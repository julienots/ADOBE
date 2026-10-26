// Classe de base des outils et utilitaires de pinceau partagés.

import { loadPref, savePref } from '../app.js';
import { createCanvas, hexToRgb } from '../util.js';

export class Tool {
  constructor(app, def) {
    this.app = app;
    this.id = def.id;
    this.name = def.name;
    this.icon = def.icon;
    this.key = def.key || '';
    this.group = def.group || '';
    this.cursor = def.cursor || 'crosshair';
    this.opts = { ...(def.defaults || {}), ...loadPref(`tool.${def.id}`, {}) };
  }

  get doc() {
    return this.app.doc;
  }

  // Définition des options affichées dans la barre d'options (surchargée par les outils).
  options() {
    return [];
  }

  setOpt(key, value) {
    this.opts[key] = value;
    savePref(`tool.${this.id}`, this.opts);
    this.onOption?.(key, value);
    this.app.view?.requestRender();
  }

  // Prépare une modification : valide les réglages en attente et vérifie le calque.
  begin() {
    this.app.flushPending();
    return this.app.canEdit();
  }
}

// ---------- Pointes de pinceau ----------

const tipCache = new Map();

// Pointe ronde : dégradé radial dont la dureté règle le contour.
export function brushTip(diameter, hardness, color = '#ffffff') {
  const d = Math.max(1, Math.round(diameter));
  const key = `${d}|${hardness}|${color}`;
  let tip = tipCache.get(key);
  if (tip) return tip;
  const size = Math.max(2, d + 2);
  tip = createCanvas(size, size);
  const ctx = tip.getContext('2d');
  const r = d / 2, c = size / 2;
  const { r: R, g: G, b: B } = hexToRgb(color);
  if (hardness >= 0.99 || d <= 2) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(c, c, Math.max(0.5, r), 0, Math.PI * 2);
    ctx.fill();
  } else {
    const g = ctx.createRadialGradient(c, c, 0, c, c, r);
    const h = Math.max(0, Math.min(0.98, hardness));
    g.addColorStop(0, `rgba(${R},${G},${B},1)`);
    g.addColorStop(h, `rgba(${R},${G},${B},1)`);
    // Décroissance douce (approximation gaussienne)
    for (let i = 1; i <= 4; i++) {
      const t = h + ((1 - h) * i) / 5;
      const a = Math.exp(-Math.pow((i / 5) * 2.2, 2));
      g.addColorStop(t, `rgba(${R},${G},${B},${a.toFixed(3)})`);
    }
    g.addColorStop(1, `rgba(${R},${G},${B},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  if (tipCache.size > 40) tipCache.delete(tipCache.keys().next().value);
  tipCache.set(key, tip);
  return tip;
}

// Parcourt un segment en appelant `dab(x, y, pression)` à intervalle régulier.
export class Stroker {
  constructor(spacingPx) {
    this.spacing = Math.max(0.5, spacingPx);
    this.last = null;
    this.carry = 0;
  }

  start(p, dab) {
    this.last = p;
    this.carry = 0;
    dab(p.x, p.y, p.pressure ?? 1);
  }

  to(p, dab) {
    const a = this.last;
    if (!a) return this.start(p, dab);
    const dx = p.x - a.x, dy = p.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return;
    let t = this.spacing - this.carry;
    while (t <= dist) {
      const k = t / dist;
      const pr = (a.pressure ?? 1) + ((p.pressure ?? 1) - (a.pressure ?? 1)) * k;
      dab(a.x + dx * k, a.y + dy * k, pr);
      t += this.spacing;
    }
    this.carry = dist - (t - this.spacing);
    this.last = p;
  }
}

// Masque une copie du canvas par la sélection courante (si elle existe).
export function clipToSelection(canvas, selection, reuse) {
  if (!selection) return canvas;
  const c = reuse && reuse.width === canvas.width && reuse.height === canvas.height ? reuse : createCanvas(canvas.width, canvas.height);
  const ctx = c.getContext('2d');
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(canvas, 0, 0);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(selection, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

export const SEL_MODES = [
  ['new', '◻', 'Nouvelle sélection'],
  ['add', '⊕', 'Ajouter à la sélection'],
  ['sub', '⊖', 'Soustraire de la sélection'],
  ['inter', '⊗', 'Intersection'],
];

export const BRUSH_MODES = [
  ['source-over', 'Normal'], ['multiply', 'Produit'], ['screen', 'Superposition'], ['overlay', 'Incrustation'],
  ['darken', 'Obscurcir'], ['lighten', 'Éclaircir'], ['color', 'Couleur'], ['hue', 'Teinte'], ['saturation', 'Saturation'], ['luminosity', 'Luminosité'],
];
