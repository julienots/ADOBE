// Prisme Motion — fichiers projet (.prismemotion) et sauvegarde automatique.
//
// Format : « PRMOTN01 » + longueur du JSON (4 octets) + JSON du projet + fichiers des médias
// mis bout à bout (positions indiquées dans le JSON). Les médias sont donc intégrés au projet.

import { serialize, deserialize } from './model.js';
import { hydrateAsset } from './media.js';

const MAGIC = 'PRMOTN01';

export async function packProject(project) {
  const data = JSON.parse(serialize(project));
  const blobs = [];
  let offset = 0;
  for (const a of data.assets) {
    const src = project.assets.find((x) => x.id === a.id)?.__blob;
    if (!src) continue;
    a.pkOffset = offset;
    a.pkLength = src.size;
    blobs.push(src);
    offset += src.size;
  }
  const json = JSON.stringify(data);
  const enc = new TextEncoder().encode(json);
  const head = new Uint8Array(12);
  head.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(head.buffer).setUint32(8, enc.length, true);
  return new Blob([head, enc, ...blobs], { type: 'application/x-prisme-motion' });
}

export async function unpackProject(blob, onAsset) {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (new TextDecoder().decode(head.slice(0, 8)) !== MAGIC) throw new Error('Ce fichier n’est pas un projet Prisme Motion');
  const len = new DataView(head.buffer).getUint32(8, true);
  const json = new TextDecoder().decode(await blob.slice(12, 12 + len).arrayBuffer());
  const project = deserialize(json);
  const base = 12 + len;
  for (const a of project.assets) {
    if (a.pkLength == null) continue;
    const part = blob.slice(base + a.pkOffset, base + a.pkOffset + a.pkLength, a.mime || '');
    delete a.pkOffset;
    delete a.pkLength;
    try {
      await hydrateAsset(a, part);
    } catch (e) {
      console.warn('Média illisible', a.name, e);
    }
    onAsset?.(a);
  }
  return project;
}

// ---------- Sauvegarde automatique (IndexedDB, médias stockés sous forme de Blob) ----------

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('prisme-motion', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(key, value) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

async function get(key) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', 'readonly');
    const r = tx.objectStore('kv').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function autosave(project) {
  try {
    const blobs = {};
    for (const a of project.assets) if (a.__blob) blobs[a.id] = a.__blob;
    await put('autosave', { json: serialize(project), blobs, savedAt: Date.now(), name: project.name });
  } catch (e) {
    console.warn('Sauvegarde automatique impossible', e);
  }
}

export async function getAutosave() {
  try {
    return await get('autosave');
  } catch {
    return null;
  }
}

export async function restoreAutosave(data, onAsset) {
  const project = deserialize(data.json);
  for (const a of project.assets) {
    const b = data.blobs?.[a.id];
    if (!b) continue;
    try {
      await hydrateAsset(a, b);
    } catch (e) {
      console.warn('Média illisible', a.name, e);
    }
    onAsset?.(a);
  }
  return project;
}
