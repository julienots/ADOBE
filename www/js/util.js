// Fonctions utilitaires partagées : DOM, canvas, couleurs, maths.

export const APP_NAME = 'Prisme';
export const APP_VERSION = '1.0.0';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

let uidCounter = 0;
export const uid = () => `${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

export function debounce(fn, ms) {
  let t;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

// Regroupe les appels dans la prochaine frame d'animation.
export function rafThrottle(fn) {
  let pending = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      fn(...lastArgs);
    });
  };
}

export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------- Canvas ----------

export function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function cloneCanvas(src) {
  const c = createCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

export function getData(canvas) {
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}

export function canvasFromData(data) {
  const c = createCanvas(data.width, data.height);
  c.getContext('2d').putImageData(data, 0, 0);
  return c;
}

// Réduit un canvas pour l'aperçu temps réel (proxy) ; renvoie aussi l'échelle appliquée.
export function makeProxy(src, maxPixels = 1_200_000) {
  const px = src.width * src.height;
  if (px <= maxPixels) return { canvas: cloneCanvas(src), scale: 1 };
  const scale = Math.sqrt(maxPixels / px);
  return { canvas: resizeCanvas(src, src.width * scale, src.height * scale), scale };
}

// Redimensionnement de qualité : réduction par paliers successifs de 50 %.
export function resizeCanvas(src, w, h) {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  let cur = src;
  while (cur.width / 2 > w && cur.height / 2 > h) {
    const half = createCanvas(cur.width / 2, cur.height / 2);
    const hc = half.getContext('2d');
    hc.imageSmoothingQuality = 'high';
    hc.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = createCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

// Applique `result` sur `original` uniquement là où la sélection (masque alpha) est active.
export function blendWithSelection(original, result, selection) {
  if (!selection) return result;
  const w = original.width, h = original.height;
  const masked = createCanvas(w, h);
  const mctx = masked.getContext('2d');
  mctx.drawImage(result, 0, 0, w, h);
  mctx.globalCompositeOperation = 'destination-in';
  mctx.drawImage(selection, 0, 0, w, h);
  const out = createCanvas(w, h);
  const octx = out.getContext('2d');
  octx.drawImage(original, 0, 0);
  octx.globalCompositeOperation = 'destination-out';
  octx.drawImage(selection, 0, 0, w, h);
  octx.globalCompositeOperation = 'source-over';
  octx.drawImage(masked, 0, 0);
  return out;
}

// Rectangle englobant des pixels non transparents (alpha > seuil).
export function alphaBounds(canvas, threshold = 0) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    let row = y * w * 4 + 3;
    for (let x = 0; x < w; x++, row += 4) {
      if (d[row] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

let checkerPattern = null;
export function checker(ctx, size = 8) {
  if (!checkerPattern) {
    const c = createCanvas(size * 2, size * 2);
    const x = c.getContext('2d');
    x.fillStyle = '#cfcfd4';
    x.fillRect(0, 0, size * 2, size * 2);
    x.fillStyle = '#9d9da6';
    x.fillRect(0, 0, size, size);
    x.fillRect(size, size, size, size);
    checkerPattern = c;
  }
  return ctx.createPattern(checkerPattern, 'repeat');
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Export impossible'))), type, quality));
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image illisible'));
    img.src = src;
  });
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// ---------- Couleurs ----------

export function hexToRgb(hex) {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  if (typeof r === 'object') ({ r, g, b } = r);
  return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

// Version en flottants 0..1 pour les traitements pixel.
export function rgbToHsl01(r, g, b, out) {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  out[0] = h; out[1] = s; out[2] = l;
  return out;
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hslToRgb01(h, s, l, out) {
  if (s <= 0) {
    out[0] = out[1] = out[2] = l;
    return out;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out[0] = hue2rgb(p, q, h + 1 / 3);
  out[1] = hue2rgb(p, q, h);
  out[2] = hue2rgb(p, q, h - 1 / 3);
  return out;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches;
export const isMobileLayout = () => matchMedia('(max-width: 899px)').matches;
export const isCapacitor = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
export const isElectron = () => /Electron/i.test(navigator.userAgent);
