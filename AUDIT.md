# Technical audit — October 2026

Scope: reliability, calculation accuracy, data integrity and offline stability of the existing app
(`index.html`, `sw.js`, `manifest.webmanifest`, icons, `tools/`). No redesign, no new product features.
Method: read every source file, write an automated test for each suspected problem, run it against the unmodified
app to confirm or reject it, then fix only what was confirmed and re-run everything.

## 1. Confirmed bugs (each reproduced by a failing test before the fix)

| # | Severity | Area | Bug | How it showed |
|---|---|---|---|---|
| 1 | High | Storage | Saved data that could not be parsed was silently replaced by the sample profile; the next save overwrote the user's real data for good. | truncated JSON in localStorage → original text gone after one tap |
| 2 | High | Storage | `save()` swallowed every exception: when storage was full or blocked the app looked fine while nothing was saved. | `setItem` throwing → no message |
| 3 | High | Import | Import replaced all data immediately, without confirmation and without any way back. | — |
| 4 | High | Import | Only `profiles` was checked. A backup with a wrong shape (e.g. `days:"x"`) was applied, then every view crashed. | `p.days.find is not a function` |
| 5 | High | Security | Ids from an imported backup were placed inside `onclick="…('id')"`; a crafted id ran script when tapped. | `window.__pw` set by an imported profile id |
| 6 | High | Security | Renamed meal names were inserted as HTML in the Days view (stored XSS via rename or a shared backup). | `<img onerror>` executed |
| 7 | High | Robustness | An unknown `goal` or `activity` in saved/imported data crashed the profile and target calculations (`GOALS[p.goal]` undefined, `act` NaN). | TypeError |
| 8 | High | Robustness | Any rendering exception left a blank page with no way to reach the backup screen. | — |
| 9 | High | Offline | The service worker stored **any** navigation response as the app shell, including a 404 page; after visiting a wrong URL the app could not start offline. | offline start showed "Not found" |
| 10 | Medium | Offline | On a slow connection the page waited for the network indefinitely even when a cached copy existed. | page not shown within 15 s |
| 11 | Medium | Nutrition | Training/rest-day carb cycling: rest days could go below the 1200/1500 kcal floor, and with 4+ training days the rest-day cut grew to 67–300 g. | floored woman: rest day 1048 kcal |
| 12 | Medium | Shopping | Cooked and raw forms of rice, pasta and pulses produced two separate rows (both shown as "Rouz"), each rounded up to a full pack. | 2 rice rows |
| 13 | Medium | Recipes | With "less oil" on, the recipe editor's per-portion totals still used the full oil, unlike every other view. | editor 574 kcal vs 499 |
| 14 | Medium | Units | ± buttons rounded to 0.1, so quarter steps broke (½ loaf − ¼ became 0.3). | 0.3 instead of 0.25 |
| 15 | Medium | Validation | Quantities typed by hand had no upper bound (1e12 g accepted). | — |
| 16 | Medium | Validation | Custom foods accepted impossible values (e.g. 140 g of macros per 100 g). | accepted |
| 17 | Medium | i18n | The Darija text for "weighed with bones" (`notes.asbought`) was missing, so "undefined" appeared in Prices/tooltips. `check-i18n` did not look inside nested tables. | "undefined" on screen |
| 18 | Low | Menu | Deleting a recipe used in the weekly menu left dangling references. | stale ids |
| 19 | Low | Data | Tuna in water used rounded values (100 kcal / 23 g protein per can); chicken breast protein 23 g instead of 22.5 g. | compared with USDA FDC 171986 / SR Legacy |
| 20 | Low | A11y | Light-theme text colours for macros, money and secondary text were below WCAG AA (2.6–4.4:1 on the sunken background); toasts were not announced to screen readers. | measured |

Found while fixing: built-in sweets declare up to 100 portions, but the editor capped servings at 40 — the validation
had to allow up to 500 so existing recipes were not altered (caught by the backward-compatibility test).

Checked and **not** a bug: Mifflin-St Jeor BMR, activity factors (1.2–1.9), goal factors, calorie floor, teen rule,
BMI-25 reference weight for protein, fat floor 0.6 g/kg, unit conversions (g, pieces, spoons, ml), recipe scaling,
day/week totals, aggregation across meals/recipes/profiles, consumption vs purchase cost, pantry subtraction, menu
quantities, budget maths, export→import round trip, cache cleanup on update, manifest and icon sizes.

## 2. Fixes

* **Data validation** (`sanitize`, `sanitizeIds`, `sanitizeMenu` in `index.html`): saved data and imported backups go
  through the same checks. Unusable values are repaired with safe defaults and counted; ids are limited to
  `[A-Za-z0-9_-]` and remapped everywhere they are referenced. Valid data is left byte-for-byte unchanged (verified with
  a fixture produced by the previous version).
* **Storage**: unreadable saved data is copied to `makla_mizan_v2_corrupt` before anything else, with a banner and a
  download button. Save failures show a persistent banner with a backup button, which disappears once saving works.
* **Import**: parsed and validated on a copy, smoke-tested (targets, totals, shopping list), then a confirmation shows
  what the file contains and how many entries were repaired. The current data is kept in `makla_mizan_v2_prev`;
  "Restore previous data" swaps back (also after "reset everything"). "Reset prices" now needs a second tap.
* **Crash screen**: a rendering error shows a recovery panel with "download my data" instead of a blank page.
* **Escaping**: meal names are escaped (all other user text already was).
* **Service worker**: only a 200 response for the app page itself (scope root or `index.html`) may replace the cached
  shell; navigation falls back to the cached copy after 3.5 s; cache-write lifetime is kept with `waitUntil`. Cache
  version bumped to `mizan-v25`.
* **Training days**: weekly-neutral shift with `n·up = (7−n)·down`, both ≤ 50 g, and rest days never under the floor.
* **Shopping**: cooked forms are merged into the dry purchase (only when both are bought in the same unit); existing
  pantry/ticks for the cooked form are migrated.
* **Recipes/units**: editor totals use the oil setting; ± steps keep two decimals; typed quantities are capped
  (meal line 5 kg / 100 pieces, recipe pot 50 kg / 500 pieces); servings up to 500.
* **Menu**: deleting a recipe replaces it in the weekly menu with the closest option; menu lists take part in unit
  conversions and deletions. Changing a food's buy unit clears its stale "at home" amount.
* **Custom foods**: per 100 g, protein+carbs+fat ≤ 100 g and energy ≤ 900 kcal.
* **Food data**: tuna in water and chicken breast aligned with USDA; liquids labelled ml; estimated foods marked **≈**
  (`EST`). Details and sources in [FOOD_DATA.md](FOOD_DATA.md).
* **Accessibility**: light-theme colour tokens darkened just enough for ≥ 4.6:1 (same hues); toasts are a live region;
  the add-food sheet is `aria-modal`.
* **Tooling**: `tools/check-i18n.js` now compares nested tables and placeholders in both directions.

## 3. Files changed

| File | Why |
|---|---|
| `index.html` | all fixes above (validation, storage, import, crash screen, escaping, maths, shopping, units, a11y, data labels, translations) |
| `sw.js` | safe shell caching, network timeout, version bump |
| `tools/check-i18n.js` | stricter translation check |
| `README.md` | data safety notes, how to run tests |
| `tests/run.js` *(new)* | automated test suite (Playwright, real app over http://localhost) |
| `tests/fixtures/state-v24.json` *(new)* | realistic data saved by the previous version, for backward compatibility |
| `FOOD_DATA.md` *(new)* | food data conventions, sources, what was and was not verified |
| `AUDIT.md` *(new)* | this report |
| `package.json`, `.gitignore` *(new)* | `npm test`, ignore `node_modules` and local results |

## 4. Automated tests — actual results

`npm test` runs 42 checks in headless Chromium. Expected values are computed by hand or from the raw data in the test
file, never with the app's own helper. "Before" = unmodified app (commit `d19d009`); 2 tests were added after the
baseline run and only have an "after" result.

| Group | Test | Before | After |
|---|---|---|---|
| Nutrition | 5 hand-calculated reference profiles (maintain, cut, BMI cap, calorie floor, teen) | pass ×5 | pass ×5 |
| Nutrition | invalid / empty / extreme inputs never give NaN or crash | FAIL | pass |
| Nutrition | training days: weekly-neutral, ≤ 50 g/day, floor kept | FAIL | pass |
| Units | grams, pieces, spoons and ml | pass | pass |
| Units | ± keeps quarter steps | FAIL | pass |
| Units | negative, empty, absurd quantities | FAIL | pass |
| Recipes | portion = pot ÷ servings | pass | pass |
| Recipes | servings change re-divides exactly | pass | pass |
| Recipes | less oil: card, editor, portion agree | FAIL | pass |
| Totals | day total and week average | pass | pass |
| Shopping | cooked + raw rice = one row | FAIL | pass |
| Shopping | aggregation across meals, recipes, profiles | pass | pass |
| Shopping | pack cost vs eaten cost | pass | pass |
| Shopping | weekly menu quantities | pass | pass |
| Shopping | pantry subtraction | pass | pass |
| Budget | month estimate and monthly spending | pass | pass |
| Profiles | add, switch, delete | pass | pass |
| Backup | export → import round trip | pass | pass |
| Backup | import asks for confirmation | FAIL | pass |
| Backup | import can be undone | — | pass |
| Backup | invalid JSON leaves data untouched | pass | pass |
| Backup | broken backup cannot break the app | FAIL | pass |
| Backup | crafted ids cannot inject script | FAIL | pass |
| Backup | corrupted saved data kept aside | FAIL | pass |
| Backup | storage failure reported | FAIL | pass |
| Backup | unknown goal/activity still loads | FAIL | pass |
| Backup | v24 data loads unchanged, zero repairs | — | pass |
| Backup | rendering error → recovery screen | FAIL | pass |
| Security | user text never executed | FAIL | pass |
| Languages | 5 languages × 7 tabs: no missing text/NaN/placeholders, RTL | FAIL | pass |
| Menu | deleting a recipe used in the menu | FAIL | pass |
| Menu | no NaN after menu, snacks, carb top-ups | pass | pass |
| Foods | impossible custom values refused | FAIL | pass |
| PWA | manifest and icon sizes | pass | pass |
| PWA | offline start after first visit | pass | pass |
| PWA | 404 never replaces the cached app | FAIL | pass |
| PWA | new version replaces old cache | pass | pass |
| PWA | slow network falls back to cache | FAIL | pass |
| **Total** | | **21 / 40 pass** | **42 / 42 pass** |

Other checks run: JavaScript syntax of the page script and `sw.js`; `node tools/check-i18n.js` (all languages OK);
the earlier feature scripts for the weekly menu, snacks, lean swaps, pantry and spending (no page errors);
screenshots of the main tabs, the import confirmation and the storage-error banner (light theme, 400 px wide).
Offline tests simulate a lost connection at the server, because browser offline emulation does not apply to service
workers.

## 5. Remaining risks and unverified areas

* Not tested on real phones: installation (Android/iOS), iOS Safari storage eviction, real storage-quota behaviour.
* Google Fonts are loaded from Google (privacy: the user's IP is sent to Google; first offline start without fonts falls
  back to system fonts).
* Food values: apart from the spot checks in FOOD_DATA.md, values were not individually re-verified.
* Keyboard-only navigation, screen-reader flow and RTL layout were not audited screen by screen (text and `dir` were).
* Extreme target settings (protein 3.3 g/kg + fat 40 % at a low calorie target) can make protein + fat exceed the
  calorie target; carbs then show 0. Not reachable with typical inputs.
* Inline event handlers prevent a strict Content-Security-Policy.

## 6. Recommended manual tests

1. Phone: install, open in airplane mode, add food, close and reopen.
2. After deploying, open twice online (GitHub Pages caches HTML up to 10 min) and check the new version appears.
3. Export a backup on one phone and import it on another; try "Restore previous data".
4. Switch to العربية / الدارجة and scroll every tab for layout issues.
5. Fill a day, change "Zit f les recettes", and compare the recipe editor with the Days view.

## 7. Prioritised future improvements

1. Self-host the fonts (privacy + first offline start).
2. Move nutrition, shopping and storage logic into separate modules testable in Node without a browser.
3. Replace inline `onclick` handlers to allow a strict CSP.
4. Automatic periodic backup reminder/export, or IndexedDB with versioned snapshots.
5. Record a source field for every built-in food and verify the remaining values (USDA FDC / Moroccan composition
   tables).
6. Focus management after re-render, tab-panel semantics and a focus trap in the add-food sheet.
7. Warn when protein + fat targets exceed the calorie target.

## 7. After the audit (interface phases 1–3)

The suite has grown to **52 checks, all passing**: 5 interface checks (bottom navigation and old section names,
first-run questions with and without macros, shopping list grouped by shop, folded menu days and dismissed tips) and
5 cooking checks (every built-in recipe has 3–7 steps; cooking-mode amounts follow the chosen portions; one step per
screen; the screen lock is requested and released; the phone's back button closes cooking mode; edited steps are
stored only when they differ from the built-in ones and are shown as text; favourites are cleaned on delete and
import). The cooking checks were confirmed to fail when portion scaling, lock release or favourite cleanup is broken
on purpose. Data saved by v24 still loads with no repairs.
