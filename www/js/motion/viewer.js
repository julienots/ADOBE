// Prisme Motion — visualiseur de composition : affichage de l'image rendue par le GPU, poignées
// de transformation (déplacer, mettre à l'échelle, faire pivoter), point d'ancrage, trajectoire
// de mouvement, contours des masques, outils de dessin (rectangle, ellipse, plume, texte).

import { el } from '../util.js';
import { M4 } from './gl.js';
import * as M from './model.js';

const HANDLE = 6;

export class Viewer {
  constructor(core, root) {
    this.core = core;
    this.root = root;
    this.canvas = el('canvas', { class: 'mv-canvas' });
    root.append(this.canvas);
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.zoom = 'fit';
    this.pan = [0, 0];
    this.showGrid = false;
    this.showSafe = false;
    this.pen = null;
    this.drag = null;
    this.pointers = new Map();
    new ResizeObserver(() => this.resize()).observe(root);
    core.on('frame', () => this.draw());
    core.on('select', () => this.draw());
    core.on('live', () => this.draw());
    core.on('tool', () => {
      this.pen = null;
      this.updateCursor();
      this.draw();
    });
    core.on('comp', () => {
      this.zoom = 'fit';
      this.pan = [0, 0];
      this.draw();
    });
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.hover(e));
    this.canvas.addEventListener('dblclick', (e) => this.dbl(e));
    this.canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hit = this.hitLayer(this.toComp(e));
      if (hit && !core.selection.has(hit.id)) core.select(hit.id);
      if (core.selection.size) core.emit('layer-menu', { x: e.clientX, y: e.clientY });
    });
    this.updateCursor();
  }

  resize() {
    const r = this.root.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    this.w = Math.max(10, r.width);
    this.h = Math.max(10, r.height);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.dpr = dpr;
    this.draw();
  }

  get scale() {
    const c = this.core.comp;
    if (this.zoom === 'fit') return Math.max(0.01, Math.min((this.w - 32) / c.width, (this.h - 32) / c.height));
    return this.zoom;
  }

  origin() {
    const c = this.core.comp, z = this.scale;
    return [(this.w - c.width * z) / 2 + this.pan[0], (this.h - c.height * z) / 2 + this.pan[1]];
  }

  toComp(e) {
    const r = this.canvas.getBoundingClientRect();
    const [ox, oy] = this.origin(), z = this.scale;
    return [(e.clientX - r.left - ox) / z, (e.clientY - r.top - oy) / z];
  }

  toScreen(p) {
    const [ox, oy] = this.origin(), z = this.scale;
    return [ox + p[0] * z, oy + p[1] * z];
  }

  setZoom(z, around = null) {
    const c = this.core.comp;
    const old = this.scale;
    const nz = M.clamp(z, 0.02, 32);
    if (around) {
      const [ox, oy] = this.origin();
      const px = (around[0] - ox) / old, py = (around[1] - oy) / old;
      this.zoom = nz;
      const [nx, ny] = this.origin();
      this.pan[0] += around[0] - (nx + px * nz);
      this.pan[1] += around[1] - (ny + py * nz);
    } else this.zoom = nz;
    if (c) this.core.emit('zoom', this.scale);
    this.draw();
  }

  fit() {
    this.zoom = 'fit';
    this.pan = [0, 0];
    this.core.emit('zoom', this.scale);
    this.draw();
  }

  updateCursor() {
    const t = this.core.tool;
    this.canvas.style.cursor = t === 'hand' ? 'grab' : t === 'text' ? 'text' : ['rect', 'ellipse', 'pen'].includes(t) ? 'crosshair' : 'default';
  }

  // ---------- Dessin ----------

  draw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.paint();
    });
  }

  paint() {
    const core = this.core;
    const c = core.comp;
    const ctx = this.ctx;
    if (!this.w) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0c0c11';
    ctx.fillRect(0, 0, this.w, this.h);
    const z = this.scale;
    const [ox, oy] = this.origin();
    const cw = c.width * z, ch = c.height * z;
    if (core.transparent) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, cw, ch);
      ctx.clip();
      const s = 10;
      for (let y = 0; y < ch; y += s) for (let x = 0; x < cw; x += s) {
        ctx.fillStyle = ((x / s + y / s) & 1) ? '#3a3a44' : '#2a2a32';
        ctx.fillRect(ox + x, oy + y, s, s);
      }
      ctx.restore();
    }
    const img = core.lastFrameImage;
    if (img) {
      ctx.imageSmoothingEnabled = z < 2;
      ctx.imageSmoothingQuality = 'high';
      try {
        ctx.drawImage(img, ox, oy, cw, ch);
      } catch {
        core.requestRender();
      }
    } else {
      ctx.fillStyle = c.bg;
      ctx.fillRect(ox, oy, cw, ch);
    }
    ctx.strokeStyle = 'rgba(255,255,255,.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox - 0.5, oy - 0.5, cw + 1, ch + 1);
    if (this.showSafe) this.drawSafe(ox, oy, cw, ch);
    if (this.showGrid) this.drawGrid(ox, oy, cw, ch);
    if (!core.playing) this.drawOverlays();
    this.drawToolPreview();
  }

  drawSafe(ox, oy, cw, ch) {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,.35)';
    ctx.setLineDash([4, 4]);
    for (const m of [0.05, 0.1]) ctx.strokeRect(ox + cw * m, oy + ch * m, cw * (1 - 2 * m), ch * (1 - 2 * m));
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(ox + cw / 2 - 8, oy + ch / 2);
    ctx.lineTo(ox + cw / 2 + 8, oy + ch / 2);
    ctx.moveTo(ox + cw / 2, oy + ch / 2 - 8);
    ctx.lineTo(ox + cw / 2, oy + ch / 2 + 8);
    ctx.stroke();
  }

  drawGrid(ox, oy, cw, ch) {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,.16)';
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo(ox + (cw * i) / 3, oy);
      ctx.lineTo(ox + (cw * i) / 3, oy + ch);
      ctx.moveTo(ox, oy + (ch * i) / 3);
      ctx.lineTo(ox + cw, oy + (ch * i) / 3);
    }
    ctx.stroke();
  }

  drawOverlays() {
    const core = this.core;
    const c = core.comp;
    const ctx = this.ctx;
    const eng = core.engine;
    for (const layer of core.selectedLayers) {
      if (!M.layerActive(layer, core.time)) continue;
      const corners = eng.corners(c, layer, core.time).map((p) => this.toScreen(p));
      const col = layer.label || '#7b5cff';
      // Trajectoire de mouvement (images clés de position)
      const pk = layer.p.position.k;
      if (pk && pk.length > 1 && !layer.parent) {
        ctx.strokeStyle = 'rgba(255,255,255,.55)';
        ctx.fillStyle = 'rgba(255,255,255,.8)';
        ctx.beginPath();
        const f0 = Math.round(pk[0].t * c.fps), f1 = Math.round(pk[pk.length - 1].t * c.fps);
        const step = Math.max(1, Math.ceil((f1 - f0) / 400));
        for (let f = f0; f <= f1; f += step) {
          const p = this.toScreen(M.keyedValue(layer.p.position, f / c.fps));
          if (f === f0) ctx.moveTo(p[0], p[1]);
          else ctx.lineTo(p[0], p[1]);
        }
        ctx.stroke();
        for (let f = f0; f <= f1; f += step) {
          const p = this.toScreen(M.keyedValue(layer.p.position, f / c.fps));
          ctx.fillRect(p[0] - 1, p[1] - 1, 2, 2);
        }
        for (const k of pk) {
          const p = this.toScreen(k.v);
          ctx.fillStyle = '#fff';
          ctx.fillRect(p[0] - 3.5, p[1] - 3.5, 7, 7);
          ctx.strokeStyle = col;
          ctx.strokeRect(p[0] - 3.5, p[1] - 3.5, 7, 7);
        }
      }
      // Masques
      if (layer.masks.length) {
        const m = eng.viewMatrix(c, layer, eng.matrix(c, layer, core.time));
        for (const mk of layer.masks) {
          const vals = { box: mk.p.box ? eng.pv(c, layer, '', core.time, mk.p.box) : null, offset: eng.pv(c, layer, '', core.time, mk.p.offset) };
          const pts = maskPoints(mk, vals);
          ctx.strokeStyle = '#ffd21f';
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          pts.forEach((p, i) => {
            const s = this.toScreen(M4.apply(m, p[0] + vals.offset[0], p[1] + vals.offset[1]));
            if (i) ctx.lineTo(s[0], s[1]);
            else ctx.moveTo(s[0], s[1]);
          });
          ctx.closePath();
          ctx.stroke();
        }
      }
      if (layer.type === 'audio') continue;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      corners.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.stroke();
      if (core.selectedLayers.length === 1 && !layer.locked) {
        for (const h of this.handles(corners)) {
          ctx.fillStyle = '#fff';
          ctx.fillRect(h.p[0] - HANDLE / 2, h.p[1] - HANDLE / 2, HANDLE, HANDLE);
          ctx.strokeStyle = col;
          ctx.strokeRect(h.p[0] - HANDLE / 2, h.p[1] - HANDLE / 2, HANDLE, HANDLE);
        }
        const rk = this.rotKnob(corners);
        ctx.beginPath();
        ctx.moveTo(rk.base[0], rk.base[1]);
        ctx.lineTo(rk.p[0], rk.p[1]);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(rk.p[0], rk.p[1], 5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.stroke();
      }
      // Point d'ancrage
      const av = eng.pv(c, layer, 'anchor', core.time);
      const a = this.toScreen(M4.apply(eng.viewMatrix(c, layer, eng.matrix(c, layer, core.time)), av[0], av[1]));
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(a[0], a[1], 5, 0, Math.PI * 2);
      ctx.moveTo(a[0] - 9, a[1]);
      ctx.lineTo(a[0] + 9, a[1]);
      ctx.moveTo(a[0], a[1] - 9);
      ctx.lineTo(a[0], a[1] + 9);
      ctx.stroke();
    }
  }

  drawToolPreview() {
    const ctx = this.ctx;
    if (this.drag?.kind === 'draw') {
      const [a, b] = [this.toScreen(this.drag.a), this.toScreen(this.drag.b)];
      ctx.strokeStyle = '#3db5ff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      if (this.core.tool === 'ellipse') ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
      else ctx.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.pen?.points.length) {
      ctx.strokeStyle = '#3db5ff';
      ctx.fillStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const pts = this.pen.points.map((p) => this.toScreen(p));
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      if (this.pen.hover) {
        const h = this.toScreen(this.pen.hover);
        ctx.lineTo(h[0], h[1]);
      }
      ctx.stroke();
      for (const [i, p] of pts.entries()) {
        ctx.fillStyle = i === 0 ? '#3db5ff' : '#fff';
        ctx.fillRect(p[0] - 3.5, p[1] - 3.5, 7, 7);
      }
    }
  }

  handles(corners) {
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const [a, b, c, d] = corners;
    return [
      { p: a, id: 'tl', sx: -1, sy: -1 }, { p: b, id: 'tr', sx: 1, sy: -1 }, { p: c, id: 'br', sx: 1, sy: 1 }, { p: d, id: 'bl', sx: -1, sy: 1 },
      { p: mid(a, b), id: 't', sx: 0, sy: -1 }, { p: mid(b, c), id: 'r', sx: 1, sy: 0 }, { p: mid(c, d), id: 'b', sx: 0, sy: 1 }, { p: mid(d, a), id: 'l', sx: -1, sy: 0 },
    ];
  }

  rotKnob(corners) {
    const [a, b, , d] = corners;
    const base = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const up = [a[0] - d[0], a[1] - d[1]];
    const L = Math.hypot(up[0], up[1]) || 1;
    return { base, p: [base[0] + (up[0] / L) * 26, base[1] + (up[1] / L) * 26] };
  }

  // ---------- Sélection ----------

  hitLayer(p) {
    const core = this.core;
    const c = core.comp;
    for (const l of c.layers) {
      if (!l.visible || l.locked || !M.layerActive(l, core.time) || l.type === 'audio') continue;
      const q = core.engine.corners(c, l, core.time);
      if (inQuad(p, q)) return l;
    }
    return null;
  }

  // ---------- Interactions ----------

  down(e) {
    const core = this.core;
    this.pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (this.pointers.size === 2) return this.startPinch();
    if (e.button === 1 || core.tool === 'hand' || this.spaceDown) return this.startPan(e);
    if (e.button !== 0) return;
    const p = this.toComp(e);
    const c = core.comp;
    const tool = core.tool;
    if (tool === 'text') {
      core.emit('new-text', { pos: p });
      return;
    }
    if (tool === 'pen') return this.penClick(p, e);
    if (tool === 'rect' || tool === 'ellipse') {
      this.drag = { kind: 'draw', a: p, b: p };
      this.capture(e, (ev) => {
        this.drag.b = this.toComp(ev);
        if (ev.shiftKey) {
          const d = Math.max(Math.abs(this.drag.b[0] - p[0]), Math.abs(this.drag.b[1] - p[1]));
          this.drag.b = [p[0] + Math.sign(this.drag.b[0] - p[0] || 1) * d, p[1] + Math.sign(this.drag.b[1] - p[1] || 1) * d];
        }
        this.draw();
      }, () => {
        const { a, b } = this.drag;
        this.drag = null;
        const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]), w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
        if (w > 3 && h > 3) core.emit('draw-shape', { kind: tool, rect: [x, y, w, h] });
        this.draw();
      });
      return;
    }
    // Outil de sélection / ancrage : poignées de la sélection d'abord.
    const sel = core.selectedLayers.length === 1 ? core.layer : null;
    const sx = e.clientX - this.canvas.getBoundingClientRect().left, sy = e.clientY - this.canvas.getBoundingClientRect().top;
    if (sel && !sel.locked && tool === 'select' && M.layerActive(sel, core.time)) {
      const corners = core.engine.corners(c, sel, core.time).map((q) => this.toScreen(q));
      const rk = this.rotKnob(corners);
      if (Math.hypot(sx - rk.p[0], sy - rk.p[1]) < 9) return this.startRotate(e, sel);
      for (const h of this.handles(corners)) {
        if (Math.abs(sx - h.p[0]) < 8 && Math.abs(sy - h.p[1]) < 8) return this.startScale(e, sel, h);
      }
    }
    if (tool === 'anchor' && sel) return this.startAnchor(e, sel);
    const hit = this.hitLayer(p);
    if (!hit) {
      if (!e.shiftKey) core.select([]);
      return;
    }
    if (!core.selection.has(hit.id)) core.select(hit.id, e.shiftKey);
    else if (e.shiftKey) return core.select(hit.id, true);
    if (tool === 'anchor') return this.startAnchor(e, hit);
    this.startMove(e, p);
  }

  capture(e, move, up) {
    this.canvas.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      if (ev.pointerId === e.pointerId) move(ev);
    };
    const done = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      this.canvas.removeEventListener('pointermove', mv);
      this.canvas.removeEventListener('pointerup', done);
      this.canvas.removeEventListener('pointercancel', done);
      this.pointers.delete(e.pointerId);
      up?.(ev);
    };
    this.canvas.addEventListener('pointermove', mv);
    this.canvas.addEventListener('pointerup', done);
    this.canvas.addEventListener('pointercancel', done);
  }

  startPan(e) {
    const start = [e.clientX, e.clientY, ...this.pan];
    if (this.zoom === 'fit') this.zoom = this.scale;
    this.canvas.style.cursor = 'grabbing';
    this.capture(e, (ev) => {
      this.pan = [start[2] + ev.clientX - start[0], start[3] + ev.clientY - start[1]];
      this.draw();
    }, () => this.updateCursor());
  }

  startPinch() {
    const pts = [...this.pointers.values()];
    const d0 = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
    const z0 = this.scale;
    const c0 = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    const pan0 = [...this.pan];
    this.drag = null;
    const move = (ev) => {
      if (!this.pointers.has(ev.pointerId)) return;
      this.pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
      const p = [...this.pointers.values()];
      if (p.length < 2) return;
      const d = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
      const cc = [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2];
      this.zoom = M.clamp(z0 * (d / d0), 0.02, 32);
      this.pan = [pan0[0] + cc[0] - c0[0], pan0[1] + cc[1] - c0[1]];
      this.draw();
    };
    const up = (ev) => {
      this.pointers.delete(ev.pointerId);
      if (this.pointers.size < 2) {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Convertit un déplacement écran (pixels de composition) dans l'espace du parent du calque.
  parentDelta(layer, dx, dy) {
    if (!layer.parent) return [dx, dy];
    const c = this.core.comp;
    const par = c.layers.find((l) => l.id === layer.parent);
    if (!par) return [dx, dy];
    const m = this.core.engine.matrix(c, par, this.core.time);
    const det = m[0] * m[5] - m[1] * m[4] || 1e-9;
    return [(dx * m[5] - dy * m[4]) / det, (dy * m[0] - dx * m[1]) / det];
  }

  startMove(e, p0) {
    const core = this.core;
    const t = core.time;
    const layers = core.selectedLayers.filter((l) => !l.locked);
    const orig = layers.map((l) => ({ l, pos: M.clone(M.keyedValue(l.p.position, t)) }));
    let moved = false;
    core.interacting = true;
    this.capture(e, (ev) => {
      const p = this.toComp(ev);
      let dx = p[0] - p0[0], dy = p[1] - p0[1];
      if (!moved && Math.hypot(dx, dy) * this.scale < 3) return;
      if (!moved) {
        moved = true;
        core.beginDrag();
      }
      if (ev.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      for (const o of orig) {
        const [ddx, ddy] = this.parentDelta(o.l, dx, dy);
        M.setPropValue(o.l.p.position, t, [o.pos[0] + ddx, o.pos[1] + ddy]);
      }
      core.live();
    }, () => {
      core.interacting = false;
      if (moved) core.endDrag('Déplacer');
      else core.requestRender();
    });
  }

  startScale(e, layer, h) {
    const core = this.core;
    const c = core.comp;
    const t = core.time;
    const eng = core.engine;
    const world = eng.matrix(c, layer, t);
    const inv = M4.invert2D(world);
    const a = M.clone(M.keyedValue(layer.p.anchor, t));
    const s0 = M.clone(M.keyedValue(layer.p.scale, t));
    const box = eng.sourceBox(c, layer);
    const hx = h.sx < 0 ? box[0] : h.sx > 0 ? box[0] + box[2] : null;
    const hy = h.sy < 0 ? box[1] : h.sy > 0 ? box[1] + box[3] : null;
    core.beginDrag();
    core.interacting = true;
    this.capture(e, (ev) => {
      const p = inv(...this.toComp(ev));
      let fx = hx != null ? (p[0] - a[0]) / (hx - a[0] || 1e-6) : 1;
      let fy = hy != null ? (p[1] - a[1]) / (hy - a[1] || 1e-6) : 1;
      if (ev.shiftKey || layer.type === 'text') {
        const f = hx != null && hy != null ? (Math.abs(fx) > Math.abs(fy) ? fx : fy) : hx != null ? fx : fy;
        fx = fy = f;
      }
      M.setPropValue(layer.p.scale, t, [s0[0] * fx, s0[1] * fy]);
      core.live();
    }, () => {
      core.interacting = false;
      core.endDrag('Mise à l’échelle');
    });
  }

  startRotate(e, layer) {
    const core = this.core;
    const c = core.comp;
    const t = core.time;
    const eng = core.engine;
    const m = eng.viewMatrix(c, layer, eng.matrix(c, layer, t));
    const a = M.keyedValue(layer.p.anchor, t);
    const center = M4.apply(m, a[0], a[1]);
    const p0 = this.toComp(e);
    const ang0 = Math.atan2(p0[1] - center[1], p0[0] - center[0]);
    const r0 = M.keyedValue(layer.p.rotation, t);
    core.beginDrag();
    core.interacting = true;
    this.capture(e, (ev) => {
      const p = this.toComp(ev);
      let d = ((Math.atan2(p[1] - center[1], p[0] - center[0]) - ang0) * 180) / Math.PI;
      let r = r0 + d;
      if (ev.shiftKey) r = Math.round(r / 15) * 15;
      M.setPropValue(layer.p.rotation, t, r);
      core.live();
    }, () => {
      core.interacting = false;
      core.endDrag('Rotation');
    });
  }

  // Outil Ancrage : déplace le point d'ancrage sans déplacer le calque.
  startAnchor(e, layer) {
    const core = this.core;
    const c = core.comp;
    const t = core.time;
    const eng = core.engine;
    const world = eng.matrix(c, layer, t);
    const inv = M4.invert2D(world);
    const pos0 = M.clone(M.keyedValue(layer.p.position, t));
    const a0 = M.clone(M.keyedValue(layer.p.anchor, t));
    core.beginDrag();
    this.capture(e, (ev) => {
      const pc = this.toComp(ev);
      const an = inv(pc[0], pc[1]);
      const w0 = M4.apply(world, a0[0], a0[1]);
      const [dx, dy] = this.parentDelta(layer, pc[0] - w0[0], pc[1] - w0[1]);
      M.setPropValue(layer.p.anchor, t, an);
      M.setPropValue(layer.p.position, t, [pos0[0] + dx, pos0[1] + dy]);
      core.live();
    }, () => core.endDrag('Point d’ancrage'));
  }

  penClick(p, e) {
    if (!this.pen) this.pen = { points: [] };
    const pts = this.pen.points;
    if (pts.length >= 3) {
      const f = this.toScreen(pts[0]), s = this.toScreen(p);
      if (Math.hypot(f[0] - s[0], f[1] - s[1]) < 10) return this.finishPen(true);
    }
    pts.push(p);
    this.draw();
    e.preventDefault();
  }

  finishPen(closed = true) {
    const pen = this.pen;
    this.pen = null;
    if (pen && pen.points.length >= 2) this.core.emit('draw-path', { points: pen.points, closed: closed && pen.points.length >= 3 });
    this.draw();
  }

  cancelTool() {
    this.pen = null;
    this.drag = null;
    this.draw();
  }

  hover(e) {
    if (this.pen) {
      this.pen.hover = this.toComp(e);
      this.draw();
    }
    const core = this.core;
    if (core.tool !== 'select' || this.pointers.size) return;
    const sel = core.selectedLayers.length === 1 ? core.layer : null;
    let cur = 'default';
    if (sel && M.layerActive(sel, core.time) && !sel.locked) {
      const r = this.canvas.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const corners = core.engine.corners(core.comp, sel, core.time).map((q) => this.toScreen(q));
      const rk = this.rotKnob(corners);
      if (Math.hypot(sx - rk.p[0], sy - rk.p[1]) < 9) cur = 'alias';
      else if (this.handles(corners).some((h) => Math.abs(sx - h.p[0]) < 8 && Math.abs(sy - h.p[1]) < 8)) cur = 'nwse-resize';
      else if (inQuad(this.toComp(e), core.engine.corners(core.comp, sel, core.time))) cur = 'move';
    }
    this.canvas.style.cursor = cur;
  }

  dbl(e) {
    const core = this.core;
    if (core.tool === 'pen') return this.finishPen(false);
    const hit = this.hitLayer(this.toComp(e));
    if (!hit) return;
    if (hit.type === 'text') core.emit('edit-text', hit);
    else if (hit.type === 'comp') core.setComp(hit.source);
  }

  wheel(e) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.setZoom(this.scale * f, [e.clientX - r.left, e.clientY - r.top]);
    } else {
      if (this.zoom === 'fit') this.zoom = this.scale;
      this.pan[0] -= e.deltaX;
      this.draw();
    }
  }
}

function maskPoints(m, vals) {
  if (m.kind === 'rect' || m.kind === 'ellipse') {
    const [x, y, w, h] = vals.box;
    if (m.kind === 'rect') return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const pts = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      pts.push([x + w / 2 + (Math.cos(a) * w) / 2, y + h / 2 + (Math.sin(a) * h) / 2]);
    }
    return pts;
  }
  return m.points || [];
}

function inQuad(p, q) {
  let pos = 0, neg = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (cr > 0) pos++;
    else if (cr < 0) neg++;
  }
  return !(pos && neg);
}
