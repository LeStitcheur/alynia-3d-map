# Ocean Hospital — Plan 3D explorable

Site web statique (three.js) qui affiche l'MLO FiveM **oceanHospital** en 3D :

- **Maquette** : vue orbitale du bâtiment, coupe par étage (sous-sol, RDC, 1er, 2e, étage supérieur), noms des salles, clic sur une salle pour la sélectionner.
- **Visite libre** : déplacement à la première personne avec collisions (ZQSD/WASD, Maj pour courir, `F` pour le vol libre), joystick tactile sur mobile.
- Liste des salles avec recherche, mini-plan SVG de l'étage courant, fiche de salle (dimensions, surface approximative).

## Lancer en local

```bash
npm install
npm start
```

puis ouvrir <http://localhost:8080> (port modifiable via la variable `PORT`).

## Déployer

```bash
npm run deploy
```

Le script ([scripts/deploy.mjs](scripts/deploy.mjs)) :

1. commite tous les changements et pousse le code sur la branche `main` de <https://github.com/LeStitcheur/alynia-3d-map> ;
2. publie le dossier `public/` sur la branche `gh-pages`.

Message de commit personnalisé : `npm run deploy -- "mon message"`.

**Au premier déploiement uniquement** : dans GitHub → *Settings → Pages*, choisir la source *Deploy from a branch* → `gh-pages` / `(root)`. Le site sera ensuite servi sur <https://lestitcheur.github.io/alynia-3d-map/>.

Le projet tourne aussi tel quel sur n'importe quel hébergeur Node (Render, Railway, VPS…) branché sur le dépôt : `npm start`, sans dépendance de production.

## Régénérer le modèle depuis le dossier FiveM

```bash
npm run build:model -- "C:/Users/lelex/Downloads/oceanHospital/oceanHospital/stream"
```

Pré-requis : .NET SDK 10 et Node.js (uniquement pour régénérer le modèle, pas pour déployer). Le script :

1. clone [CodeWalker](https://github.com/dexyfex/CodeWalker) dans `tools/CodeWalker` si besoin, puis compile `tools/OceanExporter` ;
2. lit les `.ytyp`/`.ymap` (placements, intérieurs MLO, salles), les `.ydr`/`.ydd`/`.yft` (géométrie) et les `.ytd` (textures) ;
3. écrit un glTF + `rooms.json` dans `build/export/` ;
4. l'optimise avec gltf-transform (compression meshopt, textures WebP ≤ 1024 px) vers `public/model/hospital.glb`.

## Limites connues

- Les objets **vanilla GTA V** placés dans l'intérieur (≈ 2 500 occurrences : chaises, lits standards, plantes…) ne sont pas fournis dans la ressource : ils sont absents de la maquette. Seuls les modèles propres à l'Ocean Hospital sont affichés.
- Même chose pour ~190 textures vanilla (routes, certains sols) : les surfaces concernées apparaissent en gris clair.
- Les surfaces de salles sont calculées à partir des boîtes englobantes des « rooms » MLO : ce sont des ordres de grandeur, pas des surfaces au sol exactes.
- La **morgue** est déclarée dans l'MLO (`R20morgue`) mais la ressource ne contient aucun modèle pour elle : elle est reconstituée procéduralement dans [public/morgue.js](public/morgue.js) (murs ouest/sud, sol, plafond, chambre froide 24 cases, tables d'autopsie, paillasse, brancard), calée sur la façade et le mur du garage existants.
- L'intérieur `bm_middoc` (situé à 3 km, sans rapport avec l'hôpital) est ignoré.

## Structure

```
public/            site servi (index.html, style.css, app.js, morgue.js, model/)
server.js          serveur statique Node sans dépendance
scripts/deploy.mjs npm run deploy
tools/
  OceanExporter/   convertisseur GTA V -> glTF (C#)
  build-model.sh   npm run build:model
```

Les noms affichés des salles et les hauteurs d'étage se règlent en haut de `public/app.js` (`ROOM_NAMES`, `LEVELS`).

## Performances

Le modèle est découpé par l'exporteur en blocs par étage (`tile|<intérieur/extérieur/portes>|L0..L4|tall`). Le viewer :

- n'affiche que l'étage sélectionné en vue maquette (≈ 1 M triangles au lieu de 3,5 M) ;
- masque l'intérieur en vue d'ensemble tant que la caméra est hors du bâtiment ;
- en visite, n'affiche que l'étage courant et ses voisins, dans la distance du brouillard ;
- ne redessine la maquette que quand la caméra bouge, et ajuste la résolution si l'affichage ralentit.
