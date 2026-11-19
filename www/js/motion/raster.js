// Prisme Motion — rastérisation des calques texte, des calques de forme et des masques.
// Chaque résultat est mis en cache : on ne redessine que lorsque les paramètres changent.
// Les coordonnées renvoyées sont en unités du calque ; `scale` est la densité de pixels.

import { clamp, EASINGS } from './model.js';

const mk = (w, h) => {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(Math.max(1, w), Math.max(1, h)) : Object.assign(document.createElement('canvas'), { width: Math.max(1, w), height: Math.max(1, h) });
  return c;
};

const MAX_SIDE = 8192;

// ---------- Texte ----------

const measureCanvas = mk(4, 4);
const mctx = measureCanvas.getContext('2d');

function fontCss(c, size) {
  return `${c.weight || '700'} ${size}px ${c.font}`;
}

export function textKey(c, t, scale) {
  const timeDep = c.animator === 'wave';
  return JSON.stringify([c.text, c.font, c.weight, c.align, c.fontSize, c.fill, c.strokeWidth, c.stroke, c.tracking, c.leading, c.animator, c.animator === 'none' ? 0 : c.reveal, c.spread, timeDep ? Math.round(t * 120) : 0, Math.round(scale * 1000)]);
}

export function rasterText(c, t, scale) {
  const fs = Math.max(1, c.fontSize);
  const lines = String(c.text ?? '').split('\n');
  mctx.font = fontCss(c, fs);
  const track = (c.tracking || 0) * fs / 1000;
  const lh = fs * (c.leading || 1.15);
  const chars = [];
  let total = 0;
  const lineInfo = lines.map((line) => {
    const glyphs = [...line];
    let w = 0;
    const xs = [];
    for (const g of glyphs) {
      xs.push(w);
      w += mctx.measureText(g).width + track;
    }
    if (glyphs.length) w -= track;
    total += glyphs.length;
    return { glyphs, xs, w };
  });
  const maxW = Math.max(1, ...lineInfo.map((l) => l.w));
  const blockH = lh * lines.length;
  const pad = (c.strokeWidth || 0) + fs * 0.6 + 4;
  const x0 = (c.align === 'left' ? 0 : c.align === 'right' ? -maxW : -maxW / 2) - pad;
  const y0 = -blockH / 2 - pad;
  const w = maxW + pad * 2, h = blockH + pad * 2;
  const s = Math.min(scale, MAX_SIDE / w, MAX_SIDE / h);
  const cv = mk(Math.ceil(w * s), Math.ceil(h * s));
  const ctx = cv.getContext('2d');
  ctx.scale(s, s);
  ctx.translate(-x0, -y0);
  ctx.font = fontCss(c, fs);
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.fillStyle = c.fill || '#ffffff';
  ctx.strokeStyle = c.stroke || '#000000';
  ctx.lineWidth = (c.strokeWidth || 0) * 2;
  const anim = c.animator && c.animator !== 'none' ? c.animator : null;
  const N = Math.max(1, total);
  const reveal = clamp((c.reveal ?? 100) / 100, 0, 1);
  const S = Math.max(1, ((c.spread ?? 30) / 100) * N);
  let idx = 0;
  lineInfo.forEach((L, li) => {
    const lx = c.align === 'left' ? 0 : c.align === 'right' ? -L.w : -L.w / 2;
    const by = -blockH / 2 + li * lh + fs * 0.82 + (lh - fs) / 2;
    if (!anim) {
      // Ligne entière (meilleur crénage) avec l'interlettrage natif du canvas.
      ctx.letterSpacing = `${track}px`;
      if (c.strokeWidth > 0) ctx.strokeText(lines[li], lx, by);
      ctx.fillText(lines[li], lx, by);
      ctx.letterSpacing = '0px';
      return;
    }
    L.glyphs.forEach((g, gi) => {
      const i = idx++;
      let a;
      if (anim === 'type' || anim === 'wave') a = i < Math.round(reveal * N) ? 1 : 0;
      else a = clamp((reveal * (N + S) - i) / S, 0, 1);
      if (a <= 0 || g === ' ') return;
      const gx = lx + L.xs[gi];
      const gw = mctx.measureText(g).width;
      ctx.save();
      let dy = 0, sc = 1, alpha = 1;
      if (anim === 'fade') alpha = a;
      else if (anim === 'rise') {
        const e = EASINGS.expo.fn(a);
        alpha = a;
        dy = (1 - e) * fs * 0.7;
      } else if (anim === 'pop') {
        sc = EASINGS.back.fn(a);
        alpha = Math.min(1, a * 2);
      } else if (anim === 'blur') {
        alpha = a;
        const b = (1 - a) * fs * 0.2 * s;
        if (b > 0.3) ctx.filter = `blur(${b}px)`;
      } else if (anim === 'wave') dy = Math.sin(t * 5 - i * 0.45) * fs * 0.12;
      ctx.globalAlpha = alpha;
      ctx.translate(gx + gw / 2, by + dy - fs * 0.35);
      if (sc !== 1) ctx.scale(sc, sc);
      ctx.translate(-gw / 2, fs * 0.35);
      if (c.strokeWidth > 0) ctx.strokeText(g, 0, 0);
      ctx.fillText(g, 0, 0);
      ctx.restore();
    });
  });
  return { canvas: cv, x: x0, y: y0, w, h, scale: s };
}

// ---------- Formes ----------

export function shapeKey(c, path, scale) {
  return JSON.stringify([c, path, Math.round(scale * 1000)]);
}

function roundRect(w, h, r) {
  const pts = [];
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const hw = w / 2, hh = h / 2;
  if (r < 0.01) return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const corners = [[hw - r, -hh + r, -90], [hw - r, hh - r, 0], [-hw + r, hh - r, 90], [-hw + r, -hh + r, 180]];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= 8; i++) {
      const a = ((a0 + (i * 90) / 8) * Math.PI) / 180;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
}

export function shapePoints(c, path) {
  const [w, h] = c.size || [100, 100];
  switch (c.shape) {
    case 'ellipse': {
      const n = 120, pts = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        pts.push([Math.cos(a) * w / 2, Math.sin(a) * h / 2]);
      }
      return { pts, closed: true };
    }
    case 'polygon':
    case 'star': {
      const n = Math.max(3, Math.round(c.points || 5));
      const pts = [];
      const star = c.shape === 'star';
      const steps = star ? n * 2 : n;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2 - Math.PI / 2;
        const rr = star && i % 2 ? (c.innerRatio ?? 45) / 100 : 1;
        pts.push([Math.cos(a) * (w / 2) * rr, Math.sin(a) * (h / 2) * rr]);
      }
      return { pts, closed: true };
    }
    case 'line':
      return { pts: [[-w / 2, 0], [w / 2, 0]], closed: false };
    case 'path':
      return { pts: path?.points?.length ? path.points : [[-w / 2, 0], [w / 2, 0]], closed: path?.closed ?? true };
    default:
      return { pts: roundRect(w, h, c.roundness || 0), closed: true };
  }
}

// Sous-tracé entre deux fractions de la longueur (outil « Raccorder les tracés »).
function trimPolyline(pts, closed, a, b) {
  const P = closed ? [...pts, pts[0]] : pts;
  const lens = [0];
  for (let i = 1; i < P.length; i++) lens.push(lens[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  const L = lens[lens.length - 1] || 1;
  const at = (d) => {
    d = clamp(d, 0, L);
    let i = 1;
    while (i < lens.length - 1 && lens[i] < d) i++;
    const u = (d - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
    return [P[i - 1][0] + (P[i][0] - P[i - 1][0]) * u, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * u, i];
  };
  const seg = (d0, d1) => {
    const s = at(d0), e = at(d1);
    const out = [[s[0], s[1]]];
    for (let i = s[2]; i < e[2]; i++) out.push(P[i]);
    out.push([e[0], e[1]]);
    return out;
  };
  const d0 = a * L, d1 = b * L;
  if (d1 <= L) return [seg(d0, d1)];
  return [seg(d0, L), seg(0, d1 - L)];
}

export function rasterShape(c, path, scale) {
  const { pts, closed } = shapePoints(c, path);
  let ts = clamp((c.trimStart ?? 0) / 100, 0, 1), te = clamp((c.trimEnd ?? 100) / 100, 0, 1);
  if (ts > te) [ts, te] = [te, ts];
  const off = (((c.trimOffset || 0) / 360) % 1 + 1) % 1;
  const trimmed = ts > 0.0005 || te < 0.9995;
  const subpaths = trimmed ? (te - ts < 0.0005 ? [] : trimPolyline(pts, closed, ts + off, te + off).map((p) => [p, false])) : [[pts, closed]];
  const copies = Math.max(1, Math.round(c.copies || 1));
  const ro = c.repOffset || [0, 0], rr = ((c.repRotation || 0) * Math.PI) / 180, rs = (c.repScale ?? 100) / 100;
  const xf = [];
  for (let i = 0; i < copies; i++) {
    const s = Math.pow(rs, i), a = rr * i;
    xf.push({ tx: ro[0] * i, ty: ro[1] * i, cos: Math.cos(a) * s, sin: Math.sin(a) * s, s, alpha: copies > 1 ? 1 + ((c.repFade ?? 100) / 100 - 1) * (i / (copies - 1)) : 1 });
  }
  const sw = c.strokeOn ? Math.max(0, c.strokeWidth || 0) : 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const x of xf) {
    for (const p of pts) {
      const X = p[0] * x.cos - p[1] * x.sin + x.tx, Y = p[0] * x.sin + p[1] * x.cos + x.ty;
      if (X < minX) minX = X;
      if (Y < minY) minY = Y;
      if (X > maxX) maxX = X;
      if (Y > maxY) maxY = Y;
    }
  }
  if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;
  const pad = sw * Math.max(1, rs ** (copies - 1)) + 4;
  const x0 = minX - pad, y0 = minY - pad, w = maxX - minX + pad * 2, h = maxY - minY + pad * 2;
  const s = Math.min(scale, MAX_SIDE / w, MAX_SIDE / h);
  const cv = mk(Math.ceil(w * s), Math.ceil(h * s));
  const ctx = cv.getContext('2d');
  ctx.scale(s, s);
  ctx.translate(-x0, -y0);
  ctx.lineJoin = 'round';
  ctx.lineCap = closed ? 'butt' : 'round';
  if (c.dash > 0) ctx.setLineDash([c.dash, c.dash]);
  const trace = (list, x) => {
    ctx.beginPath();
    for (const [P, cl] of list) {
      P.forEach((p, i) => {
        const X = p[0] * x.cos - p[1] * x.sin + x.tx, Y = p[0] * x.sin + p[1] * x.cos + x.ty;
        if (i) ctx.lineTo(X, Y);
        else ctx.moveTo(X, Y);
      });
      if (cl) ctx.closePath();
    }
  };
  // Les copies du répéteur sont dessinées de la dernière à la première (la première au-dessus).
  for (let i = xf.length - 1; i >= 0; i--) {
    const x = xf[i];
    ctx.globalAlpha = clamp(x.alpha, 0, 1);
    if (c.fillOn && closed) {
      trace(trimmed ? subpaths : [[pts, true]], x);
      ctx.fillStyle = c.fill || '#ffffff';
      ctx.fill();
    }
    if (sw > 0) {
      trace(subpaths, x);
      ctx.strokeStyle = c.stroke || '#ffffff';
      ctx.lineWidth = sw * x.s;
      ctx.stroke();
    }
  }
  return { canvas: cv, x: x0, y: y0, w, h, scale: s };
}

// ---------- Masques ----------

export function maskPolygon(m, vals) {
  if (m.kind === 'rect' || m.kind === 'ellipse') {
    const [x, y, w, h] = vals.box;
    if (m.kind === 'rect') return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const pts = [];
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      pts.push([x + w / 2 + (Math.cos(a) * w) / 2, y + h / 2 + (Math.sin(a) * h) / 2]);
    }
    return pts;
  }
  return m.points || [];
}

// masks : [{ mask, vals }] ; box : rectangle de la source (unités du calque) ; scale : densité.
export function rasterMasks(masks, box, scale) {
  const W = Math.max(1, Math.ceil(box.w * scale)), H = Math.max(1, Math.ceil(box.h * scale));
  const out = mk(W, H);
  const octx = out.getContext('2d');
  const first = masks.find((m) => m.mask.mode !== 'none');
  if (!first) {
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, W, H);
    return out;
  }
  if (first.mask.mode === 'subtract' || first.mask.mode === 'intersect') {
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, W, H);
  }
  const tmp = mk(W, H);
  const t = tmp.getContext('2d');
  for (const { mask: m, vals } of masks) {
    if (m.mode === 'none') continue;
    t.setTransform(1, 0, 0, 1, 0, 0);
    t.globalCompositeOperation = 'source-over';
    t.filter = 'none';
    t.clearRect(0, 0, W, H);
    const pts = maskPolygon(m, vals);
    if (pts.length < 2) continue;
    const feather = Math.max(0, vals.feather || 0) * scale;
    const exp = (vals.expansion || 0) * scale;
    const [ox, oy] = vals.offset || [0, 0];
    const draw = (ctx) => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const X = (p[0] + ox - box.x) * scale, Y = (p[1] + oy - box.y) * scale;
        if (i) ctx.lineTo(X, Y);
        else ctx.moveTo(X, Y);
      });
      ctx.closePath();
    };
    if (feather > 0.3) t.filter = `blur(${feather / 2}px)`;
    t.fillStyle = '#fff';
    t.strokeStyle = '#fff';
    t.lineJoin = 'round';
    if (m.inverted) {
      t.fillRect(-W, -H, W * 3, H * 3);
      t.globalCompositeOperation = 'destination-out';
    }
    draw(t);
    t.fill();
    if (exp > 0) {
      t.lineWidth = exp * 2;
      t.stroke();
    } else if (exp < 0) {
      t.globalCompositeOperation = m.inverted ? 'source-over' : 'destination-out';
      t.lineWidth = -exp * 2;
      t.stroke();
    }
    octx.globalAlpha = clamp((vals.opacity ?? 100) / 100, 0, 1);
    octx.globalCompositeOperation = m.mode === 'subtract' ? 'destination-out' : m.mode === 'intersect' ? 'destination-in' : 'source-over';
    octx.drawImage(tmp, 0, 0);
  }
  octx.globalAlpha = 1;
  octx.globalCompositeOperation = 'source-over';
  return out;
}

// Petit cache LRU partagé.
export class LRU {
  constructor(max = 64, onEvict) {
    this.max = max;
    this.map = new Map();
    this.onEvict = onEvict;
  }

  get(k) {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }

  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) {
      const [fk, fv] = this.map.entries().next().value;
      this.map.delete(fk);
      this.onEvict?.(fv, fk);
    }
  }

  clear() {
    if (this.onEvict) for (const [k, v] of this.map) this.onEvict(v, k);
    this.map.clear();
  }
}
