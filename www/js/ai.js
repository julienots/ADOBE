// IA embarquée : détection du sujet (détourage) avec le modèle U²-Net-p exécuté localement
// par ONNX Runtime Web (WebAssembly). Aucune image n'est envoyée sur Internet.

import { createCanvas, resizeCanvas, smoothstep } from './util.js';
import { blurChannel } from './imaging.js';

// L'hébergement web de démonstration impose une autre extension : il fournit alors l'URL.
const MODEL_URL = window.PRISME_MODEL_URL || 'models/u2netp.onnx';
const ORT_URL = 'vendor/ort/ort.wasm.min.js';
const SIZE = 320;

let sessionPromise = null;
const cache = new WeakMap();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Chargement impossible : ${src}`));
    document.head.append(s);
  });
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      if (!window.ort) await loadScript(ORT_URL);
      const ort = window.ort;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = new URL('vendor/ort/', location.href).href;
      const res = await fetch(MODEL_URL);
      if (!res.ok) throw new Error('Modèle IA introuvable');
      const buf = await res.arrayBuffer();
      return ort.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    })();
    sessionPromise.catch(() => (sessionPromise = null));
  }
  return sessionPromise;
}

// Précharge le modèle en arrière-plan (appelé quand l'utilisateur ouvre une photo).
export function warmUpAI() {
  getSession().catch(() => {});
}

/**
 * Renvoie un canvas à la taille de `canvas` dont l'alpha vaut la probabilité « sujet ».
 */
export async function segmentSubject(canvas) {
  const hit = cache.get(canvas);
  if (hit) return hit;
  const session = await getSession();
  const ort = window.ort;

  // Entrée 320×320 normalisée comme à l'entraînement (ImageNet)
  const small = createCanvas(SIZE, SIZE);
  const sctx = small.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.fillStyle = '#ffffff';
  sctx.fillRect(0, 0, SIZE, SIZE);
  sctx.drawImage(resizeCanvas(canvas, SIZE, SIZE), 0, 0);
  const px = sctx.getImageData(0, 0, SIZE, SIZE).data;
  let mx = 1;
  for (let i = 0; i < px.length; i += 4) mx = Math.max(mx, px[i], px[i + 1], px[i + 2]);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const input = new Float32Array(3 * SIZE * SIZE);
  for (let i = 0, p = 0; i < SIZE * SIZE; i++, p += 4)
    for (let c = 0; c < 3; c++) input[c * SIZE * SIZE + i] = (px[p + c] / mx - mean[c]) / std[c];

  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) };
  const out = await session.run(feeds);
  const pred = out[session.outputNames[0]].data;
  let mn = Infinity, mxp = -Infinity;
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (pred[i] < mn) mn = pred[i];
    if (pred[i] > mxp) mxp = pred[i];
  }
  const range = mxp - mn || 1;
  const maskSmall = createCanvas(SIZE, SIZE);
  const mctx = maskSmall.getContext('2d');
  const md = mctx.createImageData(SIZE, SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = 255;
    md.data[i * 4 + 3] = ((pred[i] - mn) / range) * 255;
  }
  mctx.putImageData(md, 0, 0);
  const refined = refineMask(canvas, maskSmall);
  cache.set(canvas, refined);
  return refined;
}

// Affinage des contours : filtre guidé par l'image (les bords du masque suivent ceux de la photo).
function refineMask(image, maskSmall) {
  const W = image.width, H = image.height;
  const k = Math.min(1, Math.sqrt(1_500_000 / (W * H)));
  const w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
  const guide = resizeCanvas(image, w, h).getContext('2d').getImageData(0, 0, w, h).data;
  const mc = createCanvas(w, h);
  const mcx = mc.getContext('2d');
  mcx.imageSmoothingQuality = 'high';
  mcx.drawImage(maskSmall, 0, 0, w, h);
  const md = mcx.getImageData(0, 0, w, h);
  const n = w * h;
  const I = new Float32Array(n), p = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    I[i] = (0.299 * guide[i * 4] + 0.587 * guide[i * 4 + 1] + 0.114 * guide[i * 4 + 2]) / 255;
    p[i] = md.data[i * 4 + 3] / 255;
  }
  const r = Math.max(2, Math.round(Math.max(w, h) * 0.008));
  const eps = 2e-3;
  const f = (a) => blurChannel(a, w, h, r / 1.5);
  const mI = f(Float32Array.from(I)), mP = f(Float32Array.from(p));
  const II = new Float32Array(n), IP = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    II[i] = I[i] * I[i];
    IP[i] = I[i] * p[i];
  }
  f(II);
  f(IP);
  const A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = II[i] - mI[i] * mI[i];
    const cov = IP[i] - mI[i] * mP[i];
    A[i] = cov / (varI + eps);
    B[i] = mP[i] - A[i] * mI[i];
  }
  f(A);
  f(B);
  for (let i = 0; i < n; i++) {
    // Combinaison du masque brut et du masque guidé, puis durcissement léger
    const q = A[i] * I[i] + B[i];
    const v = smoothstep(0.18, 0.82, q * 0.7 + p[i] * 0.3);
    md.data[i * 4] = md.data[i * 4 + 1] = md.data[i * 4 + 2] = 255;
    md.data[i * 4 + 3] = v * 255;
  }
  mcx.putImageData(md, 0, 0);
  const full = createCanvas(W, H);
  const fctx = full.getContext('2d');
  fctx.imageSmoothingQuality = 'high';
  fctx.drawImage(mc, 0, 0, W, H);
  return full;
}
