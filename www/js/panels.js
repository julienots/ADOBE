// Panneaux latéraux : Calques, Réglages (développement), Looks, Filtres, Historique, Infos.

import { el, $, clamp, createCanvas, makeProxy, getData, canvasFromData, blendWithSelection, debounce, rafThrottle, resizeCanvas } from './util.js';
import { icon } from './icons.js';
import { BLEND_MODES } from './doc.js';
import {
  develop, defaultParams, cloneParams, isDefault, withDefaults, scaleParams, autoParams, LOOKS, HSL_BANDS,
} from './develop.js';
import { curveLUT, histogram } from './imaging.js';
import { FILTERS, FILTER_CATEGORIES } from './filters.js';
import { busy, toast, dropdown, promptDialog } from './ui.js';
import { selectionFromLayerAlpha } from './selection.js';

// ======================================================================
// Session de développement (partagée par les panneaux Réglages et Looks)
// ======================================================================

export class DevelopSession {
  constructor(app) {
    this.app = app;
    this.params = defaultParams();
    this.layerId = null;
    this.look = 'none';
    this.lookAmount = 100;
    this.lookBase = null;
    this.schedule = rafThrottle(() => this.render());
  }

  get active() {
    return !!this.layerId;
  }

  // Prépare l'aperçu sur une version réduite du calque actif.
  ensure() {
    const app = this.app;
    const layer = app.doc?.active;
    if (!layer) return false;
    if (this.layerId === layer.id && this.srcCanvas === layer.canvas) return true;
    if (this.layerId) this.cancel();
    if (layer.locked) {
      toast('Le calque est verrouillé 🔒');
      return false;
    }
    if (app.pending && app.pending !== this) app.flushPending();
    const proxy = makeProxy(layer.canvas, 1_400_000);
    this.layerId = layer.id;
    this.srcCanvas = layer.canvas;
    this.proxy = proxy;
    this.srcData = getData(proxy.canvas);
    this.hist = histogram(this.srcData, 2);
    app.pending = this;
    return true;
  }

  update() {
    if (!this.ensure()) return;
    this.schedule();
  }

  render() {
    if (!this.layerId) return;
    const app = this.app;
    if (isDefault(this.params)) {
      app.setPreview(null);
      app.emit('develop-changed');
      return;
    }
    const out = canvasFromData(develop(this.srcData, this.params, this.proxy.scale));
    const sel = app.doc.selection;
    app.setPreview({ layerId: this.layerId, canvas: sel ? blendWithSelection(this.proxy.canvas, out, sel) : out });
    app.emit('develop-changed');
  }

  setParams(p) {
    this.params = p;
    this.update();
  }

  commit() {
    const app = this.app;
    if (!this.layerId) return;
    const layer = app.doc.layerById(this.layerId);
    const params = this.params;
    this.committing = true;
    this.reset();
    if (layer && !isDefault(params)) {
      const full = canvasFromData(develop(getData(layer.canvas), params, 1));
      app.history.push('Réglages photo');
      const sel = app.doc.selection;
      layer.canvas = sel ? blendWithSelection(layer.canvas, full, sel) : full;
      layer.text = null;
      app.invalidate(true);
    }
    this.committing = false;
    app.emit('develop-changed');
  }

  cancel() {
    this.reset();
    this.app.emit('develop-changed');
  }

  reset() {
    this.layerId = null;
    this.srcCanvas = null;
    this.srcData = null;
    this.params = defaultParams();
    this.look = 'none';
    this.lookAmount = 100;
    this.lookBase = null;
    if (this.app.pending === this) this.app.pending = null;
    this.app.setPreview(null);
  }

  applyLook(look) {
    if (!this.ensure()) return;
    this.look = look.id;
    this.lookBase = look.auto ? autoParams(this.srcData) : withDefaults(look.params);
    this.params = scaleParams(this.lookBase, this.lookAmount / 100);
    this.update();
  }

  setLookAmount(v) {
    this.lookAmount = v;
    if (this.lookBase) {
      this.params = scaleParams(this.lookBase, v / 100);
      this.update();
    }
  }
}

// ======================================================================
// Composants de base
// ======================================================================

function section(title, body, { closed = false, id } = {}) {
  const key = `prisme.sec.${id || title}`;
  const stored = localStorage.getItem(key);
  const s = el('div', { class: `section${(stored == null ? closed : stored === '1') ? ' closed' : ''}` });
  const head = el('div', { class: 'section-head' }, title);
  head.addEventListener('click', () => {
    s.classList.toggle('closed');
    localStorage.setItem(key, s.classList.contains('closed') ? '1' : '0');
  });
  s.append(head, el('div', { class: 'section-body' }, body));
  return s;
}

// Ligne curseur + valeur numérique ; double-clic = valeur par défaut.
export function sliderRow({ label, min, max, step = 1, value, def = 0, track, onInput, format }) {
  const row = el('div', { class: `slider-row${value !== def ? ' changed' : ''}` });
  const range = el('input', { type: 'range', min, max, step, value });
  if (track) range.style.setProperty('--track', track);
  const fmt = format || ((v) => (step < 1 ? Number(v).toFixed(step < 0.1 ? 2 : 1) : String(Math.round(v))));
  const num = el('input', { class: 'num', type: 'text', inputmode: 'decimal', value: fmt(value) });
  const set = (v, fromNum) => {
    v = clamp(Number(v), min, max);
    if (Number.isNaN(v)) return;
    range.value = v;
    if (!fromNum || document.activeElement !== num) num.value = fmt(v);
    row.classList.toggle('changed', v !== def);
    onInput(v);
  };
  range.addEventListener('input', () => set(range.value));
  range.addEventListener('dblclick', () => set(def));
  num.addEventListener('change', () => set(num.value.replace(',', '.'), true));
  num.addEventListener('focus', () => num.select());
  row.append(el('label', { ondblclick: () => set(def) }, label), num, range);
  row.setValue = (v) => {
    range.value = v;
    num.value = fmt(v);
    row.classList.toggle('changed', v !== def);
  };
  return row;
}

function segmented(options, value, onChange) {
  const seg = el('div', { class: 'seg' });
  for (const [v, l] of options) {
    const b = el('button', { class: v === value ? 'on' : '' }, l);
    b.addEventListener('click', () => {
      [...seg.children].forEach((c) => c.classList.remove('on'));
      b.classList.add('on');
      onChange(v);
    });
    seg.append(b);
  }
  return seg;
}

// ======================================================================
// Panneau Calques
// ======================================================================

export function layersPanel(app, actions) {
  const root = el('div');
  const render = () => {
    root.innerHTML = '';
    const doc = app.doc;
    if (!doc) return root.append(el('p', { class: 'hint' }, 'Aucun document ouvert.'));
    const layer = doc.active;

    // Propriétés du calque actif
    const blend = el('select', {}, ...BLEND_MODES.map(([v, l]) => el('option', { value: v, selected: layer && layer.blend === v ? true : null }, l)));
    blend.addEventListener('change', () => {
      app.history.push('Mode de fusion');
      layer.blend = blend.value;
      app.invalidate(true);
    });
    let opacityPushed = false;
    const opacity = sliderRow({
      label: 'Opacité', min: 0, max: 100, value: Math.round((layer?.opacity ?? 1) * 100), def: 100,
      format: (v) => `${Math.round(v)} %`,
      onInput: (v) => {
        if (!opacityPushed) {
          app.history.push('Opacité du calque');
          opacityPushed = true;
          setTimeout(() => (opacityPushed = false), 800);
        }
        layer.opacity = v / 100;
        app.invalidate();
      },
    });
    root.append(el('div', { class: 'layer-props' }, el('label', {}, 'Mode de fusion', blend), el('div', {}, opacity)));

    const list = el('div', { class: 'layer-list' });
    const layers = [...doc.layers].reverse();
    for (const l of layers) list.append(layerRow(app, actions, l, render));
    root.append(list);

    const tb = (name, title, fn) => el('button', { class: 'icon-btn', title, html: icon(name, 18), onclick: fn });
    root.append(el('div', { class: 'layer-tools' },
      tb('plus', 'Nouveau calque', () => actions.run('layer.new')),
      tb('copy', 'Dupliquer', () => actions.run('layer.duplicate')),
      tb('mask', 'Ajouter un masque', () => actions.run(layer?.mask ? 'mask.toggle' : 'mask.add')),
      tb('fx', 'Effets du calque', () => actions.run('layer.effects')),
      tb('merge', 'Fusionner vers le bas', () => actions.run('layer.mergeDown')),
      tb('up', 'Monter', () => actions.run('layer.up')),
      tb('down', 'Descendre', () => actions.run('layer.down')),
      tb('trash', 'Supprimer', () => actions.run('layer.delete')),
      tb('more', 'Plus…', (e) => dropdown(e.currentTarget, actions.layerMenu()))));
    if (doc.editMask) root.append(el('p', { class: 'hint' }, '✏️ Édition du masque : peignez en noir pour masquer, en blanc pour révéler.'));
  };
  const rerender = debounce(render, 30);
  app.on('layers', rerender);
  app.on('document', rerender);
  app.on('document-restored', rerender);
  app.on('doc', updateThumbs);
  function updateThumbs() {
    for (const row of root.querySelectorAll('.layer-row')) row.refreshThumb?.();
  }
  render();
  return root;
}

function thumbCanvas(src, w = 88, h = 68, mask = false) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  const k = Math.min(w / src.width, h / src.height);
  const dw = src.width * k, dh = src.height * k;
  if (mask) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
  return c;
}

function layerRow(app, actions, l, rerender) {
  const doc = app.doc;
  const on = l.id === doc.activeId;
  const row = el('div', { class: `layer-row${on ? ' on' : ''}`, 'data-id': l.id });
  const vis = el('button', { class: 'vis', title: l.visible ? 'Masquer' : 'Afficher', html: icon(l.visible ? 'eye' : 'eye-off', 16) });
  vis.addEventListener('click', (e) => {
    e.stopPropagation();
    app.history.push(l.visible ? 'Masquer le calque' : 'Afficher le calque');
    l.visible = !l.visible;
    app.invalidate(true);
  });
  const thumb = thumbCanvas(l.canvas);
  thumb.className = `thumb${on && !doc.editMask ? ' edit' : ''}`;
  thumb.title = 'Ctrl + clic : sélectionner les pixels';
  thumb.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.stopPropagation();
      app.history.push('Sélection depuis le calque');
      doc.selection = selectionFromLayerAlpha(doc, l);
      app.invalidate();
      return;
    }
    if (doc.editMask) {
      doc.editMask = false;
      app.emit('layers');
    }
  });
  let mthumb = el('span');
  if (l.mask) {
    mthumb = thumbCanvas(l.mask, 68, 68, true);
    mthumb.className = `mthumb${on && doc.editMask ? ' edit' : ''}`;
    mthumb.title = 'Cliquer pour peindre dans le masque · Maj + clic : désactiver';
    if (!l.maskEnabled) mthumb.style.opacity = 0.35;
    mthumb.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.shiftKey) {
        app.history.push('Activer / désactiver le masque');
        l.maskEnabled = !l.maskEnabled;
        app.invalidate(true);
        return;
      }
      doc.activeId = l.id;
      doc.editMask = true;
      app.emit('layers');
    });
  }
  const name = el('div', { style: { minWidth: 0 } },
    el('div', { class: 'lname' }, l.text ? `T  ${l.name}` : l.name),
    el('div', { class: 'lmeta' }, `${BLEND_MODES.find(([v]) => v === l.blend)?.[1] || ''} · ${Math.round(l.opacity * 100)} %`));
  name.addEventListener('dblclick', async (e) => {
    e.stopPropagation();
    if (l.text) {
      doc.activeId = l.id;
      return app.tools.text.edit(l);
    }
    const n = await promptDialog('Renommer le calque', 'Nom', l.name);
    if (n) {
      app.history.push('Renommer');
      l.name = n;
      app.emit('layers');
    }
  });
  const fxOn = l.effects && (l.effects.shadow.enabled || l.effects.glow.enabled || l.effects.stroke.enabled);
  const badges = el('div', { class: 'badges' },
    fxOn ? el('span', { html: icon('fx', 14), title: 'Effets' }) : null,
    el('button', { class: 'vis', title: l.locked ? 'Déverrouiller' : 'Verrouiller', html: icon(l.locked ? 'lock' : 'unlock', 14), style: { opacity: l.locked ? 1 : 0.35, width: '22px' },
      onclick: (e) => {
        e.stopPropagation();
        app.history.push(l.locked ? 'Déverrouiller' : 'Verrouiller');
        l.locked = !l.locked;
        app.emit('layers');
      } }),
    el('span', { class: 'drag-handle', title: 'Glisser pour réordonner', style: { cursor: 'grab', padding: '0 4px', touchAction: 'none', color: 'var(--faint)' } }, '⋮⋮'));
  row.append(vis, thumb, mthumb, name, badges);
  row.addEventListener('click', () => {
    if (doc.activeId !== l.id) {
      app.flushPending();
      doc.activeId = l.id;
      doc.editMask = false;
      app.emit('layers');
      app.emit('active-layer');
    }
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    doc.activeId = l.id;
    app.emit('layers');
    dropdown({ x: e.clientX, y: e.clientY }, actions.layerMenu());
  });
  row.refreshThumb = () => {
    const t = thumbCanvas(l.canvas);
    thumb.getContext('2d').clearRect(0, 0, thumb.width, thumb.height);
    thumb.getContext('2d').drawImage(t, 0, 0);
  };

  // Réordonner par glisser-déposer (souris et tactile) via la poignée
  const handle = badges.querySelector('.drag-handle');
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    row.classList.add('dragging');
    const list = row.parentElement;
    let target = null, before = false;
    const mv = (ev) => {
      for (const r of list.children) r.classList.remove('drop-before', 'drop-after');
      const over = [...list.children].find((r) => {
        const b = r.getBoundingClientRect();
        return ev.clientY >= b.top && ev.clientY <= b.bottom;
      });
      if (over && over !== row) {
        const b = over.getBoundingClientRect();
        before = ev.clientY < b.top + b.height / 2;
        over.classList.add(before ? 'drop-before' : 'drop-after');
        target = over;
      } else target = null;
    };
    const upFn = () => {
      handle.removeEventListener('pointermove', mv);
      handle.removeEventListener('pointerup', upFn);
      row.classList.remove('dragging');
      if (target) {
        const targetId = target.dataset.id;
        app.history.push('Réordonner les calques');
        const from = doc.layers.findIndex((x) => x.id === l.id);
        const [moved] = doc.layers.splice(from, 1);
        let to = doc.layers.findIndex((x) => x.id === targetId);
        // La liste affichée est inversée : « avant » visuel = au-dessus = index + 1
        if (before) to += 1;
        doc.layers.splice(to, 0, moved);
        app.invalidate(true);
      }
      rerender();
    };
    handle.addEventListener('pointermove', mv);
    handle.addEventListener('pointerup', upFn);
  });
  return row;
}

// ======================================================================
// Panneau Réglages (Développement)
// ======================================================================

const TRACKS = {
  temperature: 'linear-gradient(90deg,#3a7bff,#d9d9d9,#ffc23a)',
  tint: 'linear-gradient(90deg,#39c06b,#d9d9d9,#e04bd8)',
  exposure: 'linear-gradient(90deg,#111,#eee)',
  saturation: 'linear-gradient(90deg,#888,#ff4d4d,#ffd84d,#4dff88,#4da3ff)',
  vibrance: 'linear-gradient(90deg,#888,#ff7a4d,#4da3ff)',
  hue: 'linear-gradient(90deg,red,#ff0,lime,cyan,blue,#f0f,red)',
};

export function developPanel(app, session) {
  const root = el('div');
  let rows = {};
  const p = () => session.params;

  const setParam = (path, v) => {
    if (!session.ensure()) return;
    const parts = path.split('.');
    let o = session.params;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = v;
    session.look = 'custom';
    session.update();
  };
  const get = (path) => path.split('.').reduce((o, k) => o[k], p());

  const slider = (path, label, min, max, step = 1, extra = {}) => {
    const r = sliderRow({ label, min, max, step, value: get(path), def: get.call(null, path) === undefined ? 0 : defaultAt(path), onInput: (v) => setParam(path, v), ...extra });
    rows[path] = r;
    return r;
  };

  const render = () => {
    rows = {};
    root.innerHTML = '';
    if (!app.doc) return root.append(el('p', { class: 'hint' }, 'Ouvrez une photo pour commencer.'));
    const top = el('div', { class: 'row', style: { marginBottom: '6px' } },
      el('button', { class: 'btn small', onclick: () => {
        if (!session.ensure()) return;
        session.params = autoParams(session.srcData);
        session.update();
        render();
        toast('Réglages automatiques appliqués ✨');
      } }, '✨ Auto'),
      el('button', { class: 'btn small', onclick: () => {
        session.params = defaultParams();
        session.update();
        render();
      } }, 'Réinitialiser'),
      el('label', { class: 'check', style: { marginLeft: 'auto' } }, (() => {
        const cb = el('input', { type: 'checkbox', checked: p().bw });
        cb.addEventListener('change', () => setParam('bw', cb.checked));
        return cb;
      })(), 'Noir & blanc'));
    root.append(top);
    const sel = !!app.doc.selection;
    root.append(el('div', { class: 'row', style: { marginBottom: '6px', fontSize: '12px', color: 'var(--muted)' } }, 'Appliquer à :',
      el('div', { class: 'seg' },
        el('button', { class: sel ? '' : 'on', onclick: () => app.actions.run('sel.none') }, 'Tout'),
        el('button', { onclick: () => app.actions.run('ai.selectSubject') }, '✨ Sujet'),
        el('button', { onclick: () => app.actions.run('ai.selectBackground') }, '✨ Arrière-plan'),
        sel ? el('button', { class: 'on' }, 'Sélection') : null)));

    root.append(section('Lumière', el('div', {},
      slider('exposure', 'Exposition', -5, 5, 0.01, { track: TRACKS.exposure }),
      slider('contrast', 'Contraste', -100, 100),
      slider('highlights', 'Hautes lumières', -100, 100),
      slider('shadows', 'Ombres', -100, 100),
      slider('whites', 'Blancs', -100, 100),
      slider('blacks', 'Noirs', -100, 100))));

    root.append(section('Couleur', el('div', {},
      slider('temperature', 'Température', -100, 100, 1, { track: TRACKS.temperature }),
      slider('tint', 'Teinte', -100, 100, 1, { track: TRACKS.tint }),
      slider('vibrance', 'Vibrance', -100, 100, 1, { track: TRACKS.vibrance }),
      slider('saturation', 'Saturation', -100, 100, 1, { track: TRACKS.saturation }))));

    root.append(section('Présence', el('div', {},
      slider('texture', 'Texture', -100, 100),
      slider('clarity', 'Clarté', -100, 100),
      slider('dehaze', 'Correction du voile', -100, 100))));

    root.append(section('Courbe des tonalités', curveEditor(app, session, setParam), { closed: true, id: 'curve' }));
    root.append(section('Couleurs TSL', hslEditor(session, setParam), { closed: true, id: 'hsl' }));
    root.append(section('Étalonnage des couleurs', gradeEditor(session, setParam, slider), { closed: true, id: 'grade' }));

    root.append(section('Détail', el('div', {},
      slider('sharpen', 'Netteté', 0, 150),
      slider('sharpenRadius', 'Rayon', 0.5, 3, 0.1, { def: 1 }),
      slider('noise', 'Réduction du bruit', 0, 100),
      slider('colorNoise', 'Bruit de couleur', 0, 100)), { closed: true, id: 'detail' }));

    root.append(section('Effets', el('div', {},
      slider('vignette', 'Vignetage', -100, 100),
      slider('vignetteMid', 'Point médian', 0, 100, 1, { def: 50 }),
      slider('vignetteFeather', 'Contour progressif', 0, 100, 1, { def: 50 }),
      slider('grain', 'Grain', 0, 100),
      slider('grainSize', 'Taille du grain', 0.5, 6, 0.1, { def: 1.5 }),
      slider('fade', 'Délavé (mat)', 0, 100)), { closed: true, id: 'effects' }));

    const target = app.doc.selection ? ' (sélection)' : '';
    root.append(el('div', { class: 'panel-actions' },
      el('button', { class: 'btn', onclick: () => {
        session.cancel();
        render();
      } }, 'Annuler'),
      el('button', { class: 'btn primary', onclick: async () => {
        if (!session.active) return toast('Aucun réglage à appliquer');
        await busy(() => session.commit(), 'Application des réglages…');
        render();
        toast('Réglages appliqués ✔');
      } }, `Appliquer${target}`)));
    root.append(el('p', { class: 'hint' }, 'Astuce : double-cliquez un curseur pour le remettre à zéro. Les réglages s\'appliquent au calque actif.'));
  };

  app.on('develop-reset', render);
  app.on('selection', () => {
    if (session.active) session.update();
    render();
  });
  app.on('document', render);
  app.on('document-restored', render);
  app.on('active-layer', () => {
    if (session.active) session.commit();
    render();
  });
  render();
  root.refresh = render;
  return root;
}

function defaultAt(path) {
  return path.split('.').reduce((o, k) => o[k], defaultParams());
}

function hslEditor(session, setParam) {
  const wrap = el('div');
  let mode = 'h';
  const draw = () => {
    wrap.innerHTML = '';
    wrap.append(el('div', { class: 'hsl-tabs' }, segmented([['h', 'Teinte'], ['s', 'Saturation'], ['l', 'Luminance']], mode, (m) => {
      mode = m;
      draw();
    })));
    for (const [key, label, , color] of HSL_BANDS) {
      wrap.append(sliderRow({
        label: el('span', {}, el('i', { class: 'grade-swatch', style: { background: color } }), label),
        min: -100, max: 100, value: session.params.hsl[key][mode], def: 0,
        track: mode === 'h' ? 'linear-gradient(90deg,#888,' + color + ',#888)' : mode === 's' ? `linear-gradient(90deg,#808080,${color})` : `linear-gradient(90deg,#000,${color},#fff)`,
        onInput: (v) => setParam(`hsl.${key}.${mode}`, v),
      }));
    }
  };
  draw();
  return wrap;
}

function gradeEditor(session, setParam) {
  const wrap = el('div');
  const g = session.params.grade;
  const region = (key, label) => {
    const sw = el('i', { class: 'grade-swatch' });
    const upd = () => (sw.style.background = `hsl(${session.params.grade[key].h} ${Math.max(20, session.params.grade[key].s)}% 55%)`);
    upd();
    return el('div', { class: 'grade-wheel' },
      el('div', { style: { fontWeight: 600, fontSize: '12px', marginTop: '4px' } }, sw, label),
      sliderRow({ label: 'Teinte', min: 0, max: 360, value: g[key].h, def: g[key].h, track: TRACKS.hue, onInput: (v) => { setParam(`grade.${key}.h`, v); upd(); } }),
      sliderRow({ label: 'Saturation', min: 0, max: 100, value: g[key].s, def: 0, onInput: (v) => { setParam(`grade.${key}.s`, v); upd(); } }));
  };
  wrap.append(region('shadows', 'Ombres'), region('midtones', 'Tons moyens'), region('highlights', 'Hautes lumières'),
    sliderRow({ label: 'Balance', min: -100, max: 100, value: g.balance, def: 0, onInput: (v) => setParam('grade.balance', v) }));
  return wrap;
}

// Éditeur de courbe interactif (souris et tactile).
function curveEditor(app, session, setParam) {
  const wrap = el('div', { class: 'curve-wrap' });
  let ch = 'rgb';
  const canvas = el('canvas', { class: 'curve-canvas' });
  const colors = { rgb: '#ffffff', r: '#ff5d5d', g: '#4ddb7a', b: '#4da3ff' };
  const pts = () => session.params.curves[ch];

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth || 280;
    canvas.width = canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    // Histogramme en fond
    if (session.hist) {
      const h = ch === 'rgb' ? session.hist.l : session.hist[ch];
      let mx = 0;
      for (let i = 2; i < 254; i++) mx = Math.max(mx, h[i]);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.beginPath();
      ctx.moveTo(0, size);
      for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * size, size - Math.min(1, h[i] / (mx || 1)) * size * 0.9);
      ctx.lineTo(size, size);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo((size * i) / 4, 0);
      ctx.lineTo((size * i) / 4, size);
      ctx.moveTo(0, (size * i) / 4);
      ctx.lineTo(size, (size * i) / 4);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.moveTo(0, size);
    ctx.lineTo(size, 0);
    ctx.stroke();
    const lut = curveLUT(pts(), 256);
    ctx.strokeStyle = colors[ch];
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * size, y = size - lut[i] * size;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    for (const [x, y] of pts()) {
      ctx.beginPath();
      ctx.arc(x * size, size - y * size, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#17171f';
      ctx.fill();
      ctx.strokeStyle = colors[ch];
      ctx.stroke();
    }
  };

  let dragIdx = -1;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!session.ensure()) return;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = pos(e);
    const list = pts();
    const R = e.pointerType === 'touch' ? 0.07 : 0.04;
    dragIdx = list.findIndex(([px, py]) => Math.hypot(px - x, py - y) < R);
    if (dragIdx < 0) {
      const lut = curveLUT(list, 256);
      list.push([clamp(x, 0, 1), lut[Math.round(clamp(x, 0, 1) * 255)]]);
      list.sort((a, b) => a[0] - b[0]);
      dragIdx = list.findIndex(([px]) => px === clamp(x, 0, 1));
    }
    draw();
    session.update();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragIdx < 0) return;
    const [x, y] = pos(e);
    const list = pts();
    const isEnd = dragIdx === 0 || dragIdx === list.length - 1;
    // Glisser un point hors du cadre le supprime
    if (!isEnd && (y < -0.08 || y > 1.08 || x < -0.08 || x > 1.08)) {
      list.splice(dragIdx, 1);
      dragIdx = -1;
    } else {
      const lo = dragIdx > 0 ? list[dragIdx - 1][0] + 0.01 : 0;
      const hi = dragIdx < list.length - 1 ? list[dragIdx + 1][0] - 0.01 : 1;
      list[dragIdx] = [dragIdx === 0 ? clamp(x, 0, hi) : dragIdx === list.length - 1 ? clamp(x, lo, 1) : clamp(x, lo, hi), clamp(y, 0, 1)];
    }
    session.look = 'custom';
    draw();
    session.update();
  });
  canvas.addEventListener('pointerup', () => (dragIdx = -1));
  canvas.addEventListener('dblclick', (e) => {
    const [x, y] = pos(e);
    const list = pts();
    const i = list.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 0.05);
    if (i > 0 && i < list.length - 1) {
      list.splice(i, 1);
      draw();
      session.update();
    }
  });

  const presets = el('select', { style: { flex: 1 } },
    ...[['', 'Préréglages…'], ['linear', 'Linéaire'], ['medium', 'Contraste moyen'], ['strong', 'Contraste fort'], ['film', 'Film (noirs relevés)'], ['inverse', 'Négatif'], ['soft', 'Doux']].map(([v, l]) => el('option', { value: v }, l)));
  presets.addEventListener('change', () => {
    const P = {
      linear: [[0, 0], [1, 1]], medium: [[0, 0], [0.25, 0.21], [0.75, 0.8], [1, 1]], strong: [[0, 0], [0.25, 0.16], [0.75, 0.86], [1, 1]],
      film: [[0, 0.07], [0.3, 0.27], [0.7, 0.76], [1, 0.95]], inverse: [[0, 1], [1, 0]], soft: [[0, 0.04], [0.5, 0.52], [1, 0.96]],
    }[presets.value];
    if (!P || !session.ensure()) return;
    session.params.curves[ch] = P.map((x) => [...x]);
    presets.value = '';
    draw();
    session.update();
  });
  const tabs = el('div', { class: 'curve-tabs row' }, segmented([['rgb', 'RVB'], ['r', 'R'], ['g', 'V'], ['b', 'B']], ch, (c) => {
    ch = c;
    draw();
  }), presets);
  wrap.append(tabs, canvas, el('p', { class: 'hint' }, 'Touchez pour ajouter un point, glissez-le hors du cadre pour le supprimer.'));
  new ResizeObserver(() => draw()).observe(canvas);
  app.on('develop-changed', () => draw());
  return wrap;
}

// ======================================================================
// Panneau Looks
// ======================================================================

export function looksPanel(app, session) {
  const root = el('div');
  let thumbsFor = null;
  const render = () => {
    root.innerHTML = '';
    if (!app.doc) return root.append(el('p', { class: 'hint' }, 'Ouvrez une photo pour voir les looks.'));
    const amount = sliderRow({ label: 'Intensité', min: 0, max: 100, value: session.lookAmount, def: 100, format: (v) => `${Math.round(v)} %`, onInput: (v) => session.setLookAmount(v) });
    root.append(amount);
    const grid = el('div', { class: 'looks-grid' });
    const layer = app.doc.active;
    const small = layer ? makeProxy(layer.canvas, 110 * 110).canvas : null;
    const srcData = small ? getData(small) : null;
    for (const look of LOOKS) {
      const c = el('canvas', { width: small?.width || 1, height: small?.height || 1 });
      const btn = el('button', { class: `look${session.look === look.id ? ' on' : ''}` }, c, look.name);
      btn.addEventListener('click', () => {
        if (look.id === 'none') {
          session.cancel();
        } else session.applyLook(look);
        [...grid.children].forEach((b) => b.classList.remove('on'));
        btn.classList.add('on');
        app.emit('develop-reset-silent');
      });
      grid.append(btn);
      if (srcData) {
        // Vignettes générées en différé pour garder l'interface fluide
        setTimeout(() => {
          const params = look.auto ? autoParams(srcData) : withDefaults(look.params);
          c.getContext('2d').putImageData(develop(srcData, params, small.width / (layer.canvas.width || 1)), 0, 0);
        }, 10);
      }
    }
    root.append(grid);
    root.append(el('div', { class: 'panel-actions' },
      el('button', { class: 'btn', onclick: () => {
        session.cancel();
        render();
      } }, 'Annuler'),
      el('button', { class: 'btn primary', onclick: async () => {
        if (!session.active) return toast('Choisissez un look');
        await busy(() => session.commit(), 'Application du look…');
        render();
        toast('Look appliqué ✔');
      } }, 'Appliquer')));
    root.append(el('p', { class: 'hint' }, 'Les looks règlent les curseurs du panneau Réglages : vous pouvez les affiner avant d\'appliquer.'));
    thumbsFor = layer?.canvas;
  };
  app.on('document', render);
  app.on('document-restored', render);
  app.on('active-layer', render);
  root.refresh = () => {
    if (app.doc?.active?.canvas !== thumbsFor) render();
  };
  render();
  return root;
}

// ======================================================================
// Panneau Filtres
// ======================================================================

export function filtersPanel(app, actions) {
  const root = el('div');
  const aiList = el('div', { class: 'filter-list' });
  for (const [id, label] of [['ai.selectSubject', '✨ Sélectionner le sujet'], ['ai.removeBg', '✨ Supprimer l\'arrière-plan'], ['ai.replaceBg', '✨ Remplacer l\'arrière-plan'], ['ai.portrait', '✨ Flou portrait'], ['ai.contentFill', '✨ Remplissage intelligent'], ['ai.selectBackground', '✨ Sélectionner l\'arrière-plan']]) {
    aiList.append(el('button', { class: 'filter-item ai', onclick: () => actions.run(id) }, label));
  }
  root.append(el('div', { class: 'filter-cat' }, el('h4', {}, 'Intelligence artificielle (sur l\'appareil)'), aiList));
  const cats = ['Réglages', ...FILTER_CATEGORIES];
  for (const cat of cats) {
    const list = el('div', { class: 'filter-list' });
    for (const f of FILTERS.filter((x) => x.cat === cat)) {
      list.append(el('button', { class: 'filter-item', onclick: () => actions.runFilter(f.id) }, f.name));
    }
    root.append(el('div', { class: 'filter-cat' }, el('h4', {}, cat), list));
  }
  return root;
}

// ======================================================================
// Panneau Historique
// ======================================================================

export function historyPanel(app) {
  const root = el('div');
  const render = () => {
    root.innerHTML = '';
    const h = app.history;
    const steps = [h.baseLabel, ...h.undoStack.map((e) => e.label)];
    const future = [...h.redoStack].reverse().map((e) => e.label);
    steps.forEach((label, i) => {
      root.append(el('button', { class: `hist-item${i === steps.length - 1 ? ' on' : ''}`, onclick: () => h.goTo(i) }, el('span', { html: icon('history', 14) }), label));
    });
    future.forEach((label, i) => {
      root.append(el('button', { class: 'hist-item future', onclick: () => h.goTo(steps.length + i) }, el('span', { html: icon('redo', 14) }), label));
    });
    root.append(el('p', { class: 'hint' }, `${h.undoStack.length} étape(s) annulable(s) · ${h.max} maximum`));
  };
  app.on('history', render);
  app.on('document-restored', render);
  render();
  return root;
}

// ======================================================================
// Panneau Infos (histogramme, image, EXIF)
// ======================================================================

export function infoPanel(app) {
  const root = el('div');
  const histo = el('canvas', { class: 'histo' });
  const info = el('dl', { class: 'kv' });
  const exif = el('dl', { class: 'kv' });
  const cursor = el('dl', { class: 'kv' });
  root.append(section('Histogramme', histo), section('Pointeur', cursor), section('Image', info), section('EXIF (appareil photo)', exif, { id: 'exif' }));

  const drawHisto = debounce(() => {
    if (!app.doc || !root.isConnected) return;
    const small = makeProxy(app.compositeCanvas, 250_000).canvas;
    const h = histogram(getData(small));
    const dpr = window.devicePixelRatio || 1;
    const W = histo.clientWidth || 300, H = histo.clientHeight || 110;
    histo.width = W * dpr;
    histo.height = H * dpr;
    const ctx = histo.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    let mx = 1;
    for (const k of ['r', 'g', 'b']) for (let i = 1; i < 255; i++) mx = Math.max(mx, h[k][i]);
    for (const [k, col] of [['r', 'rgba(255,70,70,.7)'], ['g', 'rgba(70,220,110,.7)'], ['b', 'rgba(70,140,255,.7)']]) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, H - Math.min(1, h[k][i] / mx) * H);
      ctx.lineTo(W, H);
      ctx.fill();
    }
  }, 300);

  const renderInfo = () => {
    const doc = app.doc;
    info.innerHTML = '';
    exif.innerHTML = '';
    if (!doc) return;
    const mp = ((doc.width * doc.height) / 1e6).toFixed(1);
    const rows = [
      ['Dimensions', `${doc.width} × ${doc.height} px`], ['Mégapixels', `${mp} Mpx`],
      ['Calques', doc.layers.length], ['Format', `${(doc.width / doc.height).toFixed(3)} : 1`],
    ];
    if (doc.fileInfo) {
      rows.push(['Fichier', doc.fileInfo.name], ['Type', doc.fileInfo.type || '—']);
      if (doc.fileInfo.size) rows.push(['Taille', `${(doc.fileInfo.size / 1024 / 1024).toFixed(2)} Mo`]);
    }
    for (const [k, v] of rows) info.append(el('dt', {}, k), el('dd', { title: String(v) }, String(v)));
    const ex = doc.fileInfo?.exif;
    if (ex) for (const [k, v] of Object.entries(ex)) exif.append(el('dt', {}, k), el('dd', { title: String(v) }, String(v)));
    else exif.append(el('dt', {}, 'Aucune donnée EXIF'));
    drawHisto();
  };
  app.on('cursor', rafThrottle((p) => {
    if (!root.isConnected || !app.doc) return;
    const x = Math.floor(p.x), y = Math.floor(p.y);
    cursor.innerHTML = '';
    if (x < 0 || y < 0 || x >= app.doc.width || y >= app.doc.height) return cursor.append(el('dt', {}, 'Hors image'));
    const d = app.compositeCanvas.getContext('2d').getImageData(x, y, 1, 1).data;
    const hex = `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    cursor.append(el('dt', {}, 'Position'), el('dd', {}, `${x}, ${y}`), el('dt', {}, 'RVB'), el('dd', {}, `${d[0]}, ${d[1]}, ${d[2]}`),
      el('dt', {}, 'Hexa'), el('dd', {}, el('span', { class: 'grade-swatch', style: { background: hex, borderRadius: '3px' } }), hex.toUpperCase()), el('dt', {}, 'Opacité'), el('dd', {}, `${Math.round((d[3] / 255) * 100)} %`));
  }));
  app.on('doc', drawHisto);
  app.on('document', renderInfo);
  app.on('document-restored', renderInfo);
  root.refresh = renderInfo;
  renderInfo();
  return root;
}

export { resizeCanvas };
