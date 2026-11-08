'use strict';
const $ = (s) => document.querySelector(s);
const nis = (n) =>
  (Number(n) || 0).toLocaleString('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 2 });
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TYPE_LABELS = { income: 'הכנסה', donation: 'תרומה', expense: 'הוצאה', ignore: 'לא נספר' };
let state = null;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) {
    showLogin();
    throw new Error(data.error);
  }
  if (!res.ok) throw new Error(data.error || `שגיאה ${res.status}`);
  return data;
}

function showLogin() {
  for (const id of ['#lockScreen', '#main', '#syncBtn', '#lockBtn', '#logoutBtn', '#userName']) $(id).hidden = true;
  $('#loginScreen').hidden = false;
}

async function refresh() {
  state = await api('GET', '/api/state');
  $('#loginScreen').hidden = true;
  $('#logoutBtn').hidden = !state.googleLogin;
  $('#userName').hidden = !state.user.email;
  $('#userName').textContent = state.user.name || state.user.email;
  $('#accountEmail').textContent = state.user.email ? `מחובר כ-${state.user.email}` : 'מצב מקומי (ללא התחברות)';
  const locked = !state.unlocked;
  $('#lockScreen').hidden = !locked;
  $('#main').hidden = locked;
  $('#syncBtn').hidden = locked;
  $('#lockBtn').hidden = locked;
  if (locked) {
    $('#forgotPw').hidden = !state.hasVault;
    $('#lockTitle').textContent = state.hasVault ? 'פתיחת הכספת' : 'יצירת סיסמת הצפנה';
    $('#lockHint').textContent = state.hasVault
      ? 'הזינו את סיסמת ההצפנה שלכם כדי לגשת לפרטי הבנקים.'
      : 'בחרו סיסמת הצפנה. פרטי ההתחברות לבנקים יוצפנו בעזרתה, והיא לא נשמרת בשום מקום – גם לא אצלנו. אל תשכחו אותה.';
    $('#lockSubmit').textContent = state.hasVault ? 'פתיחה' : 'יצירה';
    $('#masterPw').autocomplete = state.hasVault ? 'current-password' : 'new-password';
    return;
  }
  renderSummary();
  renderAccounts();
  renderSettings();
  $('#syncBtn').disabled = state.syncing;
  $('#syncBtn').textContent = state.syncing ? 'מסנכרן...' : 'סנכרון מהבנקים';
}

function renderSummary() {
  const s = state.summary;
  $('#sIncome').textContent = nis(s.income);
  $('#sDueLabel').textContent = `${s.percent === 20 ? 'חומש' : 'מעשר'} (${s.percent}%)`;
  $('#sDue').textContent = nis(s.due);
  $('#sDonated').textContent = nis(s.donated);
  $('#sBalanceLabel').textContent = s.balance >= 0 ? 'נשאר לתת' : 'נתת מעבר (זכות)';
  $('#sBalance').textContent = nis(Math.abs(s.balance));
  const showC = state.settings.showChomesh && s.percent !== 20;
  $('#chomeshStats').hidden = !showC;
  $('#sDueC').textContent = nis(s.chomesh.due);
  $('#sBalanceCLabel').textContent = s.chomesh.balance >= 0 ? 'נשאר לתת לפי חומש' : 'זכות לפי חומש';
  $('#sBalanceC').textContent = nis(Math.abs(s.chomesh.balance));
  const label = s.percent === 20 ? 'חומש' : 'מעשר';
  $('#monthlyHead').innerHTML = `<tr><th>חודש</th><th>הכנסות</th><th>${label}</th><th>נתרם</th><th>יתרה מצטברת</th>
    ${showC ? '<th>חומש</th><th>יתרה (חומש)</th>' : ''}</tr>`;
  $('#monthlyEmpty').hidden = s.monthly.length > 0;
  const cls = (v) => (v > 0 ? 'neg' : 'pos');
  $('#monthlyBody').innerHTML = s.monthly
    .slice()
    .reverse()
    .map(
      (m) => `<tr><td>${m.month}</td><td>${nis(m.income)}</td><td>${nis(m.due)}</td>
        <td>${nis(m.donated)}</td><td class="${cls(m.balance)}">${nis(m.balance)}</td>
        ${showC ? `<td>${nis(m.dueChomesh)}</td><td class="${cls(m.balanceChomesh)}">${nis(m.balanceChomesh)}</td>` : ''}</tr>`
    )
    .join('');
}

function renderAccounts() {
  const sel = $('#companySelect');
  if (!sel.options.length) {
    const groups = { bank: 'בנקים', card: 'כרטיסי אשראי' };
    sel.innerHTML =
      '<option value="">בחרו בנק / חברת אשראי</option>' +
      Object.entries(groups)
        .map(
          ([type, label]) =>
            `<optgroup label="${label}">` +
            Object.entries(state.companies)
              .filter(([, c]) => c.type === type)
              .map(([id, c]) => `<option value="${id}">${esc(c.name)}</option>`)
              .join('') +
            '</optgroup>'
        )
        .join('');
  }
  $('#accountList').innerHTML =
    state.accounts
      .map(
        (a) => `<li>
        <div><b>${esc(a.label)}</b> <span class="muted">(${esc(a.companyName)})</span><br/>
        <span class="small muted">${a.lastSync ? 'סונכרן לאחרונה: ' + new Date(a.lastSync).toLocaleString('he-IL') : 'עוד לא סונכרן'}</span>
        ${a.lastError ? `<br/><span class="small error">${esc(a.lastError)}</span>` : ''}</div>
        <div><button data-sync="${a.id}">סנכרון</button> <button data-del-acc="${a.id}" class="danger">מחיקה</button></div>
      </li>`
      )
      .join('') || '<li class="muted">עוד לא נוספו חשבונות.</li>';
}

function renderSettings() {
  const f = $('#settingsForm');
  if (f.dataset.loaded) return;
  f.percent.value = String(state.settings.percent);
  f.showChomesh.checked = !!state.settings.showChomesh;
  f.startDate.value = state.settings.startDate;
  f.openingBalance.value = state.settings.openingBalance;
  f.autoSyncHours.value = state.settings.autoSyncHours;
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
        const opts = ['auto', 'income', 'donation', 'expense', 'ignore']
          .map((v) => {
            const selected = (t.reason === 'manual' ? t.type : 'auto') === v ? 'selected' : '';
            let label = TYPE_LABELS[v];
            if (v === 'auto') label = t.reason === 'manual' ? 'אוטומטי' : `אוטומטי (${TYPE_LABELS[t.type]})`;
            return `<option value="${v}" ${selected}>${label}</option>`;
          })
          .join('');
        return `<tr class="t-${t.type}">
          <td>${new Date(t.date).toLocaleDateString('he-IL')}</td>
          <td>${esc(t.description)}${t.memo ? `<br/><span class="small muted">${esc(t.memo)}</span>` : ''}</td>
          <td class="small">${esc(t.accountLabel)}</td>
          <td class="${t.amount < 0 ? 'neg' : 'pos'}" dir="ltr">${nis(t.amount)}</td>
          <td>${t.source === 'manual' ? TYPE_LABELS[t.type] : `<select data-tx="${t.id}">${opts}</select>`}</td>
          <td>${t.source === 'manual' ? `<button class="danger small" data-del-tx="${t.id}">✕</button>` : ''}</td>
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

async function sync(accountId) {
  $('#syncBtn').disabled = true;
  $('#syncBtn').textContent = 'מסנכרן...';
  $('#syncLogBox').hidden = false;
  $('#syncLog').textContent = 'מתחבר לבנק... (זה יכול לקחת דקה-שתיים)';
  const poll = setInterval(async () => {
    const { log } = await api('GET', '/api/sync/log').catch(() => ({ log: [] }));
    if (log.length) $('#syncLog').textContent = log.join('\n');
  }, 2000);
  try {
    const { log } = await api('POST', '/api/sync', accountId ? { accountId } : {});
    $('#syncLog').textContent = log.join('\n') || 'אין חשבונות לסנכרון.';
  } catch (e) {
    $('#syncLog').textContent = e.message;
  } finally {
    clearInterval(poll);
    await refresh();
    if (!$('#tab-transactions').hidden) loadTransactions();
  }
}

// ---------- אירועים ----------
$('#lockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#lockError').textContent = '';
  try {
    await api('POST', state.hasVault ? '/api/unlock' : '/api/setup', { password: $('#masterPw').value });
    $('#masterPw').value = '';
    await refresh();
  } catch (err) {
    $('#lockError').textContent = err.message;
  }
});

$('#lockBtn').addEventListener('click', async () => {
  await api('POST', '/api/lock');
  refresh();
});

$('#syncBtn').addEventListener('click', () => sync());

document.querySelector('.tabs').addEventListener('click', (e) => {
  if (e.target.dataset.tab) showTab(e.target.dataset.tab);
});

$('#companySelect').addEventListener('change', () => {
  const c = state.companies[$('#companySelect').value];
  $('#credFields').innerHTML = c
    ? c.fields
        .map(
          (f) =>
            `<input name="${f}" placeholder="${esc(state.fieldLabels[f] || f)}" required
              type="${f === 'password' ? 'password' : 'text'}" autocomplete="off" />`
        )
        .join('')
    : '';
});

$('#accountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const credentials = {};
  $('#credFields').querySelectorAll('input').forEach((i) => (credentials[i.name] = i.value));
  try {
    await api('POST', '/api/accounts', {
      companyId: $('#companySelect').value,
      label: $('#accountLabel').value,
      credentials,
    });
    e.target.reset();
    $('#credFields').innerHTML = '';
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

document.addEventListener('click', async (e) => {
  const d = e.target.dataset;
  try {
    if (d.sync) return sync(d.sync);
    if (d.delAcc) {
      if (!confirm('למחוק את החשבון?')) return;
      const purge = confirm('למחוק גם את כל התנועות שנמשכו מהחשבון הזה?');
      await api('DELETE', `/api/accounts/${d.delAcc}${purge ? '?purge=1' : ''}`);
      return refresh();
    }
    if (d.delRule) {
      await api('DELETE', `/api/rules/${d.delRule}`);
      loadRules();
      return refresh();
    }
    if (d.delTx) {
      await api('DELETE', `/api/transactions/${d.delTx}`);
      loadTransactions();
      return refresh();
    }
  } catch (err) {
    alert(err.message);
  }
});

$('#txBody').addEventListener('change', async (e) => {
  if (!e.target.dataset.tx) return;
  await api('PUT', `/api/transactions/${e.target.dataset.tx}/type`, { type: e.target.value });
  await refresh();
  loadTransactions();
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
      description: f.description.value,
    });
    f.amount.value = '';
    f.description.value = '';
    await refresh();
    loadTransactions();
  } catch (err) {
    alert(err.message);
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
    alert(err.message);
  }
});

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('PUT', '/api/settings', {
      percent: f.percent.value,
      showChomesh: f.showChomesh.checked,
      startDate: f.startDate.value,
      openingBalance: f.openingBalance.value,
      autoSyncHours: f.autoSyncHours.value,
    });
    $('#settingsMsg').textContent = 'נשמר ✓';
    setTimeout(() => ($('#settingsMsg').textContent = ''), 2000);
    refresh();
  } catch (err) {
    $('#settingsMsg').textContent = err.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('POST', '/auth/logout').catch(() => {});
  location.href = '/';
});

$('#forgotPw').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!confirm('אי אפשר לשחזר את סיסמת ההצפנה. אפשר לאפס אותה – פרטי ההתחברות לבנקים יימחקו ותצטרכו להזין אותם מחדש (התנועות והחישובים יישמרו). להמשיך?')) return;
  try {
    await api('POST', '/api/vault/reset', { confirm: true });
    refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('#deleteUserBtn').addEventListener('click', async () => {
  if (!confirm('למחוק לצמיתות את החשבון, פרטי הבנקים וכל התנועות? אי אפשר לבטל.')) return;
  try {
    await api('POST', '/api/account/delete', { confirm: true });
    location.href = '/';
  } catch (err) {
    alert(err.message);
  }
});

const loginError = new URLSearchParams(location.search).get('login_error');
if (loginError) {
  $('#loginError').textContent = loginError;
  history.replaceState(null, '', '/');
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

refresh().catch((e) => {
  if ($('#loginScreen').hidden) alert(e.message);
});
