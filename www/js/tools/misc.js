// Outils divers : déplacement, transformation, recadrage, remplissage, dégradé, pipette,
// texte, formes, main et zoom.

import { Tool, clipToSelection, BRUSH_MODES } from './base.js';
import { drawLabel } from './select.js';
import { createCanvas, cloneCanvas, alphaBounds, getData, rgbToHex, hexToRgb, clamp } from '../util.js';
import { floodMask, maskToImageData } from '../imaging.js';
import { selectionBounds } from '../selection.js';
import { renderText, defaultTextMeta } from '../text.js';

// ---------- Déplacement ----------

export class MoveTool extends Tool {
  constructor(app) {
    super(app, { id: 'move', name: 'Déplacement', icon: 'move', key: 'V', group: 'move', cursor: 'move', defaults: { autoSelect: false } });
  }

  options() {
    return [
      { key: 'autoSelect', label: 'Sélection auto du calque', type: 'checkbox' },
      { key: '_t', label: 'Transformer (Ctrl+T)', type: 'button', action: () => this.app.setTool('transform') },
    ];
  }

  pickLayer(p) {
    const doc = this.doc;
    const x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (!l.visible) continue;
      const a = l.canvas.getContext('2d').getImageData(x, y, 1, 1).data[3];
      if (a > 20) {
        if (doc.activeId !== l.id) {
          doc.activeId = l.id;
          this.app.emit('layers');
        }
        return;
      }
    }
  }

  down(p) {
    if (this.opts.autoSelect || p.ctrl) this.pickLayer(p);
    if (!this.begin()) return;
    const doc = this.doc;
    const layer = (this.layer = doc.active);
    this.start = p;
    this.dx = this.dy = 0;
    const sel = doc.selection;
    if (sel) {
      // Pixels sélectionnés flottants + reste du calque.
      this.floating = clipToSelection(layer.canvas, sel);
      const base = cloneCanvas(layer.canvas);
      const bctx = base.getContext('2d');
      bctx.globalCompositeOperation = 'destination-out';
      bctx.drawImage(sel, 0, 0);
      this.base = base;
    } else {
      this.floating = layer.canvas;
      this.base = null;
    }
    this.moveMask = !sel && layer.mask;
    this.app.setLive({ layerId: layer.id, draw: (ctx) => this.compose(ctx) });
    if (this.moveMask) this.app.setLiveMask({ layerId: layer.id, draw: (ctx) => ctx.drawImage(layer.mask, this.dx, this.dy) });
  }

  compose(ctx) {
    if (this.base) ctx.drawImage(this.base, 0, 0);
    ctx.drawImage(this.floating, this.dx, this.dy);
  }

  move(p) {
    if (!this.layer) return;
    this.dx = Math.round(p.x - this.start.x);
    this.dy = Math.round(p.y - this.start.y);
    if (p.shift) Math.abs(this.dx) > Math.abs(this.dy) ? (this.dy = 0) : (this.dx = 0);
    this.app.invalidate();
  }

  up() {
    if (!this.layer) return;
    if (this.dx || this.dy) this.commit(this.dx, this.dy);
    this.layer = null;
    this.app.live = this.app.liveMask = null;
    this.app.invalidate(true);
  }

  commit(dx, dy) {
    const doc = this.doc, layer = this.layer;
    this.app.history.push('Déplacement');
    const out = createCanvas(doc.width, doc.height);
    const ctx = out.getContext('2d');
    if (this.base) ctx.drawImage(this.base, 0, 0);
    ctx.drawImage(this.floating, dx, dy);
    const text = layer.text;
    layer.canvas = out;
    layer.text = text && !doc.selection ? { ...text, x: text.x + dx, y: text.y + dy } : null;
    if (this.moveMask) {
      const m = createCanvas(doc.width, doc.height);
      m.getContext('2d').drawImage(layer.mask, dx, dy);
      layer.mask = m;
    }
    if (doc.selection) {
      const s = createCanvas(doc.width, doc.height);
      s.getContext('2d').drawImage(doc.selection, dx, dy);
      doc.selection = s;
    }
  }

  cancel() {
    this.layer = null;
    this.app.live = this.app.liveMask = null;
    this.app.invalidate();
  }

  keydown(e) {
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d || !this.doc) return false;
    this.down({ x: 0, y: 0 });
    if (!this.layer) return true;
    this.commit(d[0], d[1]);
    this.layer = null;
    this.app.live = this.app.liveMask = null;
    this.app.invalidate(true);
    return true;
  }
}

// ---------- Transformation libre ----------

const HANDLES = [
  [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0],
];

export class TransformTool extends Tool {
  constructor(app) {
    super(app, { id: 'transform', name: 'Transformation libre', icon: 'transform', key: '', group: 'move', cursor: 'default', defaults: {} });
  }

  options() {
    if (!this.state) return [{ key: '_info', type: 'info', label: 'Choisissez un calque non vide' }];
    const s = this.state;
    return [
      { key: '_w', type: 'info', label: `L ${Math.round(Math.abs(s.sx) * 100)} %  H ${Math.round(Math.abs(s.sy) * 100)} %  ∠ ${Math.round((s.angle * 180) / Math.PI)}°` },
      { key: '_fh', label: '⇋ Horizontal', type: 'button', action: () => this.flip('x') },
      { key: '_fv', label: '⇵ Vertical', type: 'button', action: () => this.flip('y') },
      { key: '_rl', label: '⟲ 90°', type: 'button', action: () => this.rotate(-Math.PI / 2) },
      { key: '_rr', label: '⟳ 90°', type: 'button', action: () => this.rotate(Math.PI / 2) },
      { key: '_ok', label: '✔ Appliquer', type: 'button', primary: true, action: () => this.commit() },
      { key: '_no', label: '✖ Annuler', type: 'button', action: () => this.cancelAll() },
    ];
  }

  activate() {
    this.init();
  }

  init() {
    this.state = null;
    const doc = this.doc;
    if (!doc) return;
    const layer = doc.active;
    if (!layer || layer.locked) return;
    let floating, base = null, bounds;
    if (doc.selection) {
      floating = clipToSelection(layer.canvas, doc.selection);
      base = cloneCanvas(layer.canvas);
      const b = base.getContext('2d');
      b.globalCompositeOperation = 'destination-out';
      b.drawImage(doc.selection, 0, 0);
      bounds = selectionBounds(doc.selection);
    } else {
      floating = layer.canvas;
      bounds = alphaBounds(layer.canvas);
    }
    if (!bounds) return;
    this.layer = layer;
    this.floating = floating;
    this.base = base;
    this.bounds = bounds;
    const c0 = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
    this.state = { c0, cx: c0.x, cy: c0.y, sx: 1, sy: 1, angle: 0 };
    this.app.pending = { commit: () => this.commit(), cancel: () => this.cancelAll() };
    this.app.setLive({ layerId: layer.id, draw: (ctx) => this.compose(ctx) });
    this.app.emit('tool-options');
  }

  reset() {
    this.cancelAll(true);
  }

  matrix(ctx) {
    const s = this.state;
    ctx.translate(s.cx, s.cy);
    ctx.rotate(s.angle);
    ctx.scale(s.sx, s.sy);
    ctx.translate(-s.c0.x, -s.c0.y);
  }

  compose(ctx) {
    if (this.base) ctx.drawImage(this.base, 0, 0);
    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    this.matrix(ctx);
    ctx.drawImage(this.floating, 0, 0);
    ctx.restore();
  }

  // Point local (relatif au centre d'origine, avant échelle) -> document.
  toDocPt(lx, ly) {
    const s = this.state;
    const x = lx * s.sx, y = ly * s.sy;
    const c = Math.cos(s.angle), si = Math.sin(s.angle);
    return { x: s.cx + x * c - y * si, y: s.cy + x * si + y * c };
  }

  handlePts() {
    const b = this.bounds;
    return HANDLES.map(([hx, hy]) => ({ hx, hy, ...this.toDocPt((hx * b.w) / 2, (hy * b.h) / 2) }));
  }

  rotHandle(view) {
    const b = this.bounds;
    const top = this.toDocPt(0, (-b.h / 2) * Math.sign(this.state.sy || 1));
    const s = view.toScreen(top.x, top.y);
    const a = this.state.angle;
    return { x: s.x + Math.sin(a) * 28, y: s.y - Math.cos(a) * 28 };
  }

  hit(p, view) {
    const touch = p.pointerType === 'touch';
    const R = touch ? 22 : 10;
    const sp = { x: p.sx - view.canvas.getBoundingClientRect().left, y: p.sy - view.canvas.getBoundingClientRect().top };
    const rh = this.rotHandle(view);
    if (Math.hypot(sp.x - rh.x, sp.y - rh.y) < R) return { type: 'rotate' };
    for (const h of this.handlePts()) {
      const s = view.toScreen(h.x, h.y);
      if (Math.hypot(sp.x - s.x, sp.y - s.y) < R) return { type: 'scale', hx: h.hx, hy: h.hy };
    }
    if (this.inside(p)) return { type: 'move' };
    return { type: 'rotate' };
  }

  inside(p) {
    const s = this.state, b = this.bounds;
    const c = Math.cos(-s.angle), si = Math.sin(-s.angle);
    const dx = p.x - s.cx, dy = p.y - s.cy;
    const lx = (dx * c - dy * si) / s.sx, ly = (dx * si + dy * c) / s.sy;
    return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2;
  }

  down(p) {
    if (!this.state) {
      this.init();
      if (!this.state) return;
    }
    const view = this.app.view;
    this.drag = { ...this.hit(p, view), p0: p, s0: { ...this.state } };
  }

  move(p) {
    const d = this.drag;
    if (!d) return;
    const s = this.state, s0 = d.s0, b = this.bounds;
    if (d.type === 'move') {
      s.cx = s0.cx + (p.x - d.p0.x);
      s.cy = s0.cy + (p.y - d.p0.y);
    } else if (d.type === 'rotate') {
      const a0 = Math.atan2(d.p0.y - s0.cy, d.p0.x - s0.cx), a1 = Math.atan2(p.y - s0.cy, p.x - s0.cx);
      let a = s0.angle + a1 - a0;
      if (p.shift) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      s.angle = a;
    } else if (d.type === 'scale') {
      // Mise à l'échelle avec le coin / côté opposé fixe.
      Object.assign(s, s0);
      const hw = b.w / 2, hh = b.h / 2;
      const opp = this.toDocPt(-d.hx * hw, -d.hy * hh);
      const c = Math.cos(-s.angle), si = Math.sin(-s.angle);
      const vx = (p.x - opp.x) * c - (p.y - opp.y) * si;
      const vy = (p.x - opp.x) * si + (p.y - opp.y) * c;
      let sx = d.hx ? (vx * d.hx) / (2 * hw) : s0.sx;
      let sy = d.hy ? (vy * d.hy) / (2 * hh) : s0.sy;
      if (d.hx && d.hy && !p.shift) {
        const k = (Math.abs(sx / s0.sx) + Math.abs(sy / s0.sy)) / 2;
        sx = Math.sign(sx || 1) * Math.abs(s0.sx) * k;
        sy = Math.sign(sy || 1) * Math.abs(s0.sy) * k;
      }
      if (Math.abs(sx) < 0.01) sx = 0.01 * Math.sign(sx || 1);
      if (Math.abs(sy) < 0.01) sy = 0.01 * Math.sign(sy || 1);
      s.sx = sx;
      s.sy = sy;
      const ox = d.hx * hw * sx, oy = d.hy * hh * sy;
      const ca = Math.cos(s.angle), sa = Math.sin(s.angle);
      s.cx = opp.x + ox * ca - oy * sa;
      s.cy = opp.y + ox * sa + oy * ca;
    }
    this.app.invalidate();
    this.app.emit('tool-options');
  }

  up() {
    this.drag = null;
  }

  flip(axis) {
    if (!this.state) return;
    if (axis === 'x') this.state.sx *= -1;
    else this.state.sy *= -1;
    this.app.invalidate();
  }

  rotate(a) {
    if (!this.state) return;
    this.state.angle += a;
    this.app.invalidate();
    this.app.emit('tool-options');
  }

  commit() {
    if (!this.state) return;
    const s = this.state;
    const unchanged = s.sx === 1 && s.sy === 1 && !s.angle && s.cx === s.c0.x && s.cy === s.c0.y;
    const layer = this.layer;
    this.app.pending = null;
    if (!unchanged) {
      this.app.history.push('Transformation');
      const out = createCanvas(this.doc.width, this.doc.height);
      this.compose(out.getContext('2d'));
      layer.canvas = out;
      layer.text = null;
      if (layer.mask && !this.base) {
        const m = createCanvas(this.doc.width, this.doc.height);
        const mctx = m.getContext('2d');
        mctx.fillStyle = '#fff';
        mctx.save();
        this.matrix(mctx);
        mctx.drawImage(layer.mask, 0, 0);
        mctx.restore();
        layer.mask = m;
      }
      if (this.doc.selection) {
        const sel = createCanvas(this.doc.width, this.doc.height);
        const sctx = sel.getContext('2d');
        this.matrix(sctx);
        sctx.drawImage(this.doc.selection, 0, 0);
        this.doc.selection = sel;
      }
    }
    this.state = null;
    this.app.live = null;
    this.app.invalidate(true);
    this.app.emit('tool-options');
  }

  cancelAll(silent) {
    if (this.app.pending && this.state) this.app.pending = null;
    this.state = null;
    this.drag = null;
    this.app.live = null;
    this.app.invalidate();
    if (!silent) this.app.emit('tool-options');
  }

  deactivate() {
    this.commit();
  }

  keydown(e) {
    if (!this.state) return false;
    if (e.key === 'Enter') {
      this.commit();
      return true;
    }
    if (e.key === 'Escape') {
      this.cancelAll();
      return true;
    }
    return false;
  }

  drawOverlay(ctx, view) {
    if (!this.state) return;
    const pts = this.handlePts().map((h) => view.toScreen(h.x, h.y));
    ctx.save();
    ctx.strokeStyle = '#4da3ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    [0, 2, 4, 6].forEach((i, k) => (k ? ctx.lineTo(pts[i].x, pts[i].y) : ctx.moveTo(pts[i].x, pts[i].y)));
    ctx.closePath();
    ctx.stroke();
    const rh = this.rotHandle(view);
    const top = pts[1];
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(rh.x, rh.y);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const s of pts) {
      ctx.beginPath();
      ctx.rect(s.x - 5, s.y - 5, 10, 10);
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(rh.x, rh.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

// ---------- Recadrage ----------

export const CROP_RATIOS = [
  ['free', 'Libre'], ['original', 'Original'], ['1:1', '1:1 (carré)'], ['4:5', '4:5 (portrait Insta)'], ['5:4', '5:4'], ['3:2', '3:2'], ['2:3', '2:3'],
  ['4:3', '4:3'], ['3:4', '3:4'], ['16:9', '16:9'], ['9:16', '9:16 (story)'], ['21:9', '21:9 (cinéma)'], ['1.91:1', '1,91:1 (Facebook)'],
];

export class CropTool extends Tool {
  constructor(app) {
    super(app, { id: 'crop', name: 'Recadrage', icon: 'crop', key: 'C', group: 'move', cursor: 'default', defaults: { ratio: 'free', angle: 0, grid: 'thirds' } });
  }

  options() {
    return [
      { key: 'ratio', label: 'Format', type: 'select', options: CROP_RATIOS },
      { key: '_swap', label: '⇄', type: 'button', title: 'Inverser le format', action: () => this.swapRatio() },
      { key: 'angle', label: 'Redresser', type: 'range', min: -45, max: 45, step: 0.1, unit: '°' },
      { key: 'grid', label: 'Grille', type: 'select', options: [['thirds', 'Tiers'], ['golden', 'Nombre d\'or'], ['grid', 'Quadrillage'], ['none', 'Aucune']] },
      { key: '_ok', label: '✔ Appliquer', type: 'button', primary: true, action: () => this.commit() },
      { key: '_no', label: '✖ Réinitialiser', type: 'button', action: () => this.resetRect() },
    ];
  }

  activate() {
    this.resetRect();
  }

  resetRect() {
    const doc = this.doc;
    if (!doc) return;
    this.rect = { x: 0, y: 0, w: doc.width, h: doc.height };
    if (this.opts.angle) this.setOpt('angle', 0);
    this.applyRatio();
    this.syncView();
    this.app.pending = { commit: () => this.commit(), cancel: () => this.resetRect() };
  }

  reset() {
    this.resetRect();
  }

  ratioValue() {
    const r = this.opts.ratio;
    if (r === 'free') return null;
    if (r === 'original') return this.doc.width / this.doc.height;
    const [a, b] = r.split(':').map(Number);
    return a / b;
  }

  swapRatio() {
    const r = this.opts.ratio;
    if (r.includes(':')) {
      const [a, b] = r.split(':');
      const swapped = `${b}:${a}`;
      if (CROP_RATIOS.some(([k]) => k === swapped)) this.setOpt('ratio', swapped);
    } else {
      const { x, y, w, h } = this.rect;
      const cx = x + w / 2, cy = y + h / 2;
      this.rect = { x: cx - h / 2, y: cy - w / 2, w: h, h: w };
      this.app.view.requestRender();
    }
    this.app.emit('tool-options');
  }

  onOption(key) {
    if (key === 'ratio') {
      this.applyRatio();
      this.app.emit('tool-options');
    }
    if (key === 'angle') this.syncView();
  }

  applyRatio() {
    const ratio = this.ratioValue();
    if (!ratio || !this.rect) return;
    const r = this.rect;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    let w = r.w, h = w / ratio;
    if (h > r.h) {
      h = r.h;
      w = h * ratio;
    }
    this.rect = { x: cx - w / 2, y: cy - h / 2, w, h };
    this.app.view?.requestRender();
  }

  syncView() {
    const v = this.app.view;
    if (!v || !this.rect) return;
    v.rotation = (this.opts.angle * Math.PI) / 180;
    v.rotationCenter = { x: this.rect.x + this.rect.w / 2, y: this.rect.y + this.rect.h / 2 };
    v.requestRender();
  }

  deactivate() {
    if (this.rect && this.changed()) this.commit();
    this.app.pending = null;
    const v = this.app.view;
    if (v) {
      v.rotation = 0;
      v.rotationCenter = null;
    }
  }

  changed() {
    const d = this.doc, r = this.rect;
    return d && r && (Math.round(r.x) !== 0 || Math.round(r.y) !== 0 || Math.round(r.w) !== d.width || Math.round(r.h) !== d.height || this.opts.angle);
  }

  hit(p) {
    const v = this.app.view;
    const R = (p.pointerType === 'touch' ? 24 : 10) / v.zoom;
    const r = this.rect;
    const xs = [r.x, r.x + r.w / 2, r.x + r.w], ys = [r.y, r.y + r.h / 2, r.y + r.h];
    for (let iy = 0; iy < 3; iy++)
      for (let ix = 0; ix < 3; ix++) {
        if (ix === 1 && iy === 1) continue;
        if (Math.abs(p.x - xs[ix]) < R && Math.abs(p.y - ys[iy]) < R) return { type: 'handle', hx: ix - 1, hy: iy - 1 };
      }
    // Bords entiers (plus facile à attraper au doigt)
    if (p.x > r.x && p.x < r.x + r.w) {
      if (Math.abs(p.y - r.y) < R) return { type: 'handle', hx: 0, hy: -1 };
      if (Math.abs(p.y - r.y - r.h) < R) return { type: 'handle', hx: 0, hy: 1 };
    }
    if (p.y > r.y && p.y < r.y + r.h) {
      if (Math.abs(p.x - r.x) < R) return { type: 'handle', hx: -1, hy: 0 };
      if (Math.abs(p.x - r.x - r.w) < R) return { type: 'handle', hx: 1, hy: 0 };
    }
    if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) return { type: 'move' };
    return { type: 'new' };
  }

  down(p) {
    if (!this.rect) this.resetRect();
    this.drag = { ...this.hit(p), p0: p, r0: { ...this.rect } };
    if (this.drag.type === 'new') this.drag.anchor = { x: p.x, y: p.y };
  }

  move(p) {
    const d = this.drag;
    if (!d) return;
    const ratio = this.ratioValue();
    const r0 = d.r0;
    let { x, y, w, h } = r0;
    if (d.type === 'move') {
      x += p.x - d.p0.x;
      y += p.y - d.p0.y;
    } else if (d.type === 'new') {
      x = Math.min(d.anchor.x, p.x);
      y = Math.min(d.anchor.y, p.y);
      w = Math.abs(p.x - d.anchor.x);
      h = Math.abs(p.y - d.anchor.y);
      if (ratio) {
        h = w / ratio;
        if (p.y < d.anchor.y) y = d.anchor.y - h;
      }
    } else {
      let x0 = r0.x, y0 = r0.y, x1 = r0.x + r0.w, y1 = r0.y + r0.h;
      if (d.hx < 0) x0 = p.x;
      if (d.hx > 0) x1 = p.x;
      if (d.hy < 0) y0 = p.y;
      if (d.hy > 0) y1 = p.y;
      if (x1 - x0 < 4) d.hx < 0 ? (x0 = x1 - 4) : (x1 = x0 + 4);
      if (y1 - y0 < 4) d.hy < 0 ? (y0 = y1 - 4) : (y1 = y0 + 4);
      x = x0; y = y0; w = x1 - x0; h = y1 - y0;
      if (ratio) {
        if (d.hx && !d.hy) {
          h = w / ratio;
          y = r0.y + (r0.h - h) / 2;
        } else if (d.hy && !d.hx) {
          w = h * ratio;
          x = r0.x + (r0.w - w) / 2;
        } else {
          h = w / ratio;
          if (d.hy < 0) y = r0.y + r0.h - h;
        }
      }
    }
    this.rect = { x, y, w: Math.max(1, w), h: Math.max(1, h) };
    this.syncView();
  }

  up() {
    this.drag = null;
  }

  dblclick() {
    this.commit();
  }

  keydown(e) {
    if (e.key === 'Enter') {
      this.commit();
      return true;
    }
    if (e.key === 'Escape') {
      this.resetRect();
      return true;
    }
    return false;
  }

  commit() {
    if (!this.rect || !this.changed()) return;
    const app = this.app, doc = this.doc;
    const r = { x: Math.round(this.rect.x), y: Math.round(this.rect.y), w: Math.max(1, Math.round(this.rect.w)), h: Math.max(1, Math.round(this.rect.h)) };
    const angle = (this.opts.angle * Math.PI) / 180;
    const cx = this.rect.x + this.rect.w / 2, cy = this.rect.y + this.rect.h / 2;
    app.pending = null;
    app.history.push('Recadrage');
    const cropCanvas = (src, fill) => {
      const c = createCanvas(r.w, r.h);
      const ctx = c.getContext('2d');
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, r.w, r.h);
      }
      ctx.imageSmoothingQuality = 'high';
      ctx.translate(-r.x, -r.y);
      if (angle) {
        ctx.translate(cx, cy);
        ctx.rotate(angle);
        ctx.translate(-cx, -cy);
      }
      ctx.drawImage(src, 0, 0);
      return c;
    };
    for (const l of doc.layers) {
      l.canvas = cropCanvas(l.canvas);
      if (l.mask) l.mask = cropCanvas(l.mask);
      if (l.text) l.text = angle ? null : { ...l.text, x: l.text.x - r.x, y: l.text.y - r.y };
    }
    doc.selection = null;
    doc.width = r.w;
    doc.height = r.h;
    this.opts.angle = 0;
    this.app.view.rotation = 0;
    this.app.view.fit();
    this.rect = { x: 0, y: 0, w: r.w, h: r.h };
    this.applyRatio();
    this.syncView();
    app.pending = { commit: () => this.commit(), cancel: () => this.resetRect() };
    app.invalidate(true);
    app.emit('document');
    app.emit('tool-options');
  }

  drawOverlay(ctx, view) {
    if (!this.rect) return;
    const r = this.rect;
    const a = view.toScreen(r.x, r.y), b = view.toScreen(r.x + r.w, r.y + r.h);
    ctx.save();
    ctx.fillStyle = 'rgba(10,10,14,0.6)';
    ctx.beginPath();
    ctx.rect(0, 0, view.cssW, view.cssH);
    ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
    // Grille de composition
    const W = b.x - a.x, H = b.y - a.y;
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.beginPath();
    const lines = this.opts.grid === 'thirds' ? [1 / 3, 2 / 3] : this.opts.grid === 'golden' ? [0.382, 0.618] : this.opts.grid === 'grid' ? [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875] : [];
    for (const t of lines) {
      ctx.moveTo(a.x + W * t, a.y);
      ctx.lineTo(a.x + W * t, b.y);
      ctx.moveTo(a.x, a.y + H * t);
      ctx.lineTo(b.x, a.y + H * t);
    }
    ctx.stroke();
    // Poignées en équerre
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 4;
    const L = Math.min(22, W / 3, H / 3);
    const corners = [[a.x, a.y, 1, 1], [b.x, a.y, -1, 1], [a.x, b.y, 1, -1], [b.x, b.y, -1, -1]];
    ctx.beginPath();
    for (const [x, y, dx, dy] of corners) {
      ctx.moveTo(x + dx * L, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + dy * L);
    }
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    ctx.moveTo(mx - L / 2, a.y); ctx.lineTo(mx + L / 2, a.y);
    ctx.moveTo(mx - L / 2, b.y); ctx.lineTo(mx + L / 2, b.y);
    ctx.moveTo(a.x, my - L / 2); ctx.lineTo(a.x, my + L / 2);
    ctx.moveTo(b.x, my - L / 2); ctx.lineTo(b.x, my + L / 2);
    ctx.stroke();
    ctx.restore();
    drawLabel(ctx, { x: a.x - 10, y: b.y - 40 }, `${Math.round(r.w)} × ${Math.round(r.h)} px`);
  }
}

// ---------- Pot de peinture ----------

export class FillTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'fill', name: 'Pot de peinture', icon: 'bucket', key: 'G', group: 'paint',
      defaults: { tolerance: 32, contiguous: true, sampleAll: false, opacity: 100, mode: 'source-over' },
    });
  }

  options() {
    return [
      { key: 'tolerance', label: 'Tolérance', type: 'range', min: 0, max: 100 },
      { key: 'opacity', label: 'Opacité', type: 'range', min: 1, max: 100, unit: ' %' },
      { key: 'mode', label: 'Mode', type: 'select', options: BRUSH_MODES },
      { key: 'contiguous', label: 'Contigus', type: 'checkbox' },
      { key: 'sampleAll', label: 'Tous les calques', type: 'checkbox' },
    ];
  }

  down(p) {
    const doc = this.doc;
    if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) return;
    if (!this.begin()) return;
    const t = this.app.target();
    const src = this.opts.sampleAll ? this.app.compositeCanvas : t.canvas;
    const mask = floodMask(getData(src), p.x, p.y, this.opts.tolerance, this.opts.contiguous);
    const fill = createCanvas(doc.width, doc.height);
    const fctx = fill.getContext('2d');
    fctx.putImageData(maskToImageData(mask, doc.width, doc.height), 0, 0);
    fctx.globalCompositeOperation = 'source-in';
    fctx.fillStyle = t.kind === 'mask' ? '#fff' : this.app.primary;
    fctx.fillRect(0, 0, doc.width, doc.height);
    const clipped = clipToSelection(fill, doc.selection);
    this.app.history.push('Pot de peinture');
    const out = cloneCanvas(t.canvas);
    const ctx = out.getContext('2d');
    ctx.globalAlpha = this.opts.opacity / 100;
    ctx.globalCompositeOperation = this.opts.mode;
    ctx.drawImage(clipped, 0, 0);
    this.app.setTargetCanvas(t, out);
    this.app.invalidate(true);
  }
}

// ---------- Dégradé ----------

const GRADIENT_PRESETS = {
  fgbg: null,
  fgtrans: null,
  rainbow: ['#ff0040', '#ff8c00', '#ffe600', '#2ecc40', '#0091ff', '#7a00ff'],
  sunset: ['#2b1055', '#d53369', '#ff8c42', '#ffd36e'],
  ocean: ['#001f3f', '#0074d9', '#7fdbff'],
  gold: ['#7a5410', '#e8c15f', '#fff4c2', '#b8860b'],
  neon: ['#00f5d4', '#9b5de5', '#f15bb5'],
  bw: ['#000000', '#ffffff'],
  peach: ['#ffecd2', '#fcb69f'],
  forest: ['#134e5e', '#71b280'],
  prisme: ['#3db5ff', '#7b5cff', '#f455d8', '#ff9d3d'],
};

export class GradientTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'gradient', name: 'Dégradé', icon: 'gradient', key: 'G', group: 'paint',
      defaults: { type: 'linear', colors: 'fgbg', opacity: 100, mode: 'source-over', reverse: false },
    });
  }

  options() {
    return [
      { key: 'type', label: '', type: 'segmented', options: [['linear', 'Linéaire'], ['radial', 'Radial'], ['conic', 'Angulaire'], ['reflected', 'Réfléchi'], ['diamond', 'Losange']] },
      { key: 'colors', label: 'Couleurs', type: 'select', options: [['fgbg', 'Premier plan → arrière-plan'], ['fgtrans', 'Premier plan → transparent'], ['prisme', 'Prisme'], ['rainbow', 'Arc-en-ciel'], ['sunset', 'Coucher de soleil'], ['ocean', 'Océan'], ['gold', 'Or'], ['neon', 'Néon'], ['peach', 'Pêche'], ['forest', 'Forêt'], ['bw', 'Noir → blanc']] },
      { key: 'opacity', label: 'Opacité', type: 'range', min: 1, max: 100, unit: ' %' },
      { key: 'mode', label: 'Mode', type: 'select', options: BRUSH_MODES },
      { key: 'reverse', label: 'Inverser', type: 'checkbox' },
    ];
  }

  stops() {
    let cols = GRADIENT_PRESETS[this.opts.colors];
    if (this.opts.colors === 'fgbg') cols = [this.app.primary, this.app.secondary];
    if (this.opts.colors === 'fgtrans') {
      const { r, g, b } = hexToRgb(this.app.primary);
      cols = [this.app.primary, `rgba(${r},${g},${b},0)`];
    }
    return this.opts.reverse ? [...cols].reverse() : cols;
  }

  paint(ctx, a, b, w, h) {
    const cols = this.stops();
    const type = this.opts.type;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    let g;
    if (type === 'radial') g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, len);
    else if (type === 'conic' && ctx.createConicGradient) g = ctx.createConicGradient(Math.atan2(b.y - a.y, b.x - a.x), a.x, a.y);
    else if (type === 'reflected') g = ctx.createLinearGradient(2 * a.x - b.x, 2 * a.y - b.y, b.x, b.y);
    else g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    if (type === 'reflected') {
      const all = [...[...cols].reverse(), ...cols.slice(1)];
      all.forEach((c, i) => g.addColorStop(i / (all.length - 1), c));
    } else cols.forEach((c, i) => g.addColorStop(i / (cols.length - 1), c));
    if (type === 'diamond') {
      // Losange : quatre dégradés linéaires découpés en triangles.
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      for (let k = 0; k < 4; k++) {
        const t = ang + (k * Math.PI) / 2;
        const ex = a.x + Math.cos(t) * len, ey = a.y + Math.sin(t) * len;
        const lg = ctx.createLinearGradient(a.x, a.y, ex, ey);
        cols.forEach((c, i) => lg.addColorStop(i / (cols.length - 1), c));
        ctx.save();
        ctx.beginPath();
        const far = Math.max(w, h) * 4;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x + Math.cos(t - Math.PI / 4) * far, a.y + Math.sin(t - Math.PI / 4) * far);
        ctx.lineTo(a.x + Math.cos(t + Math.PI / 4) * far, a.y + Math.sin(t + Math.PI / 4) * far);
        ctx.closePath();
        ctx.clip();
        ctx.fillStyle = lg;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
      return;
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  down(p) {
    if (!this.begin()) return;
    this.t = this.app.target();
    this.a = p;
    this.b = p;
    this.app.setLive({ layerId: this.t.layer.id, draw: (ctx) => this.compose(ctx) });
  }

  move(p) {
    if (!this.t) return;
    let b = p;
    if (p.shift) {
      const ang = Math.round(Math.atan2(p.y - this.a.y, p.x - this.a.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(p.x - this.a.x, p.y - this.a.y);
      b = { x: this.a.x + Math.cos(ang) * len, y: this.a.y + Math.sin(ang) * len };
    }
    this.b = b;
    this.app.invalidate();
  }

  compose(ctx) {
    const doc = this.doc;
    const g = createCanvas(doc.width, doc.height);
    this.paint(g.getContext('2d'), this.a, this.b, doc.width, doc.height);
    ctx.drawImage(this.t.canvas, 0, 0);
    ctx.globalAlpha = this.opts.opacity / 100;
    ctx.globalCompositeOperation = this.opts.mode;
    ctx.drawImage(clipToSelection(g, doc.selection), 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  up() {
    if (!this.t) return;
    const t = this.t;
    this.t = null;
    this.app.live = null;
    if (Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y) < 2) return this.app.invalidate();
    this.app.history.push('Dégradé');
    const out = createCanvas(this.doc.width, this.doc.height);
    this.t = t;
    this.compose(out.getContext('2d'));
    this.t = null;
    if (t.kind === 'mask') {
      // Dans un masque on n'utilise que la luminance du dégradé.
      const d = getData(out);
      for (let q = 0; q < d.data.length; q += 4) {
        const L = (0.299 * d.data[q] + 0.587 * d.data[q + 1] + 0.114 * d.data[q + 2]) * (d.data[q + 3] / 255);
        d.data[q] = d.data[q + 1] = d.data[q + 2] = 255;
        d.data[q + 3] = L;
      }
      out.getContext('2d').putImageData(d, 0, 0);
    }
    this.app.setTargetCanvas(t, out);
    this.app.invalidate(true);
  }

  cancel() {
    this.t = null;
    this.app.live = null;
    this.app.invalidate();
  }

  drawOverlay(ctx, view) {
    if (!this.t) return;
    const a = view.toScreen(this.a.x, this.a.y), b = view.toScreen(this.b.x, this.b.y);
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 3;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    for (const s of [a, b]) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }
    ctx.restore();
  }
}

// ---------- Pipette ----------

export class EyedropperTool extends Tool {
  constructor(app) {
    super(app, { id: 'eyedropper', name: 'Pipette', icon: 'eyedropper', key: 'I', group: 'paint', defaults: { size: 1, source: 'all' } });
  }

  options() {
    return [
      { key: 'size', label: 'Échantillon', type: 'select', options: [[1, 'Pixel'], [3, 'Moyenne 3×3'], [5, 'Moyenne 5×5'], [11, 'Moyenne 11×11'], [31, 'Moyenne 31×31']] },
      { key: 'source', label: 'Source', type: 'select', options: [['all', 'Tous les calques'], ['layer', 'Calque actif']] },
    ];
  }

  sample(p) {
    const doc = this.doc;
    const s = Number(this.opts.size) || 1;
    const x = Math.floor(p.x - (s - 1) / 2), y = Math.floor(p.y - (s - 1) / 2);
    if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) return null;
    const src = this.opts.source === 'layer' ? doc.active.canvas : this.app.compositeCanvas;
    const x0 = clamp(x, 0, doc.width - 1), y0 = clamp(y, 0, doc.height - 1);
    const w = Math.min(s, doc.width - x0), h = Math.min(s, doc.height - y0);
    const d = src.getContext('2d').getImageData(x0, y0, w, h).data;
    let r = 0, g = 0, b = 0, a = 0;
    for (let q = 0; q < d.length; q += 4) {
      r += d[q] * d[q + 3];
      g += d[q + 1] * d[q + 3];
      b += d[q + 2] * d[q + 3];
      a += d[q + 3];
    }
    if (!a) return null;
    return rgbToHex(r / a, g / a, b / a);
  }

  pick(p, which = 'primary') {
    const hex = this.sample(p);
    if (hex) {
      this.app[which] = hex;
      this.app.emit('colors');
    }
    return hex;
  }

  down(p) {
    this.which = p.alt || p.button === 2 ? 'secondary' : 'primary';
    this.pick(p, this.which);
  }

  move(p) {
    this.pick(p, this.which);
  }

  up() {
    this.app.setColor(this.which, this.app[this.which]);
  }

  drawOverlay(ctx, view) {
    const c = view.cursor;
    if (!c) return;
    const hex = this.sample(c);
    if (!hex) return;
    const s = view.toScreen(c.x, c.y);
    const off = c.pointerType === 'touch' ? -70 : 0;
    ctx.save();
    ctx.lineWidth = 10;
    ctx.strokeStyle = hex;
    ctx.beginPath();
    ctx.arc(s.x, s.y + off, 34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.arc(s.x, s.y + off, 39, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    drawLabel(ctx, { x: s.x + 30, y: s.y + off + 20 }, hex.toUpperCase());
  }
}

// ---------- Texte ----------

export class TextTool extends Tool {
  constructor(app) {
    super(app, { id: 'text', name: 'Texte', icon: 'text', key: 'T', group: 'draw', cursor: 'text', defaults: { ...defaultTextMeta() } });
  }

  options() {
    return [{ key: '_hint', type: 'info', label: 'Touchez l\'image pour ajouter un texte. Sur un calque texte : modifier.' }];
  }

  async down(p) {
    const doc = this.doc;
    this.app.flushPending();
    const layer = doc.active;
    if (layer && layer.text && layer.text.bounds) {
      const b = layer.text.bounds;
      if (p.x >= b.x - 10 && p.x <= b.x + b.w + 10 && p.y >= b.y - 10 && p.y <= b.y + b.h + 10) return this.edit(layer);
    }
    const meta = { ...defaultTextMeta(), ...this.opts, color: this.app.primary, text: '', x: p.x, y: p.y };
    const result = await this.app.ui.textDialog(meta, 'Ajouter un texte');
    if (!result || !result.text.trim()) return;
    const { canvas, bounds } = renderText(doc, result);
    const keep = { ...result };
    delete keep.text;
    delete keep.x;
    delete keep.y;
    Object.assign(this.opts, keep);
    this.setOpt('font', result.font);
    this.app.addLayerFromCanvas(canvas, result.text.split('\n')[0].slice(0, 24) || 'Texte', 'Texte', { text: { ...result, bounds } });
  }

  async edit(layer) {
    const result = await this.app.ui.textDialog({ ...layer.text }, 'Modifier le texte');
    if (!result) return;
    if (!this.app.canEdit(layer)) return;
    const { canvas, bounds } = renderText(this.doc, result);
    this.app.history.push('Modifier le texte');
    layer.canvas = canvas;
    layer.text = { ...result, bounds };
    layer.name = result.text.split('\n')[0].slice(0, 24) || layer.name;
    this.app.invalidate(true);
  }

  drawOverlay(ctx, view) {
    const layer = this.doc?.active;
    if (!layer?.text?.bounds) return;
    const b = layer.text.bounds;
    const a = view.toScreen(b.x, b.y), c = view.toScreen(b.x + b.w, b.y + b.h);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#4da3ff';
    ctx.strokeRect(a.x - 4, a.y - 4, c.x - a.x + 8, c.y - a.y + 8);
    ctx.restore();
  }
}

// ---------- Formes ----------

export const SHAPES = [
  ['rect', 'Rectangle'], ['roundrect', 'Rect. arrondi'], ['ellipse', 'Ellipse'], ['line', 'Ligne'], ['arrow', 'Flèche'],
  ['triangle', 'Triangle'], ['polygon', 'Polygone'], ['star', 'Étoile'], ['heart', 'Cœur'], ['bubble', 'Bulle'],
];

export function shapePath(type, x0, y0, x1, y1, o) {
  const p = new Path2D();
  const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  const cx = x + w / 2, cy = y + h / 2;
  switch (type) {
    case 'rect': p.rect(x, y, w, h); break;
    case 'roundrect': p.roundRect(x, y, w, h, Math.min(o.radius, w / 2, h / 2)); break;
    case 'ellipse': p.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case 'line': p.moveTo(x0, y0); p.lineTo(x1, y1); break;
    case 'arrow': {
      const ang = Math.atan2(y1 - y0, x1 - x0), head = Math.max(10, o.strokeWidth * 4);
      p.moveTo(x0, y0);
      p.lineTo(x1, y1);
      p.moveTo(x1 - Math.cos(ang - 0.45) * head, y1 - Math.sin(ang - 0.45) * head);
      p.lineTo(x1, y1);
      p.lineTo(x1 - Math.cos(ang + 0.45) * head, y1 - Math.sin(ang + 0.45) * head);
      break;
    }
    case 'triangle': p.moveTo(cx, y); p.lineTo(x + w, y + h); p.lineTo(x, y + h); p.closePath(); break;
    case 'polygon':
    case 'star': {
      const n = type === 'star' ? o.points : o.sides;
      const steps = type === 'star' ? n * 2 : n;
      for (let i = 0; i < steps; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / steps;
        const k = type === 'star' && i % 2 ? o.inner / 100 : 1;
        const px = cx + Math.cos(a) * (w / 2) * k, py = cy + Math.sin(a) * (h / 2) * k;
        i ? p.lineTo(px, py) : p.moveTo(px, py);
      }
      p.closePath();
      break;
    }
    case 'heart': {
      p.moveTo(cx, y + h * 0.3);
      p.bezierCurveTo(cx, y, x, y, x, y + h * 0.3);
      p.bezierCurveTo(x, y + h * 0.6, cx, y + h * 0.8, cx, y + h);
      p.bezierCurveTo(cx, y + h * 0.8, x + w, y + h * 0.6, x + w, y + h * 0.3);
      p.bezierCurveTo(x + w, y, cx, y, cx, y + h * 0.3);
      p.closePath();
      break;
    }
    case 'bubble': {
      const r = Math.min(w, h) * 0.15;
      p.roundRect(x, y, w, h * 0.78, r);
      p.moveTo(x + w * 0.22, y + h * 0.78);
      p.lineTo(x + w * 0.15, y + h);
      p.lineTo(x + w * 0.4, y + h * 0.78);
      break;
    }
  }
  return p;
}

export class ShapeTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'shape', name: 'Formes', icon: 'shapes', key: 'U', group: 'draw',
      defaults: { shape: 'rect', fill: true, stroke: false, strokeWidth: 6, radius: 24, sides: 6, points: 5, inner: 45, newLayer: true, opacity: 100 },
    });
  }

  options() {
    const o = [
      { key: 'shape', label: 'Forme', type: 'select', options: SHAPES },
      { key: 'fill', label: 'Remplir (1er plan)', type: 'checkbox' },
      { key: 'stroke', label: 'Contour (arrière-plan)', type: 'checkbox' },
      { key: 'strokeWidth', label: 'Épaisseur', type: 'range', min: 1, max: 200, unit: ' px' },
    ];
    if (this.opts.shape === 'roundrect') o.push({ key: 'radius', label: 'Arrondi', type: 'range', min: 0, max: 500, unit: ' px' });
    if (this.opts.shape === 'polygon') o.push({ key: 'sides', label: 'Côtés', type: 'range', min: 3, max: 16 });
    if (this.opts.shape === 'star') o.push({ key: 'points', label: 'Branches', type: 'range', min: 3, max: 24 }, { key: 'inner', label: 'Creux', type: 'range', min: 5, max: 95, unit: ' %' });
    o.push({ key: 'opacity', label: 'Opacité', type: 'range', min: 1, max: 100, unit: ' %' }, { key: 'newLayer', label: 'Nouveau calque', type: 'checkbox' });
    return o;
  }

  onOption(key) {
    if (key === 'shape') this.app.emit('tool-options');
  }

  down(p) {
    this.app.flushPending();
    this.a = p;
    this.b = p;
    this.active = true;
  }

  move(p) {
    if (!this.active) return;
    let b = { x: p.x, y: p.y };
    if (p.shift) {
      if (this.opts.shape === 'line' || this.opts.shape === 'arrow') {
        const ang = Math.round(Math.atan2(p.y - this.a.y, p.x - this.a.x) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(p.x - this.a.x, p.y - this.a.y);
        b = { x: this.a.x + Math.cos(ang) * len, y: this.a.y + Math.sin(ang) * len };
      } else {
        const s = Math.max(Math.abs(p.x - this.a.x), Math.abs(p.y - this.a.y));
        b = { x: this.a.x + Math.sign(p.x - this.a.x || 1) * s, y: this.a.y + Math.sign(p.y - this.a.y || 1) * s };
      }
    }
    this.b = b;
  }

  draw(ctx) {
    const o = this.opts;
    const path = shapePath(o.shape, this.a.x, this.a.y, this.b.x, this.b.y, o);
    const isLine = o.shape === 'line' || o.shape === 'arrow';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (o.fill && !isLine) {
      ctx.fillStyle = this.app.primary;
      ctx.fill(path);
    }
    if (o.stroke || isLine) {
      ctx.strokeStyle = isLine && !o.stroke ? this.app.primary : this.app.secondary;
      ctx.lineWidth = o.strokeWidth;
      ctx.stroke(path);
    }
  }

  up() {
    if (!this.active) return;
    this.active = false;
    if (Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y) < 3) return;
    const doc = this.doc;
    const c = createCanvas(doc.width, doc.height);
    this.draw(c.getContext('2d'));
    const name = SHAPES.find(([k]) => k === this.opts.shape)[1];
    if (this.opts.newLayer) {
      const layer = this.app.addLayerFromCanvas(clipToSelection(c, doc.selection), name, 'Forme');
      layer.opacity = this.opts.opacity / 100;
      this.app.invalidate(true);
    } else {
      if (!this.app.canEdit()) return;
      this.app.applyToTarget('Forme', (src) => {
        const out = cloneCanvas(src);
        const ctx = out.getContext('2d');
        ctx.globalAlpha = this.opts.opacity / 100;
        ctx.drawImage(c, 0, 0);
        return out;
      });
    }
  }

  cancel() {
    this.active = false;
  }

  drawOverlay(ctx, view) {
    if (!this.active) return;
    ctx.save();
    ctx.translate(view.offX, view.offY);
    ctx.scale(view.zoom, view.zoom);
    ctx.globalAlpha = this.opts.opacity / 100;
    this.draw(ctx);
    ctx.restore();
    const r = { w: Math.abs(this.b.x - this.a.x), h: Math.abs(this.b.y - this.a.y) };
    drawLabel(ctx, view.toScreen(this.b.x, this.b.y), `${Math.round(r.w)} × ${Math.round(r.h)}`);
  }
}

// ---------- Main & Zoom ----------

export class HandTool extends Tool {
  constructor(app) {
    super(app, { id: 'hand', name: 'Main', icon: 'hand', key: 'H', group: 'view', cursor: 'grab' });
  }

  options() {
    return [
      { key: '_fit', label: 'Ajuster à l\'écran', type: 'button', action: () => this.app.view.fit() },
      { key: '_100', label: '100 %', type: 'button', action: () => this.app.view.actualPixels() },
    ];
  }
}

export class ZoomTool extends Tool {
  constructor(app) {
    super(app, { id: 'zoom', name: 'Zoom', icon: 'zoom', key: 'Z', group: 'view', cursor: 'zoom-in', defaults: { out: false } });
    this.usesRightClick = true;
  }

  options() {
    return [
      { key: 'out', label: '', type: 'segmented', options: [[false, '＋ Zoom avant'], [true, '－ Zoom arrière']] },
      { key: '_fit', label: 'Ajuster', type: 'button', action: () => this.app.view.fit() },
      { key: '_100', label: '100 %', type: 'button', action: () => this.app.view.actualPixels() },
    ];
  }

  down(p) {
    const v = this.app.view;
    const r = v.canvas.getBoundingClientRect();
    const out = this.opts.out !== (p.alt || p.button === 2);
    v.zoomBy(out ? 1 / 1.6 : 1.6, p.sx - r.left, p.sy - r.top);
  }
}
