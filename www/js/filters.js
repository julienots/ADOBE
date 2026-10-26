// Bibliothèque de filtres et de réglages destructifs (avec aperçu en direct).
// Chaque entrée : { id, name, cat, params, apply(imageData, valeurs, échelle) -> ImageData }

import { clamp, smoothstep, hexToRgb, rgbToHsl01, hslToRgb01 } from './util.js';
import {
  gaussianBlur, convolve3x3, histogram, histPercentile, sampleBilinear, hash2, integralImages, luminanceChannel, blurChannel,
} from './imaging.js';
import { unsharp, reduceNoise } from './develop.js';

const copy = (img) => new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);

function perPixel(img, fn) {
  const out = copy(img);
  const d = out.data;
  for (let q = 0; q < d.length; q += 4) fn(d, q);
  return out;
}

const range = (key, label, min, max, value, step = 1, unit = '') => ({ key, label, min, max, value, step, unit });

// Déformation par mappage inverse (pour tourbillon, sphérisation, ondulation…).
function warp(img, fn) {
  const { width: w, height: h, data } = img;
  const out = new ImageData(w, h);
  const od = out.data;
  const px = [0, 0, 0, 0], src = [0, 0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4;
      if (!fn(x, y, src)) {
        od[q] = data[q]; od[q + 1] = data[q + 1]; od[q + 2] = data[q + 2]; od[q + 3] = data[q + 3];
        continue;
      }
      sampleBilinear(data, w, h, src[0], src[1], px);
      od[q] = px[0]; od[q + 1] = px[1]; od[q + 2] = px[2]; od[q + 3] = px[3];
    }
  return out;
}

// Flou directionnel : moyenne d'échantillons le long d'un vecteur.
function directionalBlur(img, getVector, samples) {
  const { width: w, height: h, data } = img;
  const out = new ImageData(w, h);
  const od = out.data;
  const px = [0, 0, 0, 0], v = [0, 0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      getVector(x, y, v);
      let r = 0, g = 0, b = 0, a = 0;
      for (let s = 0; s < samples; s++) {
        const t = samples === 1 ? 0 : s / (samples - 1) - 0.5;
        sampleBilinear(data, w, h, x + v[0] * t, y + v[1] * t, px);
        const pa = px[3];
        r += px[0] * pa; g += px[1] * pa; b += px[2] * pa; a += pa;
      }
      const q = (y * w + x) * 4;
      if (a > 0) {
        od[q] = r / a; od[q + 1] = g / a; od[q + 2] = b / a;
      }
      od[q + 3] = a / samples;
    }
  return out;
}

const lum = (d, q) => 0.2126 * d[q] + 0.7152 * d[q + 1] + 0.0722 * d[q + 2];

export const FILTERS = [
  // ---------- Réglages (menu Réglages) ----------
  {
    id: 'brightness', name: 'Luminosité / Contraste', cat: 'Réglages',
    params: [range('brightness', 'Luminosité', -150, 150, 0), range('contrast', 'Contraste', -100, 100, 0)],
    apply(img, p) {
      const c = p.contrast / 100;
      const f = c >= 0 ? 1 / Math.max(0.01, 1 - c) : 1 + c;
      return perPixel(img, (d, q) => {
        for (let k = 0; k < 3; k++) d[q + k] = (d[q + k] + p.brightness * 0.6 - 128) * f + 128;
      });
    },
  },
  {
    id: 'levels', name: 'Niveaux', cat: 'Réglages',
    params: [
      { key: 'channel', label: 'Couche', type: 'select', value: 'rgb', options: [['rgb', 'RVB'], ['r', 'Rouge'], ['g', 'Vert'], ['b', 'Bleu']] },
      range('inBlack', 'Noir en entrée', 0, 253, 0), range('gamma', 'Gamma', 0.1, 9.99, 1, 0.01), range('inWhite', 'Blanc en entrée', 2, 255, 255),
      range('outBlack', 'Noir en sortie', 0, 255, 0), range('outWhite', 'Blanc en sortie', 0, 255, 255),
    ],
    histogram: true,
    apply(img, p) {
      const lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) {
        let v = clamp((i - p.inBlack) / Math.max(1, p.inWhite - p.inBlack), 0, 1);
        v = Math.pow(v, 1 / p.gamma);
        lut[i] = p.outBlack + v * (p.outWhite - p.outBlack);
      }
      const ch = p.channel === 'rgb' ? [0, 1, 2] : [{ r: 0, g: 1, b: 2 }[p.channel]];
      return perPixel(img, (d, q) => {
        for (const k of ch) d[q + k] = lut[d[q + k]];
      });
    },
  },
  {
    id: 'exposure', name: 'Exposition', cat: 'Réglages',
    params: [range('exposure', 'Exposition', -5, 5, 0, 0.01, ' IL'), range('offset', 'Décalage', -0.5, 0.5, 0, 0.001), range('gamma', 'Correction gamma', 0.1, 3, 1, 0.01)],
    apply(img, p) {
      const m = Math.pow(2, p.exposure);
      const lut = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) {
        const lin = Math.pow(i / 255, 2.2) * m + p.offset;
        lut[i] = Math.pow(clamp(lin, 0, 1), 1 / (2.2 * p.gamma)) * 255;
      }
      return perPixel(img, (d, q) => {
        d[q] = lut[d[q]]; d[q + 1] = lut[d[q + 1]]; d[q + 2] = lut[d[q + 2]];
      });
    },
  },
  {
    id: 'huesat', name: 'Teinte / Saturation', cat: 'Réglages',
    params: [range('hue', 'Teinte', -180, 180, 0, 1, '°'), range('sat', 'Saturation', -100, 100, 0), range('light', 'Luminosité', -100, 100, 0), { key: 'colorize', label: 'Redéfinir (coloriser)', type: 'checkbox', value: false }],
    apply(img, p) {
      const hsl = [0, 0, 0], rgb = [0, 0, 0];
      return perPixel(img, (d, q) => {
        rgbToHsl01(d[q] / 255, d[q + 1] / 255, d[q + 2] / 255, hsl);
        let h = hsl[0], s = hsl[1], l = hsl[2];
        if (p.colorize) {
          h = (((p.hue + 180) % 360) + 360) % 360 / 360;
          s = (p.sat + 100) / 200;
        } else {
          h = (h + p.hue / 360 + 1) % 1;
          s = clamp(s * (1 + p.sat / 100), 0, 1);
        }
        l = p.light >= 0 ? l + (1 - l) * (p.light / 100) : l * (1 + p.light / 100);
        hslToRgb01(h, s, l, rgb);
        d[q] = rgb[0] * 255; d[q + 1] = rgb[1] * 255; d[q + 2] = rgb[2] * 255;
      });
    },
  },
  {
    id: 'colorbalance', name: 'Balance des couleurs', cat: 'Réglages',
    params: [
      range('sCR', 'Ombres : Cyan ↔ Rouge', -100, 100, 0), range('sMG', 'Ombres : Magenta ↔ Vert', -100, 100, 0), range('sYB', 'Ombres : Jaune ↔ Bleu', -100, 100, 0),
      range('mCR', 'Tons moyens : Cyan ↔ Rouge', -100, 100, 0), range('mMG', 'Tons moyens : Magenta ↔ Vert', -100, 100, 0), range('mYB', 'Tons moyens : Jaune ↔ Bleu', -100, 100, 0),
      range('hCR', 'Hautes lum. : Cyan ↔ Rouge', -100, 100, 0), range('hMG', 'Hautes lum. : Magenta ↔ Vert', -100, 100, 0), range('hYB', 'Hautes lum. : Jaune ↔ Bleu', -100, 100, 0),
      { key: 'preserve', label: 'Conserver la luminosité', type: 'checkbox', value: true },
    ],
    apply(img, p) {
      return perPixel(img, (d, q) => {
        const L = lum(d, q) / 255;
        const ws = Math.pow(1 - L, 2), wh = L * L, wm = Math.max(0, 1 - ws - wh);
        const k = 0.6;
        let r = d[q] + k * (p.sCR * ws + p.mCR * wm + p.hCR * wh);
        let g = d[q + 1] + k * (p.sMG * ws + p.mMG * wm + p.hMG * wh);
        let b = d[q + 2] + k * (p.sYB * ws + p.mYB * wm + p.hYB * wh);
        if (p.preserve) {
          const L2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const diff = L * 255 - L2;
          r += diff; g += diff; b += diff;
        }
        d[q] = r; d[q + 1] = g; d[q + 2] = b;
      });
    },
  },
  {
    id: 'vibrance', name: 'Vibrance', cat: 'Réglages',
    params: [range('vibrance', 'Vibrance', -100, 100, 0), range('saturation', 'Saturation', -100, 100, 0)],
    apply(img, p) {
      return perPixel(img, (d, q) => {
        const L = lum(d, q);
        const mx = Math.max(d[q], d[q + 1], d[q + 2]), mn = Math.min(d[q], d[q + 1], d[q + 2]);
        const k = (1 + p.saturation / 100) * (1 + (p.vibrance / 100) * (1 - (mx - mn) / 255));
        for (let c = 0; c < 3; c++) d[q + c] = L + (d[q + c] - L) * k;
      });
    },
  },
  {
    id: 'bwmix', name: 'Noir et blanc', cat: 'Réglages',
    params: [
      range('r', 'Rouges', -200, 300, 40, 1, ' %'), range('y', 'Jaunes', -200, 300, 60, 1, ' %'), range('g', 'Verts', -200, 300, 40, 1, ' %'),
      range('c', 'Cyans', -200, 300, 60, 1, ' %'), range('b', 'Bleus', -200, 300, 20, 1, ' %'), range('m', 'Magentas', -200, 300, 80, 1, ' %'),
      { key: 'tint', label: 'Virage', type: 'checkbox', value: false }, { key: 'tintColor', label: 'Couleur du virage', type: 'color', value: '#e1c79b' },
    ],
    apply(img, p) {
      const hsl = [0, 0, 0];
      const centers = [[0, p.r], [60, p.y], [120, p.g], [180, p.c], [240, p.b], [300, p.m]];
      const tc = hexToRgb(p.tintColor);
      return perPixel(img, (d, q) => {
        const r = d[q] / 255, g = d[q + 1] / 255, b = d[q + 2] / 255;
        rgbToHsl01(r, g, b, hsl);
        const hue = hsl[0] * 360;
        let wsum = 0, f = 0;
        for (const [c, v] of centers) {
          let dist = Math.abs(hue - c);
          if (dist > 180) dist = 360 - dist;
          const wgt = Math.max(0, 1 - dist / 60);
          f += wgt * v;
          wsum += wgt;
        }
        f = wsum ? f / wsum / 100 : 0.5;
        const base = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const sat = hsl[1];
        let L = base + (f - 0.5) * sat * 0.9 * (1 - Math.abs(hsl[2] * 2 - 1) * 0.5);
        L = clamp(L, 0, 1) * 255;
        if (p.tint) {
          d[q] = (L * tc.r) / 255 * 1.1; d[q + 1] = (L * tc.g) / 255 * 1.1; d[q + 2] = (L * tc.b) / 255 * 1.1;
        } else d[q] = d[q + 1] = d[q + 2] = L;
      });
    },
  },
  {
    id: 'photofilter', name: 'Filtre photo', cat: 'Réglages',
    params: [
      { key: 'preset', label: 'Filtre', type: 'select', value: '#ec8a00', options: [['#ec8a00', 'Réchauffement (85)'], ['#fa9600', 'Réchauffement (LBA)'], ['#006dff', 'Refroidissement (80)'], ['#00b5ff', 'Refroidissement (LBB)'], ['#ea1a1a', 'Rouge'], ['#19c919', 'Vert'], ['#ffd500', 'Jaune'], ['#e8158c', 'Magenta'], ['#ac7a33', 'Sépia'], ['custom', 'Personnalisé']] },
      { key: 'color', label: 'Couleur personnalisée', type: 'color', value: '#ec8a00' },
      range('density', 'Densité', 0, 100, 25, 1, ' %'), { key: 'preserve', label: 'Conserver la luminosité', type: 'checkbox', value: true },
    ],
    apply(img, p) {
      const c = hexToRgb(p.preset === 'custom' ? p.color : p.preset);
      const k = p.density / 100;
      return perPixel(img, (d, q) => {
        const L = lum(d, q);
        let r = d[q] * (1 - k) + ((d[q] * c.r) / 255) * k;
        let g = d[q + 1] * (1 - k) + ((d[q + 1] * c.g) / 255) * k;
        let b = d[q + 2] * (1 - k) + ((d[q + 2] * c.b) / 255) * k;
        if (p.preserve) {
          const L2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const f = L2 > 0 ? L / L2 : 1;
          r *= f; g *= f; b *= f;
        }
        d[q] = r; d[q + 1] = g; d[q + 2] = b;
      });
    },
  },
  {
    id: 'channelmixer', name: 'Mélangeur de couches', cat: 'Réglages',
    params: [
      range('rr', 'Rouge ← Rouge', -200, 200, 100, 1, ' %'), range('rg', 'Rouge ← Vert', -200, 200, 0, 1, ' %'), range('rb', 'Rouge ← Bleu', -200, 200, 0, 1, ' %'),
      range('gr', 'Vert ← Rouge', -200, 200, 0, 1, ' %'), range('gg', 'Vert ← Vert', -200, 200, 100, 1, ' %'), range('gb', 'Vert ← Bleu', -200, 200, 0, 1, ' %'),
      range('br', 'Bleu ← Rouge', -200, 200, 0, 1, ' %'), range('bg', 'Bleu ← Vert', -200, 200, 0, 1, ' %'), range('bb', 'Bleu ← Bleu', -200, 200, 100, 1, ' %'),
      { key: 'mono', label: 'Monochrome', type: 'checkbox', value: false },
    ],
    apply(img, p) {
      return perPixel(img, (d, q) => {
        const r = d[q], g = d[q + 1], b = d[q + 2];
        const nr = (r * p.rr + g * p.rg + b * p.rb) / 100;
        if (p.mono) {
          d[q] = d[q + 1] = d[q + 2] = nr;
          return;
        }
        d[q] = nr;
        d[q + 1] = (r * p.gr + g * p.gg + b * p.gb) / 100;
        d[q + 2] = (r * p.br + g * p.bg + b * p.bb) / 100;
      });
    },
  },
  {
    id: 'gradientmap', name: 'Courbe de transfert de dégradé', cat: 'Réglages',
    params: [{ key: 'c1', label: 'Ombres', type: 'color', value: '#1a0b3d' }, { key: 'c2', label: 'Tons moyens', type: 'color', value: '#d1416b' }, { key: 'c3', label: 'Hautes lumières', type: 'color', value: '#ffe7a8' }, range('mix', 'Opacité', 0, 100, 100, 1, ' %')],
    apply(img, p) {
      const a = hexToRgb(p.c1), b = hexToRgb(p.c2), c = hexToRgb(p.c3);
      const k = p.mix / 100;
      return perPixel(img, (d, q) => {
        const t = lum(d, q) / 255;
        const [x, y, u] = t < 0.5 ? [a, b, t * 2] : [b, c, (t - 0.5) * 2];
        d[q] += (x.r + (y.r - x.r) * u - d[q]) * k;
        d[q + 1] += (x.g + (y.g - x.g) * u - d[q + 1]) * k;
        d[q + 2] += (x.b + (y.b - x.b) * u - d[q + 2]) * k;
      });
    },
  },
  { id: 'invert', name: 'Négatif', cat: 'Réglages', params: [], apply: (img) => perPixel(img, (d, q) => { d[q] = 255 - d[q]; d[q + 1] = 255 - d[q + 1]; d[q + 2] = 255 - d[q + 2]; }) },
  { id: 'desaturate', name: 'Désaturation', cat: 'Réglages', params: [], apply: (img) => perPixel(img, (d, q) => { d[q] = d[q + 1] = d[q + 2] = lum(d, q); }) },
  {
    id: 'posterize', name: 'Isohélie (postérisation)', cat: 'Réglages', params: [range('levels', 'Niveaux', 2, 32, 5)],
    apply(img, p) {
      const n = p.levels - 1;
      return perPixel(img, (d, q) => { for (let c = 0; c < 3; c++) d[q + c] = Math.round((d[q + c] / 255) * n) / n * 255; });
    },
  },
  {
    id: 'threshold', name: 'Seuil', cat: 'Réglages', params: [range('level', 'Seuil', 1, 255, 128)],
    apply: (img, p) => perPixel(img, (d, q) => { d[q] = d[q + 1] = d[q + 2] = lum(d, q) >= p.level ? 255 : 0; }),
  },
  {
    id: 'equalize', name: 'Égaliser', cat: 'Réglages', params: [range('amount', 'Intensité', 0, 100, 100, 1, ' %')],
    apply(img, p) {
      const h = histogram(img).l;
      const cdf = new Float32Array(256);
      let acc = 0, total = 0;
      for (let i = 0; i < 256; i++) total += h[i];
      for (let i = 0; i < 256; i++) { acc += h[i]; cdf[i] = (acc / Math.max(1, total)) * 255; }
      const k = p.amount / 100;
      return perPixel(img, (d, q) => {
        const L = lum(d, q);
        const t = cdf[L | 0];
        const f = L > 0.5 ? t / L : 1;
        for (let c = 0; c < 3; c++) d[q + c] = d[q + c] * (1 - k) + d[q + c] * f * k;
      });
    },
  },
  {
    id: 'autolevels', name: 'Niveaux automatiques', cat: 'Réglages', params: [range('clip', 'Écrêtage', 0, 5, 0.5, 0.1, ' %')],
    apply(img, p) {
      const h = histogram(img);
      const luts = ['r', 'g', 'b'].map((k) => {
        const lo = histPercentile(h[k], p.clip / 100), hi = histPercentile(h[k], 1 - p.clip / 100);
        const lut = new Uint8ClampedArray(256);
        for (let i = 0; i < 256; i++) lut[i] = ((i - lo) / Math.max(1, hi - lo)) * 255;
        return lut;
      });
      return perPixel(img, (d, q) => { d[q] = luts[0][d[q]]; d[q + 1] = luts[1][d[q + 1]]; d[q + 2] = luts[2][d[q + 2]]; });
    },
  },
  {
    id: 'autocontrast', name: 'Contraste automatique', cat: 'Réglages', params: [range('clip', 'Écrêtage', 0, 5, 0.3, 0.1, ' %')],
    apply(img, p) {
      const h = histogram(img).l;
      const lo = histPercentile(h, p.clip / 100), hi = histPercentile(h, 1 - p.clip / 100);
      const f = 255 / Math.max(1, hi - lo);
      return perPixel(img, (d, q) => { for (let c = 0; c < 3; c++) d[q + c] = (d[q + c] - lo) * f; });
    },
  },

  // ---------- Flou ----------
  { id: 'gblur', name: 'Flou gaussien', cat: 'Flou', params: [range('radius', 'Rayon', 0.5, 250, 6, 0.5, ' px')], apply: (img, p, s) => gaussianBlur(img, p.radius * s) },
  {
    id: 'motionblur', name: 'Flou de mouvement', cat: 'Flou', params: [range('angle', 'Angle', -180, 180, 0, 1, '°'), range('distance', 'Distance', 1, 400, 40, 1, ' px')],
    apply(img, p, s) {
      const a = (p.angle * Math.PI) / 180, dist = p.distance * s;
      const vx = Math.cos(a) * dist, vy = -Math.sin(a) * dist;
      return directionalBlur(img, (x, y, v) => { v[0] = vx; v[1] = vy; }, clamp(Math.round(dist), 2, 48));
    },
  },
  {
    id: 'zoomblur', name: 'Flou radial (zoom)', cat: 'Flou', params: [range('amount', 'Intensité', 1, 100, 25), range('cx', 'Centre X', 0, 100, 50, 1, ' %'), range('cy', 'Centre Y', 0, 100, 50, 1, ' %')],
    apply(img, p) {
      const cx = (img.width * p.cx) / 100, cy = (img.height * p.cy) / 100, k = p.amount / 100 * 0.5;
      return directionalBlur(img, (x, y, v) => { v[0] = (x - cx) * k; v[1] = (y - cy) * k; }, 24);
    },
  },
  {
    id: 'spinblur', name: 'Flou rotatif', cat: 'Flou', params: [range('angle', 'Angle', 1, 60, 10, 1, '°'), range('cx', 'Centre X', 0, 100, 50, 1, ' %'), range('cy', 'Centre Y', 0, 100, 50, 1, ' %')],
    apply(img, p) {
      const cx = (img.width * p.cx) / 100, cy = (img.height * p.cy) / 100, a = (p.angle * Math.PI) / 180;
      return directionalBlur(img, (x, y, v) => { v[0] = -(y - cy) * a; v[1] = (x - cx) * a; }, 28);
    },
  },
  {
    id: 'tiltshift', name: 'Tilt-shift (miniature)', cat: 'Flou',
    params: [range('radius', 'Flou', 1, 60, 12, 0.5, ' px'), range('center', 'Position de la zone nette', 0, 100, 55, 1, ' %'), range('width', 'Largeur nette', 2, 80, 18, 1, ' %'), range('feather', 'Transition', 2, 80, 25, 1, ' %'), range('sat', 'Saturation', 0, 100, 30)],
    apply(img, p, s) {
      const b = gaussianBlur(img, p.radius * s).data;
      const { width: w, height: h } = img;
      const c = (p.center / 100) * h, half = (p.width / 200) * h, fe = (p.feather / 100) * h;
      return perPixel(img, (d, q) => {
        const y = ((q / 4) / w) | 0;
        const t = smoothstep(half, half + fe, Math.abs(y - c));
        const L = lum(d, q);
        for (let k = 0; k < 3; k++) {
          const v = d[q + k] + (b[q + k] - d[q + k]) * t;
          d[q + k] = L + (v - L) * (1 + p.sat / 100);
        }
      });
    },
  },
  { id: 'lensblur', name: 'Flou d\'objectif (bokeh)', cat: 'Flou', params: [range('radius', 'Rayon', 1, 60, 10, 0.5, ' px'), range('bright', 'Hautes lumières', 0, 100, 40)],
    apply(img, p, s) {
      // Accentue les hautes lumières avant le flou pour imiter des disques de bokeh.
      const boost = p.bright / 100 * 3;
      const pre = perPixel(img, (d, q) => {
        const L = lum(d, q) / 255;
        const k = 1 + boost * Math.pow(Math.max(0, L - 0.7) / 0.3, 2);
        for (let c = 0; c < 3; c++) d[q + c] = Math.min(255, d[q + c] * k);
      });
      return gaussianBlur(pre, p.radius * s * 0.8);
    },
  },

  // ---------- Netteté ----------
  {
    id: 'unsharp', name: 'Accentuation', cat: 'Netteté',
    params: [range('amount', 'Gain', 1, 500, 120, 1, ' %'), range('radius', 'Rayon', 0.1, 100, 1.5, 0.1, ' px'), range('threshold', 'Seuil', 0, 255, 2)],
    apply: (img, p, s) => unsharp(img, p.amount / 100, Math.max(0.3, p.radius * s), p.threshold),
  },
  { id: 'sharpen', name: 'Plus net', cat: 'Netteté', params: [], apply: (img) => convolve3x3(img, [0, -1, 0, -1, 5, -1, 0, -1, 0]) },
  {
    id: 'highpass', name: 'Passe-haut', cat: 'Netteté', params: [range('radius', 'Rayon', 0.5, 100, 4, 0.5, ' px')],
    apply(img, p, s) {
      const b = gaussianBlur(img, p.radius * s).data;
      return perPixel(img, (d, q) => { for (let c = 0; c < 3; c++) d[q + c] = d[q + c] - b[q + c] + 128; });
    },
  },

  // ---------- Bruit ----------
  {
    id: 'addnoise', name: 'Ajout de bruit', cat: 'Bruit',
    params: [range('amount', 'Quantité', 0, 100, 12, 1, ' %'), { key: 'mono', label: 'Monochromatique', type: 'checkbox', value: true }, range('seed', 'Variante', 0, 99, 1)],
    apply(img, p) {
      const a = (p.amount / 100) * 255;
      let i = 0;
      return perPixel(img, (d, q) => {
        i++;
        if (p.mono) {
          const n = (hash2(i, 3, p.seed) - 0.5) * a;
          d[q] += n; d[q + 1] += n; d[q + 2] += n;
        } else for (let c = 0; c < 3; c++) d[q + c] += (hash2(i, c, p.seed) - 0.5) * a;
      });
    },
  },
  {
    id: 'denoise', name: 'Réduction du bruit', cat: 'Bruit', params: [range('lum', 'Luminance', 0, 100, 40), range('color', 'Couleur', 0, 100, 40)],
    apply: (img, p, s) => reduceNoise(img, p.lum / 100, p.color / 100, s),
  },
  {
    id: 'median', name: 'Médiane', cat: 'Bruit', params: [range('radius', 'Rayon', 1, 4, 1, 1, ' px')],
    apply(img, p) {
      const { width: w, height: h, data } = img;
      const out = copy(img);
      const od = out.data;
      const r = p.radius;
      const buf = [[], [], []];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          buf[0].length = buf[1].length = buf[2].length = 0;
          for (let dy = -r; dy <= r; dy++) {
            const yy = clamp(y + dy, 0, h - 1);
            for (let dx = -r; dx <= r; dx++) {
              const q = (yy * w + clamp(x + dx, 0, w - 1)) * 4;
              buf[0].push(data[q]); buf[1].push(data[q + 1]); buf[2].push(data[q + 2]);
            }
          }
          const q = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) {
            buf[c].sort((a, b) => a - b);
            od[q + c] = buf[c][buf[c].length >> 1];
          }
        }
      return out;
    },
  },
  {
    id: 'dustscratch', name: 'Anti-poussière', cat: 'Bruit', params: [range('radius', 'Rayon', 1, 10, 2, 1, ' px'), range('threshold', 'Seuil', 0, 128, 20)],
    apply(img, p, s) {
      const b = gaussianBlur(img, Math.max(0.5, p.radius * s)).data;
      return perPixel(img, (d, q) => {
        const diff = Math.abs(lum(d, q) - (0.2126 * b[q] + 0.7152 * b[q + 1] + 0.0722 * b[q + 2]));
        if (diff > p.threshold) for (let c = 0; c < 3; c++) d[q + c] = b[q + c];
      });
    },
  },

  // ---------- Stylisation ----------
  {
    id: 'pixelate', name: 'Pixellisation', cat: 'Stylisation', params: [range('size', 'Taille des cellules', 2, 200, 16, 1, ' px')],
    apply(img, p, s) {
      const { width: w, height: h, data } = img;
      const size = Math.max(1, Math.round(p.size * s));
      const out = copy(img);
      const od = out.data;
      for (let y0 = 0; y0 < h; y0 += size)
        for (let x0 = 0; x0 < w; x0 += size) {
          let r = 0, g = 0, b = 0, a = 0, n = 0;
          const y1 = Math.min(h, y0 + size), x1 = Math.min(w, x0 + size);
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const q = (y * w + x) * 4;
            r += data[q]; g += data[q + 1]; b += data[q + 2]; a += data[q + 3]; n++;
          }
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const q = (y * w + x) * 4;
            od[q] = r / n; od[q + 1] = g / n; od[q + 2] = b / n; od[q + 3] = a / n;
          }
        }
      return out;
    },
  },
  {
    id: 'halftone', name: 'Demi-teinte', cat: 'Stylisation', params: [range('size', 'Taille de trame', 3, 60, 10, 1, ' px'), { key: 'color', label: 'Points en couleur', type: 'checkbox', value: false }],
    apply(img, p, s) {
      const { width: w, height: h, data } = img;
      const size = Math.max(2, p.size * s);
      const out = copy(img);
      const od = out.data;
      const cols = Math.ceil(w / size), rows = Math.ceil(h / size);
      const avg = new Float32Array(cols * rows * 4);
      const cnt = new Float32Array(cols * rows);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const ci = ((y / size) | 0) * cols + ((x / size) | 0), q = (y * w + x) * 4;
        avg[ci * 4] += data[q]; avg[ci * 4 + 1] += data[q + 1]; avg[ci * 4 + 2] += data[q + 2];
        cnt[ci]++;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const cxi = (x / size) | 0, cyi = (y / size) | 0, ci = cyi * cols + cxi, q = (y * w + x) * 4;
        const n = cnt[ci];
        const r = avg[ci * 4] / n, g = avg[ci * 4 + 1] / n, b = avg[ci * 4 + 2] / n;
        const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        const rad = (size / 2) * Math.sqrt(1 - L) * 1.35;
        const dx = x - (cxi + 0.5) * size, dy = y - (cyi + 0.5) * size;
        const inside = clamp(rad - Math.sqrt(dx * dx + dy * dy) + 0.5, 0, 1);
        const [fr, fg, fb] = p.color ? [r * 0.6, g * 0.6, b * 0.6] : [15, 15, 20];
        od[q] = 250 + (fr - 250) * inside; od[q + 1] = 248 + (fg - 248) * inside; od[q + 2] = 240 + (fb - 240) * inside;
      }
      return out;
    },
  },
  { id: 'emboss', name: 'Estampage', cat: 'Stylisation', params: [], apply: (img) => convolve3x3(img, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 1, 0) },
  {
    id: 'edges', name: 'Contours (Sobel)', cat: 'Stylisation', params: [{ key: 'invert', label: 'Fond blanc', type: 'checkbox', value: true }, range('strength', 'Intensité', 10, 400, 100, 1, ' %')],
    apply(img, p) {
      const { width: w, height: h } = img;
      const L = luminanceChannel(img);
      const out = copy(img);
      const od = out.data;
      const k = p.strength / 100;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const at = (xx, yy) => L[clamp(yy, 0, h - 1) * w + clamp(xx, 0, w - 1)];
        const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
        const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
        let v = clamp(Math.sqrt(gx * gx + gy * gy) * k, 0, 1) * 255;
        if (p.invert) v = 255 - v;
        const q = (y * w + x) * 4;
        od[q] = od[q + 1] = od[q + 2] = v;
      }
      return out;
    },
  },
  {
    id: 'oil', name: 'Peinture à l\'huile', cat: 'Stylisation', params: [range('radius', 'Taille du pinceau', 1, 20, 5, 1, ' px')],
    apply(img, p, s) {
      // Filtre de Kuwahara accéléré par images intégrales.
      const { width: w, height: h } = img;
      const r = Math.max(1, Math.round(p.radius * s));
      const I = integralImages(img);
      const out = copy(img);
      const od = out.data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let best = Infinity, br = 0, bg = 0, bb = 0;
        const quads = [[x - r, y - r, x, y], [x, y - r, x + r, y], [x - r, y, x, y + r], [x, y, x + r, y + r]];
        for (const [a0, b0, a1, b1] of quads) {
          const x0 = clamp(a0, 0, w - 1), y0 = clamp(b0, 0, h - 1), x1 = clamp(a1, 0, w - 1), y1 = clamp(b1, 0, h - 1);
          const n = (x1 - x0 + 1) * (y1 - y0 + 1);
          const ml = I.rect(I.sl, x0, y0, x1, y1) / n;
          const v = I.rect(I.sl2, x0, y0, x1, y1) / n - ml * ml;
          if (v < best) {
            best = v;
            br = I.rect(I.sr, x0, y0, x1, y1) / n;
            bg = I.rect(I.sg, x0, y0, x1, y1) / n;
            bb = I.rect(I.sb, x0, y0, x1, y1) / n;
          }
        }
        const q = (y * w + x) * 4;
        od[q] = br; od[q + 1] = bg; od[q + 2] = bb;
      }
      return out;
    },
  },
  {
    id: 'sketch', name: 'Croquis au crayon', cat: 'Stylisation', params: [range('radius', 'Épaisseur du trait', 1, 40, 8, 0.5, ' px'), range('color', 'Couleur conservée', 0, 100, 0, 1, ' %')],
    apply(img, p, s) {
      const gray = perPixel(img, (d, q) => { d[q] = d[q + 1] = d[q + 2] = 255 - lum(d, q); });
      const b = gaussianBlur(gray, p.radius * s).data;
      const k = p.color / 100;
      return perPixel(img, (d, q) => {
        const g = lum(d, q);
        const v = clamp((g * 255) / Math.max(1, 255 - b[q]), 0, 255);
        for (let c = 0; c < 3; c++) d[q + c] = v * (1 - k) + ((d[q + c] * v) / 255) * k;
      });
    },
  },
  {
    id: 'cartoon', name: 'Bande dessinée', cat: 'Stylisation', params: [range('levels', 'Niveaux de couleur', 2, 12, 5), range('edge', 'Encrage', 0, 100, 60)],
    apply(img, p, s) {
      const smooth = gaussianBlur(img, 1.5 * s);
      const { width: w, height: h } = img;
      const L = luminanceChannel(smooth);
      const n = p.levels - 1;
      const out = copy(smooth);
      const od = out.data;
      const thr = 1 - p.edge / 100 * 0.85;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, q = i * 4;
        const gx = L[i + (x < w - 1 ? 1 : 0)] - L[i - (x > 0 ? 1 : 0)];
        const gy = L[i + (y < h - 1 ? w : 0)] - L[i - (y > 0 ? w : 0)];
        const edge = Math.sqrt(gx * gx + gy * gy) * 4 > thr;
        for (let c = 0; c < 3; c++) od[q + c] = edge ? 20 : Math.round((od[q + c] / 255) * n) / n * 255;
      }
      return out;
    },
  },
  {
    id: 'glow', name: 'Lueur diffuse (Orton)', cat: 'Stylisation', params: [range('radius', 'Rayon', 2, 80, 18, 1, ' px'), range('amount', 'Intensité', 0, 100, 45, 1, ' %'), range('bright', 'Luminosité', -50, 50, 10)],
    apply(img, p, s) {
      const b = gaussianBlur(img, p.radius * s).data;
      const k = p.amount / 100;
      return perPixel(img, (d, q) => {
        for (let c = 0; c < 3; c++) {
          const a = d[q + c] / 255, bb = b[q + c] / 255;
          const screen = 1 - (1 - a) * (1 - bb);
          d[q + c] = (a + (screen - a) * k) * 255 + p.bright;
        }
      });
    },
  },
  {
    id: 'glitch', name: 'Glitch numérique', cat: 'Stylisation', params: [range('shift', 'Décalage RVB', 0, 60, 10, 1, ' px'), range('slices', 'Tranches', 0, 60, 12), range('seed', 'Variante', 0, 99, 3)],
    apply(img, p, s) {
      const { width: w, height: h, data } = img;
      const out = copy(img);
      const od = out.data;
      const sh = Math.round(p.shift * s);
      const rowShift = new Int32Array(h);
      for (let i = 0; i < p.slices; i++) {
        const y0 = Math.floor(hash2(i, 1, p.seed) * h), hh = Math.ceil(hash2(i, 2, p.seed) * h * 0.06) + 1;
        const off = Math.round((hash2(i, 3, p.seed) - 0.5) * w * 0.15);
        for (let y = y0; y < Math.min(h, y0 + hh); y++) rowShift[y] = off;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const q = (y * w + x) * 4;
        const bx = x - rowShift[y];
        const rq = (y * w + clamp(bx - sh, 0, w - 1)) * 4, gq = (y * w + clamp(bx, 0, w - 1)) * 4, bq = (y * w + clamp(bx + sh, 0, w - 1)) * 4;
        od[q] = data[rq]; od[q + 1] = data[gq + 1]; od[q + 2] = data[bq + 2];
      }
      return out;
    },
  },
  {
    id: 'vignettefx', name: 'Vignetage', cat: 'Stylisation', params: [range('amount', 'Intensité', -100, 100, -50), range('size', 'Taille', 0, 100, 50), range('feather', 'Contour progressif', 0, 100, 60), { key: 'color', label: 'Couleur', type: 'color', value: '#000000' }],
    apply(img, p) {
      const { width: w, height: h } = img;
      const c = hexToRgb(p.color);
      const mid = 0.3 + (p.size / 100) * 0.6, fe = 0.05 + (p.feather / 100) * 0.8;
      const k = Math.abs(p.amount) / 100;
      const target = p.amount < 0 ? c : { r: 255, g: 255, b: 255 };
      let i = 0;
      return perPixel(img, (d, q) => {
        const x = i % w, y = (i / w) | 0;
        i++;
        const dx = (x - w / 2) / (w / 2), dy = (y - h / 2) / (h / 2);
        const t = smoothstep(mid - fe / 2, mid + fe / 2, Math.sqrt(dx * dx + dy * dy) / Math.SQRT2) * k;
        d[q] += (target.r - d[q]) * t; d[q + 1] += (target.g - d[q + 1]) * t; d[q + 2] += (target.b - d[q + 2]) * t;
      });
    },
  },
  {
    id: 'duotone', name: 'Bichromie', cat: 'Stylisation', params: [{ key: 'dark', label: 'Couleur sombre', type: 'color', value: '#1d2b64' }, { key: 'light', label: 'Couleur claire', type: 'color', value: '#f8cdda' }, range('contrast', 'Contraste', -50, 50, 10)],
    apply(img, p) {
      const a = hexToRgb(p.dark), b = hexToRgb(p.light);
      const f = 1 + p.contrast / 100;
      return perPixel(img, (d, q) => {
        const t = clamp((lum(d, q) / 255 - 0.5) * f + 0.5, 0, 1);
        d[q] = a.r + (b.r - a.r) * t; d[q + 1] = a.g + (b.g - a.g) * t; d[q + 2] = a.b + (b.b - a.b) * t;
      });
    },
  },
  {
    id: 'solarize', name: 'Solarisation', cat: 'Stylisation', params: [range('threshold', 'Seuil', 0, 255, 128)],
    apply: (img, p) => perPixel(img, (d, q) => { for (let c = 0; c < 3; c++) if (d[q + c] > p.threshold) d[q + c] = 255 - d[q + c]; }),
  },
  {
    id: 'chromatic', name: 'Aberration chromatique', cat: 'Stylisation', params: [range('amount', 'Intensité', 0, 30, 4, 0.5, ' px')],
    apply(img, p, s) {
      const { width: w, height: h, data } = img;
      const out = copy(img);
      const od = out.data;
      const k = (p.amount * s) / Math.max(w, h) * 2;
      const px = [0, 0, 0, 0];
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const q = (y * w + x) * 4;
        const dx = x - w / 2, dy = y - h / 2;
        sampleBilinear(data, w, h, x + dx * k, y + dy * k, px);
        od[q] = px[0];
        sampleBilinear(data, w, h, x - dx * k, y - dy * k, px);
        od[q + 2] = px[2];
      }
      return out;
    },
  },
  {
    id: 'lightleak', name: 'Fuite de lumière', cat: 'Stylisation', params: [{ key: 'color', label: 'Couleur', type: 'color', value: '#ff7a3d' }, range('amount', 'Intensité', 0, 100, 55), range('pos', 'Position', 0, 100, 15, 1, ' %'), range('size', 'Taille', 10, 100, 45, 1, ' %')],
    apply(img, p) {
      const { width: w, height: h } = img;
      const c = hexToRgb(p.color);
      const cx = (p.pos / 100) * w, cy = h * 0.2, rad = (p.size / 100) * Math.max(w, h);
      const k = p.amount / 100;
      let i = 0;
      return perPixel(img, (d, q) => {
        const x = i % w, y = (i / w) | 0;
        i++;
        const dist = Math.hypot(x - cx, y - cy) / rad;
        const t = Math.max(0, 1 - dist) ** 2 * k;
        d[q] = 255 - (255 - d[q]) * (1 - (c.r / 255) * t);
        d[q + 1] = 255 - (255 - d[q + 1]) * (1 - (c.g / 255) * t);
        d[q + 2] = 255 - (255 - d[q + 2]) * (1 - (c.b / 255) * t);
      });
    },
  },

  // ---------- Déformation ----------
  {
    id: 'twirl', name: 'Tourbillon', cat: 'Déformation', params: [range('angle', 'Angle', -720, 720, 180, 1, '°'), range('radius', 'Rayon', 5, 100, 60, 1, ' %')],
    apply(img, p) {
      const { width: w, height: h } = img;
      const cx = w / 2, cy = h / 2, R = (p.radius / 100) * Math.min(w, h) / 2 * 1.4;
      const ang = (p.angle * Math.PI) / 180;
      return warp(img, (x, y, s) => {
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
        if (d >= R) return false;
        const a = ang * Math.pow(1 - d / R, 2);
        const cos = Math.cos(a), sin = Math.sin(a);
        s[0] = cx + dx * cos - dy * sin;
        s[1] = cy + dx * sin + dy * cos;
        return true;
      });
    },
  },
  {
    id: 'spherize', name: 'Sphérisation', cat: 'Déformation', params: [range('amount', 'Intensité', -100, 100, 60, 1, ' %'), range('radius', 'Rayon', 5, 100, 70, 1, ' %')],
    apply(img, p) {
      const { width: w, height: h } = img;
      const cx = w / 2, cy = h / 2, R = (p.radius / 100) * Math.min(w, h) / 2;
      const k = p.amount / 100;
      return warp(img, (x, y, s) => {
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
        if (d >= R || d === 0) return false;
        const r = d / R;
        const nr = k >= 0 ? Math.pow(r, 1 + k) : Math.pow(r, 1 / (1 - k));
        s[0] = cx + (dx / d) * nr * R;
        s[1] = cy + (dy / d) * nr * R;
        return true;
      });
    },
  },
  {
    id: 'ripple', name: 'Ondulation', cat: 'Déformation', params: [range('amp', 'Amplitude', 0, 60, 8, 1, ' px'), range('wave', 'Longueur d\'onde', 5, 300, 60, 1, ' px'), { key: 'mode', label: 'Type', type: 'select', value: 'waves', options: [['waves', 'Vagues'], ['water', 'Ronds dans l\'eau']] }],
    apply(img, p, s) {
      const { width: w, height: h } = img;
      const amp = p.amp * s, wl = Math.max(2, p.wave * s);
      const cx = w / 2, cy = h / 2;
      return warp(img, (x, y, o) => {
        if (p.mode === 'water') {
          const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1;
          const off = Math.sin((d / wl) * Math.PI * 2) * amp;
          o[0] = x + (dx / d) * off;
          o[1] = y + (dy / d) * off;
        } else {
          o[0] = x + Math.sin((y / wl) * Math.PI * 2) * amp;
          o[1] = y + Math.sin((x / wl) * Math.PI * 2) * amp;
        }
        return true;
      });
    },
  },
  {
    id: 'pinch', name: 'Pincement', cat: 'Déformation', params: [range('amount', 'Intensité', -100, 100, 50, 1, ' %')],
    apply(img, p) {
      const { width: w, height: h } = img;
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;
      const k = p.amount / 100;
      return warp(img, (x, y, s) => {
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
        if (d >= R || d === 0) return false;
        const f = Math.pow(Math.sin((Math.PI / 2) * (d / R)), -k);
        s[0] = cx + dx * f;
        s[1] = cy + dy * f;
        return true;
      });
    },
  },
  {
    id: 'polar', name: 'Coordonnées polaires', cat: 'Déformation', params: [{ key: 'mode', label: 'Conversion', type: 'select', value: 'toPolar', options: [['toPolar', 'Rectangulaire → polaire'], ['toRect', 'Polaire → rectangulaire']] }],
    apply(img, p) {
      const { width: w, height: h } = img;
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;
      return warp(img, (x, y, s) => {
        if (p.mode === 'toPolar') {
          const dx = x - cx, dy = y - cy;
          const a = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI);
          s[0] = a * (w - 1);
          s[1] = (Math.hypot(dx, dy) / R) * (h - 1);
        } else {
          const a = (x / w) * 2 * Math.PI - Math.PI, r = (y / h) * R;
          s[0] = cx + Math.cos(a) * r;
          s[1] = cy + Math.sin(a) * r;
        }
        return true;
      });
    },
  },
];

export const FILTER_CATEGORIES = ['Flou', 'Netteté', 'Bruit', 'Stylisation', 'Déformation'];
export const filterById = (id) => FILTERS.find((f) => f.id === id);
export const defaultValues = (f) => Object.fromEntries(f.params.map((p) => [p.key, p.value]));

// blurChannel est réexporté pour les outils qui en ont besoin.
export { blurChannel };
