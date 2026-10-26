// Remplissage d'après le contenu (suppression d'objet) : synthèse de texture multi-échelle
// par PatchMatch + vote (approche de Wexler et al.). Tout est calculé localement.

import { createCanvas } from './util.js';

const P = 7; // taille des patchs
const COARSE_LOCALITY = 8; // au niveau grossier, la structure vient surtout des alentours immédiats
const H = 3; // demi-taille

// ---------- Pyramide ----------

function makeLevel(w, h) {
  return { w, h, img: new Float32Array(w * h * 4), hole: new Uint8Array(w * h) };
}

function downsample(L) {
  const w = Math.ceil(L.w / 2), h = Math.ceil(L.h / 2);
  const D = makeLevel(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let n = 0, anyHole = false;
      const acc = [0, 0, 0, 0];
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const sx = x * 2 + dx, sy = y * 2 + dy;
          if (sx >= L.w || sy >= L.h) continue;
          const i = sy * L.w + sx;
          if (L.hole[i]) {
            anyHole = true;
            continue;
          }
          for (let c = 0; c < 4; c++) acc[c] += L.img[i * 4 + c];
          n++;
        }
      const o = y * w + x;
      D.hole[o] = anyHole ? 1 : 0;
      if (n) for (let c = 0; c < 4; c++) D.img[o * 4 + c] = acc[c] / n;
    }
  return D;
}

// Remplissage initial par diffusion (« pelure d'oignon ») depuis le bord du trou.
function diffuseFill(L) {
  const { w, h, img } = L;
  const filled = new Uint8Array(w * h);
  let remaining = 0;
  for (let i = 0; i < w * h; i++) {
    filled[i] = L.hole[i] ? 0 : 1;
    if (!filled[i]) remaining++;
  }
  let guard = 0;
  while (remaining > 0 && guard++ < w + h + 10) {
    const next = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let n = 0;
        const acc = [0, 0, 0, 0];
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const j = yy * w + xx;
            if (!filled[j]) continue;
            for (let c = 0; c < 4; c++) acc[c] += img[j * 4 + c];
            n++;
          }
        if (n) next.push(i, acc[0] / n, acc[1] / n, acc[2] / n, acc[3] / n);
      }
    if (!next.length) break;
    for (let k = 0; k < next.length; k += 5) {
      const i = next[k];
      for (let c = 0; c < 4; c++) img[i * 4 + c] = next[k + 1 + c];
      filled[i] = 1;
      remaining--;
    }
  }
}

// ---------- PatchMatch ----------

function solveLevel(L, initNNF, emIters, pmIters, rand, locality = 0.35) {
  const { w, h, img, hole } = L;
  const N = w * h;

  // Sources valides : patch entièrement connu et dans l'image.
  const valid = new Uint8Array(N);
  let validCount = 0;
  for (let y = H; y < h - H; y++)
    for (let x = H; x < w - H; x++) {
      let ok = true;
      for (let dy = -H; dy <= H && ok; dy++) for (let dx = -H; dx <= H; dx++) if (hole[(y + dy) * w + x + dx]) {
        ok = false;
        break;
      }
      if (ok) {
        valid[y * w + x] = 1;
        validCount++;
      }
    }
  if (validCount < 4) return null;
  const validList = new Int32Array(validCount);
  for (let i = 0, k = 0; i < N; i++) if (valid[i]) validList[k++] = i;

  // Cibles : pixels dont le patch touche le trou.
  const isTarget = new Uint8Array(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!hole[y * w + x]) continue;
      for (let dy = -H; dy <= H; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -H; dx <= H; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) isTarget[yy * w + xx] = 1;
        }
      }
    }
  const targets = [];
  for (let i = 0; i < N; i++) if (isTarget[i]) targets.push(i);
  const T = targets.length;
  const nnf = new Int32Array(N).fill(-1);
  const dist = new Float32Array(N);

  // Confiance : les pixels connus comptent plus que ceux encore estimés dans le trou.
  const conf = new Float32Array(N);
  const holeWeight = initNNF ? 0.6 : 0.2;
  for (let i = 0; i < N; i++) conf[i] = hole[i] ? holeWeight : 1;
  const diag = Math.hypot(w, h);

  const patchDist = (t, s, best) => {
    const tx = t % w, ty = (t / w) | 0, sx = s % w, sy = (s / w) | 0;
    const pen = (locality * Math.hypot(tx - sx, ty - sy)) / diag;
    let d = 0, n = 0;
    for (let dy = -H; dy <= H; dy++) {
      const y1 = ty + dy;
      if (y1 < 0 || y1 >= h) continue;
      const rowT = y1 * w, rowS = (sy + dy) * w;
      for (let dx = -H; dx <= H; dx++) {
        const x1 = tx + dx;
        if (x1 < 0 || x1 >= w) continue;
        const ti = rowT + x1;
        const a = ti * 4, b = (rowS + sx + dx) * 4;
        const e0 = img[a] - img[b], e1 = img[a + 1] - img[b + 1], e2 = img[a + 2] - img[b + 2], e3 = img[a + 3] - img[b + 3];
        const c = conf[ti];
        d += (e0 * e0 + e1 * e1 + e2 * e2 + e3 * e3 * 0.5) * c;
        n += c;
      }
      if ((d / Math.max(1e-6, n)) * (P * P) + pen > best) return Infinity;
    }
    return (d / Math.max(1e-6, n)) * (P * P) + pen;
  };

  // Initialisation : NNF agrandie du niveau précédent, sinon aléatoire.
  for (const t of targets) {
    let s = -1;
    if (initNNF) {
      const tx = t % w, ty = (t / w) | 0;
      const c = initNNF(tx, ty);
      if (c >= 0 && valid[c]) s = c;
    }
    if (s < 0) s = validList[(rand() * validCount) | 0];
    nnf[t] = s;
    dist[t] = patchDist(t, s, Infinity);
  }

  const tryCandidate = (t, s) => {
    if (s < 0 || s >= N || !valid[s] || s === nnf[t]) return;
    const d = patchDist(t, s, dist[t]);
    if (d < dist[t]) {
      dist[t] = d;
      nnf[t] = s;
    }
  };

  const maxR = Math.max(w, h);
  const acc = new Float32Array(N * 4);
  const wsum = new Float32Array(N);

  const vote = () => {
    // Vote pondéré par la similarité
    acc.fill(0);
    wsum.fill(0);
    let meanD = 0;
    for (const t of targets) meanD += dist[t];
    meanD = meanD / Math.max(1, T) + 1e-6;
    for (const t of targets) {
      const s = nnf[t];
      const wgt = Math.exp(-dist[t] / (0.6 * meanD));
      const tx = t % w, ty = (t / w) | 0, sx = s % w, sy = (s / w) | 0;
      for (let dy = -H; dy <= H; dy++) {
        const y1 = ty + dy;
        if (y1 < 0 || y1 >= h) continue;
        for (let dx = -H; dx <= H; dx++) {
          const x1 = tx + dx;
          if (x1 < 0 || x1 >= w) continue;
          const xi = y1 * w + x1;
          if (!hole[xi]) continue;
          const b = ((sy + dy) * w + sx + dx) * 4;
          acc[xi * 4] += img[b] * wgt;
          acc[xi * 4 + 1] += img[b + 1] * wgt;
          acc[xi * 4 + 2] += img[b + 2] * wgt;
          acc[xi * 4 + 3] += img[b + 3] * wgt;
          wsum[xi] += wgt;
        }
      }
    }
    for (let i = 0; i < N; i++) {
      if (!hole[i] || wsum[i] <= 0) continue;
      for (let c = 0; c < 4; c++) img[i * 4 + c] = acc[i * 4 + c] / wsum[i];
    }
  };

  // Niveau fin : reconstruit d'abord le trou avec les correspondances agrandies,
  // ce qui réinjecte la texture détaillée des sources.
  if (initNNF) vote();

  for (let em = 0; em < emIters; em++) {
    if (em === Math.ceil(emIters / 2)) for (let i = 0; i < N; i++) if (hole[i]) conf[i] = 1;
    // Recalcule les distances avec l'image mise à jour
    for (const t of targets) dist[t] = patchDist(t, nnf[t], Infinity);
    for (let it = 0; it < pmIters; it++) {
      const fwd = it % 2 === 0;
      for (let k = 0; k < T; k++) {
        const t = targets[fwd ? k : T - 1 - k];
        const tx = t % w, ty = (t / w) | 0;
        const step = fwd ? 1 : -1;
        // Propagation
        const nxp = tx - step, nyp = ty - step;
        if (nxp >= 0 && nxp < w) {
          const nb = ty * w + nxp;
          if (isTarget[nb] && nnf[nb] >= 0) {
            const s = nnf[nb] + step;
            if ((s % w) - (nnf[nb] % w) === step) tryCandidate(t, s);
          }
        }
        if (nyp >= 0 && nyp < h) {
          const nb = nyp * w + tx;
          if (isTarget[nb] && nnf[nb] >= 0) tryCandidate(t, nnf[nb] + step * w);
        }
        // Recherche aléatoire
        const s0 = nnf[t];
        const sx = s0 % w, sy = (s0 / w) | 0;
        for (let r = maxR; r >= 1; r = (r / 2) | 0) {
          const cx = sx + Math.round((rand() * 2 - 1) * r), cy = sy + Math.round((rand() * 2 - 1) * r);
          if (cx < H || cy < H || cx >= w - H || cy >= h - H) continue;
          tryCandidate(t, cy * w + cx);
        }
      }
    }
    vote();
  }
  return { nnf, w, h };
}

// Distance maximale (en pixels, métrique de l'échiquier) entre un pixel du trou et le bord connu.
function holeThickness(L) {
  const { w, h, hole } = L;
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = hole[i] ? INF : 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + 1);
      if (y > 0) {
        m = Math.min(m, d[i - w] + 1);
        if (x > 0) m = Math.min(m, d[i - w - 1] + 1);
        if (x < w - 1) m = Math.min(m, d[i - w + 1] + 1);
      }
      d[i] = m;
    }
  let mx = 0;
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let m = d[i];
      if (x < w - 1) m = Math.min(m, d[i + 1] + 1);
      if (y < h - 1) {
        m = Math.min(m, d[i + w] + 1);
        if (x < w - 1) m = Math.min(m, d[i + w + 1] + 1);
        if (x > 0) m = Math.min(m, d[i + w - 1] + 1);
      }
      d[i] = m;
      if (m > mx && m < INF) mx = m;
    }
  return mx;
}

function mulberry(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Remplit les pixels du trou d'une ImageData. `hole` : Uint8Array (1 = à reconstruire).
 * Renvoie une nouvelle ImageData.
 */
export function inpaintImageData(src, hole) {
  const { width: w, height: h, data } = src;
  const L0 = makeLevel(w, h);
  for (let i = 0; i < w * h; i++) {
    L0.hole[i] = hole[i] ? 1 : 0;
    for (let c = 0; c < 4; c++) L0.img[i * 4 + c] = data[i * 4 + c] / 255;
  }
  // Pyramide jusqu'à ce que le trou soit « mince » : chaque pixel du trou est alors
  // à moins d'un demi-patch d'un pixel connu, ce qui guide bien la synthèse.
  const levels = [L0];
  while (levels.length < 10) {
    const last = levels[levels.length - 1];
    if (Math.min(last.w, last.h) < 100) break;
    if (holeThickness(last) <= H) break;
    levels.push(downsample(last));
  }
  const rand = mulberry(1234);
  let prev = null;
  for (let li = levels.length - 1; li >= 0; li--) {
    const L = levels[li];
    if (li === levels.length - 1) diffuseFill(L);
    else {
      // Agrandit la solution grossière dans le trou
      const C = levels[li + 1];
      for (let y = 0; y < L.h; y++)
        for (let x = 0; x < L.w; x++) {
          const i = y * L.w + x;
          if (!L.hole[i]) continue;
          const cx = Math.min(C.w - 1, x >> 1), cy = Math.min(C.h - 1, y >> 1);
          const j = cy * C.w + cx;
          for (let c = 0; c < 4; c++) L.img[i * 4 + c] = C.img[j * 4 + c];
        }
    }
    const coarse = prev;
    const initNNF = coarse
      ? (x, y) => {
          const cx = Math.min(coarse.w - 1, x >> 1), cy = Math.min(coarse.h - 1, y >> 1);
          const s = coarse.nnf[cy * coarse.w + cx];
          if (s < 0) return -1;
          const sx = (s % coarse.w) * 2 + (x & 1), sy = ((s / coarse.w) | 0) * 2 + (y & 1);
          if (sx >= L.w || sy >= L.h) return -1;
          return sy * L.w + sx;
        }
      : null;
    const isCoarsest = li === levels.length - 1;
    const res = solveLevel(L, initNNF, isCoarsest ? 8 : li === 0 ? 2 : 4, isCoarsest ? 5 : 3, rand, isCoarsest ? COARSE_LOCALITY : 0.35);
    if (!res && li === levels.length - 1) diffuseFill(L);
    prev = res;
  }
  const out = new ImageData(new Uint8ClampedArray(data), w, h);
  for (let i = 0; i < w * h; i++) {
    if (!L0.hole[i]) continue;
    for (let c = 0; c < 4; c++) out.data[i * 4 + c] = L0.img[i * 4 + c] * 255;
  }
  return out;
}

/**
 * Remplissage d'après le contenu sur un canvas entier.
 * `mask` : canvas dont l'alpha indique la zone à reconstruire (doux accepté).
 */
export function contentAwareFill(canvas, mask, { maxPixels = 1_600_000 } = {}) {
  const W = canvas.width, Hh = canvas.height;
  const md = mask.getContext('2d').getImageData(0, 0, W, Hh).data;
  let x0 = W, y0 = Hh, x1 = -1, y1 = -1;
  for (let y = 0; y < Hh; y++)
    for (let x = 0; x < W; x++)
      if (md[(y * W + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  if (x1 < 0) return null;
  // Zone de travail : le trou + une marge où chercher des textures
  const hw = x1 - x0 + 1, hh = y1 - y0 + 1;
  const margin = Math.max(48, Math.round(Math.max(hw, hh) * 1.2));
  const rx = Math.max(0, x0 - margin), ry = Math.max(0, y0 - margin);
  const rw = Math.min(W, x1 + margin + 1) - rx, rh = Math.min(Hh, y1 + margin + 1) - ry;
  const k = Math.min(1, Math.sqrt(maxPixels / (rw * rh)));
  const sw = Math.max(8, Math.round(rw * k)), sh = Math.max(8, Math.round(rh * k));

  const work = createCanvas(sw, sh);
  const wctx = work.getContext('2d');
  wctx.imageSmoothingQuality = 'high';
  wctx.drawImage(canvas, rx, ry, rw, rh, 0, 0, sw, sh);
  const wm = createCanvas(sw, sh);
  const mctx = wm.getContext('2d');
  mctx.drawImage(mask, rx, ry, rw, rh, 0, 0, sw, sh);
  const wmd = mctx.getImageData(0, 0, sw, sh).data;
  const hole = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) hole[i] = wmd[i * 4 + 3] > 10 ? 1 : 0;
  // Élargit d'un pixel pour ne pas garder de liseré de l'objet
  const grown = new Uint8Array(hole);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++)
      if (hole[y * sw + x])
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < sw && yy < sh) grown[yy * sw + xx] = 1;
          }
  const filled = inpaintImageData(wctx.getImageData(0, 0, sw, sh), grown);
  wctx.putImageData(filled, 0, 0);

  // Recompose : résultat (remis à l'échelle) uniquement dans le masque, bords adoucis.
  const piece = createCanvas(rw, rh);
  const pctx = piece.getContext('2d');
  pctx.imageSmoothingQuality = 'high';
  pctx.drawImage(work, 0, 0, rw, rh);
  pctx.globalCompositeOperation = 'destination-in';
  // masque légèrement étendu et adouci
  const soft = createCanvas(rw, rh);
  const sctx = soft.getContext('2d');
  sctx.drawImage(mask, rx, ry, rw, rh, 0, 0, rw, rh);
  if ('filter' in sctx) {
    const s2 = createCanvas(rw, rh);
    const s2c = s2.getContext('2d');
    s2c.filter = `blur(${Math.max(1, Math.round(1.5 / k))}px)`;
    s2c.drawImage(soft, 0, 0);
    s2c.filter = 'none';
    s2c.drawImage(soft, 0, 0);
    pctx.drawImage(s2, 0, 0);
  } else pctx.drawImage(soft, 0, 0);
  const out = createCanvas(W, Hh);
  const octx = out.getContext('2d');
  octx.drawImage(canvas, 0, 0);
  octx.drawImage(piece, rx, ry);
  return out;
}
