// Modèle du document : calques, masques, sélection, et composition finale.
//
// Règle importante : un canvas de calque n'est JAMAIS modifié sur place une fois créé.
// Toute modification produit un nouveau canvas. L'historique peut ainsi garder de simples
// références vers les anciens canvas (instantanés quasi gratuits en mémoire).

import { createCanvas, uid } from './util.js';

export const BLEND_MODES = [
  ['source-over', 'Normal'],
  ['multiply', 'Produit'],
  ['screen', 'Superposition'],
  ['overlay', 'Incrustation'],
  ['darken', 'Obscurcir'],
  ['lighten', 'Éclaircir'],
  ['color-dodge', 'Densité couleur −'],
  ['color-burn', 'Densité couleur +'],
  ['hard-light', 'Lumière crue'],
  ['soft-light', 'Lumière tamisée'],
  ['difference', 'Différence'],
  ['exclusion', 'Exclusion'],
  ['hue', 'Teinte'],
  ['saturation', 'Saturation'],
  ['color', 'Couleur'],
  ['luminosity', 'Luminosité'],
];

export const defaultEffects = () => ({
  shadow: { enabled: false, color: '#000000', opacity: 0.6, distance: 12, angle: 135, blur: 18 },
  glow: { enabled: false, color: '#ffd84d', opacity: 0.8, blur: 24 },
  stroke: { enabled: false, color: '#ffffff', width: 4, opacity: 1 },
});

export function makeLayer(props = {}) {
  return {
    id: uid(),
    name: 'Calque',
    canvas: null,
    mask: null, // canvas dont l'alpha = visibilité
    maskEnabled: true,
    visible: true,
    opacity: 1,
    blend: 'source-over',
    locked: false,
    effects: defaultEffects(),
    text: null, // métadonnées d'un calque texte (ré-éditable)
    ...props,
  };
}

const cloneEffects = (e) => JSON.parse(JSON.stringify(e));

export class Doc {
  constructor(width, height, name = 'Sans titre') {
    this.width = width;
    this.height = height;
    this.name = name;
    this.layers = [];
    this.activeId = null;
    this.selection = null; // canvas alpha ou null
    this.editMask = false; // vrai si on peint dans le masque du calque actif
    this.fileInfo = null;
  }

  get active() {
    return this.layers.find((l) => l.id === this.activeId) || this.layers[this.layers.length - 1] || null;
  }

  get activeIndex() {
    return this.layers.findIndex((l) => l.id === this.activeId);
  }

  layerById(id) {
    return this.layers.find((l) => l.id === id);
  }

  newLayerCanvas() {
    return createCanvas(this.width, this.height);
  }

  addLayer(props = {}, index = null) {
    const layer = makeLayer({ canvas: props.canvas || this.newLayerCanvas(), ...props });
    if (!props.name) layer.name = `Calque ${this.layers.length + 1}`;
    const i = index == null ? this.activeIndex + 1 || this.layers.length : index;
    this.layers.splice(i, 0, layer);
    this.activeId = layer.id;
    return layer;
  }

  removeLayer(id) {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return;
    this.layers.splice(i, 1);
    if (this.activeId === id) this.activeId = (this.layers[Math.max(0, i - 1)] || {}).id || null;
  }

  snapshot() {
    return {
      width: this.width,
      height: this.height,
      activeId: this.activeId,
      selection: this.selection,
      editMask: this.editMask,
      layers: this.layers.map((l) => ({ ...l, effects: cloneEffects(l.effects), text: l.text ? { ...l.text } : null })),
    };
  }

  restore(s) {
    this.width = s.width;
    this.height = s.height;
    this.activeId = s.activeId;
    this.selection = s.selection;
    this.editMask = s.editMask;
    this.layers = s.layers.map((l) => ({ ...l, effects: cloneEffects(l.effects), text: l.text ? { ...l.text } : null }));
  }
}

// ---------- Composition ----------

const temps = [];
function temp(i, w, h) {
  let c = temps[i];
  if (!c) c = temps[i] = createCanvas(w, h);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  return { c, ctx };
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Dessine uniquement l'ombre d'une image (astuce : image hors champ, ombre décalée dans le champ).
function drawShadowOnly(ctx, src, color, blur, dx, dy) {
  const off = src.width + 1000;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = dx + off;
  ctx.shadowOffsetY = dy;
  ctx.drawImage(src, -off, 0);
  ctx.restore();
}

// Contour extérieur approximé par plusieurs copies décalées teintées.
function drawStroke(ctx, src, color, width, opacity, w, h) {
  const { c, ctx: t } = temp(3, w, h);
  const steps = Math.max(8, Math.min(32, Math.round(width * 3)));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    t.drawImage(src, Math.cos(a) * width, Math.sin(a) * width);
  }
  t.globalCompositeOperation = 'source-in';
  t.fillStyle = color;
  t.fillRect(0, 0, w, h);
  t.globalCompositeOperation = 'destination-out';
  t.drawImage(src, 0, 0);
  ctx.save();
  ctx.globalAlpha *= opacity;
  ctx.drawImage(c, 0, 0);
  ctx.restore();
}

/**
 * Compose tous les calques visibles dans `target` (canvas à la taille du document).
 * opts.live    : { layerId, draw(ctx) } – rendu en direct d'un calque (pinceau en cours…)
 * opts.liveMask: { layerId, draw(ctx) } – rendu en direct d'un masque
 * opts.preview : { layerId, canvas }    – aperçu d'un réglage (canvas éventuellement réduit)
 * opts.only    : id d'un calque à rendre seul (vignettes)
 */
export function composite(doc, target, opts = {}) {
  const w = doc.width, h = doc.height;
  if (target.width !== w || target.height !== h) {
    target.width = w;
    target.height = h;
  }
  const ctx = target.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, w, h);
  }

  for (const l of doc.layers) {
    if (!l.visible && !opts.includeHidden) continue;
    if (opts.only && l.id !== opts.only) continue;
    if (opts.skip && opts.skip === l.id) continue;
    let src = l.canvas;

    if (opts.live && opts.live.layerId === l.id) {
      const t = temp(0, w, h);
      opts.live.draw(t.ctx);
      src = t.c;
    } else if (opts.preview && opts.preview.layerId === l.id) {
      const t = temp(0, w, h);
      t.ctx.imageSmoothingQuality = 'high';
      t.ctx.drawImage(opts.preview.canvas, 0, 0, w, h);
      src = t.c;
    }

    let mask = l.mask && l.maskEnabled ? l.mask : null;
    if (opts.liveMask && opts.liveMask.layerId === l.id) {
      const t = temp(1, w, h);
      opts.liveMask.draw(t.ctx);
      mask = t.c;
    }
    if (mask) {
      const t = temp(2, w, h);
      t.ctx.drawImage(src, 0, 0);
      t.ctx.globalCompositeOperation = 'destination-in';
      t.ctx.drawImage(mask, 0, 0);
      src = t.c;
    }

    ctx.globalAlpha = l.opacity;
    ctx.globalCompositeOperation = l.blend;
    const fx = l.effects;
    if (fx) {
      if (fx.shadow.enabled) {
        const rad = (fx.shadow.angle * Math.PI) / 180;
        drawShadowOnly(ctx, src, hexA(fx.shadow.color, fx.shadow.opacity), fx.shadow.blur,
          -Math.cos(rad) * fx.shadow.distance, Math.sin(rad) * fx.shadow.distance);
      }
      if (fx.glow.enabled) drawShadowOnly(ctx, src, hexA(fx.glow.color, fx.glow.opacity), fx.glow.blur, 0, 0);
      if (fx.stroke.enabled) drawStroke(ctx, src, fx.stroke.color, fx.stroke.width, fx.stroke.opacity, w, h);
    }
    ctx.drawImage(src, 0, 0);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  return target;
}

// Rendu d'un seul calque avec masque appliqué (sans effets ni opacité) dans un nouveau canvas.
export function layerPixels(doc, layer) {
  const c = createCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(layer.canvas, 0, 0);
  if (layer.mask && layer.maskEnabled) {
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(layer.mask, 0, 0);
  }
  return c;
}

export function flatten(doc, background = null) {
  return composite(doc, createCanvas(doc.width, doc.height), { background });
}
