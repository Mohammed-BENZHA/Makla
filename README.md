# Makla Mizan

App (PWA) dyal l'makla mghribiya: menu dyal simana, lista dyal t9edya b dirham, recettes b l'khatawat, w macros l li bgha.

## Chno katdir
- **Menu** (onglet louwel): 4 d l'as2ila f l'bdya (ch7al d nass, chno ma katakloch, l'wa9t, l'budget) w l'app katwejjed simana kamla. Kol nhar mtwi, b étiquette (✓ mzyan, na9s protein, dhoun bezzaf…); t9der tbeddel ay wjba (rkhas, asra3, protein ktar, dhoun 9lal).
- **T9edya**: lista mjmou3a 3la 7sab l'blasa (khddar, gezzar, 7awwat, ferran, 7anout), WhatsApp f l'fou9, l'flous b dirham kamel. "3endi f dar" kay9ess men lista.
- **Recettes**: 90 recette mghribiya, kol wa7da b l'khatawat dyalha b ddarija. **Tayb** (👨‍🍳) kay7ell mode dyal tayb: l'kmiyat 3la 7sab 3dad n-nass, khatwa b khatwa, w l'écran ma kaytfach. ❤ l les recettes li kat7ebb (l'menu kaymil lihom chwiya). T9der tbeddel l'khatawat (kol str = khatwa).
- **Ana**: profils (wazn, tol, 3mer, nachat, lhadaf), ayyam template w simana. L'7sab dyal calories w protein ikhtiyari.
- **Hadaf dyal lwazn**: majal s7i7 3la 7sab tol (IMC 18.5–24.9), hadaf katkhtaro nta (ma kayt9belch t7t l7ad s7i7), barre d tatabo3 men l'moyenne d 7 ayyam, rythme f simana w imta twsel, tanbihat ila w9eft 3 simanat, ila zerbti bezzaf wla ila lhadaf ma metfa9ch m3a l'profil. L9yas dyal lkerch ikhtiyari (nesba lkerch/tol).
- **⚙ Réglages**: lougha (5), mode (fate7 / mdellem / auto), zit f les recettes, prix, sauvegarde/import.
- Katkhdem **offline** men ba3d awel merra.

## Installation 3la telephone
- **Android (Chrome)**: 7ell l'lien → bouton "Installi l'app", wla menu ⋮ → *Installer l'application*.
- **iPhone (Safari)**: 7ell l'lien → bouton Partager → *Sur l'écran d'accueil*.

## Data
Kolchi kaytsjel f l'appareil (localStorage). Bach tdowwez data l appareil akhor: **⚙ Réglages → Telecharger fichier**, w f l'appareil l'akhor **Importer men fichier**.
- L'import kaywerrik chno f l'fichier w kaytsennak t2akked 9bel ma ybeddel; l'data l9dima katb9a w t9der trje3 liha.
- Ila ma t9dertch l'app tsjjel (memoire 3amra), katban rissala 7mra. Ila l'data li kanet msjjla ma t9ratch, katkhbba f blasa w t9der t7mmelha.
- L'ar9am dyal l'makla: chouf [FOOD_DATA.md](FOOD_DATA.md) (mnin jaw, chno t2akked, w chno ta9dir ≈).

## Tests
```
npm install        # playwright
npx playwright install chromium   # ila ma kanch 3endek Chromium
npm test           # 54 test: 7sab, unités, recettes, lista, backup, sécurité, lougat, offline, wajiha, tayb, hadaf dyal lwazn
npm run check-i18n # kolchi mtarjem f 5 d l'lougat
```
Tafasil l'audit w l'bugs li tsla7o: [AUDIT.md](AUDIT.md).

## Mise à jour
Ila beddelti chi 7aja, beddel `VERSION` f `sw.js` bach les telephones yjibou version jdida, w doz `npm test`.
