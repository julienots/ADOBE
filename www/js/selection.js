// Sélections : masques alpha à la taille du document, combinaisons, contour animé.

import { createCanvas, getData, makeProxy } from './util.js';
import { blurAlpha, floodMask, maskToImageData } from './imaging.js';

export function selectionFromPath(doc, path, fillRule = 'nonzero') {
  const c = createCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fill(path, fillRule);
  return c;
}

export function selectAll(doc) {
  const c = createCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

// mode : 'new' | 'add' | 'sub' | 'inter'
export function combineSelection(doc, current, next, mode) {
  if (mode === 'new' || !current) {
    if (mode === 'sub') return null;
    if (mode === 'inter' && !current) return next;
    return next;
  }
  const c = createCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(current, 0, 0);
  ctx.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'sub' ? 'destination-out' : 'destination-in';
  ctx.drawImage(next, 0, 0);
  return isEmptySelection(c) ? null : c;
}

export function invertSelection(doc, sel) {
  const c = selectAll(doc);
  if (!sel) return null;
  const ctx = c.getContext('2d');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(sel, 0, 0);
  return isEmptySelection(c) ? null : c;
}

export function featherSelection(sel, radius) {
  const data = blurAlpha(getData(sel), radius / 2);
  const c = createCanvas(sel.width, sel.height);
  c.getContext('2d').putImageData(data, 0, 0);
  return c;
}

// Étendre (px > 0) ou contracter (px < 0) via flou + seuil.
export function growSelection(sel, px) {
  const data = blurAlpha(getData(sel), Math.abs(px) / 1.5);
  const d = data.data;
  const thr = px > 0 ? 8 : 247;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] > thr ? 255 : 0;
  const c = createCanvas(sel.width, sel.height);
  c.getContext('2d').putImageData(data, 0, 0);
  return isEmptySelection(c) ? null : c;
}

export function isEmptySelection(sel) {
  const p = makeProxy(sel, 200_000).canvas;
  const d = getData(p).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return false;
  return true;
}

export function wandSelection(doc, source, x, y, tolerance, contiguous) {
  const data = getData(source);
  const mask = floodMask(data, x, y, tolerance, contiguous);
  const c = createCanvas(doc.width, doc.height);
  c.getContext('2d').putImageData(maskToImageData(mask, doc.width, doc.height), 0, 0);
  return c;
}

export function colorRangeSelection(doc, source, rgb, fuzziness) {
  const data = getData(source);
  const { width: w, height: h, data: d } = data;
  const out = new ImageData(w, h);
  const od = out.data;
  const range = (fuzziness / 100) * 441;
  for (let p = 0; p < d.length; p += 4) {
    const dr = d[p] - rgb.r, dg = d[p + 1] - rgb.g, db = d[p + 2] - rgb.b;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    const a = dist <= range * 0.5 ? 255 : dist >= range ? 0 : 255 * (1 - (dist - range * 0.5) / (range * 0.5));
    od[p] = od[p + 1] = od[p + 2] = 255;
    od[p + 3] = a * (d[p + 3] / 255);
  }
  const c = createCanvas(w, h);
  c.getContext('2d').putImageData(out, 0, 0);
  return isEmptySelection(c) ? null : c;
}

export function selectionFromLayerAlpha(doc, layer) {
  const c = createCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(layer.canvas, 0, 0);
  if (layer.mask && layer.maskEnabled) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(layer.mask, 0, 0);
  }
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  return isEmptySelection(c) ? null : c;
}

// ---------- Contour (« fourmis ») ----------

const outlineCache = new WeakMap();

// Trace les bords du masque (seuil 50 %) en segments fusionnés, sur une version réduite si besoin.
export function selectionOutline(sel) {
  if (outlineCache.has(sel)) return outlineCache.get(sel);
  const { canvas: small, scale } = makeProxy(sel, 1_500_000);
  const w = small.width, h = small.height;
  const d = getData(small).data;
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inside[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
  const path = new Path2D();
  const k = 1 / scale;
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : inside[y * w + x]);
  // Bords horizontaux
  for (let y = 0; y <= h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && at(x, y) !== at(x, y - 1);
      if (edge && start < 0) start = x;
      else if (!edge && start >= 0) {
        path.moveTo(start * k, y * k);
        path.lineTo(x * k, y * k);
        start = -1;
      }
    }
  }
  // Bords verticaux
  for (let x = 0; x <= w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && at(x, y) !== at(x - 1, y);
      if (edge && start < 0) start = y;
      else if (!edge && start >= 0) {
        path.moveTo(x * k, start * k);
        path.lineTo(x * k, y * k);
        start = -1;
      }
    }
  }
  outlineCache.set(sel, path);
  return path;
}

export function selectionBounds(sel) {
  const { canvas: small, scale } = makeProxy(sel, 600_000);
  const w = small.width, h = small.height;
  const d = getData(small).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  if (x1 < 0) return null;
  const k = 1 / scale;
  const bx = Math.max(0, Math.floor(x0 * k) - 1), by = Math.max(0, Math.floor(y0 * k) - 1);
  return {
    x: bx,
    y: by,
    w: Math.min(sel.width, Math.ceil((x1 + 1) * k) + 1) - bx,
    h: Math.min(sel.height, Math.ceil((y1 + 1) * k) + 1) - by,
  };
}
