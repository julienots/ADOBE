// Zone de travail : zoom, déplacement, gestes tactiles, rendu et superpositions.

import { clamp, checker } from './util.js';
import { selectionOutline } from './selection.js';

export class View {
  constructor(app, canvas) {
    this.app = app;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.zoom = 1;
    this.offX = 0;
    this.offY = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.pointers = new Map();
    this.gesture = null;
    this.panning = null;
    this.spaceDown = false;
    this.cursor = null; // position du pointeur en coordonnées document
    this.antsOffset = 0;
    this.showGrid = false;
    this.showPixelGrid = true;
    this.rotation = 0; // rotation d'aperçu (outil de recadrage)
    this.rotationCenter = null;
    this.toolActive = false;
    this.needsRender = true;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.bindEvents();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    setInterval(() => {
      if (this.app.doc && this.app.doc.selection && !document.hidden) {
        this.antsOffset = (this.antsOffset + 1) % 16;
        this.requestRender();
      }
    }, 120);
  }

  resize() {
    const parent = this.canvas.parentElement;
    const r = parent.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = r.width;
    this.cssH = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    if (!this.fitted && this.app.doc) this.fit();
    this.requestRender();
  }

  requestRender() {
    this.needsRender = true;
  }

  loop() {
    if (this.needsRender || this.app.compositeDirty) {
      this.needsRender = false;
      this.render();
    }
    requestAnimationFrame(this.loop);
  }

  // ---------- Coordonnées ----------

  toDoc(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    let x = (clientX - r.left - this.offX) / this.zoom;
    let y = (clientY - r.top - this.offY) / this.zoom;
    return { x, y };
  }

  toScreen(x, y) {
    return { x: x * this.zoom + this.offX, y: y * this.zoom + this.offY };
  }

  fit() {
    const doc = this.app.doc;
    if (!doc || !this.cssW) return;
    const pad = this.cssW < 600 ? 16 : 48;
    const z = Math.min((this.cssW - pad * 2) / doc.width, (this.cssH - pad * 2) / doc.height);
    this.setZoom(Math.min(z, 4), true);
    this.fitted = true;
  }

  setZoom(z, center = false, anchorX = this.cssW / 2, anchorY = this.cssH / 2) {
    const doc = this.app.doc;
    z = clamp(z, 0.02, 64);
    if (center && doc) {
      this.zoom = z;
      this.offX = (this.cssW - doc.width * z) / 2;
      this.offY = (this.cssH - doc.height * z) / 2;
    } else {
      const dx = (anchorX - this.offX) / this.zoom, dy = (anchorY - this.offY) / this.zoom;
      this.zoom = z;
      this.offX = anchorX - dx * z;
      this.offY = anchorY - dy * z;
    }
    this.app.emit('zoom');
    this.requestRender();
  }

  zoomBy(f, ax, ay) {
    this.setZoom(this.zoom * f, false, ax, ay);
  }

  actualPixels() {
    this.setZoom(1, true);
  }

  // ---------- Évènements ----------

  bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e, true));
    c.addEventListener('pointerleave', () => {
      this.cursor = null;
      this.requestRender();
    });
    c.addEventListener('dblclick', (e) => this.app.tool?.dblclick?.(this.pt(e), e));
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !isTyping(e)) {
        if (!this.spaceDown) {
          this.spaceDown = true;
          this.updateCursor();
        }
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.updateCursor();
      }
    });
  }

  pt(e) {
    const p = this.toDoc(e.clientX, e.clientY);
    p.pressure = e.pointerType === 'pen' ? (e.pressure || 0.5) : 1;
    p.pointerType = e.pointerType;
    p.shift = e.shiftKey;
    p.alt = e.altKey;
    p.ctrl = e.ctrlKey || e.metaKey;
    p.button = e.button;
    p.sx = e.clientX;
    p.sy = e.clientY;
    return p;
  }

  onDown(e) {
    if (!this.app.doc) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 2) {
      // Deux doigts : on annule l'outil en cours et on passe en geste zoom/déplacement.
      if (this.toolActive) {
        this.app.tool?.cancel?.();
        this.toolActive = false;
      }
      const [a, b] = [...this.pointers.values()];
      const r = this.canvas.getBoundingClientRect();
      this.gesture = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mx: (a.x + b.x) / 2 - r.left,
        my: (a.y + b.y) / 2 - r.top,
        zoom: this.zoom,
        offX: this.offX,
        offY: this.offY,
      };
      return;
    }
    if (this.pointers.size > 2) return;

    const tool = this.app.tool;
    if (e.button === 1 || this.spaceDown || (tool && tool.id === 'hand') || (e.button === 2 && tool && !tool.usesRightClick)) {
      this.panning = { x: e.clientX, y: e.clientY, offX: this.offX, offY: this.offY };
      return;
    }
    if (!tool) return;
    this.toolActive = true;
    const p = this.pt(e);
    this.cursor = p;
    tool.down?.(p, e);
    this.requestRender();
  }

  onMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = this.pt(e);
    this.cursor = p;
    this.app.emit('cursor', p);

    if (this.gesture && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const r = this.canvas.getBoundingClientRect();
      const g = this.gesture;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
      const z = clamp(g.zoom * (dist / g.dist), 0.02, 64);
      const docX = (g.mx - g.offX) / g.zoom, docY = (g.my - g.offY) / g.zoom;
      this.zoom = z;
      this.offX = mx - docX * z;
      this.offY = my - docY * z;
      this.app.emit('zoom');
      this.requestRender();
      return;
    }
    if (this.panning) {
      this.offX = this.panning.offX + (e.clientX - this.panning.x);
      this.offY = this.panning.offY + (e.clientY - this.panning.y);
      this.requestRender();
      return;
    }
    const tool = this.app.tool;
    if (this.toolActive && tool) {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (tool.wantsCoalesced && events.length > 1) for (const ce of events) tool.move?.(this.pt(ce), ce);
      else tool.move?.(p, e);
    } else tool?.hover?.(p, e);
    this.requestRender();
  }

  onUp(e, cancelled = false) {
    this.pointers.delete(e.pointerId);
    if (this.gesture) {
      if (this.pointers.size < 2) this.gesture = null;
      return;
    }
    if (this.panning) {
      this.panning = null;
      return;
    }
    if (this.toolActive) {
      this.toolActive = false;
      const tool = this.app.tool;
      if (cancelled) tool?.cancel?.();
      else tool?.up?.(this.pt(e), e);
    }
    this.requestRender();
  }

  onWheel(e) {
    if (!this.app.doc) return;
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const ax = e.clientX - r.left, ay = e.clientY - r.top;
    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      // Molette (ou pincement sur pavé tactile) = zoom centré sur le pointeur.
      const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      this.zoomBy(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)), ax, ay);
    } else {
      this.offX -= e.deltaY || e.deltaX;
      this.requestRender();
    }
  }

  updateCursor() {
    const tool = this.app.tool;
    this.canvas.style.cursor = this.spaceDown || tool?.id === 'hand' ? 'grab' : tool?.cursor || 'crosshair';
  }

  // ---------- Rendu ----------

  render() {
    const app = this.app;
    const doc = app.doc;
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--stage').trim() || '#16161a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!doc) return;

    if (app.compositeDirty) app.updateComposite();
    const src = app.showOriginal && app.originalCanvas ? app.originalCanvas : app.compositeCanvas;
    const z = this.zoom;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    if (this.rotation && this.rotationCenter) {
      const c = this.toScreen(this.rotationCenter.x, this.rotationCenter.y);
      ctx.translate(c.x, c.y);
      ctx.rotate(this.rotation);
      ctx.translate(-c.x, -c.y);
    }
    // Ombre portée de la feuille
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = checker(ctx);
    ctx.fillRect(this.offX, this.offY, doc.width * z, doc.height * z);
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.imageSmoothingEnabled = z < 2;
    ctx.imageSmoothingQuality = z < 1 ? 'high' : 'low';
    ctx.drawImage(src, this.offX, this.offY, doc.width * z, doc.height * z);

    if (z >= 10 && this.showPixelGrid) this.drawPixelGrid(ctx, doc);
    ctx.restore();

    if (this.showGrid) this.drawThirds(ctx, doc);

    if (doc.selection && !app.hideSelection) {
      const path = selectionOutline(doc.selection);
      ctx.save();
      ctx.translate(this.offX, this.offY);
      ctx.scale(z, z);
      ctx.lineWidth = 1 / z;
      ctx.setLineDash([4 / z, 4 / z]);
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = -this.antsOffset / z;
      ctx.stroke(path);
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = (-this.antsOffset + 4) / z;
      ctx.stroke(path);
      ctx.restore();
    }

    app.tool?.drawOverlay?.(ctx, this);
  }

  drawPixelGrid(ctx, doc) {
    const z = this.zoom;
    const x0 = Math.max(0, Math.floor(-this.offX / z)), y0 = Math.max(0, Math.floor(-this.offY / z));
    const x1 = Math.min(doc.width, Math.ceil((this.cssW - this.offX) / z)), y1 = Math.min(doc.height, Math.ceil((this.cssH - this.offY) / z));
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      const sx = Math.round(this.offX + x * z) + 0.5;
      ctx.moveTo(sx, this.offY + y0 * z);
      ctx.lineTo(sx, this.offY + y1 * z);
    }
    for (let y = y0; y <= y1; y++) {
      const sy = Math.round(this.offY + y * z) + 0.5;
      ctx.moveTo(this.offX + x0 * z, sy);
      ctx.lineTo(this.offX + x1 * z, sy);
    }
    ctx.strokeStyle = 'rgba(128,128,128,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  drawThirds(ctx, doc) {
    const z = this.zoom;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      const x = this.offX + (doc.width * z * i) / 3, y = this.offY + (doc.height * z * i) / 3;
      ctx.moveTo(x, this.offY);
      ctx.lineTo(x, this.offY + doc.height * z);
      ctx.moveTo(this.offX, y);
      ctx.lineTo(this.offX + doc.width * z, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Cercle de prévisualisation de la taille du pinceau.
  drawBrushCursor(ctx, size) {
    if (!this.cursor || this.pointers.size > 1 || this.cursor.pointerType === 'touch') return;
    const s = this.toScreen(this.cursor.x, this.cursor.y);
    const r = Math.max(1, (size / 2) * this.zoom);
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

export function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
