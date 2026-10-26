// Outils de sélection : rectangle, ellipse, lasso, lasso polygonal, baguette magique, sélection rapide.

import { Tool, SEL_MODES } from './base.js';
import { createCanvas, getData } from '../util.js';
import { selectionFromPath, combineSelection, featherSelection, wandSelection, isEmptySelection } from '../selection.js';
import { floodMask } from '../imaging.js';

const modeOpt = { key: 'mode', label: '', type: 'segmented', options: SEL_MODES.map(([k, icon, title]) => [k, icon, title]) };
const featherOpt = { key: 'feather', label: 'Contour progressif', type: 'range', min: 0, max: 250, unit: ' px' };

class SelectionTool extends Tool {
  modeFor(p) {
    if (p.shift && p.alt) return 'inter';
    if (p.shift) return 'add';
    if (p.alt) return 'sub';
    return this.opts.mode || 'new';
  }

  commitSelection(newSel, mode, label = 'Sélection') {
    const app = this.app;
    if (newSel && this.opts.feather > 0) newSel = featherSelection(newSel, this.opts.feather);
    const result = combineSelection(this.doc, this.doc.selection, newSel, mode);
    app.history.push(label, { keepPending: true });
    this.doc.selection = result && !isEmptySelection(result) ? result : null;
    app.invalidate();
    app.emit('selection');
  }

  deselectClick() {
    if (!this.doc.selection) return;
    this.app.history.push('Désélectionner', { keepPending: true });
    this.doc.selection = null;
    this.app.invalidate();
    this.app.emit('selection');
  }
}

export class MarqueeTool extends SelectionTool {
  constructor(app, shape = 'rect') {
    super(app, {
      id: shape === 'rect' ? 'marquee' : 'ellipse',
      name: shape === 'rect' ? 'Rectangle de sélection' : 'Ellipse de sélection',
      icon: shape === 'rect' ? 'marquee' : 'ellipse-sel',
      key: 'M', group: 'select',
      defaults: { mode: 'new', feather: 0, ratio: 'free' },
    });
    this.shape = shape;
  }

  options() {
    return [modeOpt, featherOpt, { key: 'ratio', label: 'Proportions', type: 'select', options: [['free', 'Libre'], ['1:1', '1:1'], ['4:3', '4:3'], ['3:2', '3:2'], ['16:9', '16:9'], ['9:16', '9:16']] }];
  }

  down(p) {
    this.start = p;
    this.end = p;
    this.mode = this.modeFor(p);
  }

  move(p) {
    if (!this.start) return;
    this.end = p;
  }

  rect() {
    let x0 = this.start.x, y0 = this.start.y;
    let w = this.end.x - x0, h = this.end.y - y0;
    const ratio = this.opts.ratio !== 'free' ? this.opts.ratio.split(':').map(Number) : null;
    if (ratio || (this.end.shift && this.mode === 'new')) {
      const [rw, rh] = ratio || [1, 1];
      const s = Math.max(Math.abs(w) / rw, Math.abs(h) / rh);
      w = Math.sign(w || 1) * s * rw;
      h = Math.sign(h || 1) * s * rh;
    }
    if (this.end.alt && this.mode === 'new') {
      x0 -= w;
      y0 -= h;
      w *= 2;
      h *= 2;
    }
    return { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), w: Math.abs(w), h: Math.abs(h) };
  }

  path(r) {
    const path = new Path2D();
    if (this.shape === 'rect') path.rect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
    else path.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    return path;
  }

  up(p) {
    if (!this.start) return;
    this.end = p;
    const r = this.rect();
    this.start = null;
    if (r.w < 2 || r.h < 2) {
      if (this.mode === 'new') this.deselectClick();
      return;
    }
    this.commitSelection(selectionFromPath(this.doc, this.path(r)), this.mode);
  }

  cancel() {
    this.start = null;
  }

  drawOverlay(ctx, view) {
    if (!this.start) return;
    const r = this.rect();
    const a = view.toScreen(r.x, r.y);
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.scale(view.zoom, view.zoom);
    const path = this.path({ x: 0, y: 0, w: r.w, h: r.h });
    ctx.lineWidth = 1 / view.zoom;
    ctx.setLineDash([5 / view.zoom, 4 / view.zoom]);
    ctx.strokeStyle = '#000';
    ctx.stroke(path);
    ctx.lineDashOffset = 5 / view.zoom;
    ctx.strokeStyle = '#fff';
    ctx.stroke(path);
    ctx.restore();
    drawLabel(ctx, view.toScreen(r.x + r.w, r.y + r.h), `${Math.round(r.w)} × ${Math.round(r.h)}`);
  }
}

export function drawLabel(ctx, at, text) {
  ctx.save();
  ctx.font = '600 12px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = 'rgba(20,20,26,0.85)';
  ctx.beginPath();
  ctx.roundRect(at.x + 10, at.y + 10, w, 22, 6);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(text, at.x + 16, at.y + 25);
  ctx.restore();
}

export class LassoTool extends SelectionTool {
  constructor(app) {
    super(app, { id: 'lasso', name: 'Lasso', icon: 'lasso', key: 'L', group: 'select', defaults: { mode: 'new', feather: 0 } });
    this.wantsCoalesced = true;
  }

  options() {
    return [modeOpt, featherOpt];
  }

  down(p) {
    this.points = [p];
    this.mode = this.modeFor(p);
  }

  move(p) {
    if (!this.points) return;
    const last = this.points[this.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) * this.app.view.zoom > 2) this.points.push(p);
  }

  up() {
    const pts = this.points;
    this.points = null;
    if (!pts || pts.length < 3) {
      if (this.mode === 'new') this.deselectClick();
      return;
    }
    const path = new Path2D();
    path.moveTo(pts[0].x, pts[0].y);
    for (const q of pts.slice(1)) path.lineTo(q.x, q.y);
    path.closePath();
    this.commitSelection(selectionFromPath(this.doc, path, 'evenodd'), this.mode);
  }

  cancel() {
    this.points = null;
  }

  drawOverlay(ctx, view) {
    if (!this.points) return;
    drawPolyline(ctx, view, this.points, false);
  }
}

function drawPolyline(ctx, view, pts, closed, extra) {
  ctx.save();
  ctx.beginPath();
  pts.forEach((q, i) => {
    const s = view.toScreen(q.x, q.y);
    if (i) ctx.lineTo(s.x, s.y);
    else ctx.moveTo(s.x, s.y);
  });
  if (extra) {
    const s = view.toScreen(extra.x, extra.y);
    ctx.lineTo(s.x, s.y);
  }
  if (closed) ctx.closePath();
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = '#000';
  ctx.stroke();
  ctx.lineDashOffset = 5;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.restore();
}

export class PolyLassoTool extends SelectionTool {
  constructor(app) {
    super(app, { id: 'polylasso', name: 'Lasso polygonal', icon: 'polylasso', key: 'L', group: 'select', defaults: { mode: 'new', feather: 0 } });
  }

  options() {
    return [modeOpt, featherOpt, { key: '_close', label: 'Fermer', type: 'button', action: () => this.close() }, { key: '_cancel', label: 'Annuler', type: 'button', action: () => this.reset() }];
  }

  down(p) {
    if (!this.points) {
      this.points = [];
      this.mode = this.modeFor(p);
    }
    const first = this.points[0];
    if (first && this.points.length > 2 && Math.hypot(p.x - first.x, p.y - first.y) * this.app.view.zoom < 12) {
      this.close();
      return;
    }
    this.points.push({ x: p.x, y: p.y });
    this.hoverPt = p;
  }

  hover(p) {
    this.hoverPt = p;
  }

  move(p) {
    this.hoverPt = p;
  }

  dblclick() {
    this.close();
  }

  keydown(e) {
    if (!this.points) return false;
    if (e.key === 'Enter') {
      this.close();
      return true;
    }
    if (e.key === 'Escape') {
      this.reset();
      return true;
    }
    if (e.key === 'Backspace') {
      this.points.pop();
      if (!this.points.length) this.reset();
      this.app.view.requestRender();
      return true;
    }
    return false;
  }

  close() {
    const pts = this.points;
    this.reset();
    if (!pts || pts.length < 3) return;
    const path = new Path2D();
    path.moveTo(pts[0].x, pts[0].y);
    for (const q of pts.slice(1)) path.lineTo(q.x, q.y);
    path.closePath();
    this.commitSelection(selectionFromPath(this.doc, path, 'evenodd'), this.mode);
  }

  reset() {
    this.points = null;
    this.app.view?.requestRender();
  }

  deactivate() {
    this.reset();
  }

  drawOverlay(ctx, view) {
    if (!this.points || !this.points.length) return;
    drawPolyline(ctx, view, this.points, false, this.hoverPt);
    const f = view.toScreen(this.points[0].x, this.points[0].y);
    ctx.beginPath();
    ctx.arc(f.x, f.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();
  }
}

export class WandTool extends SelectionTool {
  constructor(app) {
    super(app, {
      id: 'wand', name: 'Baguette magique', icon: 'wand', key: 'W', group: 'select',
      defaults: { mode: 'new', tolerance: 32, contiguous: true, sampleAll: false, feather: 0 },
    });
  }

  options() {
    return [
      modeOpt,
      { key: 'tolerance', label: 'Tolérance', type: 'range', min: 0, max: 100 },
      { key: 'contiguous', label: 'Pixels contigus', type: 'checkbox' },
      { key: 'sampleAll', label: 'Tous les calques', type: 'checkbox' },
      featherOpt,
    ];
  }

  down(p) {
    const doc = this.doc;
    if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) return;
    const app = this.app;
    const src = this.opts.sampleAll ? app.compositeCanvas : app.doc.active.canvas;
    const sel = wandSelection(doc, src, p.x, p.y, this.opts.tolerance, this.opts.contiguous);
    this.commitSelection(sel, this.modeFor(p), 'Baguette magique');
  }
}

// Sélection rapide : on « peint » la zone, la sélection s'étend aux couleurs similaires sous le pinceau.
export class QuickSelectTool extends SelectionTool {
  constructor(app) {
    super(app, {
      id: 'quickselect', name: 'Sélection rapide', icon: 'quicksel', key: 'W', group: 'select', cursor: 'none',
      defaults: { mode: 'add', size: 40, tolerance: 22, sampleAll: true },
    });
  }

  options() {
    return [
      { key: 'mode', label: '', type: 'segmented', options: [['add', '⊕', 'Ajouter'], ['sub', '⊖', 'Soustraire']] },
      { key: 'size', label: 'Taille', type: 'range', min: 4, max: 400, unit: ' px' },
      { key: 'tolerance', label: 'Tolérance', type: 'range', min: 1, max: 100 },
      { key: 'sampleAll', label: 'Tous les calques', type: 'checkbox' },
      { key: '_subject', label: '✨ Sélectionner le sujet', type: 'button', action: () => this.app.actions.run('ai.selectSubject') },
    ];
  }

  down(p) {
    this.app.flushPending();
    const src = this.opts.sampleAll ? this.app.compositeCanvas : this.doc.active.canvas;
    this.data = getData(src);
    this.subtract = p.alt || this.opts.mode === 'sub';
    this.app.history.push('Sélection rapide');
    this.acc = createCanvas(this.doc.width, this.doc.height);
    if (this.doc.selection && !this.subtract) this.acc.getContext('2d').drawImage(this.doc.selection, 0, 0);
    if (this.subtract) {
      if (!this.doc.selection) {
        this.app.history.discardLast();
        this.data = null;
        return;
      }
      this.acc.getContext('2d').drawImage(this.doc.selection, 0, 0);
    }
    this.last = null;
    this.grow(p);
  }

  grow(p) {
    if (!this.data) return;
    if (this.last && Math.hypot(p.x - this.last.x, p.y - this.last.y) < this.opts.size * 0.25) return;
    this.last = p;
    const w = this.doc.width, h = this.doc.height;
    const r = this.opts.size;
    const region = { x0: Math.floor(p.x - r * 1.5), y0: Math.floor(p.y - r * 1.5), x1: Math.ceil(p.x + r * 1.5), y1: Math.ceil(p.y + r * 1.5) };
    const mask = floodMask(this.data, p.x, p.y, this.opts.tolerance, true, region);
    const bx = Math.max(0, region.x0), by = Math.max(0, region.y0);
    const bw = Math.min(w, region.x1 + 1) - bx, bh = Math.min(h, region.y1 + 1) - by;
    if (bw <= 0 || bh <= 0) return;
    const img = new ImageData(bw, bh);
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) {
        const m = mask[(y + by) * w + x + bx];
        // Toujours inclure le disque du pinceau lui-même.
        const inBrush = Math.hypot(x + bx - p.x, y + by - p.y) < r / 2;
        if (m || inBrush) {
          const q = (y * bw + x) * 4;
          img.data[q] = img.data[q + 1] = img.data[q + 2] = img.data[q + 3] = 255;
        }
      }
    const piece = createCanvas(bw, bh);
    piece.getContext('2d').putImageData(img, 0, 0);
    const ctx = this.acc.getContext('2d');
    ctx.globalCompositeOperation = this.subtract ? 'destination-out' : 'source-over';
    ctx.drawImage(piece, bx, by);
    ctx.globalCompositeOperation = 'source-over';
    // On remplace la sélection par une copie (les anciens états restent intacts dans l'historique).
    const snap = createCanvas(w, h);
    snap.getContext('2d').drawImage(this.acc, 0, 0);
    this.doc.selection = snap;
    this.app.invalidate();
  }

  move(p) {
    this.grow(p);
  }

  up() {
    if (!this.data) return;
    this.data = null;
    if (this.doc.selection && isEmptySelection(this.doc.selection)) this.doc.selection = null;
    this.app.emit('selection');
  }

  cancel() {
    this.up();
  }

  drawOverlay(ctx, view) {
    view.drawBrushCursor(ctx, this.opts.size);
  }
}
