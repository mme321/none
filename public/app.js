'use strict';
const $ = (s) => document.querySelector(s);
const SYMBOL = { ILS: '₪', USD: '$' };
const money = (n, cur = 'ILS') =>
  (Number(n) || 0).toLocaleString('he-IL', { style: 'currency', currency: cur, maximumFractionDigits: 2 });
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (d) => new Date(String(d).slice(0, 10) + 'T12:00:00').toLocaleDateString('he-IL');

const TYPE_LABELS = { income: 'הכנסה', donation: 'תרומה', expense: 'הוצאה', ignore: 'לא נספר' };
const STATUS_LABELS = { active: '', error: 'שגיאה', reauth: 'נדרש חיבור מחדש' };
let config = null;
let state = null;

async function api(method, url, body) {
  const headers = { 'X-Requested-With': 'fetch' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) {
    showLogin();
    throw new Error(data.error);
  }
  if (!res.ok) throw new Error(data.error || `שגיאה ${res.status}`);
  return data;
}

function banner(text, kind = 'info') {
  const b = $('#banner');
  b.hidden = !text;
  b.textContent = text || '';
  b.className = 'banner ' + kind;
}

function showLogin() {
  for (const id of ['#main', '#syncBtn', '#logoutBtn', '#userName']) $(id).hidden = true;
  $('#loginScreen').hidden = false;
  $('#googleBtn').hidden = !config?.googleLogin;
  $('#devLoginForm').hidden = !config?.devLogin;
}

async function refresh() {
  state = await api('GET', '/api/state');
  $('#loginScreen').hidden = true;
  $('#main').hidden = false;
  $('#syncBtn').hidden = !state.connections.length;
  $('#logoutBtn').hidden = false;
  $('#userName').hidden = false;
  $('#userName').textContent = state.user.name || state.user.email;
  $('#accountEmail').textContent = `מחובר כ-${state.user.email}`;
  renderSummary();
  renderConnections();
  renderSettings();
}

function renderSummary() {
  const s = state.summary;
  const cur = s.currency;
  const m = (n) => money(n, cur);
  $('#sIncome').textContent = m(s.income);
  $('#sDueLabel').textContent = `${s.percent === 20 ? 'חומש' : 'מעשר'} (${s.percent}%)`;
  $('#sDue').textContent = m(s.due);
  $('#sDonated').textContent = m(s.donated);
  $('#sBalanceLabel').textContent = s.balance >= 0 ? 'נשאר לתת' : 'נתת מעבר (זכות)';
  $('#sBalance').textContent = m(Math.abs(s.balance));
  const showC = state.settings.showChomesh && s.percent !== 20;
  $('#chomeshStats').hidden = !showC;
  $('#sDueC').textContent = m(s.chomesh.due);
  $('#sBalanceCLabel').textContent = s.chomesh.balance >= 0 ? 'נשאר לתת לפי חומש' : 'זכות לפי חומש';
  $('#sBalanceC').textContent = m(Math.abs(s.chomesh.balance));

  // פירוט לפי מטבע (כשיש יותר ממטבע אחד)
  const curs = Object.entries(s.byCurrency);
  const NAMES = { ILS: 'בשקלים', USD: 'בדולרים' };
  let note = '';
  if (curs.length > 1 || (curs.length === 1 && curs[0][0] !== cur)) {
    note = curs
      .map(([c, v]) => `${NAMES[c] || esc(c)}: הכנסות <bdi>${money(v.income, c)}</bdi>, תרומות <bdi>${money(v.donated, c)}</bdi>`)
      .join(' · ');
    note += `. הסכומים למעלה הומרו ל${NAMES[cur] ? NAMES[cur].slice(1) : esc(cur)} לפי שער היום של כל תנועה.`;
  }
  if (s.unconverted) note += ` ⚠️ ${s.unconverted} תנועות לא נכללו (אין שער חליפין).`;
  $('#currencyNote').innerHTML = note;

  const label = s.percent === 20 ? 'חומש' : 'מעשר';
  $('#monthlyHead').innerHTML = `<tr><th>חודש</th><th>הכנסות</th><th>${label}</th><th>נתרם</th><th>יתרה מצטברת</th>
    ${showC ? '<th>חומש</th><th>יתרה (חומש)</th>' : ''}</tr>`;
  $('#monthlyEmpty').hidden = s.monthly.length > 0;
  const cls = (v) => (v > 0 ? 'neg' : 'pos');
  $('#monthlyBody').innerHTML = s.monthly
    .slice()
    .reverse()
    .map(
      (r) => `<tr><td>${r.month}</td><td>${m(r.income)}</td><td>${m(r.due)}</td>
        <td>${m(r.donated)}</td><td class="${cls(r.balance)}">${m(r.balance)}</td>
        ${showC ? `<td>${m(r.dueChomesh)}</td><td class="${cls(r.balanceChomesh)}">${m(r.balanceChomesh)}</td>` : ''}</tr>`
    )
    .join('');
}

function renderConnections() {
  $('#connectIL').hidden = !state.providers.saltedge;
  $('#ilDisabled').hidden = state.providers.saltedge;
  $('#connectUS').hidden = !state.providers.plaid;
  $('#usDisabled').hidden = state.providers.plaid;
  $('#connectionList').innerHTML =
    state.connections
      .map((c) => {
        const accounts = c.accounts
          .map((a) => `${esc(a.name || 'חשבון')}${a.mask ? ' ••' + esc(a.mask) : ''}${a.kind === 'card' ? ' (אשראי)' : ''}`)
          .join(', ');
        const status = STATUS_LABELS[c.status];
        return `<li>
          <div><b>${esc(c.institution_name || (c.provider === 'plaid' ? 'US bank' : 'בנק'))}</b>
            <span class="small muted">${c.provider === 'plaid' ? '🇺🇸 Plaid' : '🇮🇱 Open Banking'}</span>
            ${status ? `<span class="badge ${c.status}">${status}</span>` : ''}<br/>
            <span class="small muted">${accounts || 'עדיין לא נמשכו חשבונות'}</span><br/>
            <span class="small muted">${c.last_sync ? 'עודכן: ' + new Date(c.last_sync).toLocaleString('he-IL') : 'ממתין לנתונים מהבנק...'}</span>
            ${c.last_error ? `<br/><span class="small error">${esc(c.last_error)}</span>` : ''}</div>
          <div class="btns">
            ${c.status === 'reauth' && c.provider === 'plaid' ? `<button data-reauth="${c.id}" class="primary">חיבור מחדש</button>` : ''}
            ${c.status === 'reauth' && c.provider === 'saltedge' ? `<button data-reconnect-il="1" class="primary">חיבור מחדש</button>` : ''}
            <button data-sync="${c.id}">רענון</button>
            <button data-del-conn="${c.id}" class="danger">ניתוק</button>
          </div>
        </li>`;
      })
      .join('') || '<li class="muted">עוד לא חוברו בנקים.</li>';
}

function renderSettings() {
  const f = $('#settingsForm');
  if (f.dataset.loaded) return;
  const s = state.settings;
  f.percent.value = String(s.percent);
  f.showChomesh.checked = !!s.showChomesh;
  f.baseCurrency.value = s.baseCurrency;
  f.startDate.value = s.startDate;
  f.openingBalance.value = s.openingBalance;
  $('#manualForm').currency.value = s.baseCurrency;
  f.dataset.loaded = '1';
}

async function loadTransactions() {
  const params = new URLSearchParams();
  if ($('#txType').value) params.set('type', $('#txType').value);
  if ($('#txSearch').value) params.set('q', $('#txSearch').value);
  const list = await api('GET', '/api/transactions?' + params);
  $('#txBody').innerHTML =
    list
      .map((t) => {
        const manualOverride = !!t.type_override;
        const opts = ['auto', 'income', 'donation', 'expense', 'ignore']
          .map((v) => {
            const selected = (manualOverride ? t.type : 'auto') === v ? 'selected' : '';
            let label = TYPE_LABELS[v];
            if (v === 'auto') label = manualOverride ? 'אוטומטי' : `אוטומטי (${TYPE_LABELS[t.type]})`;
            return `<option value="${v}" ${selected}>${label}</option>`;
          })
          .join('');
        const manual = t.provider === 'manual';
        const acct = manual ? 'ידני' : `${esc(t.institution)}${t.mask ? ' ••' + esc(t.mask) : ''}`;
        return `<tr class="t-${t.type}">
          <td>${fmtDate(t.date)}</td>
          <td>${esc(t.description)}${t.memo ? `<br/><span class="small muted">${esc(t.memo)}</span>` : ''}</td>
          <td class="small">${acct}</td>
          <td class="${t.amount < 0 ? 'neg' : 'pos'}" dir="ltr">${money(t.amount, t.currency)}</td>
          <td>${manual ? TYPE_LABELS[t.type] : `<select data-tx="${t.id}">${opts}</select>`}</td>
          <td>${manual ? `<button class="danger small" data-del-tx="${t.id}">✕</button>` : ''}</td>
        </tr>`;
      })
      .join('') || '<tr><td colspan="6" class="muted">אין תנועות.</td></tr>';
}

async function loadRules() {
  const rules = await api('GET', '/api/rules');
  $('#ruleList').innerHTML = rules
    .map(
      (r) => `<li><span>"${esc(r.pattern)}" ← <b>${TYPE_LABELS[r.type]}</b></span>
      <button class="danger small" data-del-rule="${r.id}">מחיקה</button></li>`
    )
    .join('');
}

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== 'tab-' + name));
  if (name === 'transactions') loadTransactions();
  if (name === 'rules') loadRules();
}

async function afterChange() {
  await refresh();
  if (!$('#tab-transactions').hidden) loadTransactions();
}

async function sync(connectionId) {
  const btn = $('#syncBtn');
  btn.disabled = true;
  btn.textContent = 'מרענן...';
  try {
    const { results } = await api('POST', '/api/sync', connectionId ? { connectionId: Number(connectionId) } : {});
    const failed = results.filter((r) => !r.ok);
    const added = results.reduce((n, r) => n + (r.added || 0), 0);
    banner(failed.length ? `${failed.length} חיבורים נכשלו – ראו בלשונית "חיבור בנקים"` : `עודכן ✓ (${added} תנועות חדשות)`, failed.length ? 'error' : 'ok');
  } catch (e) {
    banner(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'רענון נתונים';
    afterChange();
  }
}

// ---------- Plaid (ארה"ב) ----------
function loadPlaidScript() {
  if (window.Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('לא ניתן לטעון את Plaid'));
    document.head.appendChild(s);
  });
}

async function openPlaid({ connectionId, receivedRedirectUri } = {}) {
  await loadPlaidScript();
  let token;
  if (receivedRedirectUri) {
    // חזרה מבנק עם OAuth (למשל TD Bank) – ממשיכים עם אותו link token
    token = sessionStorage.getItem('plaidLinkToken');
    connectionId = sessionStorage.getItem('plaidReauthId') || undefined;
    if (!token) throw new Error('פג תוקף החיבור, נסו שוב');
  } else {
    token = (await api('POST', '/api/plaid/link-token', connectionId ? { connectionId } : {})).linkToken;
    sessionStorage.setItem('plaidLinkToken', token);
    if (connectionId) sessionStorage.setItem('plaidReauthId', connectionId);
    else sessionStorage.removeItem('plaidReauthId');
  }
  const handler = window.Plaid.create({
    token,
    receivedRedirectUri,
    onSuccess: async (publicToken) => {
      sessionStorage.removeItem('plaidLinkToken');
      banner('מושך נתונים מהבנק...', 'info');
      try {
        if (connectionId) await api('POST', `/api/connections/${connectionId}/reconnected`, {});
        else await api('POST', '/api/plaid/exchange', { publicToken });
        banner('הבנק חובר ✓ ייתכן שההיסטוריה המלאה תגיע תוך כמה דקות.', 'ok');
      } catch (e) {
        banner(e.message, 'error');
      }
      afterChange();
    },
    onExit: (err) => {
      if (err) banner(err.display_message || err.error_message || 'החיבור בוטל', 'error');
    },
  });
  handler.open();
}

// ---------- Salt Edge (ישראל) ----------
async function connectIsrael() {
  const { url } = await api('POST', '/api/saltedge/connect', {});
  location.href = url;
}

// ---------- אירועים ----------
$('#devLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/auth/dev', { email: e.target.email.value });
    location.reload();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

$('#syncBtn').addEventListener('click', () => sync());
$('#connectUS').addEventListener('click', () => openPlaid().catch((e) => banner(e.message, 'error')));
$('#connectIL').addEventListener('click', () => connectIsrael().catch((e) => banner(e.message, 'error')));

document.querySelector('.tabs').addEventListener('click', (e) => {
  if (e.target.dataset.tab) showTab(e.target.dataset.tab);
});

document.addEventListener('click', async (e) => {
  const d = e.target.dataset;
  try {
    if (d.sync) return sync(d.sync);
    if (d.reauth) return openPlaid({ connectionId: d.reauth });
    if (d.reconnectIl) return connectIsrael();
    if (d.delConn) {
      if (!confirm('לנתק את החיבור לבנק? הגישה תבוטל גם אצל הספק.')) return;
      const purge = confirm('למחוק גם את התנועות שכבר נמשכו מהחיבור הזה? (ביטול = לשמור אותן לחישוב)');
      await api('DELETE', `/api/connections/${d.delConn}${purge ? '?purge=1' : ''}`);
      return afterChange();
    }
    if (d.delRule) {
      await api('DELETE', `/api/rules/${d.delRule}`);
      loadRules();
      return refresh();
    }
    if (d.delTx) {
      await api('DELETE', `/api/transactions/${d.delTx}`);
      return afterChange();
    }
  } catch (err) {
    banner(err.message, 'error');
  }
});

$('#txBody').addEventListener('change', async (e) => {
  if (!e.target.dataset.tx) return;
  await api('PUT', `/api/transactions/${e.target.dataset.tx}/type`, { type: e.target.value });
  afterChange();
});

let searchTimer;
$('#txSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadTransactions, 250);
});
$('#txType').addEventListener('change', loadTransactions);

$('#addManualBtn').addEventListener('click', () => {
  const f = $('#manualForm');
  f.hidden = !f.hidden;
  if (!f.date.value) f.date.value = new Date().toISOString().slice(0, 10);
});

$('#manualForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('POST', '/api/transactions', {
      type: f.type.value,
      date: f.date.value,
      amount: f.amount.value,
      currency: f.currency.value,
      description: f.description.value,
    });
    f.amount.value = '';
    f.description.value = '';
    afterChange();
  } catch (err) {
    banner(err.message, 'error');
  }
});

$('#ruleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/rules', { pattern: e.target.pattern.value, type: e.target.type.value });
    e.target.reset();
    loadRules();
    refresh();
  } catch (err) {
    banner(err.message, 'error');
  }
});

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('PUT', '/api/settings', {
      percent: f.percent.value,
      showChomesh: f.showChomesh.checked,
      baseCurrency: f.baseCurrency.value,
      startDate: f.startDate.value,
      openingBalance: f.openingBalance.value,
    });
    $('#settingsMsg').textContent = 'נשמר ✓';
    setTimeout(() => ($('#settingsMsg').textContent = ''), 2000);
    refresh();
  } catch (err) {
    $('#settingsMsg').textContent = err.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('POST', '/auth/logout', {}).catch(() => {});
  location.href = '/';
});

$('#deleteUserBtn').addEventListener('click', async () => {
  if (!confirm('למחוק לצמיתות את החשבון, את כל החיבורים לבנקים ואת כל התנועות? אי אפשר לבטל.')) return;
  try {
    await api('POST', '/api/account/delete', { confirm: true });
    location.href = '/';
  } catch (err) {
    banner(err.message, 'error');
  }
});

// ---------- טעינה ----------
(async () => {
  const params = new URLSearchParams(location.search);
  const loginError = params.get('login_error');
  if (loginError) $('#loginError').textContent = loginError;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  config = await fetch('/api/config').then((r) => r.json());
  if (!config.user) return showLogin();

  await refresh();
  if (location.pathname === '/plaid-oauth' && params.get('oauth_state_id')) {
    const uri = location.href;
    history.replaceState(null, '', '/');
    showTab('banks');
    openPlaid({ receivedRedirectUri: uri }).catch((e) => banner(e.message, 'error'));
  } else if (params.get('connected') === 'saltedge') {
    history.replaceState(null, '', '/');
    showTab('banks');
    banner('מושך נתונים מהבנק...', 'info');
    const connectionId = params.get('connection_id');
    if (connectionId) await api('POST', '/api/saltedge/return', { connectionId }).catch(() => {});
    banner('הבנק חובר ✓ הנתונים יתעדכנו אוטומטית.', 'ok');
    afterChange();
  } else if (loginError) {
    history.replaceState(null, '', '/');
  }
})().catch((e) => banner(e.message, 'error'));
