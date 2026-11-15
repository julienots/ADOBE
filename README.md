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
   - **Prisme-Windows** → `Prisme-Setup-1.1.0.exe` (installateur) ou
     `Prisme-Portable-1.1.0.exe` (sans installation).
     Windows SmartScreen peut afficher un avertissement tant que l'application
     n'est pas signée : *Informations complémentaires → Exécuter quand même*.
   - **Prisme-Web** → le dossier `www/` à héberger sur n'importe quel serveur (PWA installable).

On peut aussi relancer la compilation à la main : *Actions → Compiler Prisme → Run workflow*.

## Lancer en local

```bash
npm run serve          # version web sur http://localhost:8080
npm install && npm start   # version Windows/Mac/Linux (Electron)
```

## Nouveautés de la version 1.1

- **Rendu accéléré par la carte graphique (WebGL 2)** : les réglages photo (exposition, tonalité,
  clarté, voile, courbes, TSL, étalonnage, vignetage, grain…) sont calculés sur le GPU, à l'aperçu
  comme à l'application en pleine résolution. Résultat identique au moteur CPU, qui reste utilisé
  automatiquement si WebGL 2 manque ou si le GPU est émulé. *Affichage → Accélération GPU*.
- **Fichiers Photoshop (PSD)** : ouverture multi-calques (opacité, modes de fusion, visibilité,
  masques, groupes aplatis) et export PSD avec calques et masques (*Fichier → Exporter en PSD*).
- **Photos d'iPhone (HEIC / HEIF)** décodées sur l'appareil (libheif en WebAssembly).
- **Fichiers RAW** (CR2, CR3, NEF, ARW, DNG, ORF, RW2, RAF, PEF…) : ouverture de l'aperçu JPEG
  pleine taille intégré par l'appareil, avec l'orientation et les données EXIF.
- **TIFF** en ouverture et en export.
- **Palette de commandes** (`Ctrl+K`) : recherche instantanée dans toutes les commandes, les
  49 filtres et les outils, avec les dernières commandes utilisées en tête.
- **Enregistrement direct sur le disque** (Chrome, Edge, application Windows) : `Ctrl+S` réécrit
  le même fichier `.prisme`, *Enregistrer le projet sous…* choisit un nouvel emplacement.
- **Ouvrir avec Prisme** : double-clic sur un `.prisme` ou « Ouvrir avec » dans l'Explorateur
  Windows ; version web installée : gestion des fichiers du système (File Handling API).

Les bibliothèques de formats ne sont téléchargées qu'à la première utilisation : le démarrage
de l'application n'est pas ralenti.

## Prisme face à Adobe (Photoshop + Lightroom)

| | Prisme | Adobe |
|---|---|---|
| Prix | Gratuit, sans abonnement | Abonnement mensuel |
| Compte obligatoire | Non | Oui |
| Fonctionne hors ligne | Oui, entièrement (IA comprise) | En partie ; l'IA générative passe par le cloud |
| Confidentialité | Les photos ne quittent jamais l'appareil | Fonctions IA envoyées aux serveurs d'Adobe |
| Une seule app pour retouche + développement | Oui | Deux logiciels (Photoshop et Lightroom) |
| Même app sur Windows, Android et navigateur | Oui | Apps différentes selon la plateforme |
| Poids | ~20 Mo | Plusieurs Go |
| Fichiers Photoshop (PSD) | Ouverture et export avec calques | Natif |

Adobe garde encore de l'avance sur certains points : développement RAW complet depuis les données
du capteur (Prisme utilise l'aperçu intégré), mode CMJN pour l'impression, remplissage génératif à
partir d'un texte, objets dynamiques, calques de réglage, extensions.

## Intelligence artificielle (sur l'appareil, hors ligne)

- **Sélectionner le sujet** / **l'arrière-plan** en un clic (modèle U²-Net + affinage des contours guidé par l'image).
- **Supprimer l'arrière-plan** : crée un masque de calque modifiable (non destructif).
- **Remplacer l'arrière-plan** : couleur, dégradé, photo floutée ou transparent.
- **Flou d'arrière-plan (portrait)** avec aperçu en direct.
- **Remplissage d'après le contenu** : la zone sélectionnée est reconstruite à partir du reste de la photo.
- **Suppression d'objet au pinceau** (outil Correcteur) : on peint sur l'objet, il disparaît.
- **Réglages ciblés** : dans le panneau Réglages, « Appliquer à : Sujet / Arrière-plan ».

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

**Fichiers** : ouverture JPEG/PNG/WebP/GIF/AVIF/BMP/TIFF/HEIC/PSD/RAW, lecture EXIF, glisser-déposer,
coller depuis le presse-papier, appareil photo sur mobile, export JPEG/PNG/WebP/AVIF/TIFF/PSD
(qualité, taille, aperçu du poids), partage mobile, projets `.prisme` multi-calques,
enregistrement direct sur le disque, **sauvegarde automatique** de la session.

**Interface** : écran d'ouverture SuperEssence Studio, thème sombre, menus complets,
raccourcis clavier façon Photoshop (Aide → Raccourcis), palette de commandes `Ctrl+K`, historique de 60 étapes avec
panneau, histogramme, avant / après, interface tactile dédiée sur mobile (pincer pour
zoomer, panneaux coulissants).

## Structure

```
www/                 Application (HTML/CSS/JavaScript, sans dépendance)
  js/app.js          État global, calque cible, rendu
  js/doc.js          Document, calques, masques, composition
  js/develop.js      Moteur de développement photo + looks
  js/gpu.js          Moteur de développement WebGL 2 (shaders GLSL)
  js/formats.js      PSD, TIFF, HEIC, RAW (chargés à la demande)
  js/palette.js      Palette de commandes (Ctrl+K)
  js/filters.js      Filtres et réglages
  js/tools/          Outils (peinture, sélection, transformation…)
  js/panels.js       Panneaux Réglages, Looks, Calques, Filtres, Historique, Infos
  js/actions.js      Commandes, menus, raccourcis
  js/io.js           Ouverture, EXIF, export, projets, sauvegarde automatique
  js/ai.js           Détection du sujet (ONNX Runtime Web + U²-Net-p)
  js/inpaint.js      Remplissage d'après le contenu (PatchMatch multi-échelle)
  vendor/ort/        ONNX Runtime Web (licence MIT, Microsoft)
  vendor/ag-psd/     Lecture/écriture PSD (licence MIT)
  vendor/utif/       TIFF : UTIF.js + pako (licences MIT)
  vendor/libheif/    Décodeur HEIC/HEIF en WebAssembly (licence LGPL-3.0, fichier remplaçable)
  models/            Modèle U²-Net-p (licence Apache 2.0)
electron/main.js     Application Windows
electron/preload.js  Pont sécurisé (ouverture des fichiers depuis l'Explorateur)
capacitor.config.json  Application Android
assets/, build/      Icônes et logos (logo « P » de Prisme, logo SuperEssence)
```

© SuperEssence Studio. Tous droits réservés.
