// Démarrage de Prisme : assemble l'application, les outils, l'interface et les panneaux.

import { App, loadPref, savePref } from './app.js';
import { el, $, $$, isMobileLayout, isCapacitor, isElectron, createCanvas, APP_NAME } from './util.js';
import { icon } from './icons.js';
import { toast, dropdown, closeDropdown, textDialog, colorPicker } from './ui.js';
import { createActions } from './actions.js';
import { openImageFile, setupAutosave, getAutosave, restoreAutosave, exportDialog } from './io.js';
import { DevelopSession, developPanel, looksPanel, layersPanel, filtersPanel, historyPanel, infoPanel } from './panels.js';
import { BrushTool, CloneTool, HealTool, SmudgeTool, DodgeTool, BlurBrushTool, RedEyeTool } from './tools/paint.js';
import { MarqueeTool, LassoTool, PolyLassoTool, WandTool, QuickSelectTool } from './tools/select.js';
import { MoveTool, TransformTool, CropTool, FillTool, GradientTool, EyedropperTool, TextTool, ShapeTool, HandTool, ZoomTool } from './tools/misc.js';

const app = new App();
window.prisme = app; // pratique pour le débogage
app.attachView($('#canvas'));
app.toast = toast;

// ---------- Outils ----------

const toolList = [
  new MoveTool(app), new TransformTool(app), new CropTool(app), null,
  new MarqueeTool(app, 'rect'), new MarqueeTool(app, 'ellipse'), new LassoTool(app), new PolyLassoTool(app), new QuickSelectTool(app), new WandTool(app), null,
  new BrushTool(app), new BrushTool(app, { id: 'pencil', name: 'Crayon', icon: 'pencil', key: 'N', pencil: true, defaults: { size: 4, opacity: 100, pressure: false, mode: 'source-over', hardness: 100, flow: 100, spacing: 10, smoothing: 0 } }),
  new BrushTool(app, { id: 'eraser', name: 'Gomme', icon: 'eraser', key: 'E', erase: true }), new FillTool(app), new GradientTool(app), new EyedropperTool(app), null,
  new HealTool(app), new CloneTool(app), new SmudgeTool(app), new DodgeTool(app), new BlurBrushTool(app), new RedEyeTool(app), null,
  new TextTool(app), new ShapeTool(app), null,
  new HandTool(app), new ZoomTool(app),
];
for (const t of toolList) if (t) app.registerTool(t);

// ---------- Session de développement & actions ----------

const session = new DevelopSession(app);
app.develop = session;

const ui = {
  textDialog,
  toast,
  pickFiles(mode = 'replace', camera = false) {
    const input = $('#file-input');
    input.multiple = mode === 'layer';
    if (camera) input.setAttribute('capture', 'environment');
    else input.removeAttribute('capture');
    input.accept = camera ? 'image/*' : 'image/*,.prisme,.json';
    input.onchange = async () => {
      const files = [...input.files];
      input.value = '';
      for (const [i, f] of files.entries()) await openImageFile(app, f, mode === 'layer' || i > 0 ? 'layer' : 'replace');
      if (app.doc) ui.hideWelcome();
    };
    input.click();
  },
  showWelcome,
  hideWelcome,
  togglePanels() {
    document.body.classList.toggle('no-panels');
    const ws = $('#workspace');
    ws.style.gridTemplateColumns = document.body.classList.contains('no-panels') ? '0 1fr 0' : '';
    $('#toolbar').style.display = document.body.classList.contains('no-panels') && !isMobileLayout() ? 'none' : '';
    $('#sidebar').style.display = document.body.classList.contains('no-panels') && !isMobileLayout() ? 'none' : '';
    setTimeout(() => app.view.resize(), 50);
  },
};
app.ui = ui;
const actions = createActions(app, ui);
app.actions = actions;
window.__prismeRecent = app.recentColors;
app.on('colors', () => (window.__prismeRecent = app.recentColors));

// ---------- Barre du haut ----------

$('#btn-menu').innerHTML = icon('menu');
$('#btn-undo').innerHTML = icon('undo');
$('#btn-redo').innerHTML = icon('redo');
$('#btn-compare').innerHTML = icon('compare');
$('#btn-export').insertAdjacentHTML('afterbegin', icon('download', 18));
$('#btn-undo').onclick = () => actions.run('edit.undo');
$('#btn-redo').onclick = () => actions.run('edit.redo');
$('#btn-export').onclick = () => (app.doc ? exportDialog(app) : ui.pickFiles());
$('#zoom-label').onclick = () => app.view.fit();
const compare = $('#btn-compare');
const showBefore = (on) => {
  if (!app.doc) return;
  app.showOriginal = on;
  compare.classList.toggle('active', on);
  app.view.requestRender();
};
compare.addEventListener('pointerdown', () => showBefore(true));
compare.addEventListener('pointerup', () => showBefore(false));
compare.addEventListener('pointerleave', () => showBefore(false));

const updateTop = () => {
  $('#btn-undo').disabled = !app.history.canUndo;
  $('#btn-redo').disabled = !app.history.canRedo;
  $('#zoom-label').textContent = `${Math.round(app.view.zoom * 100)} %`;
};
app.on('history', updateTop);
app.on('zoom', updateTop);
app.on('document', updateTop);
app.on('document-restored', updateTop);

// Menus (bureau) et menu hamburger (mobile)
const menubar = $('#menubar');
let menuOpen = false;
for (const m of actions.menus()) {
  const b = el('button', { class: 'menu-btn' }, m.label);
  const open = () => {
    $$('.menu-btn', menubar).forEach((x) => x.classList.remove('open'));
    b.classList.add('open');
    menuOpen = true;
    dropdown(b, m.items(), { onClose: () => {
      b.classList.remove('open');
      setTimeout(() => (menuOpen = false), 0);
    } });
  };
  b.addEventListener('click', () => (b.classList.contains('open') ? closeDropdown() : open()));
  b.addEventListener('mouseenter', () => menuOpen && !b.classList.contains('open') && open());
  menubar.append(b);
}
$('#btn-menu').onclick = (e) => {
  dropdown(e.currentTarget, [
    ...actions.menus().map((m) => ({ label: m.label, submenu: m.items })),
    { sep: true },
    { label: 'Panneau Infos', action: () => showPanel('info') },
    { label: 'Panneau Historique', action: () => showPanel('history') },
  ]);
};

// ---------- Barre d'outils ----------

function buildToolbar() {
  const tb = $('#toolbar');
  tb.innerHTML = '';
  for (const t of toolList) {
    if (!t) {
      tb.append(el('div', { class: 'tool-sep' }));
      continue;
    }
    const b = el('button', { class: 'tool-btn', title: `${t.name}${t.key ? ` (${t.key})` : ''}`, 'data-tool': t.id, html: icon(t.icon) });
    b.addEventListener('click', () => {
      app.setTool(t.id);
      if (isMobileLayout()) closeSheet();
    });
    tb.append(b);
  }
  const sw = el('div', { class: 'swatches' });
  const prim = el('div', { class: 'swatch primary', title: 'Couleur de premier plan' });
  const sec = el('div', { class: 'swatch secondary', title: 'Couleur d\'arrière-plan' });
  prim.onclick = () => colorPicker(prim, app.primary, (hex) => app.setColor('primary', hex), app.recentColors);
  sec.onclick = () => colorPicker(sec, app.secondary, (hex) => app.setColor('secondary', hex), app.recentColors);
  sw.append(prim, sec);
  tb.append(sw, el('div', { class: 'swatch-mini' },
    el('button', { title: 'Inverser (X)', html: icon('swap', 14), onclick: () => app.swapColors() }),
    el('button', { title: 'Noir et blanc (D)', onclick: () => app.resetColors() }, '◩')));
  const refresh = () => {
    prim.style.background = app.primary;
    sec.style.background = app.secondary;
  };
  app.on('colors', refresh);
  refresh();
}
buildToolbar();
app.on('tool', (t) => {
  $$('.tool-btn').forEach((b) => b.classList.toggle('on', b.dataset.tool === t.id));
  renderOptions();
  updateStatus();
});

// ---------- Barre d'options de l'outil ----------

function renderOptions() {
  const bar = $('#optionsbar');
  bar.innerHTML = '';
  const t = app.tool;
  if (!t) return;
  bar.append(el('div', { class: 'opt' }, el('span', { html: icon(t.icon, 18) }), el('span', { class: 'opt-title' }, t.name)));
  for (const o of t.options()) {
    bar.append(el('div', { class: 'opt-sep' }));
    const v = t.opts[o.key];
    const type = o.type || 'range';
    if (type === 'range') {
      const toSlider = (x) => (o.log ? Math.log(x) / Math.log(o.max) * 1000 : x);
      const fromSlider = (x) => (o.log ? Math.max(o.min, Math.round(Math.exp((x / 1000) * Math.log(o.max)))) : Number(x));
      const val = el('span', { class: 'val' }, `${v}${o.unit || ''}`);
      const r = el('input', { type: 'range', min: o.log ? 0 : o.min, max: o.log ? 1000 : o.max, step: o.log ? 1 : o.step || 1, value: toSlider(v) });
      r.addEventListener('input', () => {
        const x = fromSlider(r.value);
        val.textContent = `${x}${o.unit || ''}`;
        t.setOpt(o.key, x);
      });
      bar.append(el('label', { class: 'opt' }, o.label, r, val));
    } else if (type === 'select') {
      const s = el('select', {}, ...o.options.map(([k, l]) => el('option', { value: k, selected: String(k) === String(v) ? true : null }, l)));
      s.addEventListener('change', () => {
        const opt = o.options.find(([k]) => String(k) === s.value);
        t.setOpt(o.key, opt ? opt[0] : s.value);
      });
      bar.append(el('label', { class: 'opt' }, o.label, s));
    } else if (type === 'checkbox') {
      const c = el('input', { type: 'checkbox', checked: !!v });
      c.addEventListener('change', () => t.setOpt(o.key, c.checked));
      bar.append(el('label', { class: 'opt check' }, c, o.label));
    } else if (type === 'toggle') {
      const b = el('button', { class: `btn small${v ? ' primary' : ''}`, title: o.hint || '' }, o.label);
      b.addEventListener('click', () => {
        t.setOpt(o.key, !t.opts[o.key]);
        renderOptions();
      });
      bar.append(el('div', { class: 'opt' }, b));
    } else if (type === 'segmented') {
      const seg = el('div', { class: 'seg' });
      for (const [k, l, title] of o.options) {
        const b = el('button', { class: String(k) === String(v) ? 'on' : '', title: title || '' }, l);
        b.addEventListener('click', () => {
          t.setOpt(o.key, k);
          renderOptions();
        });
        seg.append(b);
      }
      bar.append(el('div', { class: 'opt' }, o.label ? el('span', {}, o.label) : null, seg));
    } else if (type === 'button') {
      bar.append(el('div', { class: 'opt' }, el('button', { class: `btn small${o.primary ? ' primary' : ''}`, title: o.title || '', onclick: () => o.action() }, o.label)));
    } else if (type === 'info') {
      bar.append(el('div', { class: 'opt' }, o.label));
    }
  }
  // Couleur rapide pour les outils de peinture
  if (['brush', 'pencil', 'fill', 'shape', 'text', 'gradient'].includes(t.id)) {
    bar.append(el('div', { class: 'opt-sep' }));
    const sw = el('button', { class: 'color-input', title: 'Couleur', style: { background: app.primary } });
    sw.onclick = () => colorPicker(sw, app.primary, (hex) => {
      sw.style.background = hex;
      app.setColor('primary', hex);
    }, app.recentColors);
    bar.append(el('div', { class: 'opt' }, 'Couleur', sw));
  }
}
app.on('tool-options', renderOptions);
app.on('colors', () => {
  const sw = $('#optionsbar .color-input');
  if (sw) sw.style.background = app.primary;
});

// ---------- Panneaux ----------

const panels = {
  adjust: { label: 'Réglages', icon: 'sliders', make: () => developPanel(app, session) },
  looks: { label: 'Looks', icon: 'sparkles', make: () => looksPanel(app, session) },
  layers: { label: 'Calques', icon: 'layers', make: () => layersPanel(app, actions) },
  filters: { label: 'Filtres', icon: 'filter', make: () => filtersPanel(app, actions) },
  history: { label: 'Historique', icon: 'history', make: () => historyPanel(app) },
  info: { label: 'Infos', icon: 'info', make: () => infoPanel(app) },
};
let currentPanel = null;

function showPanel(id) {
  const p = panels[id];
  if (!p) return;
  // Quitter Réglages / Looks valide les réglages en cours.
  if (currentPanel && ['adjust', 'looks'].includes(currentPanel) && !['adjust', 'looks'].includes(id) && session.active) {
    session.commit();
    toast('Réglages appliqués ✔', 1200);
  }
  p.root ||= p.make();
  const body = $('#panel-body');
  body.innerHTML = '';
  body.append(p.root);
  p.root.refresh?.();
  currentPanel = id;
  savePref('panel', id);
  $$('.ptab').forEach((b) => b.classList.toggle('on', b.dataset.panel === id));
  $$('.mtab').forEach((b) => b.classList.toggle('on', b.dataset.panel === id));
  if (isMobileLayout()) openSheet(id);
}

const tabs = $('#panel-tabs');
for (const [id, p] of Object.entries(panels)) {
  tabs.append(el('button', { class: 'ptab', 'data-panel': id, onclick: () => showPanel(id), html: `${icon(p.icon, 18)}<span>${p.label}</span>` }));
}

// Onglets mobiles + feuille coulissante
const mtabs = $('#mobile-tabs');
const mobileTabs = [['tools', 'Outils', 'tools'], ['adjust', 'Réglages', 'sliders'], ['looks', 'Looks', 'sparkles'], ['filters', 'Filtres', 'filter'], ['layers', 'Calques', 'layers'], ['history', 'Historique', 'history']];
for (const [id, label, ic] of mobileTabs) {
  mtabs.append(el('button', { class: 'mtab', 'data-panel': id, html: `${icon(ic, 20)}<span>${label}</span>`, onclick: () => {
    if (id === 'tools') return closeSheet();
    if ($('#sidebar').classList.contains('open') && currentPanel === id) return closeSheet();
    showPanel(id);
  } }));
}

function openSheet(id) {
  $('#sidebar').classList.add('open');
  $('#sidebar').classList.toggle('tall', id === 'adjust' || id === 'filters');
  $('#toolbar').classList.add('sheet-open');
  $$('.mtab').forEach((b) => b.classList.toggle('on', b.dataset.panel === id));
  refitSoon();
}

// Sur mobile la photo se réduit au-dessus du panneau : on recadre la vue après l'animation.
function refitSoon() {
  setTimeout(() => {
    app.view.resize();
    if (app.doc) app.view.fit();
  }, 30);
}

function closeSheet() {
  $('#sidebar').classList.remove('open');
  $('#toolbar').classList.remove('sheet-open');
  $$('.mtab').forEach((b) => b.classList.toggle('on', b.dataset.panel === 'tools'));
  if (isMobileLayout()) refitSoon();
}

// Glisser la poignée vers le bas ferme la feuille
{
  const handle = $('.sheet-handle');
  let y0 = null;
  handle.addEventListener('pointerdown', (e) => (y0 = e.clientY));
  handle.addEventListener('click', closeSheet);
  window.addEventListener('pointerup', (e) => {
    if (y0 != null && e.clientY - y0 > 40) closeSheet();
    y0 = null;
  });
}

// ---------- Barre d'état ----------

const status = $('#statusbar');
let cursorText = '';
function updateStatus() {
  const doc = app.doc;
  status.innerHTML = '';
  if (!doc) {
    status.append(el('span', {}, `${APP_NAME} · par SuperEssence Studio`));
    return;
  }
  status.append(
    el('span', { class: 'chip' }, `${doc.width} × ${doc.height} px`),
    el('span', { class: 'chip' }, `Zoom ${Math.round(app.view.zoom * 100)} %`),
    el('span', { class: 'chip' }, `Calque : ${doc.active?.name || '—'}${doc.editMask ? ' (masque)' : ''}`),
    el('span', { class: 'chip' }, app.tool?.name || ''),
    el('span', { class: 'chip' }, cursorText),
    el('span', { class: 'chip', style: { marginLeft: 'auto' } }, `${APP_NAME} · SuperEssence Studio`));
}
app.on('cursor', (p) => {
  if (!app.doc) return;
  cursorText = `x ${Math.round(p.x)}  y ${Math.round(p.y)}`;
  const chip = status.children[4];
  if (chip) chip.textContent = cursorText;
});
['zoom', 'layers', 'document', 'document-restored'].forEach((ev) => app.on(ev, updateStatus));

// ---------- Accueil ----------

async function showWelcome() {
  const w = $('#welcome');
  w.hidden = false;
  w.innerHTML = '';
  const card = (ic, title, sub, fn) => el('button', { class: 'wcard', onclick: fn, html: `${icon(ic, 30)}<span>${title}</span><small>${sub}</small>` });
  const actionsBox = el('div', { class: 'welcome-actions' },
    card('image', 'Ouvrir une photo', 'JPEG, PNG, WebP, GIF, AVIF…', () => ui.pickFiles('replace')),
    card('plus', 'Nouveau document', 'Formats réseaux sociaux, A4, 4K…', () => actions.newDocDialog()),
    isMobileLayout() || isCapacitor() ? card('camera', 'Prendre une photo', 'Appareil photo', () => ui.pickFiles('replace', true)) : null,
    card('sparkles', 'Essayer la démo', 'Image d\'exemple', () => openDemo()));
  const inner = el('div', { class: 'welcome-inner' },
    el('img', { class: 'logo', src: 'icons/icon-256.png', alt: '' }),
    el('h1', {}, `${APP_NAME} Photo`),
    el('p', { class: 'sub' }, 'Éditeur photo complet — calques, masques, retouche, réglages pro, looks et filtres.'),
    actionsBox);
  const saved = await getAutosave();
  if (saved && saved.layers?.length) {
    const thumbUrl = saved.thumb ? URL.createObjectURL(saved.thumb) : null;
    const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString('fr-FR') : '';
    inner.append(el('div', { style: { marginTop: '14px' } }, el('button', { class: 'wcard', style: { flexDirection: 'row', width: '100%', justifyContent: 'flex-start', textAlign: 'left' }, onclick: async () => {
      await restoreAutosave(app, saved);
      hideWelcome();
    } }, thumbUrl ? el('img', { src: thumbUrl, style: { width: '64px', height: '48px', objectFit: 'cover', borderRadius: '8px' } }) : null,
    el('span', {}, 'Reprendre la dernière session', el('small', { style: { display: 'block' } }, `${saved.name || 'Projet'} · ${saved.width}×${saved.height} · ${when}`)))));
  }
  inner.append(el('div', { class: 'feature-list' },
    ...['✨ Détourage IA', '✨ Suppression d\'objet IA', '✨ Flou portrait IA', 'Calques & masques', '16 modes de fusion', 'Courbes & TSL', 'Étalonnage couleur', '23 looks', `${actions && Object.keys(actions.cmds).filter((k) => k.startsWith('filter.')).length - 1} filtres & réglages`, 'Correcteur & tampon', 'Sélection rapide', 'Texte & formes', 'Recadrage & redressement', 'Effets de calque', 'Historique 60 étapes', 'Hors ligne', 'Export JPEG/PNG/WebP'].map((t) => el('span', {}, t))));
  inner.append(el('div', { style: { marginTop: '28px', color: 'var(--faint)', fontSize: '12px' } }, 'Une création ', el('b', { style: { color: '#fff' } }, 'Super'), el('b', { style: { color: '#ffcc1f' } }, 'Essence'), ' Studio'));
  w.append(inner);
  updateStatus();
}

function hideWelcome() {
  $('#welcome').hidden = true;
}

// Image de démonstration générée (paysage au coucher du soleil).
function openDemo() {
  const W = 1800, H = 1200;
  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.62);
  sky.addColorStop(0, '#1b2a5c');
  sky.addColorStop(0.45, '#c2577a');
  sky.addColorStop(0.8, '#f59f5b');
  sky.addColorStop(1, '#ffd38a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  const sun = ctx.createRadialGradient(W * 0.62, H * 0.5, 10, W * 0.62, H * 0.5, 260);
  sun.addColorStop(0, 'rgba(255,248,220,1)');
  sun.addColorStop(0.25, 'rgba(255,214,140,0.9)');
  sun.addColorStop(1, 'rgba(255,170,100,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, W, H);
  const mountain = (base, amp, color, seed) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 10) {
      const y = base - amp * (0.5 + 0.3 * Math.sin(x / 210 + seed) + 0.2 * Math.sin(x / 67 + seed * 3) + 0.08 * Math.sin(x / 23 + seed));
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.fill();
  };
  mountain(H * 0.6, 260, '#6b3f6e', 1);
  mountain(H * 0.63, 190, '#4a2d59', 4);
  mountain(H * 0.66, 120, '#2e1d3f', 7);
  const lake = ctx.createLinearGradient(0, H * 0.66, 0, H);
  lake.addColorStop(0, '#e7956a');
  lake.addColorStop(0.3, '#7a4a78');
  lake.addColorStop(1, '#1a1730');
  ctx.fillStyle = lake;
  ctx.fillRect(0, H * 0.66, W, H * 0.34);
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#fff2d0';
  for (let i = 0; i < 40; i++) ctx.fillRect(W * 0.62 - 120 + Math.sin(i) * 60, H * 0.68 + i * 9, 240 - i * 4, 2);
  ctx.globalAlpha = 1;
  // Pins en silhouette
  ctx.fillStyle = '#120d1c';
  for (let i = 0; i < 26; i++) {
    const x = (i < 13 ? i * 34 : W - (i - 13) * 36) + (i % 3) * 7, h = 140 + ((i * 37) % 90), y = H * 0.67;
    ctx.beginPath();
    ctx.moveTo(x, y - h);
    ctx.lineTo(x - h * 0.22, y);
    ctx.lineTo(x + h * 0.22, y);
    ctx.fill();
  }
  // Grain léger
  const img = ctx.getImageData(0, 0, W, H);
  for (let p = 0; p < img.data.length; p += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[p] += n;
    img.data[p + 1] += n;
    img.data[p + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  app.newDocument(W, H, null, 'Démo coucher de soleil');
  app.doc.layers[0].canvas = c;
  app.doc.layers[0].name = 'Arrière-plan';
  app.originalCanvas = createCanvas(W, H);
  app.originalCanvas.getContext('2d').drawImage(c, 0, 0);
  app.invalidate(true);
  app.emit('document');
  hideWelcome();
}

// ---------- Fichiers : glisser-déposer & coller ----------

let dragDepth = 0, dropHint = null;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  if (dragDepth++ === 0) dropHint = document.body.appendChild(el('div', { class: 'drop-hint' }, app.doc ? 'Déposez : ouvrir (ou Maj = comme calque)' : 'Déposez votre photo ici'));
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropHint?.remove();
  }
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropHint?.remove();
  const files = [...(e.dataTransfer?.files || [])];
  for (const [i, f] of files.entries()) await openImageFile(app, f, (app.doc && e.shiftKey) || i > 0 ? 'layer' : 'replace');
  if (app.doc) hideWelcome();
});
window.addEventListener('paste', async (e) => {
  if (e.target.closest?.('input, textarea')) return;
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) {
    e.preventDefault();
    await actions.pasteBlob(file);
  }
});

// ---------- Clavier ----------

window.addEventListener('keydown', (e) => actions.handleKey(e));

// ---------- Avertissement de fermeture ----------

window.addEventListener('beforeunload', (e) => {
  if (app.dirty && app.doc && !isCapacitor()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Bouton « retour » Android : ferme la feuille / la fenêtre ouverte avant de quitter
if (isCapacitor() && window.Capacitor.Plugins?.App) {
  window.Capacitor.Plugins.App.addListener('backButton', () => {
    const modalBack = document.querySelector('.modal-back');
    if (modalBack) return document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    if ($('#sidebar').classList.contains('open')) return closeSheet();
    if (app.doc && $('#welcome').hidden) return actions.run('file.close');
    window.Capacitor.Plugins.App.exitApp();
  });
}

// ---------- Démarrage ----------

setupAutosave(app);
const savedTool = localStorage.getItem('prisme.tool');
app.setTool(app.tools[savedTool] ? savedTool : 'brush');
showPanel(isMobileLayout() ? 'adjust' : loadPref('panel', 'adjust'));
if (isMobileLayout()) closeSheet();
updateTop();
updateStatus();
showWelcome();

app.on('document', () => {
  hideWelcome();
  app.tool?.activate?.();
});

// Écran d'ouverture « SuperEssence Studio présente »
{
  const splash = $('#splash');
  const hide = () => {
    if (!splash.isConnected || splash.classList.contains('out')) return;
    splash.classList.add('out');
    setTimeout(() => splash.remove(), 550);
  };
  splash.addEventListener('click', hide);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(hide, reduce ? 1600 : 3400);
}

// Application installable / hors ligne (web uniquement)
if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !isCapacitor() && !isElectron() && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

export { app };
