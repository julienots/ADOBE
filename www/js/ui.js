// Composants d'interface : notifications, menus, fenêtres, formulaires, sélecteur de couleur.

import { el, $, clamp, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, isMobileLayout } from './util.js';
import { icon } from './icons.js';
import { FONTS, fontLabel } from './text.js';

const overlays = () => $('#overlays');

// ---------- Notifications ----------

export function toast(msg, ms = 2200) {
  let box = $('#toasts');
  if (!box) box = overlays().appendChild(el('div', { id: 'toasts' }));
  const t = box.appendChild(el('div', { class: 'toast' }, msg));
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => t.remove(), ms);
}

let busyCount = 0;
// Affiche un indicateur pendant un traitement lourd (laisse le temps au navigateur de l'afficher).
export async function busy(fn, label = 'Traitement…') {
  const b = $('#busy');
  busyCount++;
  b.querySelector('span').textContent = label;
  b.hidden = false;
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 16)));
  try {
    return await fn();
  } finally {
    if (--busyCount <= 0) {
      busyCount = 0;
      b.hidden = true;
    }
  }
}

// ---------- Menus déroulants ----------

let openDropdown = null;

export function closeDropdown() {
  if (openDropdown) {
    openDropdown.remove();
    openDropdown.onClose?.();
    openDropdown = null;
  }
}

export function dropdown(anchor, items, { onClose, level = 0 } = {}) {
  if (level === 0) closeDropdown();
  const menu = el('div', { class: 'dropdown', role: 'menu' });
  menu.onClose = onClose;
  const render = (list) => {
    menu.innerHTML = '';
    if (level > 0 || (isMobileLayout() && list !== items)) {
      menu.append(el('button', { class: 'dd-item', onclick: () => render(items) }, '‹ Retour'));
    }
    for (const it of list) {
      if (!it) continue;
      if (it.sep) {
        menu.append(el('div', { class: 'dd-sep' }));
        continue;
      }
      if (it.head) {
        menu.append(el('div', { class: 'dd-head' }, it.head));
        continue;
      }
      const btn = el('button', { class: 'dd-item', role: 'menuitem', disabled: it.disabled ? true : null },
        it.checked != null ? el('span', { style: { width: '14px' } }, it.checked ? '✓' : '') : null,
        it.icon ? el('span', { html: icon(it.icon, 16) }) : null,
        el('span', {}, it.label),
        it.submenu ? el('span', { class: 'chev' }, '›') : it.shortcut ? el('span', { class: 'sc' }, it.shortcut) : null);
      if (it.submenu) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isMobileLayout()) render(typeof it.submenu === 'function' ? it.submenu() : it.submenu);
          else openSub(btn, it);
        });
        if (!isMobileLayout()) btn.addEventListener('mouseenter', () => openSub(btn, it));
      } else {
        btn.addEventListener('mouseenter', () => closeSub());
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          closeDropdown();
          it.action?.();
        });
      }
      menu.append(btn);
    }
  };
  let sub = null;
  const closeSub = () => {
    sub?.remove();
    sub = null;
  };
  const openSub = (btn, it) => {
    closeSub();
    const list = typeof it.submenu === 'function' ? it.submenu() : it.submenu;
    sub = el('div', { class: 'dropdown' });
    for (const s of list) {
      if (!s) continue;
      if (s.sep) {
        sub.append(el('div', { class: 'dd-sep' }));
        continue;
      }
      if (s.head) {
        sub.append(el('div', { class: 'dd-head' }, s.head));
        continue;
      }
      sub.append(el('button', {
        class: 'dd-item', disabled: s.disabled ? true : null,
        onclick: (e) => {
          e.stopPropagation();
          closeDropdown();
          s.action?.();
        },
      }, s.checked != null ? el('span', { style: { width: '14px' } }, s.checked ? '✓' : '') : null, el('span', {}, s.label), s.shortcut ? el('span', { class: 'sc' }, s.shortcut) : null));
    }
    menu.append(sub);
    const r = btn.getBoundingClientRect();
    sub.style.left = `${Math.min(r.right + 2, innerWidth - 260)}px`;
    sub.style.top = `${Math.min(r.top - 5, innerHeight - Math.min(sub.scrollHeight, innerHeight - 70) - 10)}px`;
  };
  render(items);
  overlays().append(menu);
  if (!isMobileLayout()) {
    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : { left: anchor.x, bottom: anchor.y, top: anchor.y };
    menu.style.left = `${Math.max(4, Math.min(r.left, innerWidth - 260))}px`;
    menu.style.top = `${Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
  } else {
    // Sur mobile : feuille en bas de l'écran avec fond assombri.
    const back = el('div', { class: 'modal-back', style: { zIndex: 59 }, onclick: () => closeDropdown() });
    overlays().insertBefore(back, menu);
    const prevClose = menu.onClose;
    menu.onClose = () => {
      back.remove();
      prevClose?.();
    };
  }
  openDropdown = menu;
  setTimeout(() => {
    const away = (e) => {
      if (!menu.contains(e.target)) {
        closeDropdown();
        document.removeEventListener('pointerdown', away, true);
      }
    };
    document.addEventListener('pointerdown', away, true);
  });
  return menu;
}

// ---------- Fenêtres modales ----------

export function modal({ title, body, buttons = [], wide = false, preview = false, onClose, left }) {
  const back = el('div', { class: `modal-back${preview ? ' preview-mode' : ''}` });
  const box = el('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title });
  const header = el('header', {}, el('span', {}, title), el('button', { class: 'icon-btn', html: icon('close', 18), onclick: () => close(null) }));
  const footer = el('footer', {}, left ? el('div', { class: 'left' }, left) : null);
  let resolveFn;
  const promise = new Promise((r) => (resolveFn = r));
  const close = (value) => {
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.(value);
    resolveFn(value);
  };
  for (const b of buttons) {
    footer.append(el('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`, onclick: () => (b.onClick ? b.onClick(close) : close(b.value)) }, b.label));
  }
  box.append(header, el('div', { class: 'body' }, body), footer);
  back.append(box);
  if (!preview) back.addEventListener('pointerdown', (e) => e.target === back && close(null));
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(null);
    } else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      const primary = buttons.find((b) => b.primary);
      if (primary) {
        e.preventDefault();
        e.stopPropagation();
        primary.onClick ? primary.onClick(close) : close(primary.value);
      }
    }
  };
  document.addEventListener('keydown', onKey, true);
  overlays().append(back);
  // Fenêtre déplaçable sur ordinateur (pratique pour voir l'aperçu)
  if (!isMobileLayout()) makeDraggable(box, header);
  return { close, promise, box, back };
}

function makeDraggable(box, handle) {
  let start = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = box.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, l: r.left, t: r.top };
    box.style.position = 'fixed';
    box.style.margin = '0';
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!start) return;
    box.style.left = `${clamp(start.l + e.clientX - start.x, 0, innerWidth - 80)}px`;
    box.style.top = `${clamp(start.t + e.clientY - start.y, 0, innerHeight - 40)}px`;
  });
  handle.addEventListener('pointerup', () => (start = null));
}

export function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  return modal({
    title,
    body: el('p', { style: { margin: 0, color: 'var(--muted)' } }, message),
    buttons: [{ label: 'Annuler', value: false }, { label: okLabel, value: true, primary: !danger, danger }],
  }).promise;
}

export function promptDialog(title, label, value = '') {
  const input = el('input', { type: 'text', value, style: { width: '100%' } });
  const m = modal({
    title,
    body: el('div', { class: 'field full' }, el('label', {}, label), input),
    buttons: [{ label: 'Annuler', value: null }, { label: 'OK', primary: true, onClick: (close) => close(input.value) }],
  });
  setTimeout(() => {
    input.focus();
    input.select();
  }, 30);
  return m.promise;
}

// ---------- Formulaires génériques ----------

/**
 * Construit des champs à partir de définitions :
 *   { key, label, type: 'range'|'number'|'select'|'checkbox'|'color'|'text'|'textarea'|'segmented', min, max, step, unit, options }
 * `onChange(values, key)` est appelé à chaque modification.
 */
export function buildFields(fields, values, onChange) {
  const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const set = (k, v) => {
    values[k] = v;
    onChange?.(values, k);
  };
  for (const f of fields) {
    if (f.when && !f.when(values)) continue;
    const type = f.type || 'range';
    if (type === 'range') {
      const range = el('input', { type: 'range', min: f.min, max: f.max, step: f.step || 1, value: values[f.key] });
      const num = el('input', { type: 'number', class: 'num', min: f.min, max: f.max, step: f.step || 1, value: values[f.key] });
      range.addEventListener('input', () => {
        num.value = range.value;
        set(f.key, Number(range.value));
      });
      num.addEventListener('change', () => {
        const v = clamp(Number(num.value), f.min, f.max);
        num.value = range.value = v;
        set(f.key, v);
      });
      range.addEventListener('dblclick', () => {
        if (f.value == null) return;
        range.value = num.value = f.value;
        set(f.key, f.value);
      });
      wrap.append(el('div', { class: 'field' }, el('label', {}, f.label + (f.unit ? ` (${f.unit.trim()})` : '')), num, range));
    } else if (type === 'number') {
      const num = el('input', { type: 'number', min: f.min, max: f.max, step: f.step || 1, value: values[f.key] });
      num.addEventListener('input', () => set(f.key, Number(num.value)));
      wrap.append(el('div', { class: 'field' }, el('label', {}, f.label), num));
    } else if (type === 'select') {
      const sel = el('select', {}, ...f.options.map(([v, l]) => el('option', { value: v, selected: String(values[f.key]) === String(v) ? true : null }, l)));
      sel.addEventListener('change', () => set(f.key, sel.value));
      wrap.append(el('div', { class: 'field' }, el('label', {}, f.label), sel));
    } else if (type === 'checkbox') {
      const cb = el('input', { type: 'checkbox', checked: !!values[f.key] });
      cb.addEventListener('change', () => set(f.key, cb.checked));
      wrap.append(el('label', { class: 'check' }, cb, f.label));
    } else if (type === 'color') {
      const sw = el('button', { class: 'color-input', style: { background: values[f.key] } });
      sw.addEventListener('click', () => colorPicker(sw, values[f.key], (hex) => {
        sw.style.background = hex;
        set(f.key, hex);
      }));
      wrap.append(el('div', { class: 'field' }, el('label', {}, f.label), sw));
    } else if (type === 'text') {
      const inp = el('input', { type: 'text', value: values[f.key] ?? '' });
      inp.addEventListener('input', () => set(f.key, inp.value));
      wrap.append(el('div', { class: 'field full' }, el('label', {}, f.label), inp));
    } else if (type === 'textarea') {
      const ta = el('textarea', { rows: f.rows || 3 }, values[f.key] ?? '');
      ta.addEventListener('input', () => set(f.key, ta.value));
      wrap.append(el('div', { class: 'field full' }, el('label', {}, f.label), ta));
    } else if (type === 'segmented') {
      const seg = el('div', { class: 'seg' });
      for (const [v, l] of f.options) {
        const b = el('button', { class: String(values[f.key]) === String(v) ? 'on' : '' }, l);
        b.addEventListener('click', () => {
          [...seg.children].forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
          set(f.key, v);
        });
        seg.append(b);
      }
      wrap.append(el('div', { class: 'field' }, el('label', {}, f.label), seg));
    } else if (type === 'html') {
      wrap.append(f.render(values));
    }
  }
  return wrap;
}

// Fenêtre de formulaire ; `preview` active la fenêtre non bloquante pour voir l'image derrière.
export function formDialog({ title, fields, values, onChange, okLabel = 'OK', preview = false, wide = false, extra, left, rebuildOn = [] }) {
  const vals = { ...values };
  const holder = el('div');
  const rebuild = () => {
    holder.innerHTML = '';
    holder.append(buildFields(fields, vals, (v, k) => {
      onChange?.(v, k);
      if (rebuildOn.includes(k)) rebuild();
    }));
    if (extra) holder.append(extra(vals));
  };
  rebuild();
  return modal({
    title, body: holder, wide, preview, left,
    buttons: [{ label: 'Annuler', value: null }, { label: okLabel, primary: true, onClick: (close) => close(vals) }],
  }).promise;
}

// ---------- Sélecteur de couleur ----------

let pickerOpen = null;

export function colorPicker(anchor, initial, onChange, recent = window.__prismeRecent || []) {
  pickerOpen?.close();
  let { h, s, v } = rgbToHsv(...Object.values(hexToRgb(initial || '#ffffff')));
  const sv = el('div', { class: 'sv' });
  const svKnob = el('div', { class: 'knob' });
  sv.append(svKnob);
  const hue = el('div', { class: 'hue' });
  const hueKnob = el('div', { class: 'knob' });
  hue.append(hueKnob);
  const hex = el('input', { type: 'text', value: initial, style: { flex: 1 } });
  const prev = el('div', { class: 'prev' });
  const rgbInputs = ['R', 'V', 'B'].map(() => el('input', { type: 'number', min: 0, max: 255, style: { width: '58px' } }));
  const recents = el('div', { class: 'recents' });
  const eyedropBtn = 'EyeDropper' in window ? el('button', { class: 'btn small', title: 'Prélever à l\'écran' }, 'Pipette écran') : null;

  const update = (emit = true) => {
    const c = hsvToRgb(h, s, v);
    const hx = rgbToHex(c);
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h} 100% 50%))`;
    svKnob.style.left = `${s * 100}%`;
    svKnob.style.top = `${(1 - v) * 100}%`;
    hueKnob.style.left = `${(h / 360) * 100}%`;
    prev.style.background = hx;
    if (document.activeElement !== hex) hex.value = hx;
    rgbInputs.forEach((inp, i) => {
      if (document.activeElement !== inp) inp.value = Math.round([c.r, c.g, c.b][i]);
    });
    if (emit) onChange(hx);
  };
  const setFromHex = (hx) => {
    const c = hexToRgb(hx);
    ({ h, s, v } = rgbToHsv(c.r, c.g, c.b));
    update();
  };
  const drag = (elm, fn) => {
    elm.addEventListener('pointerdown', (e) => {
      elm.setPointerCapture(e.pointerId);
      fn(e);
      const mv = (ev) => fn(ev);
      const up = () => {
        elm.removeEventListener('pointermove', mv);
        elm.removeEventListener('pointerup', up);
      };
      elm.addEventListener('pointermove', mv);
      elm.addEventListener('pointerup', up);
    });
  };
  drag(sv, (e) => {
    const r = sv.getBoundingClientRect();
    s = clamp((e.clientX - r.left) / r.width, 0, 1);
    v = 1 - clamp((e.clientY - r.top) / r.height, 0, 1);
    update();
  });
  drag(hue, (e) => {
    const r = hue.getBoundingClientRect();
    h = clamp((e.clientX - r.left) / r.width, 0, 0.9999) * 360;
    update();
  });
  hex.addEventListener('change', () => /^#?[0-9a-f]{3,6}$/i.test(hex.value.trim()) && setFromHex(hex.value.trim().startsWith('#') ? hex.value.trim() : `#${hex.value.trim()}`));
  rgbInputs.forEach((inp) => inp.addEventListener('change', () => {
    const [r, g, b] = rgbInputs.map((i) => clamp(Number(i.value) || 0, 0, 255));
    ({ h, s, v } = rgbToHsv(r, g, b));
    update();
  }));
  const swatchColors = [...new Set([...recent, '#000000', '#ffffff', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#5856d6', '#af52de', '#ff2d55', '#a2845e', '#8e8e93', '#3db5ff', '#7b5cff', '#f455d8'])].slice(0, 16);
  for (const c of swatchColors) recents.append(el('button', { style: { background: c }, title: c, onclick: () => setFromHex(c) }));
  if (eyedropBtn) {
    eyedropBtn.addEventListener('click', async () => {
      try {
        const r = await new window.EyeDropper().open();
        setFromHex(r.sRGBHex);
      } catch {
        /* annulé */
      }
    });
  }
  const body = el('div', { class: 'picker' }, sv, hue,
    el('div', { class: 'row' }, prev, hex),
    el('div', { class: 'row' }, ...rgbInputs.flatMap((inp, i) => [el('span', { style: { color: 'var(--muted)' } }, ['R', 'V', 'B'][i]), inp])),
    recents, eyedropBtn);
  const box = el('div', { class: 'dropdown', style: { minWidth: '0' } }, body);
  overlays().append(box);
  let back = null;
  if (isMobileLayout()) {
    back = el('div', { class: 'modal-back', style: { zIndex: 59 } });
    overlays().insertBefore(back, box);
    body.style.width = '100%';
  } else {
    const r = anchor.getBoundingClientRect();
    box.style.left = `${Math.min(r.left, innerWidth - 300)}px`;
    box.style.top = `${Math.min(r.bottom + 6, innerHeight - 420)}px`;
  }
  update(false);
  const close = () => {
    box.remove();
    back?.remove();
    document.removeEventListener('pointerdown', away, true);
    pickerOpen = null;
  };
  const away = (e) => {
    if (!box.contains(e.target) && e.target !== anchor) close();
  };
  setTimeout(() => document.addEventListener('pointerdown', away, true));
  pickerOpen = { close };
  return pickerOpen;
}

// ---------- Fenêtre de texte ----------

export function textDialog(meta, title, onPreview) {
  const vals = { ...meta };
  const fields = [
    { key: 'text', label: 'Texte', type: 'textarea', rows: 3 },
    { key: 'font', label: 'Police', type: 'select', options: FONTS.map((f) => [f, fontLabel(f)]) },
    { key: 'size', label: 'Taille', type: 'range', min: 6, max: 600, unit: 'px' },
    { key: 'color', label: 'Couleur', type: 'color' },
    { key: 'align', label: 'Alignement', type: 'segmented', options: [['left', 'Gauche'], ['center', 'Centre'], ['right', 'Droite']] },
    { key: 'bold', label: 'Gras', type: 'checkbox' },
    { key: 'italic', label: 'Italique', type: 'checkbox' },
    { key: 'uppercase', label: 'Majuscules', type: 'checkbox' },
    { key: 'lineHeight', label: 'Interligne', type: 'range', min: 0.6, max: 3, step: 0.05 },
    { key: 'letterSpacing', label: 'Espacement', type: 'range', min: -20, max: 100, unit: 'px' },
    { key: 'rotation', label: 'Rotation', type: 'range', min: -180, max: 180, unit: '°' },
    { key: 'opacity', label: 'Opacité', type: 'range', min: 0.05, max: 1, step: 0.05 },
    { key: 'strokeWidth', label: 'Contour', type: 'range', min: 0, max: 40, unit: 'px' },
    { key: 'strokeColor', label: 'Couleur du contour', type: 'color', when: (v) => v.strokeWidth > 0 },
    { key: 'shadow', label: 'Ombre portée', type: 'checkbox' },
    { key: 'shadowColor', label: 'Couleur de l\'ombre', type: 'color', when: (v) => v.shadow },
    { key: 'shadowBlur', label: 'Flou de l\'ombre', type: 'range', min: 0, max: 80, when: (v) => v.shadow },
    { key: 'shadowOpacity', label: 'Opacité de l\'ombre', type: 'range', min: 0, max: 1, step: 0.05, when: (v) => v.shadow },
    { key: 'background', label: 'Fond (étiquette)', type: 'checkbox' },
    { key: 'bgColor', label: 'Couleur du fond', type: 'color', when: (v) => v.background },
    { key: 'bgOpacity', label: 'Opacité du fond', type: 'range', min: 0, max: 1, step: 0.05, when: (v) => v.background },
    { key: 'bgPadding', label: 'Marge', type: 'range', min: 0, max: 120, when: (v) => v.background },
  ];
  const holder = el('div');
  const rebuild = () => {
    holder.innerHTML = '';
    holder.append(buildFields(fields, vals, (v, k) => {
      onPreview?.(v);
      if (['strokeWidth', 'shadow', 'background'].includes(k)) {
        const focused = document.activeElement;
        if (!(focused && focused.tagName === 'TEXTAREA')) rebuild();
      }
    }));
  };
  rebuild();
  setTimeout(() => holder.querySelector('textarea')?.focus(), 50);
  return modal({
    title, body: holder,
    buttons: [{ label: 'Annuler', value: null }, { label: 'Valider', primary: true, onClick: (close) => close({ ...vals }) }],
  }).promise;
}
