// Entrées / sorties : ouverture d'images, EXIF, export, projets .prisme, sauvegarde automatique.

import { Doc } from './doc.js';
import { createCanvas, canvasToBlob, loadImage, blobToDataURL, resizeCanvas, formatBytes, isCapacitor, isMobileLayout, el, debounce } from './util.js';
import { flatten } from './doc.js';
import { toast, busy, modal, buildFields } from './ui.js';

const MAX_PIXELS = () => (isMobileLayout() ? 24_000_000 : 60_000_000);

// ---------- Décodage ----------

export async function decodeImage(file) {
  let source;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      source = await loadImage(url);
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  }
  let w = source.width, h = source.height;
  let canvas = createCanvas(w, h);
  canvas.getContext('2d').drawImage(source, 0, 0);
  source.close?.();
  let downscaled = false;
  if (w * h > MAX_PIXELS()) {
    const k = Math.sqrt(MAX_PIXELS() / (w * h));
    canvas = resizeCanvas(canvas, w * k, h * k);
    downscaled = true;
  }
  return { canvas, downscaled, original: { w, h } };
}

// ---------- EXIF (JPEG) ----------

const EXIF_TAGS = {
  0x010f: 'Fabricant', 0x0110: 'Appareil', 0x0112: 'Orientation', 0x0131: 'Logiciel', 0x0132: 'Date',
  0x829a: 'Exposition', 0x829d: 'Ouverture', 0x8827: 'ISO', 0x9003: 'Prise de vue', 0x920a: 'Focale',
  0xa434: 'Objectif', 0x9209: 'Flash', 0xa405: 'Focale (24x36)', 0xa002: 'Largeur', 0xa003: 'Hauteur', 0x8822: 'Programme',
  0x9204: 'Correction expo', 0xa403: 'Balance des blancs',
};

export async function readExif(file) {
  if (!/jpe?g/i.test(file.type) && !/\.jpe?g$/i.test(file.name || '')) return null;
  const buf = await file.slice(0, 256 * 1024).arrayBuffer();
  const v = new DataView(buf);
  if (v.getUint16(0) !== 0xffd8) return null;
  let off = 2;
  while (off < v.byteLength - 4) {
    const marker = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
    off += 2 + len;
  }
  return null;
}

function parseTiff(v, start) {
  const little = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(o, little), u32 = (o) => v.getUint32(o, little), s32 = (o) => v.getInt32(o, little);
  const out = {};
  const readIFD = (ifdOff, depth = 0) => {
    if (depth > 2 || ifdOff + 2 > v.byteLength) return;
    const n = u16(ifdOff);
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      if (e + 12 > v.byteLength) return;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const valOff = e + 8;
      const dataOff = (type === 2 && count > 4) || (type === 5 || type === 10) ? start + u32(valOff) : valOff;
      if (tag === 0x8769) {
        readIFD(start + u32(valOff), depth + 1);
        continue;
      }
      const name = EXIF_TAGS[tag];
      if (!name) continue;
      try {
        let val;
        if (type === 2) {
          val = '';
          for (let k = 0; k < count - 1 && dataOff + k < v.byteLength; k++) val += String.fromCharCode(v.getUint8(dataOff + k));
          val = val.trim();
        } else if (type === 3) val = u16(valOff);
        else if (type === 4) val = u32(valOff);
        else if (type === 5) val = u32(dataOff) / (u32(dataOff + 4) || 1);
        else if (type === 10) val = s32(dataOff) / (s32(dataOff + 4) || 1);
        if (tag === 0x829a && typeof val === 'number') val = val < 1 ? `1/${Math.round(1 / val)} s` : `${val} s`;
        if (tag === 0x829d && typeof val === 'number') val = `f/${val.toFixed(1)}`;
        if (tag === 0x920a && typeof val === 'number') val = `${Math.round(val)} mm`;
        if (tag === 0x9204 && typeof val === 'number') val = `${val > 0 ? '+' : ''}${val.toFixed(1)} IL`;
        if (tag === 0x9209) val = val & 1 ? 'Déclenché' : 'Non déclenché';
        if (tag === 0xa403) val = val ? 'Manuelle' : 'Auto';
        if (val !== '' && val != null) out[name] = val;
      } catch {
        /* entrée EXIF illisible */
      }
    }
  };
  readIFD(start + u32(start + 4));
  delete out.Orientation;
  return Object.keys(out).length ? out : null;
}

// ---------- Ouverture ----------

export async function openImageFile(app, file, mode = 'replace') {
  if (/\.(prisme|json)$/i.test(file.name)) return loadProjectFile(app, file);
  if (file.type && !file.type.startsWith('image/')) return toast(`Format non pris en charge : ${file.name}`);
  try {
    await busy(async () => {
      const { canvas, downscaled, original } = await decodeImage(file);
      const name = (file.name || 'Image').replace(/\.[^.]+$/, '');
      if (mode === 'layer' && app.doc) {
        placeAsLayer(app, canvas, name);
      } else {
        const doc = new Doc(canvas.width, canvas.height, name);
        doc.addLayer({ canvas, name: 'Arrière-plan' });
        doc.fileInfo = { name: file.name, size: file.size, type: file.type, original, exif: await readExif(file).catch(() => null) };
        app.setDocument(doc);
      }
      if (downscaled) toast(`Image réduite à ${canvas.width}×${canvas.height} pour la mémoire de l'appareil`, 3500);
    }, 'Ouverture…');
  } catch (e) {
    console.error(e);
    toast(/heic|heif/i.test(file.type + file.name) ? 'HEIC non pris en charge par ce navigateur : convertissez en JPEG' : `Impossible d'ouvrir ${file.name}`);
  }
}

// Place une image comme nouveau calque, centrée et réduite si elle dépasse le document.
export function placeAsLayer(app, canvas, name = 'Image importée') {
  const doc = app.doc;
  const k = Math.min(1, doc.width / canvas.width, doc.height / canvas.height);
  const w = canvas.width * k, h = canvas.height * k;
  const c = doc.newLayerCanvas();
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, (doc.width - w) / 2, (doc.height - h) / 2, w, h);
  app.addLayerFromCanvas(c, name, 'Importer comme calque');
}

// ---------- Export ----------

export function supportedFormats() {
  const test = createCanvas(2, 2);
  const ok = (t) => test.toDataURL(t).startsWith(`data:${t}`);
  const f = [['image/jpeg', 'JPEG'], ['image/png', 'PNG'], ['image/webp', 'WebP']];
  if (ok('image/avif')) f.push(['image/avif', 'AVIF']);
  return f.filter(([t]) => t === 'image/png' || ok(t));
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' };

export async function exportDialog(app) {
  const doc = app.doc;
  if (!doc) return;
  app.flushPending();
  const vals = {
    name: doc.name || 'image', format: localStorage.getItem('prisme.exportFormat') || 'image/jpeg', quality: 92, scale: 100,
    width: doc.width, height: doc.height, background: '#ffffff',
  };
  const info = el('div', { class: 'hint' }, '');
  const preview = el('canvas', { style: { width: '100%', maxHeight: '200px', objectFit: 'contain', borderRadius: '8px', background: 'repeating-conic-gradient(#9d9da6 0 25%, #cfcfd4 0 50%) 0 0/14px 14px' } });
  const flat = flatten(doc);
  const pv = resizeCanvas(flat, Math.min(600, flat.width), Math.min(600, flat.width) * (flat.height / flat.width));
  preview.width = pv.width;
  preview.height = pv.height;
  preview.getContext('2d').drawImage(pv, 0, 0);
  const estimate = debounce(async () => {
    const out = renderExport(flat, vals);
    const blob = await canvasToBlob(out, vals.format, vals.quality / 100);
    info.textContent = `${out.width} × ${out.height} px · environ ${formatBytes(blob.size)}`;
  }, 250);
  const fields = [
    { key: 'name', label: 'Nom du fichier', type: 'text' },
    { key: 'format', label: 'Format', type: 'select', options: supportedFormats() },
    { key: 'quality', label: 'Qualité', type: 'range', min: 10, max: 100, unit: '%', when: (v) => v.format !== 'image/png' },
    { key: 'scale', label: 'Taille', type: 'range', min: 5, max: 400, unit: '%' },
    { key: 'background', label: 'Fond (JPEG)', type: 'color', when: (v) => v.format === 'image/jpeg' },
  ];
  const holder = el('div');
  const rebuild = () => {
    holder.innerHTML = '';
    holder.append(buildFields(fields, vals, (v, k) => {
      if (k === 'format') rebuild();
      estimate();
    }));
  };
  rebuild();
  estimate();
  const canShare = isCapacitor() || (navigator.canShare && navigator.canShare({ files: [new File([new Blob()], 'a.png', { type: 'image/png' })] }));
  const buttons = [{ label: 'Annuler', value: null }];
  if (canShare) buttons.push({ label: 'Partager', onClick: (close) => close('share') });
  buttons.push({ label: isCapacitor() ? 'Enregistrer' : 'Télécharger', primary: true, onClick: (close) => close('save') });
  const action = await modal({ title: 'Exporter l\'image', body: el('div', {}, preview, holder, info), buttons }).promise;
  if (!action) return;
  localStorage.setItem('prisme.exportFormat', vals.format);
  await busy(async () => {
    const out = renderExport(flat, vals);
    const blob = await canvasToBlob(out, vals.format, vals.quality / 100);
    const filename = `${(vals.name || 'image').replace(/[\\/:*?"<>|]+/g, '_')}.${EXT[vals.format]}`;
    await saveBlob(blob, filename, action === 'share');
    app.dirty = false;
  }, 'Export…');
}

function renderExport(flat, vals) {
  const w = Math.max(1, Math.round((flat.width * vals.scale) / 100)), h = Math.max(1, Math.round((flat.height * vals.scale) / 100));
  let out = vals.scale === 100 ? flat : resizeCanvas(flat, w, h);
  if (vals.format === 'image/jpeg') {
    const c = createCanvas(out.width, out.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = vals.background;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(out, 0, 0);
    out = c;
  }
  return out;
}

// Enregistre un fichier selon la plateforme : Android (Capacitor), partage mobile, ou téléchargement.
export async function saveBlob(blob, filename, share = false) {
  if (isCapacitor()) {
    const { Filesystem, Share } = window.Capacitor.Plugins;
    const data = (await blobToDataURL(blob)).split(',')[1];
    if (!share) {
      try {
        await Filesystem.writeFile({ path: `Prisme/${filename}`, data, directory: 'DOCUMENTS', recursive: true });
        toast(`Enregistré dans Documents/Prisme/${filename}`, 3500);
        return;
      } catch (e) {
        console.warn('Écriture Documents impossible, passage par le partage', e);
      }
    }
    const res = await Filesystem.writeFile({ path: filename, data, directory: 'CACHE' });
    await Share.share({ title: filename, files: [res.uri], dialogTitle: 'Enregistrer ou partager' });
    return;
  }
  if (share && navigator.canShare) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Fichier exporté : ${filename}`);
}

// ---------- Projets .prisme ----------

async function canvasToPNG(c) {
  return blobToDataURL(await canvasToBlob(c, 'image/png'));
}

export async function serializeDoc(doc, asBlobs = false) {
  const enc = async (c) => (c ? (asBlobs ? canvasToBlob(c, 'image/png') : canvasToPNG(c)) : null);
  return {
    app: 'Prisme', version: 1, width: doc.width, height: doc.height, name: doc.name,
    activeIndex: doc.activeIndex, fileInfo: doc.fileInfo,
    layers: await Promise.all(doc.layers.map(async (l) => ({
      name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked,
      effects: l.effects, text: l.text, maskEnabled: l.maskEnabled,
      image: await enc(l.canvas), mask: await enc(l.mask),
    }))),
  };
}

async function decodeStored(src) {
  if (!src) return null;
  const url = src instanceof Blob ? URL.createObjectURL(src) : src;
  const img = await loadImage(url);
  if (src instanceof Blob) URL.revokeObjectURL(url);
  return img;
}

export async function deserializeDoc(data) {
  const doc = new Doc(data.width, data.height, data.name || 'Projet');
  doc.fileInfo = data.fileInfo || null;
  for (const l of data.layers) {
    const canvas = doc.newLayerCanvas();
    const img = await decodeStored(l.image);
    if (img) canvas.getContext('2d').drawImage(img, 0, 0);
    let mask = null;
    if (l.mask) {
      mask = doc.newLayerCanvas();
      mask.getContext('2d').drawImage(await decodeStored(l.mask), 0, 0);
    }
    const layer = doc.addLayer({ canvas, name: l.name, mask }, doc.layers.length);
    Object.assign(layer, {
      visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked, maskEnabled: l.maskEnabled ?? true,
      text: l.text || null, effects: l.effects || layer.effects,
    });
  }
  doc.activeId = (doc.layers[data.activeIndex] || doc.layers[doc.layers.length - 1]).id;
  return doc;
}

export async function saveProject(app) {
  if (!app.doc) return;
  app.flushPending();
  await busy(async () => {
    const data = await serializeDoc(app.doc);
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    await saveBlob(blob, `${app.doc.name || 'projet'}.prisme`);
    app.dirty = false;
  }, 'Enregistrement du projet…');
}

export async function loadProjectFile(app, file) {
  try {
    await busy(async () => {
      const data = JSON.parse(await file.text());
      if (data.app !== 'Prisme') throw new Error('Fichier projet invalide');
      app.setDocument(await deserializeDoc(data), 'Ouverture du projet');
    }, 'Ouverture du projet…');
  } catch (e) {
    console.error(e);
    toast('Projet illisible');
  }
}

// ---------- Sauvegarde automatique (IndexedDB) ----------

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('prisme', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function setupAutosave(app) {
  app.autosave = debounce(async () => {
    if (!app.doc) return;
    try {
      const data = await serializeDoc(app.doc, true);
      data.savedAt = Date.now();
      // Petite vignette pour l'écran d'accueil
      const flat = flatten(app.doc);
      const k = Math.min(1, 320 / Math.max(flat.width, flat.height));
      data.thumb = await canvasToBlob(resizeCanvas(flat, flat.width * k, flat.height * k), 'image/jpeg', 0.8);
      await idbSet('autosave', data);
    } catch (e) {
      console.warn('Sauvegarde automatique impossible', e);
    }
  }, 2500);
}

export async function getAutosave() {
  try {
    return await idbGet('autosave');
  } catch {
    return null;
  }
}

export async function restoreAutosave(app, data) {
  await busy(async () => app.setDocument(await deserializeDoc(data), 'Session restaurée'), 'Restauration…');
}
