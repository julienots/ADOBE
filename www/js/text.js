// Rendu des calques texte (ré-éditables).

import { createCanvas, hexToRgb } from './util.js';

export const FONTS = [
  'Inter, system-ui, sans-serif', 'Arial, Helvetica, sans-serif', 'Georgia, serif', '"Times New Roman", Times, serif',
  '"Courier New", monospace', 'Verdana, sans-serif', '"Trebuchet MS", sans-serif', 'Impact, "Arial Black", sans-serif',
  '"Comic Sans MS", "Comic Neue", cursive', '"Palatino Linotype", Palatino, serif', 'Garamond, serif', '"Brush Script MT", cursive',
  '"Segoe UI", Roboto, sans-serif', 'system-ui, sans-serif',
];

export const fontLabel = (f) => f.split(',')[0].replace(/"/g, '');

export function defaultTextMeta() {
  return {
    text: '', font: FONTS[0], size: 72, color: '#ffffff', bold: true, italic: false, align: 'left',
    lineHeight: 1.2, letterSpacing: 0, strokeColor: '#000000', strokeWidth: 0,
    shadow: true, shadowColor: '#000000', shadowBlur: 12, shadowOpacity: 0.5,
    background: false, bgColor: '#000000', bgOpacity: 0.55, bgPadding: 24, rotation: 0, opacity: 1,
    uppercase: false, x: 0, y: 0,
  };
}

function fontString(m) {
  return `${m.italic ? 'italic ' : ''}${m.bold ? '700 ' : '400 '}${m.size}px ${m.font}`;
}

export function measureText(ctx, m) {
  const lines = (m.uppercase ? m.text.toUpperCase() : m.text).split('\n');
  ctx.font = fontString(m);
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${m.letterSpacing}px`;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const lh = m.size * m.lineHeight;
  return { lines, widths, w: Math.max(1, ...widths), h: lh * lines.length, lh };
}

// Dessine le texte dans un canvas à la taille du document. (x, y) = coin haut-gauche du bloc.
export function renderText(doc, m) {
  const c = createCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d');
  const { lines, widths, w, h, lh } = measureText(ctx, m);
  const pad = m.background ? m.bgPadding : 0;
  const bx = m.x - pad, by = m.y - pad, bw = w + pad * 2, bh = h + pad * 2;

  ctx.save();
  ctx.globalAlpha = m.opacity ?? 1;
  if (m.rotation) {
    const cx = m.x + w / 2, cy = m.y + h / 2;
    ctx.translate(cx, cy);
    ctx.rotate((m.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }
  if (m.background) {
    const { r, g, b } = hexToRgb(m.bgColor);
    ctx.fillStyle = `rgba(${r},${g},${b},${m.bgOpacity})`;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, Math.min(24, pad));
    ctx.fill();
  }
  ctx.font = fontString(m);
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${m.letterSpacing}px`;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  lines.forEach((line, i) => {
    const lw = widths[i];
    const x = m.align === 'center' ? m.x + (w - lw) / 2 : m.align === 'right' ? m.x + (w - lw) : m.x;
    const y = m.y + i * lh + m.size * 0.92;
    if (m.shadow) {
      const { r, g, b } = hexToRgb(m.shadowColor);
      ctx.shadowColor = `rgba(${r},${g},${b},${m.shadowOpacity})`;
      ctx.shadowBlur = m.shadowBlur;
      ctx.shadowOffsetY = m.shadowBlur * 0.3;
    }
    if (m.strokeWidth > 0) {
      ctx.strokeStyle = m.strokeColor;
      ctx.lineWidth = m.strokeWidth * 2;
      ctx.strokeText(line, x, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = m.color;
    ctx.fillText(line, x, y);
    ctx.shadowColor = 'transparent';
  });
  ctx.restore();
  return { canvas: c, bounds: { x: bx, y: by, w: bw, h: bh } };
}
