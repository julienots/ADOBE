// Prisme Motion — modèle de données : projet, compositions, calques, propriétés animables,
// images clés, interpolations, expressions et préréglages d'animation.
//
// Un calque possède un dictionnaire plat de propriétés `layer.p` (clé → Prop).
//   Prop = { v: valeur statique, k: [images clés] | undefined, x: expression | undefined }
//   Image clé = { t: temps (s, temps de composition), v: valeur, e: interpolation vers la clé suivante }
// Les valeurs sont des nombres, des tableaux de nombres (vecteurs) ou des couleurs « #rrggbb ».

export const MOTION_VERSION = 1;

let counter = 0;
export const mid = (p = 'm') => `${p}${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- Couleurs ----------

export function hexToArr(hex) {
  if (Array.isArray(hex)) return hex;
  const h = String(hex || '#000000').replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  return [parseInt(f.slice(0, 2), 16) / 255, parseInt(f.slice(2, 4), 16) / 255, parseInt(f.slice(4, 6), 16) / 255];
}

export function arrToHex(a) {
  const c = (x) => Math.round(clamp(x, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${c(a[0])}${c(a[1])}${c(a[2])}`;
}

const isColor = (v) => typeof v === 'string' && v[0] === '#';

// ---------- Interpolations ----------

// Courbes de Bézier temporelles (mêmes conventions que cubic-bezier en CSS).
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    let t = x;
    for (let i = 0; i < 6; i++) {
      const e = sx(t) - x, d = dx(t);
      if (Math.abs(e) < 1e-5) break;
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    if (t < 0 || t > 1 || Math.abs(sx(t) - x) > 1e-3) {
      let lo = 0, hi = 1;
      t = x;
      for (let i = 0; i < 24; i++) {
        if (sx(t) < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return sy(t);
  };
}

const easeBack = (u) => {
  const s = 1.70158 * 1.2;
  return 1 + (s + 1) * Math.pow(u - 1, 3) + s * Math.pow(u - 1, 2);
};
const easeElastic = (u) => (u === 0 || u === 1 ? u : Math.pow(2, -10 * u) * Math.sin((u * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1);
const easeBounce = (u) => {
  const n = 7.5625, d = 2.75;
  if (u < 1 / d) return n * u * u;
  if (u < 2 / d) return n * (u -= 1.5 / d) * u + 0.75;
  if (u < 2.5 / d) return n * (u -= 2.25 / d) * u + 0.9375;
  return n * (u -= 2.625 / d) * u + 0.984375;
};

export const EASINGS = {
  linear: { label: 'Linéaire', fn: (u) => u },
  ease: { label: 'Lissage (Easy Ease)', fn: bezier(0.33, 0, 0.67, 1), key: 'F9' },
  easeOut: { label: 'Décélération (arrivée douce)', fn: bezier(0, 0, 0.58, 1) },
  easeIn: { label: 'Accélération (départ doux)', fn: bezier(0.42, 0, 1, 1) },
  expo: { label: 'Exponentiel', fn: bezier(0.16, 1, 0.3, 1) },
  back: { label: 'Dépassement', fn: easeBack },
  elastic: { label: 'Élastique', fn: easeElastic },
  bounce: { label: 'Rebond', fn: easeBounce },
  hold: { label: 'Maintien (pas de transition)', fn: () => 0 },
};

export function lerpValue(a, b, u) {
  if (typeof a === 'number') return a + (b - a) * u;
  if (isColor(a)) {
    const x = hexToArr(a), y = hexToArr(b);
    return arrToHex([x[0] + (y[0] - x[0]) * u, x[1] + (y[1] - x[1]) * u, x[2] + (y[2] - x[2]) * u]);
  }
  if (Array.isArray(a)) return a.map((v, i) => v + ((b[i] ?? v) - v) * u);
  return u < 1 ? a : b;
}

// Valeur des images clés à l'instant t (sans expression).
export function keyedValue(prop, t) {
  const k = prop.k;
  if (!k || !k.length) return prop.v;
  if (t <= k[0].t) return k[0].v;
  const last = k[k.length - 1];
  if (t >= last.t) return last.v;
  // Recherche dichotomique du segment
  let lo = 0, hi = k.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (k[m].t <= t) lo = m;
    else hi = m;
  }
  const a = k[lo], b = k[hi];
  if (a.e === 'hold' || typeof a.v === 'string' && !isColor(a.v)) return a.v;
  const u = (t - a.t) / (b.t - a.t || 1);
  const f = (EASINGS[a.e] || EASINGS.linear).fn;
  return lerpValue(a.v, b.v, f(u));
}

export const isAnimated = (prop) => !!(prop && ((prop.k && prop.k.length) || prop.x));

// ---------- Bruit déterministe (wiggle, particules, grain…) ----------

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export function rand01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

// Bruit de valeur lissé sur une dimension, dans [-1, 1].
export function noise1(x) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return (rand01(i) * (1 - u) + rand01(i + 1) * u) * 2 - 1;
}

function wiggleAt(seed, t, freq, amp, octaves = 1, ampMult = 0.5) {
  let s = 0, a = 1, fq = freq, norm = 0;
  for (let o = 0; o < Math.max(1, octaves); o++) {
    s += noise1(t * fq + seed * 1000 + o * 37.7) * a;
    norm += a;
    a *= ampMult;
    fq *= 2;
  }
  return (s / norm) * amp * 1.4;
}

// ---------- Expressions ----------

const exprErrors = new Map();
export const expressionError = (prop) => exprErrors.get(prop);

const vecOp = (a, b, op) => {
  if (Array.isArray(a) && Array.isArray(b)) return a.map((v, i) => op(v, b[i] ?? 0));
  if (Array.isArray(a)) return a.map((v) => op(v, b));
  if (Array.isArray(b)) return b.map((v) => op(a, v));
  return op(a, b);
};

const MATH = {};
for (const k of Object.getOwnPropertyNames(Math)) MATH[k] = Math[k];

function loopTime(prop, t, type, out = true) {
  const k = prop.k;
  if (!k || k.length < 2) return { t, cycles: 0 };
  const a = k[0].t, b = k[k.length - 1].t, d = b - a;
  if (d <= 0) return { t, cycles: 0 };
  if (out && t <= b) return { t, cycles: 0 };
  if (!out && t >= a) return { t, cycles: 0 };
  const rel = t - a;
  const cycles = Math.floor(rel / d);
  let local = rel - cycles * d;
  if (type === 'pingpong' && Math.abs(cycles) % 2 === 1) local = d - local;
  return { t: a + local, cycles };
}

export function evalExpression(prop, value, t, ctx) {
  const src = prop.x;
  const seedBase = hashStr(`${ctx.layer?.id || ''}:${ctx.key || ''}`);
  let rndState = seedBase * 1e6;
  const env = {
    ...MATH,
    time: t, value, fps: ctx.comp?.fps || 30, index: ctx.index ?? 1,
    inPoint: ctx.layer?.in ?? 0, outPoint: ctx.layer?.out ?? 0,
    thisComp: ctx.comp ? { width: ctx.comp.width, height: ctx.comp.height, duration: ctx.comp.duration, fps: ctx.comp.fps, name: ctx.comp.name } : {},
    thisLayer: ctx.layer ? { name: ctx.layer.name, inPoint: ctx.layer.in, outPoint: ctx.layer.out } : {},
    PI: Math.PI,
    add: (a, b) => vecOp(a, b, (x, y) => x + y),
    sub: (a, b) => vecOp(a, b, (x, y) => x - y),
    mul: (a, b) => vecOp(a, b, (x, y) => x * y),
    div: (a, b) => vecOp(a, b, (x, y) => x / y),
    clamp: (v, a, b) => (Array.isArray(v) ? v.map((x) => clamp(x, a, b)) : clamp(v, a, b)),
    degreesToRadians: (d) => (d * Math.PI) / 180,
    radiansToDegrees: (r) => (r * 180) / Math.PI,
    linear: (x, a, b, v1, v2) => {
      if (v1 === undefined) return x;
      const u = clamp((x - a) / (b - a || 1), 0, 1);
      return lerpValue(v1, v2, u);
    },
    ease: (x, a, b, v1, v2) => lerpValue(v1, v2, EASINGS.ease.fn(clamp((x - a) / (b - a || 1), 0, 1))),
    easeIn: (x, a, b, v1, v2) => lerpValue(v1, v2, EASINGS.easeIn.fn(clamp((x - a) / (b - a || 1), 0, 1))),
    easeOut: (x, a, b, v1, v2) => lerpValue(v1, v2, EASINGS.easeOut.fn(clamp((x - a) / (b - a || 1), 0, 1))),
    random: (a, b) => {
      rndState += 1;
      const r = rand01(rndState);
      if (a === undefined) return r;
      if (b === undefined) return r * a;
      return a + r * (b - a);
    },
    noise: (x) => noise1(Array.isArray(x) ? x[0] : x),
    wiggle: (freq, amp, oct = 1, mult = 0.5, tt = t) => {
      if (Array.isArray(value)) return value.map((v, i) => v + wiggleAt(seedBase + i * 0.137, tt, freq, amp, oct, mult));
      if (typeof value === 'number') return value + wiggleAt(seedBase, tt, freq, amp, oct, mult);
      return value;
    },
    valueAtTime: (tt) => keyedValue(prop, tt),
    loopOut: (type = 'cycle') => {
      const { t: lt, cycles } = loopTime(prop, t, type, true);
      let v = keyedValue(prop, lt);
      if (type === 'offset' && cycles > 0) {
        const d = vecOp(prop.k[prop.k.length - 1].v, prop.k[0].v, (x, y) => x - y);
        v = vecOp(v, vecOp(d, cycles, (x, y) => x * y), (x, y) => x + y);
      }
      return v;
    },
    loopIn: (type = 'cycle') => keyedValue(prop, loopTime(prop, t, type, false).t),
    posterizeTime: (f) => {
      env.time = Math.floor(t * f) / f;
      return env.time;
    },
    __src: src,
  };
  try {
    // Les expressions sont des extraits JavaScript écrits par l'utilisateur sur son propre projet.
    // eslint-disable-next-line no-new-func
    const fn = prop.__fn && prop.__fnSrc === src ? prop.__fn : (prop.__fn = new Function('__e', 'with(__e){ return eval(__e.__src); }'), prop.__fnSrc = src, prop.__fn);
    let r = fn(env);
    if (r === undefined || (typeof r === 'number' && !Number.isFinite(r))) r = value;
    if (Array.isArray(value) && typeof r === 'number') r = value.map(() => r);
    if (Array.isArray(value) && Array.isArray(r) && r.length < value.length) r = value.map((v, i) => r[i] ?? v);
    exprErrors.delete(prop);
    return r;
  } catch (e) {
    exprErrors.set(prop, e.message);
    return value;
  }
}

export function propValue(prop, t, ctx) {
  if (!prop) return undefined;
  let v = keyedValue(prop, t);
  if (prop.x && ctx) v = evalExpression(prop, v, t, ctx);
  return v;
}

// ---------- Images clés : édition ----------

const EPS = 1e-4;

export function keyAt(prop, t) {
  return prop.k?.find((k) => Math.abs(k.t - t) < EPS) || null;
}

export function setKey(prop, t, v, e) {
  prop.k ||= [];
  const ex = keyAt(prop, t);
  if (ex) {
    ex.v = clone(v);
    if (e) ex.e = e;
    return ex;
  }
  const key = { t, v: clone(v), e: e || prop.k.find((k) => k.t < t)?.e || 'linear' };
  prop.k.push(key);
  prop.k.sort((a, b) => a.t - b.t);
  return key;
}

export function removeKey(prop, key) {
  if (!prop.k) return;
  prop.k = prop.k.filter((k) => k !== key);
  if (!prop.k.length) delete prop.k;
}

// Modifie une propriété comme After Effects : si le chronomètre est activé, crée/met à jour une
// image clé à l'instant courant ; sinon modifie la valeur statique.
export function setPropValue(prop, t, v) {
  if (prop.k && prop.k.length) setKey(prop, t, v);
  else prop.v = clone(v);
}

export function toggleStopwatch(prop, t) {
  if (prop.k && prop.k.length) {
    prop.v = keyedValue(prop, t);
    delete prop.k;
  } else {
    setKey(prop, t, prop.v);
  }
}

export const clone = (v) => (Array.isArray(v) ? v.slice() : v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

export const P = (v) => ({ v });

// ---------- Définitions des propriétés ----------

// type : num | vec2 | color | angle | text | select | bool
export const TRANSFORM_DEFS = [
  { key: 'anchor', label: "Point d'ancrage", type: 'vec2', step: 1, short: 'A' },
  { key: 'position', label: 'Position', type: 'vec2', step: 1, short: 'P' },
  { key: 'posZ', label: 'Position Z', type: 'num', step: 1, only3d: true },
  { key: 'scale', label: 'Échelle', type: 'vec2', unit: '%', step: 0.5, short: 'S', link: true },
  { key: 'rotX', label: 'Rotation X', type: 'num', unit: '°', step: 0.5, only3d: true },
  { key: 'rotY', label: 'Rotation Y', type: 'num', unit: '°', step: 0.5, only3d: true },
  { key: 'rotation', label: 'Rotation', type: 'num', unit: '°', step: 0.5, short: 'R' },
  { key: 'opacity', label: 'Opacité', type: 'num', unit: '%', min: 0, max: 100, step: 0.5, short: 'T' },
];

export const BLEND_MODES = [
  ['normal', 'Normal'], ['add', 'Addition'], ['screen', 'Superposition'], ['lighten', 'Éclaircir'], ['dodge', 'Densité couleur -'],
  ['multiply', 'Produit'], ['darken', 'Obscurcir'], ['burn', 'Densité couleur +'],
  ['overlay', 'Incrustation'], ['softlight', 'Lumière tamisée'], ['hardlight', 'Lumière crue'],
  ['difference', 'Différence'], ['exclusion', 'Exclusion'], ['subtract', 'Soustraction'],
  ['hue', 'Teinte'], ['saturation', 'Saturation'], ['color', 'Couleur'], ['luminosity', 'Luminosité'],
];
export const BLEND_INDEX = Object.fromEntries(BLEND_MODES.map(([k], i) => [k, i]));

export const MATTE_MODES = [
  ['', 'Aucun cache'], ['alpha', 'Cache alpha'], ['alphaInv', 'Cache alpha inversé'], ['luma', 'Cache de luminance'], ['lumaInv', 'Cache de luminance inversé'],
];

export const LABEL_COLORS = ['#e05252', '#e0a352', '#e0d552', '#7bd552', '#52d5c0', '#52a3e0', '#7b5cff', '#c452e0', '#e052a3', '#9a9aae'];

const FONT_LIST = [
  'Inter, system-ui, sans-serif', 'Arial, Helvetica, sans-serif', 'Impact, "Arial Black", sans-serif', 'Georgia, serif',
  '"Times New Roman", Times, serif', '"Courier New", monospace', 'Verdana, sans-serif', '"Trebuchet MS", sans-serif',
  '"Comic Sans MS", "Comic Neue", cursive', '"Brush Script MT", cursive', '"Segoe UI", Roboto, sans-serif',
];
export const FONTS = FONT_LIST.map((f) => [f, f.split(',')[0].replace(/"/g, '')]);

export const CONTENT_DEFS = {
  solid: [
    { key: 'color', label: 'Couleur', type: 'color' },
    { key: 'size', label: 'Taille', type: 'vec2', step: 1, min: 1 },
  ],
  text: [
    { key: 'text', label: 'Texte', type: 'text' },
    { key: 'font', label: 'Police', type: 'select', options: FONTS },
    { key: 'weight', label: 'Graisse', type: 'select', options: [['400', 'Normal'], ['700', 'Gras'], ['900', 'Extra gras'], ['300', 'Fin']] },
    { key: 'align', label: 'Alignement', type: 'select', options: [['center', 'Centré'], ['left', 'Gauche'], ['right', 'Droite']] },
    { key: 'fontSize', label: 'Corps', type: 'num', min: 1, step: 0.5, unit: 'px' },
    { key: 'fill', label: 'Couleur', type: 'color' },
    { key: 'strokeWidth', label: 'Contour', type: 'num', min: 0, step: 0.25, unit: 'px' },
    { key: 'stroke', label: 'Couleur du contour', type: 'color' },
    { key: 'tracking', label: 'Interlettrage', type: 'num', step: 0.5 },
    { key: 'leading', label: 'Interligne', type: 'num', step: 0.01, min: 0.5 },
    { key: 'animator', label: 'Animation du texte', type: 'select', options: [['none', 'Aucune'], ['type', 'Machine à écrire'], ['fade', 'Fondu par lettre'], ['rise', 'Montée par lettre'], ['pop', 'Pop par lettre'], ['blur', 'Flou par lettre'], ['wave', 'Vague continue']] },
    { key: 'reveal', label: 'Révélation', type: 'num', min: 0, max: 100, unit: '%', step: 0.5 },
    { key: 'spread', label: 'Douceur', type: 'num', min: 0, max: 100, unit: '%', step: 1 },
  ],
  shape: [
    { key: 'shape', label: 'Forme', type: 'select', options: [['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['polygon', 'Polygone'], ['star', 'Étoile'], ['path', 'Tracé'], ['line', 'Ligne']] },
    { key: 'size', label: 'Taille', type: 'vec2', step: 1, min: 0 },
    { key: 'roundness', label: 'Arrondi', type: 'num', min: 0, step: 0.5 },
    { key: 'points', label: 'Sommets', type: 'num', min: 3, max: 64, step: 1 },
    { key: 'innerRatio', label: 'Rayon intérieur', type: 'num', min: 0, max: 100, unit: '%', step: 0.5 },
    { key: 'fillOn', label: 'Remplissage', type: 'bool' },
    { key: 'fill', label: 'Couleur de fond', type: 'color' },
    { key: 'strokeOn', label: 'Contour', type: 'bool' },
    { key: 'stroke', label: 'Couleur du contour', type: 'color' },
    { key: 'strokeWidth', label: 'Épaisseur du contour', type: 'num', min: 0, step: 0.25, unit: 'px' },
    { key: 'dash', label: 'Pointillés', type: 'num', min: 0, step: 0.5, unit: 'px' },
    { key: 'trimStart', label: 'Raccorder : début', type: 'num', min: 0, max: 100, unit: '%', step: 0.5 },
    { key: 'trimEnd', label: 'Raccorder : fin', type: 'num', min: 0, max: 100, unit: '%', step: 0.5 },
    { key: 'trimOffset', label: 'Raccorder : décalage', type: 'num', unit: '°', step: 1 },
    { key: 'copies', label: 'Répéteur : copies', type: 'num', min: 1, max: 200, step: 1 },
    { key: 'repOffset', label: 'Répéteur : position', type: 'vec2', step: 1 },
    { key: 'repRotation', label: 'Répéteur : rotation', type: 'num', unit: '°', step: 0.5 },
    { key: 'repScale', label: 'Répéteur : échelle', type: 'num', unit: '%', step: 0.5 },
    { key: 'repFade', label: 'Répéteur : opacité finale', type: 'num', min: 0, max: 100, unit: '%', step: 1 },
  ],
  particles: [
    { key: 'emitter', label: "Position de l'émetteur", type: 'vec2', step: 1 },
    { key: 'emitSize', label: "Taille de l'émetteur", type: 'vec2', step: 1, min: 0 },
    { key: 'rate', label: 'Particules / seconde', type: 'num', min: 0, max: 5000, step: 1 },
    { key: 'life', label: 'Durée de vie', type: 'num', min: 0.05, max: 20, step: 0.05, unit: 's' },
    { key: 'speed', label: 'Vitesse', type: 'num', min: 0, step: 1 },
    { key: 'direction', label: 'Direction', type: 'num', unit: '°', step: 1 },
    { key: 'spread', label: 'Dispersion', type: 'num', min: 0, max: 360, unit: '°', step: 1 },
    { key: 'gravity', label: 'Gravité', type: 'num', step: 1 },
    { key: 'turbulence', label: 'Turbulence', type: 'num', min: 0, step: 1 },
    { key: 'sizeStart', label: 'Taille à la naissance', type: 'num', min: 0, step: 0.5 },
    { key: 'sizeEnd', label: 'Taille à la mort', type: 'num', min: 0, step: 0.5 },
    { key: 'colorStart', label: 'Couleur à la naissance', type: 'color' },
    { key: 'colorEnd', label: 'Couleur à la mort', type: 'color' },
    { key: 'opacity', label: 'Opacité des particules', type: 'num', min: 0, max: 100, unit: '%', step: 1 },
    { key: 'softness', label: 'Douceur', type: 'num', min: 0, max: 100, unit: '%', step: 1 },
    { key: 'additive', label: 'Fusion lumineuse', type: 'bool' },
    { key: 'seed', label: 'Graine aléatoire', type: 'num', step: 1 },
  ],
  audio: [],
};

export const AUDIO_DEFS = [{ key: 'level', label: 'Niveau audio', type: 'num', unit: 'dB', min: -60, max: 12, step: 0.1 }];

// ---------- Effets ----------
// Les shaders correspondants sont dans gl.js. `pad` : marge (px du calque) que l'effet peut déborder.

export const EFFECTS = {
  blur: {
    name: 'Flou gaussien', cat: 'Flou et netteté',
    params: [{ key: 'amount', label: 'Flou', type: 'num', min: 0, max: 500, step: 0.5, v: 10 }, { key: 'dir', label: 'Direction', type: 'select', options: [['both', 'Horizontale et verticale'], ['h', 'Horizontale'], ['v', 'Verticale']], v: 'both' }, { key: 'repeat', label: 'Répéter les pixels du bord', type: 'bool', v: false }],
    pad: (p) => (p.repeat ? 0 : p.amount * 1.5),
  },
  dirblur: {
    name: 'Flou directionnel', cat: 'Flou et netteté',
    params: [{ key: 'angle', label: 'Direction', type: 'num', unit: '°', step: 1, v: 0 }, { key: 'length', label: 'Longueur', type: 'num', min: 0, max: 1000, step: 0.5, v: 30 }],
    pad: (p) => p.length,
  },
  radialblur: {
    name: 'Flou radial (zoom)', cat: 'Flou et netteté',
    params: [{ key: 'amount', label: 'Intensité', type: 'num', min: 0, max: 100, step: 0.5, v: 20 }, { key: 'center', label: 'Centre (%)', type: 'vec2', step: 0.5, v: [50, 50] }, { key: 'spin', label: 'Rotation', type: 'bool', v: false }],
    pad: () => 0,
  },
  sharpen: {
    name: 'Accentuation', cat: 'Flou et netteté',
    params: [{ key: 'amount', label: 'Intensité', type: 'num', min: 0, max: 500, step: 1, v: 50 }],
    pad: () => 0,
  },
  glow: {
    name: 'Lueur', cat: 'Stylisation',
    params: [{ key: 'threshold', label: 'Seuil', type: 'num', min: 0, max: 100, unit: '%', step: 0.5, v: 55 }, { key: 'radius', label: 'Rayon', type: 'num', min: 0, max: 500, step: 0.5, v: 30 }, { key: 'intensity', label: 'Intensité', type: 'num', min: 0, max: 10, step: 0.05, v: 1.5 }, { key: 'tint', label: 'Teinte de la lueur', type: 'color', v: '#ffffff' }, { key: 'useTint', label: 'Colorer la lueur', type: 'bool', v: false }],
    pad: (p) => p.radius * 2,
  },
  shadow: {
    name: 'Ombre portée', cat: 'Perspective',
    params: [{ key: 'color', label: 'Couleur', type: 'color', v: '#000000' }, { key: 'opacity', label: 'Opacité', type: 'num', min: 0, max: 100, unit: '%', step: 1, v: 60 }, { key: 'angle', label: 'Direction', type: 'num', unit: '°', step: 1, v: 135 }, { key: 'distance', label: 'Distance', type: 'num', min: 0, step: 0.5, v: 12 }, { key: 'softness', label: 'Adoucissement', type: 'num', min: 0, max: 300, step: 0.5, v: 18 }],
    pad: (p) => p.distance + p.softness * 1.5,
  },
  color: {
    name: 'Correction colorimétrique', cat: 'Couleur',
    params: [{ key: 'exposure', label: 'Exposition', type: 'num', min: -5, max: 5, step: 0.01, v: 0 }, { key: 'brightness', label: 'Luminosité', type: 'num', min: -100, max: 100, step: 0.5, v: 0 }, { key: 'contrast', label: 'Contraste', type: 'num', min: -100, max: 100, step: 0.5, v: 0 }, { key: 'saturation', label: 'Saturation', type: 'num', min: -100, max: 100, step: 0.5, v: 0 }, { key: 'hue', label: 'Teinte', type: 'num', unit: '°', step: 1, v: 0 }, { key: 'gamma', label: 'Gamma', type: 'num', min: 0.1, max: 4, step: 0.01, v: 1 }, { key: 'temperature', label: 'Température', type: 'num', min: -100, max: 100, step: 0.5, v: 0 }],
    pad: () => 0,
  },
  tint: {
    name: 'Teinte (bichromie)', cat: 'Couleur',
    params: [{ key: 'black', label: 'Noirs vers', type: 'color', v: '#1a1440' }, { key: 'white', label: 'Blancs vers', type: 'color', v: '#ffd28a' }, { key: 'amount', label: 'Intensité', type: 'num', min: 0, max: 100, unit: '%', step: 1, v: 100 }],
    pad: () => 0,
  },
  fill: {
    name: 'Remplissage', cat: 'Générer',
    params: [{ key: 'color', label: 'Couleur', type: 'color', v: '#ff3b6b' }, { key: 'opacity', label: 'Opacité', type: 'num', min: 0, max: 100, unit: '%', step: 1, v: 100 }],
    pad: () => 0,
  },
  ramp: {
    name: 'Dégradé', cat: 'Générer',
    params: [{ key: 'type', label: 'Forme', type: 'select', options: [['linear', 'Linéaire'], ['radial', 'Radial']], v: 'linear' }, { key: 'start', label: 'Début (%)', type: 'vec2', step: 0.5, v: [50, 0] }, { key: 'c1', label: 'Couleur de début', type: 'color', v: '#3db5ff' }, { key: 'end', label: 'Fin (%)', type: 'vec2', step: 0.5, v: [50, 100] }, { key: 'c2', label: 'Couleur de fin', type: 'color', v: '#f455d8' }, { key: 'blend', label: "Mélange avec l'original", type: 'num', min: 0, max: 100, unit: '%', step: 1, v: 0 }],
    pad: () => 0,
  },
  invert: { name: 'Négatif', cat: 'Couleur', params: [{ key: 'amount', label: 'Intensité', type: 'num', min: 0, max: 100, unit: '%', step: 1, v: 100 }], pad: () => 0 },
  posterize: { name: 'Isohélie', cat: 'Stylisation', params: [{ key: 'levels', label: 'Niveaux', type: 'num', min: 2, max: 64, step: 1, v: 6 }], pad: () => 0 },
  threshold: { name: 'Seuil', cat: 'Stylisation', params: [{ key: 'level', label: 'Niveau', type: 'num', min: 0, max: 100, unit: '%', step: 0.5, v: 50 }], pad: () => 0 },
  chromakey: {
    name: 'Incrustation (fond vert)', cat: 'Incrustation',
    params: [{ key: 'key', label: 'Couleur clé', type: 'color', v: '#00ff00' }, { key: 'tolerance', label: 'Tolérance', type: 'num', min: 0, max: 100, unit: '%', step: 0.5, v: 30 }, { key: 'softness', label: 'Adoucissement', type: 'num', min: 0, max: 100, unit: '%', step: 0.5, v: 12 }, { key: 'spill', label: 'Suppression du débordement', type: 'num', min: 0, max: 100, unit: '%', step: 1, v: 60 }],
    pad: () => 0,
  },
  lumakey: {
    name: 'Incrustation par luminance', cat: 'Incrustation',
    params: [{ key: 'threshold', label: 'Seuil', type: 'num', min: 0, max: 100, unit: '%', step: 0.5, v: 15 }, { key: 'softness', label: 'Adoucissement', type: 'num', min: 0, max: 100, unit: '%', step: 0.5, v: 10 }, { key: 'invert', label: 'Retirer les zones claires', type: 'bool', v: false }],
    pad: () => 0,
  },
  chromatic: {
    name: 'Aberration chromatique', cat: 'Stylisation',
    params: [{ key: 'amount', label: 'Décalage', type: 'num', min: 0, max: 200, step: 0.25, v: 6 }, { key: 'angle', label: 'Direction', type: 'num', unit: '°', step: 1, v: 0 }, { key: 'radial', label: 'Radial (lentille)', type: 'bool', v: true }],
    pad: (p) => p.amount,
  },
  glitch: {
    name: 'Glitch numérique', cat: 'Stylisation',
    params: [{ key: 'amount', label: 'Intensité', type: 'num', min: 0, max: 100, step: 0.5, v: 40 }, { key: 'blocks', label: 'Taille des bandes', type: 'num', min: 1, max: 200, step: 1, v: 24 }, { key: 'speed', label: 'Vitesse', type: 'num', min: 0, max: 60, step: 0.5, v: 12 }, { key: 'rgb', label: 'Séparation RVB', type: 'num', min: 0, max: 100, step: 0.5, v: 10 }],
    pad: (p) => p.amount,
  },
  wave: {
    name: 'Ondulation', cat: 'Déformation',
    params: [{ key: 'amplitude', label: 'Amplitude', type: 'num', min: 0, max: 500, step: 0.5, v: 12 }, { key: 'wavelength', label: "Longueur d'onde", type: 'num', min: 1, max: 2000, step: 1, v: 120 }, { key: 'speed', label: 'Vitesse (cycles/s)', type: 'num', step: 0.05, v: 1 }, { key: 'angle', label: 'Direction', type: 'num', unit: '°', step: 1, v: 90 }],
    pad: (p) => p.amplitude,
  },
  turbulent: {
    name: 'Déplacement turbulent', cat: 'Déformation',
    params: [{ key: 'amount', label: 'Intensité', type: 'num', min: 0, max: 500, step: 0.5, v: 25 }, { key: 'size', label: 'Taille', type: 'num', min: 1, max: 2000, step: 1, v: 140 }, { key: 'evolution', label: 'Évolution (tours/s)', type: 'num', step: 0.05, v: 0.5 }],
    pad: (p) => p.amount,
  },
  twirl: {
    name: 'Tourbillon', cat: 'Déformation',
    params: [{ key: 'angle', label: 'Angle', type: 'num', unit: '°', step: 1, v: 180 }, { key: 'radius', label: 'Rayon (%)', type: 'num', min: 1, max: 200, step: 0.5, v: 50 }, { key: 'center', label: 'Centre (%)', type: 'vec2', step: 0.5, v: [50, 50] }],
    pad: () => 0,
  },
  bulge: {
    name: 'Renflement', cat: 'Déformation',
    params: [{ key: 'amount', label: 'Intensité', type: 'num', min: -100, max: 100, step: 0.5, v: 50 }, { key: 'radius', label: 'Rayon (%)', type: 'num', min: 1, max: 200, step: 0.5, v: 40 }, { key: 'center', label: 'Centre (%)', type: 'vec2', step: 0.5, v: [50, 50] }],
    pad: () => 0,
  },
  mirror: {
    name: 'Miroir', cat: 'Déformation',
    params: [{ key: 'axis', label: 'Axe', type: 'select', options: [['x', 'Vertical (gauche → droite)'], ['y', 'Horizontal (haut → bas)'], ['xy', 'Les deux (kaléidoscope)']], v: 'x' }],
    pad: () => 0,
  },
  tile: {
    name: 'Répétition de motif', cat: 'Stylisation',
    params: [{ key: 'tiles', label: 'Répétitions', type: 'vec2', step: 0.1, v: [3, 3] }, { key: 'mirrorEdges', label: 'Bords en miroir', type: 'bool', v: false }],
    pad: () => 0,
  },
  pixelate: { name: 'Mosaïque', cat: 'Stylisation', params: [{ key: 'size', label: 'Taille des blocs', type: 'num', min: 1, max: 400, step: 0.5, v: 16 }], pad: () => 0 },
  noise: {
    name: 'Grain', cat: 'Bruit',
    params: [{ key: 'amount', label: 'Quantité', type: 'num', min: 0, max: 100, step: 0.5, v: 18 }, { key: 'size', label: 'Taille', type: 'num', min: 0.5, max: 10, step: 0.1, v: 1.2 }, { key: 'color', label: 'Grain coloré', type: 'bool', v: false }, { key: 'animated', label: 'Animé', type: 'bool', v: true }],
    pad: () => 0,
  },
  vignette: {
    name: 'Vignetage', cat: 'Couleur',
    params: [{ key: 'amount', label: 'Intensité', type: 'num', min: -100, max: 100, step: 0.5, v: 45 }, { key: 'size', label: 'Taille', type: 'num', min: 0, max: 100, step: 0.5, v: 55 }, { key: 'softness', label: 'Douceur', type: 'num', min: 1, max: 100, step: 0.5, v: 60 }],
    pad: () => 0,
  },
  scanlines: {
    name: 'Lignes vidéo (VHS)', cat: 'Stylisation',
    params: [{ key: 'amount', label: 'Intensité', type: 'num', min: 0, max: 100, step: 0.5, v: 35 }, { key: 'spacing', label: 'Espacement', type: 'num', min: 1, max: 40, step: 0.5, v: 4 }, { key: 'roll', label: 'Défilement', type: 'num', step: 1, v: 30 }],
    pad: () => 0,
  },
  wipe: {
    name: 'Transition : balayage linéaire', cat: 'Transition',
    params: [{ key: 'completion', label: 'Achèvement', type: 'num', min: 0, max: 100, unit: '%', step: 0.5, v: 0 }, { key: 'angle', label: 'Angle', type: 'num', unit: '°', step: 1, v: 90 }, { key: 'feather', label: 'Contour progressif', type: 'num', min: 0, max: 1000, step: 1, v: 40 }],
    pad: () => 0,
  },
  radialwipe: {
    name: 'Transition : balayage radial', cat: 'Transition',
    params: [{ key: 'completion', label: 'Achèvement', type: 'num', min: 0, max: 100, unit: '%', step: 0.5, v: 0 }, { key: 'start', label: 'Angle de départ', type: 'num', unit: '°', step: 1, v: 0 }, { key: 'feather', label: 'Contour progressif', type: 'num', min: 0, max: 90, unit: '°', step: 0.5, v: 4 }],
    pad: () => 0,
  },
  iris: {
    name: 'Transition : iris', cat: 'Transition',
    params: [{ key: 'completion', label: 'Achèvement', type: 'num', min: 0, max: 100, unit: '%', step: 0.5, v: 0 }, { key: 'center', label: 'Centre (%)', type: 'vec2', step: 0.5, v: [50, 50] }, { key: 'feather', label: 'Contour progressif', type: 'num', min: 0, max: 500, step: 1, v: 20 }],
    pad: () => 0,
  },
  venetian: {
    name: 'Transition : stores vénitiens', cat: 'Transition',
    params: [{ key: 'completion', label: 'Achèvement', type: 'num', min: 0, max: 100, unit: '%', step: 0.5, v: 0 }, { key: 'width', label: 'Largeur', type: 'num', min: 2, max: 500, step: 1, v: 40 }, { key: 'angle', label: 'Angle', type: 'num', unit: '°', step: 1, v: 0 }],
    pad: () => 0,
  },
};

export const EFFECT_CATS = [...new Set(Object.values(EFFECTS).map((e) => e.cat))];

export function makeEffect(type) {
  const def = EFFECTS[type];
  const p = {};
  for (const prm of def.params) p[prm.key] = P(clone(prm.v));
  return { id: mid('fx'), type, on: true, p };
}

// ---------- Masques ----------

export const MASK_MODES = [['add', 'Addition'], ['subtract', 'Soustraction'], ['intersect', 'Intersection'], ['none', 'Aucun']];
export const MASK_DEFS = [
  { key: 'box', label: 'Rectangle du masque', type: 'vec4', step: 1, onlyBox: true },
  { key: 'feather', label: 'Contour progressif', type: 'num', min: 0, step: 0.5, unit: 'px' },
  { key: 'opacity', label: 'Opacité du masque', type: 'num', min: 0, max: 100, unit: '%', step: 1 },
  { key: 'expansion', label: 'Expansion', type: 'num', step: 0.5, unit: 'px' },
  { key: 'offset', label: 'Décalage du tracé', type: 'vec2', step: 1 },
];

// kind : 'rect' | 'ellipse' (rectangle englobant animable « box ») ou 'poly' (points du tracé).
export function makeMask(kind, data, name = 'Masque') {
  const m = { id: mid('mk'), name, kind, mode: 'add', inverted: false, p: { feather: P(0), opacity: P(100), expansion: P(0), offset: P([0, 0]) } };
  if (kind === 'poly') m.points = data;
  else m.p.box = P(data);
  return m;
}

// ---------- Calques ----------

export const LAYER_TYPES = {
  solid: { label: 'Solide', icon: 'square' },
  image: { label: 'Image', icon: 'image' },
  video: { label: 'Vidéo', icon: 'film' },
  audio: { label: 'Audio', icon: 'music' },
  text: { label: 'Texte', icon: 'text' },
  shape: { label: 'Forme', icon: 'shapes' },
  null: { label: 'Objet nul', icon: 'null' },
  adjust: { label: "Calque d'effets", icon: 'sliders' },
  comp: { label: 'Composition', icon: 'comp' },
  particles: { label: 'Particules', icon: 'sparkles' },
};

// Couleur d'étiquette par défaut selon le type de calque (comme After Effects).
const TYPE_LABELS = { solid: '#e05252', image: '#7b5cff', video: '#52a3e0', audio: '#7bd552', text: '#e0a352', shape: '#52d5c0', null: '#9a9aae', adjust: '#c452e0', comp: '#e0d552', particles: '#e052a3' };

const CONTENT_DEFAULTS = {
  solid: (c) => ({ color: '#7b5cff', size: [c.width, c.height] }),
  text: () => ({ text: 'Votre titre', font: FONT_LIST[0], weight: '700', align: 'center', fontSize: 120, fill: '#ffffff', strokeWidth: 0, stroke: '#000000', tracking: 0, leading: 1.15, animator: 'none', reveal: 100, spread: 30 }),
  shape: () => ({ shape: 'rect', size: [400, 260], roundness: 0, points: 5, innerRatio: 45, fillOn: true, fill: '#3db5ff', strokeOn: false, stroke: '#ffffff', strokeWidth: 8, dash: 0, trimStart: 0, trimEnd: 100, trimOffset: 0, copies: 1, repOffset: [0, 0], repRotation: 0, repScale: 100, repFade: 100 }),
  particles: (c) => ({ emitter: [c.width / 2, c.height / 2], emitSize: [40, 40], rate: 120, life: 2.5, speed: 260, direction: -90, spread: 70, gravity: 180, turbulence: 30, sizeStart: 14, sizeEnd: 2, colorStart: '#ffd28a', colorEnd: '#f455d8', opacity: 90, softness: 70, additive: true, seed: 1 }),
};

export function makeLayer(comp, type, opts = {}) {
  const W = comp.width, H = comp.height;
  const layer = {
    id: mid('ly'), type, name: opts.name || LAYER_TYPES[type]?.label || 'Calque',
    in: opts.in ?? 0, out: opts.out ?? comp.duration, start: opts.start ?? opts.in ?? 0, speed: 1,
    visible: true, solo: false, locked: false, shy: false, audio: true, label: opts.label ?? TYPE_LABELS[type] ?? LABEL_COLORS[0],
    parent: null, blend: 'normal', threeD: false, motionBlur: false, matte: '', source: opts.source || null,
    p: {}, effects: [], masks: [], open: false,
  };
  const content = CONTENT_DEFAULTS[type]?.(comp) || {};
  for (const [k, v] of Object.entries({ ...content, ...(opts.content || {}) })) layer.p[`c.${k}`] = P(v);
  // Taille de la source (unités du calque)
  const sw = opts.w ?? (type === 'solid' ? content.size[0] : type === 'null' ? 100 : W);
  const sh = opts.h ?? (type === 'solid' ? content.size[1] : type === 'null' ? 100 : H);
  const centered = type === 'text' || type === 'shape';
  layer.p.anchor = P(centered ? [0, 0] : [sw / 2, sh / 2]);
  layer.p.position = P([W / 2, H / 2]);
  layer.p.posZ = P(0);
  layer.p.scale = P([100, 100]);
  layer.p.rotX = P(0);
  layer.p.rotY = P(0);
  layer.p.rotation = P(0);
  layer.p.opacity = P(100);
  if (type === 'video' || type === 'audio' || type === 'comp') layer.p['au.level'] = P(0);
  if (type === 'particles') {
    layer.p.anchor = P([W / 2, H / 2]);
  }
  if (opts.fit && sw && sh) {
    const s = Math.min(W / sw, H / sh) * 100;
    if (s < 100) layer.p.scale = P([s, s]);
  }
  return layer;
}

export function makeComp(opts = {}) {
  return {
    id: mid('cp'), name: opts.name || 'Composition 1', width: opts.width || 1920, height: opts.height || 1080,
    fps: opts.fps || 30, duration: opts.duration || 10, bg: opts.bg || '#000000', layers: [],
    workIn: 0, workOut: opts.duration || 10, motionBlur: true, shutter: 180, mbSamples: 8,
  };
}

export function makeProject() {
  const comp = makeComp();
  return { version: MOTION_VERSION, app: 'Prisme Motion', name: 'Projet sans titre', comps: [comp], assets: [], active: comp.id };
}

export const COMP_PRESETS = [
  ['1920x1080x30', 'HD 1080p · 1920×1080 · 30 i/s'], ['1920x1080x60', 'HD 1080p · 1920×1080 · 60 i/s'], ['1920x1080x25', 'HD 1080p · 1920×1080 · 25 i/s'],
  ['3840x2160x30', '4K UHD · 3840×2160 · 30 i/s'], ['1280x720x30', 'HD 720p · 1280×720 · 30 i/s'],
  ['1080x1920x30', 'Story / Reel / TikTok · 1080×1920'], ['1080x1080x30', 'Carré Instagram · 1080×1080'], ['1080x1350x30', 'Portrait Instagram · 1080×1350'],
  ['2560x1080x24', 'Cinéma 21:9 · 2560×1080 · 24 i/s'], ['512x512x30', 'Sticker / GIF · 512×512'],
];

// Durée totale d'une image en secondes.
export const frameDur = (comp) => 1 / comp.fps;
export const snapTime = (comp, t) => Math.round(t * comp.fps) / comp.fps;

export function timecode(t, fps, mode = 'tc') {
  const f = Math.round(t * fps);
  if (mode === 'frames') return String(f);
  const ff = f % Math.round(fps);
  const s = Math.floor(f / Math.round(fps));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

export function parseTimecode(str, fps) {
  const s = String(str).trim();
  if (/^\d+$/.test(s)) return Number(s) / fps;
  if (/^[\d.]+s$/.test(s)) return parseFloat(s);
  const parts = s.split(/[:;.]/).map(Number);
  if (parts.some((x) => Number.isNaN(x))) return null;
  while (parts.length < 4) parts.unshift(0);
  const [h, m, sec, fr] = parts;
  return h * 3600 + m * 60 + sec + fr / fps;
}

// ---------- Parcours des propriétés d'un calque (pour l'interface et le rendu) ----------

export function layerGroups(layer) {
  const groups = [];
  const content = CONTENT_DEFS[layer.type];
  if (content && content.length) groups.push({ id: 'content', label: layer.type === 'text' ? 'Texte' : layer.type === 'shape' ? 'Contenu' : layer.type === 'particles' ? 'Émetteur' : 'Source', props: content.map((d) => ({ ...d, key: `c.${d.key}`, def: d })) });
  if (layer.masks.length) {
    for (const m of layer.masks) groups.push({ id: `mask:${m.id}`, mask: m, label: m.name, props: MASK_DEFS.filter((d) => !d.onlyBox || m.p.box).map((d) => ({ ...d, owner: m, def: d })) });
  }
  for (const fx of layer.effects) {
    const def = EFFECTS[fx.type];
    if (!def) continue;
    groups.push({ id: `fx:${fx.id}`, effect: fx, label: def.name, props: def.params.map((d) => ({ ...d, owner: fx, def: d })) });
  }
  groups.push({ id: 'transform', label: 'Transformer', props: TRANSFORM_DEFS.filter((d) => !d.only3d || layer.threeD).map((d) => ({ ...d, def: d })) });
  if (layer.p['au.level']) groups.push({ id: 'audio', label: 'Audio', props: AUDIO_DEFS.map((d) => ({ ...d, key: `au.${d.key}`, def: d })) });
  return groups;
}

export const propOf = (layer, item) => (item.owner ? item.owner.p[item.def.key] : layer.p[item.key]);

// Liste de toutes les propriétés animées d'un calque (pour l'affichage « U »).
export function allProps(layer) {
  const out = [];
  for (const g of layerGroups(layer)) for (const it of g.props) out.push({ group: g, item: it, prop: propOf(layer, it) });
  return out;
}

// ---------- Recherche dans le projet ----------

export const compById = (project, id) => project.comps.find((c) => c.id === id);
export const assetById = (project, id) => project.assets.find((a) => a.id === id);

export function layerIndex(comp, layer) {
  return comp.layers.indexOf(layer) + 1;
}

// Empêche les boucles de pré-composition (A contient B qui contient A).
export function compContains(project, comp, targetId, depth = 0) {
  if (depth > 32) return true;
  for (const l of comp.layers) {
    if (l.type !== 'comp') continue;
    if (l.source === targetId) return true;
    const c = compById(project, l.source);
    if (c && compContains(project, c, targetId, depth + 1)) return true;
  }
  return false;
}

// Durée de calque visible à l'instant t ?
export const layerActive = (l, t) => t >= l.in - 1e-6 && t < l.out - 1e-6;

// Temps source (vidéo, sous-composition) correspondant au temps de composition.
export const sourceTime = (l, t) => (t - l.start) * (l.speed || 1);

// ---------- Préréglages d'animation ----------

const k = (layer, key, t, v, e = 'ease') => setKey(layer.p[key], t, v, e);

export const PRESETS = [
  { id: 'fadeIn', cat: 'Apparitions', name: 'Fondu entrant', apply: (l, t) => { k(l, 'opacity', t, 0); k(l, 'opacity', t + 0.6, 100); } },
  { id: 'fadeOut', cat: 'Disparitions', name: 'Fondu sortant', apply: (l, t) => { const e = Math.max(t, l.out - 0.6); k(l, 'opacity', e, 100); k(l, 'opacity', l.out - 1 / 60, 0); } },
  { id: 'slideL', cat: 'Apparitions', name: 'Glisser depuis la gauche', apply: (l, t, c) => slide(l, t, c, -1, 0) },
  { id: 'slideR', cat: 'Apparitions', name: 'Glisser depuis la droite', apply: (l, t, c) => slide(l, t, c, 1, 0) },
  { id: 'slideU', cat: 'Apparitions', name: 'Monter depuis le bas', apply: (l, t, c) => slide(l, t, c, 0, 1) },
  { id: 'slideD', cat: 'Apparitions', name: 'Descendre depuis le haut', apply: (l, t, c) => slide(l, t, c, 0, -1) },
  { id: 'popIn', cat: 'Apparitions', name: 'Pop (zoom avec dépassement)', apply: (l, t) => { const s = cur(l, 'scale', t); k(l, 'scale', t, [0, 0], 'back'); k(l, 'scale', t + 0.55, s); k(l, 'opacity', t, 0, 'linear'); k(l, 'opacity', t + 0.2, cur(l, 'opacity', t) || 100); } },
  { id: 'zoomIn', cat: 'Apparitions', name: 'Zoom avant doux', apply: (l, t) => { const s = cur(l, 'scale', t); k(l, 'scale', t, s.map((x) => x * 0.6), 'expo'); k(l, 'scale', t + 0.9, s); k(l, 'opacity', t, 0); k(l, 'opacity', t + 0.5, 100); } },
  { id: 'bounceIn', cat: 'Apparitions', name: 'Chute avec rebond', apply: (l, t, c) => { const p = cur(l, 'position', t); k(l, 'position', t, [p[0], p[1] - c.height * 0.7], 'bounce'); k(l, 'position', t + 1.1, p); } },
  { id: 'spinIn', cat: 'Apparitions', name: 'Rotation entrante', apply: (l, t) => { const r = cur(l, 'rotation', t); k(l, 'rotation', t, r - 180, 'expo'); k(l, 'rotation', t + 0.9, r); const s = cur(l, 'scale', t); k(l, 'scale', t, [0, 0], 'expo'); k(l, 'scale', t + 0.9, s); } },
  { id: 'blurIn', cat: 'Apparitions', name: 'Mise au point (flou → net)', apply: (l, t) => { let fx = l.effects.find((f) => f.type === 'blur'); if (!fx) { fx = makeEffect('blur'); l.effects.push(fx); } setKey(fx.p.amount, t, 60, 'ease'); setKey(fx.p.amount, t + 0.8, 0); k(l, 'opacity', t, 0); k(l, 'opacity', t + 0.5, 100); } },
  { id: 'wipeIn', cat: 'Apparitions', name: 'Révélation par balayage', apply: (l, t) => { const fx = makeEffect('wipe'); l.effects.push(fx); setKey(fx.p.completion, t, 100, 'expo'); setKey(fx.p.completion, t + 1, 0); } },
  { id: 'irisIn', cat: 'Apparitions', name: 'Ouverture en iris', apply: (l, t) => { const fx = makeEffect('iris'); l.effects.push(fx); setKey(fx.p.completion, t, 100, 'ease'); setKey(fx.p.completion, t + 0.9, 0); } },
  { id: 'typewriter', cat: 'Texte', name: 'Machine à écrire', only: 'text', apply: (l, t) => { l.p['c.animator'].v = 'type'; setKey(l.p['c.reveal'], t, 0, 'linear'); setKey(l.p['c.reveal'], t + Math.max(0.6, String(l.p['c.text'].v).length * 0.05), 100); } },
  { id: 'textRise', cat: 'Texte', name: 'Lettres qui montent', only: 'text', apply: (l, t) => { l.p['c.animator'].v = 'rise'; setKey(l.p['c.reveal'], t, 0, 'easeOut'); setKey(l.p['c.reveal'], t + 1.2, 100); } },
  { id: 'textPop', cat: 'Texte', name: 'Lettres en pop', only: 'text', apply: (l, t) => { l.p['c.animator'].v = 'pop'; setKey(l.p['c.reveal'], t, 0, 'linear'); setKey(l.p['c.reveal'], t + 1, 100); } },
  { id: 'textBlur', cat: 'Texte', name: 'Lettres floues → nettes', only: 'text', apply: (l, t) => { l.p['c.animator'].v = 'blur'; setKey(l.p['c.reveal'], t, 0, 'easeOut'); setKey(l.p['c.reveal'], t + 1.2, 100); } },
  { id: 'textWave', cat: 'Texte', name: 'Vague continue', only: 'text', apply: (l) => { l.p['c.animator'].v = 'wave'; l.p['c.reveal'].v = 100; } },
  { id: 'drawOn', cat: 'Formes', name: 'Tracé dessiné (raccorder)', only: 'shape', apply: (l, t) => { l.p['c.strokeOn'].v = true; l.p['c.fillOn'].v = false; setKey(l.p['c.trimEnd'], t, 0, 'ease'); setKey(l.p['c.trimEnd'], t + 1.2, 100); } },
  { id: 'shake', cat: 'Boucles', name: 'Secousse (wiggle)', apply: (l) => { l.p.position.x = 'wiggle(12, 18)'; } },
  { id: 'float', cat: 'Boucles', name: 'Flottement doux', apply: (l) => { l.p.position.x = 'wiggle(0.6, 22, 2)'; l.p.rotation.x = 'wiggle(0.4, 3)'; } },
  { id: 'pulse', cat: 'Boucles', name: 'Pulsation', apply: (l) => { l.p.scale.x = 'mul(value, 1 + 0.06 * Math.sin(time * Math.PI * 2 * 1.2))'; } },
  { id: 'spin', cat: 'Boucles', name: 'Rotation continue', apply: (l) => { l.p.rotation.x = 'value + time * 90'; } },
  { id: 'blink', cat: 'Boucles', name: 'Clignotement', apply: (l) => { l.p.opacity.x = 'Math.floor(time * 4) % 2 ? value : 0'; } },
  { id: 'swing', cat: 'Boucles', name: 'Balancier', apply: (l) => { l.p.rotation.x = 'value + 12 * Math.sin(time * Math.PI * 1.5)'; } },
  { id: 'glitchLoop', cat: 'Boucles', name: 'Glitch intermittent', apply: (l) => { const fx = makeEffect('glitch'); fx.p.amount.x = 'Math.sin(time * 7) > 0.85 ? 60 : 0'; l.effects.push(fx); } },
  { id: 'kenburns', cat: 'Caméra', name: 'Ken Burns (zoom lent)', apply: (l, t) => { const s = cur(l, 'scale', t); k(l, 'scale', l.in, s, 'linear'); k(l, 'scale', l.out - 1 / 60, s.map((x) => x * 1.15)); } },
  { id: 'camShake', cat: 'Caméra', name: 'Caméra à l’épaule', apply: (l) => { l.p.position.x = 'wiggle(1.5, 10, 3)'; l.p.rotation.x = 'wiggle(1, 0.6)'; } },
  { id: 'scaleOut', cat: 'Disparitions', name: 'Zoom sortant', apply: (l) => { const e = Math.max(l.in, l.out - 0.6); const s = cur(l, 'scale', e); k(l, 'scale', e, s, 'easeIn'); k(l, 'scale', l.out - 1 / 60, [0, 0]); } },
  { id: 'slideOutR', cat: 'Disparitions', name: 'Sortie vers la droite', apply: (l, t, c) => { const e = Math.max(l.in, l.out - 0.7); const p = cur(l, 'position', e); k(l, 'position', e, p, 'easeIn'); k(l, 'position', l.out - 1 / 60, [p[0] + c.width, p[1]]); } },
];

function cur(l, key, t) {
  return clone(keyedValue(l.p[key], t));
}

function slide(l, t, c, dx, dy) {
  const p = cur(l, 'position', t);
  k(l, 'position', t, [p[0] + dx * c.width * 0.6, p[1] + dy * c.height * 0.6], 'expo');
  k(l, 'position', t + 0.9, p);
  k(l, 'opacity', t, 0, 'ease');
  k(l, 'opacity', t + 0.5, cur(l, 'opacity', t) || 100);
}

// ---------- Sérialisation ----------

// Copie profonde sans les champs d'exécution (commençant par « __ »).
export function serialize(project) {
  return JSON.stringify(project, (key, value) => (key.startsWith('__') || key === 'blob' || key === 'url' ? undefined : value));
}

export function deserialize(json) {
  const p = typeof json === 'string' ? JSON.parse(json) : json;
  if (!p || p.app !== 'Prisme Motion' || !Array.isArray(p.comps)) throw new Error('Projet Motion invalide');
  return p;
}
