// Prisme Motion — application d'animation et de compositing (dans l'esprit d'After Effects) :
// assemble le moteur, le visualiseur, la timeline et les panneaux ; gère les menus, les raccourcis,
// l'import de médias, les commandes sur les calques et le pont avec Prisme Photo.

import { el, $, isMobileLayout } from '../util.js';
import { icon } from '../icons.js';
import { toast, dropdown, closeDropdown, modal, formDialog, confirmDialog } from '../ui.js';
import { saveBlob } from '../io.js';
import * as M from './model.js';
import { MotionCore, loadPref, savePref } from './core.js';
import { Viewer } from './viewer.js';
import { Timeline } from './timeline.js';
import { projectPanel, effectsPanel, propertiesPanel } from './panels.js';
import { importMedia, MEDIA_ACCEPT, mediaKind } from './media.js';
import { exportDialog, exportFrame } from './export.js';
import { packProject, unpackProject, autosave, getAutosave, restoreAutosave } from './store.js';
import { TEMPLATES } from './templates.js';

let instance = null;

export async function openMotion(photoApp, opts = {}) {
  if (!instance) instance = new MotionApp(photoApp);
  instance.show();
  if (opts.image) await instance.importCanvas(opts.image, opts.name || 'Image Prisme Photo');
  return instance;
}

export const motionInstance = () => instance;

class MotionApp {
  constructor(photo) {
    this.photo = photo;
    this.core = new MotionCore();
    this.clipboard = null;
    this.buildDom();
    this.viewer = new Viewer(this.core, this.viewRoot);
    this.timeline = new Timeline(this.core, this.tlRoot);
    this.panels = { project: projectPanel(this), effects: effectsPanel(this), props: propertiesPanel(this) };
    this.leftBody.append(this.panels.project);
    this.rightBody.append(this.panels.props);
    this.setLeftTab('project');
    this.setMobileTab('timeline');
    this.wire();
    this.core.requestRender();
    this.updateTop();
  }

  // ---------- Interface ----------

  buildDom() {
    const root = el('div', { id: 'motion', hidden: true });
    this.root = root;
    const top = el('header', { class: 'mo-top' });
    const back = el('button', { class: 'mode-switch', title: 'Revenir à Prisme Photo' },
      el('span', { class: 'ms-opt', html: `${icon('image', 15)}<span>Photo</span>` }),
      el('span', { class: 'ms-opt on', html: `${icon('film', 15)}<span>Motion</span>` }));
    back.onclick = () => this.hide();
    this.menubar = el('nav', { class: 'mo-menubar desktop-only' });
    this.btnUndo = el('button', { class: 'icon-btn', title: 'Annuler (Ctrl+Z)', html: icon('undo'), onclick: () => this.run('edit.undo') });
    this.btnRedo = el('button', { class: 'icon-btn', title: 'Rétablir (Ctrl+Maj+Z)', html: icon('redo'), onclick: () => this.run('edit.redo') });
    top.append(
      el('button', { class: 'icon-btn mobile-only', html: icon('menu'), onclick: (e) => this.mobileMenu(e.currentTarget) }),
      el('div', { class: 'brand' }, el('img', { src: 'icons/logo-ui.png', alt: '' }), el('span', {}, 'Prisme'), el('em', { class: 'brand-sub' }, 'Motion')),
      this.menubar, el('div', { class: 'spacer' }), back, this.btnUndo, this.btnRedo,
      el('button', { class: 'btn primary', onclick: () => this.run('file.export'), html: `${icon('render', 18)}<span class="desktop-only">Exporter</span>` }));
    // Colonne gauche : Projet / Effets
    this.leftTabs = el('div', { class: 'mo-tabs' });
    for (const [id, label, ic] of [['project', 'Projet', 'folder'], ['effects', 'Effets & préréglages', 'fx']]) {
      this.leftTabs.append(el('button', { class: 'mo-tab', 'data-tab': id, html: `${icon(ic, 15)}<span>${label}</span>`, onclick: () => this.setLeftTab(id) }));
    }
    this.leftBody = el('div', { class: 'mo-pbody' });
    const left = el('aside', { class: 'mo-left' }, this.leftTabs, this.leftBody);
    // Centre : outils, visualiseur, transport
    this.toolsBar = el('div', { class: 'mo-tools' });
    const tools = [['select', 'move', 'Sélection (V)'], ['hand', 'hand', 'Main (H)'], ['anchor', 'anchor', 'Point d’ancrage (Y)'], null, ['rect', 'rect', 'Rectangle (Q) — masque si un calque est sélectionné'], ['ellipse', 'ellipse', 'Ellipse (Q)'], ['pen', 'pen', 'Plume (G) — cliquez pour placer des points'], ['text', 'text', 'Texte (Ctrl+T)']];
    for (const t of tools) {
      if (!t) {
        this.toolsBar.append(el('span', { class: 'tool-sep' }));
        continue;
      }
      this.toolsBar.append(el('button', { class: 'tool-btn', 'data-tool': t[0], title: t[2], html: icon(t[1], 18), onclick: () => this.core.setTool(t[0]) }));
    }
    this.resSel = el('select', { class: 'mini-select', title: 'Résolution de l’aperçu' }, ...[['auto', 'Auto'], ['1', 'Pleine'], ['0.5', 'Moitié'], ['0.333', 'Tiers'], ['0.25', 'Quart']].map(([k, l]) => el('option', { value: k }, l)));
    this.resSel.value = String(this.core.resolution);
    this.resSel.onchange = () => this.setResolution(this.resSel.value);
    this.zoomSel = el('button', { class: 'zoom-chip', title: 'Zoom du visualiseur' }, 'Ajuster');
    this.zoomSel.onclick = (e) => dropdown(e.currentTarget, [['fit', 'Ajuster'], [0.25, '25 %'], [0.5, '50 %'], [1, '100 %'], [2, '200 %'], [4, '400 %']].map(([z, l]) => ({ label: l, action: () => (z === 'fit' ? this.viewer.fit() : this.viewer.setZoom(z)) })));
    const tog = (ic, title, fn) => el('button', { class: 'icon-btn small', title, html: icon(ic, 16), onclick: (e) => fn(e.currentTarget) });
    this.stats = el('span', { class: 'mo-stats', title: 'Rendu GPU' });
    this.toolsBar.append(el('div', { class: 'spacer' }), this.resSel, this.zoomSel,
      tog('grid', 'Grille des tiers', (b) => {
        this.viewer.showGrid = !this.viewer.showGrid;
        b.classList.toggle('active', this.viewer.showGrid);
        this.viewer.draw();
      }),
      tog('crop', 'Marges de sécurité', (b) => {
        this.viewer.showSafe = !this.viewer.showSafe;
        b.classList.toggle('active', this.viewer.showSafe);
        this.viewer.draw();
      }),
      tog('layers', 'Grille de transparence', (b) => {
        this.core.transparent = !this.core.transparent;
        b.classList.toggle('active', this.core.transparent);
        this.core.invalidate();
      }), this.stats);
    this.viewRoot = el('div', { class: 'mo-view' });
    this.startCard = el('div', { class: 'mo-start', hidden: true });
    this.viewRoot.append(this.startCard);
    this.transport = el('div', { class: 'mo-transport' });
    const tb = (ic, title, fn, cls = '') => el('button', { class: `icon-btn ${cls}`, title, html: icon(ic, 18), onclick: fn });
    this.playBtn = tb('play', 'Lecture / pause (Espace)', () => this.core.togglePlay(), 'play');
    this.loopBtn = tb('loop', 'Lecture en boucle', () => {
      this.core.loop = !this.core.loop;
      this.loopBtn.classList.toggle('active', this.core.loop);
    });
    this.loopBtn.classList.toggle('active', this.core.loop);
    this.tc = el('span', { class: 'mo-tc' });
    this.ramBtn = el('button', { class: 'btn small', title: 'Pré-calculer la zone de travail en mémoire pour une lecture fluide (0)', onclick: () => this.run('comp.ram'), html: `${icon('render', 14)}<span>Pré-calcul RAM</span>` });
    this.transport.append(tb('skip-back', 'Début (Origine)', () => this.core.setTime(0)), tb('step-back', 'Image précédente (Page préc.)', () => this.core.step(-1)), this.playBtn, tb('step-fwd', 'Image suivante (Page suiv.)', () => this.core.step(1)), tb('skip-fwd', 'Fin', () => this.core.setTime(this.core.comp.duration)), this.loopBtn, this.tc, el('div', { class: 'spacer' }), this.ramBtn);
    const center = el('section', { class: 'mo-center' }, this.toolsBar, this.viewRoot, this.transport);
    // Droite : Propriétés
    this.rightBody = el('div', { class: 'mo-pbody' });
    const right = el('aside', { class: 'mo-right' }, el('div', { class: 'mo-tabs' }, el('span', { class: 'mo-tab on', html: `${icon('sliders', 15)}<span>Propriétés</span>` })), this.rightBody);
    // Timeline
    this.tlRoot = el('section', { class: 'mo-tl' });
    const grip = el('div', { class: 'mo-grip', title: 'Redimensionner' });
    this.dragGrip(grip);
    // Onglets mobiles
    this.mtabs = el('nav', { class: 'mo-mtabs mobile-only' });
    for (const [id, label, ic] of [['timeline', 'Timeline', 'film'], ['props', 'Propriétés', 'sliders'], ['project', 'Projet', 'folder'], ['effects', 'Effets', 'fx']]) {
      this.mtabs.append(el('button', { class: 'mtab', 'data-m': id, html: `${icon(ic, 18)}<span>${label}</span>`, onclick: () => this.setMobileTab(id) }));
    }
    this.mobileBody = el('div', { class: 'mo-mbody mobile-only' });
    root.append(top, el('div', { class: 'mo-main' }, left, center, right), grip, this.tlRoot, this.mtabs, this.mobileBody);
    document.body.append(root);
    const h = loadPref('tlH', 300);
    root.style.setProperty('--tl-h', `${h}px`);
    this.buildMenus();
  }

  dragGrip(grip) {
    grip.addEventListener('pointerdown', (e) => {
      const y0 = e.clientY;
      const h0 = this.tlRoot.getBoundingClientRect().height;
      const move = (ev) => {
        const h = M.clamp(h0 - (ev.clientY - y0), 120, innerHeight - 220);
        this.root.style.setProperty('--tl-h', `${h}px`);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        savePref('tlH', this.tlRoot.getBoundingClientRect().height);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  setLeftTab(id) {
    this.leftTab = id;
    for (const b of this.leftTabs.children) b.classList.toggle('on', b.dataset.tab === id);
    if (!isMobileLayout()) this.leftBody.replaceChildren(this.panels[id]);
  }

  // Sur mobile, le panneau du bas affiche un seul onglet à la fois.
  setMobileTab(id) {
    this.mobileTab = id;
    for (const b of this.mtabs.children) b.classList.toggle('on', b.dataset.m === id);
    this.root.dataset.mtab = id;
    if (!isMobileLayout()) return;
    if (id === 'timeline') {
      this.mobileBody.replaceChildren();
    } else this.mobileBody.replaceChildren(this.panels[id]);
  }

  relayout() {
    // Replace les panneaux selon la disposition (ordinateur / mobile).
    if (isMobileLayout()) this.setMobileTab(this.mobileTab || 'timeline');
    else {
      this.leftBody.replaceChildren(this.panels[this.leftTab || 'project']);
      this.rightBody.replaceChildren(this.panels.props);
    }
    this.timeline.schedule();
  }

  show() {
    document.body.classList.add('motion-mode');
    this.root.hidden = false;
    $('#app').hidden = true;
    this.relayout();
    this.viewer.resize();
    this.timeline.fit();
    this.core.requestRender();
    this.updateStart();
  }

  hide() {
    this.core.pause();
    document.body.classList.remove('motion-mode');
    this.root.hidden = true;
    $('#app').hidden = false;
    setTimeout(() => this.photo?.view?.resize(), 30);
  }

  updateTop() {
    this.btnUndo.disabled = !this.core.undoStack.length;
    this.btnRedo.disabled = !this.core.redoStack.length;
    for (const b of this.toolsBar.querySelectorAll('.tool-btn')) b.classList.toggle('on', b.dataset.tool === this.core.tool);
  }

  updateStart() {
    const empty = this.core.project.comps.every((c) => !c.layers.length) && !this.core.project.assets.length;
    this.startCard.hidden = !empty;
    if (!empty || this.startCard.childElementCount) return;
    const card = (ic, title, sub, fn) => el('button', { class: 'wcard', onclick: fn, html: `${icon(ic, 26)}<span>${title}</span><small>${sub}</small>` });
    const inner = el('div', { class: 'mo-start-inner' },
      el('h2', {}, 'Prisme ', el('span', { class: 'grad' }, 'Motion')),
      el('p', {}, 'Animation, compositing et effets visuels — rendu GPU en temps réel.'),
      el('div', { class: 'welcome-actions' },
        card('film', 'Importer des médias', 'Vidéos, images, sons', () => this.importDialog()),
        card('text', 'Ajouter un titre', 'Texte animé', () => this.run('layer.newText')),
        card('comp', 'Nouvelle composition', 'HD, 4K, Story, carré…', () => this.newCompDialog())),
      el('div', { class: 'mp-head' }, 'Modèles'),
      el('div', { class: 'welcome-actions' }, ...TEMPLATES.map((t) => card('sparkles', t.name, t.desc, () => this.useTemplate(t)))));
    this.startCard.append(inner);
    getAutosave().then((s) => {
      if (!s || !s.json || !this.startCard.isConnected) return;
      inner.append(el('div', { style: { marginTop: '10px' } }, el('button', { class: 'btn', onclick: () => this.restoreSession(s) }, `Reprendre la dernière session (${s.name || 'projet'} · ${new Date(s.savedAt).toLocaleString('fr-FR')})`)));
    });
  }

  // ---------- Évènements ----------

  wire() {
    const core = this.core;
    core.on('change', () => {
      this.updateTop();
      this.updateStart();
      clearTimeout(this.asTimer);
      this.asTimer = setTimeout(() => {
        if (core.project.comps.some((c) => c.layers.length) || core.project.assets.length) autosave(core.project);
      }, 2500);
    });
    core.on('tool', () => this.updateTop());
    core.on('play', (on) => {
      this.playBtn.innerHTML = icon(on ? 'pause' : 'play', 18);
      this.playBtn.classList.toggle('active', on);
    });
    core.on('time', () => {
      this.tc.textContent = `${M.timecode(core.time, core.comp.fps)}  ·  ${core.frameOf()}`;
    });
    core.on('frame', () => {
      const fps = core.fpsMeter.fps;
      this.stats.textContent = core.cacheHit ? `RAM · ${fps.toFixed(0)} i/s` : `GPU ${core.lastRenderMs.toFixed(1)} ms${core.playing ? ` · ${fps.toFixed(0)} i/s` : ''}${core.frameScale < 1 ? ` · ${Math.round(core.frameScale * 100)} %` : ''}`;
    });
    core.on('zoom', (z) => (this.zoomSel.textContent = this.viewer.zoom === 'fit' ? `Ajuster (${Math.round(z * 100)} %)` : `${Math.round(z * 100)} %`));
    core.on('render-error', (e) => toast(`Erreur de rendu : ${e.message}`, 4000));
    core.on('comp', () => {
      this.tc.textContent = M.timecode(core.time, core.comp.fps);
      this.updateStart();
    });
    core.on('edit-text', (layer) => this.editText(layer));
    core.on('new-text', ({ pos }) => this.newText(pos));
    core.on('draw-shape', (d) => this.drawShape(d));
    core.on('draw-path', (d) => this.drawPath(d));
    core.on('layer-menu', (p) => dropdown(p, this.layerMenuItems()));
    core.on('delete-keys', () => this.deleteKeys());
    this.tc.textContent = M.timecode(0, core.comp.fps);
    window.addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      this.onKey(e, true);
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.viewer.spaceDown = false;
    });
    // Glisser-déposer : fichiers du système, médias et effets du panneau Projet.
    const dropTarget = this.root;
    dropTarget.addEventListener('dragover', (e) => {
      if (this.root.hidden) return;
      e.preventDefault();
      dropTarget.classList.add('drop-on');
    });
    dropTarget.addEventListener('dragleave', (e) => {
      if (e.target === dropTarget) dropTarget.classList.remove('drop-on');
    });
    dropTarget.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropTarget.classList.remove('drop-on');
      const dt = e.dataTransfer;
      const assetId = dt.getData('text/x-prisme-asset');
      const compId = dt.getData('text/x-prisme-comp');
      const fx = dt.getData('text/x-prisme-effect');
      if (assetId) {
        const a = M.assetById(core.project, assetId);
        if (a) this.addAssetLayer(a);
      } else if (compId) {
        const c = M.compById(core.project, compId);
        if (c) this.addCompLayer(c);
      } else if (fx) {
        const hit = e.target.closest('.mv-canvas') ? this.viewer.hitLayer(this.viewer.toComp(e)) : null;
        if (hit) core.select(hit.id);
        this.applyEffect(fx);
      } else if (dt.files?.length) {
        await this.importFiles([...dt.files], true);
      }
    }, true);
    window.addEventListener('resize', () => {
      if (this.root.hidden) return;
      clearTimeout(this.rzT);
      this.rzT = setTimeout(() => this.relayout(), 120);
    });
    window.addEventListener('beforeunload', () => {
      if (core.dirty) autosave(core.project);
    });
  }

  onKey(e) {
    const core = this.core;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    if (document.querySelector('.modal-back, .palette-back')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    const kl = k.length === 1 ? k.toLowerCase() : k;
    const go = (id) => {
      e.preventDefault();
      this.run(id);
    };
    if (ctrl) {
      if (kl === 'z') return go(e.shiftKey ? 'edit.redo' : 'edit.undo');
      if (kl === 'y' && !e.shiftKey && !e.altKey) return go('layer.newSolid');
      if (kl === 'c' && e.shiftKey) return go('layer.precompose');
      if (kl === 'c') return go('edit.copy');
      if (kl === 'v') return go('edit.paste');
      if (kl === 'x') return go('edit.cut');
      if (kl === 'd' && e.shiftKey) return go('layer.split');
      if (kl === 'd') return go('edit.duplicate');
      if (kl === 'a') return go('edit.selectAll');
      if (kl === 's') return go('file.save');
      if (kl === 'o') return go('file.open');
      if (kl === 'i') return go('file.import');
      if (kl === 'm') return go('file.export');
      if (kl === 'n') return go('comp.new');
      if (kl === 'k') return go('comp.settings');
      if (kl === 't') {
        e.preventDefault();
        return core.setTool('text');
      }
      if (kl === 'f' && e.altKey) return go('layer.fit');
      if (k === 'Home' && e.altKey) return go('layer.anchorCenter');
      if (k === 'ArrowLeft') return core.step(e.shiftKey ? -10 : -1);
      if (k === 'ArrowRight') return core.step(e.shiftKey ? 10 : 1);
      return;
    }
    if (k === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (e.repeat) return;
      return core.togglePlay();
    }
    if (k === 'Escape') {
      this.viewer.cancelTool();
      core.selKeys.clear();
      core.select([]);
      return;
    }
    if (k === 'Enter' && this.viewer.pen) return this.viewer.finishPen(true);
    if (k === 'Delete' || k === 'Backspace') return go(core.selKeys.size ? 'edit.deleteKeys' : 'edit.delete');
    if (k === 'Home') return core.setTime(e.shiftKey ? core.comp.workIn : 0);
    if (k === 'End') return core.setTime(e.shiftKey ? core.comp.workOut : core.comp.duration);
    if (k === 'PageUp') return core.step(e.shiftKey ? -10 : -1);
    if (k === 'PageDown') return core.step(e.shiftKey ? 10 : 1);
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      if (core.selection.size && !e.altKey) {
        const dx = k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, dy = k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0;
        return this.nudge(dx, dy);
      }
      if (k === 'ArrowLeft') return core.step(-d);
      if (k === 'ArrowRight') return core.step(d);
      return;
    }
    if (k === 'F9') return go('anim.easyEase');
    if (k === 'F2') return core.select([]);
    if (kl === '0' || e.code === 'Numpad0') return go('comp.ram');
    if (k === '[' || k === ']') return go(e.altKey ? (k === '[' ? 'layer.trimIn' : 'layer.trimOut') : (k === '[' ? 'layer.moveIn' : 'layer.moveOut'));
    if (kl === 'b') return go('comp.workIn');
    if (kl === 'n') return go('comp.workOut');
    if (kl === 'i') return this.gotoLayerEdge('in');
    if (kl === 'o') return this.gotoLayerEdge('out');
    if (kl === 'j') return this.gotoKey(-1);
    if (kl === 'k') return this.gotoKey(1);
    if (kl === 'v') return core.setTool('select');
    if (kl === 'h') return core.setTool('hand');
    if (kl === 'y') return core.setTool('anchor');
    if (kl === 'g') return core.setTool('pen');
    if (kl === 'q') return core.setTool(core.tool === 'rect' ? 'ellipse' : 'rect');
    if (kl === 'w') return core.setTool('select');
    const reveal = { p: 'P', s: 'S', r: 'R', t: 'T', a: 'A', e: 'E', m: 'M' }[kl];
    if (reveal) {
      e.preventDefault();
      const keys = e.shiftKey ? [...new Set([reveal, ...(this.lastReveal || [])])] : [reveal];
      this.lastReveal = keys;
      return this.timeline.revealKeys(keys);
    }
    if (kl === 'u') return this.timeline.revealAnimated();
    if (k === '.' || k === '+') return this.viewer.setZoom(this.viewer.scale * 1.25);
    if (k === ',' || k === '-') return this.viewer.setZoom(this.viewer.scale / 1.25);
    if (k === '/' || k === '?') return this.viewer.fit();
    if (k === 'Alt') e.preventDefault();
  }

  // ---------- Menus ----------

  buildMenus() {
    for (const m of this.menus()) {
      const b = el('button', { class: 'menu-btn' }, m.label);
      b.addEventListener('click', () => {
        if (b.classList.contains('open')) return closeDropdown();
        for (const x of this.menubar.children) x.classList.remove('open');
        b.classList.add('open');
        this.menuOpen = true;
        dropdown(b, m.items(), { onClose: () => {
          b.classList.remove('open');
          setTimeout(() => (this.menuOpen = false), 0);
        } });
      });
      b.addEventListener('mouseenter', () => {
        if (this.menuOpen && !b.classList.contains('open')) b.click();
      });
      this.menubar.append(b);
    }
  }

  mobileMenu(anchor) {
    dropdown(anchor, this.menus().map((m) => ({ label: m.label, submenu: m.items })));
  }

  menus() {
    const core = this.core;
    const hasSel = () => core.selection.size > 0;
    const it = (label, id, shortcut = '', extra = {}) => ({ label, shortcut, action: () => this.run(id), ...extra });
    return [
      { label: 'Fichier', items: () => [
        it('Nouveau projet', 'file.new'), it('Ouvrir un projet…', 'file.open', 'Ctrl+O'), it('Enregistrer le projet', 'file.save', 'Ctrl+S'), { sep: true },
        it('Importer des médias…', 'file.import', 'Ctrl+I'), it('Importer l’image de Prisme Photo', 'file.fromPhoto', '', { disabled: !this.photo?.doc }), { sep: true },
        it('Exporter la vidéo…', 'file.export', 'Ctrl+M'), it('Exporter l’image courante (PNG)', 'file.exportFrame'), it('Envoyer l’image vers Prisme Photo', 'file.toPhoto'), { sep: true },
        it('Revenir à Prisme Photo', 'file.back'),
      ] },
      { label: 'Édition', items: () => [
        it('Annuler', 'edit.undo', 'Ctrl+Z', { disabled: !core.undoStack.length }), it('Rétablir', 'edit.redo', 'Ctrl+Maj+Z', { disabled: !core.redoStack.length }), { sep: true },
        it('Couper', 'edit.cut', 'Ctrl+X', { disabled: !hasSel() }), it('Copier', 'edit.copy', 'Ctrl+C', { disabled: !hasSel() }), it('Coller', 'edit.paste', 'Ctrl+V', { disabled: !this.clipboard }),
        it('Dupliquer', 'edit.duplicate', 'Ctrl+D', { disabled: !hasSel() }), it('Scinder le calque', 'layer.split', 'Ctrl+Maj+D', { disabled: !hasSel() }), it('Supprimer', 'edit.delete', 'Suppr', { disabled: !hasSel() }), { sep: true },
        it('Tout sélectionner', 'edit.selectAll', 'Ctrl+A'), it('Tout désélectionner', 'edit.deselect', 'F2'), { sep: true },
        it('Préférences…', 'edit.prefs'),
      ] },
      { label: 'Composition', items: () => [
        it('Nouvelle composition…', 'comp.new', 'Ctrl+N'), it('Paramètres de composition…', 'comp.settings', 'Ctrl+K'), it('Dupliquer la composition', 'comp.duplicate'), { sep: true },
        it('Pré-calcul RAM de la zone de travail', 'comp.ram', '0'), it('Vider le cache', 'comp.purge'), { sep: true },
        it('Début de la zone de travail ici', 'comp.workIn', 'B'), it('Fin de la zone de travail ici', 'comp.workOut', 'N'), it('Rogner la composition à la zone de travail', 'comp.trimToWork'), { sep: true },
        { label: 'Modèles', submenu: () => TEMPLATES.map((t) => ({ label: t.name, action: () => this.useTemplate(t) })) },
      ] },
      { label: 'Calque', items: () => [
        { label: 'Nouveau', submenu: () => [
          it('Texte', 'layer.newText', 'Ctrl+T'), it('Solide', 'layer.newSolid', 'Ctrl+Y'), it('Forme (rectangle)', 'layer.newShape'), it('Forme (ellipse)', 'layer.newEllipse'), it('Forme (étoile)', 'layer.newStar'),
          it('Particules', 'layer.newParticles'), it('Objet nul', 'layer.newNull'), it('Calque d’effets', 'layer.newAdjust'),
        ] },
        { sep: true },
        it('Pré-composer…', 'layer.precompose', 'Ctrl+Maj+C', { disabled: !hasSel() }),
        { label: 'Masque', submenu: () => [it('Nouveau masque rectangle', 'mask.rect', '', { disabled: !hasSel() }), it('Nouveau masque ellipse', 'mask.ellipse', '', { disabled: !hasSel() }), it('Supprimer les masques', 'mask.clear', '', { disabled: !hasSel() })] },
        { label: 'Transformer', submenu: () => [it('Centrer dans la composition', 'layer.center'), it('Ajuster à la composition', 'layer.fit', 'Ctrl+Alt+F'), it('Ancre au centre du calque', 'layer.anchorCenter', 'Ctrl+Alt+Orig.'), it('Réinitialiser', 'layer.resetTransform'), it('Symétrie horizontale', 'layer.flipH'), it('Symétrie verticale', 'layer.flipV')] },
        { label: 'Ordre', submenu: () => [it('Premier plan', 'layer.front'), it('Avancer', 'layer.forward'), it('Reculer', 'layer.backward'), it('Arrière-plan', 'layer.back')] },
        { sep: true },
        it('Calque 3D', 'layer.toggle3d', '', { disabled: !hasSel() }), it('Flou de mouvement', 'layer.toggleMB', '', { disabled: !hasSel() }),
        it('Séquencer les calques', 'layer.sequence', '', { disabled: core.selection.size < 2 }),
        it('Placer le début à l’instant courant', 'layer.moveIn', '['), it('Rogner le début ici', 'layer.trimIn', 'Alt+['), it('Rogner la fin ici', 'layer.trimOut', 'Alt+]'),
      ] },
      { label: 'Effet', items: () => [
        ...M.EFFECT_CATS.map((cat) => ({ label: cat, submenu: () => Object.entries(M.EFFECTS).filter(([, d]) => d.cat === cat).map(([type, d]) => ({ label: d.name, action: () => this.applyEffect(type) })) })),
        { sep: true },
        it('Supprimer tous les effets', 'fx.clear', '', { disabled: !hasSel() }),
      ] },
      { label: 'Animation', items: () => [
        ...[...new Set(M.PRESETS.map((p) => p.cat))].map((cat) => ({ label: `Préréglages : ${cat}`, submenu: () => M.PRESETS.filter((p) => p.cat === cat).map((p) => ({ label: p.name, action: () => this.applyPreset(p) })) })),
        { sep: true },
        { label: 'Ajouter une image clé', submenu: () => [['position', 'Position'], ['scale', 'Échelle'], ['rotation', 'Rotation'], ['opacity', 'Opacité'], ['anchor', 'Point d’ancrage']].map(([k, l]) => ({ label: l, action: () => this.addKey(k) })) },
        it('Lissage de vitesse (Easy Ease)', 'anim.easyEase', 'F9', { disabled: !core.selKeys.size }),
        { label: 'Interpolation des images clés', submenu: () => Object.entries(M.EASINGS).map(([k, v]) => ({ label: v.label, disabled: !core.selKeys.size, action: () => this.setEase(k) })) },
        it('Supprimer les images clés sélectionnées', 'edit.deleteKeys', '', { disabled: !core.selKeys.size }),
        it('Supprimer les expressions du calque', 'anim.clearExpr', '', { disabled: !hasSel() }),
      ] },
      { label: 'Affichage', items: () => [
        { label: 'Résolution', submenu: () => [['auto', 'Automatique'], ['1', 'Pleine'], ['0.5', 'Moitié'], ['0.333', 'Tiers'], ['0.25', 'Quart']].map(([k, l]) => ({ label: l, checked: String(core.resolution) === k, action: () => this.setResolution(k) })) },
        { label: 'Zoom', submenu: () => [['fit', 'Ajuster', '/'], [0.5, '50 %'], [1, '100 %'], [2, '200 %']].map(([z, l, s]) => ({ label: l, shortcut: s || '', action: () => (z === 'fit' ? this.viewer.fit() : this.viewer.setZoom(z)) })) },
        { label: 'Grille des tiers', checked: this.viewer.showGrid, action: () => {
          this.viewer.showGrid = !this.viewer.showGrid;
          this.viewer.draw();
        } },
        { label: 'Marges de sécurité', checked: this.viewer.showSafe, action: () => {
          this.viewer.showSafe = !this.viewer.showSafe;
          this.viewer.draw();
        } },
        { label: 'Grille de transparence', checked: !!core.transparent, action: () => {
          core.transparent = !core.transparent;
          core.invalidate();
        } },
        { sep: true },
        it('Plein écran', 'view.fullscreen'),
      ] },
      { label: 'Aide', items: () => [it('Raccourcis clavier', 'help.keys'), it('Expressions : aide-mémoire', 'help.expr'), it('À propos de Prisme Motion', 'help.about')] },
    ];
  }

  layerMenuItems() {
    const it = (label, id, shortcut = '') => ({ label, shortcut, action: () => this.run(id) });
    const core = this.core;
    const l = core.layer;
    return [
      it('Dupliquer', 'edit.duplicate', 'Ctrl+D'), it('Scinder ici', 'layer.split', 'Ctrl+Maj+D'), it('Pré-composer…', 'layer.precompose', 'Ctrl+Maj+C'), it('Supprimer', 'edit.delete', 'Suppr'),
      { sep: true },
      { label: 'Effet', submenu: () => M.EFFECT_CATS.flatMap((cat) => [{ head: cat }, ...Object.entries(M.EFFECTS).filter(([, d]) => d.cat === cat).map(([type, d]) => ({ label: d.name, action: () => this.applyEffect(type) }))]) },
      { label: 'Animer', submenu: () => M.PRESETS.filter((p) => !p.only || p.only === l?.type).map((p) => ({ label: `${p.cat} · ${p.name}`, action: () => this.applyPreset(p) })) },
      { label: 'Mode de fusion', submenu: () => M.BLEND_MODES.map(([k, lab]) => ({ label: lab, checked: l?.blend === k, action: () => core.change('Mode de fusion', () => core.selectedLayers.forEach((x) => (x.blend = k))) })) },
      { label: 'Masque', submenu: () => [it('Rectangle', 'mask.rect'), it('Ellipse', 'mask.ellipse'), it('Supprimer les masques', 'mask.clear')] },
      { label: 'Transformer', submenu: () => [it('Centrer', 'layer.center'), it('Ajuster à la composition', 'layer.fit'), it('Ancre au centre', 'layer.anchorCenter'), it('Réinitialiser', 'layer.resetTransform')] },
      { sep: true },
      { label: 'Calque 3D', checked: !!l?.threeD, action: () => this.run('layer.toggle3d') },
      { label: 'Flou de mouvement', checked: !!l?.motionBlur, action: () => this.run('layer.toggleMB') },
      l?.type === 'text' ? it('Modifier le texte…', 'layer.editText') : null,
      l?.type === 'comp' ? it('Ouvrir la pré-composition', 'layer.openComp') : null,
      it('Envoyer l’image vers Prisme Photo', 'file.toPhoto'),
    ];
  }

  effectMenu(anchor) {
    dropdown(anchor, M.EFFECT_CATS.map((cat) => ({ label: cat, submenu: () => Object.entries(M.EFFECTS).filter(([, d]) => d.cat === cat).map(([type, d]) => ({ label: d.name, action: () => this.applyEffect(type) })) })));
  }

  presetMenu(anchor) {
    const l = this.core.layer;
    dropdown(anchor, [...new Set(M.PRESETS.map((p) => p.cat))].map((cat) => ({ label: cat, submenu: () => M.PRESETS.filter((p) => p.cat === cat && (!p.only || p.only === l?.type)).map((p) => ({ label: p.name, action: () => this.applyPreset(p) })) })));
  }

  // ---------- Commandes ----------

  run(id) {
    const core = this.core;
    const c = core.comp;
    const sel = core.selectedLayers;
    const t = core.time;
    const each = (label, fn) => {
      if (!sel.length) return toast('Sélectionnez un calque');
      core.change(label, () => sel.forEach(fn));
    };
    switch (id) {
      case 'file.new': return this.newProject();
      case 'file.open': return this.openProjectDialog();
      case 'file.save': return this.saveProject();
      case 'file.import': return this.importDialog();
      case 'file.fromPhoto': return this.importFromPhoto();
      case 'file.export': return exportDialog(this);
      case 'file.exportFrame': return exportFrame(this);
      case 'file.toPhoto': return this.sendToPhoto();
      case 'file.back': return this.hide();
      case 'edit.undo': {
        const l = core.undo();
        if (l) toast(`Annulé : ${l}`, 1200);
        return;
      }
      case 'edit.redo': {
        const l = core.redo();
        if (l) toast(`Rétabli : ${l}`, 1200);
        return;
      }
      case 'edit.copy':
        if (sel.length) this.clipboard = M.serialize({ layers: sel });
        return sel.length && toast(`${sel.length} calque(s) copié(s)`, 1000);
      case 'edit.cut':
        this.run('edit.copy');
        return this.run('edit.delete');
      case 'edit.paste': return this.paste();
      case 'edit.duplicate': return this.duplicate();
      case 'edit.delete':
        if (!sel.length) return;
        return core.change('Supprimer', () => {
          const ids = new Set(sel.map((l) => l.id));
          c.layers = c.layers.filter((l) => !ids.has(l.id));
          for (const l of c.layers) if (ids.has(l.parent)) l.parent = null;
          core.selection.clear();
        });
      case 'edit.deleteKeys': return this.deleteKeys();
      case 'edit.selectAll': return core.select(c.layers.map((l) => l.id));
      case 'edit.deselect': return core.select([]);
      case 'edit.prefs': return this.prefsDialog();
      case 'comp.new': return this.newCompDialog();
      case 'comp.settings': return this.compSettings(c);
      case 'comp.duplicate': return this.duplicateComp(c);
      case 'comp.ram': return this.ramPreview();
      case 'comp.purge':
        core.clearCache();
        return toast('Cache vidé', 1000);
      case 'comp.workIn': return core.change('Zone de travail', () => (c.workIn = Math.min(t, c.workOut - 1 / c.fps)));
      case 'comp.workOut': return core.change('Zone de travail', () => (c.workOut = Math.max(t + 1 / c.fps, c.workIn + 1 / c.fps)));
      case 'comp.trimToWork': return core.change('Rogner la composition', () => {
        const d = c.workIn;
        for (const l of c.layers) shiftLayer(l, -d);
        c.duration = Math.max(1 / c.fps, c.workOut - c.workIn);
        c.workIn = 0;
        c.workOut = c.duration;
        core.time = 0;
      });
      case 'layer.newText': return this.newText([c.width / 2, c.height / 2]);
      case 'layer.newSolid': return this.newSolid();
      case 'layer.newShape': return this.addLayer(M.makeLayer(c, 'shape', { name: 'Rectangle', in: t }));
      case 'layer.newEllipse': return this.addLayer(M.makeLayer(c, 'shape', { name: 'Ellipse', in: t, content: { shape: 'ellipse', size: [300, 300], fill: '#f455d8' } }));
      case 'layer.newStar': return this.addLayer(M.makeLayer(c, 'shape', { name: 'Étoile', in: t, content: { shape: 'star', size: [360, 360], fill: '#ffcc1f' } }));
      case 'layer.newParticles': return this.addLayer(M.makeLayer(c, 'particles', { name: 'Particules', in: t }));
      case 'layer.newNull': return this.addLayer(M.makeLayer(c, 'null', { name: 'Nul', in: t }));
      case 'layer.newAdjust': return this.addLayer(M.makeLayer(c, 'adjust', { name: 'Calque d’effets', in: t }));
      case 'layer.precompose': return this.precompose();
      case 'layer.split': return this.split();
      case 'layer.editText': return sel[0]?.type === 'text' && this.editText(sel[0]);
      case 'layer.openComp': return sel[0]?.type === 'comp' && core.setComp(sel[0].source);
      case 'layer.toggle3d': return each('Calque 3D', (l) => (l.threeD = !l.threeD));
      case 'layer.toggleMB': return each('Flou de mouvement', (l) => (l.motionBlur = !l.motionBlur));
      case 'layer.center': return each('Centrer', (l) => {
        const b = core.engine.sourceBox(c, l);
        M.setPropValue(l.p.anchor, t, [b[0] + b[2] / 2, b[1] + b[3] / 2]);
        M.setPropValue(l.p.position, t, [c.width / 2, c.height / 2]);
      });
      case 'layer.fit': return each('Ajuster à la composition', (l) => {
        const b = core.engine.sourceBox(c, l);
        const s = Math.min(c.width / b[2], c.height / b[3]) * 100;
        M.setPropValue(l.p.anchor, t, [b[0] + b[2] / 2, b[1] + b[3] / 2]);
        M.setPropValue(l.p.position, t, [c.width / 2, c.height / 2]);
        M.setPropValue(l.p.scale, t, [s, s]);
      });
      case 'layer.anchorCenter': return each('Ancre au centre', (l) => {
        const b = core.engine.sourceBox(c, l);
        const m = core.engine.matrix(c, l, t);
        const na = [b[0] + b[2] / 2, b[1] + b[3] / 2];
        const wa = [m[0] * na[0] + m[4] * na[1] + m[12], m[1] * na[0] + m[5] * na[1] + m[13]];
        const old = M.keyedValue(l.p.anchor, t);
        const wo = [m[0] * old[0] + m[4] * old[1] + m[12], m[1] * old[0] + m[5] * old[1] + m[13]];
        const [dx, dy] = this.viewer.parentDelta(l, wa[0] - wo[0], wa[1] - wo[1]);
        const p = M.keyedValue(l.p.position, t);
        M.setPropValue(l.p.anchor, t, na);
        M.setPropValue(l.p.position, t, [p[0] + dx, p[1] + dy]);
      });
      case 'layer.resetTransform': return each('Réinitialiser', (l) => {
        const fresh = M.makeLayer(c, l.type, { w: core.engine.sourceBox(c, l)[2], h: core.engine.sourceBox(c, l)[3] });
        for (const k of ['anchor', 'position', 'posZ', 'scale', 'rotX', 'rotY', 'rotation', 'opacity']) l.p[k] = fresh.p[k];
        if (l.type === 'image' || l.type === 'video') {
          const a = M.assetById(core.project, l.source);
          if (a) l.p.anchor = M.P([a.w / 2, a.h / 2]);
        }
      });
      case 'layer.flipH': return each('Symétrie', (l) => {
        const s = M.keyedValue(l.p.scale, t);
        M.setPropValue(l.p.scale, t, [-s[0], s[1]]);
      });
      case 'layer.flipV': return each('Symétrie', (l) => {
        const s = M.keyedValue(l.p.scale, t);
        M.setPropValue(l.p.scale, t, [s[0], -s[1]]);
      });
      case 'layer.front':
      case 'layer.back':
      case 'layer.forward':
      case 'layer.backward': return this.reorder(id.split('.')[1]);
      case 'layer.sequence': return core.change('Séquencer', () => {
        const order = c.layers.filter((l) => core.selection.has(l.id));
        let cur = order[0].in;
        for (const l of order) {
          shiftLayer(l, cur - l.in);
          cur = l.out;
        }
      });
      case 'layer.moveIn': return each('Déplacer le calque', (l) => shiftLayer(l, t - l.in));
      case 'layer.moveOut': return each('Déplacer le calque', (l) => shiftLayer(l, t - l.out));
      case 'layer.trimIn': return each('Rogner', (l) => (l.in = Math.min(t, l.out - 1 / c.fps)));
      case 'layer.trimOut': return each('Rogner', (l) => (l.out = Math.max(t, l.in + 1 / c.fps)));
      case 'mask.rect':
      case 'mask.ellipse': return each('Nouveau masque', (l) => {
        const b = core.engine.sourceBox(c, l);
        l.masks.push(M.makeMask(id === 'mask.rect' ? 'rect' : 'ellipse', [b[0] + b[2] * 0.15, b[1] + b[3] * 0.15, b[2] * 0.7, b[3] * 0.7], `Masque ${l.masks.length + 1}`));
        this.timeline.reveal.set(l.id, new Set(['M']));
      });
      case 'mask.clear': return each('Supprimer les masques', (l) => (l.masks = []));
      case 'fx.clear': return each('Supprimer les effets', (l) => (l.effects = []));
      case 'anim.easyEase': return this.setEase('ease');
      case 'anim.clearExpr': return each('Supprimer les expressions', (l) => {
        for (const { prop } of M.allProps(l)) delete prop.x;
      });
      case 'view.fullscreen':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.();
        return;
      case 'help.keys': return this.helpKeys();
      case 'help.expr': return this.helpExpr();
      case 'help.about': return modal({ title: 'À propos', body: el('div', { class: 'about' }, el('h3', {}, 'Prisme Motion'), el('p', {}, 'Animation, compositing et effets visuels, intégrés à Prisme. Rendu GPU WebGL 2, décodage et encodage vidéo matériels (WebCodecs).'), el('p', {}, `GPU : ${core.engine.gl.gpuName}`), el('p', {}, 'Une création SuperEssence Studio.')), buttons: [{ label: 'Fermer', primary: true }] });
      default:
        console.warn('Commande inconnue', id);
    }
  }

  // ---------- Calques ----------

  addLayer(layer, { select = true, label } = {}) {
    const core = this.core;
    core.change(label || `Nouveau calque : ${layer.name}`, () => {
      core.comp.layers.unshift(layer);
    });
    if (select) core.select(layer.id);
    return layer;
  }

  newSolid() {
    const c = this.core.comp;
    formDialog({
      title: 'Nouveau solide', okLabel: 'Créer',
      fields: [{ key: 'name', label: 'Nom', type: 'text' }, { key: 'color', label: 'Couleur', type: 'color' }, { key: 'w', label: 'Largeur', type: 'number', min: 1, max: 16384 }, { key: 'h', label: 'Hauteur', type: 'number', min: 1, max: 16384 }],
      values: { name: 'Solide', color: '#7b5cff', w: c.width, h: c.height },
    }).then((v) => {
      if (!v) return;
      this.addLayer(M.makeLayer(c, 'solid', { name: v.name || 'Solide', in: this.core.time, content: { color: v.color, size: [Number(v.w) || c.width, Number(v.h) || c.height] } }));
    });
  }

  newText(pos) {
    const c = this.core.comp;
    const l = M.makeLayer(c, 'text', { name: 'Texte', in: this.core.time });
    l.p.position.v = [pos[0], pos[1]];
    this.addLayer(l);
    this.core.setTool('select');
    this.editText(l, true);
  }

  editText(layer, fresh = false) {
    const core = this.core;
    const ta = el('textarea', { rows: 4, style: { width: '100%', fontSize: '16px' } }, fresh ? '' : layer.p['c.text'].v);
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    const m = modal({
      title: 'Texte du calque', body: ta,
      buttons: [{ label: 'Annuler', value: null }, { label: 'OK', primary: true, onClick: (close) => close(ta.value) }],
    });
    setTimeout(() => {
      ta.focus();
      ta.select();
    }, 30);
    m.promise.then((v) => {
      if (v == null) {
        if (fresh) core.undo();
        return;
      }
      const txt = v.trim() ? v : 'Texte';
      core.change('Modifier le texte', () => {
        layer.p['c.text'].v = txt;
        layer.name = txt.split('\n')[0].slice(0, 40);
      });
    });
  }

  // Rectangle / ellipse tracés dans le visualiseur : masque sur le calque sélectionné, ou nouvelle forme.
  drawShape({ kind, rect }) {
    const core = this.core;
    const c = core.comp;
    const target = core.selectedLayers.length === 1 && core.layer.type !== 'shape' && !core.layer.locked ? core.layer : null;
    const [x, y, w, h] = rect;
    if (target) {
      const m = core.engine.matrix(c, target, core.time);
      const inv = M4inv(m);
      const rot = Math.abs(Math.atan2(m[1], m[0])) > 1e-3;
      core.change('Nouveau masque', () => {
        if (!rot) {
          const a = inv(x, y), b = inv(x + w, y + h);
          target.masks.push(M.makeMask(kind === 'ellipse' ? 'ellipse' : 'rect', [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])], `Masque ${target.masks.length + 1}`));
        } else {
          const pts = [];
          const n = kind === 'ellipse' ? 48 : 4;
          for (let i = 0; i < n; i++) {
            const p = kind === 'ellipse' ? [x + w / 2 + (Math.cos((i / n) * Math.PI * 2) * w) / 2, y + h / 2 + (Math.sin((i / n) * Math.PI * 2) * h) / 2] : [[x, y], [x + w, y], [x + w, y + h], [x, y + h]][i];
            pts.push(inv(p[0], p[1]));
          }
          target.masks.push(M.makeMask('poly', pts, `Masque ${target.masks.length + 1}`));
        }
      });
      this.timeline.reveal.set(target.id, new Set(['M']));
      this.timeline.schedule();
      return;
    }
    const l = M.makeLayer(c, 'shape', { name: kind === 'ellipse' ? 'Ellipse' : 'Rectangle', in: core.time, content: { shape: kind === 'ellipse' ? 'ellipse' : 'rect', size: [w, h], fill: kind === 'ellipse' ? '#f455d8' : '#3db5ff' } });
    l.p.position.v = [x + w / 2, y + h / 2];
    this.addLayer(l);
  }

  drawPath({ points, closed }) {
    const core = this.core;
    const c = core.comp;
    const target = core.selectedLayers.length === 1 && core.layer.type !== 'shape' && !core.layer.locked ? core.layer : null;
    if (target && closed) {
      const inv = M4inv(core.engine.matrix(c, target, core.time));
      core.change('Masque (plume)', () => target.masks.push(M.makeMask('poly', points.map((p) => inv(p[0], p[1])), `Masque ${target.masks.length + 1}`)));
      this.timeline.reveal.set(target.id, new Set(['M']));
      return;
    }
    const cx = points.reduce((s, p) => s + p[0], 0) / points.length, cy = points.reduce((s, p) => s + p[1], 0) / points.length;
    const l = M.makeLayer(c, 'shape', { name: 'Tracé', in: core.time, content: { shape: 'path', fillOn: closed, strokeOn: true, stroke: '#ffffff', strokeWidth: 6, fill: '#7b5cff' } });
    l.path = { points: points.map((p) => [p[0] - cx, p[1] - cy]), closed };
    l.p.position.v = [cx, cy];
    this.addLayer(l);
  }

  addAssetLayer(asset, { select = true } = {}) {
    const core = this.core;
    const c = core.comp;
    const t = core.time;
    const type = asset.type;
    const dur = type === 'image' ? c.duration - t : asset.duration || c.duration;
    const l = M.makeLayer(c, type, { name: asset.name, source: asset.id, in: t, start: t, out: t + dur, w: asset.w || c.width, h: asset.h || c.height, fit: true });
    if (type === 'image') l.out = c.duration;
    return this.addLayer(l, { select });
  }

  addCompLayer(sub) {
    const core = this.core;
    if (sub.id === core.comp.id || M.compContains(core.project, sub, core.comp.id)) return toast('Impossible : cela créerait une boucle de compositions');
    const l = M.makeLayer(core.comp, 'comp', { name: sub.name, source: sub.id, in: core.time, start: core.time, out: core.time + sub.duration, w: sub.width, h: sub.height, fit: true });
    this.addLayer(l);
  }

  duplicate() {
    const core = this.core;
    const c = core.comp;
    const sel = core.selectedLayers;
    if (!sel.length) return;
    const copies = [];
    core.change('Dupliquer', () => {
      for (const l of sel) {
        const cp = cloneLayer(l);
        c.layers.splice(c.layers.indexOf(l), 0, cp);
        copies.push(cp.id);
      }
    });
    core.select(copies);
  }

  paste() {
    const core = this.core;
    if (!this.clipboard) return;
    const data = JSON.parse(this.clipboard);
    const ids = [];
    core.change('Coller', () => {
      const map = {};
      const layers = data.layers.map((l) => {
        const cp = cloneLayer(l);
        map[l.id] = cp.id;
        return cp;
      });
      for (const l of layers) if (l.parent) l.parent = map[l.parent] || (core.comp.layers.some((x) => x.id === l.parent) ? l.parent : null);
      core.comp.layers.unshift(...layers);
      ids.push(...layers.map((l) => l.id));
    });
    core.select(ids);
  }

  split() {
    const core = this.core;
    const c = core.comp;
    const t = core.time;
    const sel = core.selectedLayers.filter((l) => t > l.in && t < l.out);
    if (!sel.length) return toast('Placez la tête de lecture à l’intérieur du calque');
    const ids = [];
    core.change('Scinder le calque', () => {
      for (const l of sel) {
        const cp = cloneLayer(l);
        cp.in = t;
        l.out = t;
        c.layers.splice(c.layers.indexOf(l), 0, cp);
        ids.push(cp.id);
      }
    });
    core.select(ids);
  }

  precompose() {
    const core = this.core;
    const c = core.comp;
    const sel = core.selectedLayers;
    if (!sel.length) return;
    formDialog({ title: 'Pré-composer', okLabel: 'OK', fields: [{ key: 'name', label: 'Nom de la nouvelle composition', type: 'text' }], values: { name: `${sel[0].name} — pré-comp` } }).then((v) => {
      if (!v) return;
      core.change('Pré-composer', () => {
        const sub = M.makeComp({ name: v.name || 'Pré-composition', width: c.width, height: c.height, fps: c.fps, duration: c.duration, bg: c.bg });
        sub.motionBlur = c.motionBlur;
        const ids = new Set(sel.map((l) => l.id));
        const idx = c.layers.findIndex((l) => ids.has(l.id));
        sub.layers = c.layers.filter((l) => ids.has(l.id));
        for (const l of sub.layers) if (l.parent && !ids.has(l.parent)) l.parent = null;
        c.layers = c.layers.filter((l) => !ids.has(l.id));
        core.project.comps.push(sub);
        const layer = M.makeLayer(c, 'comp', { name: sub.name, source: sub.id, in: 0, start: 0, out: c.duration, w: c.width, h: c.height });
        c.layers.splice(Math.max(0, idx), 0, layer);
        core.selection.clear();
        core.selection.add(layer.id);
      });
    });
  }

  reorder(how) {
    const core = this.core;
    const c = core.comp;
    const sel = core.selectedLayers;
    if (!sel.length) return;
    core.change('Ordre des calques', () => {
      const ids = new Set(sel.map((l) => l.id));
      if (how === 'front' || how === 'back') {
        const rest = c.layers.filter((l) => !ids.has(l.id));
        c.layers = how === 'front' ? [...sel, ...rest] : [...rest, ...sel];
      } else {
        const d = how === 'forward' ? -1 : 1;
        const list = c.layers.slice();
        const order = d < 0 ? sel : [...sel].reverse();
        for (const l of order) {
          const i = list.indexOf(l), j = i + d;
          if (j < 0 || j >= list.length || ids.has(list[j].id)) continue;
          [list[i], list[j]] = [list[j], list[i]];
        }
        c.layers = list;
      }
    });
  }

  nudge(dx, dy) {
    const core = this.core;
    const sel = core.selectedLayers.filter((l) => !l.locked);
    if (!sel.length) return;
    core.change('Déplacer', () => {
      for (const l of sel) {
        const [ddx, ddy] = this.viewer.parentDelta(l, dx, dy);
        const p = M.keyedValue(l.p.position, core.time);
        M.setPropValue(l.p.position, core.time, [p[0] + ddx, p[1] + ddy]);
      }
    });
  }

  gotoLayerEdge(which) {
    const l = this.core.layer;
    if (l) this.core.setTime(which === 'in' ? l.in : l.out - 1 / this.core.comp.fps);
  }

  gotoKey(dir) {
    const core = this.core;
    const layers = core.selectedLayers.length ? core.selectedLayers : core.comp.layers;
    const times = [];
    for (const l of layers) for (const { prop } of M.allProps(l)) for (const k of prop.k || []) times.push(k.t);
    times.sort((a, b) => a - b);
    const t = dir < 0 ? [...times].reverse().find((x) => x < core.time - 1e-4) : times.find((x) => x > core.time + 1e-4);
    if (t != null) core.setTime(t);
  }

  addKey(key) {
    const core = this.core;
    const sel = core.selectedLayers;
    if (!sel.length) return toast('Sélectionnez un calque');
    core.change('Image clé', () => {
      for (const l of sel) M.setKey(l.p[key], core.time, core.engine.pv(core.comp, l, key, core.time));
    });
    this.timeline.revealKeys([{ position: 'P', scale: 'S', rotation: 'R', opacity: 'T', anchor: 'A' }[key]]);
  }

  setEase(e) {
    const core = this.core;
    if (!core.selKeys.size) return toast('Sélectionnez des images clés dans la timeline');
    core.change('Interpolation', () => {
      for (const s of core.selKeys) s.key.e = e;
    });
    toast(`Interpolation : ${M.EASINGS[e].label}`, 1200);
  }

  deleteKeys() {
    const core = this.core;
    if (!core.selKeys.size) return;
    core.change('Supprimer les images clés', () => {
      for (const s of core.selKeys) M.removeKey(s.prop, s.key);
      core.selKeys.clear();
    });
  }

  applyEffect(type) {
    const core = this.core;
    let sel = core.selectedLayers;
    if (!sel.length) {
      const adj = M.makeLayer(core.comp, 'adjust', { name: `Calque d’effets — ${M.EFFECTS[type].name}` });
      adj.effects.push(M.makeEffect(type));
      this.addLayer(adj, { label: 'Effet' });
      toast(`${M.EFFECTS[type].name} : calque d’effets créé`, 1600);
      return;
    }
    core.change(`Effet : ${M.EFFECTS[type].name}`, () => {
      for (const l of sel) l.effects.push(M.makeEffect(type));
    });
    for (const l of sel) this.timeline.reveal.set(l.id, new Set(['E']));
    this.timeline.schedule();
    if (isMobileLayout()) this.setMobileTab('props');
  }

  applyPreset(p) {
    const core = this.core;
    const sel = core.selectedLayers.filter((l) => !p.only || l.type === p.only);
    if (!sel.length) return toast(p.only ? `Sélectionnez un calque ${p.only === 'text' ? 'texte' : 'de forme'}` : 'Sélectionnez un calque');
    core.change(`Animation : ${p.name}`, () => {
      for (const l of sel) p.apply(l, Math.max(core.time, l.in), core.comp);
    });
    this.timeline.revealAnimated();
    toast(`✨ ${p.name}`, 1200);
  }

  // ---------- Projet & compositions ----------

  async newProject() {
    if (this.core.dirty && !(await confirmDialog('Nouveau projet', 'Le projet actuel sera fermé (il reste dans la sauvegarde automatique). Continuer ?', 'Nouveau projet'))) return;
    this.core.setProject(M.makeProject(), 'Nouveau projet');
    this.startCard.replaceChildren();
    this.updateStart();
  }

  async newCompDialog(from = null) {
    const v = await formDialog({
      title: 'Nouvelle composition', okLabel: 'Créer', rebuildOn: ['preset'],
      fields: [
        { key: 'name', label: 'Nom', type: 'text' },
        { key: 'preset', label: 'Préréglage', type: 'select', options: [['custom', 'Personnalisé'], ...M.COMP_PRESETS] },
        { key: 'width', label: 'Largeur (px)', type: 'number', min: 16, max: 8192, when: (x) => x.preset === 'custom' },
        { key: 'height', label: 'Hauteur (px)', type: 'number', min: 16, max: 8192, when: (x) => x.preset === 'custom' },
        { key: 'fps', label: 'Images par seconde', type: 'number', min: 1, max: 120, when: (x) => x.preset === 'custom' },
        { key: 'duration', label: 'Durée (secondes)', type: 'number', min: 0.1, max: 3600, step: 0.1 },
        { key: 'bg', label: 'Couleur de fond', type: 'color' },
      ],
      values: { name: `Composition ${this.core.project.comps.length + 1}`, preset: from ? 'custom' : '1920x1080x30', width: from?.w || 1920, height: from?.h || 1080, fps: from?.fps || 30, duration: from?.duration || 10, bg: '#000000' },
    });
    if (!v) return null;
    const [pw, ph, pf] = v.preset === 'custom' ? [v.width, v.height, v.fps] : v.preset.split('x').map(Number);
    const comp = M.makeComp({ name: v.name, width: Math.round(pw), height: Math.round(ph), fps: Number(pf) || 30, duration: Number(v.duration) || 10, bg: v.bg });
    this.core.change('Nouvelle composition', () => {
      this.core.project.comps.push(comp);
    });
    this.core.setComp(comp.id);
    return comp;
  }

  async compSettings(c) {
    const v = await formDialog({
      title: 'Paramètres de composition', okLabel: 'OK',
      fields: [
        { key: 'name', label: 'Nom', type: 'text' },
        { key: 'width', label: 'Largeur (px)', type: 'number', min: 16, max: 8192 },
        { key: 'height', label: 'Hauteur (px)', type: 'number', min: 16, max: 8192 },
        { key: 'fps', label: 'Images par seconde', type: 'number', min: 1, max: 120 },
        { key: 'duration', label: 'Durée (secondes)', type: 'number', min: 0.1, max: 3600, step: 0.1 },
        { key: 'bg', label: 'Couleur de fond', type: 'color' },
        { key: 'motionBlur', label: 'Flou de mouvement activé', type: 'checkbox' },
        { key: 'shutter', label: 'Angle d’obturateur (°)', type: 'range', min: 0, max: 720, step: 1 },
        { key: 'mbSamples', label: 'Échantillons du flou', type: 'range', min: 2, max: 64, step: 1 },
      ],
      values: { name: c.name, width: c.width, height: c.height, fps: c.fps, duration: c.duration, bg: c.bg, motionBlur: c.motionBlur, shutter: c.shutter, mbSamples: c.mbSamples },
    });
    if (!v) return;
    this.core.change('Paramètres de composition', () => {
      const oldDur = c.duration;
      c.name = v.name || c.name;
      c.width = Math.round(Number(v.width)) || c.width;
      c.height = Math.round(Number(v.height)) || c.height;
      c.fps = Number(v.fps) || c.fps;
      c.duration = Number(v.duration) || c.duration;
      c.bg = v.bg;
      c.motionBlur = v.motionBlur;
      c.shutter = v.shutter;
      c.mbSamples = v.mbSamples;
      if (c.workOut >= oldDur - 1e-6 || c.workOut > c.duration) c.workOut = c.duration;
      c.workIn = Math.min(c.workIn, c.workOut - 1 / c.fps);
      for (const l of c.layers) if (Math.abs(l.out - oldDur) < 1e-6 && l.type !== 'video' && l.type !== 'audio') l.out = c.duration;
    });
    this.timeline.fit();
    this.viewer.fit();
  }

  duplicateComp(c) {
    const core = this.core;
    const copy = JSON.parse(M.serialize(c));
    copy.id = M.mid('cp');
    copy.name = `${c.name} copie`;
    const map = {};
    copy.layers = copy.layers.map((l) => {
      const n = cloneLayer(l);
      map[l.id] = n.id;
      return n;
    });
    for (const l of copy.layers) if (l.parent) l.parent = map[l.parent] || null;
    core.change('Dupliquer la composition', () => core.project.comps.push(copy));
    core.setComp(copy.id);
  }

  async deleteComp(c) {
    const core = this.core;
    if (core.project.comps.length < 2) return;
    if (!(await confirmDialog('Supprimer la composition', `Supprimer « ${c.name} » ? Les calques qui l’utilisent seront retirés.`, 'Supprimer', true))) return;
    core.change('Supprimer la composition', () => {
      core.project.comps = core.project.comps.filter((x) => x !== c);
      for (const o of core.project.comps) o.layers = o.layers.filter((l) => !(l.type === 'comp' && l.source === c.id));
      if (core.project.active === c.id) core.project.active = core.project.comps[0].id;
    });
    core.emit('comp');
  }

  async compFromAsset(a) {
    const comp = M.makeComp({ name: a.name, width: a.w || 1920, height: a.h || 1080, fps: Math.round(a.fps || 30), duration: a.type === 'video' ? Math.max(0.1, a.duration) : 10 });
    this.core.change('Nouvelle composition', () => this.core.project.comps.push(comp));
    this.core.setComp(comp.id);
    this.core.time = 0;
    this.addAssetLayer(a);
  }

  async deleteAsset(a) {
    const core = this.core;
    const used = core.project.comps.some((c) => c.layers.some((l) => l.source === a.id));
    if (used && !(await confirmDialog('Supprimer le média', `« ${a.name} » est utilisé dans des compositions. Supprimer aussi ces calques ?`, 'Supprimer', true))) return;
    core.change('Supprimer le média', () => {
      core.project.assets = core.project.assets.filter((x) => x !== a);
      for (const c of core.project.comps) c.layers = c.layers.filter((l) => l.source !== a.id);
    });
    core.engine.forgetAsset(a);
  }

  useTemplate(t) {
    const core = this.core;
    const comp = t.build();
    core.change(`Modèle : ${t.name}`, () => {
      const empty = core.project.comps.length === 1 && !core.comp.layers.length;
      if (empty) core.project.comps = [];
      core.project.comps.push(comp);
    });
    core.setComp(comp.id);
    core.setTime(Math.min(comp.duration / 2, 2));
    this.timeline.fit();
    this.viewer.fit();
    toast(`Modèle « ${t.name} » — modifiez les textes dans Propriétés`, 2600);
  }

  // ---------- Import ----------

  importDialog() {
    const input = el('input', { type: 'file', multiple: true, accept: MEDIA_ACCEPT, hidden: true });
    document.body.append(input);
    input.onchange = async () => {
      const files = [...input.files];
      input.remove();
      await this.importFiles(files, true);
    };
    input.click();
  }

  async importFiles(files, addToComp = false) {
    const core = this.core;
    const proj = files.find((f) => /\.prismemotion$/i.test(f.name));
    if (proj) return this.loadProject(proj);
    const busy = el('div', { class: 'mo-busy' }, el('div', { class: 'spinner' }), el('span', {}, 'Import…'));
    this.viewRoot.append(busy);
    const added = [];
    try {
      for (const f of files) {
        if (!mediaKind(f)) {
          toast(`Format non pris en charge : ${f.name}`);
          continue;
        }
        busy.lastChild.textContent = `Import de ${f.name}…`;
        try {
          const a = await importMedia(f);
          core.registerAsset(a);
          core.change(`Importer ${a.name}`, () => core.project.assets.push(a));
          added.push(a);
        } catch (e) {
          console.error(e);
          toast(`Impossible d’importer ${f.name} : ${e.message}`, 4000);
        }
      }
    } finally {
      busy.remove();
    }
    if (!added.length) return;
    const c = core.comp;
    // Première vidéo dans une composition vide : la composition prend ses dimensions.
    if (addToComp && !c.layers.length && added[0].type === 'video' && core.project.comps.length === 1) {
      const a = added[0];
      core.change('Composition adaptée au média', () => {
        c.width = a.w;
        c.height = a.h;
        c.fps = Math.min(120, Math.max(1, Math.round(a.fps || 30)));
        c.duration = Math.max(1 / c.fps, a.duration || c.duration);
        c.workOut = c.duration;
      });
      this.viewer.fit();
    }
    if (addToComp) for (const a of added) this.addAssetLayer(a, { select: true });
    this.timeline.fit();
    toast(`${added.length} média(s) importé(s)`, 1500);
  }

  async importCanvas(canvas, name) {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    await this.importFiles([new File([blob], `${name}.png`, { type: 'image/png' })], true);
  }

  async importFromPhoto() {
    const app = this.photo;
    if (!app?.doc) return toast('Aucune image ouverte dans Prisme Photo');
    app.flushPending?.();
    app.updateComposite();
    await this.importCanvas(app.compositeCanvas, app.doc.name || 'Image Prisme Photo');
  }

  async sendToPhoto() {
    const core = this.core;
    const app = this.photo;
    if (!app) return;
    core.pause();
    while (core.rendering) await new Promise((r) => setTimeout(r, 10));
    core.exporting = true;
    let c2;
    try {
      const canvas = await core.engine.renderFrame(core.comp, core.time, { scale: 1, bg: !core.transparent });
      c2 = document.createElement('canvas');
      c2.width = canvas.width;
      c2.height = canvas.height;
      c2.getContext('2d').drawImage(canvas, 0, 0);
    } finally {
      core.exporting = false;
      core.invalidate();
    }
    this.hide();
    app.newDocument(c2.width, c2.height, null, `${core.comp.name} — ${M.timecode(core.time, core.comp.fps)}`);
    app.doc.layers[0].canvas = c2;
    app.doc.layers[0].name = 'Image Motion';
    app.originalCanvas = document.createElement('canvas');
    app.originalCanvas.width = c2.width;
    app.originalCanvas.height = c2.height;
    app.originalCanvas.getContext('2d').drawImage(c2, 0, 0);
    app.invalidate(true);
    app.emit('document');
    app.ui?.hideWelcome?.();
    toast('Image envoyée vers Prisme Photo', 1800);
  }

  // ---------- Fichiers projet ----------

  async saveProject() {
    const core = this.core;
    const blob = await packProject(core.project);
    const name = `${(core.project.name || core.comp.name || 'Projet').replace(/[\\/:*?"<>|]+/g, '_')}.prismemotion`;
    if (typeof window.showSaveFilePicker === 'function' && !window.Capacitor) {
      try {
        const h = this.fileHandle || await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Projet Prisme Motion', accept: { 'application/x-prisme-motion': ['.prismemotion'] } }] });
        const w = await h.createWritable();
        await w.write(blob);
        await w.close();
        this.fileHandle = h;
        core.dirty = false;
        return toast('Projet enregistré ✔', 1400);
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    await saveBlob(blob, name);
    core.dirty = false;
  }

  openProjectDialog() {
    const input = el('input', { type: 'file', accept: '.prismemotion', hidden: true });
    document.body.append(input);
    input.onchange = () => {
      const f = input.files[0];
      input.remove();
      if (f) this.loadProject(f);
    };
    input.click();
  }

  async loadProject(file) {
    try {
      const p = await unpackProject(file, (a) => this.core.registerAsset(a));
      this.core.setProject(p, 'Ouverture du projet');
      this.viewer.fit();
      this.timeline.fit();
      toast(`Projet « ${p.name} » ouvert`, 1500);
    } catch (e) {
      console.error(e);
      toast(`Projet illisible : ${e.message}`, 4000);
    }
  }

  async restoreSession(s) {
    try {
      const p = await restoreAutosave(s, (a) => this.core.registerAsset(a));
      this.core.setProject(p, 'Session restaurée');
      this.viewer.fit();
      this.timeline.fit();
    } catch (e) {
      toast(`Restauration impossible : ${e.message}`, 4000);
    }
  }

  // ---------- Aperçu & préférences ----------

  async ramPreview() {
    const core = this.core;
    if (this.ramRunning) {
      core.cancelRam = true;
      return;
    }
    this.ramRunning = true;
    const label = this.ramBtn.querySelector('span');
    try {
      const ok = await core.ramPreview((p) => (label.textContent = `Pré-calcul ${Math.round(p * 100)} %`));
      label.textContent = 'Pré-calcul RAM';
      if (ok) {
        core.time = core.comp.workIn;
        core.play();
      }
    } finally {
      this.ramRunning = false;
      label.textContent = 'Pré-calcul RAM';
    }
  }

  setResolution(r) {
    this.core.resolution = r === 'auto' ? 'auto' : Number(r);
    this.resSel.value = String(r);
    savePref('res', this.core.resolution);
    this.core.invalidate();
  }

  setCacheBudget(mb) {
    this.core.cacheBudgetMB = mb;
    savePref('cacheMB', mb);
  }

  async prefsDialog() {
    const core = this.core;
    const v = await formDialog({
      title: 'Préférences de Prisme Motion', okLabel: 'OK',
      fields: [
        { key: 'res', label: 'Résolution de l’aperçu', type: 'select', options: [['auto', 'Automatique (adaptative)'], ['1', 'Pleine'], ['0.5', 'Moitié'], ['0.333', 'Tiers'], ['0.25', 'Quart']] },
        { key: 'cache', label: 'Mémoire du cache RAM', type: 'select', options: [['512', '512 Mo'], ['1024', '1 Go'], ['1536', '1,5 Go'], ['3072', '3 Go'], ['6144', '6 Go']] },
        { key: 'draft', label: 'Brouillon rapide pendant les manipulations (sans flou de mouvement)', type: 'checkbox' },
      ],
      values: { res: String(core.resolution), cache: String(core.cacheBudgetMB), draft: !!core.fastDraft },
    });
    if (!v) return;
    this.setResolution(v.res);
    this.setCacheBudget(Number(v.cache));
    core.fastDraft = v.draft;
  }

  helpKeys() {
    const rows = [
      ['Espace', 'Lecture / pause'], ['0', 'Pré-calcul RAM puis lecture'], ['Page préc. / suiv.', 'Image précédente / suivante (Maj : ×10)'], ['Origine / Fin', 'Début / fin de la composition'],
      ['J / K', 'Image clé précédente / suivante'], ['I / O', 'Début / fin du calque'], ['B / N', 'Début / fin de la zone de travail'], ['[ / ]', 'Placer le début / la fin du calque ici'], ['Alt+[ / Alt+]', 'Rogner le calque ici'],
      ['P S R T A', 'Afficher Position, Échelle, Rotation, Opacité, Ancrage'], ['U', 'Afficher les propriétés animées'], ['E / M', 'Afficher les effets / masques'], ['F9', 'Lissage de vitesse (Easy Ease)'],
      ['V H Y', 'Sélection, Main, Point d’ancrage'], ['Q', 'Rectangle / ellipse (masque si un calque est sélectionné)'], ['G', 'Plume (Entrée pour terminer)'], ['Ctrl+T', 'Texte'],
      ['Flèches', 'Déplacer le calque de 1 px (Maj : 10 px)'], ['Ctrl+D', 'Dupliquer'], ['Ctrl+Maj+D', 'Scinder'], ['Ctrl+Maj+C', 'Pré-composer'], ['Ctrl+Y', 'Nouveau solide'],
      ['Ctrl+K', 'Paramètres de composition'], ['Ctrl+M', 'Exporter'], ['Ctrl+I', 'Importer'], ['Ctrl+S', 'Enregistrer'], ['Ctrl+Z / Ctrl+Maj+Z', 'Annuler / rétablir'],
      ['. / ,', 'Zoom avant / arrière'], ['/', 'Ajuster le zoom'], ['Molette', 'Zoom du visualiseur'], ['Ctrl+molette', 'Zoom de la timeline'],
    ];
    modal({ title: 'Raccourcis clavier', wide: true, body: el('div', { class: 'keys-grid' }, ...rows.flatMap(([k, d]) => [el('kbd', {}, k), el('span', {}, d)])), buttons: [{ label: 'Fermer', primary: true }] });
  }

  helpExpr() {
    const rows = [
      ['wiggle(fréq, amplitude)', 'Tremblement aléatoire lissé. Ex. : wiggle(2, 30)'], ['time', 'Temps courant en secondes. Ex. : time * 90 (rotation continue)'],
      ['value', 'Valeur de la propriété (images clés comprises)'], ['loopOut("cycle" | "pingpong" | "offset")', 'Boucle les images clés après la dernière'],
      ['add(a, b) · mul(a, b)', 'Opérations sur les vecteurs. Ex. : add(value, [0, Math.sin(time*3)*20])'], ['linear(t, t1, t2, v1, v2) · ease(…)', 'Interpolation d’une valeur'],
      ['random(min, max) · noise(x)', 'Aléatoire déterministe'], ['valueAtTime(t)', 'Valeur à un autre instant'], ['thisComp.width · index · inPoint', 'Informations sur la composition et le calque'],
    ];
    modal({ title: 'Expressions — aide-mémoire', wide: true, body: el('div', { class: 'keys-grid' }, ...rows.flatMap(([k, d]) => [el('code', {}, k), el('span', {}, d)])), buttons: [{ label: 'Fermer', primary: true }] });
  }
}

// ---------- Utilitaires ----------

function shiftLayer(l, d) {
  l.in += d;
  l.out += d;
  l.start += d;
  for (const { prop } of M.allProps(l)) for (const k of prop.k || []) k.t += d;
}

function cloneLayer(l) {
  const cp = JSON.parse(M.serialize(l));
  cp.id = M.mid('ly');
  for (const fx of cp.effects) fx.id = M.mid('fx');
  for (const m of cp.masks) m.id = M.mid('mk');
  return cp;
}

function M4inv(m) {
  const a = m[0], b = m[1], c = m[4], d = m[5], e = m[12], f = m[13];
  const det = a * d - b * c || 1e-9;
  return (x, y) => [((x - e) * d - (y - f) * c) / det, ((y - f) * a - (x - e) * b) / det];
}
