# Brief for an AI reviewer — Makla Mizan

Read this first, then `index.html`. Live app: https://mohammed-benzha.github.io/Makla/ · Repo: https://github.com/Mohammed-BENZHA/Makla

## What the app is
A Moroccan meal-planning / nutrition / shopping PWA for a shared flat (two people, one shopping trip, costs split by what each eats). Prices in DH, food names in Moroccan Darija (Latin script). Five UI languages: dj (Darija Latin), da (Darija Arabic script), fr, ar, en.

## Hard constraints (please respect them in any suggestion)
- **One file, no build step, no framework, no dependencies**: everything is in `index.html` (vanilla JS + CSS), plus `sw.js` (offline cache) and `manifest.webmanifest`. Hosted on GitHub Pages.
- **Offline first**; data lives in `localStorage` key `makla_mizan_v2` (object `S`). Every load goes through `normalize()` → `sanitize()`, which repairs any bad data (old versions, imported backups, other phones).
- **Optional household sync** through the Firestore REST API (no accounts, no SDK): one document per household code, field per key, polling every 8 s. Rules in `firestore.rules`.
- Every UI string goes through `t('key')`; a new key must exist in the 5 languages (`node tools/check-i18n.js`).
- Tests: `npm install && npm test` (Playwright, 60 tests, includes a fake Firestore server). Any change should keep them green.

## Map of `index.html` (line numbers approximate)
| Lines | Content |
|---|---|
| 19–520 | CSS (light/dark tokens, layout) |
| 530–990 | `I18N` tables (5 languages) — skip unless reviewing translations |
| 991–1190 | `FOODS`: id, category, unit `u` (g or piece), macros `m` [kcal, P, C, F] per 100 g or per piece, buy unit `b`, conversion `f`, price `p` (DH per buy unit); `PACK` pack sizes |
| 1190–1360 | state helpers, meals, `sanitize()`, `normalize()` |
| 1360–1440 | storage, foods index, built-in recipes (`STEPS`, `sampleRecipes`) |
| 1440–1630 | nutrition targets (`targets`: Mifflin-St Jeor × activity, goal, protein g/kg, training-day carb shift), weight log & goal (BMI range, trend, ETA) |
| 1630–1800 | Profile / Days / Meals views |
| 1930–2090 | weekly menu generator (`makeMenu`) and menu view |
| 2086–2160 | recipes view, cooking mode |
| 2185–2350 | shopping list (`shopData`), household portions, cost split (`menuSplit`), prices view |
| 2440–2510 | backup export/import, program import (`progParse`/`progApply`) |
| 2610–2789 | household sync (`syncSnap`, `syncPull`, `syncNow`) |

## What I want from you
1. **Bugs** (wrong numbers, data loss, crashes, sync conflicts) — highest priority.
2. **Nutrition science**: are the formulas, macro values (`FOODS`) and targets correct and up to date? Cite sources.
3. **UX** for a non-technical user on a phone (Darija speaker).
4. **Security / privacy** (Firestore rules, injection, backups).
5. Feature ideas — last, and only if they fit the constraints.

## Output format
For each point: **severity** (critical / major / minor / idea) · **where** (function name + approx. line) · **what happens** (concrete scenario: input → wrong result) · **suggested fix** (small diff or precise description). Do not rewrite the whole app or switch frameworks. Say clearly when something is a guess rather than verified.
