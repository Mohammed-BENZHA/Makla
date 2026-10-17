# Makla Mizan

App (PWA) dyal macros, planning dyal simana w lista dyal t9edya b dirham, m3a l'makla mghribiya.

## Chno katdir
- **Profils**: kol wa7ed b lwazn, tol, 3mer, nachat w lhadaf dyalou (tnchif, recomp, 7afed, zid 3dalat).
- **Lwazn**: sjel lwazn, moyenne 7 ayyam, graphique, w TDEE l7a9i9i men tbeddel lwazn.
- **Recettes**: l'9edra kamla → portions (tajine, 7rira, kesksou…).
- **Ayyam template**: sawb 2–3 d les ayyam (nhar training, nhar raha) w l'app kat7seb calories, protein, karb, dhoun w taman.
- **Simana & t9edya**: 3ti template l kol nhar, w l'app katkhrej lista dyal chra b l'kilo w b l7ba (9tani w rouz nay, djaj w 7out b l3dem).
- **Prix**: beddel les prix b dyal l'7anout dyalek, zid makla dyalek, sauvegarde/import.
- Katkhdem **offline** men ba3d awel merra.

## Installation 3la telephone
- **Android (Chrome)**: 7ell l'lien → bouton "Installi l'app", wla menu ⋮ → *Installer l'application*.
- **iPhone (Safari)**: 7ell l'lien → bouton Partager → *Sur l'écran d'accueil*.

## Data
Kolchi kaytsjel f l'appareil (localStorage). Bach tdowwez data l appareil akhor: onglet **Prix → Telecharger fichier**, w f l'appareil l'akhor **Importer men fichier**.
- L'import kaywerrik chno f l'fichier w kaytsennak t2akked 9bel ma ybeddel; l'data l9dima katb9a w t9der trje3 liha.
- Ila ma t9dertch l'app tsjjel (memoire 3amra), katban rissala 7mra. Ila l'data li kanet msjjla ma t9ratch, katkhbba f blasa w t9der t7mmelha.
- L'ar9am dyal l'makla: chouf [FOOD_DATA.md](FOOD_DATA.md) (mnin jaw, chno t2akked, w chno ta9dir ≈).

## Tests
```
npm install        # playwright
npx playwright install chromium   # ila ma kanch 3endek Chromium
npm test           # 42 test: 7sab, unités, recettes, lista, backup, sécurité, lougat, offline
npm run check-i18n # kolchi mtarjem f 5 d l'lougat
```
Tafasil l'audit w l'bugs li tsla7o: [AUDIT.md](AUDIT.md).

## Mise à jour
Ila beddelti chi 7aja, beddel `VERSION` f `sw.js` bach les telephones yjibou version jdida, w doz `npm test`.
