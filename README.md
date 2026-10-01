# PATASUR : application web de détection des faux billets FCFA

Prototype à l'apparence d'une application mobile : caméra ou photo → modèle YOLO26s (ONNX) → verdict
Authentique / Suspect / Incertain, avec un score pour chaque critère de sécurité.
**Ce n'est pas un outil de vérification officiel.**

Charte graphique du site de la BEAC (bleu #005ca6, or #c2a712, crème, polices Avenir / Open Sans).
Pendant un scan, un rayon lumineux balaie le billet à l'écran, puis le verdict s'affiche.

Écrans : **Scanner** (caméra en direct, galerie, recto + verso), **Résultat** (verdict, image annotée,
critères, score pondéré S, signalement), **Historique**, **Guide** (critères de sécurité, bons gestes),
**Autorités** (tableau de bord de démonstration) et **Paramètres** (seuil, voix, mode malvoyant, vibration).
Sur PC, l'application s'affiche dans un cadre de téléphone (pratique pour la projection).

## Arborescence

```
web_app/
├── index.html            structure des écrans (accueil, caméra, résultat, onglets)
├── style.css             apparence « application mobile »
├── detection.js          prétraitement, seuil, NMS, décision VRAI/FAUX/INCERTAIN
├── app.js                modèle, caméra, scores par critère, historique, voix, navigation
├── manifest.webmanifest  installation sur l'écran d'accueil (nom, icône, couleurs)
├── icons/                icônes de l'application (PNG 192/512, billet de 10 000)
├── img/                  billet de 10 000 FCFA (accueil, logo)
├── lancer_serveur.bat    lance le serveur local (double-clic)
└── model/
    ├── best.onnx         ton modèle exporté depuis Colab
    └── classes.json      noms des 11 classes + taille 960 + seuil
```

Pour changer de modèle, remplace `model/best.onnx` et `model/classes.json`
(les deux fichiers doivent venir du même entraînement).

## 1. Tester sur le PC (webcam)

1. Double-clique sur `lancer_serveur.bat`. Si Windows demande l'autorisation du pare-feu, coche **Réseaux privés** puis **Autoriser**.
2. Ouvre **Chrome** ou **Edge** à l'adresse `http://localhost:8000`.
3. Attends « Modèle prêt » (le fichier fait 38 Mo), clique sur **Démarrer la caméra** et autorise la caméra.

> N'ouvre pas `index.html` par double-clic : le navigateur bloque alors le chargement du modèle.

## 2. Tester sur le téléphone Android (même Wi-Fi que le PC)

La caméra d'un navigateur ne fonctionne qu'en HTTPS ou sur `localhost`.
Pour un test local, on dit à Chrome de faire confiance à l'adresse de ton PC :

1. Lance `lancer_serveur.bat` sur le PC et note l'adresse IPv4 affichée (ex. `192.168.1.25`).
2. Sur le téléphone, ouvre Chrome et tape : `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
3. Dans la case, écris `http://192.168.1.25:8000` (ton adresse), passe l'option à **Enabled**, puis touche **Relaunch**.
4. Ouvre `http://192.168.1.25:8000` sur le téléphone, puis touche **Démarrer la caméra** (la caméra arrière est utilisée par défaut).
5. Pour garder un raccourci : menu ⋮ → **Ajouter à l'écran d'accueil**.

Si la page ne s'ouvre pas : vérifie que le PC et le téléphone sont sur le même Wi-Fi et que le pare-feu autorise Python.

### Option : lien HTTPS permanent (GitHub Pages)

À utiliser si tu veux tester n'importe où, sans PC allumé.
⚠️ Le dépôt doit être **public** : ton modèle sera téléchargeable par tout le monde.

1. Crée un compte sur github.com et installe **GitHub Desktop**. L'envoi par le site web est limité à 25 Mo par fichier, alors que `best.onnx` fait 38 Mo.
2. Dans GitHub Desktop : *File → New repository*, puis copie le contenu de `web_app/` dans le dossier créé. Fais *Commit*, puis *Publish repository* (décoche « Keep this code private »).
3. Sur github.com, dans ton dépôt : *Settings → Pages → Branch : main / (root) → Save*.
4. Après 1 à 2 minutes, l'adresse `https://TON_NOM.github.io/NOM_DU_DEPOT/` fonctionne sur le téléphone, sans réglage Chrome.

## 3. Lire l'écran de résultat

| Affichage | Signification |
|---|---|
| Carte **verte** « Billet authentique » | jugé vrai, confiance ≥ seuil, aucun élément suspect |
| Carte **rouge** « Billet suspect » | jugé faux, confiance ≥ seuil |
| Carte **orange** « Résultat incertain » | confiance < seuil, hésitation VRAI/FAUX, ou élément `_F` sur un billet jugé vrai |
| Anneau | confiance du modèle pour ce verdict |
| Critère **vert** Conforme / **bleu** Peu net | élément `_V` détecté (au-dessus / en dessous du seuil) |
| Critère **orange** Douteux / **rouge** Suspect | élément `_F` détecté (en dessous / au-dessus du seuil) |
| Score pondéré S | moyenne des critères visibles (poids égaux) : indicatif, le verdict reste celui du modèle |
| Recto + verso | le verdict le plus grave des deux faces l'emporte |

En mode **recto + verso**, prends le recto, puis retourne le billet et prends le verso.
Depuis la galerie, tu peux choisir les deux photos d'un coup.
Le **mode vocal** (accueil ou Paramètres) annonce le verdict à voix haute pendant le scan en direct.
Le **Temps d'analyse** et le **Moteur** (`GPU (WebGPU)` rapide, `CPU (wasm)` lent) sont dans Paramètres.

## 4. Tests à faire (note les résultats dans un tableau)

| # | Situation | Attendu |
|---|---|---|
| 1 | Vrai billet, bonne lumière, à plat, rempli 60–80 % de l'image | VRAI (vert) |
| 2 | Faux billet, mêmes conditions | FAUX (rouge) |
| 3 | Faible lumière (pièce sombre, soir) | pas de VRAI sur un faux ; INCERTAIN acceptable |
| 4 | Contre-jour / reflet du néon | idem |
| 5 | Billet plié en deux, froissé | idem |
| 6 | Billet loin (petit dans l'image) puis très proche | noter à partir de quelle distance ça marche |
| 7 | Recto puis verso, chaque dénomination (500 à 10 000) | noter les ratés |
| 8 | **Faux de bonne qualité** (le plus ressemblant que tu as) | FAUX ou INCERTAIN, **jamais VRAI** |
| 9 | Autre téléphone / webcam que celui des photos d'entraînement | noter les différences |
| 10 | Aucun billet (main, feuille blanche, facture) | « Aucun billet détecté » |

Toute erreur « faux → VRAI » est grave : garde une capture d'écran et ajoute ce cas au dataset.
