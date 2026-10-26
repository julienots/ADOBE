// Cœur de l'application : état global, évènements, document courant et opérations communes.

import { Doc, composite } from './doc.js';
import { History } from './history.js';
import { View } from './view.js';
import { createCanvas, cloneCanvas, blendWithSelection, debounce } from './util.js';

export class App {
  constructor() {
    this.listeners = {};
    this.doc = null;
    this.history = new History(this);
    this.tools = {};
    this.tool = null;
    this.primary = '#1e90ff';
    this.secondary = '#ffffff';
    this.recentColors = loadPref('recentColors', ['#000000', '#ffffff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de']);
    this.compositeCanvas = createCanvas(1, 1);
    this.compositeDirty = true;
    this.live = null;
    this.liveMask = null;
    this.preview = null;
    this.pending = null; // session de réglage en cours (Développement / Looks)
    this.originalCanvas = null;
    this.showOriginal = false;
    this.clipboard = null;
    this.lastFilter = null;
    this.dirty = false;
    this.on('history', () => {
      this.dirty = true;
      this.autosave?.();
    });
    this.notifyDocChanged = debounce(() => this.emit('doc'), 60);
  }

  // ---------- Évènements ----------
  on(name, fn) {
    (this.listeners[name] ||= []).push(fn);
    return () => (this.listeners[name] = this.listeners[name].filter((f) => f !== fn));
  }

  emit(name, data) {
    for (const fn of this.listeners[name] || []) fn(data);
  }

  attachView(canvas) {
    this.view = new View(this, canvas);
  }

  // ---------- Rendu ----------
  invalidate(structure = false) {
    this.compositeDirty = true;
    this.view?.requestRender();
    if (structure) this.emit('layers');
    this.notifyDocChanged();
  }

  updateComposite() {
    if (!this.doc) return;
    composite(this.doc, this.compositeCanvas, { live: this.live, liveMask: this.liveMask, preview: this.preview });
    this.compositeDirty = false;
  }

  setLive(live) {
    this.live = live;
    this.invalidate();
  }

  setLiveMask(live) {
    this.liveMask = live;
    this.invalidate();
  }

  setPreview(preview) {
    this.preview = preview;
    this.invalidate();
  }

  // ---------- Document ----------
  setDocument(doc, label = 'Ouverture') {
    this.cancelPending();
    this.tool?.deactivate?.();
    this.doc = doc;
    this.live = this.liveMask = this.preview = null;
    this.history.reset(label);
    this.originalCanvas = composite(doc, createCanvas(doc.width, doc.height));
    this.dirty = false;
    this.view.fitted = false;
    this.view.fit();
    this.tool?.activate?.();
    this.invalidate(true);
    this.emit('document');
  }

  newDocument(w, h, background = '#ffffff', name = 'Sans titre') {
    const doc = new Doc(w, h, name);
    const layer = doc.addLayer({ name: background ? 'Arrière-plan' : 'Calque 1' });
    if (background) {
      const ctx = layer.canvas.getContext('2d');
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, w, h);
    }
    this.setDocument(doc, 'Nouveau document');
  }

  afterRestore(message) {
    this.live = this.liveMask = this.preview = null;
    this.tool?.reset?.();
    this.invalidate(true);
    this.emit('document-restored');
    if (message) this.toast?.(message, 1200);
  }

  // Validation / annulation des réglages en attente (panneau Développement).
  flushPending() {
    if (this.pending && !this.pending.committing) this.pending.commit();
  }

  cancelPending() {
    if (this.pending) this.pending.cancel();
  }

  // ---------- Calques ----------

  // Cible du dessin : pixels du calque actif, ou son masque en mode « édition de masque ».
  target() {
    const layer = this.doc?.active;
    if (!layer) return null;
    const mask = this.doc.editMask && layer.mask;
    return { layer, kind: mask ? 'mask' : 'pixels', canvas: mask ? layer.mask : layer.canvas };
  }

  canEdit(layer = this.doc?.active) {
    if (!layer) {
      this.toast('Aucun calque actif');
      return false;
    }
    if (layer.locked) {
      this.toast('Le calque est verrouillé 🔒');
      return false;
    }
    if (!layer.visible) {
      this.toast('Le calque est masqué');
      return false;
    }
    return true;
  }

  setTargetCanvas(t, canvas) {
    if (t.kind === 'mask') t.layer.mask = canvas;
    else {
      t.layer.canvas = canvas;
      if (t.layer.text) t.layer.text = null;
    }
  }

  // Applique `fn(canvasSource) -> nouveauCanvas` sur la cible, limité à la sélection.
  applyToTarget(label, fn, { useSelection = true } = {}) {
    if (!this.canEdit()) return false;
    const t = this.target();
    this.history.push(label);
    const result = fn(t.canvas);
    if (!result) {
      this.history.discardLast();
      return false;
    }
    const sel = useSelection ? this.doc.selection : null;
    this.setTargetCanvas(t, sel ? blendWithSelection(t.canvas, result, sel) : result);
    this.invalidate(true);
    return true;
  }

  // Ajoute un calque contenant `canvas` (taille document) et le rend actif.
  addLayerFromCanvas(canvas, name, label = 'Nouveau calque', props = {}) {
    this.history.push(label);
    const c = canvas.width === this.doc.width && canvas.height === this.doc.height ? canvas : (() => {
      const cc = this.doc.newLayerCanvas();
      cc.getContext('2d').drawImage(canvas, 0, 0);
      return cc;
    })();
    const layer = this.doc.addLayer({ canvas: c, name, ...props });
    this.invalidate(true);
    return layer;
  }

  // ---------- Outils & couleurs ----------
  registerTool(tool) {
    this.tools[tool.id] = tool;
  }

  setTool(id) {
    const tool = this.tools[id];
    if (!tool || tool === this.tool) return;
    this.tool?.deactivate?.();
    this.tool = tool;
    localStorage.setItem('prisme.tool', id);
    tool.activate?.();
    this.view?.updateCursor();
    this.view?.requestRender();
    this.emit('tool', tool);
  }

  setColor(which, hex) {
    this[which] = hex;
    this.recentColors = [hex, ...this.recentColors.filter((c) => c !== hex)].slice(0, 16);
    savePref('recentColors', this.recentColors);
    this.emit('colors');
  }

  swapColors() {
    [this.primary, this.secondary] = [this.secondary, this.primary];
    this.emit('colors');
  }

  resetColors() {
    this.primary = '#000000';
    this.secondary = '#ffffff';
    this.emit('colors');
  }

  cloneTarget() {
    const t = this.target();
    return t ? cloneCanvas(t.canvas) : null;
  }
}

export function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(`prisme.${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function savePref(key, value) {
  try {
    localStorage.setItem(`prisme.${key}`, JSON.stringify(value));
  } catch {
    /* stockage indisponible : on ignore */
  }
}
