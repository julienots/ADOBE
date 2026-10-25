# ORB RUSH 🎮

Petit jeu 3D sous Unity, généré « au pif » : tu es une boule lumineuse sur une arène flottante
générée aléatoirement. Ramasse toutes les orbes de la vague, évite les cubes rouges qui te
pourchassent… et éjecte-les dans le vide d'un coup de dash pour des points bonus.

## Lancer le jeu

1. Ouvre ce dossier avec **Unity Hub** (testé pour Unity 2022.3 LTS, compatible Unity 6).
2. À la première ouverture, la scène `Assets/Scenes/Main.unity` est créée automatiquement.
3. Appuie sur **Play** ▶️ — tout le jeu (arène, joueur, caméra, interface) se construit par code.

> Si Unity signale que l'ancien Input Manager est désactivé : *Edit → Project Settings → Player →
> Active Input Handling* → **Both** (ou *Input Manager (Old)*).

## Obtenir l'APK Android

### Option 1 : compilation automatique sur GitHub (sans installer Unity)

Le workflow `.github/workflows/build-android.yml` compile l'APK à chaque push. Il a besoin
d'une licence Unity (la licence Personal gratuite suffit), à ajouter **une seule fois** dans
*GitHub → Settings → Secrets and variables → Actions → New repository secret* :

| Secret | Valeur |
|---|---|
| `UNITY_EMAIL` | l'e-mail de ton compte Unity |
| `UNITY_PASSWORD` | son mot de passe |
| `UNITY_LICENSE` | le contenu du fichier `Unity_lic.ulf` |

Le fichier `.ulf` se trouve sur un PC où Unity Hub est connecté et la licence Personal activée :
- Windows : `C:\ProgramData\Unity\Unity_lic.ulf`
- macOS : `/Library/Application Support/Unity/Unity_lic.ulf`
- Linux : `~/.local/share/unity3d/Unity/Unity_lic.ulf`

(Guide détaillé : https://game.ci/docs/github/activation)

Ensuite : onglet **Actions → Build APK Android → Run workflow**. À la fin (~20-30 min la première
fois), télécharge l'artefact **OrbRush-apk** : il contient `OrbRush.apk`, à copier sur le
téléphone et à installer (autoriser les « sources inconnues »).

### Option 2 : depuis Unity sur ton PC

1. Dans Unity Hub, installe le module **Android Build Support** (avec OpenJDK et SDK/NDK).
2. *File → Build Settings → Android → Switch Platform*, puis **Build**.

## Contrôles mobiles

Joystick virtuel à gauche de l'écran, boutons **SAUT** et **DASH** à droite, glisser le doigt
sur la droite pour tourner la caméra. Bouton retour Android = retour au menu.

## Contrôles clavier

| Touche | Action |
|---|---|
| WASD / Flèches | Rouler |
| Espace | Sauter |
| Shift / Clic gauche | Dash (éjecte les cubes) |
| Clic droit + souris, Q / E | Tourner la caméra |
| R (menu / game over) | Nouvelle arène aléatoire |
| Échap | Retour au menu |

## Règles

- Orbe bleue : **10 pts** · Orbe dorée (sur les plateformes, il faut sauter) : **50 pts**
- Vague terminée : **100 × vague**
- Cube éjecté de l'arène : **50 × vague**
- 3 vies : un cube qui te touche (hors dash) ou une chute dans le vide en coûte une.
- Chaque vague ajoute plus d'orbes et des cubes plus nombreux et plus rapides.

## Code

Tout est dans `Assets/Scripts/` :

- `GameBootstrap.cs` – démarre le jeu automatiquement dans n'importe quelle scène
- `GameManager.cs` – génération de l'arène, vagues, score, vies, interface
- `PlayerController.cs` – physique de la boule (déplacement, saut, dash)
- `Enemy.cs`, `Orb.cs`, `Debris.cs`, `CameraFollow.cs` – le reste
