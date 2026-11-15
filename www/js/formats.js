// Formats de fichiers avancés, chargés à la demande (rien n'est téléchargé tant qu'on ne s'en sert pas) :
//  - PSD (Photoshop) en lecture et en écriture, calques et masques compris   → ag-psd (MIT)
//  - TIFF en lecture et en écriture                                           → UTIF.js + pako (MIT)
//  - HEIC / HEIF (photos d'iPhone)                                            → libheif (LGPL, WebAssembly)
//  - RAW (CR2, NEF, ARW, DNG, ORF, RW2, PEF, RAF, CR3…) : aperçu JPEG pleine taille intégré par l'appareil

import { Doc } from './doc.js';
import { createCanvas } from './util.js';

const scripts = {};
export function loadScript(src) {
  if (!scripts[src]) {
    scripts[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => {
        delete scripts[src];
        reject(new Error(`Chargement impossible : ${src}`));
      };
      document.head.append(s);
    });
  }
  return scripts[src];
}

const ext = (name = '') => (name.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();

export const RAW_EXT = ['cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'orf', 'rw2', 'raf', 'pef', 'srw', 'erf', 'kdc', 'mrw', '3fr', 'iiq', 'x3f', 'rwl'];
export const HEIC_EXT = ['heic', 'heif', 'hif'];
export const TIFF_EXT = ['tif', 'tiff'];

export function fileKind(file) {
  const e = ext(file.name);
  const t = (file.type || '').toLowerCase();
  if (e === 'psd' || e === 'psb' || t === 'image/vnd.adobe.photoshop') return 'psd';
  if (HEIC_EXT.includes(e) || /image\/hei[cf]/.test(t)) return 'heic';
  if (TIFF_EXT.includes(e) || t === 'image/tiff') return 'tiff';
  if (RAW_EXT.includes(e)) return 'raw';
  return 'image';
}

// Extensions acceptées par le sélecteur de fichiers.
export const ACCEPT = ['image/*', '.prisme', '.json', '.psd', ...HEIC_EXT, ...TIFF_EXT, ...RAW_EXT].map((x) => (x.includes('/') || x.startsWith('.') ? x : `.${x}`)).join(',');

function canvasFromRGBA(rgba, w, h) {
  const c = createCanvas(w, h);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
  return c;
}

// ======================================================================
// HEIC / HEIF
// ======================================================================

let heifPromise = null;
function getHeif() {
  if (!heifPromise) {
    heifPromise = (async () => {
      const [, wasm] = await Promise.all([
        loadScript('vendor/libheif/libheif.js'),
        fetch('vendor/libheif/libheif.wasm').then((r) => {
          if (!r.ok) throw new Error('Décodeur HEIC introuvable');
          return r.arrayBuffer();
        }),
      ]);
      return new Promise((resolve, reject) => {
        try {
          // Avec wasmBinary l'initialisation peut être synchrone : on résout après le retour de la fabrique.
          let mod = null;
          mod = window.libheif({
            wasmBinary: wasm,
            onRuntimeInitialized: () => setTimeout(() => resolve(mod)),
            onAbort: (e) => reject(new Error(`libheif : ${e}`)),
          });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    })();
    heifPromise.catch(() => (heifPromise = null));
  }
  return heifPromise;
}

export async function decodeHEIC(file) {
  const lib = await getHeif();
  const decoder = new lib.HeifDecoder();
  let images;
  try {
    images = decoder.decode(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }
  if (!images || !images.length) throw new Error('Fichier HEIC vide ou illisible');
  const img = images[0]; // image principale
  const w = img.get_width(), h = img.get_height();
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const data = ctx.createImageData(w, h);
  await new Promise((resolve, reject) => img.display(data, (d) => (d ? resolve() : reject(new Error('Décodage HEIC impossible')))));
  ctx.putImageData(data, 0, 0);
  for (const i of images) i.free?.();
  return c;
}

// ======================================================================
// TIFF
// ======================================================================

async function getUTIF() {
  if (!window.pako) await loadScript('vendor/utif/pako_inflate.min.js');
  if (!window.UTIF) await loadScript('vendor/utif/UTIF.js');
  return window.UTIF;
}

export async function decodeTIFF(file) {
  const UTIF = await getUTIF();
  const buf = await file.arrayBuffer();
  const ifds = UTIF.decode(buf);
  // On garde la plus grande image (certains TIFF contiennent des vignettes)
  let best = null;
  for (const ifd of ifds) {
    const w = ifd.t256?.[0] || ifd.width, h = ifd.t257?.[0] || ifd.height;
    if (w && h && (!best || w * h > best.w * best.h)) best = { ifd, w, h };
  }
  if (!best) throw new Error('TIFF sans image');
  UTIF.decodeImage(buf, best.ifd, ifds);
  const rgba = UTIF.toRGBA8(best.ifd);
  return canvasFromRGBA(rgba, best.ifd.width, best.ifd.height);
}

export async function encodeTIFF(canvas) {
  const UTIF = await getUTIF();
  const { width: w, height: h } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  return new Blob([UTIF.encodeImage(data.buffer, w, h)], { type: 'image/tiff' });
}

// ======================================================================
// RAW : aperçu JPEG intégré
// ======================================================================
// Les appareils photo enregistrent dans chaque fichier RAW un JPEG pleine taille (ou presque),
// traité par le boîtier. On le retrouve : d'abord via la structure TIFF (CR2, NEF, ARW, DNG,
// ORF, RW2, PEF…), sinon en cherchant le plus grand flux JPEG du fichier (CR3, RAF…).

function jpegCandidatesFromTiff(v) {
  const out = [];
  if (v.byteLength < 16) return out;
  const bo = v.getUint16(0);
  if (bo !== 0x4949 && bo !== 0x4d4d) return out;
  const le = bo === 0x4949;
  const magic = v.getUint16(2, le);
  if (magic !== 42 && magic !== 0x4f52 && magic !== 0x5352 && magic !== 0x55) return out; // TIFF, ORF, RW2
  const seen = new Set();
  const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
  const walk = (off, depth) => {
    if (!off || off + 2 > v.byteLength || seen.has(off) || depth > 4 || seen.size > 64) return;
    seen.add(off);
    const n = u16(off);
    if (n > 1000) return;
    let jOff = 0, jLen = 0, strip = 0, stripLen = 0, compression = 0;
    const subs = [];
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const val = type === 3 && count === 1 ? u16(e + 8) : u32(e + 8);
      if (tag === 0x0201) jOff = val;
      else if (tag === 0x0202) jLen = val;
      else if (tag === 0x0103) compression = val;
      else if (tag === 0x0111 && count === 1) strip = val;
      else if (tag === 0x0117 && count === 1) stripLen = val;
      else if (tag === 0x014a || tag === 0x8769) {
        // SubIFDs (DNG, NEF…) ou EXIF
        if (count === 1) subs.push(val);
        else for (let k = 0; k < Math.min(count, 16); k++) if (val + k * 4 + 4 <= v.byteLength) subs.push(u32(val + k * 4));
      }
    }
    if (jOff && jLen) out.push([jOff, jLen]);
    if (strip && stripLen && (compression === 6 || compression === 7)) out.push([strip, stripLen]);
    for (const s of subs) walk(s, depth + 1);
    if (off + 2 + n * 12 + 4 <= v.byteLength) walk(u32(off + 2 + n * 12), depth + 1);
  };
  walk(u32(4), 0);
  return out;
}

// Longueur exacte d'un flux JPEG commençant à `s` (segments jusqu'au SOS, puis données jusqu'à EOI).
function jpegLength(bytes, s) {
  let i = s + 2;
  const n = bytes.length;
  while (i + 4 <= n) {
    if (bytes[i] !== 0xff) return 0;
    const m = bytes[i + 1];
    if (m === 0xd9) return i + 2 - s;
    if (m >= 0xd0 && m <= 0xd7 || m === 0x01) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2) return 0;
    i += 2 + len;
    if (m === 0xda) {
      // Données compressées : on avance jusqu'à un marqueur qui n'est ni un octet bourré (FF00) ni un RST
      while (i + 1 < n) {
        if (bytes[i] === 0xff && bytes[i + 1] !== 0 && !(bytes[i + 1] >= 0xd0 && bytes[i + 1] <= 0xd7)) break;
        i++;
      }
    }
  }
  return 0;
}

function jpegCandidatesByScan(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length - 4 && out.length < 32; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xd8 || bytes[i + 2] !== 0xff) continue;
    const len = jpegLength(bytes, i);
    if (len > 1024) {
      out.push([i, len]);
      i += len - 1;
    }
  }
  return out;
}

async function decodeJpegBytes(bytes) {
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const c = createCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}

// Orientation EXIF du RAW (les aperçus intégrés ne la portent pas toujours eux-mêmes).
function rawOrientation(v) {
  try {
    const le = v.getUint16(0) === 0x4949;
    const ifd = v.getUint32(4, le);
    const n = v.getUint16(ifd, le);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le);
    }
  } catch {
    /* pas de structure TIFF */
  }
  return 1;
}

function applyOrientation(c, o) {
  if (!o || o === 1) return c;
  const swap = o >= 5;
  const w = swap ? c.height : c.width, h = swap ? c.width : c.height;
  const out = createCanvas(w, h);
  const ctx = out.getContext('2d');
  const T = {
    2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, w, 0], 7: [0, -1, -1, 0, w, h], 8: [0, -1, 1, 0, 0, h],
  }[o];
  if (T) ctx.setTransform(...T);
  ctx.drawImage(c, 0, 0);
  return out;
}

export async function decodeRAW(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const v = new DataView(buf);
  let cands = jpegCandidatesFromTiff(v).filter(([o, l]) => o > 0 && l > 1024 && o + l <= bytes.length && bytes[o] === 0xff && bytes[o + 1] === 0xd8);
  if (!cands.length) cands = jpegCandidatesByScan(bytes);
  cands.sort((a, b) => b[1] - a[1]);
  let best = null;
  for (const [o, l] of cands.slice(0, 6)) {
    try {
      const c = await decodeJpegBytes(bytes.subarray(o, o + l));
      if (!best || c.width * c.height > best.width * best.height) best = c;
      if (best.width >= 1600) break; // assez grand : inutile de décoder les autres
    } catch {
      /* flux JPEG sans-perte (données RAW) ou tronqué : on passe au suivant */
    }
  }
  if (!best) throw new Error('Aucun aperçu exploitable dans ce fichier RAW');
  // Les aperçus Nikon/Canon/Sony n'intègrent pas l'orientation : on applique celle du RAW
  return applyOrientation(best, rawOrientation(v));
}

// ======================================================================
// PSD (Photoshop)
// ======================================================================

async function getAgPsd() {
  if (!window.agPsd) await loadScript('vendor/ag-psd/ag-psd.min.js');
  return window.agPsd;
}

const TO_PSD = {
  'source-over': 'normal', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten',
  'color-dodge': 'color dodge', 'color-burn': 'color burn', 'hard-light': 'hard light', 'soft-light': 'soft light',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};
const FROM_PSD = Object.fromEntries(Object.entries(TO_PSD).map(([a, b]) => [b, a]));
Object.assign(FROM_PSD, { 'pass through': 'source-over', 'linear dodge': 'color-dodge', 'linear burn': 'color-burn', 'darker color': 'darken', 'lighter color': 'lighten', 'vivid light': 'hard-light', 'linear light': 'hard-light', 'pin light': 'hard-light' });

// Masque Prisme (alpha) → masque Photoshop (niveaux de gris, blanc = visible) et inversement.
function alphaToGray(mask) {
  const { width: w, height: h } = mask;
  const src = mask.getContext('2d').getImageData(0, 0, w, h).data;
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(w, h);
  for (let i = 0; i < src.length; i += 4) {
    out.data[i] = out.data[i + 1] = out.data[i + 2] = src[i + 3];
    out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

function grayToAlpha(m, docW, docH) {
  const c = createCanvas(docW, docH);
  const ctx = c.getContext('2d');
  // Hors des limites du masque : couleur par défaut (0 = masqué, 255 = visible)
  if ((m.defaultColor ?? 0) > 127) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, docW, docH);
  }
  if (m.canvas && m.canvas.width && m.canvas.height) {
    const { width: w, height: h } = m.canvas;
    const src = m.canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const tmp = createCanvas(w, h);
    const tctx = tmp.getContext('2d');
    const out = tctx.createImageData(w, h);
    for (let i = 0; i < src.length; i += 4) {
      out.data[i] = out.data[i + 1] = out.data[i + 2] = 255;
      out.data[i + 3] = src[i];
    }
    tctx.putImageData(out, 0, 0);
    ctx.clearRect(m.left || 0, m.top || 0, w, h);
    ctx.drawImage(tmp, m.left || 0, m.top || 0);
  }
  return c;
}

/** Lit un fichier PSD et renvoie un document Prisme multi-calques. */
export async function readPSD(file) {
  const agPsd = await getAgPsd();
  const psd = agPsd.readPsd(await file.arrayBuffer(), { skipThumbnail: true, useImageData: false });
  const name = (file.name || 'Photoshop').replace(/\.[^.]+$/, '');
  const doc = new Doc(psd.width, psd.height, name);
  const flat = [];
  // Les groupes sont aplatis ; leur visibilité et leur opacité se répercutent sur les calques enfants.
  const walk = (children, hidden, opacity) => {
    for (const l of children || []) {
      const op = (l.opacity ?? 1) * opacity;
      const hid = hidden || !!l.hidden;
      if (l.children) walk(l.children, hid, op);
      else flat.push({ l, hidden: hid, opacity: op });
    }
  };
  walk(psd.children, false, 1);
  if (!flat.length && psd.canvas) flat.push({ l: { name: 'Arrière-plan', canvas: psd.canvas, left: 0, top: 0 }, hidden: false, opacity: 1 });
  // ag-psd ordonne les calques du bas vers le haut, comme Prisme.
  for (const { l, hidden, opacity } of flat) {
    const canvas = doc.newLayerCanvas();
    if (l.canvas && l.canvas.width && l.canvas.height) canvas.getContext('2d').drawImage(l.canvas, l.left || 0, l.top || 0);
    const layer = doc.addLayer({ canvas, name: l.name || 'Calque' }, doc.layers.length);
    layer.visible = !hidden;
    layer.opacity = Math.max(0, Math.min(1, opacity));
    layer.blend = FROM_PSD[l.blendMode] || 'source-over';
    if (l.mask && (l.mask.canvas || l.mask.defaultColor > 127)) {
      layer.mask = grayToAlpha(l.mask, doc.width, doc.height);
      layer.maskEnabled = !l.mask.disabled;
    }
  }
  doc.activeId = doc.layers[doc.layers.length - 1]?.id || null;
  doc.fileInfo = { name: file.name, size: file.size, type: 'image/vnd.adobe.photoshop', original: { w: psd.width, h: psd.height } };
  return doc;
}

/** Écrit le document en PSD (calques, opacité, modes de fusion, visibilité, masques). */
export async function writePSD(doc, composite) {
  const agPsd = await getAgPsd();
  const psd = {
    width: doc.width,
    height: doc.height,
    canvas: composite,
    children: doc.layers.map((l) => {
      const out = {
        name: l.name || 'Calque',
        canvas: l.canvas,
        left: 0,
        top: 0,
        opacity: l.opacity,
        hidden: !l.visible,
        blendMode: TO_PSD[l.blend] || 'normal',
        protected: l.locked ? { transparency: true, composite: true, position: true } : undefined,
      };
      if (l.mask) out.mask = { canvas: alphaToGray(l.mask), left: 0, top: 0, defaultColor: 0, disabled: !l.maskEnabled };
      return out;
    }),
  };
  const buf = agPsd.writePsd(psd, { generateThumbnail: true, trimImageData: true });
  return new Blob([buf], { type: 'image/vnd.adobe.photoshop' });
}

// ======================================================================
// Décodage générique
// ======================================================================

/** Décode n'importe quel fichier pris en charge en canvas (null : laisser le navigateur décoder). */
export async function decodeSpecial(file) {
  switch (fileKind(file)) {
    case 'heic':
      // Safari sait décoder le HEIC nativement : on essaie d'abord le décodeur du système
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const c = createCanvas(bmp.width, bmp.height);
        c.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close?.();
        return c;
      } catch {
        return decodeHEIC(file);
      }
    case 'tiff':
      return decodeTIFF(file);
    case 'raw':
      return decodeRAW(file);
    default:
      return null;
  }
}
