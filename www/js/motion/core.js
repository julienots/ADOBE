// Prisme Motion — état de l'application : projet, sélection, temps, lecture, historique,
// cache RAM des images rendues et planification du rendu.

import * as M from './model.js';
import { Engine } from './engine.js';
import { AudioEngine } from './media.js';

const HISTORY_MAX = 80;

export class MotionCore {
  constructor() {
    this.listeners = {};
    this.engine = new Engine();
    this.audio = new AudioEngine();
    this.runtime = new Map(); // id d'élément → objet avec les données d'exécution (images, lecteurs…)
    this.project = M.makeProject();
    this.engine.project = this.project;
    this.time = 0;
    this.playing = false;
    this.loop = true;
    this.selection = new Set();
    this.selKeys = new Set(); // images clés sélectionnées : objets { prop, key }
    this.tool = 'select';
    this.resolution = loadPref('res', 'auto');
    this.cacheBudgetMB = loadPref('cacheMB', 1536);
    this.cache = new Map();
    this.cacheScale = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.snapshot = M.serialize(this.project);
    this.dragSnap = null;
    this.rendering = false;
    this.renderPending = false;
    this.lastFrameImage = null;
    this.fpsMeter = { frames: 0, t0: performance.now(), fps: 0 };
    this.dirty = false;
  }

  // ---------- Évènements ----------
  on(name, fn) {
    (this.listeners[name] ||= []).push(fn);
    return () => (this.listeners[name] = this.listeners[name].filter((f) => f !== fn));
  }

  emit(name, data) {
    for (const fn of this.listeners[name] || []) fn(data);
  }

  // ---------- Accès ----------
  get comp() {
    return M.compById(this.project, this.project.active) || this.project.comps[0];
  }

  get selectedLayers() {
    return this.comp.layers.filter((l) => this.selection.has(l.id));
  }

  get layer() {
    return this.selectedLayers[0] || null;
  }

  frameOf(t = this.time) {
    return Math.round(t * this.comp.fps);
  }

  // ---------- Modifications & historique ----------

  // Applique une modification du projet et l'enregistre dans l'historique.
  change(label, fn) {
    if (this.dragSnap == null) this.pushUndo(label);
    fn?.();
    this.invalidate();
    if (this.dragSnap == null) this.snapshot = M.serialize(this.project);
    this.emit('change', { label });
  }

  // Modification « en direct » pendant un glisser : l'historique n'est mis à jour qu'à la fin.
  beginDrag() {
    if (this.dragSnap == null) this.dragSnap = this.snapshot;
  }

  live() {
    this.invalidate();
    this.emit('live');
  }

  endDrag(label) {
    if (this.dragSnap == null) return;
    const now = M.serialize(this.project);
    if (now !== this.dragSnap) {
      this.undoStack.push({ label, state: this.dragSnap });
      if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift();
      this.redoStack = [];
      this.snapshot = now;
      this.dirty = true;
    }
    this.dragSnap = null;
    this.emit('change', { label });
  }

  pushUndo(label) {
    this.undoStack.push({ label, state: this.snapshot });
    if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
  }

  restore(state) {
    const p = M.deserialize(state);
    this.attachRuntime(p);
    this.project = p;
    this.engine.project = p;
    this.snapshot = state;
    const ids = new Set(this.comp.layers.map((l) => l.id));
    for (const id of [...this.selection]) if (!ids.has(id)) this.selection.delete(id);
    this.selKeys.clear();
    this.invalidate();
    this.emit('change', { label: 'restore' });
    this.emit('comp');
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push({ label: e.label, state: this.snapshot });
    this.restore(e.state);
    return e.label;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push({ label: e.label, state: this.snapshot });
    this.restore(e.state);
    return e.label;
  }

  // Réassocie les données d'exécution (images décodées, lecteurs vidéo) aux éléments du projet.
  attachRuntime(p) {
    p.assets = p.assets.map((a) => {
      const rt = this.runtime.get(a.id);
      if (!rt) return a;
      for (const k of Object.keys(rt)) if (!k.startsWith('__')) delete rt[k];
      return Object.assign(rt, a);
    });
  }

  registerAsset(asset) {
    this.runtime.set(asset.id, asset);
  }

  setProject(p, label = 'Ouverture') {
    this.pause();
    this.attachRuntime(p);
    this.project = p;
    this.engine.project = p;
    this.selection.clear();
    this.selKeys.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.snapshot = M.serialize(p);
    this.time = Math.min(this.time, this.comp.duration);
    this.dirty = false;
    this.invalidate();
    this.emit('change', { label });
    this.emit('comp');
  }

  // ---------- Sélection ----------
  select(ids, add = false) {
    if (!add) this.selection.clear();
    for (const id of [].concat(ids)) {
      if (add && this.selection.has(id)) this.selection.delete(id);
      else if (id) this.selection.add(id);
    }
    this.emit('select');
    this.requestRender();
  }

  setTool(t) {
    this.tool = t;
    this.emit('tool', t);
  }

  setComp(id) {
    if (!M.compById(this.project, id)) return;
    this.pause();
    this.project.active = id;
    this.selection.clear();
    this.selKeys.clear();
    this.time = Math.min(this.time, this.comp.duration - 1 / this.comp.fps);
    this.invalidate();
    this.emit('comp');
  }

  // ---------- Temps & lecture ----------
  setTime(t, { snap = true } = {}) {
    const c = this.comp;
    t = M.clamp(t, 0, Math.max(0, c.duration - 1 / c.fps));
    if (snap) t = M.snapTime(c, t);
    if (t === this.time && !this.playing) return;
    this.time = t;
    if (this.playing) {
      this.playStart = { wall: performance.now(), t };
      this.audio.play(this.project, c, t);
    }
    this.emit('time', t);
    this.requestRender();
  }

  step(n) {
    this.setTime(this.time + n / this.comp.fps);
  }

  togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }

  play() {
    if (this.playing) return;
    const c = this.comp;
    let t = this.time;
    if (t >= c.workOut - 1 / c.fps || t < c.workIn) t = c.workIn;
    this.time = t;
    this.playing = true;
    this.playStart = { wall: performance.now(), t };
    this.lastShownFrame = -1;
    this.audio.play(this.project, c, t);
    this.emit('play', true);
    this.tick();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.audio.stop();
    cancelAnimationFrame(this.raf);
    this.emit('play', false);
    this.requestRender();
  }

  tick() {
    if (!this.playing) return;
    this.raf = requestAnimationFrame(() => this.tick());
    const c = this.comp;
    const fd = 1 / c.fps;
    let t = this.playStart.t + (performance.now() - this.playStart.wall) / 1000;
    const end = Math.max(c.workIn + fd, c.workOut);
    if (t >= end) {
      if (!this.loop) {
        this.time = M.snapTime(c, end - fd);
        this.pause();
        this.emit('time', this.time);
        return;
      }
      t = c.workIn;
      this.playStart = { wall: performance.now(), t };
      this.audio.play(this.project, c, t);
    }
    const f = Math.floor(t * c.fps + 1e-6);
    if (f === this.lastShownFrame) return;
    // Si le rendu précédent n'est pas terminé, on saute cette image (lecture en temps réel).
    if (this.rendering) return;
    this.lastShownFrame = f;
    this.time = f / c.fps;
    this.emit('time', this.time);
    this.renderNow();
  }

  // ---------- Rendu & cache RAM ----------

  playbackScale() {
    const c = this.comp;
    const r = this.resolution;
    if (r !== 'auto') return Number(r);
    const px = c.width * c.height;
    const maxPx = this.playing || this.interacting ? 1_000_000 : 8_300_000;
    if (px <= maxPx) return 1;
    return Math.max(0.125, Math.sqrt(maxPx / px));
  }

  invalidate() {
    this.clearCache();
    this.requestRender();
  }

  clearCache() {
    // L'image affichée reste valide (le visualiseur peut encore la redessiner).
    for (const b of this.cache.values()) if (b !== this.lastFrameImage) b.close?.();
    this.cache.clear();
    this.emit('cache');
  }

  cacheLimit(scale) {
    const c = this.comp;
    const bytes = Math.max(1, Math.round(c.width * scale) * Math.round(c.height * scale) * 4);
    return Math.max(8, Math.floor((this.cacheBudgetMB * 1024 * 1024) / bytes));
  }

  requestRender() {
    if (this.playing || this.exporting) return;
    if (this.rendering) {
      this.renderPending = true;
      return;
    }
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  async renderNow() {
    if (this.exporting) return;
    if (this.rendering) {
      this.renderPending = true;
      return;
    }
    this.rendering = true;
    try {
      const c = this.comp;
      const scale = this.playbackScale();
      if (scale !== this.cacheScale) {
        this.clearCache();
        this.cacheScale = scale;
      }
      const f = this.frameOf();
      let img = this.cache.get(f);
      if (img) {
        this.lastFrameImage = img;
        this.lastRenderMs = 0;
        this.cacheHit = true;
      } else {
        this.engine.mbEnabled = !this.interacting || !this.fastDraft;
        const t = f / c.fps;
        const canvas = await this.engine.renderFrame(c, t, { scale, bg: !this.transparent });
        this.lastRenderMs = this.engine.lastMs;
        this.cacheHit = false;
        // Mise en cache : capture GPU asynchrone de l'image rendue.
        if (!this.interacting && typeof createImageBitmap === 'function') {
          try {
            img = await createImageBitmap(canvas);
            if (this.cacheScale === scale) {
              this.cache.set(f, img);
              const lim = this.cacheLimit(scale);
              while (this.cache.size > lim) {
                const [k, b] = this.cache.entries().next().value;
                this.cache.delete(k);
                if (b !== this.lastFrameImage) b.close?.();
              }
              this.emit('cache');
            }
          } catch {
            img = null;
          }
        }
        this.lastFrameImage = img || canvas;
      }
      this.frameScale = scale;
      const m = this.fpsMeter;
      m.frames++;
      const now = performance.now();
      if (now - m.t0 > 500) {
        m.fps = (m.frames * 1000) / (now - m.t0);
        m.frames = 0;
        m.t0 = now;
      }
      this.emit('frame');
    } catch (e) {
      console.error(e);
      this.emit('render-error', e);
    } finally {
      this.rendering = false;
      if (this.renderPending) {
        this.renderPending = false;
        this.requestRender();
      }
    }
  }

  // Pré-calcul de la zone de travail en mémoire (aperçu RAM).
  async ramPreview(onProgress) {
    this.pause();
    const c = this.comp;
    const scale = this.playbackScale();
    if (scale !== this.cacheScale) {
      this.clearCache();
      this.cacheScale = scale;
    }
    const f0 = Math.round(c.workIn * c.fps), f1 = Math.max(f0, Math.round(c.workOut * c.fps) - 1);
    const lim = this.cacheLimit(scale);
    const total = Math.min(f1 - f0 + 1, lim);
    this.cancelRam = false;
    let done = 0;
    for (let f = f0; f < f0 + total; f++) {
      if (this.cancelRam) break;
      if (!this.cache.has(f)) {
        const canvas = await this.engine.renderFrame(c, f / c.fps, { scale, bg: !this.transparent });
        this.cache.set(f, await createImageBitmap(canvas));
      }
      done++;
      if (done % 4 === 0) {
        this.emit('cache');
        onProgress?.(done / total);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    this.emit('cache');
    return !this.cancelRam;
  }
}

export function loadPref(k, d) {
  try {
    const v = localStorage.getItem(`prisme.motion.${k}`);
    return v == null ? d : JSON.parse(v);
  } catch {
    return d;
  }
}

export function savePref(k, v) {
  try {
    localStorage.setItem(`prisme.motion.${k}`, JSON.stringify(v));
  } catch {
    /* stockage indisponible */
  }
}
