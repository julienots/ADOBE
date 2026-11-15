// Palette de commandes (Ctrl+K) : recherche instantanée dans toutes les commandes, filtres et outils.

import { el } from './util.js';

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Score de correspondance approximative : mots consécutifs et débuts de mots favorisés.
function score(query, text) {
  if (!query) return 1;
  const t = norm(text);
  const idx = t.indexOf(query);
  if (idx >= 0) return 100 - idx + (idx === 0 || t[idx - 1] === ' ' ? 50 : 0);
  let ti = 0, s = 0, run = 0;
  for (const ch of query) {
    if (ch === ' ') continue;
    const j = t.indexOf(ch, ti);
    if (j < 0) return 0;
    run = j === ti ? run + 1 : 0;
    s += 1 + run * 2 + (j === 0 || t[j - 1] === ' ' ? 3 : 0);
    ti = j + 1;
  }
  // Correspondance trop éparpillée : on l'écarte
  return s >= query.replace(/ /g, '').length * 3 ? s : 0;
}

const RECENT_KEY = 'prisme.paletteRecent';
const loadRecent = () => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
  } catch {
    return [];
  }
};

export function openPalette(app, actions) {
  if (document.querySelector('.palette-back')) return;
  const entries = [];
  const seen = new Set();
  for (const c of Object.values(actions.cmds)) {
    if (c.id === 'help.palette' || seen.has(c.label)) continue;
    seen.add(c.label);
    const cat = c.id.startsWith('filter.') ? 'Filtre' : { file: 'Fichier', edit: 'Édition', image: 'Image', layer: 'Calque', mask: 'Masque', sel: 'Sélection', view: 'Affichage', help: 'Aide', ai: 'IA' }[c.id.split('.')[0]] || '';
    entries.push({ id: c.id, label: c.label, cat, shortcut: c.shortcut, enabled: () => (c.enabled ? c.enabled() : true), run: () => actions.run(c.id) });
  }
  for (const t of Object.values(app.tools)) {
    entries.push({ id: `tool.${t.id}`, label: `Outil : ${t.name}`, cat: 'Outil', shortcut: t.key || '', enabled: () => true, run: () => app.setTool(t.id) });
  }
  const recent = loadRecent();

  const input = el('input', { type: 'text', placeholder: 'Rechercher une commande, un filtre, un outil…', 'aria-label': 'Rechercher une commande', spellcheck: 'false', autocomplete: 'off' });
  const list = el('div', { class: 'palette-list', role: 'listbox' });
  const box = el('div', { class: 'palette', role: 'dialog', 'aria-label': 'Palette de commandes' }, input, list,
    el('div', { class: 'palette-foot' }, '↑↓ naviguer · Entrée exécuter · Échap fermer'));
  const back = el('div', { class: 'palette-back' }, box);
  let results = [], sel = 0;

  const render = () => {
    const q = norm(input.value.trim());
    results = entries
      .map((e) => {
        const r = recent.indexOf(e.id);
        return { e, s: score(q, `${e.label} ${e.cat}`) + (r >= 0 ? (q ? 8 : 200) - r : 0) };
      })
      .filter((x) => x.s > 0 && x.e.enabled())
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.e);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    list.innerHTML = '';
    if (!results.length) list.append(el('div', { class: 'palette-empty' }, 'Aucun résultat'));
    results.forEach((e, i) => {
      list.append(el('div', {
        class: `palette-item${i === sel ? ' active' : ''}`, role: 'option', 'aria-selected': String(i === sel),
        onpointerdown: (ev) => {
          ev.preventDefault();
          exec(i);
        },
        onpointermove: () => {
          if (sel !== i) {
            sel = i;
            highlight();
          }
        },
      }, el('span', { class: 'palette-label' }, e.label), el('span', { class: 'palette-cat' }, e.cat), e.shortcut ? el('kbd', {}, e.shortcut) : null));
    });
  };
  const highlight = () => {
    [...list.children].forEach((c, i) => {
      c.classList.toggle('active', i === sel);
      c.setAttribute('aria-selected', String(i === sel));
    });
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const exec = (i) => {
    const e = results[i];
    if (!e) return;
    close();
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify([e.id, ...recent.filter((x) => x !== e.id)].slice(0, 8)));
    } catch {
      /* stockage indisponible */
    }
    e.run();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (!results.length) return;
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      exec(sel);
    }
  };
  input.addEventListener('input', () => {
    sel = 0;
    render();
  });
  back.addEventListener('pointerdown', (e) => e.target === back && close());
  document.addEventListener('keydown', onKey, true);
  document.getElementById('overlays').append(back);
  render();
  input.focus();
}
