// Prisme Motion — panneaux latéraux : Projet (compositions et médias), Effets & préréglages,
// Propriétés (réglages du calque sélectionné ou de la composition).

import { el } from '../util.js';
import { icon } from '../icons.js';
import { dropdown, toast } from '../ui.js';
import * as M from './model.js';
import { propEditor, keyControls, exprEditor, scrubber, propKey } from './widgets.js';
import { setParent } from './timeline.js';

const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(s < 10 ? 1 : 0)} s`);

// ---------- Projet ----------

export function projectPanel(mapp) {
  const core = mapp.core;
  const root = el('div', { class: 'mp mp-project' });
  const render = () => {
    const p = core.project;
    root.innerHTML = '';
    root.append(el('div', { class: 'mp-actions' },
      el('button', { class: 'btn small', onclick: () => mapp.importDialog(), html: `${icon('plus', 14)}<span>Importer</span>` }),
      el('button', { class: 'btn small', onclick: () => mapp.newCompDialog(), html: `${icon('comp', 14)}<span>Composition</span>` })));
    root.append(el('div', { class: 'mp-head' }, `Compositions (${p.comps.length})`));
    for (const c of p.comps) {
      const item = el('div', { class: `mp-item${c.id === p.active ? ' on' : ''}`, draggable: 'true' },
        el('span', { class: 'mp-ic', html: icon('comp', 18) }),
        el('div', { class: 'mp-txt' }, el('b', {}, c.name), el('small', {}, `${c.width}×${c.height} · ${c.fps} i/s · ${fmtDur(c.duration)} · ${c.layers.length} calque(s)`)));
      item.onclick = () => core.setComp(c.id);
      item.ondblclick = () => mapp.compSettings(c);
      item.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-prisme-comp', c.id));
      item.oncontextmenu = (e) => {
        e.preventDefault();
        dropdown({ x: e.clientX, y: e.clientY }, [
          { label: 'Ouvrir', action: () => core.setComp(c.id) },
          { label: 'Paramètres de composition…', action: () => mapp.compSettings(c) },
          { label: 'Ajouter à la composition active', disabled: c.id === p.active, action: () => mapp.addCompLayer(c) },
          { label: 'Dupliquer', action: () => mapp.duplicateComp(c) },
          { sep: true },
          { label: 'Supprimer', disabled: p.comps.length < 2, action: () => mapp.deleteComp(c) },
        ]);
      };
      root.append(item);
    }
    root.append(el('div', { class: 'mp-head' }, `Médias (${p.assets.length})`));
    if (!p.assets.length) root.append(el('div', { class: 'mp-empty' }, 'Glissez ici vos vidéos, images et sons, ou utilisez « Importer ».'));
    for (const a of p.assets) {
      const info = a.type === 'image' ? `${a.w}×${a.h}` : a.type === 'video' ? `${a.w}×${a.h} · ${fmtDur(a.duration || 0)} · ${a.fps || '?'} i/s${a.hasAudio ? ' · son' : ''}` : fmtDur(a.duration || 0);
      const item = el('div', { class: 'mp-item', draggable: 'true' },
        a.thumb ? el('img', { class: 'mp-thumb', src: a.thumb, alt: '' }) : el('span', { class: 'mp-ic', html: icon(a.type === 'audio' ? 'music' : a.type === 'video' ? 'film' : 'image', 18) }),
        el('div', { class: 'mp-txt' }, el('b', {}, a.name), el('small', {}, info)),
        el('button', { class: 'mini-btn', title: 'Ajouter à la composition', html: icon('plus', 14), onclick: (e) => {
          e.stopPropagation();
          mapp.addAssetLayer(a);
        } }));
      item.ondblclick = () => mapp.addAssetLayer(a);
      item.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-prisme-asset', a.id));
      item.oncontextmenu = (e) => {
        e.preventDefault();
        dropdown({ x: e.clientX, y: e.clientY }, [
          { label: 'Ajouter à la composition', action: () => mapp.addAssetLayer(a) },
          { label: 'Nouvelle composition à partir du média', disabled: a.type === 'audio', action: () => mapp.compFromAsset(a) },
          { sep: true },
          { label: 'Supprimer du projet', action: () => mapp.deleteAsset(a) },
        ]);
      };
      root.append(item);
    }
    const g = core.engine.gl;
    root.append(el('div', { class: 'mp-foot' }, `Moteur GPU : ${g.gpuName}`));
  };
  core.on('change', render);
  core.on('comp', render);
  render();
  return root;
}

// ---------- Effets & préréglages ----------

export function effectsPanel(mapp) {
  const core = mapp.core;
  const root = el('div', { class: 'mp mp-effects' });
  const search = el('input', { type: 'search', placeholder: 'Rechercher un effet ou un préréglage…', class: 'mp-search' });
  search.addEventListener('keydown', (e) => e.stopPropagation());
  const list = el('div');
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const render = () => {
    const q = norm(search.value.trim());
    list.innerHTML = '';
    const sec = (title) => list.append(el('div', { class: 'mp-head' }, title));
    const presetCats = [...new Set(M.PRESETS.map((p) => p.cat))];
    let any = false;
    sec('✨ Préréglages d’animation');
    for (const cat of presetCats) {
      const items = M.PRESETS.filter((p) => p.cat === cat && (!q || norm(p.name).includes(q) || norm(cat).includes(q)));
      if (!items.length) continue;
      any = true;
      list.append(el('div', { class: 'mp-sub' }, cat));
      for (const p of items) list.append(el('button', { class: 'mp-fx', onclick: () => mapp.applyPreset(p), title: p.only ? `Calques ${p.only === 'text' ? 'texte' : 'de forme'}` : '' }, el('span', { html: icon('sparkles', 14) }), p.name));
    }
    sec('Effets (GPU)');
    for (const cat of M.EFFECT_CATS) {
      const items = Object.entries(M.EFFECTS).filter(([, d]) => d.cat === cat && (!q || norm(d.name).includes(q) || norm(cat).includes(q)));
      if (!items.length) continue;
      any = true;
      list.append(el('div', { class: 'mp-sub' }, cat));
      for (const [type, d] of items) {
        const b = el('button', { class: 'mp-fx', draggable: 'true', onclick: () => mapp.applyEffect(type) }, el('span', { html: icon('fx', 14) }), d.name);
        b.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/x-prisme-effect', type));
        list.append(b);
      }
    }
    if (!any) list.append(el('div', { class: 'mp-empty' }, 'Aucun résultat.'));
  };
  search.addEventListener('input', render);
  root.append(search, el('div', { class: 'mp-hint' }, 'Cliquez pour appliquer au calque sélectionné (sans sélection : un calque d’effets est créé).'), list);
  render();
  return root;
}

// ---------- Propriétés ----------

export function propertiesPanel(mapp) {
  const core = mapp.core;
  const root = el('div', { class: 'mp mp-props' });
  let refreshers = [];
  const openGroups = new Set(['transform', 'content']);
  const render = () => {
    refreshers = [];
    root.innerHTML = '';
    const layers = core.selectedLayers;
    if (layers.length === 1) layerProps(layers[0]);
    else if (layers.length > 1) {
      root.append(el('div', { class: 'mp-title' }, `${layers.length} calques sélectionnés`));
      root.append(el('div', { class: 'mp-empty' }, 'Les effets et préréglages s’appliquent à tous les calques sélectionnés. Utilisez la timeline pour modifier leurs propriétés.'));
    } else compProps();
  };
  const row = (label, ...ctrl) => el('div', { class: 'mp-row' }, el('label', {}, label), el('div', { class: 'mp-ctrl' }, ...ctrl));
  const timeScrub = (get, set, label) => {
    const c = core.comp;
    const s = scrubber({ get: () => Math.round(get() * c.fps), step: 1, begin: () => core.beginDrag(), set: (v) => {
      set(v / c.fps);
      core.live();
    }, end: () => core.endDrag(label), commit: (v) => core.change(label, () => set(v / c.fps)), unit: ' i' });
    refreshers.push(s.refresh);
    return s;
  };

  function layerProps(layer) {
    const c = core.comp;
    const name = el('input', { class: 'mp-name', value: layer.name });
    name.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') name.blur();
    });
    name.addEventListener('change', () => core.change('Renommer', () => (layer.name = name.value.trim() || layer.name)));
    root.append(el('div', { class: 'mp-title' }, el('span', { class: 'lbl', style: { background: layer.label } }), el('span', { html: icon(M.LAYER_TYPES[layer.type]?.icon || 'layers', 16) }), name));
    // Calque
    const sel = (opts, value, fn) => {
      const s = el('select', { class: 'mini-select' }, ...opts.map(([k, l]) => el('option', { value: k }, l)));
      s.value = value;
      s.onchange = () => fn(s.value);
      s.addEventListener('keydown', (e) => e.stopPropagation());
      return s;
    };
    const chk = (on, label, fn) => el('label', { class: 'mini-check' }, el('input', { type: 'checkbox', checked: on ? true : null, onchange: (e) => fn(e.target.checked) }), label);
    const box = el('div', { class: 'mp-group' }, el('div', { class: 'mp-gh' }, 'Calque'));
    box.append(
      row('Début (image)', timeScrub(() => layer.in, (v) => (layer.in = Math.min(v, layer.out - 1 / c.fps)), 'Point d’entrée')),
      row('Fin (image)', timeScrub(() => layer.out, (v) => (layer.out = Math.max(v, layer.in + 1 / c.fps)), 'Point de sortie')),
    );
    if (['video', 'audio', 'comp'].includes(layer.type)) {
      const sp = scrubber({ get: () => (layer.speed || 1) * 100, step: 1, min: 1, max: 1000, unit: ' %', begin: () => core.beginDrag(), set: (v) => {
        layer.speed = v / 100;
        core.live();
      }, end: () => core.endDrag('Vitesse'), commit: (v) => core.change('Vitesse', () => (layer.speed = v / 100)) });
      refreshers.push(sp.refresh);
      box.append(row('Vitesse', sp), row('Décalage source', timeScrub(() => layer.start, (v) => (layer.start = v), 'Décalage')));
    }
    box.append(
      row('Mode de fusion', sel(M.BLEND_MODES, layer.blend, (v) => core.change('Mode de fusion', () => (layer.blend = v)))),
      row('Cache', sel(M.MATTE_MODES, layer.matte || '', (v) => core.change('Cache', () => (layer.matte = v)))),
      row('Parent', sel([['', 'Aucun'], ...c.layers.filter((l) => l !== layer).map((l) => [l.id, `${c.layers.indexOf(l) + 1}. ${l.name}`])], layer.parent || '', (v) => core.change('Parent', () => setParent(core, c, layer, v || null)))),
      el('div', { class: 'mp-checks' },
        chk(layer.threeD, 'Calque 3D', (v) => core.change('Calque 3D', () => (layer.threeD = v))),
        chk(layer.motionBlur, 'Flou de mouvement', (v) => core.change('Flou de mouvement', () => (layer.motionBlur = v))),
        chk(layer.visible, 'Visible', (v) => core.change('Visibilité', () => (layer.visible = v))),
        chk(layer.locked, 'Verrouillé', (v) => core.change('Verrou', () => (layer.locked = v))),
        ['video', 'audio', 'comp'].includes(layer.type) ? chk(layer.audio, 'Son', (v) => core.change('Audio', () => (layer.audio = v))) : null),
      el('div', { class: 'mp-colors' }, ...M.LABEL_COLORS.map((col) => el('button', { class: `mp-swatch${layer.label === col ? ' on' : ''}`, style: { background: col }, title: 'Couleur d’étiquette', onclick: () => core.change('Étiquette', () => (layer.label = col)) }))),
    );
    root.append(box);
    if (layer.type === 'comp') root.append(el('button', { class: 'btn small block', onclick: () => core.setComp(layer.source) }, 'Ouvrir la pré-composition'));
    if (layer.type === 'text') {
      const prop = layer.p['c.text'];
      const ta = el('textarea', { class: 'mp-textarea', rows: 3 }, prop.v);
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      ta.addEventListener('input', () => {
        core.beginDrag();
        prop.v = ta.value;
        core.live();
      });
      ta.addEventListener('change', () => core.endDrag('Texte'));
      root.append(el('div', { class: 'mp-group' }, el('div', { class: 'mp-gh' }, 'Texte'), ta));
    }
    for (const g of M.layerGroups(layer)) {
      const closed = g.effect ? !!g.effect.__closed : g.mask ? !!g.mask.__closed : !openGroups.has(g.id);
      const gh = el('button', { class: `mp-gh toggle${closed ? '' : ' open'}` }, el('span', { class: 'chev' }, '▸'), g.label);
      const body = el('div', { class: 'mp-gbody' });
      const grp = el('div', { class: 'mp-group' }, gh, body);
      gh.onclick = () => {
        if (g.effect) g.effect.__closed = !g.effect.__closed;
        else if (g.mask) g.mask.__closed = !g.mask.__closed;
        else if (openGroups.has(g.id)) openGroups.delete(g.id);
        else openGroups.add(g.id);
        render();
      };
      if (g.effect) {
        gh.append(el('span', { class: 'spacer' }),
          el('button', { class: `sw ${g.effect.on ? 'on' : ''}`, title: 'Activer', html: icon('fx', 13), onclick: (e) => {
            e.stopPropagation();
            core.change('Effet', () => (g.effect.on = !g.effect.on));
          } }),
          el('button', { class: 'mini-btn', title: 'Monter', html: icon('up', 13), onclick: (e) => {
            e.stopPropagation();
            core.change('Ordre des effets', () => moveIn(layer.effects, g.effect, -1));
          } }),
          el('button', { class: 'mini-btn', title: 'Descendre', html: icon('down', 13), onclick: (e) => {
            e.stopPropagation();
            core.change('Ordre des effets', () => moveIn(layer.effects, g.effect, 1));
          } }),
          el('button', { class: 'mini-btn', title: 'Supprimer', html: icon('trash', 13), onclick: (e) => {
            e.stopPropagation();
            core.change('Supprimer l’effet', () => (layer.effects = layer.effects.filter((f) => f !== g.effect)));
          } }));
      }
      if (g.mask) {
        const m = g.mask;
        gh.append(el('span', { class: 'spacer' }), el('button', { class: 'mini-btn', title: 'Supprimer le masque', html: icon('trash', 13), onclick: (e) => {
          e.stopPropagation();
          core.change('Supprimer le masque', () => (layer.masks = layer.masks.filter((x) => x !== m)));
        } }));
        body.append(row('Mode', sel(M.MASK_MODES, m.mode, (v) => core.change('Mode du masque', () => (m.mode = v)))), el('div', { class: 'mp-checks' }, chk(m.inverted, 'Inversé', (v) => core.change('Inverser le masque', () => (m.inverted = v)))));
      }
      if (!closed) {
        for (const it of g.props) {
          if (it.def.type === 'text') continue;
          const kc = keyControls(core, layer, it);
          const ed = propEditor(core, layer, it);
          refreshers.push(kc.refresh, ed.refresh);
          const prop = M.propOf(layer, it);
          const lbl = el('label', {}, kc.el, el('span', {}, it.def.label));
          const r = el('div', { class: 'mp-row prop' }, lbl, el('div', { class: 'mp-ctrl' }, ed.el));
          if (!['select', 'bool', 'text'].includes(it.def.type)) {
            const eb = el('button', { class: `mini-btn expr-btn${prop.x ? ' on' : ''}`, title: 'Expression', html: icon('expr', 12) });
            eb.onclick = () => {
              layer.__exprOpen ||= new Set();
              const k = propKey(it);
              if (layer.__exprOpen.has(k)) layer.__exprOpen.delete(k);
              else layer.__exprOpen.add(k);
              render();
            };
            r.lastChild.append(eb);
          }
          body.append(r);
          if (prop.x != null || layer.__exprOpen?.has(propKey(it))) {
            const ex = exprEditor(core, layer, it);
            refreshers.push(ex.refresh);
            body.append(ex.el);
          }
        }
        if (g.id === 'transform') {
          body.append(el('div', { class: 'mp-actions' },
            el('button', { class: 'btn small', onclick: () => mapp.run('layer.center') }, 'Centrer'),
            el('button', { class: 'btn small', onclick: () => mapp.run('layer.fit') }, 'Ajuster'),
            el('button', { class: 'btn small', onclick: () => mapp.run('layer.anchorCenter') }, 'Ancre au centre'),
            el('button', { class: 'btn small', onclick: () => mapp.run('layer.resetTransform') }, 'Réinitialiser')));
        }
      }
      root.append(grp);
    }
    root.append(el('div', { class: 'mp-actions' },
      el('button', { class: 'btn small', onclick: (e) => mapp.effectMenu(e.currentTarget), html: `${icon('fx', 14)}<span>Ajouter un effet</span>` }),
      el('button', { class: 'btn small', onclick: (e) => mapp.presetMenu(e.currentTarget), html: `${icon('sparkles', 14)}<span>Animer</span>` })));
  }

  function compProps() {
    const c = core.comp;
    root.append(el('div', { class: 'mp-title' }, el('span', { html: icon('comp', 16) }), el('b', {}, c.name)));
    root.append(el('div', { class: 'mp-group' },
      el('div', { class: 'mp-gh' }, 'Composition'),
      el('div', { class: 'mp-info' }, `${c.width} × ${c.height} px · ${c.fps} i/s · ${fmtDur(c.duration)}`),
      el('div', { class: 'mp-actions' }, el('button', { class: 'btn small', onclick: () => mapp.compSettings(c) }, 'Paramètres de composition…')),
      el('div', { class: 'mp-checks' }, el('label', { class: 'mini-check' }, el('input', { type: 'checkbox', checked: c.motionBlur ? true : null, onchange: (e) => core.change('Flou de mouvement', () => (c.motionBlur = e.target.checked)) }), 'Flou de mouvement (calques cochés)'))));
    const perf = el('div', { class: 'mp-group' }, el('div', { class: 'mp-gh' }, 'Performances'));
    const res = el('select', { class: 'mini-select' }, ...[['auto', 'Automatique (adaptative)'], ['1', 'Pleine'], ['0.5', 'Moitié'], ['0.333', 'Tiers'], ['0.25', 'Quart']].map(([k, l]) => el('option', { value: k }, l)));
    res.value = String(core.resolution);
    res.onchange = () => mapp.setResolution(res.value);
    const cache = el('select', { class: 'mini-select' }, ...[[512, '512 Mo'], [1024, '1 Go'], [1536, '1,5 Go'], [3072, '3 Go'], [6144, '6 Go']].map(([k, l]) => el('option', { value: k }, l)));
    cache.value = String(core.cacheBudgetMB);
    cache.onchange = () => mapp.setCacheBudget(Number(cache.value));
    perf.append(row('Résolution d’aperçu', res), row('Cache RAM', cache), el('div', { class: 'mp-info' }, `GPU : ${core.engine.gl.gpuName}`));
    root.append(perf);
    root.append(el('div', { class: 'mp-group' }, el('div', { class: 'mp-gh' }, 'Astuces'), el('div', { class: 'mp-info tips' },
      el('div', {}, 'Espace : lecture · 0 : pré-calcul RAM'),
      el('div', {}, 'P S R T A : afficher Position, Échelle, Rotation, Opacité, Ancrage · U : propriétés animées'),
      el('div', {}, 'Chronomètre ⏱ : animer une propriété — chaque modification crée une image clé'),
      el('div', {}, 'F9 : lissage de vitesse (Easy Ease) des images clés sélectionnées'),
      el('div', {}, 'Q : rectangle (masque si un calque est sélectionné) · G : plume · Ctrl+T : texte'),
      el('div', {}, 'Expressions : wiggle(2, 30), time * 90, loopOut(), value…'))));
  }

  const sched = () => {
    if (root.__q) return;
    root.__q = requestAnimationFrame(() => {
      root.__q = null;
      if (root.contains(document.activeElement) && document.activeElement.matches('textarea, input')) {
        refreshers.forEach((f) => f());
        return;
      }
      render();
    });
  };
  core.on('select', sched);
  core.on('change', sched);
  core.on('comp', sched);
  core.on('time', () => refreshers.forEach((f) => f()));
  core.on('live', () => refreshers.forEach((f) => f()));
  render();
  return root;
}

function moveIn(arr, item, d) {
  const i = arr.indexOf(item), j = i + d;
  if (i < 0 || j < 0 || j >= arr.length) return;
  arr.splice(i, 1);
  arr.splice(j, 0, item);
}

export { toast };
