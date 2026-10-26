// Commandes de l'application, menus et raccourcis clavier.

import {
  el, createCanvas, cloneCanvas, getData, canvasFromData, makeProxy, blendWithSelection, alphaBounds, resizeCanvas,
  hexToRgb, rafThrottle, canvasToBlob, APP_NAME, APP_VERSION,
} from './util.js';
import { flatten, layerPixels, defaultEffects, composite } from './doc.js';
import { FILTERS, FILTER_CATEGORIES, filterById, defaultValues } from './filters.js';
import { develop, autoParams } from './develop.js';
import {
  selectAll, invertSelection, featherSelection, growSelection, colorRangeSelection, selectionFromLayerAlpha, selectionBounds, selectionOutline,
} from './selection.js';
import { toast, busy, modal, formDialog, confirmDialog, buildFields, promptDialog } from './ui.js';
import { openImageFile, exportDialog, saveProject, saveBlob, placeAsLayer, decodeImage } from './io.js';
import { loadPref, savePref } from './app.js';
import { segmentSubject } from './ai.js';
import { contentAwareFill } from './inpaint.js';
import { gaussianBlur } from './imaging.js';
import { isTyping } from './view.js';

const SLOW_FILTERS = new Set(['median', 'oil', 'motionblur', 'zoomblur', 'spinblur', 'halftone', 'lensblur', 'twirl', 'spherize', 'ripple', 'pinch', 'polar', 'chromatic']);

export function createActions(app, ui) {
  const cmds = {};
  const def = (id, label, run, shortcut = '', enabled = null) => (cmds[id] = { id, label, run, shortcut, enabled });
  const hasDoc = () => !!app.doc;
  const hasSel = () => !!app.doc?.selection;
  const active = () => app.doc?.active;

  // ---------- Utilitaires de transformation du document ----------

  function transformDoc(label, w, h, fn, { keepSelection = false } = {}) {
    const doc = app.doc;
    app.flushPending();
    app.history.push(label);
    for (const l of doc.layers) {
      l.canvas = fn(l.canvas, false);
      if (l.mask) l.mask = fn(l.mask, true);
      if (l.text) l.text = null;
    }
    doc.selection = keepSelection && doc.selection ? fn(doc.selection, true) : null;
    doc.width = w;
    doc.height = h;
    app.view.fit();
    app.invalidate(true);
    app.emit('document');
  }

  const drawWith = (w, h, draw) => (src) => {
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    draw(ctx, src);
    return c;
  };

  function rotateDoc(deg) {
    const doc = app.doc;
    const swap = deg % 180 !== 0;
    const w = swap ? doc.height : doc.width, h = swap ? doc.width : doc.height;
    transformDoc(`Rotation ${deg}°`, w, h, drawWith(w, h, (ctx, src) => {
      ctx.translate(w / 2, h / 2);
      ctx.rotate((deg * Math.PI) / 180);
      ctx.drawImage(src, -src.width / 2, -src.height / 2);
    }), { keepSelection: true });
  }

  function flipDoc(axis) {
    const doc = app.doc;
    transformDoc(axis === 'x' ? 'Symétrie horizontale' : 'Symétrie verticale', doc.width, doc.height, drawWith(doc.width, doc.height, (ctx, src) => {
      if (axis === 'x') {
        ctx.translate(src.width, 0);
        ctx.scale(-1, 1);
      } else {
        ctx.translate(0, src.height);
        ctx.scale(1, -1);
      }
      ctx.drawImage(src, 0, 0);
    }), { keepSelection: true });
  }

  function cropDocTo(r, label = 'Recadrage') {
    transformDoc(label, r.w, r.h, drawWith(r.w, r.h, (ctx, src) => ctx.drawImage(src, -r.x, -r.y)));
  }

  function flipLayer(axis) {
    if (!app.canEdit()) return;
    app.applyToTarget(axis === 'x' ? 'Symétrie du calque' : 'Symétrie verticale du calque', (src) => {
      const c = createCanvas(src.width, src.height);
      const ctx = c.getContext('2d');
      if (axis === 'x') {
        ctx.translate(src.width, 0);
        ctx.scale(-1, 1);
      } else {
        ctx.translate(0, src.height);
        ctx.scale(1, -1);
      }
      ctx.drawImage(src, 0, 0);
      return c;
    }, { useSelection: false });
  }

  // ---------- Dialogues ----------

  async function newDocDialog() {
    const presets = [
      ['Instagram carré', 1080, 1080], ['Instagram portrait', 1080, 1350], ['Story / Reels', 1080, 1920], ['Full HD', 1920, 1080],
      ['4K UHD', 3840, 2160], ['A4 300 ppp', 2480, 3508], ['A5 300 ppp', 1748, 2480], ['Photo 10×15', 1800, 1200],
      ['Miniature YouTube', 1280, 720], ['Bannière X/Twitter', 1500, 500], ['Couverture Facebook', 1640, 624], ['Fond d\'écran mobile', 1290, 2796],
      ['Icône d\'app', 1024, 1024], ['Carte de visite', 1050, 600],
    ];
    const vals = { width: 1080, height: 1080, background: 'white', name: 'Sans titre' };
    const grid = el('div', { class: 'presets' });
    const fieldsHolder = el('div');
    const renderFields = () => {
      fieldsHolder.innerHTML = '';
      fieldsHolder.append(buildFields([
        { key: 'name', label: 'Nom', type: 'text' },
        { key: 'width', label: 'Largeur (px)', type: 'number', min: 1, max: 16000 },
        { key: 'height', label: 'Hauteur (px)', type: 'number', min: 1, max: 16000 },
        { key: 'background', label: 'Arrière-plan', type: 'select', options: [['white', 'Blanc'], ['black', 'Noir'], ['transparent', 'Transparent'], ['primary', 'Couleur de premier plan'], ['secondary', 'Couleur d\'arrière-plan']] },
      ], vals));
    };
    for (const [name, w, h] of presets) {
      const b = el('button', { class: 'preset' }, name, el('small', {}, `${w} × ${h}`));
      b.addEventListener('click', () => {
        [...grid.children].forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        Object.assign(vals, { width: w, height: h, name });
        renderFields();
      });
      grid.append(b);
    }
    renderFields();
    const ok = await modal({ title: 'Nouveau document', wide: true, body: el('div', {}, grid, el('div', { style: { height: '10px' } }), fieldsHolder), buttons: [{ label: 'Annuler', value: false }, { label: 'Créer', primary: true, value: true }] }).promise;
    if (!ok) return;
    const w = Math.max(1, Math.min(16000, Math.round(vals.width))), h = Math.max(1, Math.min(16000, Math.round(vals.height)));
    if (w * h > 100_000_000) return toast('Document trop grand (100 Mpx maximum)');
    const bg = { white: '#ffffff', black: '#000000', transparent: null, primary: app.primary, secondary: app.secondary }[vals.background];
    app.newDocument(w, h, bg, vals.name || 'Sans titre');
    ui.hideWelcome();
  }

  async function imageSizeDialog() {
    const doc = app.doc;
    const ratio = doc.width / doc.height;
    const w = el('input', { type: 'number', min: 1, max: 16000, value: doc.width });
    const h = el('input', { type: 'number', min: 1, max: 16000, value: doc.height });
    const pct = el('input', { type: 'number', min: 1, max: 1000, value: 100 });
    const keep = el('input', { type: 'checkbox', checked: true });
    const sync = (src) => {
      if (src === pct) {
        w.value = Math.round((doc.width * pct.value) / 100);
        h.value = Math.round((doc.height * pct.value) / 100);
      } else if (keep.checked) {
        if (src === w) h.value = Math.max(1, Math.round(w.value / ratio));
        else w.value = Math.max(1, Math.round(h.value * ratio));
        pct.value = Math.round((w.value / doc.width) * 100);
      }
    };
    [w, h, pct].forEach((i) => i.addEventListener('input', () => sync(i)));
    const ok = await modal({
      title: 'Taille de l\'image',
      body: el('div', {}, el('div', { class: 'field' }, el('label', {}, 'Largeur (px)'), w), el('div', { class: 'field' }, el('label', {}, 'Hauteur (px)'), h),
        el('div', { class: 'field' }, el('label', {}, 'Pourcentage'), pct), el('label', { class: 'check' }, keep, 'Conserver les proportions'),
        el('p', { class: 'hint' }, `Actuel : ${doc.width} × ${doc.height} px`)),
      buttons: [{ label: 'Annuler', value: false }, { label: 'Redimensionner', primary: true, value: true }],
    }).promise;
    if (!ok) return;
    const nw = Math.max(1, Math.round(w.value)), nh = Math.max(1, Math.round(h.value));
    if (nw === doc.width && nh === doc.height) return;
    await busy(() => transformDoc('Taille de l\'image', nw, nh, (src) => resizeCanvas(src, nw, nh), { keepSelection: true }));
  }

  async function canvasSizeDialog() {
    const doc = app.doc;
    const vals = { width: doc.width, height: doc.height, anchor: 4, fill: 'transparent' };
    const anchorGrid = () => {
      const g = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 34px)', gap: '4px' } });
      for (let i = 0; i < 9; i++) {
        const b = el('button', { class: `btn small${vals.anchor === i ? ' primary' : ''}`, style: { padding: 0 } }, vals.anchor === i ? '●' : '·');
        b.addEventListener('click', () => {
          vals.anchor = i;
          g.replaceWith(anchorGrid());
        });
        g.append(b);
      }
      return g;
    };
    const res = await formDialog({
      title: 'Taille de la zone de travail',
      fields: [
        { key: 'width', label: 'Largeur (px)', type: 'number', min: 1, max: 16000 },
        { key: 'height', label: 'Hauteur (px)', type: 'number', min: 1, max: 16000 },
        { key: 'fill', label: 'Nouvelle zone', type: 'select', options: [['transparent', 'Transparente'], ['white', 'Blanche'], ['black', 'Noire'], ['secondary', 'Couleur d\'arrière-plan']] },
      ],
      values: vals,
      extra: () => el('div', { class: 'field' }, el('label', {}, 'Ancrage'), anchorGrid()),
      okLabel: 'Appliquer',
    });
    if (!res) return;
    const W = Math.max(1, Math.round(res.width)), H = Math.max(1, Math.round(res.height));
    const ax = vals.anchor % 3, ay = Math.floor(vals.anchor / 3);
    const dx = Math.round(((W - doc.width) * ax) / 2), dy = Math.round(((H - doc.height) * ay) / 2);
    const fill = { white: '#ffffff', black: '#000000', secondary: app.secondary }[res.fill];
    const bottomId = doc.layers[0]?.id;
    app.flushPending();
    app.history.push('Taille de la zone de travail');
    for (const l of doc.layers) {
      const c = createCanvas(W, H);
      const ctx = c.getContext('2d');
      if (fill && l.id === bottomId) {
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.drawImage(l.canvas, dx, dy);
      l.canvas = c;
      if (l.mask) {
        const m = createCanvas(W, H);
        const mctx = m.getContext('2d');
        mctx.fillStyle = '#fff';
        mctx.fillRect(0, 0, W, H);
        mctx.clearRect(dx, dy, doc.width, doc.height);
        mctx.drawImage(l.mask, dx, dy);
        l.mask = m;
      }
      if (l.text) l.text = { ...l.text, x: l.text.x + dx, y: l.text.y + dy, bounds: l.text.bounds && { ...l.text.bounds, x: l.text.bounds.x + dx, y: l.text.bounds.y + dy } };
    }
    doc.selection = null;
    doc.width = W;
    doc.height = H;
    app.view.fit();
    app.invalidate(true);
    app.emit('document');
  }

  async function rotateArbitraryDialog() {
    const doc = app.doc;
    const res = await formDialog({
      title: 'Rotation de l\'image', okLabel: 'Pivoter',
      fields: [{ key: 'angle', label: 'Angle', type: 'range', min: -180, max: 180, step: 0.1, unit: '°', value: 0 }, { key: 'expand', label: 'Agrandir la zone de travail', type: 'checkbox' }],
      values: { angle: 0, expand: true },
    });
    if (!res || !res.angle) return;
    const a = (res.angle * Math.PI) / 180;
    const cos = Math.abs(Math.cos(a)), sin = Math.abs(Math.sin(a));
    const W = res.expand ? Math.round(doc.width * cos + doc.height * sin) : doc.width;
    const H = res.expand ? Math.round(doc.width * sin + doc.height * cos) : doc.height;
    transformDoc('Rotation', W, H, drawWith(W, H, (ctx, src) => {
      ctx.translate(W / 2, H / 2);
      ctx.rotate(a);
      ctx.drawImage(src, -src.width / 2, -src.height / 2);
    }));
  }

  async function fillDialog() {
    if (!app.canEdit()) return;
    const res = await formDialog({
      title: 'Remplir', okLabel: 'Remplir',
      fields: [
        { key: 'content', label: 'Contenu', type: 'select', options: [['primary', 'Couleur de premier plan'], ['secondary', 'Couleur d\'arrière-plan'], ['black', 'Noir'], ['white', 'Blanc'], ['gray', 'Gris 50 %'], ['clear', 'Transparent (effacer)']] },
        { key: 'opacity', label: 'Opacité', type: 'range', min: 1, max: 100, unit: '%' },
        { key: 'mode', label: 'Mode', type: 'select', options: [['source-over', 'Normal'], ['multiply', 'Produit'], ['screen', 'Superposition'], ['overlay', 'Incrustation'], ['color', 'Couleur'], ['soft-light', 'Lumière tamisée']] },
      ],
      values: { content: 'primary', opacity: 100, mode: 'source-over' },
    });
    if (!res) return;
    fillTarget(res.content, res.opacity / 100, res.mode, 'Remplir');
  }

  function fillTarget(content, opacity = 1, mode = 'source-over', label = 'Remplir') {
    const color = { primary: app.primary, secondary: app.secondary, black: '#000000', white: '#ffffff', gray: '#808080' }[content];
    app.applyToTarget(label, (src) => {
      const c = cloneCanvas(src);
      const ctx = c.getContext('2d');
      if (content === 'clear') {
        ctx.globalAlpha = opacity;
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillRect(0, 0, c.width, c.height);
        return c;
      }
      ctx.globalAlpha = opacity;
      ctx.globalCompositeOperation = mode;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, c.width, c.height);
      return c;
    });
  }

  async function strokeSelectionDialog() {
    if (!hasSel()) return toast('Aucune sélection');
    if (!app.canEdit()) return;
    const res = await formDialog({
      title: 'Contour de la sélection', okLabel: 'Appliquer',
      fields: [{ key: 'width', label: 'Épaisseur', type: 'range', min: 1, max: 100, unit: 'px' }, { key: 'color', label: 'Couleur', type: 'color' }],
      values: { width: 4, color: app.primary },
    });
    if (!res) return;
    const path = selectionOutline(app.doc.selection);
    app.applyToTarget('Contour', (src) => {
      const c = cloneCanvas(src);
      const ctx = c.getContext('2d');
      ctx.strokeStyle = res.color;
      ctx.lineWidth = res.width;
      ctx.lineJoin = 'round';
      ctx.stroke(path);
      return c;
    }, { useSelection: false });
  }

  async function effectsDialog() {
    const layer = active();
    if (!layer) return;
    app.flushPending();
    app.history.push('Effets du calque');
    const before = JSON.parse(JSON.stringify(layer.effects || defaultEffects()));
    layer.effects = JSON.parse(JSON.stringify(before));
    const fx = layer.effects;
    const live = rafThrottle(() => app.invalidate());
    const group = (title, obj, fields) => {
      const box = el('div', { class: 'section' });
      box.append(el('div', { class: 'section-head', style: { cursor: 'default' } }, title));
      box.append(buildFields(fields, obj, live));
      return box;
    };
    const body = el('div', {},
      group('Ombre portée', fx.shadow, [
        { key: 'enabled', label: 'Activer', type: 'checkbox' }, { key: 'color', label: 'Couleur', type: 'color' },
        { key: 'opacity', label: 'Opacité', type: 'range', min: 0, max: 1, step: 0.01 }, { key: 'distance', label: 'Distance', type: 'range', min: 0, max: 200 },
        { key: 'angle', label: 'Angle', type: 'range', min: 0, max: 360, unit: '°' }, { key: 'blur', label: 'Flou', type: 'range', min: 0, max: 150 },
      ]),
      group('Lueur externe', fx.glow, [
        { key: 'enabled', label: 'Activer', type: 'checkbox' }, { key: 'color', label: 'Couleur', type: 'color' },
        { key: 'opacity', label: 'Opacité', type: 'range', min: 0, max: 1, step: 0.01 }, { key: 'blur', label: 'Taille', type: 'range', min: 1, max: 200 },
      ]),
      group('Contour', fx.stroke, [
        { key: 'enabled', label: 'Activer', type: 'checkbox' }, { key: 'color', label: 'Couleur', type: 'color' },
        { key: 'width', label: 'Épaisseur', type: 'range', min: 1, max: 40 }, { key: 'opacity', label: 'Opacité', type: 'range', min: 0, max: 1, step: 0.01 },
      ]));
    const ok = await modal({ title: `Effets — ${layer.name}`, body, preview: true, buttons: [{ label: 'Annuler', value: false }, { label: 'OK', primary: true, value: true }] }).promise;
    if (!ok) {
      layer.effects = before;
      app.history.discardLast();
    }
    app.invalidate(true);
  }

  // ---------- Filtres ----------

  async function runFilter(id, presetValues = null) {
    const f = filterById(id);
    if (!f || !hasDoc()) return;
    app.flushPending();
    if (!app.canEdit()) return;
    const t = app.target();
    const saved = loadPref(`filter.${id}`, null);
    let values = presetValues || { ...defaultValues(f), ...(saved || {}) };
    if (!f.params.length) {
      await busy(() => app.applyToTarget(f.name, (c) => canvasFromData(f.apply(getData(c), values, 1))), f.name);
      app.lastFilter = { id, values };
      return;
    }
    const proxy = makeProxy(t.canvas, SLOW_FILTERS.has(id) ? 350_000 : 1_000_000);
    const src = getData(proxy.canvas);
    const sel = app.doc.selection;
    let pending = false, latest = values;
    const compute = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => setTimeout(() => {
        pending = false;
        const out = canvasFromData(f.apply(src, latest, proxy.scale));
        const prev = sel ? blendWithSelection(proxy.canvas, out, sel) : out;
        if (t.kind === 'pixels') app.setPreview({ layerId: t.layer.id, canvas: prev });
      }, 0));
    };
    compute();
    const res = await formDialog({
      title: f.name, fields: f.params, values, preview: true, okLabel: 'Appliquer',
      onChange: (v) => {
        latest = { ...v };
        compute();
      },
      left: el('button', { class: 'btn small', onclick: (e) => {
        e.preventDefault();
        latest = defaultValues(f);
        compute();
      } }, 'Défaut'),
    });
    app.setPreview(null);
    if (!res) return;
    savePref(`filter.${id}`, res);
    await busy(() => app.applyToTarget(f.name, (c) => canvasFromData(f.apply(getData(c), res, 1))), `${f.name}…`);
    app.lastFilter = { id, values: res };
  }

  // ---------- Presse-papier ----------

  async function copy(merged = false, cut = false) {
    const doc = app.doc;
    if (!doc) return;
    app.flushPending();
    const src = merged ? flatten(doc) : layerPixels(doc, active());
    const sel = doc.selection;
    const c = sel ? blendWithSelection(createCanvas(doc.width, doc.height), src, sel) : src;
    const b = sel ? selectionBounds(sel) : alphaBounds(c);
    if (!b) return toast('Rien à copier');
    app.clipboard = { canvas: c, bounds: b };
    // Copie aussi dans le presse-papier du système quand c'est possible
    try {
      const crop = createCanvas(b.w, b.h);
      crop.getContext('2d').drawImage(c, -b.x, -b.y);
      const blob = await canvasToBlob(crop, 'image/png');
      if (navigator.clipboard && window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch {
      /* presse-papier système indisponible : on garde la copie interne */
    }
    if (cut && !merged) fillTarget('clear', 1, 'source-over', 'Couper');
    toast(cut ? 'Coupé ✂' : 'Copié 📋', 1000);
  }

  function paste() {
    if (!app.doc) return;
    if (!app.clipboard) return pasteSystem();
    const c = createCanvas(app.doc.width, app.doc.height);
    c.getContext('2d').drawImage(app.clipboard.canvas, 0, 0);
    app.addLayerFromCanvas(c, 'Collage', 'Coller');
  }

  async function pasteSystem() {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) return pasteBlob(await it.getType(type));
      }
      toast('Le presse-papier ne contient pas d\'image');
    } catch {
      toast('Utilisez Ctrl+V pour coller depuis le presse-papier');
    }
  }

  async function pasteBlob(blob) {
    const { canvas } = await decodeImage(blob);
    if (!app.doc) {
      app.newDocument(canvas.width, canvas.height, null, 'Collage');
      app.doc.layers[0].canvas = canvas;
      app.doc.layers[0].name = 'Collage';
      app.originalCanvas = cloneCanvas(canvas);
      app.invalidate(true);
      ui.hideWelcome();
    } else placeAsLayer(app, canvas, 'Collage');
  }

  // ---------- Calques ----------

  function layerOp(label, fn) {
    if (!hasDoc()) return;
    app.flushPending();
    app.history.push(label);
    const r = fn(app.doc);
    if (r === false) app.history.discardLast();
    app.invalidate(true);
  }

  function mergeDown() {
    const doc = app.doc;
    const i = doc.activeIndex;
    if (i <= 0) return toast('Aucun calque en dessous');
    layerOp('Fusionner vers le bas', () => {
      const top = doc.layers[i], bottom = doc.layers[i - 1];
      const c = createCanvas(doc.width, doc.height);
      composite({ width: doc.width, height: doc.height, layers: [{ ...bottom, blend: 'source-over', visible: true }, { ...top, visible: true }] }, c);
      Object.assign(bottom, { canvas: c, mask: null, opacity: 1, blend: bottom.blend, text: null, effects: defaultEffects() });
      doc.layers.splice(i, 1);
      doc.activeId = bottom.id;
    });
  }

  function mergeVisible() {
    layerOp('Fusionner les calques visibles', (doc) => {
      const vis = doc.layers.filter((l) => l.visible);
      if (vis.length < 2) return false;
      const c = flatten(doc);
      const keep = vis[vis.length - 1];
      const idx = doc.layers.indexOf(keep);
      const merged = { ...keep, canvas: c, mask: null, opacity: 1, blend: 'source-over', text: null, effects: defaultEffects(), name: 'Fusion' };
      doc.layers = doc.layers.filter((l) => !l.visible);
      doc.layers.splice(Math.min(idx - (vis.length - 1), doc.layers.length), 0, merged);
      doc.activeId = merged.id;
    });
  }

  function flattenImage() {
    layerOp('Aplatir l\'image', (doc) => {
      const c = flatten(doc, '#ffffff');
      const base = doc.layers[0];
      doc.layers = [{ ...base, canvas: c, mask: null, opacity: 1, blend: 'source-over', visible: true, text: null, effects: defaultEffects(), name: 'Arrière-plan', locked: false }];
      doc.activeId = base.id;
    });
  }

  function moveLayer(dir) {
    const doc = app.doc;
    const i = doc.activeIndex;
    const j = dir === 'top' ? doc.layers.length - 1 : dir === 'bottom' ? 0 : i + dir;
    if (j < 0 || j >= doc.layers.length || j === i) return;
    layerOp('Ordre des calques', () => {
      const [l] = doc.layers.splice(i, 1);
      doc.layers.splice(j, 0, l);
    });
  }

  function layerFromSelection(cut) {
    const doc = app.doc;
    if (!doc.selection) return layerOp('Dupliquer le calque', duplicateLayer);
    const l = active();
    const piece = blendWithSelection(createCanvas(doc.width, doc.height), layerPixels(doc, l), doc.selection);
    layerOp(cut ? 'Calque par couper' : 'Calque par copier', () => {
      if (cut && !l.locked) {
        const rest = cloneCanvas(l.canvas);
        const ctx = rest.getContext('2d');
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(doc.selection, 0, 0);
        l.canvas = rest;
      }
      doc.addLayer({ canvas: piece, name: `${l.name} (extrait)` });
    });
  }

  function duplicateLayer(doc) {
    const l = active();
    if (!l) return false;
    const i = doc.activeIndex;
    const copyL = { ...l, id: `${l.id}c${Date.now().toString(36)}`, name: `${l.name} copie`, effects: JSON.parse(JSON.stringify(l.effects)), text: l.text ? { ...l.text } : null };
    doc.layers.splice(i + 1, 0, copyL);
    doc.activeId = copyL.id;
  }

  function addMask(mode) {
    const doc = app.doc;
    const l = active();
    if (!l) return;
    if (l.mask) return toast('Ce calque a déjà un masque');
    layerOp('Ajouter un masque', () => {
      const m = createCanvas(doc.width, doc.height);
      const ctx = m.getContext('2d');
      if (mode === 'selection' && doc.selection) ctx.drawImage(doc.selection, 0, 0);
      else if (mode !== 'hide') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, m.width, m.height);
      }
      l.mask = m;
      l.maskEnabled = true;
      doc.editMask = true;
      if (mode === 'selection') doc.selection = null;
    });
    toast('Masque ajouté : peignez en noir pour masquer, en blanc pour révéler', 3000);
  }

  // ---------- Définition des commandes ----------

  // Fichier
  def('file.new', 'Nouveau…', newDocDialog, 'Ctrl+N');
  def('file.open', 'Ouvrir…', () => ui.pickFiles('replace'), 'Ctrl+O');
  def('file.openLayer', 'Importer comme calque…', () => ui.pickFiles('layer'), 'Ctrl+Maj+O', hasDoc);
  def('file.camera', 'Prendre une photo…', () => ui.pickFiles('replace', true));
  def('file.save', 'Enregistrer le projet (.prisme)', () => saveProject(app), 'Ctrl+S', hasDoc);
  def('file.export', 'Exporter l\'image…', () => exportDialog(app), 'Ctrl+Maj+S', hasDoc);
  def('file.quickExport', 'Export rapide JPEG', async () => {
    app.flushPending();
    const blob = await canvasToBlob(flatten(app.doc, '#ffffff'), 'image/jpeg', 0.92);
    await saveBlob(blob, `${app.doc.name || 'image'}.jpg`);
  }, 'Ctrl+Alt+S', hasDoc);
  def('file.close', 'Fermer le document', async () => {
    if (app.dirty && !(await confirmDialog('Fermer le document', 'Les modifications non exportées seront perdues (une sauvegarde automatique est conservée).', 'Fermer', true))) return;
    app.cancelPending();
    ui.showWelcome();
  }, 'Ctrl+W', hasDoc);

  // Édition
  def('edit.undo', 'Annuler', () => app.history.undo(), 'Ctrl+Z', () => app.history.canUndo);
  def('edit.redo', 'Rétablir', () => app.history.redo(), 'Ctrl+Y', () => app.history.canRedo);
  def('edit.cut', 'Couper', () => copy(false, true), 'Ctrl+X', hasDoc);
  def('edit.copy', 'Copier', () => copy(false), 'Ctrl+C', hasDoc);
  def('edit.copyMerged', 'Copier avec fusion', () => copy(true), 'Ctrl+Maj+C', hasDoc);
  def('edit.paste', 'Coller', paste, 'Ctrl+V');
  def('edit.clear', 'Effacer', () => fillTarget('clear', 1, 'source-over', 'Effacer'), 'Suppr', hasDoc);
  def('edit.fill', 'Remplir…', fillDialog, 'Maj+F5', hasDoc);
  def('edit.fillPrimary', 'Remplir avec le premier plan', () => fillTarget('primary'), 'Alt+Retour', hasDoc);
  def('edit.stroke', 'Contour…', strokeSelectionDialog, '', hasSel);
  def('edit.transform', 'Transformation libre', () => app.setTool('transform'), 'Ctrl+T', hasDoc);
  def('edit.flipLayerH', 'Symétrie horizontale du calque', () => flipLayer('x'), '', hasDoc);
  def('edit.flipLayerV', 'Symétrie verticale du calque', () => flipLayer('y'), '', hasDoc);

  // Image
  def('image.size', 'Taille de l\'image…', imageSizeDialog, 'Ctrl+Alt+I', hasDoc);
  def('image.canvas', 'Taille de la zone de travail…', canvasSizeDialog, 'Ctrl+Alt+C', hasDoc);
  def('image.rotCW', 'Rotation 90° horaire', () => rotateDoc(90), '', hasDoc);
  def('image.rotCCW', 'Rotation 90° antihoraire', () => rotateDoc(-90), '', hasDoc);
  def('image.rot180', 'Rotation 180°', () => rotateDoc(180), '', hasDoc);
  def('image.rotFree', 'Rotation libre…', rotateArbitraryDialog, '', hasDoc);
  def('image.flipH', 'Symétrie horizontale', () => flipDoc('x'), '', hasDoc);
  def('image.flipV', 'Symétrie verticale', () => flipDoc('y'), '', hasDoc);
  def('image.crop', 'Outil Recadrage', () => app.setTool('crop'), 'C', hasDoc);
  def('image.cropSel', 'Recadrer sur la sélection', () => {
    const b = selectionBounds(app.doc.selection);
    if (b) cropDocTo(b, 'Recadrer sur la sélection');
  }, '', hasSel);
  def('image.trim', 'Rognage automatique (transparence)', () => {
    const b = alphaBounds(flatten(app.doc), 0);
    if (!b) return toast('Image vide');
    if (b.w === app.doc.width && b.h === app.doc.height) return toast('Rien à rogner');
    cropDocTo(b, 'Rognage');
  }, '', hasDoc);
  def('image.autoTone', 'Tonalité automatique', () => {
    if (!app.canEdit()) return;
    busy(() => app.applyToTarget('Tonalité automatique', (c) => canvasFromData(develop(getData(c), autoParams(getData(makeProxy(c, 400_000).canvas)), 1))));
  }, 'Ctrl+Maj+L', hasDoc);
  def('image.autoColor', 'Couleur automatique', () => runFilter('autolevels', { clip: 0.5 }).then(() => {}), 'Ctrl+Maj+B', hasDoc);
  def('image.autoContrast', 'Contraste automatique', () => runFilter('autocontrast', { clip: 0.3 }), 'Ctrl+Alt+Maj+L', hasDoc);

  // Intelligence artificielle (calculée sur l'appareil)
  async function subjectMask(source) {
    try {
      return await busy(() => segmentSubject(source), 'Analyse IA du sujet…');
    } catch (e) {
      console.error(e);
      toast('IA indisponible sur cet appareil');
      return null;
    }
  }

  def('ai.selectSubject', 'Sélectionner le sujet', async () => {
    const mask = await subjectMask(flatten(app.doc));
    if (!mask) return;
    app.history.push('Sélectionner le sujet', { keepPending: true });
    app.doc.selection = cloneCanvas(mask);
    app.invalidate();
    app.emit('selection');
    toast('Sujet sélectionné ✨', 1500);
  }, 'Ctrl+Alt+Maj+S', hasDoc);
  def('ai.selectBackground', 'Sélectionner l\'arrière-plan', async () => {
    const mask = await subjectMask(flatten(app.doc));
    if (!mask) return;
    app.history.push('Sélectionner l\'arrière-plan', { keepPending: true });
    app.doc.selection = invertSelection(app.doc, mask);
    app.invalidate();
    app.emit('selection');
  }, '', hasDoc);
  def('ai.removeBg', 'Supprimer l\'arrière-plan', async () => {
    const l = active();
    if (!app.canEdit(l)) return;
    const mask = await subjectMask(layerPixels(app.doc, l));
    if (!mask) return;
    layerOp('Supprimer l\'arrière-plan', (doc) => {
      if (l.mask) {
        const m = cloneCanvas(l.mask);
        const ctx = m.getContext('2d');
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(mask, 0, 0);
        l.mask = m;
      } else l.mask = cloneCanvas(mask);
      l.maskEnabled = true;
      doc.editMask = false;
    });
    toast('Arrière-plan supprimé (masque modifiable : peignez en blanc pour récupérer)', 3500);
  }, '', hasDoc);
  def('ai.replaceBg', 'Remplacer l\'arrière-plan…', async () => {
    const l = active();
    if (!app.canEdit(l)) return;
    const res = await formDialog({
      title: 'Remplacer l\'arrière-plan', okLabel: 'Appliquer',
      fields: [
        { key: 'type', label: 'Nouvel arrière-plan', type: 'select', options: [['color', 'Couleur unie'], ['gradient', 'Dégradé'], ['blur', 'Photo floutée'], ['none', 'Transparent']] },
        { key: 'color', label: 'Couleur', type: 'color', when: (v) => v.type === 'color' || v.type === 'gradient' },
        { key: 'color2', label: 'Seconde couleur', type: 'color', when: (v) => v.type === 'gradient' },
      ],
      values: { type: 'color', color: '#f2f2f5', color2: '#7b5cff' }, rebuildOn: ['type'],
    });
    if (!res) return;
    const src = layerPixels(app.doc, l);
    const mask = await subjectMask(src);
    if (!mask) return;
    const doc = app.doc;
    const bg = createCanvas(doc.width, doc.height);
    const bctx = bg.getContext('2d');
    if (res.type === 'color') {
      bctx.fillStyle = res.color;
      bctx.fillRect(0, 0, bg.width, bg.height);
    } else if (res.type === 'gradient') {
      const g = bctx.createLinearGradient(0, 0, bg.width, bg.height);
      g.addColorStop(0, res.color);
      g.addColorStop(1, res.color2);
      bctx.fillStyle = g;
      bctx.fillRect(0, 0, bg.width, bg.height);
    } else if (res.type === 'blur') {
      await busy(() => {
        const small = makeProxy(src, 600_000);
        const blurred = canvasFromData(gaussianBlur(getData(small.canvas), 18 * small.scale + 4));
        bctx.drawImage(blurred, 0, 0, bg.width, bg.height);
      }, 'Flou…');
    }
    layerOp('Remplacer l\'arrière-plan', (d) => {
      l.mask = l.mask ? (() => {
        const m = cloneCanvas(l.mask);
        const ctx = m.getContext('2d');
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(mask, 0, 0);
        return m;
      })() : cloneCanvas(mask);
      l.maskEnabled = true;
      if (res.type !== 'none') {
        const i = d.layers.indexOf(l);
        const nl = d.addLayer({ canvas: bg, name: 'Nouvel arrière-plan' }, i);
        void nl;
        d.activeId = l.id;
      }
    });
  }, '', hasDoc);
  def('ai.portrait', 'Flou d\'arrière-plan (portrait)…', async () => {
    const l = active();
    if (!app.canEdit(l)) return;
    const mask = await subjectMask(layerPixels(app.doc, l));
    if (!mask) return;
    const t = app.target();
    const proxy = makeProxy(t.canvas, 900_000);
    const smallMask = resizeCanvas(mask, proxy.canvas.width, proxy.canvas.height);
    const srcData = getData(proxy.canvas);
    const render = (v, src, m, scale) => {
      const blurred = canvasFromData(gaussianBlur(src, Math.max(0.5, v.radius * scale)));
      const subject = createCanvas(m.width, m.height);
      const sc = subject.getContext('2d');
      sc.drawImage(canvasFromData(src), 0, 0);
      sc.globalCompositeOperation = 'destination-in';
      sc.drawImage(m, 0, 0);
      const out = createCanvas(m.width, m.height);
      const oc = out.getContext('2d');
      oc.drawImage(blurred, 0, 0);
      if (v.dim) {
        oc.fillStyle = `rgba(0,0,0,${v.dim / 100})`;
        oc.fillRect(0, 0, out.width, out.height);
      }
      oc.drawImage(subject, 0, 0);
      return out;
    };
    let pending = false, latest = { radius: 14, dim: 0 };
    const preview = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => setTimeout(() => {
        pending = false;
        app.setPreview({ layerId: t.layer.id, canvas: render(latest, srcData, smallMask, proxy.scale) });
      }));
    };
    preview();
    const res = await formDialog({
      title: 'Flou d\'arrière-plan (portrait)', preview: true, okLabel: 'Appliquer',
      fields: [{ key: 'radius', label: 'Intensité du flou', type: 'range', min: 1, max: 80, unit: 'px' }, { key: 'dim', label: 'Assombrir l\'arrière-plan', type: 'range', min: 0, max: 80, unit: '%' }],
      values: latest,
      onChange: (v) => {
        latest = { ...v };
        preview();
      },
    });
    app.setPreview(null);
    if (!res) return;
    await busy(() => app.applyToTarget('Flou d\'arrière-plan', (c) => render(res, getData(c), mask, 1)), 'Flou d\'arrière-plan…');
  }, '', hasDoc);
  def('ai.contentFill', 'Remplissage d\'après le contenu', async () => {
    if (!hasSel()) return toast('Sélectionnez d\'abord la zone à faire disparaître');
    if (!app.canEdit()) return;
    const t = app.target();
    const sel = app.doc.selection;
    const out = await busy(() => contentAwareFill(t.canvas, sel), 'Remplissage intelligent…');
    if (!out) return;
    app.history.push('Remplissage d\'après le contenu');
    app.setTargetCanvas(t, out);
    app.doc.selection = null;
    app.invalidate(true);
    toast('Zone reconstruite ✨', 1500);
  }, 'Maj+Suppr', hasSel);

  // Calque
  def('layer.new', 'Nouveau calque', () => layerOp('Nouveau calque', (doc) => doc.addLayer({})), 'Ctrl+Maj+N', hasDoc);
  def('layer.newFill', 'Nouveau calque de couleur', () => layerOp('Calque de couleur', (doc) => {
    const c = createCanvas(doc.width, doc.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = app.primary;
    ctx.fillRect(0, 0, c.width, c.height);
    doc.addLayer({ canvas: c, name: 'Remplissage' });
  }), '', hasDoc);
  def('layer.duplicate', 'Dupliquer le calque', () => layerFromSelection(false), 'Ctrl+J', hasDoc);
  def('layer.viaCut', 'Calque par couper', () => layerFromSelection(true), 'Ctrl+Maj+J', hasSel);
  def('layer.delete', 'Supprimer le calque', () => {
    if (app.doc.layers.length <= 1) return toast('Le document doit garder au moins un calque');
    layerOp('Supprimer le calque', (doc) => doc.removeLayer(doc.activeId));
  }, '', hasDoc);
  def('layer.rename', 'Renommer…', async () => {
    const n = await promptDialog('Renommer le calque', 'Nom', active().name);
    if (n) layerOp('Renommer', () => (active().name = n));
  }, '', hasDoc);
  def('layer.up', 'Monter', () => moveLayer(1), 'Ctrl+]', hasDoc);
  def('layer.down', 'Descendre', () => moveLayer(-1), 'Ctrl+[', hasDoc);
  def('layer.top', 'Premier plan', () => moveLayer('top'), 'Ctrl+Maj+]', hasDoc);
  def('layer.bottom', 'Arrière-plan', () => moveLayer('bottom'), 'Ctrl+Maj+[', hasDoc);
  def('layer.mergeDown', 'Fusionner vers le bas', mergeDown, 'Ctrl+E', hasDoc);
  def('layer.mergeVisible', 'Fusionner les calques visibles', mergeVisible, 'Ctrl+Maj+E', hasDoc);
  def('layer.flatten', 'Aplatir l\'image', flattenImage, '', hasDoc);
  def('layer.effects', 'Effets du calque…', effectsDialog, '', hasDoc);
  def('layer.lock', 'Verrouiller / déverrouiller', () => layerOp('Verrouillage', () => (active().locked = !active().locked)), 'Ctrl+/', hasDoc);
  def('layer.hide', 'Afficher / masquer', () => layerOp('Visibilité', () => (active().visible = !active().visible)), 'Ctrl+,', hasDoc);
  def('layer.selectAlpha', 'Sélectionner les pixels du calque', () => layerOp('Sélection depuis le calque', (doc) => (doc.selection = selectionFromLayerAlpha(doc, active()))), '', hasDoc);
  def('mask.add', 'Ajouter un masque (tout afficher)', () => addMask('reveal'), '', hasDoc);
  def('mask.addHide', 'Ajouter un masque (tout masquer)', () => addMask('hide'), '', hasDoc);
  def('mask.fromSel', 'Masque à partir de la sélection', () => addMask('selection'), '', hasSel);
  def('mask.invert', 'Inverser le masque', () => {
    if (!active()?.mask) return toast('Aucun masque');
    layerOp('Inverser le masque', (doc) => {
      const l = active();
      const c = createCanvas(doc.width, doc.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(l.mask, 0, 0);
      l.mask = c;
    });
  }, '', hasDoc);
  def('mask.apply', 'Appliquer le masque', () => {
    if (!active()?.mask) return toast('Aucun masque');
    layerOp('Appliquer le masque', (doc) => {
      const l = active();
      l.canvas = layerPixels(doc, l);
      l.mask = null;
      doc.editMask = false;
    });
  }, '', hasDoc);
  def('mask.delete', 'Supprimer le masque', () => {
    if (!active()?.mask) return toast('Aucun masque');
    layerOp('Supprimer le masque', (doc) => {
      active().mask = null;
      doc.editMask = false;
    });
  }, '', hasDoc);
  def('mask.toggle', 'Activer / désactiver le masque', () => {
    if (!active()?.mask) return addMask('reveal');
    layerOp('Masque activé/désactivé', () => (active().maskEnabled = !active().maskEnabled));
  }, '', hasDoc);
  def('layer.flipH', 'Symétrie horizontale du calque', () => flipLayer('x'), '', hasDoc);
  def('layer.flipV', 'Symétrie verticale du calque', () => flipLayer('y'), '', hasDoc);

  // Sélection
  const setSel = (label, fn) => {
    if (!hasDoc()) return;
    const next = fn(app.doc);
    if (next === undefined) return;
    app.history.push(label, { keepPending: true });
    app.doc.selection = next;
    app.invalidate();
    app.emit('selection');
  };
  def('sel.all', 'Tout sélectionner', () => setSel('Tout sélectionner', (d) => selectAll(d)), 'Ctrl+A', hasDoc);
  def('sel.none', 'Désélectionner', () => hasSel() && setSel('Désélectionner', () => null), 'Ctrl+D', hasSel);
  def('sel.invert', 'Inverser la sélection', () => setSel('Inverser la sélection', (d) => (d.selection ? invertSelection(d, d.selection) : selectAll(d))), 'Ctrl+Maj+I', hasDoc);
  def('sel.feather', 'Contour progressif…', async () => {
    const r = await formDialog({ title: 'Contour progressif', fields: [{ key: 'radius', label: 'Rayon', type: 'range', min: 1, max: 250, unit: 'px' }], values: { radius: 10 }, okLabel: 'Appliquer' });
    if (r) await busy(() => setSel('Contour progressif', (d) => featherSelection(d.selection, r.radius)));
  }, 'Maj+F6', hasSel);
  def('sel.grow', 'Étendre…', async () => {
    const r = await formDialog({ title: 'Étendre la sélection', fields: [{ key: 'px', label: 'Étendre de', type: 'range', min: 1, max: 200, unit: 'px' }], values: { px: 8 }, okLabel: 'Appliquer' });
    if (r) await busy(() => setSel('Étendre la sélection', (d) => growSelection(d.selection, r.px)));
  }, '', hasSel);
  def('sel.shrink', 'Contracter…', async () => {
    const r = await formDialog({ title: 'Contracter la sélection', fields: [{ key: 'px', label: 'Contracter de', type: 'range', min: 1, max: 200, unit: 'px' }], values: { px: 8 }, okLabel: 'Appliquer' });
    if (r) await busy(() => setSel('Contracter la sélection', (d) => growSelection(d.selection, -r.px)));
  }, '', hasSel);
  def('sel.colorRange', 'Plage de couleurs…', async () => {
    const r = await formDialog({ title: 'Plage de couleurs', fields: [{ key: 'color', label: 'Couleur', type: 'color' }, { key: 'fuzz', label: 'Tolérance', type: 'range', min: 1, max: 100 }], values: { color: app.primary, fuzz: 30 }, okLabel: 'Sélectionner' });
    if (r) await busy(() => setSel('Plage de couleurs', (d) => colorRangeSelection(d, app.compositeCanvas, hexToRgb(r.color), r.fuzz)));
  }, '', hasDoc);
  def('sel.layer', 'Sélectionner les pixels du calque', () => cmds['layer.selectAlpha'].run(), '', hasDoc);
  def('sel.hide', 'Masquer les contours', () => {
    app.hideSelection = !app.hideSelection;
    app.view.requestRender();
  }, 'Ctrl+H', hasSel);

  // Filtres
  def('filter.last', 'Dernier filtre', () => app.lastFilter && runFilter(app.lastFilter.id, app.lastFilter.values), 'Ctrl+F', () => !!app.lastFilter);
  for (const f of FILTERS) def(`filter.${f.id}`, f.name, () => runFilter(f.id));

  // Affichage
  def('view.zoomIn', 'Zoom avant', () => app.view.zoomBy(1.25, app.view.cssW / 2, app.view.cssH / 2), 'Ctrl++', hasDoc);
  def('view.zoomOut', 'Zoom arrière', () => app.view.zoomBy(0.8, app.view.cssW / 2, app.view.cssH / 2), 'Ctrl+-', hasDoc);
  def('view.fit', 'Ajuster à l\'écran', () => app.view.fit(), 'Ctrl+0', hasDoc);
  def('view.actual', 'Pixels réels (100 %)', () => app.view.actualPixels(), 'Ctrl+1', hasDoc);
  def('view.grid', 'Grille des tiers', () => {
    app.view.showGrid = !app.view.showGrid;
    app.view.requestRender();
  }, 'Ctrl+\'', hasDoc);
  def('view.pixelGrid', 'Grille de pixels (zoom fort)', () => {
    app.view.showPixelGrid = !app.view.showPixelGrid;
    app.view.requestRender();
  }, '', hasDoc);
  def('view.panels', 'Afficher / masquer les panneaux', () => ui.togglePanels(), 'Tab');
  def('view.fullscreen', 'Plein écran', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => toast('Plein écran indisponible'));
  }, 'F11');
  def('view.compare', 'Avant / après (basculer)', () => {
    app.showOriginal = !app.showOriginal;
    app.view.requestRender();
    toast(app.showOriginal ? 'Affichage : AVANT (original)' : 'Affichage : APRÈS', 900);
  }, '\\', hasDoc);

  // Aide
  def('help.shortcuts', 'Raccourcis clavier', () => shortcutsDialog(), 'F1');
  def('help.about', `À propos de ${APP_NAME}`, () => aboutDialog());

  function shortcutsDialog() {
    const rows = Object.values(cmds).filter((c) => c.shortcut).map((c) => [c.label, c.shortcut]);
    const tools = Object.values(app.tools).filter((t) => t.key).map((t) => [`Outil : ${t.name}`, t.key]);
    const extra = [['Taille du pinceau', '[ et ]'], ['Couleurs par défaut', 'D'], ['Inverser les couleurs', 'X'], ['Déplacer la vue', 'Espace + glisser'], ['Zoom', 'Molette / pincement'], ['Pipette pendant la peinture', 'Alt + clic'], ['Valider (recadrage, transformation)', 'Entrée'], ['Annuler l\'opération', 'Échap']];
    const kv = el('dl', { class: 'kv' });
    for (const [a, b] of [...rows, ...tools, ...extra]) kv.append(el('dt', {}, a), el('dd', {}, b));
    modal({ title: 'Raccourcis clavier', wide: true, body: kv, buttons: [{ label: 'Fermer', primary: true, value: true }] });
  }

  function aboutDialog() {
    modal({
      title: `À propos de ${APP_NAME}`,
      body: el('div', { style: { textAlign: 'center' } },
        el('img', { src: 'icons/icon-256.png', style: { width: '96px', borderRadius: '22px' } }),
        el('h2', { style: { margin: '10px 0 2px' } }, `${APP_NAME} Photo`),
        el('div', { class: 'hint' }, `Version ${APP_VERSION}`),
        el('div', { style: { margin: '16px 0 6px', color: 'var(--muted)' } }, 'Une création'),
        el('img', { src: 'icons/superessence.png', alt: 'SuperEssence', style: { width: '220px', maxWidth: '80%' } }),
        el('div', { style: { color: '#ffcc1f', fontWeight: 800, letterSpacing: '4px', fontSize: '12px', marginTop: '4px' } }, 'S T U D I O'),
        el('p', { class: 'hint', style: { marginTop: '16px' } }, `${Object.keys(app.tools).length} outils · ${FILTERS.length} filtres et réglages · calques, masques, effets, looks, export JPEG/PNG/WebP. Fonctionne hors ligne, vos photos restent sur votre appareil.`),
        el('p', { class: 'hint' }, `© ${new Date().getFullYear()} SuperEssence Studio. Tous droits réservés.`)),
      buttons: [{ label: 'Fermer', primary: true, value: true }],
    });
  }

  // ---------- Menus ----------

  const item = (id, extra = {}) => {
    const c = cmds[id];
    return { label: c.label, shortcut: c.shortcut, action: () => run(id), disabled: c.enabled ? !c.enabled() : false, ...extra };
  };
  const sep = { sep: true };

  function layerMenu() {
    return [item('layer.new'), item('layer.newFill'), item('layer.duplicate'), item('layer.viaCut'), item('layer.delete'), item('layer.rename'), sep,
      item('layer.effects'), item('layer.lock'), item('layer.hide'), item('layer.selectAlpha'), sep,
      { label: 'Masque de fusion', submenu: () => [item('mask.add'), item('mask.addHide'), item('mask.fromSel'), item('mask.invert'), item('mask.toggle'), item('mask.apply'), item('mask.delete')] },
      { label: 'Disposition', submenu: () => [item('layer.top'), item('layer.up'), item('layer.down'), item('layer.bottom')] },
      { label: 'Transformation', submenu: () => [item('edit.transform'), item('layer.flipH'), item('layer.flipV')] }, sep,
      item('layer.mergeDown'), item('layer.mergeVisible'), item('layer.flatten')];
  }

  function menus() {
    return [
      { label: 'Fichier', items: () => [item('file.new'), item('file.open'), item('file.camera'), item('file.openLayer'), sep, item('file.save'), item('file.export'), item('file.quickExport'), sep, item('file.close')] },
      { label: 'Édition', items: () => [item('edit.undo'), item('edit.redo'), sep, item('edit.cut'), item('edit.copy'), item('edit.copyMerged'), item('edit.paste'), item('edit.clear'), sep, item('edit.fill'), item('ai.contentFill'), item('edit.fillPrimary'), item('edit.stroke'), sep, item('edit.transform'), item('edit.flipLayerH'), item('edit.flipLayerV')] },
      { label: 'Image', items: () => [
        { label: 'Réglages', submenu: () => FILTERS.filter((f) => f.cat === 'Réglages').map((f) => item(`filter.${f.id}`)) },
        item('image.autoTone'), item('image.autoContrast'), item('image.autoColor'), sep,
        { head: 'Intelligence artificielle' }, item('ai.removeBg'), item('ai.replaceBg'), item('ai.portrait'), item('ai.contentFill'), sep,
        item('image.size'), item('image.canvas'), sep,
        { label: 'Rotation de l\'image', submenu: () => [item('image.rotCW'), item('image.rotCCW'), item('image.rot180'), item('image.rotFree'), sep, item('image.flipH'), item('image.flipV')] },
        item('image.crop'), item('image.cropSel'), item('image.trim')] },
      { label: 'Calque', items: layerMenu },
      { label: 'Sélection', items: () => [item('sel.all'), item('sel.none'), item('sel.invert'), sep, item('ai.selectSubject'), item('ai.selectBackground'), sep, item('sel.colorRange'), item('sel.layer'), sep, item('sel.feather'), item('sel.grow'), item('sel.shrink'), sep, item('sel.hide')] },
      { label: 'Filtre', items: () => [item('filter.last'), sep, ...FILTER_CATEGORIES.map((cat) => ({ label: cat, submenu: () => FILTERS.filter((f) => f.cat === cat).map((f) => item(`filter.${f.id}`)) }))] },
      { label: 'Affichage', items: () => [item('view.zoomIn'), item('view.zoomOut'), item('view.fit'), item('view.actual'), sep, item('view.grid', { checked: app.view.showGrid }), item('view.pixelGrid', { checked: app.view.showPixelGrid }), item('view.compare'), sep, item('view.panels'), item('view.fullscreen')] },
      { label: 'Aide', items: () => [item('help.shortcuts'), item('help.about')] },
    ];
  }

  function run(id) {
    const c = cmds[id];
    if (!c) return;
    if (c.enabled && !c.enabled()) return;
    try {
      const r = c.run();
      if (r && r.catch) r.catch((e) => {
        console.error(e);
        toast(`Erreur : ${e.message || e}`);
      });
    } catch (e) {
      console.error(e);
      toast(`Erreur : ${e.message || e}`);
    }
  }

  // ---------- Raccourcis ----------

  const comboOf = (e) => {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Maj');
    let k = e.key;
    const named = { Delete: 'Suppr', Backspace: 'Suppr', Enter: 'Retour', '=': '+', Escape: 'Échap' };
    if (named[k]) k = named[k];
    else if (k.length === 1) k = k.toUpperCase();
    if (e.code === 'BracketRight') k = ']';
    if (e.code === 'BracketLeft') k = '[';
    if (e.code === 'Backslash' || e.code === 'IntlBackslash') k = '\\';
    if (e.code === 'Quote') k = '\'';
    if (e.code === 'Slash') k = '/';
    if (e.code === 'Comma') k = ',';
    if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
    if (/^Key[A-Z]$/.test(e.code) && (e.ctrlKey || e.metaKey || e.altKey)) k = e.code.slice(3);
    if (e.code === 'NumpadAdd' || e.code === 'Equal') k = '+';
    if (e.code === 'NumpadSubtract' || e.code === 'Minus') k = '-';
    parts.push(k);
    return parts.join('+');
  };

  const shortcutMap = () => {
    const m = {};
    for (const c of Object.values(cmds)) if (c.shortcut && c.shortcut.length > 1) m[c.shortcut] = c.id;
    m['Ctrl+Maj+Z'] = 'edit.redo';
    m['Ctrl+='] = 'view.zoomIn';
    m['Ctrl+Maj++'] = 'view.zoomIn';
    return m;
  };

  function handleKey(e) {
    if (isTyping(e) || document.querySelector('.modal-back:not(.preview-mode)')) return;
    if (document.querySelector('.modal-back.preview-mode') && !(e.ctrlKey || e.metaKey)) return;
    const tool = app.tool;
    if (tool?.keydown && !(e.ctrlKey || e.metaKey) && tool.keydown(e)) {
      e.preventDefault();
      return;
    }
    const combo = comboOf(e);
    const map = shortcutMap();
    if (map[combo]) {
      e.preventDefault();
      run(map[combo]);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toUpperCase();
    if (e.key === '[' || e.key === ']') {
      if ('size' in (tool?.opts || {})) {
        const s = tool.opts.size;
        const step = s < 10 ? 1 : s < 50 ? 5 : s < 200 ? 10 : 25;
        tool.setOpt('size', Math.max(1, Math.min(1000, s + (e.key === ']' ? step : -step))));
        app.emit('tool-options');
      }
      return;
    }
    if (k === 'X') return app.swapColors();
    if (k === 'D') return app.resetColors();
    if (e.key === 'Tab') {
      e.preventDefault();
      return ui.togglePanels();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') return run('edit.clear');
    if (e.key === 'Escape') {
      if (hasSel()) run('sel.none');
      return;
    }
    if (e.key === '\\') return run('view.compare');
    if (k === 'F' && !e.repeat) return run('view.fullscreen');
    // Outils : une touche ; la répéter fait défiler les outils partageant la même lettre
    const candidates = Object.values(app.tools).filter((t) => t.key === k);
    if (candidates.length) {
      const i = candidates.indexOf(tool);
      app.setTool(candidates[(i + 1) % candidates.length].id);
    }
  }

  return { run, cmds, menus, layerMenu, runFilter, handleKey, pasteBlob, newDocDialog, fillTarget };
}
