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
test('Shopping', 'weekly menu: your own portion (±) is what goes on the list', async ({ page }) => {
  const r = await page.evaluate(() => {
    S.oil = 1; S.pantry = {}; const rc = recipe('r_3des'); const lent = rc.items.find(x => x[0] === '3des_n')[1];
    S.menu = { set: { people: 1, budget: '', time: 60, excl: [], meals: { ftour: false, ghda: true, '3cha': false } }, days: [{ ghda: 'r_3des', pfBy: { [P().id]: 1.5 } }, {}, {}, {}, {}, {}, {}], at: 1 };
    S.shop = { menu: true, [P().id]: false }; save();
    const row = shopData().rows.find(x => x.id === '3des_n'); return { got: row.week, exp: 1.5 * lent / rc.servings * 0.001, tot: menuTotal(0) };
  });
  near(r.got, r.exp, 1e-9, 'kg lentils = 1.5 portions'); near(r.tot, 1.5, 1e-9, 'day portions = your portion');
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
test('Profiles', 'one person: data with several profiles keeps the open one, archives the others (plus a full copy) and removes their list and menu entries', async () => {
  const { ctx, page, errors } = await openApp();
  try {
    await page.evaluate(() => { const base = JSON.parse(JSON.stringify(P())), mk = o => Object.assign(JSON.parse(JSON.stringify(base)), o);
      S.profiles = [mk({ id: 'pM', name: 'Mohammed', example: false }), mk({ id: 'pR', name: 'Rayan', example: false })]; S.active = 'pM'; S.shop = { menu: true, pM: true, pR: true };
      S.menu = { set: { people: 3, budget: '', time: 60, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }, at: 1,
        days: [{ ghda: 'r_3des', pfBy: { pM: 1.5, pR: 0.75 }, xtra: { pM: { snack: [['bid', 2]] }, pR: { snack: [['ton_ma', 1]] } } }, { ghda: 'r_3des', pfBy: { pR: 2 }, xtra: { pR: { side: [['khobz', 0.5]] } } }, {}, {}, {}, {}, {}] };
      S.menuSet = JSON.parse(JSON.stringify(S.menu.set)); save(); });
    const read = () => page.evaluate(() => ({ s: JSON.parse(localStorage.getItem('makla_mizan_v2')), multi: localStorage.getItem('makla_mizan_v2_multi'),
      sel: !!document.getElementById('profSel'), fns: [typeof newProfile, typeof delProfile, typeof setActive], tuna: (shopData().rows.find(x => x.id === 'ton_ma') || {}).week }));
    await page.reload(); await page.waitForTimeout(300); const r = await read(), s = r.s;
    eq(s.profiles.map(p => p.id).join(), 'pM', 'only the open profile is kept'); eq(s.active, 'pM', 'active profile');
    eq(s.oldProfiles.map(p => p.id + ':' + p.name).join(), 'pR:Rayan', 'the other one is archived, not lost'); ok(/^\d{4}-\d\d-\d\d$/.test(s.oldProfiles[0].archived), 'archive date');
    ok(r.multi && JSON.parse(r.multi).profiles.length === 2, 'full copy of the old data kept aside');
    eq(JSON.stringify(s.shop), JSON.stringify({ menu: true, pM: true }), 'archived profile off the shopping list');
    eq(JSON.stringify(s.menu.days[0].pfBy), JSON.stringify({ pM: 1.5 }), 'own portion kept, the other removed');
    eq(JSON.stringify(s.menu.days[0].xtra), JSON.stringify({ pM: { snack: [['bid', 2]] } }), 'own top-ups kept, the other removed');
    ok(!('pfBy' in s.menu.days[1]) && !('xtra' in s.menu.days[1]), 'emptied entries removed'); ok(!r.tuna, 'the archived person’s tuna is not bought');
    eq(s.menu.set.people, 1, 'menu for one'); eq(s.menuSet.people, 1, 'menu settings for one');
    ok(!r.sel, 'no profile switch in the header'); eq(r.fns.join(), 'undefined,undefined,undefined', 'no add/delete/switch profile');
    await page.reload(); await page.waitForTimeout(300); const r2 = await read();
    for (const k of ['profiles', 'oldProfiles', 'shop', 'menu']) eq(JSON.stringify(r2.s[k]), JSON.stringify(s[k]), 'second load changes nothing: ' + k);
    eq(r2.multi, r.multi, 'the copy is not overwritten'); eq(errors.length, 0, 'page errors');
  } finally { await ctx.close(); }
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
    S.menu = { set: { people: 1, budget: '', time: 60, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }, days: [0, 1, 2, 3, 4, 5, 6].map(() => ({ ftour: [['bid', 2]], ghda: 'r_mine1', '3cha': 'r_3des' })), at: 1 };
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
  A.onboarded = true;
  // v39: one person — the open profile stays, the other is archived (dated), its shopping flag goes, the menu is for one
  ok(Array.isArray(B.oldProfiles) && B.oldProfiles.length === 1 && /^\d{4}-\d\d-\d\d$/.test(B.oldProfiles[0].archived), 'other profile archived');
  const keep = A.profiles.find(p => p.id === A.active); A.oldProfiles = A.profiles.filter(p => p !== keep).map(p => Object.assign({}, p, { archived: B.oldProfiles[0].archived }));
  A.profiles = [keep]; A.oldProfiles.forEach(p => delete A.shop[p.id]); A.menu.set.people = 1; A.menuSet.people = 1;
  // v40: the 29 training recipes are added after the user's own list, nothing else in it changes
  const added = B.recipes.slice(A.recipes.length);
  ok(added.length === 29 && added.every(x => x.cat === 'gym' && x.key.startsWith('g_')), 'training recipes added (' + added.length + ')');
  A.recipes = A.recipes.concat(added); A.recipeSeed = 4;   // existing users are marked as onboarded so they never see the first-run questions
  // v36: the one shared extra portion (d.pf) becomes the open profile's own portion (d.pfBy), same value
  const legacy = A.menu.days.filter(d => d.pf != null); ok(legacy.length > 0, 'fixture has a legacy portion');
  A.menu.days.forEach(d => { if (d.pf != null) { d.pfBy = { [A.active]: d.pf }; delete d.pf; } });
  // v38: top-ups (snack/snack2/side + snackFor/sideFor) move to their person in d.xtra; empty lists disappear
  A.menu.days.forEach(d => { const x = {}; [['snack', 'snackFor'], ['snack2', 'snackFor'], ['side', 'sideFor']].forEach(([k, w]) => { if (Array.isArray(d[k]) && d[k].length) { const id = d[w] || A.active; (x[id] = x[id] || {})[k] = d[k]; } delete d[k]; });
    delete d.snackFor; delete d.sideFor; if (Object.keys(x).length) d.xtra = x; });
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
test('Interface', 'first run: 3 questions produce a profile, a weekly menu and a list', async () => {
  const { page, ctx, errors } = await openApp({ keepOnboarding: true });
  const r = await page.evaluate(() => { const shown = !!document.querySelector('#obRoot .ob');
    obGo(1); obToggle('fish'); ob.time = 30; obGo(1); ob.budget = '500'; obGo(1);
    ob.macros = true; ob.name = 'Sara'; ob.sex = 'f'; ob.age = '31'; ob.w = '64'; ob.h = '166'; ob.goal = 'cut'; obFinish();
    const p = P(); return { shown, closed: !document.querySelector('#obRoot .ob'), onboarded: S.onboarded, people: S.menu.set.people, excl: S.menu.set.excl, time: S.menu.set.time,
      days: S.menu.days.length, name: p.name, age: p.age, example: p.example, rows: shopData().rows.length, budget: S.budget, noFish: S.menu.days.every(d => [d.ghda, d['3cha']].filter(Boolean).every(id => protOf(recipe(id)) !== 'fish')) }; });
  await ctx.close();
  ok(r.shown, 'questions shown on first run'); ok(r.closed, 'closed at the end'); eq(r.onboarded, true, 'remembered');
  eq(r.people, 1, 'menu for one person'); ok(r.excl.includes('fish') && r.noFish, 'no fish in the menu'); eq(r.time, 30, 'time limit');
  eq(r.days, 7, 'menu days'); eq(r.name, 'Sara', 'profile name'); eq(r.age, 31, 'age'); eq(r.example, false, 'real profile'); ok(r.rows > 5, 'shopping list filled');
  eq(r.budget, String(Math.round(500 * 30 / 7)), 'monthly budget from the weekly answer'); eq(errors.length, 0, 'page errors');
});
test('Interface', 'first run without macros: no calorie analysis, menu and list still work', async () => {
  const { page, ctx, errors } = await openApp({ keepOnboarding: true });
  const r = await page.evaluate(() => { obGo(1); obGo(1); obGo(1); ob.macros = false; obFinish(); go('menu'); const v = document.getElementById('view');
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
test('Cooking', 'from the menu: your own portion; phone back button closes cooking mode', async ({ page }) => {
  const r = await page.evaluate(async () => { const wait = ms => new Promise(res => setTimeout(res, ms));
    S.menuSet = { people: 1, budget: '', time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }; makeMenu();
    S.menu.days[0].pfBy = { [P().id]: 1.5 }; save(); openDay = 0; go('menu');
    const btn = [...document.querySelectorAll('#view .mday.open .mcard .mbtns .btn')].find(b => b.textContent.includes('👨‍🍳'));
    btn.click(); const n = cook && cook.n, rid = cook && cook.rid;
    history.back(); await wait(150);
    return { n, rid, ghda: S.menu.days[0].ghda, closedByBack: !cook && !document.querySelector('#cookRoot .cook') }; });
  eq(r.rid, r.ghda, 'lunch recipe opened'); near(r.n, 1.5, 1e-9, 'portions = your 1.5'); ok(r.closedByBack, 'back button closes it');
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

/* the app is for one person: Mohammed, with calorie targets */
const ONE = () => { const base = JSON.parse(JSON.stringify(S.profiles[0]));
  S.profiles = [Object.assign(base, { id: 'pM', name: 'Mohammed', example: false, sex: 'm', age: 27, w: 80, h: 180, act: 1.55, goal: 'leanbulk', train: false })]; S.active = 'pM';
  S.shop = { menu: true, pM: false }; S.pantry = {}; S.oil = 1;
  S.menu = { set: { people: 1, budget: '', time: 60, excl: [], meals: { ftour: false, ghda: true, '3cha': false } }, days: [{ ghda: 'r_3des' }, {}, {}, {}, {}, {}, {}], at: 1 }; save(); };
test('Menu', 'your ± portion: quarter steps, back to the suggestion, kept after reload; the day total and the list follow it', async ({ page }) => {
  const r = await page.evaluate(ONE => { eval('(' + ONE + ')')(); const f = () => dayFit(S.menu.days[0], P()).f;
    const sug = f(); setPf(0, 1); setPf(0, 1); const up = f(); setPf(0, -1); const down = f(), stored = S.menu.days[0].pfBy.pM;
    setPf(0, 0); const back = f(), gone = !('pfBy' in S.menu.days[0]); setPf(0, 1); setPf(0, 1); const last = f();
    return { sug, up, down, stored, back, gone, last, legacy: 'pf' in S.menu.days[0] }; }, ONE.toString());
  const up = Math.min(3, r.sug + 0.5);
  near(r.up, up, 1e-9, '+2 steps'); near(r.down, Math.max(.5, up - 0.25), 1e-9, '−1 step'); near(r.stored, r.down, 1e-9, 'stored as your portion');
  near(r.back, r.sug, 1e-9, 'back to the suggestion'); ok(r.gone, 'nothing stored once back on the suggestion'); ok(!r.legacy, 'no old shared value written');
  await page.reload(); await page.waitForTimeout(300);
  const q = await page.evaluate(() => { const rc = recipe('r_3des'), lent = rc.items.find(x => x[0] === '3des_n')[1];
    return { f: dayFit(S.menu.days[0], P()).f, tot: menuTotal(0), kg: shopData().rows.find(x => x.id === '3des_n').week, lentKg: lent / rc.servings * 0.001 }; });
  near(q.f, r.last, 1e-9, 'kept after reload'); near(q.tot, q.f, 0.011, 'day total = your portion'); near(q.kg, q.f * q.lentKg, 1e-6, 'lentils on the list = your portion');
});
test('Menu', 'B1: the Menu tab, the list (week) and the generator show the same menu cost: your portions, breakfasts, top-ups; the second box is the day average; budget warning uses it', async ({ page }) => {
  const r = await page.evaluate(ONE => { eval('(' + ONE + ')')();
    S.menuSet = { people: 1, budget: '', time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }; makeMenu();
    const d = S.menu.days[0]; d.xtra = { pM: { snack: [['bid', 2]], side: [['khobz', 0.5]] } }; d.pfBy = { pM: 2.5 }; save();
    const num = s => parseFloat(String(s).replace(/[^\d.]/g, ''));
    // expected by hand: each day lunch + dinner × your portion, breakfast once, top-ups once
    let exp = 0; S.menu.days.forEach((x, i) => { const por = portionEaters().pM.f[i];
      ['ghda', '3cha'].forEach(k => { const rc = x[k] && recipe(x[k]); if (rc) exp += recCost(rc) * por; });
      if (x.ftour) exp += sum(x.ftour).cost; Object.values(x.xtra || {}).forEach(o => [].concat(o.snack || [], o.snack2 || [], o.side || []).forEach(it => exp += sum([it]).cost)); });
    const old1 = S.menu.days.reduce((c, x) => c + ['ghda', '3cha'].reduce((s, k) => s + (x[k] && recipe(x[k]) ? recCost(recipe(x[k])) : 0), 0) + (x.ftour ? sum(x.ftour).cost : 0), 0);
    openDay = null; go('menu'); const boxes = document.querySelectorAll('#view .mstat > div'), menuTxt = boxes[0].querySelector('b').textContent, dayTxt = boxes[1].textContent;
    go('t9edya'); const weekTxt = document.querySelectorAll('#view .tot b')[1].textContent;
    // a budget between the one-portion estimate and the real cost must be reported as exceeded
    S.menu.set.budget = Math.round((old1 + menuWeekCost()) / 2); save(); go('menu');
    const warn = !!document.querySelector('#view .mstat ~ .warn'), note = !!document.querySelector('#view .mstat ~ .note');
    return { exp, fn: menuWeekCost(), list: shopData().cost, gen: menuCostEst(S.menu.set, S.menu.days), menuTab: num(menuTxt), listTab: num(weekTxt), day: num(dayTxt), dayLbl: dayTxt.includes(t('day_avg')), old1, warn, note }; }, ONE.toString());
  near(r.fn, r.exp, 0.01, 'menu cost = hand calculation'); near(r.list, r.fn, 1e-6, 'list week cost (menu only) = menu cost'); near(r.gen, r.fn, 1e-6, 'generator = menu cost');
  near(r.menuTab, Math.round(r.fn), 0.5, 'Menu tab shows it'); near(r.listTab, Math.round(r.fn), 0.5, 'list tab shows it');
  near(r.day, r.fn / 7, 0.51, 'second box = cost per day'); ok(r.dayLbl, 'labelled as a day average');
  ok(r.fn > r.old1 * 1.05, 'your real portions cost more than one portion (the case B1 fixes)'); ok(r.warn && !r.note, 'over-budget warning shown');
});
test('Menu', 'B2: a lower budget never gives a dearer menu; a reachable budget is met; below the realistic floor the menu stays varied, generation stays fast and the floor is shown', async ({ page }) => {
  const r = await page.evaluate(ONE => { eval('(' + ONE + ')')();
    const seed = s => { let x = s; Math.random = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; };
    const base = { people: 1, time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true } };
    const F = menuMinCost(Object.assign({ budget: '' }, base));
    const run = (bud, s) => { seed(s); S.menuSet = Object.assign({ budget: bud }, JSON.parse(JSON.stringify(base))); const t0 = performance.now(); makeMenu();
      const ids = S.menu.days.flatMap(d => [d.ghda, d['3cha']]); return { c: menuWeekCost(), ms: performance.now() - t0, rep: ids.length - new Set(ids).size, days: JSON.stringify(S.menu.days) }; };
    const levels = ['', Math.round(F * 1.5), Math.round(F * 1.2), Math.round(F * 0.6), Math.round(F * 0.3)], N = 6, avg = {}, per = {};
    levels.forEach(b => { per[b] = []; for (let k = 0; k < N; k++) per[b].push(run(b, 500 + k)); avg[b] = per[b].reduce((s, x) => s + x.c, 0) / N; });
    const sameBelow = per[levels[3]].every((x, k) => x.days === per[levels[4]][k].days);
    const msMax = Math.max(...levels.flatMap(b => per[b].map(x => x.ms))), repLow = per[levels[4]].reduce((s, x) => s + x.rep, 0) / N;
    const msg = b => { S.menuSet.budget = b; makeMenu(); go('menu'); const w = document.querySelector('#view .mstat ~ .warn'); return w ? w.textContent : ''; };
    const lowTxt = msg(levels[4]), okTxt = msg(Math.round(F * 3));
    return { F, levels, avg: levels.map(b => Math.round(avg[b])), sameBelow, msMax, repLow, lowTxt, okTxt, lowKey: t('budget_low', { x: '' }).slice(0, 25) }; }, ONE.toString());
  const [u, b15, b12, b06, b03] = r.avg;
  ok(b15 <= u * 1.01 && b12 <= b15 * 1.01 && b06 <= b12 * 1.01 && b03 <= b06 * 1.01, 'cost never rises as the budget falls: ' + r.avg.join(' ≥ '));
  ok(b12 <= r.levels[2] * 1.05, 'a budget 20 % above the floor is met (' + b12 + ' for ' + r.levels[2] + ')');
  ok(b06 < u, 'a low budget makes the menu cheaper than no budget');
  ok(r.sameBelow, 'below the floor every budget gives the same menu (no extra squeezing)');
  ok(r.repLow <= 1, 'still varied below the floor (repeats/week: ' + r.repLow + ')'); ok(r.msMax < 1500, 'generation stays fast (' + Math.round(r.msMax) + ' ms)');
  ok(r.lowTxt.includes(r.lowKey) && r.lowTxt.includes(String(Math.ceil(r.F / 10) * 10)), 'too-low budget: message with the floor (' + Math.ceil(r.F / 10) * 10 + ' DH)');
  ok(!r.okTxt.includes(r.lowKey), 'no floor message when the budget is reachable');
});
test('Menu', 'A1: when you train and the meals fall short (here without the training recipes), protein snacks are added; a day still short is flagged', async ({ page }) => {
  const r = await page.evaluate(ONE => { eval('(' + ONE + ')')(); const seed = s => { let x = s; Math.random = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; };
    Object.assign(P(), { w: 95, act: 1.2, train: true, tdays: [0, 2, 4] }); S.recipes = S.recipes.filter(r => r.cat !== 'gym'); seed(7); S.menuSet = { people: 1, budget: '', time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true }, hp: true }; makeMenu();
    return S.menu.days.map((d, i) => { const x = dayFit(d, P(), undefined, i), own = dayFit(d, P(), xItems(d, 'pM'), i);
      return { snack: xItems(d, 'pM').length, gap: x.tg.prot - x.sc.p, lab: fitLabel(x)[1], same: Math.abs(own.sc.p - x.sc.p) < 1e-9, keys: Object.keys(d.xtra || {}).join(), legacy: 'snack' in d || 'snackFor' in d }; }); }, ONE.toString());
  ok(r.some(x => x.snack), 'some days get protein snacks');
  r.forEach((x, i) => { ok(x.snack || x.gap <= 8, 'day ' + i + ': a snack, or none needed'); ok(x.gap <= 8 || x.lab === 'st_prot', 'day ' + i + ': fine or flagged');
    ok(x.same && !x.legacy && (!x.keys || x.keys === 'pM'), 'day ' + i + ': top-ups stored as yours only'); });
});
test('Menu', 'A1: top-ups saved before v38 (snack/side + snackFor) go to their person first; an archived person’s top-ups then leave the list', async () => {
  const { ctx, page } = await openApp();
  try {
    await page.evaluate(() => { const base = JSON.parse(JSON.stringify(P())), mk = o => Object.assign(JSON.parse(JSON.stringify(base)), o);
      S.profiles = [mk({ id: 'pM', name: 'Mohammed', example: false }), mk({ id: 'pR', name: 'Rayan', example: false })]; S.active = 'pM'; S.shop = { menu: true, pM: false, pR: false };
      S.menu = { set: { people: 2, budget: '', time: 60, excl: [], meals: { ftour: false, ghda: true, '3cha': false } }, at: 1,
        days: [{ ghda: 'r_3des', snack: [['ton_ma', 1]], snack2: [['perly', 1]], snackFor: 'pR', side: [['khobz', 0.5]] }, { ghda: 'r_3des', snack: [['bid', 2]] }, {}, {}, {}, {}, {}] }; save(); });
    await page.reload(); await page.waitForTimeout(300);
    const r = await page.evaluate(() => { const row = id => (shopData().rows.find(x => x.id === id) || {}).week;
      return { d: JSON.parse(localStorage.getItem('makla_mizan_v2')).menu.days, tuna: row('ton_ma'), bread: row('khobz'), eggs: row('bid') }; });
    eq(JSON.stringify(r.d[0].xtra), JSON.stringify({ pM: { side: [['khobz', 0.5]] } }), 'Rayan’s snacks archived with him; the unnamed side is yours');
    eq(JSON.stringify(r.d[1].xtra), JSON.stringify({ pM: { snack: [['bid', 2]] } }), 'unnamed snack is yours');
    ok(!('snack' in r.d[0]) && !('snackFor' in r.d[0]) && !('side' in r.d[0]), 'old fields removed');
    ok(!r.tuna, 'Rayan’s tuna not bought'); near(r.bread, 0.5, 1e-9, 'your bread on the list'); near(r.eggs, 2, 1e-9, 'your eggs on the list');
  } finally { await ctx.close(); }
});

test('Menu', 'B2: the generator costs a week exactly like the Menu tab and the list — suggested portions, your ± portions, top-ups', async ({ page }) => {
  const r = await page.evaluate(ONE => { eval('(' + ONE + ')')();
    S.menuSet = { people: 1, budget: '', time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }; makeMenu();
    const set = S.menu.set, out = {}, cmp = tag => { out[tag] = { gen: menuCostEst(set, S.menu.days), tab: menuWeekCost(), list: shopData().cost, por: S.menu.days.map((d, i) => [portionEst(set).por(d, i), menuTotal(i)]) }; };
    cmp('suggested');
    const d = S.menu.days[0]; d.pfBy = { pM: dayFit(d, P(), undefined, 0).sug === 2.5 ? 1.5 : 2.5 }; d.xtra = { pM: { snack: [['ton_ma', 1]], side: [['khobz', 0.5]] } }; save(); cmp('chosen');
    S.menu.days[2].pfBy = { pM: 0.75 }; save(); cmp('two days');
    S.menuSet.budget = 200; makeMenu(); cmp('generated');
    return out; }, ONE.toString());
  for (const [k, v] of Object.entries(r)) {
    near(v.gen, v.tab, 1e-6, k + ': generator = Menu tab'); near(v.gen, v.list, 1e-6, k + ': generator = list');
    v.por.forEach(([a, b], i) => near(a, b, 1e-9, k + ': day ' + i + ' portions'));
  }
  ok(r.chosen.por[0][0] !== r.suggested.por[0][0], 'your ± changes the costed portions');
});
/* the two households where the final cost passed the budget after the automatic snacks (seeds 6 and 18 of the review: 500 → 664 and 500 → 656 DH) */
/* one person who trains, with a tight budget: the automatic snacks must be counted by the generator (review seeds 6 and 18) */
const SNK_HOUSE = s => { const base = JSON.parse(JSON.stringify(S.profiles[0]));
  S.profiles = [Object.assign(base, { id: 'pM', name: 'Mohammed', example: false, w: 70 + s % 25, h: 175, act: 1.2, goal: 'leanbulk', train: true, tdays: [0, 2, 4] })];
  S.active = 'pM'; S.shop = { menu: true, pM: false }; S.pantry = {};
  S.recipes = S.recipes.filter(r => r.cat !== 'gym'); };   // the usual Moroccan dishes only, so the snacks have work to do
test('Menu', 'B2 snacks: for one person who trains on a tight budget, the generator counts the snacks — its cost = Menu tab = list, snacks kept, and the overrun is stated with the snack share', async ({ page }) => {
  const r = await page.evaluate(SNK => { eval('(' + SNK + ')');
    const seed = s => { let x = s; Math.random = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; };
    return [6, 18].map(s => { seed(s); eval('(' + SNK + ')')(s); const BUD = Math.round(menuMinCost({ people: 1, budget: '', time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }) * 0.8); seed(s);
      S.menuSet = { people: 1, budget: BUD, time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }; makeMenu();
      const set = S.menu.set, E = portionEst(set), strip = S.menu.days.map(d => { const c = Object.assign({}, d); delete c.xtra; return c; });
      const gen = strip.reduce((a, d, i) => a + E.costAuto(d, i), 0), tab = menuWeekCost(), list = shopData().cost, snacks = menuSnackCost(), floor = menuMinCost(set);
      // snacks were not dropped: every training/high-protein eater short by > 8 g on a day has their snacks
      const missing = S.menu.days.filter((d, i) => nutEaters().some(e => { const x = dayFit(strip[i], e, [], i); return x.hasMain && x.tg.prot - x.sc.p > 8 && !xItems(d, e.id).length; })).length;
      openDayInit = true; openDay = null; go('menu'); const w = document.querySelector('#view .mstat ~ .warn');
      return { s, bud: BUD, gen, tab, list, snacks, floor, missing, warn: w ? w.textContent : '', over: t('over_budget', { x: (tab - BUD).toFixed(0) + ' ' + t('dh') }),
        snk: tab - snacks <= BUD ? t('budget_snacks_only', { m: (tab - snacks).toFixed(0) + ' ' + t('dh'), s: snacks.toFixed(0) + ' ' + t('dh') }) : t('budget_snacks', { s: snacks.toFixed(0) + ' ' + t('dh') }), low: t('budget_low', { x: Math.ceil(floor / 10) * 10 + ' ' + t('dh') }) }; }); }, SNK_HOUSE.toString());
  r.forEach(x => {
    near(x.gen, x.tab, 1e-6, 'seed ' + x.s + ': generator cost = Menu tab (' + Math.round(x.tab) + ' DH)'); near(x.list, x.tab, 1e-6, 'seed ' + x.s + ': = list');
    ok(x.snacks > 0 && x.missing === 0, 'seed ' + x.s + ': snacks kept on every day that needs them');
    if (x.tab > x.bud) { ok(x.warn.includes(x.over), 'seed ' + x.s + ': exact overrun shown'); ok(x.warn.includes(x.snk), 'seed ' + x.s + ': snack share shown (' + Math.round(x.snacks) + ' DH)');
      ok(x.floor > x.bud && x.warn.includes(x.low), 'seed ' + x.s + ': budget below the menu+snacks floor (' + Math.round(x.floor) + ' DH) is said'); }
    else ok(!x.warn, 'seed ' + x.s + ': within budget, no warning');
  });
});
test('Menu', 'B2 snacks: a reachable budget is met with the snacks included; when the meals fit but the snacks do not, the warning says exactly that', async ({ page }) => {
  const r = await page.evaluate(SNK => { const seed = s => { let x = s; Math.random = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; };
    eval('(' + SNK + ')')(6); const base = { people: 1, time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true } };
    const F = menuMinCost(Object.assign({ budget: '' }, base)), B = Math.round(F * 1.2);
    seed(6); S.menuSet = Object.assign({ budget: B }, JSON.parse(JSON.stringify(base))); makeMenu(); const met = menuWeekCost();
    // same menu, budget between the meals alone and meals + snacks
    const tot = menuWeekCost(), s = menuSnackCost(), mid = Math.round(tot - s / 2); S.menu.set.budget = mid; save(); openDayInit = true; openDay = null; go('menu');
    const w = document.querySelector('#view .mstat ~ .warn');
    return { B, met, snacks: s, warn: w ? w.textContent : '', exp: t('budget_snacks_only', { m: (tot - s).toFixed(0) + ' ' + t('dh'), s: s.toFixed(0) + ' ' + t('dh') }), over: t('over_budget', { x: (tot - mid).toFixed(0) + ' ' + t('dh') }), kept: menuSnackCost() === s }; }, SNK_HOUSE.toString());
  ok(r.met <= r.B * 1.02, 'budget 20 % above the menu+snacks floor is met (' + Math.round(r.met) + ' for ' + r.B + ')');
  ok(r.snacks > 0, 'the menu has snacks'); ok(r.warn.includes(r.over) && r.warn.includes(r.exp), 'meals fit, snacks do not: said with both amounts'); ok(r.kept, 'snacks not removed');
});
test('Menu', 'without calorie counting you eat one portion: list, cost and generator agree; the second box is the day average', async ({ page }) => {
  const r = await page.evaluate(() => { const base = JSON.parse(JSON.stringify(S.profiles[0]));
    S.profiles = [Object.assign(base, { id: 'pN', name: 'Sara', example: false, noTargets: true })]; S.active = 'pN'; S.shop = { menu: true, pN: false };
    S.menuSet = { people: 1, budget: '', time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }; makeMenu();
    openDayInit = true; openDay = null; go('menu'); const box = document.querySelectorAll('#view .mstat > div')[1].textContent;
    return { por: S.menu.days.map((d, i) => menuTotal(i)), week: menuWeekCost(), list: shopData().cost, gen: menuCostEst(S.menu.set, S.menu.days), box, lbl: t('day_avg') }; });
  ok(r.por.every(v => v === 1), 'one portion a day (' + r.por.join(',') + ')');
  near(r.list, r.week, 1e-6, 'list = Menu'); near(r.gen, r.week, 1e-6, 'generator = Menu');
  ok(r.box.includes(r.lbl) && r.box.includes(String(Math.round(r.week / 7))), 'day average shown: ' + r.box);
});
test('Menu', 'a menu saved before v36 (one shared d.pf) loads as your own portion; bad values cleaned', async () => {
  const { ctx, page } = await openApp();
  try {
    await page.evaluate(ONE => { eval('(' + ONE + ')')(); S.menu.days[0].pf = 1.75; S.menu.days[1] = { ghda: 'r_3des', pf: 9, pfBy: { 'bad id!': 2, pM: 7 } }; save(); }, ONE.toString());
    await page.reload(); await page.waitForTimeout(300);
    const r = await page.evaluate(() => { const saved = JSON.parse(localStorage.getItem('makla_mizan_v2')).menu.days; return { f: dayFit(S.menu.days[0], P()).f, d0: saved[0], d1: saved[1] }; });
    near(r.f, 1.75, 1e-9, 'old portion kept as yours');
    ok(!('pf' in r.d0) && r.d0.pfBy && r.d0.pfBy.pM === 1.75, 'migrated and saved as pfBy'); ok(!('pf' in r.d1) && !r.d1.pfBy, 'out-of-range and bad entries dropped');
  } finally { await ctx.close(); }
});

/* v40: training recipes (cat 'gym') — lean, high-protein plates adapted to Moroccan shops */
test('Menu', 'training recipes: 29, each ≥ 25 g protein a portion, only foods from the app; offered only to someone who trains or asks for high protein', async ({ page }) => {
  const r = await page.evaluate(ONE => { eval('(' + ONE + ')')(); const seed = s => { let x = s; Math.random = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; };
    const G = S.recipes.filter(x => x.cat === 'gym'), info = G.map(x => { const m = sum([[x.id, 1]]); return { k: x.key, p: m.p, slots: recMeta(x).slots, foods: x.items.every(([id]) => !!food(id)), name: ['dj', 'da', 'fr', 'ar', 'en'].every(l => I18N[l].rec_names[x.key]) }; });
    const ids = new Set(G.map(x => x.id)), gymIn = m => m.days.flatMap(d => [d.ghda, d['3cha']].concat((d.ftour || []).map(x => x[0]))).filter(id => ids.has(id)).length;
    const run = (hp, train) => { Object.assign(P(), { train, tdays: train ? [0, 2, 4] : [] }); const set = { people: 1, budget: '', time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true }, hp };
      const pl = menuPools(set), inPools = new Set([pl.L, pl.D, pl.B].flat().filter(x => x.cat === 'gym')).size; let used = 0;
      for (let k = 1; k <= 3; k++) { seed(k); S.menuSet = JSON.parse(JSON.stringify(set)); makeMenu(); used += gymIn(S.menu); }
      openDayInit = true; openDay = 0; swapAt = '0:ghda'; swapMode = null; const sw = swapOptions(0, 'ghda').filter(x => x.cat === 'gym').length, fo = (swapMode = 'protein', ftourOptions(0)).filter(o => o.items.some(([id]) => ids.has(id))).length;
      swapMode = null; return { inPools, used, sw, fo }; };
    return { n: G.length, info, normal: run(false, false), hp: run(true, false), train: run(false, true) }; }, ONE.toString());
  eq(r.n, 29, 'training recipes');
  r.info.forEach(x => { ok(x.p >= 25, x.k + ': ' + Math.round(x.p) + ' g protein a portion'); ok(x.foods, x.k + ': only foods the app knows'); ok(x.name, x.k + ': named in the 5 languages'); });
  ok(r.info.filter(x => x.slots === 'B').length >= 6, 'at least 6 breakfasts');
  eq(JSON.stringify(r.normal), JSON.stringify({ inPools: 0, used: 0, sw: 0, fo: 0 }), 'someone who does not train: never offered (menu, swaps, breakfasts)');
  ok(r.hp.inPools === 29 && r.hp.used > 0, 'high-protein menu: offered and used (' + r.hp.used + ' meals in 3 weeks)');
  ok(r.train.inPools === 29 && r.train.used > 0 && r.train.fo > 0, 'training days: offered and used (' + r.train.used + ' meals in 3 weeks), also among the higher-protein breakfasts');
});
test('Menu', 'training recipes cover protein from meals: a trainee needs fewer protein snacks with them than without', async ({ page }) => {
  const r = await page.evaluate(ONE => { eval('(' + ONE + ')')(); const seed = s => { let x = s; Math.random = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; }; };
    Object.assign(P(), { w: 95, act: 1.2, train: true, tdays: [0, 2, 4] }); const all = S.recipes.slice();
    const snacks = () => { let n = 0; for (let k = 1; k <= 4; k++) { seed(k); S.menuSet = { people: 1, budget: '', time: 999, excl: [], meals: { ftour: true, ghda: true, '3cha': true } }; makeMenu(); n += S.menu.days.filter(d => xItems(d, 'pM').length).length; } return n; };
    const withG = snacks(); S.recipes = all.filter(x => x.cat !== 'gym'); const without = snacks(); return { withG, without }; }, ONE.toString());
  ok(r.withG < r.without, 'days with protein snacks over 4 weeks: ' + r.withG + ' with the training recipes, ' + r.without + ' without');
});
test('Backup', 'update from recipe set v3: only the training recipes are added — a built-in the user deleted or edited stays as it is', async () => {
  const { ctx, page, errors } = await openApp();
  try {
    await page.evaluate(() => { S.recipes = S.recipes.filter(r => r.cat !== 'gym' && r.id !== 'r_harira'); const c = S.recipes.find(r => r.id === 'r_couscous'); c.items = [['couscous_n', 500]]; c.servings = 2; S.recipeSeed = 3; save(); });
    await page.reload(); await page.waitForTimeout(300);
    const r = await page.evaluate(() => { const s = S; const c = s.recipes.find(x => x.id === 'r_couscous');
      return { gym: s.recipes.filter(x => x.cat === 'gym').length, harira: s.recipes.some(x => x.id === 'r_harira'), couscous: JSON.stringify([c.items, c.servings]), seed: s.recipeSeed }; });
    eq(r.gym, 29, 'training recipes added'); ok(!r.harira, 'deleted harira not brought back'); eq(r.couscous, JSON.stringify([[['couscous_n', 500]], 2]), 'edited couscous kept'); eq(r.seed, 4, 'recipe set version');
    eq(errors.length, 0, 'page errors');
  } finally { await ctx.close(); }
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
