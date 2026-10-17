// Usage: node tools/check-i18n.js
// Compares every language with Darija ("dj"), both ways: missing keys, extra keys, array lengths,
// keys inside nested tables (notes, units, recipe names…) and {placeholders} used by each string.
const fs = require('fs');
const html = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('const LANGS='), end = html.indexOf('/* ---------- Food data');
const I18N = new Function(html.slice(start, end) + '; return I18N;')();
const base = I18N.dj; let bad = 0;
const ph = s => typeof s === 'string' ? (s.match(/\{[a-z_]+\}/g) || []).sort().join(',') : '';
const isTable = v => v && typeof v === 'object' && !Array.isArray(v);
for (const l of Object.keys(I18N)) {
  if (l === 'dj') continue;
  const L = I18N[l], issues = [];
  const all = new Set([...Object.keys(base), ...Object.keys(L)]);
  for (const k of all) {
    const a = base[k], b = L[k];
    if (a == null) { issues.push(`only in ${l}: ${k}`); continue; }
    if (b == null) { issues.push(`missing: ${k}`); continue; }
    if (Array.isArray(a) && (!Array.isArray(b) || a.length !== b.length)) issues.push(`length: ${k} (${a.length} vs ${b && b.length})`);
    else if (isTable(a)) {
      for (const sk of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[sk] == null) issues.push(`only in ${l}: ${k}.${sk}`);
        else if (b[sk] == null) issues.push(`missing: ${k}.${sk}`);
      }
    } else if (ph(a) !== ph(b)) issues.push(`placeholders differ: ${k} (${ph(a)} vs ${ph(b)})`);
  }
  if (issues.length) { bad = 1; console.log(`${l}:\n  ` + issues.join('\n  ')); } else console.log(`${l}: OK`);
}
process.exit(bad);
