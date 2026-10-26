// Traitements pixel bas niveau : flous, convolutions, remplissage, histogrammes, courbes.

import { clamp } from './util.js';

// Rayons de 3 flous boîte successifs approchant un flou gaussien d'écart-type sigma.
function boxesForGauss(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes.map((s) => Math.max(0, (s - 1) / 2));
}

// Flou boîte horizontal + vertical sur un canal flottant (src -> dst, tmp en tampon).
function boxBlurChannel(src, dst, tmp, w, h, r) {
  if (r < 1) {
    dst.set(src);
    return;
  }
  const iarr = 1 / (r + r + 1);
  // horizontal : src -> tmp
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let ti = row, li = row, ri = row + r;
    const fv = src[row], lv = src[row + w - 1];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[row + Math.min(j, w - 1)];
    for (let x = 0; x < w; x++) {
      val += (ri < row + w ? src[ri] : lv) - (x - r - 1 >= 0 ? src[li++] : fv);
      ri++;
      tmp[ti++] = val * iarr;
    }
  }
  // vertical : tmp -> dst
  for (let x = 0; x < w; x++) {
    const fv = tmp[x], lv = tmp[x + w * (h - 1)];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += tmp[x + Math.min(j, h - 1) * w];
    let li = x, ri = x + r * w, ti = x;
    for (let y = 0; y < h; y++) {
      val += (y + r < h ? tmp[ri] : lv) - (y - r - 1 >= 0 ? tmp[li] : fv);
      if (y - r - 1 >= 0) li += w;
      ri += w;
      dst[ti] = val * iarr;
      ti += w;
    }
  }
}

// Flou gaussien approximé sur un canal Float32Array (en place).
export function blurChannel(chan, w, h, sigma) {
  if (sigma < 0.3) return chan;
  const tmp = new Float32Array(chan.length);
  const out = new Float32Array(chan.length);
  let a = chan, b = out;
  for (const r of boxesForGauss(sigma)) {
    boxBlurChannel(a, b, tmp, w, h, Math.round(r));
    [a, b] = [b, a];
  }
  if (a !== chan) chan.set(a);
  return chan;
}

// Flou gaussien d'une ImageData (alpha prémultiplié pour éviter les halos sombres).
export function gaussianBlur(imageData, sigma) {
  const { width: w, height: h, data } = imageData;
  const out = new ImageData(new Uint8ClampedArray(data), w, h);
  if (sigma < 0.3) return out;
  const n = w * h;
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  let opaque = true;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = data[p + 3] / 255;
    if (a < 1) opaque = false;
    ch[0][i] = data[p] * a;
    ch[1][i] = data[p + 1] * a;
    ch[2][i] = data[p + 2] * a;
    ch[3][i] = a;
  }
  for (let c = 0; c < (opaque ? 3 : 4); c++) blurChannel(ch[c], w, h, sigma);
  const od = out.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = opaque ? 1 : ch[3][i];
    if (a <= 0.0001) {
      od[p + 3] = 0;
      continue;
    }
    od[p] = ch[0][i] / a;
    od[p + 1] = ch[1][i] / a;
    od[p + 2] = ch[2][i] / a;
    od[p + 3] = a * 255;
  }
  return out;
}

// Flou du seul canal alpha (contour progressif des sélections, masques).
export function blurAlpha(imageData, sigma) {
  const { width: w, height: h, data } = imageData;
  const n = w * h;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = data[i * 4 + 3];
  blurChannel(a, w, h, sigma);
  for (let i = 0; i < n; i++) data[i * 4 + 3] = a[i];
  return imageData;
}

export function luminanceChannel(imageData) {
  const { data } = imageData;
  const n = data.length / 4;
  const L = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) L[i] = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
  return L;
}

// Convolution 3x3 générique.
export function convolve3x3(imageData, k, divisor = 1, offset = 0, keepAlpha = true) {
  const { width: w, height: h, data } = imageData;
  const out = new ImageData(w, h);
  const od = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, ki = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = clamp(y + dy, 0, h - 1);
        for (let dx = -1; dx <= 1; dx++, ki++) {
          const xx = clamp(x + dx, 0, w - 1);
          const p = (yy * w + xx) * 4;
          const kv = k[ki];
          r += data[p] * kv;
          g += data[p + 1] * kv;
          b += data[p + 2] * kv;
        }
      }
      const o = (y * w + x) * 4;
      od[o] = r / divisor + offset;
      od[o + 1] = g / divisor + offset;
      od[o + 2] = b / divisor + offset;
      od[o + 3] = keepAlpha ? data[o + 3] : 255;
    }
  }
  return out;
}

// Remplissage par diffusion : renvoie un masque Uint8Array (255 = sélectionné).
// `region` limite éventuellement la recherche à un rectangle {x0,y0,x1,y1}.
export function floodMask(imageData, sx, sy, tolerance, contiguous = true, region = null) {
  const { width: w, height: h, data } = imageData;
  const mask = new Uint8Array(w * h);
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const p0 = (sy * w + sx) * 4;
  const r0 = data[p0], g0 = data[p0 + 1], b0 = data[p0 + 2], a0 = data[p0 + 3];
  const tol = (tolerance / 100) * 255;
  const tol2 = tol * tol * 4;
  const match = (p) => {
    const dr = data[p] - r0, dg = data[p + 1] - g0, db = data[p + 2] - b0, da = data[p + 3] - a0;
    return dr * dr + dg * dg + db * db + da * da <= tol2;
  };
  const rx0 = region ? Math.max(0, region.x0) : 0;
  const ry0 = region ? Math.max(0, region.y0) : 0;
  const rx1 = region ? Math.min(w - 1, region.x1) : w - 1;
  const ry1 = region ? Math.min(h - 1, region.y1) : h - 1;

  if (!contiguous) {
    for (let y = ry0; y <= ry1; y++)
      for (let x = rx0; x <= rx1; x++) {
        const i = y * w + x;
        if (match(i * 4)) mask[i] = 255;
      }
    return mask;
  }
  // Remplissage par lignes (scanline) avec pile.
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop();
    let x = stack.pop();
    let i = y * w + x;
    while (x >= rx0 && !mask[i] && match(i * 4)) {
      x--;
      i--;
    }
    x++;
    i++;
    let up = false, down = false;
    while (x <= rx1 && !mask[i] && match(i * 4)) {
      mask[i] = 255;
      if (y > ry0) {
        const iu = i - w;
        if (!mask[iu] && match(iu * 4)) {
          if (!up) {
            stack.push(x, y - 1);
            up = true;
          }
        } else up = false;
      }
      if (y < ry1) {
        const id = i + w;
        if (!mask[id] && match(id * 4)) {
          if (!down) {
            stack.push(x, y + 1);
            down = true;
          }
        } else down = false;
      }
      x++;
      i++;
    }
  }
  return mask;
}

// Convertit un masque 0..255 en canvas alpha (blanc opaque là où le masque est actif).
export function maskToImageData(mask, w, h) {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (!mask[i]) continue;
    d[p] = d[p + 1] = d[p + 2] = 255;
    d[p + 3] = mask[i];
  }
  return img;
}

export function histogram(imageData, step = 1) {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  const d = imageData.data;
  const inc = 4 * step;
  for (let p = 0; p < d.length; p += inc) {
    if (d[p + 3] < 8) continue;
    r[d[p]]++;
    g[d[p + 1]]++;
    b[d[p + 2]]++;
    l[(0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]) | 0]++;
  }
  return { r, g, b, l };
}

// Valeur du percentile p (0..1) d'un histogramme.
export function histPercentile(hist, p) {
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= target) return i;
  }
  return 255;
}

// Interpolation monotone (Fritsch-Carlson) des points d'une courbe -> table de n valeurs 0..1.
export function curveLUT(points, n = 256) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const lut = new Float32Array(n);
  if (pts.length < 2) {
    for (let i = 0; i < n; i++) lut[i] = i / (n - 1);
    return lut;
  }
  const k = pts.length;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const d = [], m = new Array(k).fill(0);
  for (let i = 0; i < k - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m[0] = d[0];
  m[k - 1] = d[k - 2];
  for (let i = 1; i < k - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    if (x <= xs[0]) {
      lut[i] = ys[0];
      continue;
    }
    if (x >= xs[k - 1]) {
      lut[i] = ys[k - 1];
      continue;
    }
    while (seg < k - 2 && x > xs[seg + 1]) seg++;
    const hh = xs[seg + 1] - xs[seg];
    const t = (x - xs[seg]) / hh;
    const t2 = t * t, t3 = t2 * t;
    lut[i] = clamp(
      (2 * t3 - 3 * t2 + 1) * ys[seg] + (t3 - 2 * t2 + t) * hh * m[seg] +
        (-2 * t3 + 3 * t2) * ys[seg + 1] + (t3 - t2) * hh * m[seg + 1],
      0, 1);
  }
  return lut;
}

export const isIdentityCurve = (pts) =>
  pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;

// Échantillonnage bilinéaire (pour les déformations).
export function sampleBilinear(data, w, h, x, y, out) {
  x = clamp(x, 0, w - 1.001);
  y = clamp(y, 0, h - 1.001);
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const p00 = (y0 * w + x0) * 4, p10 = p00 + 4, p01 = p00 + w * 4, p11 = p01 + 4;
  for (let c = 0; c < 4; c++) {
    const top = data[p00 + c] + (data[p10 + c] - data[p00 + c]) * fx;
    const bot = data[p01 + c] + (data[p11 + c] - data[p01 + c]) * fx;
    out[c] = top + (bot - top) * fy;
  }
  return out;
}

// Bruit pseudo-aléatoire stable (même résultat à chaque aperçu).
export function hash2(x, y, seed = 0) {
  let n = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967295;
}

// Tables de sommes (images intégrales) pour moyennes/variances locales en O(1).
export function integralImages(imageData) {
  const { width: w, height: h, data } = imageData;
  const W = w + 1;
  const size = W * (h + 1);
  const sr = new Float64Array(size), sg = new Float64Array(size), sb = new Float64Array(size), sl2 = new Float64Array(size), sl = new Float64Array(size);
  for (let y = 0; y < h; y++) {
    let ar = 0, ag = 0, ab = 0, al = 0, al2 = 0;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      ar += r; ag += g; ab += b; al += l; al2 += l * l;
      const i = (y + 1) * W + x + 1, up = y * W + x + 1;
      sr[i] = sr[up] + ar;
      sg[i] = sg[up] + ag;
      sb[i] = sb[up] + ab;
      sl[i] = sl[up] + al;
      sl2[i] = sl2[up] + al2;
    }
  }
  const rect = (arr, x0, y0, x1, y1) => arr[(y1 + 1) * W + x1 + 1] - arr[y0 * W + x1 + 1] - arr[(y1 + 1) * W + x0] + arr[y0 * W + x0];
  return { sr, sg, sb, sl, sl2, rect };
}
