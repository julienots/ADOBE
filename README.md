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

## Contrôles

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
