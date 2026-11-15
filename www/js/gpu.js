// Moteur de développement accéléré par la carte graphique (WebGL 2).
//
// Reproduit sur le GPU le passage pixel de `develop()` (balance des blancs, exposition, tonalité,
// clarté, texture, correction du voile, courbes, TSL, vibrance, étalonnage, N&B, vignetage, grain).
// Les cartes floues nécessaires au contraste local sont calculées elles aussi sur le GPU
// (réductions successives + flou gaussien séparable). Si WebGL 2 est indisponible, si l'image
// dépasse la taille de texture maximale ou si le contexte est perdu, on revient au moteur CPU.

import { curveLUT, isIdentityCurve } from './imaging.js';
import { hslToRgb01 } from './util.js';

// Préférence « prisme.gpu » (lue directement pour éviter une dépendance circulaire avec app.js).
// null : automatique (GPU matériel uniquement) ; true / false : choix explicite de l'utilisateur.
function gpuPref() {
  try {
    const v = localStorage.getItem('prisme.gpu');
    return v == null ? null : v !== 'false';
  } catch {
    return null;
  }
}

// Un GPU émulé par logiciel (SwiftShader, llvmpipe…) est plus lent que le moteur CPU optimisé.
const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;
function usable() {
  const pref = gpuPref();
  if (pref === false) return false;
  const s = init();
  if (!s) return false;
  return pref === true || !s.software;
}

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Cartes de base : R = luminance (Rec. 709), G = canal minimum (« dark channel » du voile).
const FRAG_MAPS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 o;
void main() {
  vec3 c = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb;
  o = vec4(dot(c, vec3(0.2126, 0.7152, 0.0722)), min(c.r, min(c.g, c.b)), 0.0, 1.0);
}`;

// Réduction de moitié (moyenne 2×2 grâce au filtrage bilinéaire).
const FRAG_HALF = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uOutSize;
out vec4 o;
void main() { o = texture(uTex, gl_FragCoord.xy / uOutSize); }`;

// Flou gaussien séparable.
const FRAG_BLUR = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform ivec2 uDir;
uniform int uRadius;
uniform float uSigma;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 mx = textureSize(uTex, 0) - 1;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int k = -32; k <= 32; k++) {
    if (k < -uRadius || k > uRadius) continue;
    float w = exp(-float(k * k) / (2.0 * uSigma * uSigma));
    acc += w * texelFetch(uTex, clamp(p + uDir * k, ivec2(0), mx), 0);
    wsum += w;
  }
  o = acc / wsum;
}`;

const FRAG_DEVELOP = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D uSrc;
uniform sampler2D uLut;      // 1024 × 5 (R32F) : tonalité, courbe RVB, R, V, B
uniform sampler2D uBlurL;    // clarté / voile (R) — rayon large
uniform sampler2D uBlurD;    // voile (G) — rayon très large
uniform sampler2D uBlurT;    // texture (R) — rayon fin
uniform vec2 uSize;
uniform int uFlags;          // bits : 1 voile, 2 balance/expo, 4 tonalité, 8 clarté, 16 texture, 32 courbes
                             //        64 TSL, 128 sat/vib, 256 étalonnage, 512 N&B, 1024 vignetage, 2048 grain
uniform int uCurveMask;      // bits : 1 rgb, 2 r, 4 g, 8 b
uniform float uDehaze, uClarity, uTexture;
uniform vec3 uWB;
uniform float uExp;
uniform float uSat, uVib;
uniform vec4 uBands[8];      // centre (0-1), h, s, l
uniform vec3 uGS, uGM, uGH, uGradeS;
uniform float uGBal;
uniform float uVig, uVigMid, uVigFeather;
uniform float uGrain, uGrainSize;
out vec4 o;

float toLin(float v) { v = clamp(v, 0.0, 1.0); return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float toSrgb(float v) { v = clamp(v, 0.0, 1.0); return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055; }
float lut(int row, float v) { return texelFetch(uLut, ivec2(int(clamp(v, 0.0, 1.0) * 1023.0), row), 0).r; }

vec3 rgb2hsl(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  float l = (mx + mn) * 0.5, h = 0.0, s = 0.0, d = mx - mn;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}
float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 0.5) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 c) {
  if (c.y <= 0.0) return vec3(c.z);
  float q = c.z < 0.5 ? c.z * (1.0 + c.y) : c.z + c.y - c.z * c.y;
  float p = 2.0 * c.z - q;
  return vec3(hue2rgb(p, q, c.x + 1.0 / 3.0), hue2rgb(p, q, c.x), hue2rgb(p, q, c.x - 1.0 / 3.0));
}
float hash2(uint x, uint y, uint seed) {
  uint n = x * 374761393u + y * 668265263u + seed * 2147483647u;
  n = (n ^ (n >> 13u)) * 1274126177u;
  n ^= n >> 16u;
  return float(n) / 4294967295.0;
}

void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec4 src = texelFetch(uSrc, ip, 0);
  if (src.a == 0.0) { o = src; return; }
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 c = src.rgb;

  if ((uFlags & 1) != 0) {
    float haze = texture(uBlurD, uv).g;
    if (uDehaze > 0.0) {
      float t = max(0.25, 1.0 - uDehaze * 0.85 * haze);
      c = (c - 0.95 * (1.0 - t)) / t;
    } else {
      float k = -uDehaze * 0.55;
      c = c * (1.0 - k) + vec3(0.85, 0.86, 0.88) * k;
    }
  }
  if ((uFlags & 2) != 0) {
    c = vec3(toSrgb(toLin(c.r) * uWB.r * uExp), toSrgb(toLin(c.g) * uWB.g * uExp), toSrgb(toLin(c.b) * uWB.b * uExp));
  }
  float L = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if ((uFlags & 4) != 0) {
    float L2 = lut(0, L);
    if (L > 0.0005) c *= L2 / L; else c = vec3(L2);
    L = L2;
  }
  if ((uFlags & 8) != 0) {
    float mid = 4.0 * L * (1.0 - L);
    c += (L - texture(uBlurL, uv).r) * uClarity * 1.6 * mid;
  }
  if ((uFlags & 16) != 0) c += (L - texture(uBlurT, uv).r) * uTexture * 1.8;
  if ((uFlags & 32) != 0) {
    if ((uCurveMask & 2) != 0) c.r = lut(2, c.r);
    if ((uCurveMask & 4) != 0) c.g = lut(3, c.g);
    if ((uCurveMask & 8) != 0) c.b = lut(4, c.b);
    if ((uCurveMask & 1) != 0) c = vec3(lut(1, c.r), lut(1, c.g), lut(1, c.b));
  }
  if ((uFlags & 64) != 0) {
    vec3 hsl = rgb2hsl(clamp(c, 0.0, 1.0));
    if (hsl.y > 0.02) {
      vec3 d = vec3(0.0);
      for (int i = 0; i < 8; i++) {
        float dist = abs(hsl.x - uBands[i].x);
        if (dist > 0.5) dist = 1.0 - dist;
        float w = 1.0 - smoothstep(0.0, 0.1, dist);
        d += w * uBands[i].yzw;
      }
      float satW = min(1.0, hsl.y * 2.0);
      hsl.x = mod(hsl.x + (d.x / 100.0) * 0.08 + 1.0, 1.0);
      hsl.y = clamp(hsl.y * (1.0 + d.y / 100.0), 0.0, 1.0);
      hsl.z = clamp(hsl.z + (d.z / 100.0) * 0.25 * satW, 0.0, 1.0);
      c = hsl2rgb(hsl);
    }
  }
  if ((uFlags & 128) != 0) {
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float cs = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    float k = 1.0 + uSat;
    if (uVib != 0.0) k *= 1.0 + uVib * (1.0 - min(1.0, cs * 1.5)) * (uVib > 0.0 ? 1.2 : 1.0);
    c = lum + (c - lum) * k;
  }
  if ((uFlags & 256) != 0) {
    float lum = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)) - uGBal * 0.25, 0.0, 1.0);
    float ws = (1.0 - lum) * (1.0 - lum), wh = lum * lum, wm = max(0.0, 1.0 - ws - wh);
    c += (uGS - 0.5) * uGradeS.x * ws * 0.35 + (uGM - 0.5) * uGradeS.y * wm * 0.35 + (uGH - 0.5) * uGradeS.z * wh * 0.35;
  }
  if ((uFlags & 512) != 0) c = vec3(dot(c, vec3(0.2126, 0.7152, 0.0722)));
  if ((uFlags & 1024) != 0) {
    vec2 ctr = uSize * 0.5;
    vec2 dd = (vec2(ip) - ctr) / ctr;
    float dist = length(dd) / sqrt(2.0);
    float f = smoothstep(uVigMid - uVigFeather / 2.0, uVigMid + uVigFeather / 2.0, dist);
    if (uVig < 0.0) c *= 1.0 + uVig * f; else c += (1.0 - c) * uVig * f;
  }
  if ((uFlags & 2048) != 0) {
    float nz = (hash2(uint(float(ip.x) / uGrainSize), uint(float(ip.y) / uGrainSize), 7u) - 0.5) * uGrain * 0.28;
    c += nz;
  }
  o = vec4(c, src.a);
}`;

let state = null; // { gl, programs, buffer } | false si indisponible

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
}

function init() {
  if (state !== null) return state;
  try {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false, depth: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) return (state = false);
    canvas.addEventListener?.('webglcontextlost', (e) => {
      e.preventDefault();
      state = false;
    });
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const programs = {
      maps: compile(gl, VERT, FRAG_MAPS),
      half: compile(gl, VERT, FRAG_HALF),
      blur: compile(gl, VERT, FRAG_BLUR),
      develop: compile(gl, VERT, FRAG_DEVELOP),
    };
    const renderer = (() => {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    })();
    state = { gl, canvas, programs, maxSize: gl.getParameter(gl.MAX_TEXTURE_SIZE), renderer, software: SOFTWARE_GPU.test(renderer || '') };
  } catch (e) {
    console.warn('WebGL 2 indisponible, moteur CPU utilisé', e);
    state = false;
  }
  return state;
}

/** Vrai si l'accélération GPU est disponible et activée dans les préférences. */
export function gpuEnabled() {
  return usable();
}

export function gpuInfo() {
  const s = init();
  return s ? { renderer: s.renderer, maxSize: s.maxSize, software: s.software } : null;
}

function texture(gl, w, h, { data = null, filter = 'LINEAR', format = 'RGBA8' } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl[filter]);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl[filter]);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (format === 'R32F') gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, data);
  else if (data instanceof ImageData) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, data);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return { t, w, h };
}

function draw(s, prog, target, bind) {
  const { gl } = s;
  gl.useProgram(prog.p);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.t, 0);
  gl.viewport(0, 0, target.w, target.h);
  bind(prog.u);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return fb;
}

function bindTex(gl, unit, loc, tex) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex.t);
  gl.uniform1i(loc, unit);
}

// Flou gaussien d'une texture : réductions par 2 tant que le rayon est grand, puis flou séparable.
function blurTexture(s, src, sigma, trash) {
  const { gl, programs } = s;
  let cur = src, sg = sigma;
  while (sg > 6 && cur.w > 24 && cur.h > 24) {
    const next = texture(gl, Math.ceil(cur.w / 2), Math.ceil(cur.h / 2));
    trash.push(next, draw(s, programs.half, next, (u) => {
      bindTex(gl, 0, u.uTex, cur);
      gl.uniform2f(u.uOutSize, next.w, next.h);
    }));
    cur = next;
    sg /= 2;
  }
  const radius = Math.min(32, Math.ceil(sg * 2.5));
  const pass = (from, dir) => {
    const out = texture(gl, from.w, from.h);
    trash.push(out, draw(s, programs.blur, out, (u) => {
      bindTex(gl, 0, u.uTex, from);
      gl.uniform2i(u.uDir, dir[0], dir[1]);
      gl.uniform1i(u.uRadius, radius);
      gl.uniform1f(u.uSigma, Math.max(0.3, sg));
    }));
    return out;
  };
  return pass(pass(cur, [1, 0]), [0, 1]);
}

function hueRgb(h) {
  const out = [0, 0, 0];
  hslToRgb01((((h % 360) + 360) % 360) / 360, 1, 0.5, out);
  return out;
}

/**
 * Passage pixel du développement sur le GPU. Renvoie une ImageData, ou null si le GPU ne peut pas
 * traiter cette image (le moteur CPU prend alors le relais).
 * `tone` : table de tonalité déjà calculée ; `bands` : bandes TSL avec leur centre.
 */
export function developPixelsGPU(src, p, scale, { tone, toneIdentity, bands, hslActive }) {
  if (!usable()) return null;
  const s = init();
  const { width: w, height: h } = src;
  if (w > s.maxSize || h > s.maxSize || w * h < 4) return null;
  const { gl, programs } = s;
  const trash = [];
  try {
    const srcTex = texture(gl, w, h, { data: src, filter: 'NEAREST' });
    trash.push(srcTex);

    // Tables : tonalité + 4 courbes
    const lutData = new Float32Array(1024 * 5);
    let curveMask = 0;
    if (!toneIdentity) lutData.set(tone, 0);
    ['rgb', 'r', 'g', 'b'].forEach((k, i) => {
      if (!isIdentityCurve(p.curves[k])) {
        lutData.set(curveLUT(p.curves[k], 1024), 1024 * (i + 1));
        curveMask |= 1 << i;
      }
    });
    const lutTex = texture(gl, 1024, 5, { data: lutData, filter: 'NEAREST', format: 'R32F' });
    trash.push(lutTex);

    // Cartes floues (seulement si nécessaires)
    let blurL = srcTex, blurD = srcTex, blurT = srcTex;
    if (p.clarity || p.dehaze || p.texture) {
      const maps = texture(gl, w, h);
      trash.push(maps, draw(s, programs.maps, maps, (u) => bindTex(gl, 0, u.uSrc, srcTex)));
      if (p.clarity) blurL = blurTexture(s, maps, Math.max(w, h) * 0.012, trash);
      if (p.dehaze) blurD = blurTexture(s, maps, Math.max(w, h) * 0.02, trash);
      if (p.texture) blurT = blurTexture(s, maps, Math.max(1, 2.5 * scale), trash);
    }

    const temp = p.temperature / 100, tint = p.tint / 100;
    const g = p.grade;
    let flags = 0;
    if (p.dehaze) flags |= 1;
    if (temp || tint || p.exposure) flags |= 2;
    if (!toneIdentity) flags |= 4;
    if (p.clarity) flags |= 8;
    if (p.texture) flags |= 16;
    if (curveMask) flags |= 32;
    if (hslActive) flags |= 64;
    if (p.saturation || p.vibrance) flags |= 128;
    if (g.shadows.s || g.midtones.s || g.highlights.s) flags |= 256;
    if (p.bw) flags |= 512;
    if (p.vignette) flags |= 1024;
    if (p.grain) flags |= 2048;

    const out = texture(gl, w, h, { filter: 'NEAREST' });
    trash.push(out);
    const fb = draw(s, programs.develop, out, (u) => {
      bindTex(gl, 0, u.uSrc, srcTex);
      bindTex(gl, 1, u.uLut, lutTex);
      bindTex(gl, 2, u.uBlurL, blurL);
      bindTex(gl, 3, u.uBlurD, blurD);
      bindTex(gl, 4, u.uBlurT, blurT);
      gl.uniform2f(u.uSize, w, h);
      gl.uniform1i(u.uFlags, flags);
      gl.uniform1i(u.uCurveMask, curveMask);
      gl.uniform1f(u.uDehaze, p.dehaze / 100);
      gl.uniform1f(u.uClarity, p.clarity / 100);
      gl.uniform1f(u.uTexture, p.texture / 100);
      gl.uniform3f(u.uWB, 1 + temp * 0.32 + tint * 0.12, 1 - tint * 0.25, 1 - temp * 0.32 + tint * 0.12);
      gl.uniform1f(u.uExp, Math.pow(2, p.exposure));
      gl.uniform1f(u.uSat, p.saturation / 100);
      gl.uniform1f(u.uVib, p.vibrance / 100);
      const bandData = new Float32Array(32);
      bands.forEach((b, i) => bandData.set([b.c, b.h, b.s, b.l], i * 4));
      gl.uniform4fv(u.uBands, bandData);
      gl.uniform3fv(u.uGS, hueRgb(g.shadows.h));
      gl.uniform3fv(u.uGM, hueRgb(g.midtones.h));
      gl.uniform3fv(u.uGH, hueRgb(g.highlights.h));
      gl.uniform3f(u.uGradeS, g.shadows.s / 100, g.midtones.s / 100, g.highlights.s / 100);
      gl.uniform1f(u.uGBal, g.balance / 100);
      gl.uniform1f(u.uVig, p.vignette / 100);
      gl.uniform1f(u.uVigMid, 0.25 + (p.vignetteMid / 100) * 0.6);
      gl.uniform1f(u.uVigFeather, 0.1 + (p.vignetteFeather / 100) * 0.7);
      gl.uniform1f(u.uGrain, p.grain / 100);
      gl.uniform1f(u.uGrainSize, Math.max(0.5, p.grainSize * scale));
    });
    trash.push(fb);
    const pixels = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.isContextLost()) return null;
    return new ImageData(pixels, w, h);
  } catch (e) {
    console.warn('Échec du rendu GPU, repli sur le CPU', e);
    return null;
  } finally {
    for (const o of trash) {
      if (o instanceof WebGLFramebuffer) gl.deleteFramebuffer(o);
      else if (o && o.t) gl.deleteTexture(o.t);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
