#!/usr/bin/env node
/* Makla Mizan — automated checks.
   Runs the real app (index.html) in headless Chromium, served over http://localhost so the service worker works.
   Expected values are computed independently in this file (by hand or from the raw data), never by calling the
   app's own helper for the same quantity.
   Usage:  npm test        (needs the "playwright" package and a Chromium build)                                  */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KEY = 'makla_mizan_v2';
const NAV_TABS = 4;   // Menu · T9edya · Recettes · Ana (settings behind the header button)
const results = [];
const tests = [];
const test = (group, name, fn, opts = {}) => tests.push({ group, name, fn, opts });

/* ---------- tiny assertion helpers ---------- */
class Fail extends Error {}
const ok = (c, msg) => { if (!c) throw new Fail(msg); };
const near = (got, exp, tol, msg) => { if (!(Math.abs(got - exp) <= tol)) throw new Fail(`${msg}: got ${got}, expected ${exp} (±${tol})`); };
const eq = (got, exp, msg) => { if (got !== exp) throw new Fail(`${msg}: got ${JSON.stringify(got)}, expected ${JSON.stringify(exp)}`); };

/* ---------- static server with per-path overrides (to simulate deployments and 404s) ---------- */
const overrides = {};
let serverDown = false;   // true = every request fails like a lost connection (Playwright's offline mode does not cover service workers)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
function startServer() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      if (serverDown) return req.socket.destroy();
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.startsWith('/fs')) return fakeFirestore(req, rsp, p);
      if (overrides[p] && overrides[p].delay && !req.headers['x-no-delay']) { const ms = overrides[p].delay; overrides[p].hits = (overrides[p].hits || 0) + 1; return setTimeout(() => { if (!rsp.writableEnded) { rsp.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); fs.createReadStream(path.join(ROOT, 'index.html')).pipe(rsp); } }, ms); }
      if (overrides[p] && overrides[p].body !== undefined) { const o = overrides[p]; rsp.writeHead(o.status || 200, { 'Content-Type': o.type || 'text/plain', 'Cache-Control': 'no-store' }); return rsp.end(o.body); }
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rsp.writeHead(404, { 'Content-Type': 'text/html' }); return rsp.end('<!doctype html><title>404</title><h1>Not found</h1>'); }
      rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(rsp);
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}


/* ---------- minimal Firestore REST stand-in (GET a document, :commit with updateMask + REQUEST_TIME), for the sync tests ---------- */
const fsDocs = {}; let fsClock = Date.now() - 3600e3; // server time follows the real clock (the "changed in the last 2 days" dots depend on it)
const fsNow = () => new Date(fsClock += 1000).toISOString();
function fakeFirestore(req, rsp, p) {
  const send = (code, obj) => { rsp.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); rsp.end(JSON.stringify(obj)); };
  const deny = hid => !hid || hid.length < 24;   // same idea as the security rules: ids under 24 characters are refused
  if (req.method === 'GET') { const hid = p.split('/households/')[1];
    if (deny(hid)) return send(403, { error: { code: 403, status: 'PERMISSION_DENIED' } });
    const d = fsDocs[hid]; return d ? send(200, { name: 'x/' + hid, fields: d.fields, updateTime: d.updateTime }) : send(404, { error: { code: 404, status: 'NOT_FOUND' } }); }
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const w = JSON.parse(body).writes[0]; const hid = w.update.name.split('/households/')[1];
    if (deny(hid)) return send(403, { error: { code: 403, status: 'PERMISSION_DENIED' } });
    const d = fsDocs[hid] || (fsDocs[hid] = { fields: {} }); const now = fsNow();
    const setPath = (path, val) => { const seg = path.split('.'); let f = d.fields;
      for (let i = 0; i < seg.length - 1; i++) { f[seg[i]] = f[seg[i]] && f[seg[i]].mapValue ? f[seg[i]] : { mapValue: { fields: {} } }; f = f[seg[i]].mapValue.fields; }
      if (val === undefined) delete f[seg[seg.length - 1]]; else f[seg[seg.length - 1]] = val; };
    const getPath = path => { let f = w.update.fields, v; for (const sg of path.split('.')) { v = f && f[sg]; f = v && v.mapValue && v.mapValue.fields; } return v; };
    (w.updateMask.fieldPaths || []).forEach(fp => setPath(fp, getPath(fp)));
    (w.updateTransforms || []).forEach(tr => setPath(tr.fieldPath, { timestampValue: now }));
    d.updateTime = now; send(200, { writeResults: [{ updateTime: now }], commitTime: now }); });
}

/* ---------- app helpers ---------- */
let browser, BASE;
async function openApp({ sw = false, seed, keepOnboarding = false } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: sw ? 'allow' : 'block', viewport: { width: 400, height: 860 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  if (seed !== undefined) {
    await page.goto(BASE + 'tests/blank.html').catch(() => {});
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, seed]);
  }
  await page.goto(BASE + 'index.html');
  await page.waitForFunction(() => typeof S === 'object' && S && document.getElementById('view').innerHTML.length > 0, null, { timeout: 8000 }).catch(() => {});
  if (!keepOnboarding) await page.evaluate(() => { if (typeof ob !== 'undefined' && ob && typeof skipOnboarding === 'function') skipOnboarding(); }).catch(() => {});
  return { ctx, page, errors };
}
const profileState = p => Object.assign({ id: 'p1', name: 'T', sex: 'm', age: 30, w: 80, h: 180, act: 1.55, goal: 'maintain', protKg: null, fatPct: 27, days: [], week: [null, null, null, null, null, null, null] }, p);

/* ======================================================================================
   1. Nutrition formulas — reference cases worked out by hand (Mifflin-St Jeor)
   ====================================================================================== */
const REF = [
  // BMR = 10w + 6.25h − 5a + 5 (men) / −161 (women); TDEE = BMR × activity; kcal = round(TDEE × goal factor)
  { name: 'man 30y 80kg 180cm, moderate, maintain', p: { sex: 'm', age: 30, w: 80, h: 180, act: 1.55, goal: 'maintain' },
    exp: { bmr: 1780, tdee: 2759, kcal: 2759, prot: 144, fat: 83, carbs: 359 } },
  { name: 'woman 25y 60kg 165cm, light, cut', p: { sex: 'f', age: 25, w: 60, h: 165, act: 1.375, goal: 'cut' },
    exp: { bmr: 1345, tdee: 1850, kcal: 1480, prot: 132, fat: 44, carbs: 139 } },
  { name: 'man 40y 120kg 175cm, sedentary, cut (protein on BMI-25 weight)', p: { sex: 'm', age: 40, w: 120, h: 175, act: 1.2, goal: 'cut' },
    exp: { bmr: 2099, tdee: 2519, kcal: 2015, prot: 168, fat: 60, carbs: 201, refW: 77 } },
  { name: 'woman 60y 45kg 150cm, sedentary, cut → calorie floor', p: { sex: 'f', age: 60, w: 45, h: 150, act: 1.2, goal: 'cut' },
    exp: { kcal: 1112, floored: true } },
  { name: 'teen 16y, cut → no deficit', p: { sex: 'm', age: 16, w: 60, h: 170, act: 1.55, goal: 'cut' },
    exp: { kcal: 2461, minor: true, goal: 'maintain' } },
];
for (const r of REF) test('Nutrition', r.name, async ({ page }) => {
  const tg = await page.evaluate(p => targets(Object.assign({ protKg: null, fatPct: 27 }, p)), r.p);
  for (const [k, v] of Object.entries(r.exp)) eq(tg[k], v, k);
});
test('Nutrition', 'invalid / empty / extreme inputs never give NaN or crash', async ({ page }) => {
  const bad = [
    { sex: 'x', age: 'abc', w: -5, h: Infinity, act: undefined, goal: 'zzz', fatPct: '', protKg: 'foo' },
    { sex: 'm', age: 0, w: 0, h: 0, act: 0, goal: 'cut', fatPct: 99, protKg: 9 },
    { sex: 'f', age: 1e9, w: 1e9, h: 1e9, act: 9, goal: null, fatPct: -3, protKg: -1 },
  ];
  const out = await page.evaluate(list => list.map(p => { try { const t = targets(p); return Object.values(t).filter(v => typeof v === 'number').every(Number.isFinite) ? 'ok' : 'NaN:' + JSON.stringify(t); } catch (e) { return 'throw:' + e.message; } }), bad);
  out.forEach((o, i) => eq(o, 'ok', 'case ' + i));
});
test('Nutrition', 'training days: weekly carbs unchanged, no day shifted by more than 50 g, floor kept', async ({ page }) => {
  const res = await page.evaluate(() => {
    const base = { sex: 'f', age: 35, w: 58, h: 160, act: 1.2, goal: 'cut', protKg: null, fatPct: 27, train: true };
    return [[0, 2, 4], [0, 1, 2, 3], [0, 1, 2, 3, 4, 5]].map(td => {
      const p = Object.assign({}, base, { tdays: td }); const b = targets(p);
      const days = [0, 1, 2, 3, 4, 5, 6].map(i => targets(p, i));
      return { n: td.length, shifts: days.map(d => d.carbs - b.carbs), kcal: days.map(d => d.kcal) };
    });
  });
  for (const r of res) {
    const sum = r.shifts.reduce((a, b) => a + b, 0);
    near(sum, 0, 7, `n=${r.n} weekly carb shift`);
    ok(r.shifts.every(s => Math.abs(s) <= 50), `n=${r.n} daily shift ≤ 50 g, got ${r.shifts}`);
    ok(r.kcal.every(k => k >= 1200), `n=${r.n} kcal floor 1200 on every day, got ${r.kcal}`);
  }
});

/* ======================================================================================
   2. Units and serving sizes
   ====================================================================================== */
test('Units', 'grams, pieces, spoons and ml convert to the right macros', async ({ page }) => {
  const r = await page.evaluate(() => ({
    sder100: itemM('sder', 100).k,          // 120 kcal / 100 g
    eggs2: itemM('bid', 2).k,               // 72 kcal per egg
    oil1: itemM('zit_z', 1).f,              // 13.5 g fat per tablespoon
    lben250: itemM('lben', 250).k,          // 40 kcal / 100 ml
    bread_q: itemM('khobz', 0.25).k,        // 494 kcal per loaf
  }));
  near(r.sder100, 120, 1e-9, '100 g chicken breast (USDA: 120 kcal)'); near(r.eggs2, 144, 1e-9, '2 eggs');
  near(r.oil1, 13.5, 1e-9, '1 tbsp olive oil fat'); near(r.lben250, 100, 1e-9, '250 ml lben'); near(r.bread_q, 123.5, 1e-9, '¼ loaf');
});
test('Units', '± buttons keep quarter steps (¼ loaf stays 0.25)', async ({ page }) => {
  const q = await page.evaluate(() => { const d = D(); d.meals.ftour = [['khobz', 0.5]]; step('ftour', 0, -1); return D().meals.ftour[0][1]; });
  near(q, 0.25, 1e-9, 'bread after one step down from ½');
});
test('Units', 'negative, empty and absurd quantities are rejected', async ({ page }) => {
  const r = await page.evaluate(() => { const d = D(); d.meals.ghda = [['sder', 100], ['bid', 2]];
    setQ('ghda', 0, '-50'); const a = D().meals.ghda[0][1]; setQ('ghda', 0, ''); const b = D().meals.ghda[0][1];
    setQ('ghda', 0, '1e12'); const c = D().meals.ghda[0][1]; setQ('ghda', 1, '1e9'); const e = D().meals.ghda[1][1];
    return { a, b, c, e, tot: dayTot(D()).k }; });
  eq(r.a, 0, 'negative → 0'); eq(r.b, 0, 'empty → 0');
  ok(r.c <= 10000, 'grams capped, got ' + r.c); ok(r.e <= 200, 'pieces capped, got ' + r.e); ok(Number.isFinite(r.tot), 'day total finite');
});

/* ======================================================================================
   3. Recipes
   ====================================================================================== */
async function recipeExpected(page, rid, oil = 1) {
  const raw = await page.evaluate(id => ({ r: SEED_RECIPES.find(x => 'r_' + x[0] === id), F: FOODS }), rid);
  const F = {}; raw.F.forEach(f => F[f.id] = f);
  const [, , serves, items] = raw.r; const t = [0, 0, 0, 0];
  for (const [id, q0] of items) { const f = F[id]; const q = ['zit_z', 'zit_t', 'zit_argan'].includes(id) ? q0 * oil : q0; const mul = f.u === 'g' ? q / 100 : q; f.m.forEach((v, i) => t[i] += v * mul); }
  return t.map(v => v / serves);
}
test('Recipes', 'portion = whole pot ÷ servings (tajine kefta)', async ({ page }) => {
  const exp = await recipeExpected(page, 'r_tajine_kefta');
  const got = await page.evaluate(() => recipeFood(recipe('r_tajine_kefta')).m);
  got.forEach((v, i) => near(v, exp[i], 1e-6, 'macro ' + i));
});
test('Recipes', 'changing servings re-divides the pot exactly', async ({ page }) => {
  const r = await page.evaluate(() => { const rc = recipe('r_tajine_kefta'); const a = recipeFood(rc).m[0]; editRec = rc.id; setServings(8); const b = recipeFood(recipe('r_tajine_kefta')).m[0]; return { a, b }; });
  near(r.b, r.a / 2, 1e-9, 'kcal per portion at 8 servings');
});
test('Recipes', 'less-oil setting: recipe card, editor and portion agree', async ({ page }) => {
  const exp = await recipeExpected(page, 'r_tajine_kefta', 0.5);
  const r = await page.evaluate(() => { S.oil = .5; save(); editRec = 'r_tajine_kefta'; go('recettes');
    const ed = document.querySelector('#recEd .meal-h .m'); const txt = ed ? ed.textContent : '';
    return { portion: recipeFood(recipe('r_tajine_kefta')).m[0], editorKcal: parseFloat((txt.match(/(\d+(?:\.\d+)?)\s*kcal/) || [])[1]) }; });
  near(r.portion, exp[0], 1e-6, 'recipeFood kcal with half oil');
  near(r.editorKcal, Math.round(exp[0]), 1, 'editor "per portion" kcal with half oil');
});

/* ======================================================================================
   4. Daily and weekly totals
   ====================================================================================== */
test('Totals', 'day total = sum of items; week average over planned days', async ({ page }) => {
  const r = await page.evaluate(() => { const p = P(); const d = { id: 'dx', name: 'X', meals: { ftour: [], ghda: [['sder', 200], ['rouz', 150], ['zit_z', 1]], kaskrout: [], '3cha': [] } };
    p.days.push(d); p.week = ['dx', 'dx', 'dx', null, null, null, null]; save();
    return { day: dayTot(d), wk: weekAvg(p) }; });
  near(r.day.k, 240 + 195 + 119, 1e-9, 'kcal'); near(r.day.p, 45 + 4.05, 1e-9, 'protein');
  eq(r.wk.n, 3, 'planned days'); near(r.wk.avg.k, 554, 1e-9, 'average kcal');
});

/* ======================================================================================
   5. Shopping list
   ====================================================================================== */
test('Shopping', 'cooked and raw rice are one purchase (one row, one pack)', async ({ page }) => {
  const r = await page.evaluate(() => {
    const a = { id: 'a1', name: 'A', meals: { ftour: [], ghda: [['rouz', 200]], kaskrout: [], '3cha': [] } };
    const b = { id: 'b1', name: 'B', meals: { ftour: [], ghda: [['rouz_n', 100]], kaskrout: [], '3cha': [] } };
    S.profiles = [Object.assign(P(), { id: 'pa', days: [a], week: ['a1', null, null, null, null, null, null] }),
                  { id: 'pb', name: 'B', sex: 'f', age: 30, w: 60, h: 165, act: 1.55, goal: 'maintain', fatPct: 27, days: [b], week: ['b1', null, null, null, null, null, null] }];
    S.active = 'pa'; S.shop = { pa: true, pb: true }; S.menu = null; save();
    const rows = shopData().rows.filter(x => /^rouz/.test(x.id)); return rows.map(x => ({ id: x.id, week: x.week, buy: x.buy }));
  });
  eq(r.length, 1, 'rice rows');
  near(r[0].week, 200 * 0.00035 + 100 * 0.001, 1e-9, 'kg of dry rice for the week');
});
test('Shopping', 'repeated ingredients across meals, recipes and profiles add up', async ({ page }) => {
  const r = await page.evaluate(() => {
    const rc = recipe('r_tajine_kefta'); const sv = rc.servings; const kef = rc.items.find(x => x[0] === 'kefta')[1];
    const d = { id: 'd1', name: 'D', meals: { ftour: [], ghda: [['kefta', 150], ['r_tajine_kefta', 2]], kaskrout: [], '3cha': [['kefta', 100]] } };
    S.profiles = [Object.assign(P(), { id: 'pa', days: [d], week: ['d1', 'd1', null, null, null, null, null] })]; S.active = 'pa'; S.shop = { pa: true }; S.menu = null; S.oil = 1; save();
    const row = shopData().rows.find(x => x.id === 'kefta'); return { got: row.week, exp: 2 * (150 + 100 + kef * 2 / sv) * 0.001 };
  });
  near(r.got, r.exp, 1e-9, 'kg kefta for the week');
});
test('Shopping', 'trip cost uses whole packs; week cost uses what is eaten', async ({ page }) => {
  const r = await page.evaluate(() => {
    const d = { id: 'd1', name: 'D', meals: { ftour: [['choufan', 60]], ghda: [], kaskrout: [], '3cha': [] } };
    S.profiles = [Object.assign(P(), { id: 'pa', days: [d], week: ['d1', null, null, null, null, null, null] })]; S.active = 'pa'; S.shop = { pa: true }; S.menu = null; S.prices = {}; S.pantry = {}; save();
    const sd = shopData(); const row = sd.rows.find(x => x.id === 'choufan'); return { eaten: sd.cost, buy: row.buy, trip: row.cost, price: price(food('choufan')) };
  });
  near(r.eaten, 60 * 0.001 * r.price, 1e-9, 'week (eaten) cost'); near(r.buy, 0.5, 1e-9, 'oats bought as one 500 g pack');
  near(r.trip, 0.5 * r.price, 1e-9, 'trip cost of the pack');
});
test('Shopping', 'weekly menu: people × portions plus the profile’s extra portion', async ({ page }) => {
  const r = await page.evaluate(() => {
    S.oil = 1; S.pantry = {}; const rc = recipe('r_3des'); const lent = rc.items.find(x => x[0] === '3des_n')[1];
    S.menu = { set: { people: 4, budget: '', time: 60, excl: [], meals: { ftour: false, ghda: true, '3cha': false } }, days: [{ ghda: 'r_3des', pfBy: { [P().id]: 1.5 } }, {}, {}, {}, {}, {}, {}], at: 1 };
    S.shop = { menu: true }; S.profiles.forEach(p => S.shop[p.id] = false); save();
    const row = shopData().rows.find(x => x.id === '3des_n'); return { got: row.week, exp: (4 + 0.5) * lent / rc.servings * 0.001 };
  });
  near(r.got, r.exp, 1e-9, 'kg lentils');
});
test('Shopping', 'amount at home is taken off the list', async ({ page }) => {
  const r = await page.evaluate(() => {
    const d = { id: 'd1', name: 'D', meals: { ftour: [], ghda: [['sder', 250]], kaskrout: [], '3cha': [] } };
    S.profiles = [Object.assign(P(), { id: 'pa', days: [d], week: ['d1', null, null, null, null, null, null] })]; S.active = 'pa'; S.shop = { pa: true }; S.menu = null; S.pantry = { sder: 0.1 }; save();
    const row = shopData().rows.find(x => x.id === 'sder'); return { need: row.need, home: row.home };
  });
  near(r.need, 0.15, 1e-9, 'kg still to buy'); eq(r.home, false, 'not fully at home');
});
test('Budget', 'month = week × 30/7; spending summed for the current month', async ({ page }) => {
  const r = await page.evaluate(() => {
    const ym = today().slice(0, 7); S.spend = [{ id: 's1', d: ym + '-01', a: 300, e: 280 }, { id: 's2', d: ym + '-02', a: 150, e: 0 }, { id: 's3', d: '2000-01-01', a: 999, e: 0 }]; save(); moneyOpen = true; go('t9edya');
    const txt = document.getElementById('view').textContent; const cost = shopData().cost; return { txt, cost };
  });
  ok(r.txt.includes('450.00'), 'this month = 450.00 DH shown');
  ok(r.txt.includes((r.cost * 30 / 7).toFixed(2)), 'month estimate shown');
});

/* ======================================================================================
   6. Profiles
   ====================================================================================== */
test('Profiles', 'add, switch and delete profiles keeps a valid active profile', async ({ page }) => {
  const r = await page.evaluate(() => { const n0 = S.profiles.length; newProfile(); const id = S.active; delArm = 'p'; delProfile();
    return { n0, n1: S.profiles.length, activeOk: !!S.profiles.find(p => p.id === S.active), shopGone: !(id in S.shop) }; });
  eq(r.n1, r.n0, 'profile count back'); ok(r.activeOk, 'active profile exists'); ok(r.shopGone, 'shopping flag removed');
});

/* ======================================================================================
   7. Backups: export / import / corrupted data / storage failure
   ====================================================================================== */
async function richState(page) {
  return page.evaluate(() => {
    S.custom.push({ id: 'c_test1', n: 'Skyr', cat: 'ftour', mu: 'g', u: 'g', gu: null, ul: '7ba', bl: '7ba', b: 'kg', f: .001, d: 150, s: 50, m: [63, 11, 4, 0.2], p: 40 });
    S.prices.sder = 72; S.ov.bid = { cat: 'ftour', m: [70, 6, 0.5, 5] }; S.oil = .67; S.pantry = { louz: 0.2 }; S.spend = [{ id: 'sp1', d: '2026-10-01', a: 420, e: 400 }];
    const r = { id: 'r_mine1', n: 'Ma recette', cat: 'mine', servings: 3, items: [['sder', 450], ['c_test1', 300]] }; S.recipes.push(r);
    P().days[0].meals.ghda.push(['r_mine1', 1], ['c_test1', 150]);
    S.menu = { set: { people: 3, budget: '', time: 60, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }, days: [0, 1, 2, 3, 4, 5, 6].map(() => ({ ftour: [['bid', 2]], ghda: 'r_mine1', '3cha': 'r_3des' })), at: 1 };
    save(); return JSON.stringify(S);
  });
}
test('Backup', 'export → import round trip keeps profiles, foods, recipes, menu, prices and settings', async ({ page, ctx }) => {
  const before = await richState(page);
  const { page: q, ctx: c2 } = await openApp();   // new browser context = empty storage
  await q.evaluate(txt => { go('prix'); document.getElementById('impT').value = txt; importData(); if (typeof importConfirm === 'function') importConfirm(); }, before);
  const after = await q.evaluate(() => JSON.stringify(S));
  const A = JSON.parse(before), B = JSON.parse(after);
  for (const k of ['profiles', 'custom', 'recipes', 'prices', 'ov', 'menu', 'pantry', 'spend', 'oil', 'lang', 'theme', 'meals'])
    eq(JSON.stringify(B[k]), JSON.stringify(A[k]), 'key ' + k);
  await c2.close();
});
test('Backup', 'import asks for confirmation before replacing data', async ({ page }) => {
  const r = await page.evaluate(() => { const before = JSON.stringify(S.profiles.map(p => p.id));
    const other = JSON.parse(JSON.stringify(S)); other.profiles[0].id = 'zz'; other.profiles[0].name = 'Imported'; other.active = 'zz';
    go('prix'); document.getElementById('impT').value = JSON.stringify(other); importData();
    return { unchanged: JSON.stringify(S.profiles.map(p => p.id)) === before, asked: !!document.getElementById('impConfirm') }; });
  ok(r.unchanged && r.asked, 'data replaced without confirmation');
});
test('Backup', 'an import can be undone (previous data restored)', async ({ page }) => {
  const r = await page.evaluate(() => { const mine = P().name = 'Before'; save(); const before = JSON.stringify(S.profiles);
    const o = JSON.parse(JSON.stringify(S)); o.profiles[0].name = 'Imported'; go('prix'); document.getElementById('impT').value = JSON.stringify(o); importData(); importConfirm();
    const imported = P().name; delArm = 'prev'; restorePrev(); return { imported, back: JSON.stringify(S.profiles) === before }; });
  eq(r.imported, 'Imported', 'import applied'); ok(r.back, 'previous data not restored');
});
test('Backup', 'a program file adds days, meals, foods, week and training days to the open profile without replacing anything; re-import does not duplicate', async ({ page }) => {
  const prog = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'program.json'), 'utf8'));
  const r = await page.evaluate(prog => {
    S.prices.sder = 77; const nProf = S.profiles.length, nRec = S.recipes.length, oldDays = P().days.length; S.meals = DEFAULT_MEALS(); save();
    go('prix'); const run = () => { document.getElementById('impT').value = JSON.stringify(prog); importData(); const box = !!document.getElementById('impConfirm'); importConfirm(); return box };
    const asked = run(); const p = P();
    const out = { asked, prices: S.prices.sder, prof: S.profiles.length === nProf, rec: S.recipes.length === nRec, days: p.days.length - oldDays,
      meals: S.meals.map(m => m.k), mealName: mealName('m_n3ass'), custom: S.custom.map(f => f.n), train: p.train, tdays: p.tdays,
      week: p.week.map(id => (p.days.find(d => d.id === id) || {}).name),
      sardInDay: (p.days.find(d => d.name === 'Ra7a sardine').meals.ghda[0] || [])[0], prev: hasPrev(),
      tot: Object.fromEntries(p.days.filter(d => /Tadrib|Ra7a/.test(d.name)).map(d => [d.name, dayTot(d)])) };
    run(); out.days2 = P().days.length - oldDays; out.custom2 = S.custom.length; return out; }, prog);
  ok(r.asked, 'asks before adding'); eq(r.prices, 77, 'prices untouched'); ok(r.prof && r.rec, 'profiles and recipes untouched');
  eq(r.days, 5, '5 day templates added'); eq(r.meals.slice(0, 5).join(), 'ftour,ghda,pre,3cha,m_n3ass', 'program meals first, in order'); eq(r.mealName, '9bel n3ass', 'meal named');
  ok(r.custom.some(n => /Sardine 7ok/.test(n)), 'custom food added'); ok(/^c_/.test(r.sardInDay), 'day points at the new food id');
  eq(r.train, true, 'training on'); eq(r.tdays.join(), '0,2,4', 'training days'); eq(r.week[0], r.week[4], 'Monday = Friday template'); ok(r.prev, 'can be undone');
  Object.values(r.tot).forEach(d => ok(d.k > 1500 && Number.isFinite(d.p) && d.cost > 0, 'day total sensible'));
  eq(r.days2, 5, 'second import replaces same-named days'); eq(r.custom2, r.custom.length, 'no duplicate foods');
});
test('Backup', 'invalid JSON import leaves data untouched and explains', async ({ page }) => {
  const r = await page.evaluate(() => { const before = JSON.stringify(S); go('prix'); document.getElementById('impT').value = '{not json'; importData();
    return { same: JSON.stringify(S) === before, msg: document.getElementById('impMsg').textContent }; });
  ok(r.same, 'state changed'); ok(r.msg.length > 0, 'no error message');
});
test('Backup', 'structurally broken backup cannot break the app', async ({ page, errors }) => {
  const r = await page.evaluate(() => { const before = JSON.stringify(S); go('prix');
    document.getElementById('impT').value = JSON.stringify({ profiles: [{ id: 'x', goal: 'zzz', days: 'nope', week: 5, weights: [{ d: 3, w: 'a' }] }], recipes: 'bad', custom: [{ id: 1 }] });
    importData(); if (typeof importConfirm === 'function') importConfirm();
    let rendered = true; try { ['menu', 't9edya', 'recettes', 'ayyam', 'simana', 'profil', 'prix'].forEach(go) } catch (e) { rendered = 'throw: ' + e.message }
    return { rendered, tabs: document.querySelectorAll('#tabs button').length }; });
  eq(r.rendered, true, 'all tabs render'); eq(r.tabs, NAV_TABS, 'navigation buttons'); eq(errors.length, 0, 'page errors: ' + errors.join(' | '));
});
test('Backup', 'ids from a crafted backup cannot inject script', async ({ page }) => {
  const r = await page.evaluate(() => { const o = JSON.parse(JSON.stringify(S)); const bad = "x');window.__pw=1;('";
    o.profiles[0].id = bad; o.active = bad; o.profiles[0].days[0].id = bad + 'd'; o.profiles[0].week[0] = bad + 'd';
    go('prix'); document.getElementById('impT').value = JSON.stringify(o); importData(); if (typeof importConfirm === 'function') importConfirm();
    go('t9edya'); document.querySelectorAll('#view .chip').forEach(b => b.click()); go('ayyam'); document.querySelectorAll('#view .chip').forEach(b => b.click());
    const ids = [].concat(S.profiles.map(p => p.id), S.profiles.flatMap(p => p.days.map(d => d.id)));
    return { pw: window.__pw === 1, clean: ids.every(i => /^[A-Za-z0-9_-]+$/.test(i)) }; });
  ok(!r.pw, 'script ran from an imported id'); ok(r.clean, 'unsafe ids kept');
});
test('Backup', 'corrupted saved data is kept aside, not overwritten', async () => {
  const raw = '{"profiles":[{"id":"p1","name":"Mine"'; // truncated JSON
  const { page, ctx, errors } = await openApp({ seed: raw });
  await page.evaluate(() => { setTheme('dark'); go('profil'); });   // any action that saves
  const r = await page.evaluate(k => { const vals = []; for (let i = 0; i < localStorage.length; i++) vals.push(localStorage.getItem(localStorage.key(i))); return { kept: vals.some(v => v && v.includes('"name":"Mine"')), warn: !!document.getElementById('loadWarn') && !document.getElementById('loadWarn').hidden }; }, KEY);
  await ctx.close();
  ok(r.kept, 'original text lost after first save'); ok(r.warn, 'no warning shown'); eq(errors.length, 0, 'page errors');
});
test('Backup', 'storage failure is reported, not silently ignored', async ({ page }) => {
  const r = await page.evaluate(() => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function () { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; };
    setTheme('dark'); const el = document.getElementById('saveErr'); const shown = !!el && !el.hidden; Storage.prototype.setItem = orig; setTheme('light'); const gone = !el || el.hidden; return { shown, gone }; });
  ok(r.shown, 'no visible error when saving fails'); ok(r.gone, 'error stays after saving works again');
});
test('Backup', 'saved data with an unknown goal or activity still loads', async () => {
  const st = { profiles: [profileState({ goal: 'zzz', act: 'fast', sex: '?', weights: [{ d: '2026-01-01', w: '80' }] })], active: 'p1', prices: {}, custom: [] };
  st.profiles[0].days = [{ id: 'd1', name: 'A', meals: { ftour: [['bid', 'two']], ghda: [], kaskrout: [], '3cha': [] } }]; st.profiles[0].week = ['d1', null, null, null, null, null, null];
  const { page, ctx, errors } = await openApp({ seed: JSON.stringify(st) });
  const r = await page.evaluate(() => { let res = 'ok'; try { ['profil', 'ayyam', 'simana', 'menu', 't9edya'].forEach(go) } catch (e) { res = e.message } return { res, nan: /NaN|Infinity/.test(document.getElementById('view').innerText) }; });
  await ctx.close();
  eq(r.res, 'ok', 'tabs render'); ok(!r.nan, 'NaN shown'); eq(errors.length, 0, 'page errors: ' + errors.join(' | '));
});
test('Backup', 'data saved by the previous version (v24) loads unchanged, with no repairs', async () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'state-v24.json'), 'utf8');
  const { page, ctx, errors } = await openApp({ seed: JSON.stringify(JSON.parse(fixture)) });
  const r = await page.evaluate(() => ({ s: JSON.stringify(S), fixes: _fixes }));
  await ctx.close();
  const A = JSON.parse(fixture), B = JSON.parse(r.s);
  // the only intended migration: cooked rice "at home" now counts on the dry-rice purchase row
  ok(A.pantry.rouz === 0.3 && B.pantry.rouz_n === 0.3 && B.pantry.rouz === undefined, 'pantry rice migrated to the purchase row');
  delete A.pantry.rouz; A.pantry.rouz_n = 0.3;
  A.profiles.forEach(p => { if (!p.weights) p.weights = []; });   // the previous version also added this default when loading
  A.onboarded = true;   // existing users are marked as onboarded so they never see the first-run questions
  // v36: the one shared extra portion (d.pf) becomes the open profile's own portion (d.pfBy), same value
  const legacy = A.menu.days.filter(d => d.pf != null); ok(legacy.length > 0, 'fixture has a legacy portion');
  A.menu.days.forEach(d => { if (d.pf != null) { d.pfBy = { [A.active]: d.pf }; delete d.pf; } });
  const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
  for (const k of keys) eq(JSON.stringify(B[k]), JSON.stringify(A[k]), 'key ' + k);
  eq(r.fixes, 0, 'repairs on valid data'); eq(errors.length, 0, 'page errors');
});
test('Backup', 'a rendering error shows a recovery screen instead of a blank page', async ({ page, errors }) => {
  const r = await page.evaluate(() => { P().days = null; try { render() } catch (e) { return 'throw' } return document.getElementById('crash') ? 'panel' : 'none'; });
  eq(r, 'panel', 'recovery screen');
});

/* ======================================================================================
   8. Safety of rendering
   ====================================================================================== */
test('Security', 'user text (meal, day, recipe, food names) is shown as text, never run', async ({ page }) => {
  const r = await page.evaluate(() => { const x = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
    renameMeal('ghda', x); renameDay(x); newRecipe(); renameRecipe(x); upd('name', x);
    ['ayyam', 'recettes', 'profil', 't9edya', 'simana'].forEach(go); openSheet('ghda'); closeSheet(); return new Promise(res => setTimeout(() => res(window.__xss || 0), 300)); });
  eq(r, 0, 'injected handlers executed');
});

/* ======================================================================================
   9. Languages and RTL
   ====================================================================================== */
test('Languages', 'every tab in 5 languages: no missing text, NaN or raw placeholders; RTL for Arabic script', async ({ page }) => {
  const r = await page.evaluate(() => { makeMenu(); const bad = [];
    for (const l of ['dj', 'da', 'fr', 'ar', 'en']) { setLang(l);
      for (const tb of ['menu', 't9edya', 'recettes', 'ayyam', 'simana', 'profil', 'prix']) { go(tb); const tx = document.getElementById('view').innerText;
        if (/\{[a-z_]+\}|undefined|NaN|Infinity/.test(tx)) bad.push(l + '/' + tb + ': ' + (tx.match(/.{0,30}(\{[a-z_]+\}|undefined|NaN|Infinity).{0,30}/) || [''])[0]); }
      const dir = document.documentElement.dir; if ((l === 'da' || l === 'ar') !== (dir === 'rtl')) bad.push(l + ' dir=' + dir); }
    return bad; });
  eq(r.length, 0, r.join(' || '));
});

/* ======================================================================================
   10. Menu consistency after edits
   ====================================================================================== */
test('Menu', 'deleting a recipe used in the weekly menu does not break it', async ({ page, errors }) => {
  const r = await page.evaluate(() => { makeMenu(); const id = S.menu.days[0].ghda; delArm = 'rec' + id; delRecipe(id); let res = 'ok'; try { go('menu'); go('t9edya') } catch (e) { res = e.message }
    return { res, left: S.menu.days.some(d => d.ghda === id || d['3cha'] === id) }; });
  eq(r.res, 'ok', 'menu renders'); ok(!r.left, 'deleted recipe still referenced by the menu'); eq(errors.length, 0, 'page errors: ' + errors.join(' | '));
});
test('Menu', 'no NaN anywhere after generating a menu, snacks and carb top-ups', async ({ page }) => {
  const r = await page.evaluate(() => { const p = P(); p.train = true; p.tdays = [0, 2, 4]; makeMenu(); for (let i = 0; i < 7; i++) { fillProt(i, true); fillCarb(i) }
    go('menu'); const a = document.getElementById('view').innerText; go('t9edya'); const b = document.getElementById('view').innerText; return /NaN|Infinity|undefined/.test(a + b); });
  ok(!r, 'NaN/undefined shown');
});

/* ======================================================================================
   11. Custom food validation
   ====================================================================================== */
test('Foods', 'impossible custom food values are refused (more than 100 g of macros per 100 g)', async ({ page }) => {
  const r = await page.evaluate(() => { go('prix'); const n0 = S.custom.length; const set = (i, v) => document.getElementById(i).value = v;
    set('cN', 'Test'); set('cU', 'g'); set('cP', '10'); set('cK', '400'); set('cPr', '80'); set('cC', '50'); set('cF', '10'); addCustom(); return S.custom.length - n0; });
  eq(r, 0, 'custom food with 140 g macros per 100 g was accepted');
});

/* ======================================================================================
   12. PWA: manifest, offline start, updates
   ====================================================================================== */
test('PWA', 'manifest is valid and icons exist with the declared sizes', async () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  for (const k of ['name', 'short_name', 'start_url', 'display', 'icons']) ok(m[k], 'manifest.' + k);
  for (const ic of m.icons) { const f = path.join(ROOT, ic.src); ok(fs.existsSync(f), ic.src + ' missing'); const b = fs.readFileSync(f);
    eq(b.readUInt32BE(16) + 'x' + b.readUInt32BE(20), ic.sizes, ic.src + ' size'); }
  ok(m.icons.some(i => i.purpose === 'maskable'), 'maskable icon');
});
async function swReady(page) { await page.evaluate(() => navigator.serviceWorker.ready); await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 8000 }).catch(() => page.reload()); await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 8000 }); }
test('PWA', 'app starts offline after the first visit', async () => {
  const { page, ctx } = await openApp({ sw: true }); await swReady(page);
  serverDown = true; await page.reload().catch(() => {}); const r = await page.evaluate(() => document.querySelectorAll('#tabs button').length).catch(() => 0);
  serverDown = false; await ctx.close(); eq(r, NAV_TABS, 'app rendered offline');
});
test('PWA', 'a 404 page never replaces the cached app', async () => {
  const { page, ctx } = await openApp({ sw: true }); await swReady(page);
  await page.goto(BASE + 'does-not-exist').catch(() => {});
  await page.waitForTimeout(1500);   // the service worker writes its cache asynchronously
  serverDown = true; await page.goto(BASE).catch(() => {}); const r = await page.evaluate(() => document.querySelectorAll('#tabs button').length).catch(() => 0);
  serverDown = false; await ctx.close(); eq(r, NAV_TABS, 'app shell offline after visiting a missing page');
});
test('PWA', 'a new version replaces the old cache', async () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  overrides['/sw.js'] = { type: 'text/javascript', body: sw.replace(/const VERSION = '[^']+'/, "const VERSION = 'test-v1'") };
  const { page, ctx } = await openApp({ sw: true }); await swReady(page);
  const k1 = await page.evaluate(() => caches.keys());
  overrides['/sw.js'] = { type: 'text/javascript', body: sw.replace(/const VERSION = '[^']+'/, "const VERSION = 'test-v2'") };
  await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
  let k2 = [];
  for (let i = 0; i < 50; i++) { k2 = await page.evaluate(() => caches.keys()); if (k2.join() === 'test-v2') break; await page.waitForTimeout(200); } delete overrides['/sw.js']; await ctx.close();
  ok(k1.includes('test-v1'), 'first cache ' + k1); eq(k2.join(), 'test-v2', 'caches after update');
});
test('PWA', 'slow network: offline copy is used instead of waiting forever', async () => {
  const { page, ctx } = await openApp({ sw: true }); await swReady(page);
  overrides['/'] = { delay: 20000 }; overrides['/index.html'] = { delay: 20000 };
  const t0 = Date.now(); await page.goto(BASE, { timeout: 15000 }).catch(() => {}); const ms = Date.now() - t0;
  const tabs = await page.evaluate(() => document.querySelectorAll('#tabs button').length).catch(() => 0);
  delete overrides['/']; delete overrides['/index.html']; await ctx.close();
  eq(tabs, NAV_TABS, 'app shown'); ok(ms < 9000, 'took ' + ms + ' ms');
}, { slow: true });

/* ======================================================================================
   13. New interface: navigation, settings, onboarding
   ====================================================================================== */
test('Interface', 'four bottom sections; settings, profile, days and week still reachable (old names work)', async ({ page, errors }) => {
  const r = await page.evaluate(() => { const out = {}; out.nav = [...document.querySelectorAll('#tabs button')].map(b => b.textContent.trim());
    go('prix'); out.backup = !!document.getElementById('impT'); out.lang = !!document.getElementById('langSel');
    go('ayyam'); out.ayyam = tab === 'ana' && anaSub === 'ayyam' && !!document.getElementById('dName');
    go('simana'); out.simana = !!document.querySelector('#view .week');
    go('profil'); out.profil = !!document.getElementById('pW');
    document.getElementById('setBtn').click(); out.settingsBtn = tab === 'reglages';
    return out; });
  eq(r.nav.length, NAV_TABS, 'bottom sections'); ok(r.backup && r.lang, 'settings: backup + language'); ok(r.ayyam, 'days'); ok(r.simana, 'week'); ok(r.profil, 'profile');
  ok(r.settingsBtn, 'header settings button'); eq(errors.length, 0, 'page errors: ' + errors.join(' | '));
});
test('Interface', 'first run: 4 questions produce a profile, a weekly menu and a list', async () => {
  const { page, ctx, errors } = await openApp({ keepOnboarding: true });
  const r = await page.evaluate(() => { const shown = !!document.querySelector('#obRoot .ob');
    obGo(1); ob.people = 3; obGo(1); obToggle('fish'); ob.time = 30; obGo(1); ob.budget = '500'; obGo(1);
    ob.macros = true; ob.name = 'Sara'; ob.sex = 'f'; ob.age = '31'; ob.w = '64'; ob.h = '166'; ob.goal = 'cut'; obFinish();
    const p = P(); return { shown, closed: !document.querySelector('#obRoot .ob'), onboarded: S.onboarded, people: S.menu.set.people, excl: S.menu.set.excl, time: S.menu.set.time,
      days: S.menu.days.length, name: p.name, age: p.age, example: p.example, rows: shopData().rows.length, budget: S.budget, noFish: S.menu.days.every(d => [d.ghda, d['3cha']].filter(Boolean).every(id => protOf(recipe(id)) !== 'fish')) }; });
  await ctx.close();
  ok(r.shown, 'questions shown on first run'); ok(r.closed, 'closed at the end'); eq(r.onboarded, true, 'remembered');
  eq(r.people, 3, 'people'); ok(r.excl.includes('fish') && r.noFish, 'no fish in the menu'); eq(r.time, 30, 'time limit');
  eq(r.days, 7, 'menu days'); eq(r.name, 'Sara', 'profile name'); eq(r.age, 31, 'age'); eq(r.example, false, 'real profile'); ok(r.rows > 5, 'shopping list filled');
  eq(r.budget, String(Math.round(500 * 30 / 7)), 'monthly budget from the weekly answer'); eq(errors.length, 0, 'page errors');
});
test('Interface', 'first run without macros: no calorie analysis, menu and list still work', async () => {
  const { page, ctx, errors } = await openApp({ keepOnboarding: true });
  const r = await page.evaluate(() => { obGo(1); obGo(1); obGo(1); obGo(1); ob.macros = false; obFinish(); go('menu'); const v = document.getElementById('view');
    return { noTargets: P().noTargets === true, fit: !!v.querySelector('.dfit'), rows: shopData().rows.length }; });
  await ctx.close();
  ok(r.noTargets, 'profile marked'); ok(!r.fit, 'no day analysis shown'); ok(r.rows > 5, 'list filled'); eq(errors.length, 0, 'page errors');
});

test('Interface', 'shopping list follows the trip: greengrocer, butcher, fishmonger, bread, grocery', async ({ page }) => {
  const r = await page.evaluate(() => {
    const d = { id: 'd1', name: 'D', meals: { ftour: [['khobz', 0.5], ['bid', 2]], ghda: [['sder', 200], ['maticha', 150]], kaskrout: [], '3cha': [['sardine', 200]] } };
    S.profiles = [Object.assign(P(), { id: 'pa', days: [d], week: ['d1', null, null, null, null, null, null] })]; S.active = 'pa'; S.shop = { pa: true }; S.menu = null; S.pantry = {}; save(); go('t9edya');
    const place = id => { const el = document.querySelector(`#view .li[data-id="${id}"]`); return el && el.dataset.place; };
    const txt = shopText(shopData().rows); const pos = k => txt.indexOf(t('place_' + k));
    return { sder: place('sder'), maticha: place('maticha'), sardine: place('sardine'), khobz: place('khobz'), bid: place('bid'),
      order: ['khddar', 'gezzar', '7awwat', 'ferran', '7anout'].map(pos), wholeDh: !/\d+\.\d{2}\s*DH/.test(document.querySelector('#view .receipt').innerText) };
  });
  eq(r.sder, 'gezzar', 'chicken breast'); eq(r.maticha, 'khddar', 'tomatoes'); eq(r.sardine, '7awwat', 'sardines'); eq(r.khobz, 'ferran', 'bread'); eq(r.bid, '7anout', 'eggs');
  ok(r.order.every((v, i, a) => v >= 0 && (i === 0 || v > a[i - 1])), 'WhatsApp text grouped in shop order: ' + r.order);
  ok(r.wholeDh, 'list amounts in whole dirhams');
});
test('Interface', 'menu days are folded except one; a tap opens a day; tips stay dismissed', async ({ page }) => {
  const r = await page.evaluate(() => { makeMenu(); go('menu'); const open0 = document.querySelectorAll('#view .mday.open').length, lists = document.querySelectorAll('#view .mlist').length;
    const other = (todayIdx() + 3) % 7; document.querySelectorAll('#view .mday-h')[other].click(); const nowOpen = openDay;
    go('t9edya'); const tipBefore = !!document.querySelector('#view .tip'); hideTip('list'); hideTip('listmenu'); hideTip('newweek'); go('t9edya');
    return { open0, lists, nowOpen, other, tipBefore, tipAfter: !!document.querySelector('#view .tip'), saved: JSON.parse(localStorage.getItem('makla_mizan_v2')).tips.list === 1 }; });
  eq(r.open0, 1, 'days open at first'); eq(r.lists, 6, 'folded days with meal names'); eq(r.nowOpen, r.other, 'tapped day opens');
  ok(r.tipBefore && !r.tipAfter && r.saved, 'tip dismissed and remembered');
});

/* ======================================================================================
   14. Cooking mode, steps, favourites
   ====================================================================================== */
const MOCK_WAKELOCK = () => { window.__wl = { req: 0, rel: 0 };
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { __wl.req++;
    return { _l: [], released: false, addEventListener(e, f) { this._l.push(f); }, release() { if (!this.released) { this.released = true; __wl.rel++; this._l.forEach(f => f()); } return Promise.resolve(); } }; } } }); };
test('Cooking', 'every built-in recipe has 3 to 7 written steps', async ({ page }) => {
  const r = await page.evaluate(() => { const keys = SEED_RECIPES.map(x => x[0]);
    return { missing: keys.filter(k => !Array.isArray(STEPS[k])), extra: Object.keys(STEPS).filter(k => !keys.includes(k)),
      badCount: keys.filter(k => Array.isArray(STEPS[k]) && !(STEPS[k].length >= 3 && STEPS[k].length <= 7)),
      badText: keys.filter(k => Array.isArray(STEPS[k]) && STEPS[k].some(s => typeof s !== 'string' || s.trim().length < 10 || s.length > 500)) }; });
  eq(r.missing.length, 0, 'recipes without steps: ' + r.missing); eq(r.extra.length, 0, 'steps for unknown recipes: ' + r.extra);
  eq(r.badCount.length, 0, 'step count outside 3–7: ' + r.badCount); eq(r.badText.length, 0, 'empty or over-long steps: ' + r.badText);
});
test('Cooking', 'cooking mode: amounts follow the portions, one step per screen, screen kept on then released', async ({ page, errors }) => {
  await page.evaluate(MOCK_WAKELOCK);
  const r = await page.evaluate(async () => { const wait = ms => new Promise(res => setTimeout(res, ms));
    go('recettes'); editRec = 'r_tajine_kefta'; render(); document.querySelector('#view .rec-cook .btn.pri').click(); await wait(30);
    const amt = () => [...document.querySelectorAll('.cook-ing li b')].map(b => b.textContent.trim());
    const at4 = amt(), awake = !!document.querySelector('.cook-wake');
    for (let i = 0; i < 4; i++) document.querySelectorAll('.cook-n button')[1].click();   // +0.5 × 4 → 6 portions
    const at6 = amt(), n = STEPS.tajine_kefta.length, seen = [];
    for (let i = 0; i < n; i++) { document.querySelector('.cook-foot .btn.pri').click(); seen.push(document.querySelector('.cook-s').textContent); }
    document.querySelector('.cook-foot .btn.pri').click(); const done = !!document.querySelector('.cook-done');
    document.querySelector('.cook-foot .btn.pri').click(); await wait(30);
    return { at4, at6, awake, seen, steps: STEPS.tajine_kefta, done, closed: !cook && !document.querySelector('#cookRoot .cook'), wl: __wl, noscroll: document.body.classList.contains('noscroll') }; });
  // tajine kefta serves 4: kefta 500 g, tomatoes 1020 g, eggs 4, olive oil 5 spoons (items 0, 1, 5, 6)
  near(parseFloat(r.at4[0]), 500, 0, 'kefta for 4'); near(parseFloat(r.at4[1]), 1020, 0, 'tomatoes for 4'); near(parseFloat(r.at4[5]), 4, 0, 'eggs for 4');
  near(parseFloat(r.at6[0]), 750, 0, 'kefta for 6'); near(parseFloat(r.at6[1]), 1530, 0, 'tomatoes for 6'); near(parseFloat(r.at6[5]), 6, 0, 'eggs for 6');
  ok(r.at6[6].startsWith('7½'), 'oil for 6 shown as 7½: ' + r.at6[6]);
  eq(JSON.stringify(r.seen), JSON.stringify(r.steps), 'every step shown once, in order'); ok(r.done, 'end screen');
  ok(r.awake, 'screen-on badge'); eq(r.wl.req, 1, 'screen lock asked once'); eq(r.wl.rel, 1, 'screen lock released on close');
  ok(r.closed && !r.noscroll, 'closed and page scrolls again'); eq(errors.length, 0, 'page errors: ' + errors.join(' | '));
});
test('Cooking', 'from the menu: household plus the extra portion; phone back button closes cooking mode', async ({ page }) => {
  const r = await page.evaluate(async () => { const wait = ms => new Promise(res => setTimeout(res, ms));
    S.menuSet = { people: 3, budget: '', time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }; makeMenu();
    S.menu.days[0].pfBy = { [P().id]: 1.5 }; save(); openDay = 0; go('menu');
    const btn = [...document.querySelectorAll('#view .mday.open .mcard .mbtns .btn')].find(b => b.textContent.includes('👨‍🍳'));
    btn.click(); const n = cook && cook.n, rid = cook && cook.rid;
    history.back(); await wait(150);
    return { n, rid, ghda: S.menu.days[0].ghda, closedByBack: !cook && !document.querySelector('#cookRoot .cook') }; });
  eq(r.rid, r.ghda, 'lunch recipe opened'); near(r.n, 3.5, 1e-9, 'portions = 3 people + 0.5 extra'); ok(r.closedByBack, 'back button closes it');
});
test('Cooking', 'steps can be edited; equal to the built-in = not stored; renaming keeps them; user text stays text', async ({ page }) => {
  const r = await page.evaluate(async () => { const wait = ms => new Promise(res => setTimeout(res, ms));
    const setTa = v => { const ta = document.getElementById('rSteps'); ta.value = v; ta.dispatchEvent(new Event('change')); };
    go('recettes'); editRec = 'r_harira'; render(); const orig = document.getElementById('rSteps').value;
    setTa('A\n\n  B  \nC'); const edited = recipe('r_harira').steps.slice();
    setTa(orig); const restored = !('steps' in recipe('r_harira'));
    renameRecipe('Harira dyal mama'); const renamed = !recipe('r_harira').key && recSteps(recipe('r_harira')).length === STEPS.harira.length;
    newRecipe(); const id = editRec; setTa('<img src=x onerror="window.__x=1">\nY');
    cookOpen(id, 2); cookGo(1); await wait(30);
    const shown = document.querySelector('.cook-s').textContent; cookClose(); await wait(30);
    const stored = JSON.parse(localStorage.getItem('makla_mizan_v2')).recipes.find(x => x.id === id).steps;
    return { edited, restored, renamed, shown, stored, x: window.__x }; });
  eq(JSON.stringify(r.edited), JSON.stringify(['A', 'B', 'C']), 'one line = one step, blanks dropped');
  ok(r.restored, 'built-in text not stored'); ok(r.renamed, 'renamed built-in keeps its steps');
  eq(r.shown, '<img src=x onerror="window.__x=1">', 'shown as text'); eq(r.x, undefined, 'never run'); eq(r.stored.length, 2, 'saved');
});
test('Cooking', 'favourites: heart on the card, filter, removed with the recipe; bad backup entries cleaned', async ({ page }) => {
  const r = await page.evaluate(() => {
    go('recettes'); recCat = 'all'; render();
    const card = [...document.querySelectorAll('#view .rcard')].find(c => c.querySelector('.rtx b').textContent === recName(recipe('r_3des')));
    card.querySelector('.fav').click(); const fav1 = S.fav.slice();
    const pressed = [...document.querySelectorAll('#view .rcard')].find(c => c.querySelector('.rtx b').textContent === recName(recipe('r_3des'))).querySelector('.fav').getAttribute('aria-pressed');
    recCat = 'fav'; render(); const shown = document.querySelectorAll('#view .rcard').length;
    delRecipe('r_3des'); delRecipe('r_3des'); const afterDel = S.fav.slice();
    const prev = S; S = JSON.parse(JSON.stringify(prev)); S.fav = ['r_tajine', 'nope', 42, 'r_tajine'];
    S.recipes[0].steps = 'not a list'; S.recipes[1].steps = ['ok step', 7, '', 'x'.repeat(900)].concat(Array(40).fill('s'));
    _fixes = 0; normalize(); const out = { fav: S.fav, s0: S.recipes[0].steps, s1len: S.recipes[1].steps.length, s1max: Math.max(...S.recipes[1].steps.map(s => s.length)), fixes: _fixes };
    S = prev; _foods = null; return { fav1, pressed, shown, afterDel, out }; });
  ok(r.fav1.includes('r_3des'), 'added to favourites'); eq(r.pressed, 'true', 'heart shows pressed'); eq(r.shown, 1, 'favourites filter');
  ok(!r.afterDel.includes('r_3des'), 'deleted recipe leaves favourites');
  eq(JSON.stringify(r.out.fav), JSON.stringify(['r_tajine']), 'unknown, non-text and repeated favourites dropped');
  eq(r.out.s0, undefined, 'non-list steps dropped'); ok(r.out.s1len <= 30 && r.out.s1max <= 500, 'steps capped (30 × 500 chars)'); ok(r.out.fixes >= 3, 'repairs counted');
});

/* ======================================================================================
   15. Weight goal and waist
   ====================================================================================== */
const seedWeights = (from, to, days) => { const out = []; const base = Date.UTC(2026, 8, 1);
  for (let i = 0; i < days; i++) { const d = new Date(base + i * 864e5).toISOString().slice(0, 10); out.push({ d, w: Math.round((from + (to - from) * i / (days - 1)) * 1000) / 1000 }); } return out; };
test('Weight goal', 'healthy range from height, goal below it refused, progress / pace / date from the trend', async ({ page }) => {
  const W = seedWeights(90, 87, 28);   // 28 daily weigh-ins, straight line: −3 kg over 27 days = −0.7778 kg/week
  const r = await page.evaluate(W => { const p = P(); Object.assign(p, { h: 180, age: 30, goal: 'cut', weights: W, w: 87, example: false }); delete p.noTargets; save(); go('profil');
    const range = document.querySelector('#gwPanel .hint').textContent;
    document.getElementById('gwVal').value = '55'; setGoalW(); const refused = P().goalW === undefined, err = document.getElementById('gwErr').textContent;
    document.getElementById('gwVal').value = '80'; setGoalW(); const panel = document.getElementById('gwPanel').innerText;
    return { range, refused, err, goal: P().goalW, start: P().goalStart, panel }; }, W);
  // range: 18.5 × 1.8² = 59.94 → 60.0 (rounded up), 24.9 × 1.8² = 80.68 → 80.6 (rounded down)
  ok(r.range.includes('60') && r.range.includes('80.6'), 'range shown: ' + r.range);
  ok(r.refused && r.err.includes('60'), 'goal under the healthy range refused with the limit');
  // 7-day average of the last 7 weigh-ins = 90 − 3×24/27 = 87.33; left = 7.33 kg; weeks = ceil(7.33 / 0.7778) = 10
  eq(r.goal, 80, 'goal saved'); near(r.start, 87.3, 0.05, 'start = current 7-day average');
  ok(r.panel.includes('87.3 → 80.0'), 'current → goal'); ok(r.panel.includes('7.3'), 'kg left'); ok(r.panel.includes('-0.78'), 'pace per week');
  ok(/\b10\b/.test(r.panel), 'about 10 weeks to go: ' + r.panel.slice(0, 300));
});
test('Weight goal', 'stall and goal/profile mismatch flagged; waist ratio bands; hidden for under-18s and without body data; bad data cleaned', async ({ page }) => {
  const flat = seedWeights(85, 85, 24);
  const r = await page.evaluate(flat => { const p = P(); Object.assign(p, { h: 180, age: 30, goal: 'bulk', weights: flat, w: 85, example: false, goalW: 78, goalStart: 85 }); delete p.noTargets;
    p.waists = [{ d: '2026-09-01', c: 90 }, { d: '2026-09-20', c: 86 }]; save(); go('profil');
    const panel = document.getElementById('gwPanel').innerText;
    const out = { panel, stall: panel.includes(t('gw_stall').slice(0, 30)), conflict: panel.includes(t('gw_conflict_lose').slice(0, 30)), band1: panel.includes(t('wa_ok')), recomp: panel.includes(t('wa_recomp').slice(0, 25)) };
    document.getElementById('waVal').value = '104'; logWaist(); out.band2 = document.getElementById('gwPanel').innerText.includes(t('wa_mid'));
    p.age = 16; save(); render(); out.minorHidden = !document.getElementById('gwPanel');
    p.age = 30; p.noTargets = true; save(); render(); out.noTargetsHidden = !document.getElementById('gwPanel'); delete p.noTargets;
    const prev = S; S = JSON.parse(JSON.stringify(prev)); S.profiles[0].goalW = 'x'; S.profiles[0].goalStart = 999; S.profiles[0].waists = [{ d: 'bad', c: 80 }, { d: '2026-09-01', c: 20 }, { d: '2026-09-02', c: 81 }];
    _fixes = 0; normalize(); out.clean = { goalW: S.profiles[0].goalW, waists: S.profiles[0].waists.length, fixes: _fixes }; S = prev; _foods = null; return out; }, flat);
  ok(r.stall, 'flat 3 weeks → stall advice'); ok(r.conflict, 'lower goal with a bulking profile → mismatch flagged');
  ok(r.band1, '86 / 180 = 0.48 → good band'); ok(r.recomp, 'waist −4 cm with flat weight → recomposition note');
  ok(r.band2, '104 / 180 = 0.58 → watch band'); ok(r.minorHidden, 'hidden under 18'); ok(r.noTargetsHidden, 'hidden without body data');
  eq(r.clean.goalW, undefined, 'bad goal dropped'); eq(r.clean.waists, 1, 'bad waist entries dropped'); ok(r.clean.fixes >= 3, 'repairs counted');
});

test('Menu', 'meal cards show one portion and the profile’s own share, which add up to the day total', async ({ page }) => {
  const r = await page.evaluate(() => { makeMenu(); const d = S.menu.days[0]; delete d.snack; delete d.snack2; delete d.side; d.pfBy = { [P().id]: 2.5 }; save(); openDay = 0; go('menu');
    const num = (el, re) => { const m = el.innerText.match(re); return m ? parseFloat(m[1]) : NaN; };
    const cards = [...document.querySelectorAll('#view .mday.open .mcard')]; const P1 = /P\s*([\d.]+)/;
    const lines = cards.map(c => ({ one: c.querySelector('.mm .pl') ? num(c.querySelector('.mm .pl').parentElement, P1) : num(c.querySelectorAll('.mm')[1], P1), mine: c.querySelector('.mm.mine') ? num(c.querySelector('.mm.mine'), P1) : null }));
    const pb = [...document.querySelectorAll('#view .mday.open .dfit .bar')].find(b => b.innerText.includes(t('prot'))); const shown = num(pb, /([\d.]+)\s*\//);
    return { lines, shown }; });
  const [ft, l, dn] = r.lines;
  near(l.mine, l.one * 2.5, 0.15, 'lunch: own share = 2.5 × one portion'); near(dn.mine, dn.one * 2.5, 0.15, 'dinner: own share = 2.5 × one portion');
  eq(ft.mine, null, 'breakfast is not scaled'); near(r.shown, ft.one + l.mine + dn.mine, 1, 'day protein = breakfast + own lunch + own dinner');
});

/* E1: each profile's ± portion is its own (d.pfBy), never shared with the other eaters */
const TWO = () => { const base = JSON.parse(JSON.stringify(S.profiles[0]));
  const M = Object.assign(JSON.parse(JSON.stringify(base)), { id: 'pM', name: 'Mohammed', example: false, sex: 'm', age: 27, w: 80, h: 180, act: 1.55, goal: 'leanbulk', train: false });
  const R = Object.assign(JSON.parse(JSON.stringify(base)), { id: 'pR', name: 'Rayan', example: false, sex: 'm', age: 27, w: 62, h: 172, act: 1.2, goal: 'cut', train: false });
  S.profiles = [M, R]; S.active = 'pM'; S.shop = { menu: true, pM: false, pR: false }; S.pantry = {}; S.oil = 1;
  S.menu = { set: { people: 2, budget: '', time: 60, excl: [], meals: { ftour: false, ghda: true, '3cha': false } }, days: [{ ghda: 'r_3des' }, {}, {}, {}, {}, {}, {}], at: 1 }; save(); };
test('Menu', 'portions per profile: Mohammed’s ± does not move Rayan’s and back; kept after reload; list and split use each one’s own portion', async ({ page }) => {
  const r = await page.evaluate(TWO => { eval('(' + TWO + ')')();
    const f = id => dayFit(S.menu.days[0], S.profiles.find(p => p.id === id)).f;
    const sug = { M: f('pM'), R: f('pR') };
    S.active = 'pM'; setPf(0, 1); setPf(0, 1); const afterM = { M: f('pM'), R: f('pR') };
    S.active = 'pR'; setPf(0, -1); const afterR = { M: f('pM'), R: f('pR') };
    return { sug, afterM, afterR, stored: JSON.stringify(S.menu.days[0].pfBy), legacy: 'pf' in S.menu.days[0] }; }, TWO.toString());
  near(r.afterM.M, r.sug.M + 0.5, 1e-9, 'Mohammed +2 steps'); near(r.afterM.R, r.sug.R, 1e-9, 'Rayan unchanged by Mohammed');
  near(r.afterR.R, Math.max(.5, r.sug.R - 0.25), 1e-9, 'Rayan −1 step'); near(r.afterR.M, r.sug.M + 0.5, 1e-9, 'Mohammed unchanged by Rayan');
  ok(!r.legacy, 'no shared value written');
  await page.reload(); await page.waitForTimeout(300);
  const q = await page.evaluate(() => { const f = id => dayFit(S.menu.days[0], S.profiles.find(p => p.id === id)).f;
    const rc = recipe('r_3des'), lent = rc.items.find(x => x[0] === '3des_n')[1], E = portionEaters();
    const sp = Object.fromEntries(menuSplit().map(x => [x.n, x.c]));
    return { M: f('pM'), R: f('pR'), tot: menuTotal(0), eat: [E.pM.f[0], E.pR.f[0]], kg: shopData().rows.find(x => x.id === '3des_n').week, lentKg: lent / rc.servings * 0.001, cost: recCost(rc), sp }; });
  near(q.M, r.afterR.M, 1e-9, 'Mohammed kept after reload'); near(q.R, r.afterR.R, 1e-9, 'Rayan kept after reload');
  near(q.eat[0], q.M, 1e-9, 'household portions: Mohammed'); near(q.eat[1], q.R, 1e-9, 'household portions: Rayan');
  near(q.tot, q.M + q.R, 0.011, 'day total = own portions'); near(q.kg, (q.M + q.R) * q.lentKg, 1e-6, 'lentils on the list = sum of own portions');
  near(q.sp.Mohammed, q.cost * q.M, 0.01, 'Mohammed pays his portion'); near(q.sp.Rayan, q.cost * q.R, 0.01, 'Rayan pays his portion');
});
test('Menu', 'a menu saved before v36 (one shared d.pf) loads: the value goes to the open profile, the other keeps the suggestion; bad values cleaned', async () => {
  const { ctx, page } = await openApp();
  try {
    const sug = await page.evaluate(TWO => { eval('(' + TWO + ')')(); const d = S.menu.days[0]; const s = { M: dayFit(d, P()).sug, R: dayFit(d, S.profiles[1]).sug };
      S.menu.days[0].pf = 1.75; S.menu.days[1] = { ghda: 'r_3des', pf: 9, pfBy: { 'bad id!': 2, pR: 7 } }; save(); return s; }, TWO.toString());
    await page.reload(); await page.waitForTimeout(300);
    const r = await page.evaluate(() => { const d = S.menu.days[0], saved = JSON.parse(localStorage.getItem('makla_mizan_v2')).menu.days;
      return { M: dayFit(d, S.profiles[0]).f, R: dayFit(d, S.profiles[1]).f, d0: saved[0], d1: saved[1] }; });
    near(r.M, 1.75, 1e-9, 'old portion kept for the open profile'); near(r.R, sug.R, 1e-9, 'other profile keeps the suggestion');
    ok(!('pf' in r.d0) && r.d0.pfBy && r.d0.pfBy.pM === 1.75, 'migrated and saved as pfBy'); ok(!('pf' in r.d1) && !r.d1.pfBy, 'out-of-range and bad entries dropped');
  } finally { await ctx.close(); }
});

/* ======================================================================================
   16. Shared home (sync between two phones)
   ====================================================================================== */
async function phone(name, color) { const env = await openApp(); await env.page.evaluate(([api, n, c]) => { localStorage.setItem('makla_sync_api', api); darForm.n = n; darForm.c = c; }, [BASE + 'fs', name, color]); return env; }
test('Sync', 'two phones: ticks, menu and prices reach the other phone with the sender’s colour; private profile stays private; offline changes are sent later', async () => {
  const A = await phone('Mohammed', '#2f8f5b'), B = await phone('Sara<b>x</b>', '#2f6fbf');
  try {
    const hid = await A.page.evaluate(async () => { makeMenu(); P().weights = [{ d: '2026-10-01', w: 81.2 }]; P().example = false; save(); go('reglages'); await darCreate(); return SY.hid; });
    ok(/^[A-Za-z0-9]{28}$/.test(hid), 'random 28-character code'); ok(fsDocs[hid], 'home created on the server');
    const joined = await B.page.evaluate(async hid => { go('reglages'); darForm.code = hid; render(); await darJoin(); return { menu: S.menu && S.menu.days.map(d => d.ghda), me: SY.me.id }; }, hid);
    const menuA = await A.page.evaluate(() => S.menu.days.map(d => d.ghda));
    eq(JSON.stringify(joined.menu), JSON.stringify(menuA), 'joining phone receives the menu');
    // A ticks an item; B sees it with A's colour
    const item = await A.page.evaluate(async () => { const id = shopData().rows[0].id; chk(id, true); await syncNow(); return id; });
    const b1 = await B.page.evaluate(async id => { await syncNow(); go('t9edya'); const dot = document.querySelector(`#view .li[data-id="${id}"] .sdot`); return { ticked: !!S.checked[id], dot: dot && dot.style.background, title: dot && dot.title }; }, item);
    ok(b1.ticked, 'tick reached the other phone'); ok(/47, 143, 91|2f8f5b/i.test(b1.dot || ''), 'marked with the sender colour: ' + b1.dot); ok((b1.title || '').includes('Mohammed'), 'marked with the sender name');
    // B changes Wednesday's lunch; A sees it, marked in B's colour, and a toast names B (escaped)
    const newId = await B.page.evaluate(async () => { const o = swapOptions(2, 'ghda')[0].id; setMeal(2, 'ghda', o); await syncNow(); return o; });
    const a1 = await A.page.evaluate(async () => { await syncNow(); openDay = null; go('menu'); const dot = document.querySelectorAll('#view .mday-h')[2].querySelector('.sdot');
      const toastTxt = document.getElementById('toastRoot').textContent; go('reglages'); return { ghda: S.menu.days[2].ghda, dot: dot && dot.style.background, toastTxt, html: !!document.querySelector('#darBox .mem b b') }; });
    eq(a1.ghda, newId, 'menu change reached the first phone'); ok(/47, 111, 191|2f6fbf/i.test(a1.dot || ''), 'day marked in the other colour');
    ok(a1.toastTxt.includes('Sara'), 'toast names who changed it'); ok(!a1.html, 'member name shown as text');
    // edits to different things at the same time both survive
    await A.page.evaluate(() => setP('bid', 1.9)); await B.page.evaluate(() => setP('maticha', 9));
    await A.page.evaluate(() => syncNow()); await B.page.evaluate(() => syncNow()); await A.page.evaluate(() => syncNow());
    const pa = await A.page.evaluate(() => [S.prices.bid, S.prices.maticha]), pb = await B.page.evaluate(() => [S.prices.bid, S.prices.maticha]);
    eq(JSON.stringify(pa), '[1.9,9]', 'phone A has both prices'); eq(JSON.stringify(pb), '[1.9,9]', 'phone B has both prices');
    // profiles stay on the phone unless shared
    ok(!JSON.stringify(fsDocs[hid]).includes('81.2'), 'private weight never sent');
    await A.page.evaluate(async () => { toggleShareProf(P().id); await syncNow(); });
    const shared = await B.page.evaluate(async () => { await syncNow(); return S.profiles.some(p => p.weights && p.weights.some(w => w.w === 81.2)); });
    ok(shared, 'a profile marked as shared reaches the other phone');
    // offline: kept, then sent
    serverDown = true;
    const off = await B.page.evaluate(async () => { while (_syncBusy) await new Promise(r => setTimeout(r, 50)); const id = shopData().rows.find(x => !S.checked[x.id]).id; chk(id, true); await syncNow(); return { st: _syncState, pend: syncPending(), id }; });
    serverDown = false;
    ok(off.st === 'off' || off.st === 'err', 'offline state shown: ' + off.st); ok(off.pend > 0, 'change kept while offline');
    await B.page.evaluate(() => syncNow());
    const got = await A.page.evaluate(async id => { await syncNow(); return !!S.checked[id]; }, off.id);
    ok(got, 'offline change sent when the connection returned');
    eq(A.errors.length + B.errors.length, 0, 'page errors: ' + A.errors.concat(B.errors).join(' | '));
  } finally { serverDown = false; await A.ctx.close(); await B.ctx.close(); }
});
test('Sync', 'wrong code, unknown home and refused server are explained; leaving keeps the data; Firestore is never served from cache', async () => {
  const A = await phone('Ali', '#c2572b');
  try {
    const r = await A.page.evaluate(async () => { go('reglages'); const msg = () => document.getElementById('darMsg').textContent;
      darForm.code = 'short'; renderDarBox(); await darJoin(); const bad = msg();
      darForm.code = 'Z'.repeat(28); renderDarBox(); await darJoin(); const unknown = msg(); const notJoined = SY === null;
      const before = S.recipes.length; await darCreate(); const inHome = !!SY; darLeave(); darLeave();
      return { bad, unknown, notJoined, inHome, out: SY === null, kept: S.recipes.length === before, saved: localStorage.getItem('makla_mizan_v2_sync') }; });
    ok(r.bad.length > 3 && r.unknown.length > 3 && r.bad !== r.unknown, 'two different explanations'); ok(r.notJoined, 'not joined to a missing home');
    ok(r.inHome && r.out && r.kept, 'left the home, data kept'); eq(r.saved, null, 'home code forgotten on this phone');
    const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    ok(!/endsWith\('googleapis\.com'\)/.test(sw) && /fonts\.googleapis\.com/.test(sw), 'service worker caches fonts only, never the Firestore API');
  } finally { await A.ctx.close(); }
});

test('Sync', 'same home, different profiles open: both phones get the same shopping list (portions shared, body data not)', async () => {
  const A = await phone('Mohammed', '#2f8f5b'), B = await phone('Rayan', '#2f6fbf');
  try {
    const hid = await A.page.evaluate(async () => { Object.assign(P(), { name: 'Mohammed', example: false, sex: 'm', age: 28, w: 85, h: 178, act: 1.725, goal: 'leanbulk' });
      S.menuSet = { people: 2, budget: '', time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }; makeMenu(); await darCreate(); return SY.hid; });
    await B.page.evaluate(async hid => { Object.assign(P(), { name: 'Rayan', example: false, sex: 'm', age: 24, w: 62, h: 170, act: 1.375, goal: 'cut' }); save(); darForm.code = hid; await darJoin(); }, hid);
    await A.page.evaluate(() => syncNow()); await B.page.evaluate(() => syncNow()); await A.page.evaluate(() => syncNow());
    const list = page => page.evaluate(() => JSON.stringify(shopData().rows.map(r => [r.id, Math.round(r.buy * 1000)])));
    const tot = page => page.evaluate(() => S.menu.days.map((d, i) => menuTotal(i)));
    const [la, lb, ta, tb] = [await list(A.page), await list(B.page), await tot(A.page), await tot(B.page)];
    eq(JSON.stringify(ta), JSON.stringify(tb), 'same household portions per day');
    eq(la, lb, 'same shopping list on both phones');
    const own = await A.page.evaluate(() => S.menu.days.map(d => dayFit(d, P()).f)), other = await B.page.evaluate(() => S.menu.days.map(d => dayFit(d, P()).f));
    ta.forEach((v, i) => near(v, own[i] + other[i], 0.011, 'day ' + i + ' = Mohammed’s portion + Rayan’s portion'));
    // who pays what: same split on both phones, each pays own portions, shares add up to the menu's food cost
    const sp = page => page.evaluate(() => { const m = menuSplit(); return { m: m.map(x => [x.n, Math.round(x.c * 100) / 100]), tot: menuCostPP(S.menu) * S.menu.set.people, sources: [S.shop.menu, ...S.profiles.map(p => !!S.shop[p.id])] }; });
    const sa = await sp(A.page), sb = await sp(B.page);
    eq(JSON.stringify(sa.m), JSON.stringify(sb.m), 'same split on both phones');
    const byName = Object.fromEntries(sa.m); const exp = await A.page.evaluate(() => { const E = portionEaters(); const out = {}; Object.values(E).forEach(e => out[e.n] = 0);
      S.menu.days.forEach((d, i) => { ['ghda', '3cha'].forEach(k => { const r = d[k] && recipe(d[k]); if (r) Object.values(E).forEach(e => out[e.n] += recCost(r) * e.f[i]); }); if (d.ftour) Object.values(E).forEach(e => out[e.n] += sum(d.ftour).cost); }); return out; });
    near(byName.Mohammed, exp.Mohammed, 0.05, 'Mohammed pays his own portions'); near(byName.Rayan, exp.Rayan, 0.05, 'Rayan pays his own portions');
    ok(byName.Mohammed > byName.Rayan, 'bigger eater pays more');
    eq(JSON.stringify(sb.sources), JSON.stringify([true, false]), 'joining phone lists the home menu only');
    ok(!JSON.stringify(fsDocs[hid]).includes('"w\\":62') && !JSON.stringify(fsDocs[hid]).includes('leanbulk'), 'no body data sent, only portion sizes');
  } finally { await A.ctx.close(); await B.ctx.close(); }
});

test('Sync', 'portions per profile stay independent across two phones; an old phone’s shared d.pf is not given to the wrong person', async () => {
  const A = await phone('Mohammed', '#2f8f5b'), B = await phone('Rayan', '#2f6fbf');
  try {
    const hid = await A.page.evaluate(async () => { Object.assign(P(), { name: 'Mohammed', example: false, sex: 'm', age: 28, w: 85, h: 178, act: 1.725, goal: 'leanbulk' });
      S.menuSet = { people: 2, budget: '', time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }; makeMenu(); S.menu.days.forEach(d => { delete d.snack; delete d.snack2; delete d.side; }); save(); await darCreate(); return SY.hid; });
    await B.page.evaluate(async hid => { Object.assign(P(), { name: 'Rayan', example: false, sex: 'm', age: 24, w: 62, h: 170, act: 1.375, goal: 'cut' }); save(); darForm.code = hid; await darJoin(); }, hid);
    const sync = async () => { await A.page.evaluate(() => syncNow()); await B.page.evaluate(() => syncNow()); await A.page.evaluate(() => syncNow()); await B.page.evaluate(() => syncNow()); };
    await sync();
    const own = pg => pg.evaluate(() => dayFit(S.menu.days[0], P()).f), sugB0 = await own(B.page);
    const ida = await A.page.evaluate(() => P().id), idb = await B.page.evaluate(() => P().id);
    const a1 = await A.page.evaluate(() => { setPf(0, 1); setPf(0, 1); return dayFit(S.menu.days[0], P()).f; }); await sync();
    eq(await own(B.page), sugB0, 'Rayan’s phone: his portion did not follow Mohammed’s change');
    near(await B.page.evaluate(id => portionEaters()[id].f[0], ida), a1, 1e-9, 'Rayan’s phone sees Mohammed’s new portion');
    const b1 = await B.page.evaluate(() => { setPf(0, -1); return dayFit(S.menu.days[0], P()).f; }); await sync();
    near(await own(A.page), a1, 1e-9, 'Mohammed’s phone: his portion did not follow Rayan’s change');
    near(await A.page.evaluate(id => portionEaters()[id].f[0], idb), b1, 1e-9, 'Mohammed’s phone sees Rayan’s new portion');
    const ta = await A.page.evaluate(() => menuTotal(0)), tb = await B.page.evaluate(() => menuTotal(0));
    near(ta, a1 + b1, 0.011, 'day total = both own portions'); eq(ta, tb, 'same total on both phones');
    // an old version on B writes the shared d.pf (as before v36): A must not give it to Mohammed
    await B.page.evaluate(() => { S.menu.days[0].pf = 3; save(); }); await A.page.evaluate(() => syncNow()); await B.page.evaluate(() => syncNow()); await A.page.evaluate(() => syncNow());
    near(await own(A.page), a1, 1e-9, 'old phone’s shared value ignored for Mohammed');
    ok(await A.page.evaluate(() => !('pf' in S.menu.days[0])), 'legacy value dropped on the receiving phone');
    await A.page.reload(); await A.page.waitForTimeout(300);
    near(await own(A.page), a1, 1e-9, 'Mohammed’s portion kept after reload on a shared home');
  } finally { await A.ctx.close(); await B.ctx.close(); }
});
test('Sync', 'portions stay put over many syncs; a phone that missed them (old version) repairs itself; unknown keys are kept for later', async () => {
  const A = await phone('Mohammed', '#2f8f5b'), B = await phone('Rayan', '#2f6fbf');
  try {
    const hid = await A.page.evaluate(async () => { Object.assign(P(), { name: 'Mohammed', example: false, sex: 'm', age: 28, w: 85, h: 178, act: 1.725, goal: 'leanbulk' });
      S.menuSet = { people: 2, budget: '', time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }; makeMenu(); await darCreate(); return SY.hid; });
    const bid = await B.page.evaluate(async hid => { Object.assign(P(), { name: 'Rayan', example: false, sex: 'm', age: 24, w: 62, h: 170, act: 1.375, goal: 'cut' }); save(); darForm.code = hid; await darJoin(); return P().id; }, hid);
    for (let k = 0; k < 4; k++) { await A.page.evaluate(() => syncNow()); await B.page.evaluate(() => syncNow()); }
    const key = 'kportion_d' + bid.replace(/_/g, '_u').replace(/-/g, '_h');
    const onServer = () => { const e = fsDocs[hid].fields.e.mapValue.fields[key]; return e && e.mapValue.fields.v.stringValue; };
    const bVal = await B.page.evaluate(id => JSON.stringify(syncSnap()['portion.' + id]), bid);
    eq(onServer(), bVal, 'Rayan’s portions are still on the server after many syncs (never deleted by the other phone)');
    const st = async page => page.evaluate(() => ({ pend: syncPending(), names: menuSplit().map(x => x.n) }));
    const sa = await st(A.page), sb = await st(B.page);
    eq(sa.pend + sb.pend, 0, 'nothing left to send on either phone (no back-and-forth)');
    eq(JSON.stringify(sa.names), '["Mohammed","Rayan"]', 'first phone counts Rayan by name');
    // the real-world case: phone A was on the old version when Rayan's portions arrived — marked as received, never applied
    await A.page.evaluate(id => { delete S.portions[id]; localStorage.setItem('makla_mizan_v2', JSON.stringify(S)); const sy = JSON.parse(localStorage.getItem('makla_mizan_v2_sync')); sy.ver = 1; localStorage.setItem('makla_mizan_v2_sync', JSON.stringify(sy)); }, bid);
    await A.page.reload(); await A.page.waitForFunction(() => typeof S === 'object' && S && SY);
    const fixed = await A.page.evaluate(async () => { await syncNow(); return menuSplit().map(x => x.n); });
    eq(JSON.stringify(fixed), '["Mohammed","Rayan"]', 'after the update the phone repairs itself and counts Rayan');
    // a key from a newer version is not marked as received
    fsDocs[hid].fields.e.mapValue.fields.kfuture_dx = { mapValue: { fields: { v: { stringValue: '1' }, by: { stringValue: 'mX' }, t: { timestampValue: new Date().toISOString() } } } };
    fsDocs[hid].updateTime = new Date(Date.now() + 1e6).toISOString();
    const kept = await A.page.evaluate(async () => { await syncNow(); return 'future.x' in SY.base; });
    eq(kept, false, 'unknown key left for a later version');
    const la = await A.page.evaluate(() => JSON.stringify(shopData().rows.map(r => [r.id, Math.round(r.buy * 1000)]))), lb = await B.page.evaluate(() => JSON.stringify(shopData().rows.map(r => [r.id, Math.round(r.buy * 1000)])));
    eq(la, lb, 'same list on both phones');
  } finally { await A.ctx.close(); await B.ctx.close(); }
});

/* ---------- runner ---------- */
(async () => {
  overrides['/tests/blank.html'] = { type: 'text/html', body: '<!doctype html><title>blank</title>' };   // same-origin page used to seed localStorage
  const srv = await startServer(); BASE = `http://127.0.0.1:${srv.address().port}/`;
  browser = await chromium.launch();
  const only = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
  for (const t of tests) {
    if (only && !only.test(t.group + ' ' + t.name)) continue;
    const t0 = Date.now(); let status = 'pass', detail = '';
    let env = null;
    try {
      env = t.fn.length ? await openApp() : null;
      await Promise.race([t.fn(env || {}), new Promise((_, rej) => setTimeout(() => rej(new Fail('timeout')), 30000))]);
    } catch (e) { status = e instanceof Fail ? 'FAIL' : 'ERROR'; detail = e.message.split('\n')[0]; }
    if (env) await env.ctx.close().catch(() => {});
    results.push({ group: t.group, name: t.name, status, detail, ms: Date.now() - t0 });
    console.log(`${status === 'pass' ? '✓' : '✗'} [${t.group}] ${t.name}${detail ? '  — ' + detail : ''}`);
  }
  await browser.close(); srv.close();
  const n = s => results.filter(r => r.status === s).length;
  console.log(`\n${n('pass')} passed, ${n('FAIL')} failed, ${n('ERROR')} errors, ${results.length} total`);
  fs.writeFileSync(path.join(__dirname, 'last-results.json'), JSON.stringify(results, null, 1));
  process.exit(n('FAIL') + n('ERROR') ? 1 : 0);
})();
