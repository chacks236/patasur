// =====================================================================
// app.js — Interface « application mobile » de PATASUR.
// Flux : caméra / photo -> letterbox 960 -> modèle ONNX -> seuil + NMS
//        -> décision (detection.js) -> score par critère -> résultat
// =====================================================================
"use strict";

const D = window.Detection;
const CHEMIN_MODELE = "model/best.onnx";
const CHEMIN_CLASSES = "model/classes.json";
// En ligne, le modèle est servi en 3 morceaux (< 20 Mo chacun) par le CDN jsDelivr,
// bien plus rapide que GitHub Pages sur les réseaux mobiles. Le lien est figé sur
// le commit qui contient les morceaux (contenu immuable, mis en cache longtemps).
const MORCEAUX_MODELE = [0, 1, 2].map((i) => `model/parts/best.onnx.part${i}`);
const CDN_MODELE = "https://cdn.jsdelivr.net/gh/chacks236/patasur@b3095a16925844b0260109caec112e1ed94893f8/";
const EN_LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(location.hostname);
const CLE_REGLAGES = "patasur.reglages";
const CLE_HIST = "patasur.historique";
const MAX_HIST = 40;

// Couleurs (identiques à style.css)
const COULEURS = { VRAI: "#1f9d55", FAUX: "#d93636", INCERTAIN: "#e88a00" };
const GRAVITE = { AUCUN: 0, VRAI: 1, INCERTAIN: 2, FAUX: 3 };

// Critères de sécurité reconnus par le modèle (classes XXX_V / XXX_F de classes.json)
const CRITERES = [
  { cle: "FIL_SECU", nom: "Fil de sécurité", court: "Fil sécu", desc: "Position, continuité et aspect du fil", ic: "🧵" },
  { cle: "MOTIF_3D", nom: "Motif 3D", court: "Motif 3D", desc: "Présence et effet visuel du motif en relief", ic: "✨" },
  { cle: "NUM_SERIE", nom: "Numéro de série", court: "N° série", desc: "Format et netteté de la numérotation", ic: "🔢" },
  { cle: "NUM_SERIE_ITA", nom: "Numéro de série italique", court: "N° italique", desc: "Second numéro, en caractères inclinés", ic: "🔡" },
  { cle: "VALEUR", nom: "Valeur faciale", court: "Valeur", desc: "Présence et netteté du chiffre de la valeur", ic: "💵" },
];
// Critères prévus dans les prochaines versions (dossier de projet)
const CRITERES_FUTURS = [
  { nom: "Filigrane", desc: "Présence, forme et contraste à contre-jour", ic: "💧" },
  { nom: "Encre à variation optique", desc: "Changement de couleur selon l'inclinaison", ic: "🌈" },
  { nom: "Micro-impression", desc: "Netteté des micro-textes", ic: "🔍" },
  { nom: "Impression en relief", desc: "Texture et épaisseur des traits", ic: "✋" },
  { nom: "Repérage recto-verso", desc: "Alignement des motifs par transparence", ic: "🔄" },
];
const ETATS = {
  conforme: { lib: "Conforme", sym: "✓" },
  peu_net: { lib: "Détecté, peu net", sym: "~" },
  douteux: { lib: "Douteux", sym: "!" },
  suspect: { lib: "Suspect", sym: "✕" },
  absent: { lib: "Non visible", sym: "–" },
};

// ---------------------------------------------------------------
// Outils
// ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const pct = (x) => Math.round(x * 100) + " %";

const stock = {
  lire(cle, defaut) {
    try { const v = localStorage.getItem(cle); return v ? JSON.parse(v) : defaut; } catch (e) { return defaut; }
  },
  ecrire(cle, val) {
    try { localStorage.setItem(cle, JSON.stringify(val)); return true; } catch (e) { return false; }
  },
};

let minuteurToast = 0;
function toast(texte, duree = 2600) {
  const t = $("toast");
  t.textContent = texte;
  t.classList.add("visible");
  clearTimeout(minuteurToast);
  minuteurToast = setTimeout(() => t.classList.remove("visible"), duree);
}

function confirmer(titre, texte, oui = "Confirmer") {
  return new Promise((resoudre) => {
    $("dlgTitre").textContent = titre;
    $("dlgTexte").textContent = texte;
    $("dlgOui").textContent = oui;
    $("dialogue").classList.remove("cache");
    const fin = (r) => { $("dialogue").classList.add("cache"); resoudre(r); };
    $("dlgOui").onclick = () => fin(true);
    $("dlgNon").onclick = () => fin(false);
  });
}

function afficherErreur(e) {
  console.error(e);
  toast("Erreur : " + (e.message || e), 6000);
}

// ---------------------------------------------------------------
// Réglages (enregistrés sur l'appareil)
// ---------------------------------------------------------------
const reglages = Object.assign({ seuil: 0.5, voix: true, vocal: false, vibre: true }, stock.lire(CLE_REGLAGES, {}));
const sauverReglages = () => stock.ecrire(CLE_REGLAGES, reglages);

// ---------------------------------------------------------------
// État de l'application
// ---------------------------------------------------------------
const video = $("video"), calque = $("calque"), ctxCalque = calque.getContext("2d");
let session = null;          // modèle ONNX chargé
let NOMS = [];               // noms des classes
let IMGSZ = 960;             // taille d'entrée du modèle
let modelePret = false, erreurModele = null, progression = 0;
let flux = null;             // flux de la caméra
let enCours = false;         // boucle temps réel active ?
let facing = "environment";  // caméra arrière par défaut
let fpsMoyen = 0, tDernier = 0;
let modeScan = "direct";     // "direct" (1 face) ou "rv" (recto + verso)
let captures = [];           // analyses en attente d'affichage
let occupe = false;          // capture en cours
let entreeCourante = null;   // résultat affiché (pour le signalement)

// Canvas invisible qui sert à fabriquer l'image 960x960 pour le modèle
const prep = document.createElement("canvas");
const ctxPrep = prep.getContext("2d", { willReadFrequently: true });
let tampon = null;

// ---------------------------------------------------------------
// 1) CHARGEMENT DU MODÈLE
// ---------------------------------------------------------------
function majChargement(p, texte) {
  if (p != null) progression = p;
  $("splashBarre").style.width = Math.max(3, progression) + "%";
  if (texte) $("splashTexte").textContent = texte;
  if (!modelePret && !erreurModele) $("etatModele").querySelector("b").textContent = `Chargement ${Math.round(progression)} %`;
}

// Télécharge plusieurs fichiers en parallèle avec une progression commune,
// puis les met bout à bout (un seul fichier = cas simple).
async function telechargerAvecProgression(urls) {
  const reps = await Promise.all(urls.map(async (url) => {
    const rep = await fetch(url);
    if (!rep.ok) throw new Error(`Fichier introuvable : ${url} (code ${rep.status})`);
    return rep;
  }));
  const tailles = reps.map((r) => +r.headers.get("Content-Length") || 0);
  const total = tailles.every((t) => t) ? tailles.reduce((a, b) => a + b, 0) : 0;
  let recu = 0;
  const parties = await Promise.all(reps.map(async (rep) => {
    const lecteur = rep.body.getReader();
    const morceaux = [];
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      morceaux.push(value); recu += value.length;
      if (total) majChargement(5 + (80 * recu) / total, `Téléchargement du modèle d'IA… ${Math.round((100 * recu) / total)} %`);
    }
    return morceaux;
  }));
  const octets = new Uint8Array(recu);
  let pos = 0;
  for (const morceaux of parties) for (const m of morceaux) { octets.set(m, pos); pos += m.length; }
  return octets;
}

// En local : fichier entier (rapide). En ligne : morceaux via jsDelivr, sinon depuis le site.
async function telechargerModele() {
  if (EN_LOCAL) return telechargerAvecProgression([CHEMIN_MODELE]);
  try {
    return await telechargerAvecProgression(MORCEAUX_MODELE.map((m) => CDN_MODELE + m));
  } catch (e) {
    console.warn("CDN indisponible, téléchargement depuis le site :", e);
    return telechargerAvecProgression(MORCEAUX_MODELE);
  }
}

async function chargerModele() {
  if (location.protocol === "file:") {
    throw new Error("Ouvre la page via le serveur (lancer_serveur.bat → http://localhost:8000), pas en double-cliquant sur index.html.");
  }
  if (typeof ort === "undefined") {
    throw new Error("Moteur d'IA non chargé : vérifie la connexion Internet (cdn.jsdelivr.net).");
  }
  majChargement(2, "Lecture de la configuration…");
  const cfg = await (await fetch(CHEMIN_CLASSES)).json();
  NOMS = cfg.classes; IMGSZ = cfg.imgsz || 960;
  if (cfg.seuil_conseille && stock.lire(CLE_REGLAGES, null) == null) reglages.seuil = cfg.seuil_conseille;
  prep.width = prep.height = IMGSZ;
  tampon = new Float32Array(3 * IMGSZ * IMGSZ);

  const octets = await telechargerModele();
  majChargement(88, "Préparation du modèle…");

  // Fichiers WebAssembly d'ONNX Runtime depuis le même CDN que le script
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
  // Plusieurs threads seulement si la page le permet (sinon 1)
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

  // On essaie d'abord la carte graphique (WebGPU), sinon le processeur (WASM)
  let moteur = "CPU (wasm)";
  if (navigator.gpu) {
    try {
      session = await ort.InferenceSession.create(octets, { executionProviders: ["webgpu"], graphOptimizationLevel: "all" });
      moteur = "GPU (WebGPU)";
    } catch (e) {
      console.warn("WebGPU indisponible, passage au CPU :", e);
      session = null;
    }
  }
  if (!session) {
    session = await ort.InferenceSession.create(octets, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
  }
  $("moteur").textContent = moteur;

  // Premier passage "à vide" : la 1re inférence est toujours lente (compilation)
  majChargement(95, "Préchauffage du modèle…");
  await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", tampon, [1, 3, IMGSZ, IMGSZ]) });
  majChargement(100, "Prêt");
}

// ---------------------------------------------------------------
// 2) INFÉRENCE sur une source (vidéo, image ou canvas)
// Les appels sont mis en file : le modèle ne traite qu'une image à la fois.
// ---------------------------------------------------------------
let fileInference = Promise.resolve();
function inferer(source, largeur, hauteur) {
  const p = fileInference.then(() => infererMaintenant(source, largeur, hauteur));
  fileInference = p.catch(() => {});
  return p;
}

async function infererMaintenant(source, largeur, hauteur) {
  const lb = D.calculerLetterbox(largeur, hauteur, IMGSZ);
  ctxPrep.fillStyle = "rgb(114,114,114)";
  ctxPrep.fillRect(0, 0, IMGSZ, IMGSZ);
  ctxPrep.drawImage(source, 0, 0, largeur, hauteur, lb.dx, lb.dy, lb.nw, lb.nh);
  const rgba = ctxPrep.getImageData(0, 0, IMGSZ, IMGSZ).data;
  D.rgbaVersTenseur(rgba, IMGSZ, tampon);

  const t0 = performance.now();
  const sorties = await session.run({
    [session.inputNames[0]]: new ort.Tensor("float32", tampon, [1, 3, IMGSZ, IMGSZ]),
  });
  const ms = performance.now() - t0;
  const sortie = sorties[session.outputNames[0]];
  const res = D.posttraiter(sortie.data, sortie.dims, NOMS, lb, { seuil: reglages.seuil });
  $("ms").textContent = Math.round(ms);
  return { res, ms };
}

// ---------------------------------------------------------------
// 3) INTERPRÉTATION : billet principal + score par critère
// ---------------------------------------------------------------
const infoCritere = (nomClasse) => CRITERES.find((c) => nomClasse.replace(/_[VF]$/, "") === c.cle);

// Billet retenu : le verdict le plus grave, puis la meilleure confiance
function billetPrincipal(res) {
  return res.billets.slice().sort((a, b) => GRAVITE[b.verdict] - GRAVITE[a.verdict] || b.score - a.score)[0] || null;
}

// Pour chaque critère : p = conformité estimée (0..1), d'après les éléments détectés DANS le billet
//   élément _V détecté -> p = sa confiance (« peu net » sous le seuil)
//   élément _F détecté -> p = 1 - sa confiance (« douteux », puis « suspect » au-dessus du seuil)
function analyserCriteres(res, billet) {
  const dans = (e) => {
    if (!billet) return true;
    const cx = (e.x1 + e.x2) / 2, cy = (e.y1 + e.y2) / 2;
    return cx > billet.x1 && cx < billet.x2 && cy > billet.y1 && cy < billet.y2;
  };
  return CRITERES.map((c) => {
    let v = 0, f = 0;
    for (const e of res.elements) {
      if (!dans(e)) continue;
      if (e.nom === c.cle + "_V") v = Math.max(v, e.score);
      else if (e.nom === c.cle + "_F") f = Math.max(f, e.score);
    }
    if (!v && !f) return { cle: c.cle, etat: "absent", p: null };
    if (f > v) return { cle: c.cle, etat: f >= reglages.seuil ? "suspect" : "douteux", p: 1 - f };
    return { cle: c.cle, etat: v >= reglages.seuil ? "conforme" : "peu_net", p: v };
  });
}

// Score pondéré S = Σ wi·pi sur les critères visibles (poids égaux dans ce prototype)
function scorePondere(crit) {
  const vus = crit.filter((c) => c.p != null);
  if (!vus.length) return null;
  const w = 1 / vus.length;
  return vus.reduce((s, c) => s + w * c.p, 0);
}

// Raison lisible (detection.js renvoie par ex. « élément suspect : FIL_SECU_F »)
function raisonLisible(raison) {
  if (!raison) return "";
  return raison.replace(/[A-Z0-9_]+_[VF]\b/g, (n) => (infoCritere(n) || { nom: n }).nom.toLowerCase());
}

// Fusion recto + verso : le verdict le plus grave l'emporte, et pour chaque
// critère on garde la face la moins conforme (prudence).
function fusionner(caps) {
  const pire = caps.slice().sort((a, b) => GRAVITE[b.verdict] - GRAVITE[a.verdict] || (b.billet ? b.billet.score : 0) - (a.billet ? a.billet.score : 0))[0];
  const crit = CRITERES.map((c, i) => {
    const vus = caps.map((k) => k.crit[i]).filter((x) => x.p != null);
    return vus.length ? vus.sort((a, b) => a.p - b.p)[0] : caps[0].crit[i];
  });
  return {
    verdict: pire.verdict,
    score: pire.billet ? pire.billet.score : null,
    raison: pire.billet ? pire.billet.raison : "",
    crit,
    S: scorePondere(crit),
  };
}

// ---------------------------------------------------------------
// 4) DESSIN des boîtes (coordonnées dans l'image d'origine)
// ---------------------------------------------------------------
function etiquette(c, texte, x, y, couleur, taille) {
  c.font = `bold ${taille}px system-ui, sans-serif`;
  const l = c.measureText(texte).width + 12, h = taille + 10;
  const yh = y - h < 0 ? y : y - h;   // au-dessus de la boîte, sinon dedans
  c.fillStyle = couleur;
  c.beginPath();
  if (c.roundRect) c.roundRect(x, yh, l, h, h / 3); else c.rect(x, yh, l, h);
  c.fill();
  c.fillStyle = "#fff";
  c.fillText(texte, x + 6, yh + taille + 2);
}

function dessinerDetections(c, res, w, h) {
  const base = Math.min(w, h);
  const epais = Math.max(3, Math.round(base / 150));
  const police = Math.max(16, Math.round(base / 24));

  // Éléments de sécurité : traits fins en pointillés (au-dessus du seuil)
  c.setLineDash([8, 6]);
  for (const e of res.elements) {
    if (e.score < reglages.seuil) continue;
    const faux = /_F$/.test(e.nom);
    const col = faux ? COULEURS.FAUX : COULEURS.VRAI;
    const info = infoCritere(e.nom);
    c.strokeStyle = col; c.lineWidth = Math.max(2, epais / 2);
    c.strokeRect(e.x1, e.y1, e.x2 - e.x1, e.y2 - e.y1);
    etiquette(c, `${info ? info.court : e.nom} ${faux ? "✕" : "✓"} ${Math.round(e.score * 100)}%`, e.x1, e.y1, col, Math.round(police * 0.6));
  }
  c.setLineDash([]);

  // Billets : cadre épais coloré selon le verdict
  for (const b of res.billets) {
    const col = COULEURS[b.verdict];
    c.strokeStyle = col; c.lineWidth = epais;
    c.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
    etiquette(c, `${b.verdict} ${Math.round(b.score * 100)}%`, b.x1, b.y1, col, police);
  }
}

// Image + boîtes dans un canvas d'affichage (réduit à 1280 px max)
function canvasResultat(source, w, h, res) {
  const k = Math.min(1, 1280 / Math.max(w, h));
  const cv = document.createElement("canvas");
  cv.width = Math.round(w * k); cv.height = Math.round(h * k);
  const c = cv.getContext("2d");
  c.drawImage(source, 0, 0, cv.width, cv.height);
  c.setTransform(k, 0, 0, k, 0, 0);
  dessinerDetections(c, res, w, h);
  return cv;
}

async function analyserSource(source, w, h) {
  const { res } = await inferer(source, w, h);
  const billet = billetPrincipal(res);
  console.table(res.billets.map((b) => ({ verdict: b.verdict, classe: b.nom, score: b.score.toFixed(3), rival: (b.rival || 0).toFixed(3) })));
  return { res, billet, verdict: D.verdictGlobal(res.billets), crit: analyserCriteres(res, billet), canvas: canvasResultat(source, w, h, res) };
}

// ---------------------------------------------------------------
// Analyse animée : le billet s'affiche, un rayon lumineux le balaie
// pendant l'inférence, puis les boîtes et le verdict apparaissent.
// ---------------------------------------------------------------
const ETAPES_ANALYSE = ["Détection du billet…", ...CRITERES.map((c) => c.nom + "…"), "Calcul du verdict…"];
const DUREE_ANALYSE_MIN = 3200;   // ms : durée minimale du balayage
const attendre = (ms) => new Promise((ok) => setTimeout(ok, ms));
const TEXTES_FIN = { VRAI: "✓ Vrai billet", FAUX: "✕ Faux billet", INCERTAIN: "! Résultat incertain", AUCUN: "Aucun billet détecté" };

async function analyserAvecAnimation(source, w, h, libelle) {
  const zone = $("analyse"), cv = $("analyseImage");
  const k = Math.min(1, 900 / Math.max(w, h));
  cv.width = Math.round(w * k); cv.height = Math.round(h * k);
  cv.getContext("2d").drawImage(source, 0, 0, cv.width, cv.height);
  $("analyseFace").textContent = libelle;
  $("analyseListe").innerHTML = ["Billet", ...CRITERES.map((c) => c.nom)].map((n) => `<li><i></i>${n}</li>`).join("");
  const items = Array.from($("analyseListe").children);
  zone.className = "analyse";

  let i = 0;
  const majEtape = () => {
    $("analyseEtape").textContent = ETAPES_ANALYSE[i];
    $("analyseProg").style.width = Math.round((95 * (i + 1)) / ETAPES_ANALYSE.length) + "%";
    items.forEach((li, j) => { li.className = j < i ? "fait" : j === i ? "encours" : ""; });
  };
  majEtape();
  const minuteur = setInterval(() => { if (i < ETAPES_ANALYSE.length - 1) { i++; majEtape(); } }, DUREE_ANALYSE_MIN / ETAPES_ANALYSE.length);
  const debut = performance.now();
  try {
    // Le rayon balaie d'abord le billet à l'écran : sans carte graphique (CPU),
    // le calcul du modèle bloque l'affichage pendant qu'il tourne.
    await attendre(1000);
    const cap = await analyserSource(source, w, h);
    const reste = DUREE_ANALYSE_MIN - (performance.now() - debut);
    if (reste > 0) await attendre(reste);
    clearInterval(minuteur);
    // Fin : image annotée, cadre de la couleur du verdict
    items.forEach((li) => { li.className = "fait"; });
    $("analyseProg").style.width = "100%";
    cv.width = cap.canvas.width; cv.height = cap.canvas.height;
    cv.getContext("2d").drawImage(cap.canvas, 0, 0);
    zone.className = "analyse fini " + cap.verdict.toLowerCase();
    $("analyseEtape").textContent = TEXTES_FIN[cap.verdict];
    await attendre(1100);
    return cap;
  } finally {
    clearInterval(minuteur);
  }
}
const masquerAnalyse = () => $("analyse").classList.add("cache");
const libelleFace = () => (modeScan === "rv" ? (captures.length ? "Verso du billet" : "Recto du billet") : "Analyse du billet");

// ---------------------------------------------------------------
// 5) VOIX et VIBRATION
// ---------------------------------------------------------------
function phraseVerdict(verdict, score) {
  return {
    VRAI: "Vrai billet",
    FAUX: "Faux billet",
    INCERTAIN: "Incertain",
    AUCUN: "Aucun billet",
  }[verdict];
}

function parler(texte, force) {
  if ((!force && !reglages.voix) || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(texte);
  u.lang = "fr-FR";
  u.rate = 1.15;
  // Voix française installée sur l'appareil en priorité : les voix « en ligne » répondent plus lentement
  const fr = speechSynthesis.getVoices().filter((v) => /^fr/i.test(v.lang));
  const voix = fr.find((v) => v.localService) || fr[0];
  if (voix) u.voice = voix;
  speechSynthesis.speak(u);
}

function vibrer(verdict) {
  if (!reglages.vibre || !navigator.vibrate) return;
  if (verdict === "FAUX") navigator.vibrate([300, 120, 300]);
  else if (verdict === "INCERTAIN") navigator.vibrate(150);
}

// ---------------------------------------------------------------
// 6) NAVIGATION : onglets + écrans superposés (bouton Retour Android)
// ---------------------------------------------------------------
function allerOnglet(nom) {
  $$(".ecran").forEach((e) => e.classList.toggle("actif", e.id === "ecran-" + nom));
  $$(".navigation button").forEach((b) => b.classList.toggle("actif", b.dataset.onglet === nom));
  if (nom === "historique") rendreHistorique();
  if (nom === "tableau") rendreTableau();
}

const pileCalques = [];
function fermerEffet(id) {
  if (id === "camera") arreterCamera();
  if (id === "resultat" && "speechSynthesis" in window) speechSynthesis.cancel();
}
// remplacer = true : le nouvel écran prend la place de celui du dessus (ex. caméra -> résultat)
function ouvrir(id, remplacer) {
  if (remplacer && pileCalques.length) {
    const ancien = pileCalques.pop();
    $(ancien).classList.add("cache");
    fermerEffet(ancien);
    history.replaceState({ calque: id }, "");
  } else {
    history.pushState({ calque: id }, "");
  }
  pileCalques.push(id);
  $(id).classList.remove("cache");
  if (id === "resultat") $(id).scrollTop = 0;
}
function fermerHaut() { if (pileCalques.length) history.back(); }
window.addEventListener("popstate", () => {
  const id = pileCalques.pop();
  if (!id) return;
  $(id).classList.add("cache");
  fermerEffet(id);
});

function verifierPret() {
  if (modelePret) return true;
  if (erreurModele) toast("Le modèle n'a pas pu être chargé : " + erreurModele.message, 5000);
  else toast(`Le modèle d'IA se charge encore (${Math.round(progression)} %)…`);
  return false;
}

// ---------------------------------------------------------------
// 7) CAMÉRA et BOUCLE TEMPS RÉEL
// ---------------------------------------------------------------
async function demarrerCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices) {
    throw new Error("La caméra exige HTTPS (ou http://localhost). Sur téléphone, suis la section « Tester sur le téléphone » du README.");
  }
  if (flux) flux.getTracks().forEach((t) => t.stop());
  flux = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = flux;
  await video.play();
  enCours = true; tDernier = 0; fpsMoyen = 0;
  annonce.derniere = null; annonce.candidat = null; annonce.nb = 0;
  requestAnimationFrame(boucle);
}

function arreterCamera() {
  enCours = false;
  if (flux) flux.getTracks().forEach((t) => t.stop());
  flux = null;
  video.srcObject = null;
}

const TEXTES_PILLULE = {
  AUCUN: "Recherche d'un billet…",
  VRAI: "✓ Billet authentique",
  FAUX: "✕ Billet suspect",
  INCERTAIN: "! Incertain : rapprochez-vous",
};
// Mode malvoyant : on annonce un verdict quand il est stable sur plusieurs images
const annonce = { derniere: null, candidat: null, nb: 0 };

async function boucle() {
  if (!enCours) return;
  try {
    if (video.readyState >= 2 && video.videoWidth && !occupe) {
      const w = video.videoWidth, h = video.videoHeight;
      const { res } = await inferer(video, w, h);
      if (!enCours) return;
      if (calque.width !== w || calque.height !== h) { calque.width = w; calque.height = h; }
      ctxCalque.clearRect(0, 0, w, h);
      dessinerDetections(ctxCalque, res, w, h);

      const v = D.verdictGlobal(res.billets);
      const p = $("pillule");
      p.className = "pillule " + v.toLowerCase();
      p.textContent = TEXTES_PILLULE[v];
      majFps();
      annoncerSiStable(v, billetPrincipal(res));
    }
  } catch (e) {
    afficherErreur(e); fermerHaut(); return;
  }
  requestAnimationFrame(boucle);   // image suivante dès que la précédente est traitée
}

function annoncerSiStable(v, billet) {
  if (!reglages.vocal) return;
  if (v === annonce.candidat) annonce.nb++; else { annonce.candidat = v; annonce.nb = 1; }
  if (annonce.nb !== 4) return;
  if (v === "AUCUN") { annonce.derniere = null; return; }   // billet retiré : on réannoncera le suivant
  if (v !== annonce.derniere) {
    annonce.derniere = v;
    parler(phraseVerdict(v, billet && billet.score), true);
    vibrer(v);
  }
}

function majFps() {
  const t = performance.now();
  if (tDernier) {
    const fps = 1000 / (t - tDernier);
    fpsMoyen = fpsMoyen ? 0.9 * fpsMoyen + 0.1 * fps : fps;   // moyenne lissée
    $("fps").textContent = fpsMoyen.toFixed(1);
  }
  tDernier = t;
}

function majConsigne() {
  const rv = modeScan === "rv";
  $("etapesRV").classList.toggle("visible", rv);
  const [r, v] = $("etapesRV").children;
  r.className = captures.length ? "fait" : "actif";
  v.className = captures.length ? "actif" : "";
  $("consigne").textContent = !rv
    ? "Cadrez le billet puis touchez le bouton pour analyser"
    : captures.length ? "Retournez le billet : cadrez le VERSO" : "Cadrez le RECTO (face avant) du billet";
}

async function lancerCamera(rv) {
  if (!verifierPret()) return;
  modeScan = rv ? "rv" : "direct";
  captures = [];
  majConsigne();
  $("pillule").className = "pillule aucun";
  $("pillule").textContent = TEXTES_PILLULE.AUCUN;
  ctxCalque.clearRect(0, 0, calque.width, calque.height);
  ouvrir("camera", pileCalques[pileCalques.length - 1] === "resultat");
  try { await demarrerCamera(); } catch (e) { afficherErreur(e); fermerHaut(); }
}

// Après chaque analyse : on attend le verso, ou on affiche le résultat
function apresCapture() {
  if (modeScan === "rv" && captures.length < 2) {
    majConsigne();
    toast("Recto analysé ✓  Retournez le billet");
    if (reglages.vocal) parler("Retournez le billet", true);
    return;
  }
  afficherResultat(captures);
  captures = [];
}

async function capturer() {
  if (occupe || !video.videoWidth) return;
  occupe = true;
  $("btnCapture").classList.add("occupe");
  try {
    const cv = document.createElement("canvas");
    cv.width = video.videoWidth; cv.height = video.videoHeight;
    cv.getContext("2d").drawImage(video, 0, 0);
    captures.push(await analyserAvecAnimation(cv, cv.width, cv.height, libelleFace()));
    apresCapture();
  } catch (e) { afficherErreur(e); }
  finally { masquerAnalyse(); occupe = false; $("btnCapture").classList.remove("occupe"); }
}

// ---------------------------------------------------------------
// 8) PHOTOS DE LA GALERIE
// ---------------------------------------------------------------
function chargerImage(fichier) {
  return new Promise((ok, ko) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => ko(new Error("Image illisible : " + fichier.name));
    img.src = URL.createObjectURL(fichier);
  });
}

function ouvrirGalerie(depuisAccueil) {
  if (!verifierPret()) return;
  if (depuisAccueil) { modeScan = "direct"; captures = []; }
  // Recto + verso : on peut choisir les deux photos d'un coup
  $("inputPhoto").multiple = modeScan === "rv" && captures.length === 0;
  $("inputPhoto").click();
}

$("inputPhoto").onchange = async () => {
  const fichiers = Array.from($("inputPhoto").files).slice(0, 2);
  $("inputPhoto").value = "";
  if (!fichiers.length) return;
  occupe = true;   // met en pause l'analyse en direct si la caméra est ouverte
  try {
    for (const f of fichiers) {
      const img = await chargerImage(f);
      captures.push(await analyserAvecAnimation(img, img.naturalWidth, img.naturalHeight, libelleFace()));
      URL.revokeObjectURL(img.src);
    }
    apresCapture();
  } catch (e) { afficherErreur(e); }
  finally { masquerAnalyse(); occupe = false; }
};

// ---------------------------------------------------------------
// 9) ÉCRAN RÉSULTAT
// ---------------------------------------------------------------
const TEXTES_VERDICT = {
  VRAI: { titre: "Billet authentique", sous: (d) => `Aucun élément suspect détecté. Confiance du modèle : ${pct(d.score)}.` },
  FAUX: { titre: "Billet suspect", sous: () => "Le modèle juge ce billet faux. Ne l'acceptez pas et faites-le vérifier en banque." },
  INCERTAIN: { titre: "Résultat incertain", sous: (d) => `${d.raison ? "Raison : " + raisonLisible(d.raison) + ". " : ""}Reprenez la photo avec plus de lumière, billet à plat.` },
  AUCUN: { titre: "Aucun billet détecté", sous: () => "Cadrez le billet en entier, plus près, avec un bon éclairage." },
};

function vignette(canvas) {
  const k = 240 / Math.max(canvas.width, canvas.height);
  const v = document.createElement("canvas");
  v.width = Math.round(canvas.width * k); v.height = Math.round(canvas.height * k);
  v.getContext("2d").drawImage(canvas, 0, 0, v.width, v.height);
  return v.toDataURL("image/jpeg", 0.7);
}

function afficherResultat(caps) {
  const d = fusionner(caps);
  const entree = {
    id: Date.now(),
    date: new Date().toISOString(),
    faces: caps.length,
    verdict: d.verdict, score: d.score, raison: d.raison, S: d.S,
    crit: d.crit.map(({ cle, etat, p }) => ({ cle, etat, p })),
    vignette: vignette(caps[0].canvas),
    signale: false,
  };
  if (d.verdict !== "AUCUN") ajouterHistorique(entree);
  const legendes = caps.length === 2 ? ["Recto", "Verso"] : [""];
  rendreResultat(entree, caps.map((k, i) => ({ canvas: k.canvas, legende: legendes[i] })));
  ouvrir("resultat", pileCalques[pileCalques.length - 1] === "camera");
  parler(phraseVerdict(d.verdict, d.score));
  vibrer(d.verdict);
}

function rendreResultat(entree, images) {
  entreeCourante = entree;
  const v = entree.verdict;
  $("carteVerdict").className = "carte-verdict " + v.toLowerCase();
  $("titreVerdict").textContent = TEXTES_VERDICT[v].titre;
  $("sousVerdict").textContent = TEXTES_VERDICT[v].sous(entree);
  const val = entree.score != null && v !== "AUCUN" ? Math.round(entree.score * 100) : 0;
  $("txtAnneau").textContent = v === "AUCUN" ? "–" : val + "%";
  $("valAnneau").style.strokeDasharray = "0 100";
  requestAnimationFrame(() => requestAnimationFrame(() => { $("valAnneau").style.strokeDasharray = `${val} 100`; }));

  // Images (avec boîtes) ou vignette enregistrée
  const zone = $("imagesRes");
  zone.innerHTML = "";
  zone.classList.toggle("deux", images.length === 2);
  for (const im of images) {
    const fig = document.createElement("figure");
    let el = im.canvas;
    if (!el) { el = document.createElement("canvas"); const img = new Image(); img.onload = () => { el.width = img.width; el.height = img.height; el.getContext("2d").drawImage(img, 0, 0); }; img.src = im.src; }
    fig.appendChild(el);
    if (im.legende) { const cap = document.createElement("figcaption"); cap.textContent = im.legende; fig.appendChild(cap); }
    zone.appendChild(fig);
  }

  // Critères
  const liste = $("listeCriteres");
  liste.innerHTML = "";
  entree.crit.forEach((c) => {
    const info = CRITERES.find((x) => x.cle === c.cle);
    const li = document.createElement("li");
    li.className = "critere " + c.etat;
    li.innerHTML = `<div class="haut"><span class="etat">${ETATS[c.etat].sym}</span>
      <span class="nom">${info.nom}<small>${ETATS[c.etat].lib} · ${info.desc}</small></span>
      <span class="pct">${c.p == null ? "Non visible" : pct(c.p)}</span></div>
      ${c.p == null ? "" : '<div class="piste"><span></span></div>'}`;
    liste.appendChild(li);
    const barre = li.querySelector(".piste span");
    if (barre) requestAnimationFrame(() => requestAnimationFrame(() => { barre.style.width = Math.round(c.p * 100) + "%"; }));
  });
  $("txtS").textContent = entree.S == null ? "–" : pct(entree.S);

  const b = $("btnSignaler");
  b.disabled = entree.signale || v === "AUCUN";
  b.textContent = entree.signale ? "✓ Signalé" : "🚩 Signaler";
}

$("btnSignaler").onclick = async () => {
  const e = entreeCourante;
  if (!e || e.signale) return;
  const ok = await confirmer("Signaler ce billet ?",
    "Le verdict, les critères, la date et la zone approximative seraient transmis de façon anonymisée aux autorités monétaires, avec votre accord.\n\nDémonstration : aucune donnée ne quitte cet appareil dans ce prototype.",
    "Signaler");
  if (!ok) return;
  e.signale = true;
  const hist = stock.lire(CLE_HIST, []);
  const h = hist.find((x) => x.id === e.id);
  if (h) { h.signale = true; stock.ecrire(CLE_HIST, hist); }
  $("btnSignaler").disabled = true;
  $("btnSignaler").textContent = "✓ Signalé";
  toast("Signalement enregistré. Merci !");
};

// ---------------------------------------------------------------
// 10) HISTORIQUE et TABLEAU DE BORD
// ---------------------------------------------------------------
function ajouterHistorique(entree) {
  const hist = stock.lire(CLE_HIST, []);
  hist.unshift(entree);
  hist.length = Math.min(hist.length, MAX_HIST);
  // Si la mémoire est pleine, on retire les plus anciens
  while (!stock.ecrire(CLE_HIST, hist) && hist.length > 1) hist.pop();
}

const LIB_VERDICT = { VRAI: "Authentique", FAUX: "Suspect", INCERTAIN: "Incertain", AUCUN: "Aucun billet" };

function rendreHistorique() {
  const hist = stock.lire(CLE_HIST, []);
  const liste = $("listeHistorique");
  liste.innerHTML = "";
  $("videHistorique").classList.toggle("cache", hist.length > 0);
  for (const e of hist) {
    const d = new Date(e.date);
    const btn = document.createElement("button");
    btn.className = "item-hist";
    btn.innerHTML = `<img src="${e.vignette}" alt="">
      <span class="infos"><b>${LIB_VERDICT[e.verdict]}${e.signale ? " · 🚩" : ""}</b>
      <small>${d.toLocaleDateString("fr-FR")} à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · ${e.faces === 2 ? "recto + verso" : "1 face"}</small></span>
      <span class="puce ${e.verdict.toLowerCase()}">${e.score != null ? pct(e.score) : "–"}</span>`;
    btn.onclick = () => { rendreResultat(e, [{ src: e.vignette }]); ouvrir("resultat"); };
    liste.appendChild(btn);
  }
}

function rendreTableau() {
  const hist = stock.lire(CLE_HIST, []);
  const n = (v) => hist.filter((e) => e.verdict === v).length;
  const total = hist.length, faux = n("FAUX"), doute = n("INCERTAIN");
  $("kTotal").textContent = total; $("kFaux").textContent = faux;
  $("kDoute").textContent = doute; $("kVrai").textContent = n("VRAI");
  $("kSignal").textContent = hist.filter((e) => e.signale).length;
  const taux = total ? faux / total : 0;
  $("jaugeFaux").style.width = Math.round(taux * 100) + "%";
  $("txtTaux").textContent = total ? `${pct(taux)} des billets scannés sont jugés faux (${pct(doute / total)} incertains).` : "Aucun scan pour l'instant.";

  const zone = $("barresCriteres");
  zone.innerHTML = "";
  const comptes = CRITERES.map((c) => ({
    nom: c.nom,
    nb: hist.filter((e) => e.crit.some((x) => x.cle === c.cle && (x.etat === "suspect" || x.etat === "douteux"))).length,
  })).sort((a, b) => b.nb - a.nb);
  const max = Math.max(1, ...comptes.map((c) => c.nb));
  for (const c of comptes) {
    const div = document.createElement("div");
    div.className = "barre-ligne";
    div.innerHTML = `<div><span>${c.nom}</span><b>${c.nb}</b></div><div class="piste"><span style="width:${(100 * c.nb) / max}%"></span></div>`;
    zone.appendChild(div);
  }
}

// ---------------------------------------------------------------
// 11) GUIDE
// ---------------------------------------------------------------
function rendreGuide() {
  const zone = $("listeGuide");
  const carte = (c, ia) => `<div class="carte critere-guide${ia ? "" : " futur"}"><span class="ic">${c.ic}</span><div>
    <h4>${c.nom} <span class="tag ${ia ? "ia" : "bientot"}">${ia ? "IA" : "Prochaine version"}</span></h4><p>${c.desc}</p></div></div>`;
  zone.innerHTML = CRITERES.map((c) => carte(c, true)).join("") + CRITERES_FUTURS.map((c) => carte(c, false)).join("");
}

// ---------------------------------------------------------------
// 12) BRANCHEMENT DES BOUTONS
// ---------------------------------------------------------------
const AIDES_MODE = {
  standard: "Analyse visuelle du billet avec un score pour chaque critère de sécurité.",
  vocal: "Pour les personnes malvoyantes : le verdict est annoncé à voix haute pendant le scan.",
};
function choisirMode(mode) {
  reglages.vocal = mode === "vocal";
  if (reglages.vocal) reglages.voix = true;
  sauverReglages();
  synchroniserReglages();
}
function synchroniserReglages() {
  const mode = reglages.vocal ? "vocal" : "standard";
  $$(".tuile[data-mode]").forEach((t) => t.classList.toggle("choisie", t.dataset.mode === mode));
  $("aideMode").textContent = AIDES_MODE[mode];
  $("seuil").value = reglages.seuil;
  $("seuilValeur").textContent = (+reglages.seuil).toFixed(2);
  $("optVoix").checked = reglages.voix;
  $("optVocal").checked = reglages.vocal;
  $("optVibre").checked = reglages.vibre;
}

$$(".navigation button").forEach((b) => (b.onclick = () => allerOnglet(b.dataset.onglet)));
$$(".tuile[data-mode]").forEach((t) => (t.onclick = () => {
  choisirMode(t.dataset.mode);
  if (t.dataset.mode === "vocal") parler("Mode vocal activé", true);
}));
$$("[data-aller]").forEach((b) => (b.onclick = () => allerOnglet(b.dataset.aller)));
$$(".onglets-int button").forEach((b) => (b.onclick = () => {
  $$(".onglets-int button").forEach((x) => x.classList.toggle("actif", x === b));
  $$(".sous").forEach((s) => s.classList.toggle("actif", s.id === "sous-" + b.dataset.sous));
}));

$("btnCameraDirect").onclick = () => lancerCamera(false);
$("btnRectoVerso").onclick = () => lancerCamera(true);
$("btnGalerie").onclick = () => ouvrirGalerie(true);
$("btnGalerieCam").onclick = () => ouvrirGalerie(false);
$("btnCapture").onclick = capturer;
$("btnFermerCam").onclick = fermerHaut;
$("btnRetourner").onclick = async () => {
  facing = facing === "environment" ? "user" : "environment";
  try { await demarrerCamera(); } catch (e) { afficherErreur(e); }
};
$("btnFermerRes").onclick = fermerHaut;
$("btnNouveau").onclick = () => lancerCamera(modeScan === "rv");
$("btnParler").onclick = () => entreeCourante && parler(phraseVerdict(entreeCourante.verdict, entreeCourante.score), true);

$("seuil").oninput = () => {
  reglages.seuil = parseFloat($("seuil").value);
  $("seuilValeur").textContent = reglages.seuil.toFixed(2);
  sauverReglages();
};
$("optVoix").onchange = () => { reglages.voix = $("optVoix").checked; sauverReglages(); };
$("optVocal").onchange = () => { choisirMode($("optVocal").checked ? "vocal" : "standard"); };
$("optVibre").onchange = () => { reglages.vibre = $("optVibre").checked; sauverReglages(); };
$("btnTestVoix").onclick = () => parler("Vrai billet", true);

$("btnEffacer").onclick = async () => {
  if (!(await confirmer("Effacer l'historique ?", "Tous les scans enregistrés sur cet appareil seront supprimés.", "Effacer"))) return;
  stock.ecrire(CLE_HIST, []);
  toast("Historique effacé");
};
$("btnExporter").onclick = () => {
  const hist = stock.lire(CLE_HIST, []);
  if (!hist.length) { toast("Aucun scan à exporter"); return; }
  const blob = new Blob([JSON.stringify(hist, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `patasur_historique_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// Les voix de synthèse se chargent parfois en différé
if ("speechSynthesis" in window) speechSynthesis.getVoices();

// ---------------------------------------------------------------
// DÉMARRAGE
// ---------------------------------------------------------------
synchroniserReglages();
rendreGuide();

// L'écran de démarrage reste au moins 1,2 s, au plus 4 s (le chargement continue ensuite)
const tDebut = performance.now();
function masquerSplash() {
  const reste = Math.max(0, 1200 - (performance.now() - tDebut));
  setTimeout(() => $("splash").classList.add("parti"), reste);
}
const minuteurSplash = setTimeout(masquerSplash, 4000);

chargerModele()
  .then(() => {
    modelePret = true;
    synchroniserReglages();
    const puce = $("etatModele");
    puce.className = "puce-etat pret";
    puce.querySelector("b").textContent = "IA prête";
    clearTimeout(minuteurSplash);
    masquerSplash();
  })
  .catch((e) => {
    erreurModele = e;
    const puce = $("etatModele");
    puce.className = "puce-etat erreur";
    puce.querySelector("b").textContent = "Erreur · réessayer";
    puce.style.cursor = "pointer";
    puce.onclick = () => location.reload();
    $("splashTexte").textContent = "Échec du chargement du modèle";
    clearTimeout(minuteurSplash);
    masquerSplash();
    afficherErreur(e);
  });
