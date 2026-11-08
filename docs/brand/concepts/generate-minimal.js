// כיוון מינימליסטי: צורה אחת-שתיים, ניגודיות גבוהה – קריא גם ב-16px
const fs = require('fs');
const { chromium } = require('playwright');
const dir = process.argv[2];
const F = `${dir}/../fonts/node_modules/@fontsource`;
const font = (p) => fs.readFileSync(`${F}/${p}`).toString('base64');
const fontCss = `@font-face{font-family:Heebo;font-weight:900;src:url(data:font/woff2;base64,${font('heebo/files/heebo-hebrew-900-normal.woff2')}) format('woff2')}
@font-face{font-family:Heebo;font-weight:900;src:url(data:font/woff2;base64,${font('heebo/files/heebo-latin-900-normal.woff2')}) format('woff2');unicode-range:U+0000-00FF}
@font-face{font-family:Heebo;font-weight:800;src:url(data:font/woff2;base64,${font('heebo/files/heebo-hebrew-800-normal.woff2')}) format('woff2')}`;
const NAVY = '#1e3a8a', NAVY2 = '#1d4ed8', GOLD = '#fbbf24';
const defs = `<defs><style>${fontCss}</style>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${NAVY2}"/><stop offset="1" stop-color="${NAVY}"/></linearGradient></defs>`;
const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${defs}<rect width="512" height="512" fill="url(#bg)"/>${inner}</svg>`;
const V = {};

// F1 – מטבע נכנס לחריץ (קופת צדקה בצורה הכי פשוטה)
V.F1 = wrap(`
  <clipPath id="above"><rect x="0" y="0" width="512" height="300"/></clipPath>
  <g clip-path="url(#above)"><circle cx="256" cy="236" r="104" fill="${GOLD}"/>
  <circle cx="256" cy="236" r="74" fill="none" stroke="#b45309" stroke-opacity=".35" stroke-width="12"/></g>
  <rect x="86" y="300" width="340" height="260" rx="40" fill="#fff"/>
  <rect x="156" y="284" width="200" height="32" rx="16" fill="${NAVY}"/>
  <rect x="166" y="290" width="180" height="0" fill="none"/>`);

// F2 – מטבע שחסרה בו פרוסה של עשירית, והפרוסה מורמת בזהב
const R = 150, cx = 246, cy = 268;
const pt = (deg, r = R, x0 = cx, y0 = cy) => [x0 + r * Math.cos((deg - 90) * Math.PI / 180), y0 + r * Math.sin((deg - 90) * Math.PI / 180)];
const [ax, ay] = pt(36), [bx, by] = pt(0);
const big = `M${cx} ${cy} L${ax} ${ay} A${R} ${R} 0 1 1 ${bx} ${by} Z`;
const off = 26, ox = cx + off * Math.cos((18 - 90) * Math.PI / 180), oy = cy + off * Math.sin((18 - 90) * Math.PI / 180);
const [sbx, sby] = pt(0, R, ox, oy), [sax, say] = pt(36, R, ox, oy);
const slice = `M${ox} ${oy} L${sbx} ${sby} A${R} ${R} 0 0 1 ${sax} ${say} Z`;
V.F2 = wrap(`<path d="${big}" fill="#fff"/><path d="${slice}" fill="${GOLD}"/>`);

// F3 – האות מ׳ (מעשר) עם מטבע זהב
V.F3 = wrap(`
  <text x="236" y="392" text-anchor="middle" font-family="Heebo" font-weight="900" font-size="360" fill="#fff">מ</text>
  <circle cx="380" cy="150" r="52" fill="${GOLD}"/>`);

// F4 – שבר "עשירית": 1 מעל 10
V.F4 = wrap(`
  <text x="256" y="226" text-anchor="middle" font-family="Heebo" font-weight="900" font-size="190" fill="${GOLD}">1</text>
  <rect x="146" y="252" width="220" height="22" rx="11" fill="#fff"/>
  <text x="256" y="446" text-anchor="middle" font-family="Heebo" font-weight="900" font-size="190" fill="#fff">10</text>`);

for (const [k, v] of Object.entries(V)) fs.writeFileSync(`${dir}/${k}.svg`, v);
const items = [
  ['F1', 'ו1. מטבע בקופה', 'קופת צדקה בשלוש צורות בלבד'],
  ['F2', 'ו2. עשירית', 'מטבע שעשירית ממנו מופרשת בזהב'],
  ['F3', 'ו3. מ׳ + מטבע', 'האות הראשונה של "מעשר"'],
  ['F4', 'ו4. ⅒', '"אחד מעשרה" כשבר'],
];
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1000, height: 420 } });
  const img = (k, size) => `<div style="width:${size}px;height:${size}px;border-radius:22%;overflow:hidden;flex:none">${V[k].replace('<svg ', '<svg width="100%" height="100%" ')}</div>`;
  const cells = items.map(([k, t, sub]) => `<div style="text-align:center">
    <div style="display:flex;justify-content:center">${img(k, 180)}</div>
    <div style="font-weight:800;font-size:22px;margin-top:14px">${t}</div>
    <div style="color:#64748b;font-size:15px;margin-top:4px;min-height:24px">${sub}</div>
    <div style="display:flex;gap:14px;justify-content:center;margin-top:12px;align-items:flex-end">${img(k, 48)}${img(k, 32)}${img(k, 24)}${img(k, 16)}</div>
    <div style="margin:14px auto 0;width:200px;background:#e2e8f0;border-radius:8px 8px 0 0;padding:7px 10px;display:flex;gap:8px;align-items:center;font-size:13px">${img(k, 16)}<span>מחשבון מעשר</span></div></div>`).join('');
  await p.setContent(`<html dir="rtl"><head><style>${fontCss}</style></head><body style="margin:0;padding:28px;background:#f8fafc;font-family:Heebo,Arial">
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:22px">${cells}</div></body></html>`);
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${dir}/options4.png`, fullPage: true });
  await b.close();
})();
