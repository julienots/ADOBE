// Outils de peinture et de retouche : pinceau, crayon, gomme, tampon, correcteur,
// doigt, densité, goutte d'eau / netteté, yeux rouges.

import { Tool, brushTip, Stroker, clipToSelection, BRUSH_MODES } from './base.js';
import { createCanvas, cloneCanvas, blendWithSelection, hexToRgb, getData, canvasFromData, clamp } from '../util.js';
import { gaussianBlur, blurAlpha } from '../imaging.js';
import { unsharp } from '../develop.js';
import { contentAwareFill } from '../inpaint.js';
import { busy } from '../ui.js';

const sizeOpt = { key: 'size', label: 'Taille', type: 'range', min: 1, max: 1000, step: 1, unit: ' px', log: true };
const hardOpt = { key: 'hardness', label: 'Dureté', type: 'range', min: 0, max: 100, unit: ' %' };
const opacityOpt = { key: 'opacity', label: 'Opacité', type: 'range', min: 1, max: 100, unit: ' %' };
const flowOpt = { key: 'flow', label: 'Flux', type: 'range', min: 1, max: 100, unit: ' %' };

// Rendu « en direct » sur la bonne cible (pixels ou masque).
function setLiveFor(app, t, draw) {
  if (t.kind === 'mask') app.setLiveMask({ layerId: t.layer.id, draw });
  else app.setLive({ layerId: t.layer.id, draw });
}

function clearLive(app) {
  app.live = null;
  app.liveMask = null;
  app.invalidate();
}

// ---------- Pinceau / Crayon / Gomme ----------

export class BrushTool extends Tool {
  constructor(app, def = {}) {
    super(app, {
      id: 'brush', name: 'Pinceau', icon: 'brush', key: 'B', group: 'paint', cursor: 'none',
      defaults: { size: 30, hardness: 70, opacity: 100, flow: 100, spacing: 12, smoothing: 30, mode: 'source-over', pressure: true },
      ...def,
    });
    this.wantsCoalesced = true;
    this.erase = !!def.erase;
    this.pencil = !!def.pencil;
  }

  options() {
    const o = [sizeOpt];
    if (!this.pencil) o.push(hardOpt);
    o.push(opacityOpt);
    if (!this.pencil) o.push(flowOpt, { key: 'smoothing', label: 'Lissage', type: 'range', min: 0, max: 90, unit: ' %' });
    if (!this.erase) o.push({ key: 'mode', label: 'Mode', type: 'select', options: BRUSH_MODES });
    o.push({ key: 'pressure', label: 'Pression (stylet)', type: 'checkbox' });
    return o;
  }

  color() {
    return this.app.primary;
  }

  down(p) {
    if (p.alt && !this.erase) {
      this.app.tools.eyedropper.pick(p, p.button === 2 ? 'secondary' : 'primary');
      this.picking = true;
      return;
    }
    this.picking = false;
    if (!this.begin()) return (this.t = null);
    const app = this.app;
    const t = (this.t = app.target());
    this.base = t.canvas;
    this.stroke = createCanvas(this.doc.width, this.doc.height);
    this.sctx = this.stroke.getContext('2d');
    this.clipped = null;
    const size = this.opts.size;
    this.stroker = new Stroker(this.pencil ? 1 : Math.max(1, (size * this.opts.spacing) / 100));
    this.smoothed = { ...p };
    // Dans un masque : couleur claire = révéler, couleur sombre = masquer.
    let color = this.pencil || this.erase ? '#ffffff' : this.color();
    this.maskHide = false;
    if (t.kind === 'mask') {
      const { r, g, b } = hexToRgb(this.app.primary);
      const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      this.maskHide = this.erase ? false : L < 0.5;
      this.maskStrength = this.erase ? 1 : Math.abs(L - 0.5) * 2;
      color = '#ffffff';
    }
    this.tipColor = this.pencil && !this.erase && t.kind !== 'mask' ? this.color() : this.erase ? '#ffffff' : color;
    this.stroker.start(p, this.dab);
    setLiveFor(app, t, (ctx) => this.drawLive(ctx));
  }

  dab = (x, y, pressure) => {
    const o = this.opts;
    const pr = o.pressure ? pressure : 1;
    const size = Math.max(1, o.size * (o.pressure ? 0.25 + 0.75 * pr : 1));
    const hard = this.pencil ? 1 : o.hardness / 100;
    const tip = brushTip(size, hard, this.tipColor);
    const ctx = this.sctx;
    ctx.globalAlpha = this.pencil ? 1 : (o.flow / 100) * (o.pressure ? 0.4 + 0.6 * pr : 1);
    if (this.pencil) {
      ctx.drawImage(tip, Math.round(x - tip.width / 2), Math.round(y - tip.height / 2));
    } else ctx.drawImage(tip, x - tip.width / 2, y - tip.height / 2);
  };

  move(p) {
    if (this.picking) {
      this.app.tools.eyedropper.pick(p, 'primary');
      return;
    }
    if (!this.t) return;
    // Stabilisateur : le point suit le pointeur avec du retard.
    const k = this.pencil ? 0 : this.opts.smoothing / 100;
    this.smoothed.x += (p.x - this.smoothed.x) * (1 - k);
    this.smoothed.y += (p.y - this.smoothed.y) * (1 - k);
    this.smoothed.pressure = p.pressure;
    this.stroker.to({ ...this.smoothed }, this.dab);
    this.app.invalidate();
  }

  strokeLayer() {
    this.clipped = clipToSelection(this.stroke, this.doc.selection, this.clipped);
    return this.clipped;
  }

  composeOnto(ctx) {
    const o = this.opts;
    const s = this.strokeLayer();
    ctx.drawImage(this.base, 0, 0);
    if (this.t.kind === 'mask') {
      ctx.globalAlpha = (o.opacity / 100) * this.maskStrength;
      ctx.globalCompositeOperation = this.maskHide ? 'destination-out' : 'source-over';
    } else {
      ctx.globalAlpha = o.opacity / 100;
      ctx.globalCompositeOperation = this.erase ? 'destination-out' : o.mode === 'source-over' ? 'source-over' : o.mode;
      if (!this.erase && o.mode !== 'source-over') {
        // Les modes de fusion ne doivent pas peindre hors des pixels existants.
        const tmp = createCanvas(s.width, s.height);
        const tctx = tmp.getContext('2d');
        tctx.drawImage(s, 0, 0);
        tctx.globalCompositeOperation = 'destination-in';
        tctx.drawImage(this.base, 0, 0);
        ctx.drawImage(tmp, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        return;
      }
    }
    ctx.drawImage(s, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  drawLive(ctx) {
    this.composeOnto(ctx);
  }

  up() {
    if (this.picking || !this.t) return;
    const app = this.app;
    const t = this.t;
    app.history.push(this.erase ? 'Gomme' : this.pencil ? 'Crayon' : 'Pinceau');
    const out = createCanvas(this.doc.width, this.doc.height);
    this.composeOnto(out.getContext('2d'));
    app.setTargetCanvas(t, out);
    this.t = null;
    clearLive(app);
    app.emit('layers');
  }

  cancel() {
    this.t = null;
    clearLive(this.app);
  }

  drawOverlay(ctx, view) {
    view.drawBrushCursor(ctx, this.opts.size);
  }
}

// ---------- Tampon de duplication ----------

export class CloneTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'clone', name: 'Tampon de duplication', icon: 'stamp', key: 'S', group: 'retouch', cursor: 'none',
      defaults: { size: 60, hardness: 50, opacity: 100, aligned: true, sampleAll: false, setSource: false },
    });
    this.wantsCoalesced = true;
    this.source = null;
  }

  options() {
    return [
      { key: 'setSource', label: 'Définir la source', type: 'toggle', hint: 'Ou Alt + clic' },
      sizeOpt, hardOpt, opacityOpt,
      { key: 'aligned', label: 'Aligné', type: 'checkbox' },
      { key: 'sampleAll', label: 'Tous les calques', type: 'checkbox' },
    ];
  }

  down(p) {
    if (p.alt || this.opts.setSource) {
      this.source = { x: p.x, y: p.y };
      this.offset = null;
      if (this.opts.setSource) this.setOpt('setSource', false);
      this.app.toast('Source définie ✔', 1000);
      this.t = null;
      return;
    }
    if (!this.source) {
      this.app.toast(window.matchMedia('(pointer: coarse)').matches ? 'Touchez « Définir la source » puis l’image' : 'Alt + clic pour définir la source');
      return;
    }
    if (!this.begin()) return;
    const t = (this.t = this.app.target());
    this.base = t.canvas;
    this.sample = this.opts.sampleAll ? cloneCanvas(this.app.compositeCanvas) : cloneCanvas(t.canvas);
    if (!this.opts.aligned || !this.offset) this.offset = { x: this.source.x - p.x, y: this.source.y - p.y };
    this.stroke = createCanvas(this.doc.width, this.doc.height);
    this.sctx = this.stroke.getContext('2d');
    this.tmp = createCanvas(4, 4);
    this.stroker = new Stroker(Math.max(1, this.opts.size * 0.1));
    this.stroker.start(p, this.dab);
    setLiveFor(this.app, t, (ctx) => this.compose(ctx));
  }

  dab = (x, y) => {
    const d = Math.max(2, Math.round(this.opts.size));
    const tip = brushTip(d, this.opts.hardness / 100);
    if (this.tmp.width !== tip.width) this.tmp.width = this.tmp.height = tip.width;
    const tctx = this.tmp.getContext('2d');
    const s = tip.width;
    tctx.globalCompositeOperation = 'copy';
    tctx.drawImage(this.sample, x + this.offset.x - s / 2, y + this.offset.y - s / 2, s, s, 0, 0, s, s);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(tip, 0, 0);
    this.sctx.drawImage(this.tmp, x - s / 2, y - s / 2);
  };

  move(p) {
    if (!this.t) return;
    this.stroker.to(p, this.dab);
    this.app.invalidate();
  }

  compose(ctx) {
    ctx.drawImage(this.base, 0, 0);
    ctx.globalAlpha = this.opts.opacity / 100;
    ctx.drawImage(clipToSelection(this.stroke, this.doc.selection), 0, 0);
    ctx.globalAlpha = 1;
  }

  up() {
    if (!this.t) return;
    this.app.history.push('Tampon de duplication');
    const out = createCanvas(this.doc.width, this.doc.height);
    this.compose(out.getContext('2d'));
    this.app.setTargetCanvas(this.t, out);
    this.t = null;
    clearLive(this.app);
    this.app.emit('layers');
  }

  cancel() {
    this.t = null;
    clearLive(this.app);
  }

  drawOverlay(ctx, view) {
    view.drawBrushCursor(ctx, this.opts.size);
    let src = this.source;
    if (this.t && view.cursor && this.offset) src = { x: view.cursor.x + this.offset.x, y: view.cursor.y + this.offset.y };
    else if (this.opts.aligned && this.offset && view.cursor) src = { x: view.cursor.x + this.offset.x, y: view.cursor.y + this.offset.y };
    if (!src) return;
    const s = view.toScreen(src.x, src.y);
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 3;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(s.x - 10, s.y);
    ctx.lineTo(s.x + 10, s.y);
    ctx.moveTo(s.x, s.y - 10);
    ctx.lineTo(s.x, s.y + 10);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.x, s.y, (this.opts.size / 2) * view.zoom, 0, Math.PI * 2);
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.restore();
  }

  reset() {
    this.t = null;
  }
}

// ---------- Correcteur localisé ----------
// On peint sur le défaut ; au relâchement, on cherche une zone voisine qui raccorde le mieux,
// on la recopie avec un contour progressif et on harmonise sa teinte avec le pourtour.

export class HealTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'heal', name: 'Correcteur / Suppression d\'objet', icon: 'bandage', key: 'J', group: 'retouch', cursor: 'none',
      defaults: { size: 40, mode: 'content' },
    });
    this.wantsCoalesced = true;
  }

  options() {
    return [
      { key: 'mode', label: '', type: 'segmented', options: [['content', 'Suppression intelligente'], ['quick', 'Correcteur rapide']] },
      { ...sizeOpt, max: 600 },
      { key: '_hint', type: 'info', label: 'Peignez sur l\'objet ou le défaut à faire disparaître' },
    ];
  }

  down(p) {
    if (!this.begin()) return;
    const t = (this.t = this.app.target());
    if (t.kind === 'mask') {
      this.t = null;
      return this.app.toast('Le correcteur agit sur les pixels, pas sur le masque');
    }
    this.mask = createCanvas(this.doc.width, this.doc.height);
    this.mctx = this.mask.getContext('2d');
    this.stroker = new Stroker(Math.max(1, this.opts.size * 0.15));
    this.stroker.start(p, this.dab);
    this.app.setLive({ layerId: t.layer.id, draw: (ctx) => {
      ctx.drawImage(t.canvas, 0, 0);
      ctx.globalAlpha = 0.45;
      ctx.drawImage(this.tinted(), 0, 0);
      ctx.globalAlpha = 1;
    } });
  }

  tinted() {
    if (!this.tint || this.tintDirty) {
      this.tint = this.tint || createCanvas(this.doc.width, this.doc.height);
      const c = this.tint.getContext('2d');
      c.globalCompositeOperation = 'copy';
      c.drawImage(this.mask, 0, 0);
      c.globalCompositeOperation = 'source-in';
      c.fillStyle = '#ff2d55';
      c.fillRect(0, 0, this.tint.width, this.tint.height);
      this.tintDirty = false;
    }
    return this.tint;
  }

  dab = (x, y) => {
    this.mctx.drawImage(brushTip(this.opts.size, 0.9), x - (this.opts.size + 2) / 2, y - (this.opts.size + 2) / 2);
    this.tintDirty = true;
  };

  move(p) {
    if (!this.t) return;
    this.stroker.to(p, this.dab);
    this.app.invalidate();
  }

  async up() {
    if (!this.t) return;
    const t = this.t;
    this.t = null;
    const mask = this.mask;
    const result = this.opts.mode === 'quick'
      ? healArea(t.canvas, mask, this.opts.size)
      : await busy(() => contentAwareFill(t.canvas, mask), 'Suppression de l\'objet…');
    this.tint = null;
    clearLive(this.app);
    if (!result) return;
    this.app.history.push('Correcteur');
    this.app.setTargetCanvas(t, this.doc.selection ? blendWithSelection(t.canvas, result, this.doc.selection) : result);
    this.app.invalidate(true);
  }

  cancel() {
    this.t = null;
    clearLive(this.app);
  }

  drawOverlay(ctx, view) {
    view.drawBrushCursor(ctx, this.opts.size);
  }
}

export function healArea(canvas, mask, size) {
  const W = canvas.width, H = canvas.height;
  const md = getData(mask).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (md[(y * W + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
  if (x1 < 0) return null;
  const pad = Math.max(4, Math.round(size * 0.35));
  const bx = Math.max(0, x0 - pad), by = Math.max(0, y0 - pad);
  const bw = Math.min(W, x1 + pad + 1) - bx, bh = Math.min(H, y1 + pad + 1) - by;
  const ctx = canvas.getContext('2d');
  const target = ctx.getImageData(bx, by, bw, bh);
  const td = target.data;
  const localMask = mask.getContext('2d').getImageData(bx, by, bw, bh).data;

  // Pourtour : pixels de la boîte hors du masque, utilisés pour comparer les candidats.
  const ring = [];
  for (let i = 0; i < bw * bh; i++) if (localMask[i * 4 + 3] < 10) ring.push(i);
  const step = Math.max(1, Math.floor(ring.length / 1500));

  const dist = Math.max(bw, bh) * 1.1;
  let best = null;
  for (const mult of [1, 1.6, 2.4]) {
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const ox = Math.round(Math.cos(a) * dist * mult), oy = Math.round(Math.sin(a) * dist * mult);
      const sx = bx + ox, sy = by + oy;
      if (sx < 0 || sy < 0 || sx + bw > W || sy + bh > H) continue;
      const cand = ctx.getImageData(sx, sy, bw, bh).data;
      let err = 0;
      for (let j = 0; j < ring.length; j += step) {
        const q = ring[j] * 4;
        const dr = cand[q] - td[q], dg = cand[q + 1] - td[q + 1], db = cand[q + 2] - td[q + 2];
        err += dr * dr + dg * dg + db * db;
      }
      // Pénalise aussi les candidats contenant beaucoup de texture.
      if (!best || err < best.err) best = { err, cand, sx, sy };
    }
    if (best) break;
  }
  if (!best) return null;

  // Harmonisation de couleur : écart moyen sur le pourtour.
  let mr = 0, mg = 0, mb = 0, n = 0;
  for (let j = 0; j < ring.length; j++) {
    const q = ring[j] * 4;
    mr += td[q] - best.cand[q];
    mg += td[q + 1] - best.cand[q + 1];
    mb += td[q + 2] - best.cand[q + 2];
    n++;
  }
  mr /= n || 1; mg /= n || 1; mb /= n || 1;

  // Masque adouci pour le raccord.
  const soft = new ImageData(new Uint8ClampedArray(localMask), bw, bh);
  for (let i = 3; i < soft.data.length; i += 4) soft.data[i] = soft.data[i] > 10 ? 255 : 0;
  blurAlpha(soft, Math.max(1.5, size * 0.12));
  const sd = soft.data;
  const out = ctx.getImageData(bx, by, bw, bh);
  const od = out.data;
  for (let i = 0; i < bw * bh; i++) {
    const q = i * 4;
    const a = sd[q + 3] / 255;
    if (a <= 0) continue;
    od[q] = td[q] + (best.cand[q] + mr - td[q]) * a;
    od[q + 1] = td[q + 1] + (best.cand[q + 1] + mg - td[q + 1]) * a;
    od[q + 2] = td[q + 2] + (best.cand[q + 2] + mb - td[q + 2]) * a;
    od[q + 3] = Math.max(td[q + 3], best.cand[q + 3] * a);
  }
  const result = cloneCanvas(canvas);
  result.getContext('2d').putImageData(out, bx, by);
  return result;
}

// ---------- Doigt (étaler) ----------

export class SmudgeTool extends Tool {
  constructor(app) {
    super(app, { id: 'smudge', name: 'Doigt', icon: 'finger', key: '', group: 'retouch', cursor: 'none', defaults: { size: 40, strength: 60, hardness: 30 } });
    this.wantsCoalesced = true;
  }

  options() {
    return [{ ...sizeOpt, max: 400 }, hardOpt, { key: 'strength', label: 'Intensité', type: 'range', min: 1, max: 100, unit: ' %' }];
  }

  down(p) {
    if (!this.begin()) return;
    const t = (this.t = this.app.target());
    this.base = t.canvas;
    this.work = cloneCanvas(t.canvas);
    this.wctx = this.work.getContext('2d');
    const d = Math.max(2, Math.round(this.opts.size)) + 2;
    this.sample = createCanvas(d, d);
    this.tmp = createCanvas(d, d);
    this.sample.getContext('2d').drawImage(this.work, p.x - d / 2, p.y - d / 2, d, d, 0, 0, d, d);
    this.stroker = new Stroker(Math.max(1, this.opts.size * 0.08));
    this.stroker.last = p;
    setLiveFor(this.app, t, (ctx) => ctx.drawImage(this.work, 0, 0));
  }

  dab = (x, y) => {
    const d = this.sample.width;
    const tip = brushTip(d - 2, this.opts.hardness / 100);
    const k = this.opts.strength / 100;
    const tctx = this.tmp.getContext('2d');
    tctx.globalCompositeOperation = 'copy';
    tctx.drawImage(this.sample, 0, 0);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(tip, 0, 0, d, d);
    this.wctx.globalAlpha = k;
    this.wctx.drawImage(this.tmp, x - d / 2, y - d / 2);
    this.wctx.globalAlpha = 1;
    const sctx = this.sample.getContext('2d');
    sctx.globalAlpha = 1 - k * 0.85;
    sctx.drawImage(this.work, x - d / 2, y - d / 2, d, d, 0, 0, d, d);
    sctx.globalAlpha = 1;
  };

  move(p) {
    if (!this.t) return;
    this.stroker.to(p, this.dab);
    this.app.invalidate();
  }

  up() {
    if (!this.t) return;
    this.app.history.push('Doigt');
    const result = this.doc.selection ? blendWithSelection(this.base, this.work, this.doc.selection) : this.work;
    this.app.setTargetCanvas(this.t, result);
    this.t = null;
    clearLive(this.app);
    this.app.emit('layers');
  }

  cancel() {
    this.t = null;
    clearLive(this.app);
  }

  drawOverlay(ctx, view) {
    view.drawBrushCursor(ctx, this.opts.size);
  }
}

// ---------- Densité (éclaircir / assombrir / éponge) ----------

export class DodgeTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'dodge', name: 'Densité − / + / Éponge', icon: 'dodge', key: 'O', group: 'retouch', cursor: 'none',
      defaults: { size: 80, hardness: 0, exposure: 35, mode: 'dodge' },
    });
    this.wantsCoalesced = true;
  }

  options() {
    return [
      { key: 'mode', label: 'Effet', type: 'segmented', options: [['dodge', 'Éclaircir'], ['burn', 'Assombrir'], ['sponge', 'Désaturer'], ['saturate', 'Saturer']] },
      { ...sizeOpt, max: 600 }, hardOpt, { key: 'exposure', label: 'Exposition', type: 'range', min: 1, max: 100, unit: ' %' },
    ];
  }

  down(p) {
    if (!this.begin()) return;
    const t = (this.t = this.app.target());
    if (t.kind === 'mask') {
      this.t = null;
      return this.app.toast('Outil sans effet sur un masque');
    }
    this.base = t.canvas;
    this.stroke = createCanvas(this.doc.width, this.doc.height);
    this.sctx = this.stroke.getContext('2d');
    const m = this.opts.mode;
    this.color = m === 'dodge' ? '#ffffff' : m === 'burn' ? '#000000' : '#808080';
    if (m === 'saturate') this.saturated = saturatedVersion(this.base);
    this.stroker = new Stroker(Math.max(1, this.opts.size * 0.12));
    this.stroker.start(p, this.dab);
    this.app.setLive({ layerId: t.layer.id, draw: (ctx) => this.compose(ctx) });
  }

  dab = (x, y) => {
    const tip = brushTip(this.opts.size, this.opts.hardness / 100, this.color);
    this.sctx.globalAlpha = 0.25;
    this.sctx.drawImage(tip, x - tip.width / 2, y - tip.height / 2);
  };

  compose(ctx) {
    const s = clipToSelection(this.stroke, this.doc.selection);
    const w = this.doc.width, h = this.doc.height;
    ctx.drawImage(this.base, 0, 0);
    const tmp = createCanvas(w, h);
    const t = tmp.getContext('2d');
    if (this.opts.mode === 'saturate') {
      t.drawImage(this.saturated, 0, 0);
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(s, 0, 0);
      ctx.globalAlpha = this.opts.exposure / 100 * 1.6;
      ctx.drawImage(tmp, 0, 0);
    } else {
      t.drawImage(s, 0, 0);
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(this.base, 0, 0);
      ctx.globalAlpha = clamp((this.opts.exposure / 100) * 2, 0, 1);
      ctx.globalCompositeOperation = this.opts.mode === 'sponge' ? 'saturation' : 'soft-light';
      ctx.drawImage(tmp, 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  move(p) {
    if (!this.t) return;
    this.stroker.to(p, this.dab);
    this.app.invalidate();
  }

  up() {
    if (!this.t) return;
    this.app.history.push({ dodge: 'Densité −', burn: 'Densité +', sponge: 'Éponge', saturate: 'Éponge' }[this.opts.mode]);
    const out = createCanvas(this.doc.width, this.doc.height);
    this.compose(out.getContext('2d'));
    this.app.setTargetCanvas(this.t, out);
    this.t = null;
    clearLive(this.app);
    this.app.emit('layers');
  }

  cancel() {
    this.t = null;
    clearLive(this.app);
  }

  drawOverlay(ctx, view) {
    view.drawBrushCursor(ctx, this.opts.size);
  }
}

function saturatedVersion(canvas) {
  const img = getData(canvas);
  const d = img.data;
  for (let q = 0; q < d.length; q += 4) {
    const L = 0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2];
    for (let c = 0; c < 3; c++) d[q + c] = L + (d[q + c] - L) * 1.6;
  }
  return canvasFromData(img);
}

// ---------- Goutte d'eau (flou) / Netteté ----------

export class BlurBrushTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'blurbrush', name: 'Goutte d\'eau / Netteté', icon: 'drop', key: 'R', group: 'retouch', cursor: 'none',
      defaults: { size: 60, hardness: 20, strength: 50, mode: 'blur' },
    });
    this.wantsCoalesced = true;
    this.cache = new WeakMap();
  }

  options() {
    return [
      { key: 'mode', label: 'Effet', type: 'segmented', options: [['blur', 'Flou'], ['sharpen', 'Netteté']] },
      { ...sizeOpt, max: 600 }, hardOpt, { key: 'strength', label: 'Intensité', type: 'range', min: 1, max: 100, unit: ' %' },
    ];
  }

  effectFor(canvas) {
    const key = `${this.opts.mode}|${this.opts.strength}`;
    const cached = this.cache.get(canvas);
    if (cached && cached.key === key) return cached.canvas;
    const img = getData(canvas);
    const s = this.opts.strength / 100;
    const res = this.opts.mode === 'blur' ? gaussianBlur(img, 1 + s * 8) : unsharp(img, 0.5 + s * 2, 1.2, 0);
    const c = canvasFromData(res);
    this.cache.set(canvas, { key, canvas: c });
    return c;
  }

  down(p) {
    if (!this.begin()) return;
    const t = (this.t = this.app.target());
    this.base = t.canvas;
    this.effect = this.effectFor(t.canvas);
    this.stroke = createCanvas(this.doc.width, this.doc.height);
    this.sctx = this.stroke.getContext('2d');
    this.stroker = new Stroker(Math.max(1, this.opts.size * 0.12));
    this.stroker.start(p, this.dab);
    setLiveFor(this.app, t, (ctx) => this.compose(ctx));
  }

  dab = (x, y) => {
    const tip = brushTip(this.opts.size, this.opts.hardness / 100);
    this.sctx.globalAlpha = 0.5;
    this.sctx.drawImage(tip, x - tip.width / 2, y - tip.height / 2);
  };

  compose(ctx) {
    const s = clipToSelection(this.stroke, this.doc.selection);
    const tmp = createCanvas(this.doc.width, this.doc.height);
    const t = tmp.getContext('2d');
    t.drawImage(this.effect, 0, 0);
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(s, 0, 0);
    ctx.drawImage(this.base, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  }

  move(p) {
    if (!this.t) return;
    this.stroker.to(p, this.dab);
    this.app.invalidate();
  }

  up() {
    if (!this.t) return;
    this.app.history.push(this.opts.mode === 'blur' ? 'Goutte d\'eau' : 'Netteté');
    const out = createCanvas(this.doc.width, this.doc.height);
    this.compose(out.getContext('2d'));
    this.app.setTargetCanvas(this.t, out);
    this.t = null;
    clearLive(this.app);
    this.app.emit('layers');
  }

  cancel() {
    this.t = null;
    clearLive(this.app);
  }

  drawOverlay(ctx, view) {
    view.drawBrushCursor(ctx, this.opts.size);
  }
}

// ---------- Yeux rouges ----------

export class RedEyeTool extends Tool {
  constructor(app) {
    super(app, { id: 'redeye', name: 'Yeux rouges', icon: 'eye', key: '', group: 'retouch', cursor: 'none', defaults: { size: 40, darken: 50 } });
  }

  options() {
    return [{ ...sizeOpt, label: 'Taille de la pupille', max: 300 }, { key: 'darken', label: 'Assombrissement', type: 'range', min: 0, max: 100, unit: ' %' }];
  }

  down(p) {
    if (!this.begin()) return;
    const t = this.app.target();
    const r = this.opts.size / 2;
    const x0 = Math.max(0, Math.floor(p.x - r)), y0 = Math.max(0, Math.floor(p.y - r));
    const x1 = Math.min(this.doc.width, Math.ceil(p.x + r)), y1 = Math.min(this.doc.height, Math.ceil(p.y + r));
    if (x1 <= x0 || y1 <= y0) return;
    const out = cloneCanvas(t.canvas);
    const ctx = out.getContext('2d');
    const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
    const d = img.data;
    const dk = 1 - (this.opts.darken / 100) * 0.6;
    let changed = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const dist = Math.hypot(x - p.x, y - p.y) / r;
        if (dist > 1) continue;
        const q = ((y - y0) * (x1 - x0) + (x - x0)) * 4;
        const R = d[q], G = d[q + 1], B = d[q + 2];
        const avg = (G + B) / 2;
        if (R > 50 && R > avg * 1.5) {
          const k = 1 - Math.pow(dist, 4);
          const nr = avg * dk;
          d[q] = R + (nr - R) * k;
          d[q + 1] = G + (G * dk - G) * k;
          d[q + 2] = B + (B * dk - B) * k;
          changed++;
        }
      }
    if (!changed) return this.app.toast('Aucun rouge détecté ici');
    ctx.putImageData(img, x0, y0);
    this.app.history.push('Yeux rouges');
    this.app.setTargetCanvas(t, out);
    this.app.invalidate(true);
  }

  drawOverlay(ctx, view) {
    view.drawBrushCursor(ctx, this.opts.size);
  }
}
