// Usage: node tools/check-i18n.js
// Lists translation keys missing in each language (compared with Darija "dj").
const fs = require('fs');
const html = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('const LANGS='), end = html.indexOf('/* ---------- Food data');
const I18N = new Function(html.slice(start, end) + '; return I18N;')();
const base = I18N.dj; let bad = 0;
for (const l of Object.keys(I18N)) {
  if (l === 'dj') continue;
  const miss = Object.keys(base).filter(k => I18N[l][k] == null);
  const arr = ['foods','cats','meals','week_days','goals','acts','types'].filter(k => I18N[l][k] && I18N[l][k].length !== base[k].length);
  if (miss.length || arr.length) { bad = 1; console.log(`${l}: missing [${miss.join(', ')}] wrong length [${arr.join(', ')}]`); }
  else console.log(`${l}: OK`);
}
process.exit(bad);
