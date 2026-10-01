// =====================================================================
// detection.js — Toute la logique "intelligence" de l'application :
//   1) préparer l'image pour le modèle (letterbox 960x960),
//   2) lire la sortie brute du modèle YOLO26 (ONNX),
//   3) filtrer par seuil + supprimer les doublons de boîtes (NMS),
//   4) décider pour chaque billet : VRAI / FAUX / INCERTAIN.
// Ce fichier ne touche ni à la caméra ni à l'affichage : il est donc
// testable tout seul (par exemple avec Node.js).
// =====================================================================

(function (global) {
  "use strict";

  // Réglages par défaut (modifiables depuis app.js / l'interface)
  const REGLAGES = {
    imgsz: 960,        // taille d'entrée du modèle (celle de l'entraînement)
    confMin: 0.25,     // en dessous : la boîte est ignorée (bruit)
    seuil: 0.5,        // au-dessus : décision VRAI/FAUX ; entre confMin et seuil : INCERTAIN
    iou: 0.5,          // recouvrement au-delà duquel deux boîtes sont des doublons
    rivalMin: 0.30,    // si le modèle hésite (VRAI et FAUX tous deux >= rivalMin) : INCERTAIN
  };

  // ---------------------------------------------------------------
  // 1) PRÉTRAITEMENT : image -> tenseur Float32 [1, 3, 960, 960]
  // "Letterbox" : on réduit l'image sans la déformer et on complète
  // avec du gris (114), exactement comme Ultralytics à l'entraînement.
  // ---------------------------------------------------------------
  function calculerLetterbox(largeur, hauteur, imgsz) {
    const r = Math.min(imgsz / largeur, imgsz / hauteur);   // facteur d'échelle
    const nw = Math.round(largeur * r), nh = Math.round(hauteur * r);
    const dx = Math.floor((imgsz - nw) / 2), dy = Math.floor((imgsz - nh) / 2);
    return { r, nw, nh, dx, dy };
  }

  // rgba : Uint8ClampedArray (ImageData.data) de taille imgsz*imgsz*4
  // sortie : Float32Array au format CHW (tous les R, puis tous les G, puis tous les B), valeurs 0..1
  function rgbaVersTenseur(rgba, imgsz, sortie) {
    const n = imgsz * imgsz;
    const t = sortie || new Float32Array(3 * n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      t[i] = rgba[p] / 255;             // R
      t[i + n] = rgba[p + 1] / 255;     // G
      t[i + 2 * n] = rgba[p + 2] / 255; // B
    }
    return t;
  }

  // ---------------------------------------------------------------
  // 2) + 3) POST-TRAITEMENT
  // Sortie du modèle : [1, 4 + nbClasses, nbAncres] (ici [1, 15, 18900])
  //   lignes 0..3 = cx, cy, w, h (en pixels de l'image 960x960)
  //   lignes 4..  = score de chaque classe (déjà entre 0 et 1)
  // ---------------------------------------------------------------
  function iou(a, b) {
    const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
    const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
    return union > 0 ? inter / union : 0;
  }

  // Suppression des doublons (NMS).
  // parClasse = true : on ne compare que des boîtes de même classe.
  // Pour les billets (parClasse = false), une boîte VRAI et une boîte FAUX
  // au même endroit sont des doublons : on garde la meilleure mais on
  // retient le score de l'autre ("rival") pour détecter l'hésitation.
  function nms(boites, seuilIou, parClasse) {
    boites.sort((a, b) => b.score - a.score);
    const gardees = [];
    const supprimee = new Uint8Array(boites.length);
    for (let i = 0; i < boites.length; i++) {
      if (supprimee[i]) continue;
      const a = boites[i];
      gardees.push(a);
      for (let j = i + 1; j < boites.length; j++) {
        if (supprimee[j]) continue;
        const b = boites[j];
        if (parClasse && b.classe !== a.classe) continue;
        if (iou(a, b) > seuilIou) {
          supprimee[j] = 1;
          if (b.classe !== a.classe) a.rival = Math.max(a.rival || 0, b.score);
        }
      }
    }
    return gardees;
  }

  // noms : liste des noms de classes (classes.json)
  // lb   : résultat de calculerLetterbox (pour revenir aux coordonnées d'origine)
  function posttraiter(donnees, dims, noms, lb, reglages) {
    const R = Object.assign({}, REGLAGES, reglages || {});
    const nbLignes = dims[1], nbAncres = dims[2];
    const nbClasses = nbLignes - 4;
    if (nbClasses !== noms.length) {
      throw new Error(`Le modèle a ${nbClasses} classes mais classes.json en contient ${noms.length}.`);
    }
    const iFaux = noms.indexOf("FAUX"), iVrai = noms.indexOf("VRAI");
    const estBillet = (c) => c === iFaux || c === iVrai;
    const lire = (ligne, a) => donnees[ligne * nbAncres + a];

    const billets = [], elements = [];
    for (let a = 0; a < nbAncres; a++) {
      // Meilleure classe "billet" et meilleure classe "élément de sécurité" pour cette ancre
      const sF = iFaux >= 0 ? lire(4 + iFaux, a) : 0;
      const sV = iVrai >= 0 ? lire(4 + iVrai, a) : 0;
      let meilleurElt = -1, scoreElt = 0;
      for (let c = 0; c < nbClasses; c++) {
        if (estBillet(c)) continue;
        const s = lire(4 + c, a);
        if (s > scoreElt) { scoreElt = s; meilleurElt = c; }
      }
      const sB = Math.max(sF, sV);
      if (sB < R.confMin && scoreElt < R.confMin) continue;

      // Conversion cx,cy,w,h (espace 960) -> x1,y1,x2,y2 (espace image d'origine)
      const cx = lire(0, a), cy = lire(1, a), w = lire(2, a), h = lire(3, a);
      const coords = {
        x1: (cx - w / 2 - lb.dx) / lb.r, y1: (cy - h / 2 - lb.dy) / lb.r,
        x2: (cx + w / 2 - lb.dx) / lb.r, y2: (cy + h / 2 - lb.dy) / lb.r,
      };
      if (sB >= R.confMin) {
        const classe = sF >= sV ? iFaux : iVrai;
        billets.push(Object.assign({ classe, nom: noms[classe], score: sB, rival: Math.min(sF, sV) }, coords));
      }
      if (scoreElt >= R.confMin) {
        elements.push(Object.assign({ classe: meilleurElt, nom: noms[meilleurElt], score: scoreElt }, coords));
      }
    }

    const billetsGardes = nms(billets, R.iou, false);
    const elementsGardes = nms(elements, R.iou, true);
    billetsGardes.forEach((b) => decider(b, elementsGardes, R));
    return { billets: billetsGardes, elements: elementsGardes };
  }

  // ---------------------------------------------------------------
  // 4) DÉCISION pour un billet (prudente : dans le doute -> INCERTAIN)
  // ---------------------------------------------------------------
  function decider(b, elements, R) {
    if (b.score < R.seuil) {
      b.verdict = "INCERTAIN"; b.raison = "confiance faible";
    } else if ((b.rival || 0) >= R.rivalMin) {
      b.verdict = "INCERTAIN"; b.raison = "hésitation VRAI/FAUX";
    } else if (b.nom === "FAUX") {
      b.verdict = "FAUX"; b.raison = "";
    } else {
      // Billet jugé VRAI : on vérifie qu'aucun élément "faux" (_F) n'est détecté dedans
      const suspects = elements.filter((e) => /_F$/.test(e.nom) && e.score >= R.seuil &&
        (e.x1 + e.x2) / 2 > b.x1 && (e.x1 + e.x2) / 2 < b.x2 &&
        (e.y1 + e.y2) / 2 > b.y1 && (e.y1 + e.y2) / 2 < b.y2);
      if (suspects.length) {
        b.verdict = "INCERTAIN"; b.raison = "élément suspect : " + suspects[0].nom;
      } else {
        b.verdict = "VRAI"; b.raison = "";
      }
    }
    return b;
  }

  // Verdict global affiché dans le bandeau : le plus grave l'emporte
  function verdictGlobal(billets) {
    if (!billets.length) return "AUCUN";
    if (billets.some((b) => b.verdict === "FAUX")) return "FAUX";
    if (billets.some((b) => b.verdict === "INCERTAIN")) return "INCERTAIN";
    return "VRAI";
  }

  const API = { REGLAGES, calculerLetterbox, rgbaVersTenseur, posttraiter, verdictGlobal, iou, nms };
  if (typeof module !== "undefined" && module.exports) module.exports = API; // Node (tests)
  global.Detection = API;                                                     // navigateur
})(typeof window !== "undefined" ? window : globalThis);
