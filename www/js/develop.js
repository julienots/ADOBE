// Moteur de « Développement » façon studio photo : lumière, couleur, courbes, TSL,
// étalonnage, détail et effets, dans un seul passage pixel optimisé.

import { clamp, smoothstep, rgbToHsl01, hslToRgb01 } from './util.js';
import { blurChannel, curveLUT, isIdentityCurve, hash2, histogram, histPercentile, gaussianBlur } from './imaging.js';

export const HSL_BANDS = [
  ['red', 'Rouges', 0, '#e5484d'],
  ['orange', 'Oranges', 30, '#f76b15'],
  ['yellow', 'Jaunes', 60, '#ffc53d'],
  ['green', 'Verts', 120, '#46a758'],
  ['aqua', 'Turquoises', 180, '#12a594'],
  ['blue', 'Bleus', 225, '#0090ff'],
  ['purple', 'Violets', 275, '#8e4ec6'],
  ['magenta', 'Magentas', 320, '#d6409f'],
];

export function defaultParams() {
  const hsl = {};
  for (const [k] of HSL_BANDS) hsl[k] = { h: 0, s: 0, l: 0 };
  const ident = () => [[0, 0], [1, 1]];
  return {
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    temperature: 0, tint: 0, vibrance: 0, saturation: 0,
    texture: 0, clarity: 0, dehaze: 0,
    hsl,
    curves: { rgb: ident(), r: ident(), g: ident(), b: ident() },
    grade: { shadows: { h: 220, s: 0 }, midtones: { h: 30, s: 0 }, highlights: { h: 45, s: 0 }, balance: 0 },
    sharpen: 0, sharpenRadius: 1, noise: 0, colorNoise: 0,
    vignette: 0, vignetteMid: 50, vignetteFeather: 50, grain: 0, grainSize: 1.5,
    fade: 0, bw: false,
  };
}

export const cloneParams = (p) => JSON.parse(JSON.stringify(p));

export function isDefault(p) {
  return JSON.stringify(p) === JSON.stringify(defaultParams());
}

// Fusionne un préréglage partiel avec les valeurs par défaut.
export function withDefaults(partial) {
  const p = defaultParams();
  const merge = (dst, src) => {
    for (const [k, v] of Object.entries(src || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') merge(dst[k], v);
      else dst[k] = Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v;
    }
  };
  merge(p, partial);
  return p;
}

// Interpole les réglages entre les valeurs neutres et `p` (curseur d'intensité des looks).
export function scaleParams(p, amount) {
  if (amount === 1) return cloneParams(p);
  const d = defaultParams();
  const walk = (a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return b + (a - b) * amount;
    if (Array.isArray(a)) {
      // Courbes : on rapproche chaque point de la diagonale.
      return a.map((pt) => [pt[0], pt[1] + (pt[0] - pt[1]) * (1 - amount)]);
    }
    if (a && typeof a === 'object') {
      const o = {};
      // Dans l'étalonnage, `h` est un angle de teinte : on ne l'interpole pas.
      const isGradeHue = !('l' in a);
      for (const k of Object.keys(a)) o[k] = k === 'h' && isGradeHue ? a[k] : walk(a[k], b ? b[k] : undefined);
      return o;
    }
    return a;
  };
  const out = walk(p, d);
  out.bw = p.bw && amount > 0.5;
  return out;
}

const SRGB_TO_LIN = new Float32Array(4096);
const LIN_TO_SRGB = new Float32Array(4096);
for (let i = 0; i < 4096; i++) {
  const v = i / 4095;
  SRGB_TO_LIN[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  LIN_TO_SRGB[i] = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}
const toLin = (v) => SRGB_TO_LIN[(v <= 0 ? 0 : v >= 1 ? 1 : v) * 4095 | 0];
const toSrgb = (v) => LIN_TO_SRGB[(v <= 0 ? 0 : v >= 1 ? 1 : v) * 4095 | 0];

// Table de tonalité (contraste, hautes lumières, ombres, blancs, noirs).
function toneLUT(p) {
  const n = 1024;
  const lut = new Float32Array(n);
  const c = p.contrast / 100;
  const a = Math.pow(2, c * 1.3);
  const b0 = -p.blacks / 100 * 0.18;
  const w0 = 1 - p.whites / 100 * 0.18;
  for (let i = 0; i < n; i++) {
    let x = i / (n - 1);
    x = (x - b0) / (w0 - b0);
    x = clamp(x, 0, 1);
    const sw = Math.exp(-Math.pow((x - 0.18) / 0.22, 2));
    const hw = Math.exp(-Math.pow((x - 0.82) / 0.22, 2));
    x += (p.shadows / 100) * 0.28 * sw * (p.shadows > 0 ? 1 - x : x + 0.2);
    x += (p.highlights / 100) * 0.28 * hw * (p.highlights < 0 ? x : 1 - x + 0.2);
    x = clamp(x, 0, 1);
    if (c !== 0) x = x < 0.5 ? 0.5 * Math.pow(2 * x, a) : 1 - 0.5 * Math.pow(2 * (1 - x), a);
    if (p.fade) x = (p.fade / 100) * 0.12 + x * (1 - (p.fade / 100) * 0.16);
    lut[i] = x;
  }
  return lut;
}

function hueToRgb(h) {
  const out = [0, 0, 0];
  hslToRgb01(((h % 360) + 360) % 360 / 360, 1, 0.5, out);
  return out;
}

/**
 * Applique les réglages à une ImageData et renvoie une nouvelle ImageData.
 * `scale` : rapport entre l'image traitée et l'image réelle (aperçu réduit) pour les rayons.
 */
export function develop(src, p, scale = 1) {
  const { width: w, height: h } = src;
  const sd = src.data;
  const out = new ImageData(new Uint8ClampedArray(sd), w, h);
  const od = out.data;
  const n = w * h;

  const tone = toneLUT(p);
  const toneIdentity = !p.contrast && !p.highlights && !p.shadows && !p.whites && !p.blacks && !p.fade;
  const expMul = Math.pow(2, p.exposure);
  const temp = p.temperature / 100, tint = p.tint / 100;
  const wbR = 1 + temp * 0.32 + tint * 0.12, wbG = 1 - tint * 0.25, wbB = 1 - temp * 0.32 + tint * 0.12;
  const sat = p.saturation / 100, vib = p.vibrance / 100;

  const curves = {};
  let anyCurve = false;
  for (const k of ['rgb', 'r', 'g', 'b']) {
    if (!isIdentityCurve(p.curves[k])) {
      curves[k] = curveLUT(p.curves[k], 1024);
      anyCurve = true;
    }
  }

  const hslActive = HSL_BANDS.some(([k]) => p.hsl[k].h || p.hsl[k].s || p.hsl[k].l);
  const hslBands = HSL_BANDS.map(([k, , center]) => ({ c: center / 360, ...p.hsl[k] }));

  const g = p.grade;
  const gradeActive = g.shadows.s || g.midtones.s || g.highlights.s;
  const gS = hueToRgb(g.shadows.h), gM = hueToRgb(g.midtones.h), gH = hueToRgb(g.highlights.h);
  const gBal = g.balance / 100;

  // Contraste local (clarté / texture / correction du voile) : luminance floutée.
  let blurL = null, blurT = null, dark = null;
  if (p.clarity || p.dehaze) {
    blurL = new Float32Array(n);
    for (let i = 0, q = 0; i < n; i++, q += 4) blurL[i] = (0.2126 * sd[q] + 0.7152 * sd[q + 1] + 0.0722 * sd[q + 2]) / 255;
    blurChannel(blurL, w, h, Math.max(w, h) * 0.012);
  }
  if (p.texture) {
    blurT = new Float32Array(n);
    for (let i = 0, q = 0; i < n; i++, q += 4) blurT[i] = (0.2126 * sd[q] + 0.7152 * sd[q + 1] + 0.0722 * sd[q + 2]) / 255;
    blurChannel(blurT, w, h, Math.max(1, 2.5 * scale));
  }
  if (p.dehaze) {
    dark = new Float32Array(n);
    for (let i = 0, q = 0; i < n; i++, q += 4) dark[i] = Math.min(sd[q], sd[q + 1], sd[q + 2]) / 255;
    blurChannel(dark, w, h, Math.max(w, h) * 0.02);
  }

  const vig = p.vignette / 100;
  const vigMid = 0.25 + (p.vignetteMid / 100) * 0.6;
  const vigFeather = 0.1 + (p.vignetteFeather / 100) * 0.7;
  const cx = w / 2, cy = h / 2;
  const grain = p.grain / 100;
  const grainSize = Math.max(0.5, p.grainSize * scale);
  const dehaze = p.dehaze / 100, clarity = p.clarity / 100, texture = p.texture / 100;
  const hsl = [0, 0, 0], rgb = [0, 0, 0];

  for (let i = 0, q = 0; i < n; i++, q += 4) {
    if (sd[q + 3] === 0) continue;
    let r = sd[q] / 255, gg = sd[q + 1] / 255, b = sd[q + 2] / 255;

    // Correction du voile
    if (dehaze) {
      const haze = dark[i];
      if (dehaze > 0) {
        const t = Math.max(0.25, 1 - dehaze * 0.85 * haze);
        const A = 0.95;
        r = (r - A * (1 - t)) / t;
        gg = (gg - A * (1 - t)) / t;
        b = (b - A * (1 - t)) / t;
      } else {
        const k = -dehaze * 0.55;
        r = r * (1 - k) + 0.85 * k;
        gg = gg * (1 - k) + 0.86 * k;
        b = b * (1 - k) + 0.88 * k;
      }
    }

    // Balance des blancs + exposition (en linéaire)
    if (temp || tint || p.exposure) {
      r = toSrgb(toLin(r) * wbR * expMul);
      gg = toSrgb(toLin(gg) * wbG * expMul);
      b = toSrgb(toLin(b) * wbB * expMul);
    }

    // Tonalité
    let L = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    if (!toneIdentity) {
      const L2 = tone[(L <= 0 ? 0 : L >= 1 ? 1 : L) * 1023 | 0];
      if (L > 0.0005) {
        const k = L2 / L;
        r *= k; gg *= k; b *= k;
      } else {
        r = gg = b = L2;
      }
      L = L2;
    }

    // Clarté / texture : renforcement du contraste local dans les tons moyens
    if (clarity) {
      const mid = 4 * L * (1 - L);
      const delta = (L - blurL[i]) * clarity * 1.6 * mid;
      r += delta; gg += delta; b += delta;
    }
    if (texture) {
      const delta = (L - blurT[i]) * texture * 1.8;
      r += delta; gg += delta; b += delta;
    }

    // Courbes
    if (anyCurve) {
      if (curves.r) r = curves.r[(r <= 0 ? 0 : r >= 1 ? 1 : r) * 1023 | 0];
      if (curves.g) gg = curves.g[(gg <= 0 ? 0 : gg >= 1 ? 1 : gg) * 1023 | 0];
      if (curves.b) b = curves.b[(b <= 0 ? 0 : b >= 1 ? 1 : b) * 1023 | 0];
      if (curves.rgb) {
        r = curves.rgb[(r <= 0 ? 0 : r >= 1 ? 1 : r) * 1023 | 0];
        gg = curves.rgb[(gg <= 0 ? 0 : gg >= 1 ? 1 : gg) * 1023 | 0];
        b = curves.rgb[(b <= 0 ? 0 : b >= 1 ? 1 : b) * 1023 | 0];
      }
    }

    // TSL par couleur
    if (hslActive) {
      rgbToHsl01(clamp(r, 0, 1), clamp(gg, 0, 1), clamp(b, 0, 1), hsl);
      let hh = hsl[0], ss = hsl[1], ll = hsl[2];
      if (ss > 0.02) {
        let dh = 0, ds = 0, dl = 0;
        for (const band of hslBands) {
          let dist = Math.abs(hh - band.c);
          if (dist > 0.5) dist = 1 - dist;
          const wgt = 1 - smoothstep(0, 0.1, dist);
          if (wgt <= 0) continue;
          dh += wgt * band.h;
          ds += wgt * band.s;
          dl += wgt * band.l;
        }
        const satW = Math.min(1, ss * 2);
        hh = (hh + (dh / 100) * 0.08 + 1) % 1;
        ss = clamp(ss * (1 + ds / 100), 0, 1);
        ll = clamp(ll + (dl / 100) * 0.25 * satW, 0, 1);
        hslToRgb01(hh, ss, ll, rgb);
        r = rgb[0]; gg = rgb[1]; b = rgb[2];
      }
    }

    // Vibrance et saturation
    if (sat || vib) {
      const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      const cs = mx - mn;
      let k = 1 + sat;
      if (vib) k *= 1 + vib * (1 - Math.min(1, cs * 1.5)) * (vib > 0 ? 1.2 : 1);
      r = lum + (r - lum) * k;
      gg = lum + (gg - lum) * k;
      b = lum + (b - lum) * k;
    }

    // Étalonnage couleur (ombres / tons moyens / hautes lumières)
    if (gradeActive) {
      const lum = clamp(0.2126 * r + 0.7152 * gg + 0.0722 * b - gBal * 0.25, 0, 1);
      const ws = Math.pow(1 - lum, 2), wh = lum * lum, wm = Math.max(0, 1 - ws - wh);
      const s1 = (g.shadows.s / 100) * ws * 0.35, s2 = (g.midtones.s / 100) * wm * 0.35, s3 = (g.highlights.s / 100) * wh * 0.35;
      r += (gS[0] - 0.5) * s1 + (gM[0] - 0.5) * s2 + (gH[0] - 0.5) * s3;
      gg += (gS[1] - 0.5) * s1 + (gM[1] - 0.5) * s2 + (gH[1] - 0.5) * s3;
      b += (gS[2] - 0.5) * s1 + (gM[2] - 0.5) * s2 + (gH[2] - 0.5) * s3;
    }

    // Noir et blanc
    if (p.bw) {
      const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      r = gg = b = lum;
    }

    // Vignetage
    if (vig) {
      const x = i % w, y = (i / w) | 0;
      const dx = (x - cx) / cx, dy = (y - cy) / cy;
      const dist = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2;
      const f = smoothstep(vigMid - vigFeather / 2, vigMid + vigFeather / 2, dist);
      if (vig < 0) {
        const k = 1 + vig * f;
        r *= k; gg *= k; b *= k;
      } else {
        r += (1 - r) * vig * f;
        gg += (1 - gg) * vig * f;
        b += (1 - b) * vig * f;
      }
    }

    // Grain argentique
    if (grain) {
      const x = i % w, y = (i / w) | 0;
      const nz = (hash2((x / grainSize) | 0, (y / grainSize) | 0, 7) - 0.5) * grain * 0.28;
      r += nz; gg += nz; b += nz;
    }

    od[q] = r * 255;
    od[q + 1] = gg * 255;
    od[q + 2] = b * 255;
  }

  let result = out;
  if (p.noise || p.colorNoise) result = reduceNoise(result, p.noise / 100, p.colorNoise / 100, scale);
  if (p.sharpen) result = unsharp(result, p.sharpen / 100 * 1.5, Math.max(0.4, p.sharpenRadius * scale), 2);
  return result;
}

// Réduction du bruit : flou guidé par les contours (luminance) et flou chroma.
export function reduceNoise(img, lumAmount, colorAmount, scale = 1) {
  const { width: w, height: h, data } = img;
  const out = new ImageData(new Uint8ClampedArray(data), w, h);
  const od = out.data;
  const blurred = gaussianBlur(img, Math.max(0.6, 1.6 * scale * (0.5 + lumAmount)));
  const bd = blurred.data;
  const cblur = colorAmount ? gaussianBlur(img, Math.max(1, 4 * scale)).data : null;
  const thr = 10 + 50 * lumAmount;
  for (let q = 0; q < data.length; q += 4) {
    let r = data[q], g = data[q + 1], b = data[q + 2];
    if (lumAmount) {
      const diff = Math.abs(r - bd[q]) + Math.abs(g - bd[q + 1]) + Math.abs(b - bd[q + 2]);
      const k = lumAmount * (1 - smoothstep(thr * 0.5, thr * 1.5, diff));
      r += (bd[q] - r) * k;
      g += (bd[q + 1] - g) * k;
      b += (bd[q + 2] - b) * k;
    }
    if (cblur) {
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      const Lb = 0.299 * cblur[q] + 0.587 * cblur[q + 1] + 0.114 * cblur[q + 2];
      const k = colorAmount;
      r += ((cblur[q] - Lb + L) - r) * k;
      g += ((cblur[q + 1] - Lb + L) - g) * k;
      b += ((cblur[q + 2] - Lb + L) - b) * k;
    }
    od[q] = r; od[q + 1] = g; od[q + 2] = b;
  }
  return out;
}

// Accentuation (masque flou) avec seuil.
export function unsharp(img, amount, radius, threshold = 0) {
  const blurred = gaussianBlur(img, radius).data;
  const { data } = img;
  const out = new ImageData(new Uint8ClampedArray(data), img.width, img.height);
  const od = out.data;
  for (let q = 0; q < data.length; q += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = data[q + c] - blurred[q + c];
      if (Math.abs(diff) >= threshold) od[q + c] = data[q + c] + diff * amount;
    }
  }
  return out;
}

// Réglages automatiques à partir de l'histogramme (exposition, contraste, balance des blancs).
export function autoParams(imageData) {
  const hst = histogram(imageData, Math.max(1, Math.floor(imageData.data.length / 4 / 300_000)));
  const lo = histPercentile(hst.l, 0.005), hi = histPercentile(hst.l, 0.995), med = histPercentile(hst.l, 0.5);
  const p = defaultParams();
  p.exposure = clamp(Math.log2(118 / Math.max(8, med)) * 0.7, -2, 2);
  p.blacks = clamp(-(lo / 255) * 160, -60, 20);
  p.whites = clamp(((255 - hi) / 255) * 160, -20, 60);
  const spread = (hi - lo) / 255;
  p.contrast = clamp((0.85 - spread) * 60, -20, 35);
  p.shadows = med < 90 ? 25 : 10;
  p.highlights = hi > 245 ? -35 : -15;
  // Balance des blancs « monde gris » sur les tons moyens
  const meanOf = (hh) => {
    let s = 0, c = 0;
    for (let i = 0; i < 256; i++) {
      s += hh[i] * i;
      c += hh[i];
    }
    return s / Math.max(1, c);
  };
  const mr = meanOf(hst.r), mg = meanOf(hst.g), mb = meanOf(hst.b);
  p.temperature = clamp(((mb - mr) / 255) * 220, -40, 40);
  p.tint = clamp(((mg - (mr + mb) / 2) / 255) * 260, -30, 30);
  p.vibrance = 18;
  return p;
}

// ---------- Looks (préréglages créatifs) ----------

export const LOOKS = [
  { id: 'none', name: 'Original', params: {} },
  { id: 'auto', name: 'Auto', auto: true },
  { id: 'vivid', name: 'Éclatant', params: { contrast: 18, vibrance: 40, saturation: 10, clarity: 12, highlights: -15, shadows: 12 } },
  { id: 'cinema', name: 'Cinéma', params: { contrast: 20, saturation: -12, highlights: -25, shadows: 15, grade: { shadows: { h: 190, s: 45 }, highlights: { h: 35, s: 40 } }, curves: { rgb: [[0, 0.05], [0.25, 0.22], [0.75, 0.8], [1, 0.95]] }, vignette: -20 } },
  { id: 'tealorange', name: 'Teal & Orange', params: { contrast: 15, vibrance: 25, hsl: { orange: { s: 25, l: 8 }, aqua: { h: 15, s: 30 }, blue: { h: -15, s: 20 }, green: { h: 40, s: -30 } }, grade: { shadows: { h: 195, s: 35 }, highlights: { h: 30, s: 30 } } } },
  { id: 'bw', name: 'Noir & blanc', params: { bw: true, contrast: 15, clarity: 10 } },
  { id: 'bwhard', name: 'N&B contrasté', params: { bw: true, contrast: 55, clarity: 35, blacks: -25, whites: 20, vignette: -25, grain: 18 } },
  { id: 'bwsoft', name: 'N&B doux', params: { bw: true, contrast: -15, fade: 40, shadows: 25 } },
  { id: 'vintage', name: 'Vintage', params: { fade: 45, saturation: -20, temperature: 18, contrast: -8, grade: { shadows: { h: 200, s: 25 }, highlights: { h: 45, s: 35 } }, grain: 25, vignette: -25 } },
  { id: 'sepia', name: 'Sépia', params: { saturation: -100, grade: { shadows: { h: 30, s: 60 }, midtones: { h: 35, s: 55 }, highlights: { h: 45, s: 40 } }, fade: 20, contrast: 8 } },
  { id: 'warm', name: 'Chaleureux', params: { temperature: 30, tint: 5, vibrance: 15, highlights: -10 } },
  { id: 'cold', name: 'Glacial', params: { temperature: -30, tint: -5, saturation: -10, contrast: 10, clarity: 8 } },
  { id: 'pastel', name: 'Pastel', params: { contrast: -25, fade: 35, exposure: 0.25, saturation: -15, vibrance: 15, highlights: -20 } },
  { id: 'matte', name: 'Mat', params: { fade: 60, contrast: 8, saturation: -8 } },
  { id: 'drama', name: 'Dramatique', params: { contrast: 35, clarity: 55, dehaze: 20, highlights: -55, shadows: 40, vibrance: -10, vignette: -35 } },
  { id: 'lomo', name: 'Lomo', params: { contrast: 40, saturation: 30, vignette: -60, vignetteMid: 30, curves: { r: [[0, 0], [0.3, 0.25], [0.7, 0.8], [1, 1]], b: [[0, 0.1], [1, 0.9]] } } },
  { id: 'portrait', name: 'Portrait doux', params: { texture: -30, clarity: -15, exposure: 0.15, hsl: { orange: { l: 12, s: -8 }, red: { s: -10 } }, highlights: -10, vibrance: 10 } },
  { id: 'landscape', name: 'Paysage', params: { dehaze: 25, clarity: 25, vibrance: 35, hsl: { blue: { s: 20, l: -15 }, green: { s: 20, h: -10 } }, highlights: -30, shadows: 20 } },
  { id: 'night', name: 'Nuit', params: { temperature: -25, exposure: -0.4, contrast: 25, grade: { shadows: { h: 230, s: 50 } }, saturation: -20, noise: 30 } },
  { id: 'golden', name: 'Heure dorée', params: { temperature: 35, tint: 10, highlights: -20, grade: { highlights: { h: 40, s: 50 }, midtones: { h: 30, s: 15 } }, vibrance: 20 } },
  { id: 'faded', name: 'Délavé', params: { fade: 50, saturation: -35, contrast: -10, temperature: 8 } },
  { id: 'pop', name: 'Pop', params: { saturation: 45, contrast: 30, clarity: 15, blacks: -15 } },
  { id: 'film', name: 'Pellicule', params: { curves: { rgb: [[0, 0.06], [0.3, 0.27], [0.7, 0.75], [1, 0.96]], g: [[0, 0.02], [1, 1]] }, grain: 30, grainSize: 2, saturation: -8, grade: { shadows: { h: 160, s: 20 }, highlights: { h: 40, s: 20 } } } },
  { id: 'cyber', name: 'Cyberpunk', params: { temperature: -20, tint: 35, contrast: 25, saturation: 25, grade: { shadows: { h: 260, s: 60 }, highlights: { h: 320, s: 45 } }, clarity: 20 } },
];
