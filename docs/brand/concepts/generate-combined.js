// שילוב: קופת צדקה + עשרה מטבעות שאחד מהם מופרש
const fs = require('fs');
const { chromium } = require('playwright');
const dir = process.argv[2];
const F = `${dir}/../fonts/node_modules/@fontsource`;
const font = (p) => fs.readFileSync(`${F}/${p}`).toString('base64');
const fontCss = `@font-face{font-family:Heebo;font-weight:800;src:url(data:font/woff2;base64,${font('heebo/files/heebo-hebrew-800-normal.woff2')}) format('woff2')}`;
const NAVY = '#1e3a8a', NAVY2 = '#1d4ed8';
const defs = `<defs><style>${fontCss}</style>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${NAVY2}"/><stop offset="1" stop-color="${NAVY}"/></linearGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fcd34d"/><stop offset="1" stop-color="#f59e0b"/></linearGradient>
</defs>`;
const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}<rect width="512" height="512" fill="url(#bg)"/>${inner}</svg>`;
const goldCoin = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#gold)"/><circle cx="${cx}" cy="${cy}" r="${r * 0.7}" fill="none" stroke="#b45309" stroke-width="${r * 0.12}" stroke-opacity=".4"/>`;
const box = (label) => `
  <rect x="136" y="268" width="240" height="160" rx="26" fill="#fff"/>
  <rect x="122" y="244" width="268" height="42" rx="15" fill="#dbeafe"/>
  <rect x="201" y="258" width="110" height="14" rx="7" fill="${NAVY}"/>
  ${label}`;
const V = {};

// ה1 – שורת מטבעות למעלה, אחד חסר ונופל לקופה
let row = '';
const xs = [86, 154, 222, 290, 358, 426];
for (let i = 0; i < 10; i++) {
  const col = i % 5, r = Math.floor(i / 5);
  const cx = 116 + col * 70, cy = 78 + r * 0;
}
let coinsTop = '';
for (let i = 0; i < 9; i++) {
  const x = 78 + i * 44.5 + (i >= 4 ? 44.5 : 0);
  coinsTop += `<circle cx="${x}" cy="92" r="19" fill="#fff" fill-opacity=".9"/>`;
}
coinsTop += `<circle cx="256" cy="92" r="19" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="3" stroke-dasharray="5 6"/>`;
V.E1 = wrap(`${coinsTop}
  <path d="M256 122 V160" stroke="#fcd34d" stroke-width="6" stroke-linecap="round" stroke-dasharray="2 12"/>
  ${goldCoin(256, 214, 46)}
  ${box(`<text x="256" y="372" text-anchor="middle" font-family="Heebo" font-weight="800" font-size="60" fill="${NAVY}">מעשר</text>`)}`);

// ה2 – על חזית הקופה 10 מקומות למטבעות: 9 מלאים, אחד ריק – והמטבע הזהב נכנס בחריץ
let grid = '';
for (let i = 0; i < 10; i++) {
  const col = i % 5, r = Math.floor(i / 5);
  const cx = 176 + col * 40, cy = 322 + r * 52;
  grid += i === 2
    ? `<circle cx="${cx}" cy="${cy}" r="15" fill="none" stroke="${NAVY}" stroke-opacity=".45" stroke-width="3" stroke-dasharray="4 5"/>`
    : `<circle cx="${cx}" cy="${cy}" r="15" fill="${NAVY}" fill-opacity=".85"/>`;
}
V.E2 = wrap(`${goldCoin(256, 196, 58)}${box(grid)}`);

// ה3 – כמו ה2, עם מטבעות גדולים יותר (2×5) וללא קווים
let grid3 = '';
for (let i = 0; i < 10; i++) {
  const col = i % 5, r = Math.floor(i / 5);
  const cx = 172 + col * 42, cy = 324 + r * 54;
  if (i !== 2) grid3 += `<circle cx="${cx}" cy="${cy}" r="17" fill="#93c5fd"/>`;
}
V.E3 = wrap(`
  <path d="M256 70 V112" stroke="#fcd34d" stroke-width="7" stroke-linecap="round" stroke-dasharray="2 14"/>
  ${goldCoin(256, 186, 62)}${box(grid3)}`);

for (const [k, v] of Object.entries(V)) fs.writeFileSync(`${dir}/${k}.svg`, v);
const items = [
  ['E1', 'ה1', 'תשעה מטבעות למעלה, העשירי נופל לקופה. כתוב עליה "מעשר"'],
  ['E2', 'ה2', 'על הקופה עשרה מקומות: תשעה מלאים, אחד ריק. המטבע שלו בזהב נכנס בחריץ'],
  ['E3', 'ה3', 'כמו ה2, נקי יותר וללא מסגרת למקום הריק'],
];
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 860, height: 400 } });
  const img = (k, size) => `<div style="width:${size}px;height:${size}px;border-radius:22%;overflow:hidden;flex:none;box-shadow:0 4px 14px rgba(0,0,0,.15)">${V[k].replace('<svg ', '<svg width="100%" height="100%" ')}</div>`;
  const cells = items.map(([k, t, sub]) => `<div style="text-align:center">
    <div style="display:flex;justify-content:center">${img(k, 200)}</div>
    <div style="font-weight:800;font-size:22px;margin-top:14px">${t}</div>
    <div style="color:#64748b;font-size:15px;margin-top:4px;min-height:44px;padding:0 8px">${sub}</div>
    <div style="display:flex;gap:12px;justify-content:center;margin-top:8px;align-items:center">${img(k, 56)}${img(k, 32)}</div></div>`).join('');
  await p.setContent(`<html dir="rtl"><head><style>${fontCss}</style></head><body style="margin:0;padding:28px;background:#f8fafc;font-family:Heebo,Arial">
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px">${cells}</div></body></html>`);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${dir}/options3.png`, fullPage: true });
  await b.close();
})();
