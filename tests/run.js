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
    S.menu = { set: { people: 4, budget: '', time: 60, excl: [], meals: { ftour: false, ghda: true, '3cha': false } }, days: [{ ghda: 'r_3des', pf: 1.5 }, {}, {}, {}, {}, {}, {}], at: 1 };
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
    S.menu.days[0].pf = 1.5; save(); openDay = 0; go('menu');
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
