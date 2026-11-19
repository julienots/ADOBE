// Prisme Motion — moteur graphique WebGL 2.
//
// Toute la composition se fait sur la carte graphique : textures en alpha prémultiplié,
// tampons de rendu recyclés (pool), effets en shaders GLSL, flous à résolution réduite pour les
// grands rayons, particules instanciées. Convention interne : v = 0 correspond au HAUT de l'image
// (ligne 0 en mémoire) ; seul l'affichage final retourne l'image.

import { hexToArr } from './model.js';

const VS_QUAD = `#version 300 es
in vec2 a_pos;
uniform mat4 u_mvp;
uniform vec4 u_box;
uniform vec4 u_uv;
out vec2 v_uv;
void main() {
  v_uv = u_uv.xy + a_pos * u_uv.zw;
  gl_Position = u_mvp * vec4(u_box.xy + a_pos * u_box.zw, 0.0, 1.0);
}`;

const VS_FULL = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_LAYER = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform sampler2D u_mask;
uniform int u_useMask;
uniform int u_useColor;
uniform vec4 u_color;
uniform float u_opacity;
in vec2 v_uv;
out vec4 o;
void main() {
  vec4 c = u_useColor == 1 ? u_color : texture(u_tex, v_uv);
  if (u_useMask == 1) c *= texture(u_mask, v_uv).a;
  o = c * u_opacity;
}`;

const FS_PRESENT = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec4 u_bg;
uniform int u_flip;
in vec2 v_uv;
out vec4 o;
void main() {
  vec2 uv = u_flip == 1 ? vec2(v_uv.x, 1.0 - v_uv.y) : v_uv;
  vec4 c = texture(u_tex, uv);
  o = c + u_bg * (1.0 - c.a);
}`;

// Modes de fusion (formules W3C Compositing, couleurs non prémultipliées).
const FS_BLEND = `#version 300 es
precision highp float;
uniform sampler2D u_dst;
uniform sampler2D u_src;
uniform int u_mode;
uniform float u_opacity;
in vec2 v_uv;
out vec4 o;
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c), n = min(min(c.r, c.g), c.b), x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-5);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-5);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mn = min(min(c.r, c.g), c.b), mx = max(max(c.r, c.g), c.b);
  return mx > mn ? (c - mn) * s / (mx - mn) : vec3(0.0);
}
float softl(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
vec3 blendf(vec3 b, vec3 s) {
  if (u_mode == 1) return min(b + s, 1.0);
  if (u_mode == 2) return b + s - b * s;
  if (u_mode == 3) return max(b, s);
  if (u_mode == 4) return vec3(b.r == 0.0 ? 0.0 : s.r >= 1.0 ? 1.0 : min(1.0, b.r / (1.0 - s.r)), b.g == 0.0 ? 0.0 : s.g >= 1.0 ? 1.0 : min(1.0, b.g / (1.0 - s.g)), b.b == 0.0 ? 0.0 : s.b >= 1.0 ? 1.0 : min(1.0, b.b / (1.0 - s.b)));
  if (u_mode == 5) return b * s;
  if (u_mode == 6) return min(b, s);
  if (u_mode == 7) return vec3(b.r >= 1.0 ? 1.0 : s.r <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b.r) / s.r), b.g >= 1.0 ? 1.0 : s.g <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b.g) / s.g), b.b >= 1.0 ? 1.0 : s.b <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b.b) / s.b));
  if (u_mode == 8) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (u_mode == 9) return vec3(softl(b.r, s.r), softl(b.g, s.g), softl(b.b, s.b));
  if (u_mode == 10) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, s));
  if (u_mode == 11) return abs(b - s);
  if (u_mode == 12) return b + s - 2.0 * b * s;
  if (u_mode == 13) return max(b - s, 0.0);
  if (u_mode == 14) return setLum(setSat(s, sat(b)), lum(b));
  if (u_mode == 15) return setLum(setSat(b, sat(s)), lum(b));
  if (u_mode == 16) return setLum(s, lum(b));
  if (u_mode == 17) return setLum(b, lum(s));
  return s;
}
void main() {
  vec4 d = texture(u_dst, v_uv);
  vec4 s = texture(u_src, v_uv) * u_opacity;
  if (s.a <= 0.0) { o = d; return; }
  vec3 Cb = d.a > 0.0 ? d.rgb / d.a : vec3(0.0);
  vec3 Cs = s.rgb / s.a;
  vec3 B = clamp(blendf(Cb, Cs), 0.0, 1.0);
  vec3 c = s.rgb * (1.0 - d.a) + d.rgb * (1.0 - s.a) + s.a * d.a * B;
  o = vec4(c, s.a + d.a * (1.0 - s.a));
}`;

const FS_MATTE = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform sampler2D u_matte;
uniform int u_mode;
in vec2 v_uv;
out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec4 m = texture(u_matte, v_uv);
  float f = u_mode < 2 ? m.a : dot(m.rgb, vec3(0.2126, 0.7152, 0.0722));
  if (u_mode == 1 || u_mode == 3) f = 1.0 - f;
  o = c * f;
}`;

const FS_MIX = `#version 300 es
precision highp float;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_mask;
uniform int u_useMask;
uniform float u_k;
in vec2 v_uv;
out vec4 o;
void main() {
  float k = u_k;
  if (u_useMask == 1) k *= texture(u_mask, v_uv).a;
  o = mix(texture(u_a, v_uv), texture(u_b, v_uv), k);
}`;

// Flou gaussien séparable : u_n échantillons de chaque côté, échantillonnage linéaire.
const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_dir;
uniform float u_sigma;
uniform int u_n;
in vec2 v_uv;
out vec4 o;
void main() {
  vec4 acc = texture(u_tex, v_uv);
  float wsum = 1.0;
  float k = -0.5 / (u_sigma * u_sigma);
  for (int i = 1; i <= 48; i += 2) {
    if (i > u_n) break;
    float w1 = exp(float(i * i) * k), w2 = exp(float((i + 1) * (i + 1)) * k);
    float w = w1 + w2;
    float off = (float(i) * w1 + float(i + 1) * w2) / w;
    acc += (texture(u_tex, v_uv + u_dir * off) + texture(u_tex, v_uv - u_dir * off)) * w;
    wsum += 2.0 * w;
  }
  o = acc / wsum;
}`;

const FS_COPY = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec4 u_uv;
in vec2 v_uv;
out vec4 o;
void main() { o = texture(u_tex, u_uv.xy + v_uv * u_uv.zw); }`;

// Extraction des hautes lumières (lueur) et teinte de l'ombre portée.
const FS_BRIGHT = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_thr;
uniform vec3 u_tint;
uniform int u_useTint;
in vec2 v_uv;
out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 u = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  float l = max(max(u.r, u.g), u.b);
  float k = smoothstep(u_thr, u_thr + 0.15, l);
  vec3 col = u_useTint == 1 ? u_tint * l : u;
  o = vec4(col * c.a * k, c.a * k);
}`;

const FS_ADDGLOW = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform sampler2D u_glow;
uniform float u_int;
in vec2 v_uv;
out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec4 g = texture(u_glow, v_uv) * u_int;
  o = vec4(min(c.rgb + g.rgb, vec3(1.0)), min(1.0, c.a + g.a * (1.0 - c.a)));
}`;

const FS_SHADOW = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_off;
uniform vec4 u_color;
in vec2 v_uv;
out vec4 o;
void main() {
  vec2 uv = v_uv - u_off;
  float a = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? 0.0 : texture(u_tex, uv).a;
  o = vec4(u_color.rgb, 1.0) * a * u_color.a;
}`;

const FS_OVER = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform sampler2D u_under;
in vec2 v_uv;
out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv), u = texture(u_under, v_uv);
  o = c + u * (1.0 - c.a);
}`;

const FS_PARTICLE = `#version 300 es
precision highp float;
uniform float u_soft;
in vec4 v_col;
in vec2 v_q;
out vec4 o;
void main() {
  float d = length(v_q);
  float a = 1.0 - smoothstep(1.0 - max(u_soft, 0.02), 1.0, d);
  o = vec4(v_col.rgb, 1.0) * v_col.a * a;
}`;

const VS_PARTICLE = `#version 300 es
in vec2 a_pos;
in vec4 a_inst;   // x, y, taille, opacité
in vec3 a_col;
uniform vec2 u_size;
uniform mat3 u_m;
out vec4 v_col;
out vec2 v_q;
void main() {
  v_q = a_pos * 2.0 - 1.0;
  vec2 p = (u_m * vec3(a_inst.xy, 1.0)).xy + v_q * a_inst.z * 0.5 * u_m[0][0];
  gl_Position = vec4(p / u_size * 2.0 - 1.0, 0.0, 1.0);
  v_col = vec4(a_col, a_inst.w);
}`;

// ---------- Effets (un passage) ----------

const FX_HEAD = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_size;
uniform float u_ps;
uniform vec4 u_src;
uniform float u_time;
in vec2 v_uv;
out vec4 o;
vec4 T(vec2 uv) { return (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? vec4(0.0) : texture(u_tex, uv); }
vec3 U(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : vec3(0.0); }
vec2 srcPt(vec2 pct) { return u_src.xy + pct / 100.0 * u_src.zw; }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
`;

const FX = {
  dirblur: { u: ['u_vec'], src: `uniform vec2 u_vec;
void main() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 40; i++) { float t = float(i) / 39.0 - 0.5; acc += T(v_uv + u_vec * t); }
  o = acc / 40.0;
}`, set: (v, c) => {
    const a = (v.angle * Math.PI) / 180, L = v.length * c.ps;
    return { u_vec: [(Math.sin(a) * L) / c.w, (-Math.cos(a) * L) / c.h] };
  } },
  radialblur: { u: ['u_c', 'u_amt', 'u_spin'], src: `uniform vec2 u_c; uniform float u_amt; uniform int u_spin;
void main() {
  vec4 acc = vec4(0.0);
  vec2 asp = vec2(u_size.x / u_size.y, 1.0);
  for (int i = 0; i < 32; i++) {
    float t = float(i) / 31.0;
    vec2 uv;
    if (u_spin == 1) {
      float a = (t - 0.5) * u_amt * 0.6;
      vec2 d = (v_uv - u_c) * asp;
      uv = u_c + vec2(d.x * cos(a) - d.y * sin(a), d.x * sin(a) + d.y * cos(a)) / asp;
    } else uv = u_c + (v_uv - u_c) * (1.0 - t * u_amt * 0.5);
    acc += T(uv);
  }
  o = acc / 32.0;
}`, set: (v, c) => ({ u_c: c.pt(v.center), u_amt: v.amount / 100, u_spin: v.spin ? 1 : 0 }) },
  sharpen: { u: ['u_amt'], src: `uniform float u_amt;
void main() {
  vec2 px = 1.0 / u_size;
  vec4 c = texture(u_tex, v_uv);
  vec4 b = (texture(u_tex, v_uv + vec2(px.x, 0)) + texture(u_tex, v_uv - vec2(px.x, 0)) + texture(u_tex, v_uv + vec2(0, px.y)) + texture(u_tex, v_uv - vec2(0, px.y))) * 0.25;
  vec4 r = c + (c - b) * u_amt;
  o = vec4(clamp(r.rgb, 0.0, c.a), c.a);
}`, set: (v) => ({ u_amt: v.amount / 25 }) },
  color: { u: ['u_exp', 'u_bri', 'u_con', 'u_sat', 'u_hue', 'u_gam', 'u_tmp'], src: `uniform float u_exp, u_bri, u_con, u_sat, u_hue, u_gam, u_tmp;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 u = U(c);
  u *= exp2(u_exp);
  u += u_bri;
  u = (u - 0.5) * u_con + 0.5;
  u *= vec3(1.0 + u_tmp * 0.3, 1.0 + u_tmp * 0.05, 1.0 - u_tmp * 0.3);
  float l = dot(u, vec3(0.2126, 0.7152, 0.0722));
  u = mix(vec3(l), u, u_sat);
  if (u_hue != 0.0) { vec3 h = rgb2hsv(clamp(u, 0.0, 1.0)); h.x = fract(h.x + u_hue); u = hsv2rgb(h); }
  u = pow(max(u, 0.0), vec3(1.0 / u_gam));
  o = vec4(clamp(u, 0.0, 1.0) * c.a, c.a);
}`, set: (v) => ({ u_exp: v.exposure, u_bri: v.brightness / 200, u_con: v.contrast >= 0 ? 1 + v.contrast / 50 : 1 + v.contrast / 100, u_sat: 1 + v.saturation / 100, u_hue: v.hue / 360, u_gam: Math.max(0.05, v.gamma), u_tmp: v.temperature / 100 }) },
  tint: { u: ['u_b', 'u_w', 'u_amt'], src: `uniform vec3 u_b, u_w; uniform float u_amt;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 u = U(c);
  float l = dot(u, vec3(0.2126, 0.7152, 0.0722));
  o = vec4(mix(u, mix(u_b, u_w, l), u_amt) * c.a, c.a);
}`, set: (v) => ({ u_b: hexToArr(v.black), u_w: hexToArr(v.white), u_amt: v.amount / 100 }) },
  fill: { u: ['u_col', 'u_amt'], src: `uniform vec3 u_col; uniform float u_amt;
void main() { vec4 c = texture(u_tex, v_uv); o = vec4(mix(c.rgb, u_col * c.a, u_amt), c.a); }`, set: (v) => ({ u_col: hexToArr(v.color), u_amt: v.opacity / 100 }) },
  ramp: { u: ['u_a', 'u_b', 'u_c1', 'u_c2', 'u_rad', 'u_mix'], src: `uniform vec2 u_a, u_b; uniform vec3 u_c1, u_c2; uniform int u_rad; uniform float u_mix;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 p = v_uv * u_size, a = u_a * u_size, b = u_b * u_size;
  float t;
  if (u_rad == 1) t = length(p - a) / max(length(b - a), 1e-3);
  else { vec2 d = b - a; t = dot(p - a, d) / max(dot(d, d), 1e-3); }
  vec3 g = mix(u_c1, u_c2, clamp(t, 0.0, 1.0));
  o = vec4(mix(g, U(c), u_mix) * c.a, c.a);
}`, set: (v, c) => ({ u_a: c.pt(v.start), u_b: c.pt(v.end), u_c1: hexToArr(v.c1), u_c2: hexToArr(v.c2), u_rad: v.type === 'radial' ? 1 : 0, u_mix: v.blend / 100 }) },
  invert: { u: ['u_amt'], src: `uniform float u_amt;
void main() { vec4 c = texture(u_tex, v_uv); vec3 u = U(c); o = vec4(mix(u, 1.0 - u, u_amt) * c.a, c.a); }`, set: (v) => ({ u_amt: v.amount / 100 }) },
  posterize: { u: ['u_n'], src: `uniform float u_n;
void main() { vec4 c = texture(u_tex, v_uv); vec3 u = floor(U(c) * u_n) / (u_n - 1.0); o = vec4(clamp(u, 0.0, 1.0) * c.a, c.a); }`, set: (v) => ({ u_n: Math.max(2, v.levels) }) },
  threshold: { u: ['u_l'], src: `uniform float u_l;
void main() { vec4 c = texture(u_tex, v_uv); float l = dot(U(c), vec3(0.2126, 0.7152, 0.0722)); o = vec4(vec3(step(u_l, l)) * c.a, c.a); }`, set: (v) => ({ u_l: v.level / 100 }) },
  chromakey: { u: ['u_key', 'u_tol', 'u_soft', 'u_spill'], src: `uniform vec3 u_key; uniform float u_tol, u_soft, u_spill;
vec2 cbcr(vec3 c) { return vec2(-0.1687 * c.r - 0.3313 * c.g + 0.5 * c.b, 0.5 * c.r - 0.4187 * c.g - 0.0813 * c.b); }
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec3 u = U(c);
  float d = distance(cbcr(u), cbcr(u_key)) * 2.2;
  float a = smoothstep(u_tol, u_tol + u_soft + 1e-3, d);
  // Suppression du débordement : on limite la couche dominante de la couleur clé.
  vec3 k = u_key;
  if (k.g >= k.r && k.g >= k.b) u.g = mix(u.g, min(u.g, max(u.r, u.b)), u_spill);
  else if (k.b >= k.r) u.b = mix(u.b, min(u.b, max(u.r, u.g)), u_spill);
  else u.r = mix(u.r, min(u.r, max(u.g, u.b)), u_spill);
  float na = c.a * a;
  o = vec4(u * na, na);
}`, set: (v) => ({ u_key: hexToArr(v.key), u_tol: v.tolerance / 100 * 0.6, u_soft: v.softness / 100 * 0.5, u_spill: v.spill / 100 }) },
  lumakey: { u: ['u_thr', 'u_soft', 'u_inv'], src: `uniform float u_thr, u_soft; uniform int u_inv;
void main() {
  vec4 c = texture(u_tex, v_uv);
  float l = dot(U(c), vec3(0.2126, 0.7152, 0.0722));
  if (u_inv == 1) l = 1.0 - l;
  float a = smoothstep(u_thr, u_thr + u_soft + 1e-3, l);
  o = c * a;
}`, set: (v) => ({ u_thr: v.threshold / 100, u_soft: v.softness / 100, u_inv: v.invert ? 1 : 0 }) },
  chromatic: { u: ['u_off', 'u_rad', 'u_c'], src: `uniform vec2 u_off; uniform int u_rad; uniform vec2 u_c;
void main() {
  vec2 d = u_off;
  if (u_rad == 1) d = (v_uv - u_c) * length(u_off) * 4.0;
  vec4 r = T(v_uv + d), g = T(v_uv), b = T(v_uv - d);
  o = vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}`, set: (v, c) => {
    const a = (v.angle * Math.PI) / 180;
    return { u_off: [(Math.cos(a) * v.amount * c.ps) / c.w, (Math.sin(a) * v.amount * c.ps) / c.h], u_rad: v.radial ? 1 : 0, u_c: c.pt([50, 50]) };
  } },
  glitch: { u: ['u_amt', 'u_rows', 'u_spd', 'u_rgb'], src: `uniform float u_amt, u_rows, u_spd, u_rgb;
void main() {
  float tt = floor(u_time * u_spd);
  float row = floor(v_uv.y * u_size.y / u_rows);
  float h = hash(vec2(row, tt));
  float sh = (h > 0.75 ? (hash(vec2(row * 1.7, tt + 3.0)) - 0.5) * 2.0 : 0.0) * u_amt;
  vec2 uv = v_uv + vec2(sh, 0.0);
  float s = u_rgb * (h > 0.6 ? 1.0 : 0.25);
  vec4 r = T(uv + vec2(s, 0.0)), g = T(uv), b = T(uv - vec2(s, 0.0));
  o = vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a));
}`, set: (v, c) => ({ u_amt: (v.amount * c.ps) / c.w, u_rows: Math.max(1, v.blocks * c.ps), u_spd: v.speed, u_rgb: (v.rgb * c.ps) / c.w }) },
  wave: { u: ['u_amp', 'u_len', 'u_ph', 'u_dir'], src: `uniform float u_amp, u_len, u_ph; uniform vec2 u_dir;
void main() {
  vec2 p = v_uv * u_size;
  vec2 n = vec2(-u_dir.y, u_dir.x);
  float s = sin(dot(p, n) / u_len * 6.2831853 + u_ph) * u_amp;
  o = T((p + u_dir * s) / u_size);
}`, set: (v, c) => {
    const a = (v.angle * Math.PI) / 180;
    return { u_amp: v.amplitude * c.ps, u_len: Math.max(1, v.wavelength * c.ps), u_ph: -c.time * v.speed * Math.PI * 2, u_dir: [Math.sin(a), -Math.cos(a)] };
  } },
  turbulent: { u: ['u_amt', 'u_sz', 'u_ev'], src: `uniform float u_amt, u_sz, u_ev;
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += vnoise(p) * a; p *= 2.03; a *= 0.5; } return s; }
void main() {
  vec2 p = v_uv * u_size / u_sz;
  vec2 d = vec2(fbm(p + vec2(u_ev, 0.0)), fbm(p + vec2(5.2, 1.3 - u_ev))) - 0.47;
  o = T(v_uv + d * u_amt / u_size * 2.0);
}`, set: (v, c) => ({ u_amt: v.amount * c.ps, u_sz: Math.max(1, v.size * c.ps), u_ev: c.time * v.evolution * 2 }) },
  twirl: { u: ['u_c', 'u_ang', 'u_r'], src: `uniform vec2 u_c; uniform float u_ang, u_r;
void main() {
  vec2 asp = vec2(u_size.x / u_size.y, 1.0);
  vec2 d = (v_uv - u_c) * asp;
  float l = length(d);
  float k = max(0.0, 1.0 - l / u_r);
  float a = u_ang * k * k;
  d = vec2(d.x * cos(a) - d.y * sin(a), d.x * sin(a) + d.y * cos(a));
  o = T(u_c + d / asp);
}`, set: (v, c) => ({ u_c: c.pt(v.center), u_ang: (v.angle * Math.PI) / 180, u_r: (v.radius / 100) * (c.srcH / c.h) }) },
  bulge: { u: ['u_c', 'u_amt', 'u_r'], src: `uniform vec2 u_c; uniform float u_amt, u_r;
void main() {
  vec2 asp = vec2(u_size.x / u_size.y, 1.0);
  vec2 d = (v_uv - u_c) * asp;
  float l = length(d) / u_r;
  if (l < 1.0) d *= mix(1.0, pow(l, u_amt), 1.0 - l);
  o = T(u_c + d / asp);
}`, set: (v, c) => ({ u_c: c.pt(v.center), u_amt: 1 + v.amount / 100, u_r: (v.radius / 100) * (c.srcH / c.h) }) },
  mirror: { u: ['u_ax', 'u_c'], src: `uniform int u_ax; uniform vec2 u_c;
void main() {
  vec2 uv = v_uv;
  if ((u_ax == 0 || u_ax == 2) && uv.x > u_c.x) uv.x = 2.0 * u_c.x - uv.x;
  if ((u_ax == 1 || u_ax == 2) && uv.y > u_c.y) uv.y = 2.0 * u_c.y - uv.y;
  o = T(uv);
}`, set: (v, c) => ({ u_ax: v.axis === 'y' ? 1 : v.axis === 'xy' ? 2 : 0, u_c: c.pt([50, 50]) }) },
  tile: { u: ['u_n', 'u_m'], src: `uniform vec2 u_n; uniform int u_m;
void main() {
  vec2 s = (v_uv - u_src.xy) / u_src.zw;
  vec2 q = s * u_n;
  vec2 f = fract(q);
  if (u_m == 1) { vec2 i = mod(floor(q), 2.0); f = mix(f, 1.0 - f, i); }
  o = T(u_src.xy + f * u_src.zw);
}`, set: (v) => ({ u_n: [Math.max(0.1, v.tiles[0]), Math.max(0.1, v.tiles[1])], u_m: v.mirrorEdges ? 1 : 0 }) },
  pixelate: { u: ['u_b'], src: `uniform float u_b;
void main() { vec2 p = (floor(v_uv * u_size / u_b) + 0.5) * u_b / u_size; o = T(p); }`, set: (v, c) => ({ u_b: Math.max(1, v.size * c.ps) }) },
  noise: { u: ['u_amt', 'u_sz', 'u_col', 'u_seed'], src: `uniform float u_amt, u_sz, u_seed; uniform int u_col;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 p = floor(v_uv * u_size / u_sz);
  vec3 n = u_col == 1 ? vec3(hash(p + u_seed), hash(p + u_seed + 17.0), hash(p + u_seed + 41.0)) : vec3(hash(p + u_seed));
  vec3 u = U(c) + (n - 0.5) * u_amt;
  o = vec4(clamp(u, 0.0, 1.0) * c.a, c.a);
}`, set: (v, c) => ({ u_amt: v.amount / 100, u_sz: Math.max(0.5, v.size * c.ps), u_col: v.color ? 1 : 0, u_seed: v.animated ? Math.floor(c.time * 30) * 7.31 % 1000 : 0 }) },
  vignette: { u: ['u_amt', 'u_sz', 'u_soft'], src: `uniform float u_amt, u_sz, u_soft;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 s = (v_uv - u_src.xy) / u_src.zw - 0.5;
  float d = length(s * vec2(1.0, u_src.w * u_size.y / (u_src.z * u_size.x))) * 1.414;
  float v = smoothstep(u_sz, u_sz + u_soft, d);
  vec3 u = U(c);
  u = u_amt >= 0.0 ? u * (1.0 - v * u_amt) : mix(u, vec3(1.0), v * -u_amt);
  o = vec4(u * c.a, c.a);
}`, set: (v) => ({ u_amt: v.amount / 100, u_sz: (v.size / 100) * 0.9, u_soft: Math.max(0.01, v.softness / 100) }) },
  scanlines: { u: ['u_amt', 'u_sp', 'u_off'], src: `uniform float u_amt, u_sp, u_off;
void main() {
  vec4 c = texture(u_tex, v_uv);
  float y = v_uv.y * u_size.y + u_off;
  float l = 0.5 + 0.5 * sin(y / u_sp * 3.14159);
  vec3 u = U(c) * (1.0 - u_amt * l);
  o = vec4(u * c.a, c.a);
}`, set: (v, c) => ({ u_amt: v.amount / 100, u_sp: Math.max(0.5, v.spacing * c.ps), u_off: c.time * v.roll * c.ps }) },
  wipe: { u: ['u_comp', 'u_dir', 'u_f'], src: `uniform float u_comp, u_f; uniform vec2 u_dir;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 s = (v_uv - u_src.xy) / u_src.zw - 0.5;
  vec2 p = s * u_src.zw * u_size;
  float ext = abs(u_dir.x) * u_src.z * u_size.x * 0.5 + abs(u_dir.y) * u_src.w * u_size.y * 0.5;
  float d = dot(p, u_dir) / max(ext, 1.0);
  float edge = mix(-1.0 - u_f, 1.0 + u_f, u_comp);
  o = c * smoothstep(edge - u_f, edge + u_f, d);
}`, set: (v, c) => {
    const a = ((v.angle - 90) * Math.PI) / 180;
    return { u_comp: v.completion / 100, u_dir: [Math.cos(a), Math.sin(a)], u_f: Math.max(0.0005, (v.feather * c.ps) / Math.max(c.w, c.h)) };
  } },
  radialwipe: { u: ['u_comp', 'u_st', 'u_f'], src: `uniform float u_comp, u_st, u_f;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 s = ((v_uv - u_src.xy) / u_src.zw - 0.5) * u_src.zw * u_size;
  float a = fract((atan(s.x, -s.y) - u_st) / 6.2831853 + 1.0);
  o = c * smoothstep(u_comp - u_f, u_comp + u_f, a * (1.0 + 2.0 * u_f) - u_f);
}`, set: (v) => ({ u_comp: v.completion / 100, u_st: (v.start * Math.PI) / 180, u_f: Math.max(0.0005, v.feather / 360) }) },
  iris: { u: ['u_comp', 'u_c', 'u_f'], src: `uniform float u_comp, u_f; uniform vec2 u_c;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec2 p = (v_uv - u_c) * u_size;
  float R = length(u_src.zw * u_size) * 0.5 * 1.05;
  float r = (1.0 - u_comp) * (R + u_f);
  o = c * (1.0 - smoothstep(r - u_f, r, length(p)));
}`, set: (v, c) => ({ u_comp: v.completion / 100, u_c: c.pt(v.center), u_f: Math.max(0.5, v.feather * c.ps) }) },
  venetian: { u: ['u_comp', 'u_w', 'u_dir'], src: `uniform float u_comp, u_w; uniform vec2 u_dir;
void main() {
  vec4 c = texture(u_tex, v_uv);
  float d = dot(v_uv * u_size, u_dir);
  float f = fract(d / u_w);
  o = c * step(u_comp, f);
}`, set: (v, c) => {
    const a = (v.angle * Math.PI) / 180;
    return { u_comp: v.completion / 100, u_w: Math.max(1, v.width * c.ps), u_dir: [Math.sin(a), Math.cos(a)] };
  } },
};

// ---------- Matrices 4×4 (colonnes) ----------

export const M4 = {
  ident: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  },
  translate: (x, y, z = 0) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]),
  scale: (x, y, z = 1) => new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]),
  rotZ(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  },
  rotX(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
  },
  rotY(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
  },
  // Caméra par défaut d'After Effects : perspective centrée sur la composition.
  perspective(cx, cy, zoom) {
    const p = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1 / zoom, 0, 0, 0, 1]);
    return M4.mul(M4.translate(cx, cy), M4.mul(p, M4.translate(-cx, -cy)));
  },
  // Pixels (y vers le bas) → espace de découpage.
  ortho: (w, h) => new Float32Array([2 / w, 0, 0, 0, 0, 2 / h, 0, 0, 0, 0, 1, 0, -1, -1, 0, 1]),
  apply(m, x, y, z = 0) {
    const X = m[0] * x + m[4] * y + m[8] * z + m[12];
    const Y = m[1] * x + m[5] * y + m[9] * z + m[13];
    const W = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [X / W, Y / W];
  },
  invert2D(m) {
    // Inverse de la partie affine 2D (pour les clics dans le visualiseur).
    const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
    const det = a * d - b * c || 1e-9;
    return (x, y) => [((x - e) * d - (y - f) * c) / det, ((y - f) * a - (x - e) * b) / det];
  },
};

// ---------- Moteur ----------

export class GL {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 16;
    this.canvas.height = 16;
    const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true, powerPreference: 'high-performance', desynchronized: true });
    if (!gl) throw new Error('WebGL 2 indisponible');
    this.gl = gl;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'WebGL 2';
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.progs = {};
    this.pool = [];
    this.inUse = new Set();
    this.texCache = new Map();
    this.dynTex = new Map();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.white = this.makeTex(1, 1, new Uint8Array([255, 255, 255, 255]));
    this.lost = false;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    this.stats = { passes: 0 };
  }

  prog(name, vs, fs) {
    let p = this.progs[name];
    if (p) return p;
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader ${name} : ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(pr, 0, 'a_pos');
    gl.bindAttribLocation(pr, 1, 'a_inst');
    gl.bindAttribLocation(pr, 2, 'a_col');
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(`Programme ${name} : ${gl.getProgramInfoLog(pr)}`);
    const loc = {}, types = {};
    const n = gl.getProgramParameter(pr, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(pr, i);
      const nm = info.name.replace(/\[0\]$/, '');
      loc[nm] = gl.getUniformLocation(pr, info.name);
      types[nm] = info.type;
    }
    p = { pr, loc, types };
    this.progs[name] = p;
    return p;
  }

  use(p) {
    this.gl.useProgram(p.pr);
    p.unit = 0;
    return p;
  }

  set(p, name, v) {
    const gl = this.gl, l = p.loc[name];
    if (l == null) return;
    if (typeof v === 'number') {
      if (p.types[name] === gl.INT || p.types[name] === gl.BOOL) gl.uniform1i(l, v);
      else gl.uniform1f(l, v);
    } else if (v instanceof Float32Array && v.length === 16) gl.uniformMatrix4fv(l, false, v);
    else if (v instanceof Float32Array && v.length === 9) gl.uniformMatrix3fv(l, false, v);
    else if (v.length === 2) gl.uniform2fv(l, v);
    else if (v.length === 3) gl.uniform3fv(l, v);
    else if (v.length === 4) gl.uniform4fv(l, v);
  }

  bindTex(p, name, tex) {
    const gl = this.gl;
    if (p.loc[name] == null) return;
    const unit = p.unit++;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.loc[name], unit);
  }

  makeTex(w, h, data = null) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // ---------- Tampons de rendu recyclés ----------

  fbo(w, h) {
    w = Math.max(1, Math.min(this.maxTex, Math.round(w)));
    h = Math.max(1, Math.min(this.maxTex, Math.round(h)));
    const gl = this.gl;
    let i = this.pool.findIndex((f) => f.w === w && f.h === h);
    let f;
    if (i >= 0) f = this.pool.splice(i, 1)[0];
    else {
      const tex = this.makeTex(w, h);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      f = { fb, tex, w, h };
    }
    this.inUse.add(f);
    return f;
  }

  release(f) {
    if (!f || !this.inUse.has(f)) return;
    this.inUse.delete(f);
    this.pool.push(f);
    // Limite la mémoire vidéo gardée en réserve.
    while (this.pool.length > 24) {
      const old = this.pool.shift();
      this.gl.deleteFramebuffer(old.fb);
      this.gl.deleteTexture(old.tex);
    }
  }

  target(f) {
    const gl = this.gl;
    if (f) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
      gl.viewport(0, 0, f.w, f.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  clear(f, rgba = [0, 0, 0, 0]) {
    const gl = this.gl;
    this.target(f);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(rgba[0], rgba[1], rgba[2], rgba[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  blendMode(mode) {
    const gl = this.gl;
    if (mode === 'none') return gl.disable(gl.BLEND);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    if (mode === 'add') gl.blendFunc(gl.ONE, gl.ONE);
    else if (mode === 'sample') gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  draw() {
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
    this.stats.passes++;
  }

  // ---------- Textures des sources ----------

  // Texture d'une image statique (téléversée une seule fois, avec mipmaps).
  staticTex(key, src) {
    let t = this.texCache.get(key);
    if (t) return t;
    const gl = this.gl;
    let img = src;
    let w = src.width, h = src.height;
    if (w > this.maxTex || h > this.maxTex) {
      const s = this.maxTex / Math.max(w, h);
      const c = document.createElement('canvas');
      c.width = Math.floor(w * s);
      c.height = Math.floor(h * s);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      img = c;
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    t = { tex, w, h };
    this.texCache.set(key, t);
    return t;
  }

  // Texture dynamique (vidéo, texte, forme) : retéléversée seulement si `version` change.
  dynamicTex(slot, src, version) {
    const gl = this.gl;
    let t = this.dynTex.get(slot);
    const w = src.videoWidth || src.width, h = src.videoHeight || src.height;
    if (t && t.version === version && t.w === w && t.h === h) return t;
    if (!t) {
      t = { tex: this.makeTex(1, 1), w: 0, h: 0, version: null };
      this.dynTex.set(slot, t);
    }
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    if (t.w === w && t.h === h) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    t.w = w;
    t.h = h;
    t.version = version;
    return t;
  }

  dropTex(prefix) {
    for (const [k, t] of this.texCache) {
      if (k.startsWith(prefix)) {
        this.gl.deleteTexture(t.tex);
        this.texCache.delete(k);
      }
    }
  }

  // ---------- Passages de dessin ----------

  // Dessine un quadrilatère texturé (ou de couleur unie) transformé par `mvp`.
  quad(target, { tex, color, box, mvp, opacity = 1, mask = null, uv = [0, 0, 1, 1] }, blend = 'over') {
    const gl = this.gl;
    this.target(target);
    this.blendMode(blend);
    const p = this.use(this.prog('layer', VS_QUAD, FS_LAYER));
    this.set(p, 'u_mvp', mvp);
    this.set(p, 'u_box', box);
    this.set(p, 'u_uv', uv);
    this.set(p, 'u_opacity', opacity);
    this.set(p, 'u_useColor', color ? 1 : 0);
    if (color) this.set(p, 'u_color', color);
    this.bindTex(p, 'u_tex', tex || this.white);
    this.set(p, 'u_useMask', mask ? 1 : 0);
    this.bindTex(p, 'u_mask', mask || this.white);
    this.draw();
    gl.disable(gl.BLEND);
  }

  full(target, progName, fs, uniforms, textures, blend = 'none') {
    this.target(target);
    this.blendMode(blend);
    const p = this.use(this.prog(progName, VS_FULL, fs));
    for (const [k, v] of Object.entries(textures)) this.bindTex(p, k, v);
    for (const [k, v] of Object.entries(uniforms)) this.set(p, k, v);
    this.draw();
    this.gl.disable(this.gl.BLEND);
  }

  copy(src, dst, blend = 'none', uv = [0, 0, 1, 1]) {
    this.full(dst, 'copy', FS_COPY, { u_uv: uv }, { u_tex: src.tex }, blend);
  }

  blend(dst, src, out, modeIndex, opacity = 1) {
    this.full(out, 'blend', FS_BLEND, { u_mode: modeIndex, u_opacity: opacity }, { u_dst: dst.tex, u_src: src.tex });
  }

  matte(layer, matte, out, mode) {
    const m = { alpha: 0, alphaInv: 1, luma: 2, lumaInv: 3 }[mode] ?? 0;
    this.full(out, 'matte', FS_MATTE, { u_mode: m }, { u_tex: layer.tex, u_matte: matte.tex });
  }

  mix(a, b, out, k, maskTex = null) {
    this.full(out, 'mix', FS_MIX, { u_k: k, u_useMask: maskTex ? 1 : 0 }, { u_a: a.tex, u_b: b.tex, u_mask: maskTex || this.white });
  }

  // Affiche un tampon dans le canevas (retourné verticalement), sur une couleur de fond.
  present(src, bg = [0, 0, 0, 0]) {
    this.full(null, 'present', FS_PRESENT, { u_flip: 1, u_bg: bg }, { u_tex: src.tex });
  }

  resize(w, h) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  // Flou gaussien rapide : les grands rayons sont calculés à résolution réduite.
  blur(src, sigma, dir = 'both') {
    if (sigma < 0.3) {
      const o = this.fbo(src.w, src.h);
      this.copy(src, o);
      return o;
    }
    let f = 1;
    while (sigma / f > 10 && Math.min(src.w, src.h) / (f * 2) >= 4) f *= 2;
    let cur = src, owned = null;
    // Réduction progressive (moitié par moitié) pour éviter le crénelage.
    let w = src.w, h = src.h;
    while (f > 1 && (w > src.w / f + 1 || h > src.h / f + 1)) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      const d = this.fbo(w, h);
      this.copy(cur, d);
      if (owned) this.release(owned);
      cur = owned = d;
    }
    const s = sigma / (src.w / cur.w);
    const n = Math.min(48, Math.ceil(s * 3));
    const pass = (from, dx, dy) => {
      const o = this.fbo(from.w, from.h);
      this.full(o, 'blur', FS_BLUR, { u_dir: [dx / from.w, dy / from.h], u_sigma: Math.max(0.3, s), u_n: n }, { u_tex: from.tex });
      return o;
    };
    if (dir !== 'v') {
      const o = pass(cur, 1, 0);
      if (owned) this.release(owned);
      cur = owned = o;
    }
    if (dir !== 'h') {
      const o = pass(cur, 0, 1);
      if (owned) this.release(owned);
      cur = owned = o;
    }
    if (cur.w !== src.w || cur.h !== src.h) {
      const o = this.fbo(src.w, src.h);
      this.copy(cur, o);
      this.release(cur);
      cur = o;
    }
    return cur;
  }

  // Applique un effet ; renvoie un nouveau tampon (l'entrée n'est pas libérée).
  effect(type, src, vals, ctx) {
    const c = { ...ctx, w: src.w, h: src.h, pt: (pct) => [ctx.src[0] + (pct[0] / 100) * ctx.src[2], ctx.src[1] + (pct[1] / 100) * ctx.src[3]] };
    if (type === 'blur') return this.blur(src, (vals.amount * ctx.ps) / 2, vals.dir);
    if (type === 'glow') {
      const br = this.fbo(src.w, src.h);
      this.full(br, 'bright', FS_BRIGHT, { u_thr: vals.threshold / 100, u_tint: hexToArr(vals.tint), u_useTint: vals.useTint ? 1 : 0 }, { u_tex: src.tex });
      const g = this.blur(br, (vals.radius * ctx.ps) / 2);
      this.release(br);
      const o = this.fbo(src.w, src.h);
      this.full(o, 'addglow', FS_ADDGLOW, { u_int: vals.intensity }, { u_tex: src.tex, u_glow: g.tex });
      this.release(g);
      return o;
    }
    if (type === 'shadow') {
      const a = (vals.angle * Math.PI) / 180;
      const d = vals.distance * ctx.ps;
      const sh = this.fbo(src.w, src.h);
      const col = hexToArr(vals.color);
      this.full(sh, 'shadow', FS_SHADOW, { u_off: [(Math.sin(a) * d) / src.w, (-Math.cos(a) * d) / src.h], u_color: [col[0], col[1], col[2], vals.opacity / 100] }, { u_tex: src.tex });
      const b = this.blur(sh, (vals.softness * ctx.ps) / 2);
      this.release(sh);
      const o = this.fbo(src.w, src.h);
      this.full(o, 'over', FS_OVER, {}, { u_tex: src.tex, u_under: b.tex });
      this.release(b);
      return o;
    }
    const fx = FX[type];
    if (!fx) {
      const o = this.fbo(src.w, src.h);
      this.copy(src, o);
      return o;
    }
    const o = this.fbo(src.w, src.h);
    const u = { u_size: [src.w, src.h], u_ps: ctx.ps, u_src: ctx.src, u_time: ctx.time, ...fx.set(vals, c) };
    this.full(o, `fx_${type}`, FX_HEAD + fx.src, u, { u_tex: src.tex });
    return o;
  }

  // Particules instanciées : data = Float32Array [x, y, taille, opacité] × n, cols = [r, g, b] × n.
  particles(target, data, cols, n, { additive, softness, m }) {
    const gl = this.gl;
    if (!this.pvao) {
      this.pvao = gl.createVertexArray();
      gl.bindVertexArray(this.pvao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.pinst = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pinst);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(1, 1);
      this.pcol = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pcol);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(2, 1);
      gl.bindVertexArray(this.vao);
    }
    this.target(target);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    if (additive) gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.use(this.prog('particles', VS_PARTICLE, FS_PARTICLE));
    this.set(p, 'u_size', [target.w, target.h]);
    this.set(p, 'u_soft', softness);
    this.set(p, 'u_m', m);
    gl.bindVertexArray(this.pvao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pinst);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * 4), gl.STREAM_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pcol);
    gl.bufferData(gl.ARRAY_BUFFER, cols.subarray(0, n * 3), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    this.stats.passes++;
  }
}
