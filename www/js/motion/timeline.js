// Prisme Motion — panneau Timeline : calques, propriétés dépliables, images clés, règle temporelle,
// zone de travail, rognage et déplacement des calques, sélection et déplacement des images clés.

import { el, isMobileLayout } from '../util.js';
import { icon } from '../icons.js';
import { dropdown } from '../ui.js';
import * as M from './model.js';
import { propEditor, keyControls, exprEditor, propKey } from './widgets.js';

const ROW = 24;

export class Timeline {
  constructor(core, root) {
    this.core = core;
    this.root = root;
    this.pps = 100; // pixels par seconde
    this.fitted = false;
    this.reveal = new Map(); // id calque → null | 'all' | 'animated' | Set(clés)
    this.refreshers = [];
    this.keyEls = [];
    this.build();
    const sched = () => this.schedule();
    core.on('change', sched);
    core.on('select', sched);
    core.on('comp', () => {
      this.fitted = false;
      this.schedule();
    });
    core.on('time', () => this.onTime());
    core.on('live', () => this.refreshValues());
    core.on('cache', () => this.drawRuler());
    new ResizeObserver(() => {
      if (!this.fitted) this.fit();
      this.drawRuler();
      this.updateWidth();
    }).observe(this.scroll);
  }

  get LEFT() {
    return isMobileLayout() ? 168 : 500;
  }

  build() {
    const core = this.core;
    this.tcInput = el('button', { class: 'tl-tc', title: 'Temps courant (cliquer pour saisir)' });
    this.tcInput.onclick = () => this.editTimecode();
    this.zoom = el('input', { type: 'range', min: 0, max: 1000, value: 300, class: 'tl-zoom', title: 'Zoom temporel' });
    this.zoom.addEventListener('input', () => this.setZoomSlider());
    const btn = (ic, title, fn, cls = '') => el('button', { class: `icon-btn tl-btn ${cls}`, title, html: icon(ic, 16), onclick: fn });
    this.mbBtn = btn('motion', 'Activer le flou de mouvement de la composition', () => core.change('Flou de mouvement', () => (core.comp.motionBlur = !core.comp.motionBlur)));
    this.searchInput = el('input', { type: 'search', class: 'tl-search', placeholder: 'Rechercher…' });
    this.searchInput.addEventListener('input', () => this.schedule());
    this.searchInput.addEventListener('keydown', (e) => e.stopPropagation());
    this.bar = el('div', { class: 'tl-bar' },
      this.tcInput,
      el('span', { class: 'tl-info' }),
      this.searchInput,
      el('div', { class: 'spacer' }),
      this.mbBtn,
      btn('layers', 'Replier tous les calques', () => {
        this.reveal.clear();
        this.schedule();
      }),
      btn('key', 'Afficher les propriétés animées (U)', () => this.revealAnimated()),
      el('span', { html: icon('zoom', 14), class: 'tl-zi' }), this.zoom,
      btn('fullscreen', 'Ajuster la timeline à la composition', () => this.fit()));
    this.scroll = el('div', { class: 'tl-scroll' });
    this.inner = el('div', { class: 'tl-inner' });
    this.rulerCanvas = el('canvas', { class: 'tl-ruler-canvas' });
    this.ruler = el('div', { class: 'tl-ruler' }, this.rulerCanvas);
    this.head = el('div', { class: 'tl-row tl-head' }, el('div', { class: 'tl-left tl-left-head' }), this.ruler);
    this.rows = el('div', { class: 'tl-rows' });
    this.playhead = el('div', { class: 'tl-playhead' }, el('i'));
    this.inner.append(this.head, this.rows, this.playhead);
    this.scroll.append(this.inner);
    this.root.append(this.bar, this.scroll);
    this.scroll.addEventListener('scroll', () => {
      this.drawRuler();
    });
    // Règle : déplacer la tête de lecture ; zone de travail en haut de la règle.
    this.ruler.addEventListener('pointerdown', (e) => this.rulerDown(e));
    this.scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.altKey) {
        e.preventDefault();
        const r = this.scroll.getBoundingClientRect();
        const x = e.clientX - r.left - this.LEFT + this.scroll.scrollLeft;
        const t = x / this.pps;
        this.setPps(this.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
        this.scroll.scrollLeft = t * this.pps - (e.clientX - r.left - this.LEFT);
      }
    }, { passive: false });
    this.rows.addEventListener('pointerdown', (e) => {
      if (e.target === this.rows || e.target.classList.contains('tl-track') && !e.target.closest('.tl-layer')) {
        if (e.target.classList.contains('tl-track')) return this.marquee(e);
      }
    });
    this.scroll.addEventListener('pointerdown', (e) => {
      if (e.target === this.scroll || e.target === this.inner || e.target === this.rows) {
        this.core.selKeys.clear();
        this.core.select([]);
      }
    });
  }

  schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  fit() {
    const w = this.scroll.clientWidth - this.LEFT - 16;
    if (w <= 50) return;
    this.pps = w / Math.max(0.5, this.core.comp.duration);
    this.fitted = true;
    this.syncZoomSlider();
    this.render();
  }

  // Le curseur de zoom est logarithmique : de la composition entière jusqu'à l'image près.
  zoomRange() {
    const w = Math.max(100, this.scroll.clientWidth - this.LEFT - 16);
    const min = w / Math.max(0.5, this.core.comp.duration);
    const max = Math.max(min * 2, this.core.comp.fps * 40);
    return [min, max];
  }

  syncZoomSlider() {
    const [a, b] = this.zoomRange();
    this.zoom.value = String(Math.round((Math.log(this.pps / a) / Math.log(b / a)) * 1000));
  }

  setZoomSlider() {
    const [a, b] = this.zoomRange();
    const center = this.core.time;
    const rel = center * this.pps - this.scroll.scrollLeft;
    this.pps = a * Math.pow(b / a, Number(this.zoom.value) / 1000);
    this.fitted = false;
    this.render();
    this.scroll.scrollLeft = center * this.pps - rel;
  }

  setPps(p) {
    const [a, b] = this.zoomRange();
    this.pps = M.clamp(p, a, b);
    this.fitted = false;
    this.syncZoomSlider();
    this.render();
  }

  trackW() {
    return Math.max(this.scroll.clientWidth - this.LEFT, this.core.comp.duration * this.pps + 40);
  }

  updateWidth() {
    this.inner.style.width = `${this.LEFT + this.trackW()}px`;
    this.inner.style.setProperty('--left', `${this.LEFT}px`);
  }

  x(t) {
    return t * this.pps;
  }

  tFromClient(clientX) {
    const r = this.scroll.getBoundingClientRect();
    return (clientX - r.left - this.LEFT + this.scroll.scrollLeft) / this.pps;
  }

  editTimecode() {
    const core = this.core;
    const c = core.comp;
    const input = el('input', { class: 'tl-tc-input', value: M.timecode(core.time, c.fps) });
    this.tcInput.replaceWith(input);
    input.focus();
    input.select();
    const done = (ok) => {
      if (ok) {
        const t = M.parseTimecode(input.value, c.fps);
        if (t != null) core.setTime(t);
      }
      input.replaceWith(this.tcInput);
      this.onTime();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true), { once: true });
  }

  onTime() {
    const core = this.core;
    const c = core.comp;
    this.tcInput.textContent = M.timecode(core.time, c.fps);
    this.bar.querySelector('.tl-info').textContent = `${core.frameOf()} · ${c.fps} i/s`;
    this.playhead.style.transform = `translateX(${this.LEFT + this.x(core.time)}px)`;
    if (core.playing) {
      // Suivi automatique de la tête de lecture.
      const x = this.x(core.time), sl = this.scroll.scrollLeft, w = this.scroll.clientWidth - this.LEFT;
      if (x > sl + w - 20 || x < sl) this.scroll.scrollLeft = Math.max(0, x - 40);
    }
    if (!this.timeRaf) {
      this.timeRaf = requestAnimationFrame(() => {
        this.timeRaf = null;
        this.refreshValues();
      });
    }
  }

  refreshValues() {
    for (const f of this.refreshers) f();
  }

  revealAnimated() {
    for (const l of this.core.selectedLayers.length ? this.core.selectedLayers : this.core.comp.layers) this.reveal.set(l.id, 'animated');
    this.schedule();
  }

  revealKeys(keys) {
    const layers = this.core.selectedLayers.length ? this.core.selectedLayers : this.core.comp.layers;
    for (const l of layers) this.reveal.set(l.id, new Set(keys));
    this.schedule();
  }

  // ---------- Règle ----------

  drawRuler() {
    const core = this.core;
    const c = core.comp;
    const cv = this.rulerCanvas;
    const w = Math.max(10, this.scroll.clientWidth - this.LEFT), h = 30;
    const dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== h * dpr) {
      cv.width = Math.round(w * dpr);
      cv.height = h * dpr;
      cv.style.width = `${w}px`;
      cv.style.height = `${h}px`;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const sl = this.scroll.scrollLeft;
    const pps = this.pps;
    // Zone de travail
    const wx0 = this.x(c.workIn) - sl, wx1 = this.x(c.workOut) - sl;
    ctx.fillStyle = 'rgba(123,92,255,.35)';
    ctx.fillRect(wx0, 0, wx1 - wx0, 7);
    ctx.fillStyle = '#9d86ff';
    ctx.fillRect(wx0, 0, 3, 9);
    ctx.fillRect(wx1 - 3, 0, 3, 9);
    // Images en cache (barre verte, comme l'aperçu RAM d'After Effects)
    if (core.cache.size) {
      ctx.fillStyle = '#3ddc97';
      const fw = pps / c.fps;
      for (const f of core.cache.keys()) {
        const x = f * fw - sl;
        if (x < -fw || x > w) continue;
        ctx.fillRect(x, 26, Math.max(1, fw + 0.5), 3);
      }
    }
    // Graduations
    const fps = c.fps;
    const steps = [1 / fps, 2 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    let major = steps.find((s) => s * pps >= 70) || 600;
    const minor = steps.find((s) => s < major && s * pps >= 9 && Math.abs(major / s - Math.round(major / s)) < 1e-6) || major;
    ctx.fillStyle = '#9a9aae';
    ctx.strokeStyle = '#3a3a4a';
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const t0 = sl / pps, t1 = (sl + w) / pps;
    ctx.beginPath();
    const ratio = Math.round(major / minor);
    for (let i = Math.floor(t0 / minor); i * minor <= Math.min(t1, c.duration + minor); i++) {
      const t = i * minor;
      const x = Math.round(t * pps - sl) + 0.5;
      const isMajor = i % ratio === 0;
      ctx.moveTo(x, isMajor ? 12 : 19);
      ctx.lineTo(x, 26);
      if (isMajor) {
        const fr = Math.round(t * fps);
        const sec = Math.floor(fr / fps), ff = fr - sec * fps;
        const lab = major < 1 ? `${sec}:${String(Math.round(ff)).padStart(2, '0')}` : sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec}s`;
        ctx.fillText(lab, x + 3, 10);
      }
    }
    ctx.stroke();
    // Fin de composition
    const ex = this.x(c.duration) - sl;
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(ex, 0, w - ex, h);
  }

  rulerDown(e) {
    const core = this.core;
    const c = core.comp;
    e.preventDefault();
    const r = this.rulerCanvas.getBoundingClientRect();
    const y = e.clientY - r.top;
    const t = this.tFromClient(e.clientX);
    // Poignées de la zone de travail
    if (y < 11) {
      const near = (a) => Math.abs(this.x(a) - this.x(t)) < 8;
      const which = near(c.workIn) ? 'in' : near(c.workOut) ? 'out' : t > c.workIn && t < c.workOut ? 'move' : null;
      if (which) {
        core.beginDrag();
        const start = { t, a: c.workIn, b: c.workOut };
        const move = (ev) => {
          const tt = M.snapTime(c, this.tFromClient(ev.clientX));
          if (which === 'in') c.workIn = M.clamp(tt, 0, c.workOut - 1 / c.fps);
          else if (which === 'out') c.workOut = M.clamp(tt, c.workIn + 1 / c.fps, c.duration);
          else {
            const d = M.clamp(tt - M.snapTime(c, start.t), -start.a, c.duration - start.b);
            c.workIn = start.a + d;
            c.workOut = start.b + d;
          }
          this.drawRuler();
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          core.endDrag('Zone de travail');
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        return;
      }
    }
    core.interacting = true;
    core.setTime(t);
    const move = (ev) => core.setTime(this.tFromClient(ev.clientX));
    const up = () => {
      core.interacting = false;
      core.requestRender();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---------- Lignes ----------

  render() {
    const core = this.core;
    const c = core.comp;
    this.refreshers = [];
    this.keyEls = [];
    this.updateWidth();
    this.mbBtn.classList.toggle('active', !!c.motionBlur);
    const frag = document.createDocumentFragment();
    const q = this.searchInput.value.trim().toLowerCase();
    const mobile = isMobileLayout();
    c.layers.forEach((layer, i) => {
      if (q && !layer.name.toLowerCase().includes(q)) return;
      frag.append(this.layerRow(layer, i, mobile));
      const rev = this.reveal.get(layer.id);
      if (!rev) return;
      for (const g of M.layerGroups(layer)) {
        let items = g.props;
        if (rev === 'animated') items = items.filter((it) => M.isAnimated(M.propOf(layer, it)));
        else if (rev instanceof Set) {
          items = items.filter((it) => {
            if (g.id === 'transform') return rev.has(it.def.short) || rev.has(it.key);
            if (rev.has('E') && g.effect) return true;
            if (rev.has('M') && g.mask) return true;
            return false;
          });
        }
        if (!items.length && !(rev === 'all')) continue;
        frag.append(this.groupRow(layer, g, rev === 'all'));
        if (g.collapsed) continue;
        for (const it of items) {
          frag.append(this.propRow(layer, g, it));
          const prop = M.propOf(layer, it);
          if (prop.x != null || layer.__exprOpen?.has(propKey(it))) frag.append(this.exprRow(layer, it));
        }
      }
    });
    if (!c.layers.length) {
      frag.append(el('div', { class: 'tl-empty' }, 'Composition vide — importez un média, ou ajoutez un texte, une forme, un solide ou des particules (menu Calque).'));
    }
    this.rows.replaceChildren(frag);
    this.drawRuler();
    this.onTime();
  }

  layerRow(layer, index, mobile) {
    const core = this.core;
    const c = core.comp;
    const sel = core.selection.has(layer.id);
    const row = el('div', { class: `tl-row tl-layer${sel ? ' sel' : ''}${layer.locked ? ' locked' : ''}`, 'data-id': layer.id });
    const toggle = (ic, on, title, fn, cls = '') => el('button', { class: `sw ${on ? 'on' : ''} ${cls}`, title, html: icon(ic, 13), onclick: (e) => {
      e.stopPropagation();
      fn();
    } });
    const left = el('div', { class: 'tl-left' });
    const rev = this.reveal.get(layer.id);
    left.append(...[
      toggle(layer.visible ? 'eye' : 'eye-off', layer.visible, 'Afficher / masquer', () => core.change('Visibilité', () => (layer.visible = !layer.visible))),
      !mobile ? (['video', 'audio', 'comp'].includes(layer.type) ? toggle('music', layer.audio, 'Audio activé', () => core.change('Audio', () => (layer.audio = !layer.audio))) : el('span', { class: 'sw ph' })) : null,
      !mobile ? toggle('solo', layer.solo, 'Solo', () => core.change('Solo', () => (layer.solo = !layer.solo))) : null,
      !mobile ? toggle(layer.locked ? 'lock' : 'unlock', layer.locked, 'Verrouiller', () => core.change('Verrou', () => (layer.locked = !layer.locked))) : null,
      el('button', { class: `twirl${rev ? ' open' : ''}`, title: 'Déplier les propriétés', onclick: (e) => {
        e.stopPropagation();
        if (rev) this.reveal.delete(layer.id);
        else this.reveal.set(layer.id, 'all');
        this.schedule();
      } }, '▸'),
      el('span', { class: 'lbl', style: { background: layer.label } }),
      el('span', { class: 'num' }, String(index + 1)),
      el('span', { class: 'ty', html: icon(M.LAYER_TYPES[layer.type]?.icon || 'layers', 13) }),
    ].filter(Boolean));
    const name = el('span', { class: 'nm', title: 'Double-clic pour renommer' }, layer.name);
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const inp = el('input', { class: 'nm-input', value: layer.name });
      name.replaceWith(inp);
      inp.focus();
      inp.select();
      const done = (ok) => {
        if (ok && inp.value.trim() && inp.value !== layer.name) core.change('Renommer le calque', () => (layer.name = inp.value.trim()));
        else this.schedule();
      };
      inp.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') inp.blur();
        if (ev.key === 'Escape') {
          inp.value = layer.name;
          inp.blur();
        }
      });
      inp.addEventListener('blur', () => done(true), { once: true });
    });
    left.append(name);
    if (!mobile) {
      const mode = el('select', { class: 'mini-select tl-mode', title: 'Mode de fusion' }, ...M.BLEND_MODES.map(([k, l]) => el('option', { value: k }, l)));
      mode.value = layer.blend;
      mode.onchange = () => core.change('Mode de fusion', () => (layer.blend = mode.value));
      const matte = el('select', { class: 'mini-select tl-matte', title: 'Cache par le calque du dessus', disabled: index === 0 ? true : null }, ...M.MATTE_MODES.map(([k, l]) => el('option', { value: k }, k ? l.replace('Cache ', '') : '—')));
      matte.value = layer.matte || '';
      matte.onchange = () => core.change('Cache', () => (layer.matte = matte.value));
      const parent = el('select', { class: 'mini-select tl-parent', title: 'Parent' }, el('option', { value: '' }, 'Aucun'), ...c.layers.filter((l) => l !== layer && !isAncestor(c, layer, l)).map((l) => el('option', { value: l.id }, `${c.layers.indexOf(l) + 1}. ${l.name}`)));
      parent.value = layer.parent || '';
      parent.onchange = () => core.change('Parent', () => setParent(core, c, layer, parent.value || null));
      for (const s of [mode, matte, parent]) {
        s.addEventListener('pointerdown', (e) => e.stopPropagation());
        s.addEventListener('keydown', (e) => e.stopPropagation());
      }
      left.append(mode, matte, parent,
        toggle('fx', layer.effects.length && layer.effects.some((f) => f.on), 'Effets activés', () => core.change('Effets', () => {
          const on = !layer.effects.some((f) => f.on);
          layer.effects.forEach((f) => (f.on = on));
        }), layer.effects.length ? '' : 'dim'),
        toggle('motion', layer.motionBlur, 'Flou de mouvement', () => core.change('Flou de mouvement', () => (layer.motionBlur = !layer.motionBlur))),
        toggle('cube', layer.threeD, 'Calque 3D', () => core.change('Calque 3D', () => (layer.threeD = !layer.threeD)), 'td'));
    }
    left.addEventListener('pointerdown', (e) => {
      if (e.target.closest('select, input, button')) return;
      core.selKeys.clear();
      if (e.shiftKey && core.layer) {
        const a = c.layers.indexOf(core.layer), b = index;
        core.select(c.layers.slice(Math.min(a, b), Math.max(a, b) + 1).map((l) => l.id));
      } else core.select(layer.id, e.ctrlKey || e.metaKey);
      this.dragReorder(e, layer);
    });
    left.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!core.selection.has(layer.id)) core.select(layer.id);
      core.emit('layer-menu', { x: e.clientX, y: e.clientY });
    });
    const track = el('div', { class: 'tl-track' });
    const bar = el('div', { class: `tl-bar-layer${sel ? ' sel' : ''}`, style: { left: `${this.x(layer.in)}px`, width: `${Math.max(2, this.x(layer.out) - this.x(layer.in))}px`, '--lc': layer.label } },
      el('i', { class: 'h l' }), el('span', { class: 'bl' }, layer.name), el('i', { class: 'h r' }));
    // Forme d'onde pour l'audio
    if (layer.type === 'audio') {
      const a = M.assetById(core.project, layer.source);
      if (a?.__peaks) bar.append(waveform(a.__peaks, layer, this.pps));
    }
    bar.addEventListener('pointerdown', (e) => this.barDown(e, layer, bar));
    track.append(bar);
    // Résumé des images clés quand le calque est replié
    if (!rev) {
      const times = new Set();
      for (const { prop } of M.allProps(layer)) for (const k of prop.k || []) times.add(Math.round(k.t * c.fps));
      for (const f of times) track.append(el('i', { class: 'kf-sum', style: { left: `${this.x(f / c.fps)}px` } }));
    }
    row.append(left, track);
    return row;
  }

  // Glisser un calque verticalement pour changer l'ordre d'empilement.
  dragReorder(e, layer) {
    const core = this.core;
    const c = core.comp;
    const y0 = e.clientY;
    let started = false, marker = null, target = -1;
    const move = (ev) => {
      if (!started && Math.abs(ev.clientY - y0) < 6) return;
      if (layer.locked) return;
      started = true;
      const rows = [...this.rows.querySelectorAll('.tl-layer')];
      target = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          target = i;
          break;
        }
      }
      marker ||= this.rows.appendChild(el('div', { class: 'tl-drop' }));
      const ref = rows[target] || rows[rows.length - 1];
      const rr = ref.getBoundingClientRect(), pr = this.rows.getBoundingClientRect();
      marker.style.top = `${(rows[target] ? rr.top : rr.bottom) - pr.top}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      marker?.remove();
      if (!started || target < 0) return;
      const ids = core.selectedLayers.map((l) => l.id);
      core.change('Ordre des calques', () => {
        const moving = c.layers.filter((l) => ids.includes(l.id));
        const before = c.layers[target];
        const rest = c.layers.filter((l) => !ids.includes(l.id));
        let idx = before ? rest.indexOf(before) : rest.length;
        if (idx < 0) idx = rest.length;
        rest.splice(idx, 0, ...moving);
        c.layers = rest;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Déplacement / rognage d'un calque dans le temps.
  barDown(e, layer, bar) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const core = this.core;
    const c = core.comp;
    if (!core.selection.has(layer.id)) core.select(layer.id, e.ctrlKey || e.metaKey || e.shiftKey);
    if (layer.locked) return;
    const mode = e.target.classList.contains('l') ? 'in' : e.target.classList.contains('r') ? 'out' : 'move';
    const t0 = this.tFromClient(e.clientX);
    const layers = mode === 'move' ? core.selectedLayers.filter((l) => !l.locked) : [layer];
    const orig = layers.map((l) => ({ l, in: l.in, out: l.out, start: l.start, keys: M.allProps(l).flatMap(({ prop }) => (prop.k || []).map((k) => [k, k.t])) }));
    const snapPts = [0, c.duration, core.time, ...c.layers.filter((l) => !layers.includes(l)).flatMap((l) => [l.in, l.out])];
    let moved = false;
    const move = (ev) => {
      let d = this.tFromClient(ev.clientX) - t0;
      if (!moved && Math.abs(d * this.pps) < 3) return;
      if (!moved) {
        moved = true;
        core.beginDrag();
      }
      const fd = 1 / c.fps;
      d = Math.round(d / fd) * fd;
      // Aimantation aux bords des autres calques et à la tête de lecture.
      if (!ev.shiftKey) {
        const ref = mode === 'out' ? orig[0].out : orig[0].in;
        for (const p of snapPts) {
          if (Math.abs((ref + d - p) * this.pps) < 7) {
            d = p - ref;
            break;
          }
          if (mode === 'move' && Math.abs((orig[0].out + d - p) * this.pps) < 7) {
            d = p - orig[0].out;
            break;
          }
        }
      }
      for (const o of orig) {
        const l = o.l;
        if (mode === 'move') {
          l.in = o.in + d;
          l.out = o.out + d;
          l.start = o.start + d;
          for (const [k, t] of o.keys) k.t = t + d;
        } else if (mode === 'in') {
          l.in = M.clamp(o.in + d, mediaMin(core, l), o.out - fd);
        } else {
          l.out = M.clamp(o.out + d, o.in + fd, mediaMax(core, l));
        }
      }
      bar.style.left = `${this.x(layer.in)}px`;
      bar.style.width = `${Math.max(2, this.x(layer.out) - this.x(layer.in))}px`;
      core.live();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) core.endDrag(mode === 'move' ? 'Déplacer le calque' : 'Rogner le calque');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  groupRow(layer, g) {
    const core = this.core;
    const row = el('div', { class: 'tl-row tl-group' });
    const left = el('div', { class: 'tl-left' }, el('span', { class: 'ind' }), el('span', { class: 'gname' }, g.label));
    if (g.effect) {
      const fx = g.effect;
      left.prepend(el('button', { class: `sw ${fx.on ? 'on' : ''}`, title: 'Activer l’effet', html: icon('fx', 13), onclick: () => core.change('Effet', () => (fx.on = !fx.on)) }));
      left.append(el('button', { class: 'mini-btn', title: 'Supprimer l’effet', html: icon('trash', 12), onclick: () => core.change('Supprimer l’effet', () => (layer.effects = layer.effects.filter((f) => f !== fx))) }));
    }
    if (g.mask) {
      const m = g.mask;
      const mode = el('select', { class: 'mini-select' }, ...M.MASK_MODES.map(([k, l]) => el('option', { value: k }, l)));
      mode.value = m.mode;
      mode.onchange = () => core.change('Mode du masque', () => (m.mode = mode.value));
      const inv = el('label', { class: 'mini-check' }, el('input', { type: 'checkbox', checked: m.inverted ? true : null, onchange: (e) => core.change('Inverser le masque', () => (m.inverted = e.target.checked)) }), 'Inv.');
      left.append(mode, inv, el('button', { class: 'mini-btn', title: 'Supprimer le masque', html: icon('trash', 12), onclick: () => core.change('Supprimer le masque', () => (layer.masks = layer.masks.filter((x) => x !== m))) }));
    }
    row.append(left, el('div', { class: 'tl-track' }));
    return row;
  }

  propRow(layer, g, it) {
    const core = this.core;
    const c = core.comp;
    const prop = M.propOf(layer, it);
    const row = el('div', { class: 'tl-row tl-prop' });
    const kc = keyControls(core, layer, it);
    const ed = propEditor(core, layer, it, { compact: true });
    const exprBtn = !['select', 'bool', 'text'].includes(it.def.type) ? el('button', { class: `mini-btn expr-btn${prop.x ? ' on' : ''}`, title: 'Expression', html: icon('expr', 12), onclick: () => {
      layer.__exprOpen ||= new Set();
      const k = propKey(it);
      if (layer.__exprOpen.has(k)) layer.__exprOpen.delete(k);
      else layer.__exprOpen.add(k);
      this.schedule();
    } }) : null;
    const left = el('div', { class: 'tl-left' }, el('span', { class: 'ind2' }), kc.el, el('span', { class: 'pname', title: it.def.label }, it.def.label), exprBtn, ed.el);
    this.refreshers.push(kc.refresh, ed.refresh);
    const track = el('div', { class: 'tl-track' });
    for (const key of prop.k || []) {
      const d = el('i', { class: `kf e-${key.e}${this.isSel(prop, key) ? ' sel' : ''}`, style: { left: `${this.x(key.t)}px` }, title: `${M.timecode(key.t, c.fps)} · ${M.EASINGS[key.e]?.label || ''}` });
      d.addEventListener('pointerdown', (e) => this.keyDown(e, layer, prop, key, d));
      d.addEventListener('dblclick', () => core.setTime(key.t));
      d.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!this.isSel(prop, key)) {
          core.selKeys.clear();
          core.selKeys.add({ prop, key });
        }
        this.keyMenu(e);
      });
      this.keyEls.push({ d, prop, key });
      track.append(d);
    }
    row.append(left, track);
    return row;
  }

  exprRow(layer, it) {
    const ex = exprEditor(this.core, layer, it);
    this.refreshers.push(ex.refresh);
    return el('div', { class: 'tl-row tl-expr' }, el('div', { class: 'tl-left' }, el('span', { class: 'ind2' }), ex.el), el('div', { class: 'tl-track' }));
  }

  isSel(prop, key) {
    for (const s of this.core.selKeys) if (s.key === key) return true;
    return false;
  }

  keyDown(e, layer, prop, key, d) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const core = this.core;
    const c = core.comp;
    if (!this.isSel(prop, key)) {
      if (!e.shiftKey) core.selKeys.clear();
      core.selKeys.add({ prop, key });
    } else if (e.shiftKey) {
      for (const s of core.selKeys) if (s.key === key) core.selKeys.delete(s);
    }
    this.paintKeySel();
    const t0 = this.tFromClient(e.clientX);
    const sel = [...core.selKeys].map((s) => ({ ...s, t: s.key.t }));
    let moved = false;
    const move = (ev) => {
      let dt = this.tFromClient(ev.clientX) - t0;
      if (!moved && Math.abs(dt * this.pps) < 3) return;
      if (!moved) {
        moved = true;
        core.beginDrag();
      }
      dt = Math.round(dt * c.fps) / c.fps;
      const own = sel.find((s) => s.key === key);
      // Aimantation à la tête de lecture
      if (!ev.shiftKey && own && Math.abs((own.t + dt - core.time) * this.pps) < 6) dt = core.time - own.t;
      for (const s of sel) s.key.t = Math.max(0, s.t + dt);
      for (const s of sel) s.prop.k.sort((a, b) => a.t - b.t);
      for (const k of this.keyEls) k.d.style.left = `${this.x(k.key.t)}px`;
      core.live();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) {
        // Fusionne les images clés tombées au même instant.
        for (const s of sel) {
          const same = s.prop.k.filter((k) => Math.abs(k.t - s.key.t) < 1e-4);
          if (same.length > 1) s.prop.k = s.prop.k.filter((k) => k === s.key || Math.abs(k.t - s.key.t) >= 1e-4);
        }
        core.endDrag('Déplacer les images clés');
      } else core.emit('select');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  paintKeySel() {
    for (const k of this.keyEls) k.d.classList.toggle('sel', this.isSel(k.prop, k.key));
  }

  // Sélection rectangulaire des images clés.
  marquee(e) {
    const core = this.core;
    if (!e.shiftKey) core.selKeys.clear();
    const box = this.inner.appendChild(el('div', { class: 'tl-marquee' }));
    const ir = this.inner.getBoundingClientRect();
    const x0 = e.clientX - ir.left, y0 = e.clientY - ir.top;
    const move = (ev) => {
      const ir2 = this.inner.getBoundingClientRect();
      const x1 = ev.clientX - ir2.left, y1 = ev.clientY - ir2.top;
      Object.assign(box.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
      const br = box.getBoundingClientRect();
      for (const k of this.keyEls) {
        const r = k.d.getBoundingClientRect();
        const inside = r.right > br.left && r.left < br.right && r.bottom > br.top && r.top < br.bottom;
        const has = this.isSel(k.prop, k.key);
        if (inside && !has) core.selKeys.add({ prop: k.prop, key: k.key });
      }
      this.paintKeySel();
    };
    const up = () => {
      box.remove();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  keyMenu(e) {
    const core = this.core;
    const setEase = (ease) => core.change('Interpolation', () => {
      for (const s of core.selKeys) s.key.e = ease;
    });
    dropdown({ x: e.clientX, y: e.clientY }, [
      { head: `${core.selKeys.size} image(s) clé(s)` },
      ...Object.entries(M.EASINGS).map(([k, v]) => ({ label: v.label, shortcut: v.key || '', action: () => setEase(k) })),
      { sep: true },
      { label: 'Supprimer', icon: 'trash', shortcut: 'Suppr', action: () => core.emit('delete-keys') },
    ]);
  }
}

function waveform(peaks, layer, pps) {
  const w = Math.max(2, Math.round((layer.out - layer.in) * pps));
  const c = el('canvas', { class: 'wave' });
  c.width = Math.min(w, 4000);
  c.height = 18;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,.55)';
  for (let x = 0; x < c.width; x++) {
    const v = peaks[Math.floor((x / c.width) * peaks.length)] || 0;
    ctx.fillRect(x, 9 - v * 9, 1, Math.max(1, v * 18));
  }
  return c;
}

function isAncestor(comp, layer, other) {
  let p = other, n = 0;
  while (p && n++ < 32) {
    if (p.parent === layer.id) return true;
    p = comp.layers.find((l) => l.id === p.parent);
  }
  return false;
}

// Rattache un calque à un parent en conservant sa position à l'écran (comme After Effects).
export function setParent(core, comp, layer, parentId) {
  const eng = core.engine;
  const t = core.time;
  const before = eng.matrix(comp, layer, t);
  layer.parent = parentId;
  const parentM = parentId ? eng.matrix(comp, comp.layers.find((l) => l.id === parentId), t) : null;
  // Position de l'ancre dans l'espace du parent
  const a = layer.p.anchor.v;
  const [wx, wy] = [before[0] * a[0] + before[4] * a[1] + before[12], before[1] * a[0] + before[5] * a[1] + before[13]];
  const local = parentM ? (() => {
    const inv = (m) => {
      const det = m[0] * m[5] - m[1] * m[4] || 1e-9;
      return [(wx - m[12]) * m[5] / det - (wy - m[13]) * m[4] / det, (wy - m[13]) * m[0] / det - (wx - m[12]) * m[1] / det];
    };
    return inv(parentM);
  })() : [wx, wy];
  if (!layer.p.position.k?.length) layer.p.position.v = local;
  // Échelle et rotation relatives au parent
  if (parentM && !layer.p.scale.k?.length && !layer.p.rotation.k?.length) {
    const ps = Math.hypot(parentM[0], parentM[1]), pr = Math.atan2(parentM[1], parentM[0]);
    layer.p.scale.v = layer.p.scale.v.map((s) => s / (ps || 1));
    layer.p.rotation.v -= (pr * 180) / Math.PI;
  } else if (!parentM && !layer.p.scale.k?.length && !layer.p.rotation.k?.length) {
    const s = Math.hypot(before[0], before[1]) / Math.max(1e-6, Math.abs(layer.p.scale.v[0]) / 100);
    const r = Math.atan2(before[1], before[0]);
    layer.p.scale.v = layer.p.scale.v.map((x) => x * s);
    layer.p.rotation.v = (r * 180) / Math.PI;
  }
}

function mediaMin(core, l) {
  if (l.type === 'video' || l.type === 'audio') return l.start;
  return -1e6;
}

function mediaMax(core, l) {
  if (l.type === 'video' || l.type === 'audio') {
    const a = M.assetById(core.project, l.source);
    if (a?.duration) return l.start + a.duration / (l.speed || 1);
  }
  if (l.type === 'comp') {
    const sub = M.compById(core.project, l.source);
    if (sub) return l.start + sub.duration / (l.speed || 1);
  }
  return 1e6;
}
