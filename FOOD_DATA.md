# Food data — sources, conventions and known limits

The app ships 192 built-in foods (`FOODS` in `index.html`) and ~90 built-in recipes.
Users can override any built-in food (`S.ov`), change its price (`S.prices`) or add their own (`S.custom`); those user
values are never touched by updates.

## How a food is described

| Field | Meaning |
|---|---|
| `u` | `'g'` → macros are **per 100 g** (or per 100 ml when `gu:'ml'`); `'u'` → macros are **per unit** (`ul`: piece, spoon, glass, can…) |
| `m` | `[kcal, protein g, carbs g, fat g]` for that measure |
| `b`, `f` | how it is bought (`kg`, `L` or pieces) and how many buy-units one measure needs, **including waste** (bones, peel, cooking yield) |
| `nt` | weighing note: `bone`/`sardine`/`merla` = enter the **edible** weight, `whole`/`asbought` = enter the weight **as bought**, `dry` = the food is weighed **cooked** but bought dry |

### Raw vs cooked
Rice, pasta and pulses exist twice: **cooked** (`rouz`, `makarona`, `3des`, `loubia`, `7mes`) and **raw/dry**
(`rouz_n`, …). Names say *(tayeb)* / *(nay)*. Built-in recipes always use the raw form. On the shopping list both forms
are bought as the same dry product (one row), because the cooked form's `f` already converts cooked grams to kg of dry
product (e.g. 1 g cooked rice = 0.35 g dry).

## Where the numbers come from

* **Raw ingredients** (meat, fish, eggs, grains, pulses, vegetables, fruit, nuts, oils…) use typical values from food
  composition tables, in practice the USDA FoodData Central *SR Legacy* figures for the raw food.
* **Estimates** — Moroccan bread and prepared items (msemen, harcha…), street food, branded portions (Perly, cheese
  wedges, whey), spoon-based spreads (amlou, jben), meat/fish weighed *as bought* with bones, and the spice mix.
  These are listed in `EST` in `index.html` and shown in the app with a **≈** badge.
* **Recipes** are computed from their ingredients (sum ÷ portions). They inherit the accuracy of the ingredients and
  assume the written quantities; real cooking (oil left in the pan, water lost) changes them.

## What was checked in the audit (October 2026)

1. **Energy cross-check of all 192 foods**: `kcal` was compared with 4·protein + 4·carbs + 9·fat.
   No impossible entry was found (no negative value, no food with more than 100 g of macros per 100 g, nothing above
   900 kcal/100 g). The only deviations above 15 % are vegetables, herbs, lemon/lime, yeast and spices, where tables
   count fibre inside carbohydrates and use food-specific energy factors — expected, not errors.
2. **Spot checks against USDA FoodData Central (SR Legacy)**, fetched during the audit:

| App food | App value | USDA reference | Result |
|---|---|---|---|
| `rouz` rice, cooked (100 g) | 130 kcal · P 2.7 · C 28 · F 0.3 | FDC 168878: 130 · 2.69 · 28.2 · 0.28 | matches |
| `bid` egg (one, ~50 g edible) | 72 · 6.3 · 0.4 · 4.8 | FDC 171287 per 100 g: 143 · 12.6 · 0.72 · 9.51 → ×0.5 | matches |
| `3des` lentils, cooked (100 g) | 116 · 9 · 20 · 0.4 | 116 · 9.0 · 20.1 · 0.38 | matches |
| `sder` chicken breast, raw (100 g) | 120 · **23** · 0 · 2.6 | skinless boneless raw: 120 · 22.5 · 0 · 2.62 | protein corrected to 22.5 |
| `ton_ma` tuna in water, drained (80 g can) | was 100 · **23** · 0 · 1 | FDC 171986 per 100 g: 116 · 25.5 · 0 · 0.82 → ×0.8 = 93 · 20.4 · 0 · 0.66 | corrected to 93 · 20.4 · 0 · 0.7 |

3. **Units**: liquids used in millilitres in recipes (orange-blossom water, vinegar, soy sauce) are now labelled ml.

## Not verified
Apart from the rows above, values were **not individually re-fetched** from a database during the audit. They are
plausible (energy cross-check) and consistent with common tables, but treat them as typical values, not as lab
measurements of the product in your kitchen. When you have a label, correct the food with ✎ in *Prix* — the app keeps
your values and stops showing the ≈ badge for that food.
