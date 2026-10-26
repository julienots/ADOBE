# Prisme Photo

**Éditeur photo complet pour Windows, Android et navigateur — une création SuperEssence Studio.**

Prisme réunit dans une seule application la retouche par calques (façon Photoshop) et le
développement photo (façon Lightroom). Il fonctionne hors ligne : les photos ne quittent
jamais l'appareil.

## Télécharger l'application

Chaque push déclenche le workflow **« Compiler Prisme (Android + Windows) »**
(`.github/workflows/build.yml`). Aucune licence ni aucun secret n'est nécessaire.

1. Sur GitHub, ouvrir l'onglet **Actions** puis la dernière exécution réussie.
2. En bas de la page, dans **Artifacts** :
   - **Prisme-Android-APK** → `Prisme.apk` à installer sur le téléphone
     (autoriser « Installer des applications inconnues »).
   - **Prisme-Windows** → `Prisme-Setup-1.0.0.exe` (installateur) ou
     `Prisme-Portable-1.0.0.exe` (sans installation).
     Windows SmartScreen peut afficher un avertissement tant que l'application
     n'est pas signée : *Informations complémentaires → Exécuter quand même*.
   - **Prisme-Web** → le dossier `www/` à héberger sur n'importe quel serveur (PWA installable).

On peut aussi relancer la compilation à la main : *Actions → Compiler Prisme → Run workflow*.

## Lancer en local

```bash
npm run serve          # version web sur http://localhost:8080
npm install && npm start   # version Windows/Mac/Linux (Electron)
```

## Fonctionnalités

**Calques** : calques illimités, 16 modes de fusion, opacité, verrouillage, glisser-déposer pour
réordonner, masques de fusion (peindre, inverser, appliquer, depuis la sélection), effets
(ombre portée, lueur externe, contour), fusion vers le bas / des visibles / aplatir, calques texte ré-éditables.

**Réglages photo (développement)** : exposition, contraste, hautes lumières, ombres, blancs,
noirs, température, teinte, vibrance, saturation, texture, clarté, correction du voile, courbe des
tonalités RVB/R/V/B avec préréglages, TSL sur 8 couleurs, étalonnage ombres / tons moyens /
hautes lumières, netteté, réduction du bruit (luminance + couleur), vignetage, grain, délavé,
noir & blanc, réglage **Auto**. Aperçu en direct, appliqué au calque ou à la sélection.

**23 looks** : Cinéma, Teal & Orange, Vintage, Pellicule, N&B contrasté, Heure dorée, Cyberpunk… avec intensité réglable.

**49 filtres et réglages** : niveaux, luminosité/contraste, teinte/saturation, balance des couleurs,
mélangeur de couches, filtre photo, courbe de transfert de dégradé, noir et blanc par couleur,
égalisation, niveaux / contraste automatiques ; flous gaussien, de mouvement, radial, rotatif,
tilt-shift, bokeh ; accentuation, passe-haut ; bruit, réduction du bruit, médiane, anti-poussière ;
pixellisation, demi-teinte, estampage, contours, peinture à l'huile, croquis, bande dessinée,
lueur Orton, glitch, aberration chromatique, fuite de lumière, bichromie, solarisation ;
tourbillon, sphérisation, ondulation, pincement, coordonnées polaires.

**25 outils** : déplacement, transformation libre (échelle, rotation, symétrie), recadrage
(13 formats, redressement, grilles des tiers / nombre d'or), rectangle et ellipse de sélection,
lasso, lasso polygonal, sélection rapide, baguette magique, pinceau (dureté, flux, lissage,
pression du stylet, modes de fusion), crayon, gomme, pot de peinture, dégradé (5 types,
11 palettes), pipette, correcteur localisé, tampon de duplication, doigt, densité −/+ et éponge,
goutte d'eau / netteté, yeux rouges, texte (police, contour, ombre, fond, rotation…),
10 formes, main, zoom.

**Sélection** : tout, inverser, contour progressif, étendre / contracter, plage de couleurs,
depuis les pixels d'un calque, ajouter / soustraire / intersection.

**Image** : taille de l'image, taille de la zone de travail avec ancrage, rotations,
symétries, recadrage sur la sélection, rognage automatique.

**Fichiers** : ouverture JPEG/PNG/WebP/GIF/AVIF/BMP, lecture EXIF, glisser-déposer,
coller depuis le presse-papier, appareil photo sur mobile, export JPEG/PNG/WebP/AVIF
(qualité, taille, aperçu du poids), partage mobile, projets `.prisme` multi-calques,
**sauvegarde automatique** de la session.

**Interface** : écran d'ouverture SuperEssence Studio, thème sombre, menus complets,
raccourcis clavier façon Photoshop (Aide → Raccourcis), historique de 60 étapes avec
panneau, histogramme, avant / après, interface tactile dédiée sur mobile (pincer pour
zoomer, panneaux coulissants).

## Structure

```
www/                 Application (HTML/CSS/JavaScript, sans dépendance)
  js/app.js          État global, calque cible, rendu
  js/doc.js          Document, calques, masques, composition
  js/develop.js      Moteur de développement photo + looks
  js/filters.js      Filtres et réglages
  js/tools/          Outils (peinture, sélection, transformation…)
  js/panels.js       Panneaux Réglages, Looks, Calques, Filtres, Historique, Infos
  js/actions.js      Commandes, menus, raccourcis
  js/io.js           Ouverture, EXIF, export, projets, sauvegarde automatique
electron/main.js     Application Windows
capacitor.config.json  Application Android
assets/, build/      Icônes et logos (logo « P » de Prisme, logo SuperEssence)
```

© SuperEssence Studio. Tous droits réservés.
