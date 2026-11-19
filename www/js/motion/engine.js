// Prisme Motion — moteur de rendu : évalue les calques à un instant donné et compose l'image
// sur le GPU (parentage, 3D avec perspective, masques, effets, caches de cache, modes de fusion,
// flou de mouvement, calques d'effets, pré-compositions, particules).

import { GL, M4 } from './gl.js';
import { propValue, keyedValue, isAnimated, isAnimated as M_isAnimated, layerActive, sourceTime, compById, assetById, hexToArr, EFFECTS, BLEND_INDEX, rand01, noise1, lerpValue, clamp } from './model.js';
import { rasterText, textKey, rasterShape, shapeKey, rasterMasks, LRU } from './raster.js';

const DEG = Math.PI / 180;

// Densité quantifiée (évite de re-rastériser à chaque image pendant une animation d'échelle).
const qDensity = (d) => Math.pow(2, Math.ceil(Math.log2(Math.max(0.05, d)) * 4) / 4);

export class Engine {
  constructor() {
    this.gl = new GL();
    this.raster = new LRU(160);
    this.masks = new LRU(64);
    this.frames = new Map();
    this.boxes = new Map();
    this.project = null;
    this.lastMs = 0;
    this.mbEnabled = true;
  }

  get canvas() {
    return this.gl.canvas;
  }

  // ---------- Évaluation ----------

  ctxFor(comp, layer, key) {
    return { comp, layer, key, index: comp.layers.indexOf(layer) + 1 };
  }

  pv(comp, layer, key, t, prop = layer.p[key]) {
    if (!prop) return undefined;
    return isAnimated(prop) ? propValue(prop, t, this.ctxFor(comp, layer, key)) : prop.v;
  }

  evalLayer(comp, layer, t) {
    const v = {};
    const p = layer.p;
    for (const k of ['anchor', 'position', 'posZ', 'scale', 'rotX', 'rotY', 'rotation', 'opacity']) v[k] = this.pv(comp, layer, k, t);
    const c = {};
    for (const key in p) if (key.startsWith('c.')) c[key.slice(2)] = this.pv(comp, layer, key, t);
    v.c = c;
    v.fx = [];
    for (const fx of layer.effects) {
      if (!fx.on || !EFFECTS[fx.type]) continue;
      const vals = {};
      for (const k in fx.p) vals[k] = this.pv(comp, layer, `fx.${fx.id}.${k}`, t, fx.p[k]);
      v.fx.push({ type: fx.type, vals });
    }
    v.masks = layer.masks.map((m) => {
      const vals = {};
      for (const k in m.p) vals[k] = this.pv(comp, layer, `mk.${m.id}.${k}`, t, m.p[k]);
      return { mask: m, vals };
    });
    return v;
  }

  // Matrice du calque (unités du calque → pixels de la composition), parents compris.
  matrix(comp, layer, t, depth = 0, v = null) {
    v ||= {
      anchor: this.pv(comp, layer, 'anchor', t), position: this.pv(comp, layer, 'position', t), posZ: this.pv(comp, layer, 'posZ', t),
      scale: this.pv(comp, layer, 'scale', t), rotX: this.pv(comp, layer, 'rotX', t), rotY: this.pv(comp, layer, 'rotY', t), rotation: this.pv(comp, layer, 'rotation', t),
    };
    const a = v.anchor, pos = v.position, s = v.scale;
    let m = M4.translate(pos[0], pos[1], layer.threeD ? v.posZ || 0 : 0);
    m = M4.mul(m, M4.rotZ((v.rotation || 0) * DEG));
    if (layer.threeD) {
      if (v.rotY) m = M4.mul(m, M4.rotY(v.rotY * DEG));
      if (v.rotX) m = M4.mul(m, M4.rotX(v.rotX * DEG));
    }
    m = M4.mul(m, M4.scale(s[0] / 100, s[1] / 100, 1));
    m = M4.mul(m, M4.translate(-a[0], -a[1], 0));
    if (layer.parent && depth < 16) {
      const par = comp.layers.find((l) => l.id === layer.parent);
      if (par && par !== layer) m = M4.mul(this.matrix(comp, par, t, depth + 1), m);
    }
    return m;
  }

  // Projection finale : perspective de la caméra par défaut pour les calques 3D.
  viewMatrix(comp, layer, world) {
    if (!layer.threeD) return world;
    const zoom = comp.width * 1.3889; // caméra 50 mm d'After Effects
    return M4.mul(M4.perspective(comp.width / 2, comp.height / 2, zoom), world);
  }

  // Rectangle de la source en unités du calque (avant effets).
  sourceBox(comp, layer) {
    const known = this.boxes.get(layer.id);
    if (known) return known;
    if (layer.type === 'image' || layer.type === 'video') {
      const a = assetById(this.project, layer.source);
      return [0, 0, a?.w || 100, a?.h || 100];
    }
    if (layer.type === 'comp') {
      const c = compById(this.project, layer.source);
      return [0, 0, c?.width || 100, c?.height || 100];
    }
    if (layer.type === 'solid') {
      const sz = layer.p['c.size']?.v || [comp.width, comp.height];
      return [0, 0, sz[0], sz[1]];
    }
    if (layer.type === 'null') return [0, 0, 100, 100];
    if (layer.type === 'text' || layer.type === 'shape') return [-100, -50, 200, 100];
    return [0, 0, comp.width, comp.height];
  }

  // Coins de la source dans la composition (pour la sélection et les poignées).
  corners(comp, layer, t) {
    const m = this.viewMatrix(comp, layer, this.matrix(comp, layer, t));
    const [x, y, w, h] = this.sourceBox(comp, layer);
    return [M4.apply(m, x, y), M4.apply(m, x + w, y), M4.apply(m, x + w, y + h), M4.apply(m, x, y + h)];
  }

  visibleLayers(comp, t) {
    const solo = comp.layers.some((l) => l.solo && l.visible);
    const out = [];
    for (let i = comp.layers.length - 1; i >= 0; i--) {
      const l = comp.layers[i];
      if (!layerActive(l, t)) continue;
      if (l.type === 'audio' || l.type === 'null') continue;
      // Calque servant de cache au calque situé en dessous : il n'est pas affiché lui-même.
      const below = comp.layers[i + 1];
      if (below && below.matte) continue;
      if (solo ? !l.solo : !l.visible) continue;
      out.push({ layer: l, index: i, matte: l.matte && i > 0 ? comp.layers[i - 1] : null });
    }
    return out;
  }

  // ---------- Préparation asynchrone (décodage des images vidéo) ----------

  async prepare(comp, t, depth = 0, jobs = []) {
    if (depth === 0) this.frames.clear();
    if (depth > 12) return;
    for (const { layer, matte } of this.visibleLayers(comp, t)) {
      for (const l of matte ? [layer, matte] : [layer]) {
        if (!layerActive(l, t)) continue;
        if (l.type === 'video') {
          const a = assetById(this.project, l.source);
          const r = a?.__reader;
          if (!r) continue;
          const st = sourceTime(l, t);
          const key = `${l.id}|${Math.round(st * 1e4)}`;
          if (!this.frames.has(key)) {
            this.frames.set(key, null);
            jobs.push(r.frameAt(st).then((f) => this.frames.set(key, f)).catch(() => {}));
          }
        } else if (l.type === 'comp') {
          const sub = compById(this.project, l.source);
          if (sub) await this.prepare(sub, sourceTime(l, t), depth + 1, jobs);
        }
      }
    }
    if (depth === 0) await Promise.all(jobs);
  }

  // ---------- Sources ----------

  maxScale(v) {
    return Math.max(Math.abs(v.scale[0]), Math.abs(v.scale[1])) / 100;
  }

  // Renvoie { tex, box, owned? } ou { color, box } ; box en unités du calque.
  source(comp, layer, v, t, scale, depth) {
    const gl = this.gl;
    const dens = qDensity(scale * clamp(this.maxScale(v), 0.05, 4));
    switch (layer.type) {
      case 'solid': {
        const sz = v.c.size || [comp.width, comp.height];
        const col = hexToArr(v.c.color || '#808080');
        const box = [0, 0, sz[0], sz[1]];
        this.boxes.set(layer.id, box);
        return { color: [col[0], col[1], col[2], 1], box };
      }
      case 'image': {
        const a = assetById(this.project, layer.source);
        if (!a?.__img) return null;
        const t2 = gl.staticTex(`img:${a.id}:${a.__version || 0}`, a.__img);
        return { tex: t2.tex, box: [0, 0, a.w, a.h] };
      }
      case 'video': {
        const a = assetById(this.project, layer.source);
        const st = sourceTime(layer, t);
        const f = this.frames.get(`${layer.id}|${Math.round(st * 1e4)}`);
        if (!f) return null;
        const t2 = gl.dynamicTex(`vid:${layer.id}`, f, `${st}`);
        return { tex: t2.tex, box: [0, 0, a.w, a.h] };
      }
      case 'text': {
        const key = textKey(v.c, t, dens);
        let r = this.raster.get(key);
        if (!r) {
          r = rasterText(v.c, t, dens);
          this.raster.set(key, r);
        }
        const t2 = gl.dynamicTex(`txt:${layer.id}`, r.canvas, key);
        const box = [r.x, r.y, r.w, r.h];
        this.boxes.set(layer.id, box);
        return { tex: t2.tex, box };
      }
      case 'shape': {
        const key = shapeKey(v.c, layer.path, dens);
        let r = this.raster.get(key);
        if (!r) {
          r = rasterShape(v.c, layer.path, dens);
          this.raster.set(key, r);
        }
        const t2 = gl.dynamicTex(`shp:${layer.id}`, r.canvas, key);
        const box = [r.x, r.y, r.w, r.h];
        this.boxes.set(layer.id, box);
        return { tex: t2.tex, box };
      }
      case 'comp': {
        const sub = compById(this.project, layer.source);
        if (!sub || depth > 12) return null;
        const d = Math.min(scale * clamp(this.maxScale(v), 0.1, 2), 4);
        const fb = this.renderComp(sub, sourceTime(layer, t), d, depth + 1);
        return { tex: fb.tex, box: [0, 0, sub.width, sub.height], owned: fb };
      }
      case 'particles': {
        const box = [0, 0, comp.width, comp.height];
        const d = scale;
        const fb = gl.fbo(box[2] * d, box[3] * d);
        gl.clear(fb);
        this.drawParticles(comp, layer, v, t, fb, d);
        return { tex: fb.tex, box, owned: fb };
      }
      default:
        return null;
    }
  }

  // Simulation sans état (déterministe) : chaque particule est calculée à partir de sa date de
  // naissance, ce qui permet de se déplacer librement dans le temps.
  drawParticles(comp, layer, v, t, fb, d) {
    const c = v.c;
    const lt = t - layer.start;
    const L = Math.max(0.05, c.life || 1);
    if (lt < 0) return;
    const maxN = 40000;
    // Nombre cumulé de particules émises : linéaire si le débit est fixe, intégré s'il est animé.
    const rp = layer.p['c.rate'];
    let cumAt, invCum;
    if (M_isAnimated(rp)) {
      const key = `${layer.id}:${JSON.stringify(rp.k || null)}:${rp.x || ''}`;
      let tab = this.rateTables?.get(key);
      if (!tab) {
        const dt = 1 / 240, n = Math.ceil((comp.duration + L * 2 + 1) * 240);
        const cum = new Float64Array(n + 1);
        for (let j = 1; j <= n; j++) cum[j] = cum[j - 1] + Math.max(0, this.pv(comp, layer, 'c.rate', layer.start + (j - 0.5) * dt) || 0) * dt;
        tab = { cum, dt };
        (this.rateTables ||= new Map()).set(key, tab);
        if (this.rateTables.size > 64) this.rateTables.delete(this.rateTables.keys().next().value);
      }
      const { cum, dt } = tab;
      cumAt = (x) => {
        const f = Math.max(0, x / dt), j = Math.min(cum.length - 2, Math.floor(f));
        return cum[j] + (cum[j + 1] - cum[j]) * Math.min(1, f - j);
      };
      invCum = (nn) => {
        let lo = 0, hi = cum.length - 1;
        while (hi - lo > 1) {
          const m = (lo + hi) >> 1;
          if (cum[m] <= nn) lo = m;
          else hi = m;
        }
        const d = cum[hi] - cum[lo];
        return (lo + (d > 0 ? (nn - cum[lo]) / d : 0)) * dt;
      };
    } else {
      const R = Math.max(0, c.rate || 0);
      if (R <= 0) return;
      cumAt = (x) => Math.max(0, x) * R;
      invCum = (nn) => nn / R;
    }
    const i0 = Math.max(0, Math.floor(cumAt(lt - L * 1.25))), i1 = Math.floor(cumAt(lt));
    const n = Math.min(maxN, i1 - i0 + 1);
    if (n <= 0 || i1 < 0) return;
    this.pbuf ||= new Float32Array(maxN * 4);
    this.pcol ||= new Float32Array(maxN * 3);
    const data = this.pbuf, cols = this.pcol;
    const seed = (c.seed || 0) * 13.37;
    const emProp = layer.p['c.emitter'];
    const emKeyed = emProp?.k?.length && !emProp.x;
    const em0 = c.emitter || [comp.width / 2, comp.height / 2];
    const es = c.emitSize || [0, 0];
    const c0 = hexToArr(c.colorStart || '#ffffff'), c1 = hexToArr(c.colorEnd || '#ffffff');
    const op = (c.opacity ?? 100) / 100;
    let k = 0;
    for (let i = i1; i >= i0 && k < n; i--) {
      const r = (j) => rand01(i * 7.13 + j * 91.7 + seed);
      const b = invCum(i + r(0) * 0.999);
      const life = L * (0.8 + 0.4 * r(1));
      const age = lt - b;
      if (age < 0 || age >= life) continue;
      const em = emKeyed ? keyedValue(emProp, layer.start + b) : em0;
      const x0 = em[0] + (r(2) - 0.5) * es[0], y0 = em[1] + (r(3) - 0.5) * es[1];
      const ang = ((c.direction || 0) + (r(4) - 0.5) * (c.spread || 0)) * DEG;
      const sp = (c.speed || 0) * (0.6 + 0.8 * r(5));
      const tu = c.turbulence || 0;
      const x = x0 + Math.cos(ang) * sp * age + noise1(i * 0.37 + age * 1.3) * tu * age;
      const y = y0 + Math.sin(ang) * sp * age + 0.5 * (c.gravity || 0) * age * age + noise1(i * 0.91 + age * 1.1 + 50) * tu * age;
      const u = age / life;
      const size = (c.sizeStart ?? 10) + ((c.sizeEnd ?? 0) - (c.sizeStart ?? 10)) * u;
      const fade = Math.min(1, u * 12) * (u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1);
      data[k * 4] = x;
      data[k * 4 + 1] = y;
      data[k * 4 + 2] = Math.max(0.5, size * (0.7 + 0.6 * r(6)));
      data[k * 4 + 3] = op * fade;
      const col = lerpValue(c0, c1, u);
      cols[k * 3] = col[0];
      cols[k * 3 + 1] = col[1];
      cols[k * 3 + 2] = col[2];
      k++;
    }
    const m = new Float32Array([d, 0, 0, 0, d, 0, 0, 0, 1]);
    this.gl.particles(fb, data, cols, k, { additive: !!c.additive, softness: (c.softness ?? 50) / 100, m });
  }

  // Applique masques et effets dans un tampon local au calque (avec marge pour les débordements).
  process(comp, layer, v, src, t, scale) {
    const gl = this.gl;
    const hasMasks = v.masks.some((m) => m.mask.mode !== 'none');
    if (!hasMasks && !v.fx.length) return src;
    const box = src.box;
    let pad = 0;
    for (const f of v.fx) pad += Math.max(0, EFFECTS[f.type].pad(f.vals) || 0);
    pad = Math.min(pad, 4000);
    const B = [box[0] - pad, box[1] - pad, box[2] + pad * 2, box[3] + pad * 2];
    let bs = scale * clamp(this.maxScale(v), 0.05, 2);
    const lim = Math.min(gl.maxTex, 8192);
    bs = Math.min(bs, lim / B[2], lim / B[3]);
    const buf = gl.fbo(B[2] * bs, B[3] * bs);
    gl.clear(buf);
    let mask = null;
    if (hasMasks) {
      const mbox = { x: box[0], y: box[1], w: box[2], h: box[3] };
      const ms = Math.min(bs, 4096 / Math.max(1, box[2]), 4096 / Math.max(1, box[3]));
      const key = JSON.stringify([v.masks.map((m) => [m.mask.mode, m.mask.inverted, m.mask.kind, m.mask.points, m.vals]), box, Math.round(ms * 500)]);
      let mc = this.masks.get(key);
      if (!mc) {
        mc = rasterMasks(v.masks, mbox, ms);
        this.masks.set(key, mc);
      }
      mask = gl.dynamicTex(`msk:${layer.id}`, mc, key).tex;
    }
    const mvp = M4.mul(M4.ortho(buf.w, buf.h), M4.mul(M4.scale(bs, bs), M4.translate(-B[0], -B[1])));
    gl.quad(buf, { tex: src.tex, color: src.color, box, mvp, mask }, 'over');
    if (src.owned) gl.release(src.owned);
    let cur = buf;
    const ctx = { ps: bs, src: [(box[0] - B[0]) / B[2], (box[1] - B[1]) / B[3], box[2] / B[2], box[3] / B[3]], time: t, srcH: box[3] * bs };
    for (const f of v.fx) {
      const out = gl.effect(f.type, cur, f.vals, ctx);
      gl.release(cur);
      cur = out;
    }
    return { tex: cur.tex, box: B, owned: cur };
  }

  // ---------- Composition ----------

  // Rend une composition à l'instant t ; renvoie un tampon (à libérer par l'appelant).
  renderComp(comp, t, scale, depth = 0, dims = null) {
    const gl = this.gl;
    const W = dims ? dims[0] : Math.max(1, Math.round(comp.width * scale)), H = dims ? dims[1] : Math.max(1, Math.round(comp.height * scale));
    let A = gl.fbo(W, H);
    gl.clear(A);
    const proj = M4.mul(M4.ortho(W, H), M4.scale(W / comp.width, H / comp.height));
    const fps = comp.fps || 30;
    for (const { layer, matte } of this.visibleLayers(comp, t)) {
      const v = this.evalLayer(comp, layer, t);
      const opacity = clamp((v.opacity ?? 100) / 100, 0, 1);
      if (opacity <= 0 && layer.type !== 'adjust') continue;
      if (layer.type === 'adjust') {
        A = this.adjust(comp, layer, v, t, scale, A, opacity);
        continue;
      }
      let src = this.source(comp, layer, v, t, scale, depth);
      if (!src) continue;
      src = this.process(comp, layer, v, src, t, scale);
      const world = this.matrix(comp, layer, t, 0, v);
      const draw = { tex: src.tex, color: src.color, box: src.box, mvp: M4.mul(proj, this.viewMatrix(comp, layer, world)), opacity };
      // Flou de mouvement : échantillons sur la durée d'obturation, seulement si le calque bouge.
      let samples = null;
      if (this.mbEnabled && comp.motionBlur && layer.motionBlur) {
        const N = Math.max(2, Math.min(64, comp.mbSamples || 8));
        const span = ((comp.shutter ?? 180) / 360) / fps;
        const list = [];
        const base = this.viewMatrix(comp, layer, world);
        let moves = false;
        for (let i = 0; i < N; i++) {
          const ts = t + (i / (N - 1) - 0.5) * span;
          const m = this.viewMatrix(comp, layer, this.matrix(comp, layer, ts));
          const op = clamp((this.pv(comp, layer, 'opacity', ts) ?? 100) / 100, 0, 1);
          if (!moves) {
            for (let j = 0; j < 16; j++) {
              if (Math.abs(m[j] - base[j]) > 1e-4) {
                moves = true;
                break;
              }
            }
          }
          list.push({ mvp: M4.mul(proj, m), opacity: op });
        }
        if (moves) samples = list;
      }
      const mode = layer.blend || 'normal';
      const direct = !matte && !samples && (mode === 'normal' || mode === 'add');
      if (direct) {
        gl.quad(A, draw, mode === 'add' ? 'add' : 'over');
      } else {
        let L = gl.fbo(W, H);
        gl.clear(L);
        if (samples) {
          gl.gl.blendColor(0, 0, 0, 1 / samples.length);
          for (const s of samples) gl.quad(L, { ...draw, ...s }, 'sample');
        } else gl.quad(L, draw, 'over');
        if (matte) {
          const M = this.layerToComp(comp, matte, t, scale, depth, proj, W, H);
          const out = gl.fbo(W, H);
          gl.matte(L, M, out, layer.matte);
          gl.release(M);
          gl.release(L);
          L = out;
        }
        if (mode === 'normal') gl.copy(L, A, 'over');
        else if (mode === 'add') gl.copy(L, A, 'add');
        else {
          const B = gl.fbo(W, H);
          gl.blend(A, L, B, BLEND_INDEX[mode] ?? 0, 1);
          gl.release(A);
          A = B;
        }
        gl.release(L);
      }
      if (src.owned) gl.release(src.owned);
    }
    return A;
  }

  // Calque servant de cache, rendu seul dans l'espace de la composition.
  layerToComp(comp, layer, t, scale, depth, proj, W, H) {
    const gl = this.gl;
    const M = gl.fbo(W, H);
    gl.clear(M);
    if (!layerActive(layer, t)) return M;
    const v = this.evalLayer(comp, layer, t);
    let src = this.source(comp, layer, v, t, scale, depth);
    if (!src) return M;
    src = this.process(comp, layer, v, src, t, scale);
    const world = this.matrix(comp, layer, t, 0, v);
    gl.quad(M, { tex: src.tex, color: src.color, box: src.box, mvp: M4.mul(proj, this.viewMatrix(comp, layer, world)), opacity: clamp((v.opacity ?? 100) / 100, 0, 1) }, 'over');
    if (src.owned) gl.release(src.owned);
    return M;
  }

  // Calque d'effets : applique ses effets à tout ce qui se trouve en dessous.
  adjust(comp, layer, v, t, scale, A, opacity) {
    const gl = this.gl;
    if (!v.fx.length || opacity <= 0) return A;
    let cur = gl.fbo(A.w, A.h);
    gl.copy(A, cur);
    const ctx = { ps: scale, src: [0, 0, 1, 1], time: t, srcH: A.h };
    for (const f of v.fx) {
      const out = gl.effect(f.type, cur, f.vals, ctx);
      gl.release(cur);
      cur = out;
    }
    let mask = null;
    if (v.masks.some((m) => m.mask.mode !== 'none')) {
      const key = JSON.stringify(['adj', v.masks.map((m) => [m.mask.mode, m.mask.inverted, m.mask.kind, m.mask.points, m.vals]), comp.width, comp.height, Math.round(scale * 500)]);
      let mc = this.masks.get(key);
      if (!mc) {
        mc = rasterMasks(v.masks, { x: 0, y: 0, w: comp.width, h: comp.height }, scale);
        this.masks.set(key, mc);
      }
      mask = gl.dynamicTex(`msk:${layer.id}`, mc, key).tex;
    }
    const out = gl.fbo(A.w, A.h);
    gl.mix(A, cur, out, opacity, mask);
    gl.release(cur);
    gl.release(A);
    return out;
  }

  // Rendu complet d'une image dans le canevas du moteur. `bg` : fond opaque de la composition.
  async renderFrame(comp, t, { scale = 1, bg = true, size = null } = {}) {
    if (this.gl.lost) throw new Error('Contexte graphique perdu');
    await this.prepare(comp, t);
    const t0 = performance.now();
    this.gl.stats.passes = 0;
    const W = size ? size[0] : Math.max(1, Math.round(comp.width * scale)), H = size ? size[1] : Math.max(1, Math.round(comp.height * scale));
    this.gl.resize(W, H);
    const fb = this.renderComp(comp, t, scale, 0, [W, H]);
    const col = hexToArr(comp.bg || '#000000');
    this.gl.present(fb, bg ? [col[0], col[1], col[2], 1] : [0, 0, 0, 0]);
    this.gl.release(fb);
    this.gl.gl.flush();
    this.lastMs = performance.now() - t0;
    return this.canvas;
  }

  // Libère les textures d'un élément de métrage supprimé ou remplacé.
  forgetAsset(asset) {
    this.gl.dropTex(`img:${asset.id}:`);
  }
}
