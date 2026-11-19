// Prisme Motion — éditeurs de propriétés partagés par la timeline et le panneau Propriétés :
// valeurs numériques « glissables » (comme dans After Effects), vecteurs, couleurs, listes,
// chronomètre d'animation, navigation entre images clés et expressions.

import { el } from '../util.js';
import { icon } from '../icons.js';
import { colorPicker } from '../ui.js';
import * as M from './model.js';

export function propKey(item) {
  if (!item.owner) return item.key;
  return item.owner.type ? `fx.${item.owner.id}.${item.def.key}` : `mk.${item.owner.id}.${item.def.key}`;
}

const decimals = (step) => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
export const fmt = (v, step = 1) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const d = decimals(step);
  return v.toFixed(d).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

// Nombre réglable par glissement horizontal ; clic simple = saisie au clavier.
export function scrubber({ get, set, begin, end, commit, step = 1, min = -Infinity, max = Infinity, unit = '', title = '' }) {
  const span = el('span', { class: 'scrub', title: title || 'Glisser pour régler · clic pour saisir · Maj = ×10 · Alt = fin' });
  const show = () => {
    span.textContent = `${fmt(get(), step)}${unit}`;
  };
  show();
  let start = null;
  span.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    span.setPointerCapture(e.pointerId);
    start = { x: e.clientX, v: get(), moved: false };
  });
  span.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    if (!start.moved && Math.abs(dx) < 3) return;
    if (!start.moved) {
      start.moved = true;
      begin?.();
      document.body.classList.add('scrubbing');
    }
    const mul = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
    const v = M.clamp(start.v + dx * step * mul, min, max);
    set(Math.round(v / (step * (e.altKey ? 0.1 : 1))) * (step * (e.altKey ? 0.1 : 1)));
    show();
  });
  const up = () => {
    if (!start) return;
    const moved = start.moved;
    start = null;
    document.body.classList.remove('scrubbing');
    if (moved) {
      end?.();
      return;
    }
    // Saisie au clavier
    const input = el('input', { class: 'scrub-input', type: 'text', value: fmt(get(), step), inputmode: 'decimal' });
    span.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (ok) {
        const raw = input.value.replace(',', '.').trim();
        let v;
        try {
          v = /^[-+*/().\d\s]+$/.test(raw) ? Function(`return (${raw})`)() : Number(raw);
        } catch {
          v = NaN;
        }
        if (Number.isFinite(v)) commit(M.clamp(v, min, max));
      }
      input.replaceWith(span);
      show();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  };
  span.addEventListener('pointerup', up);
  span.addEventListener('pointercancel', up);
  span.refresh = show;
  return span;
}

// Éditeur d'une propriété d'un calque. Renvoie { el, refresh }.
export function propEditor(core, layer, item, { compact = false } = {}) {
  const def = item.def || item;
  const prop = M.propOf(layer, item);
  const key = propKey(item);
  const value = () => core.engine.pv(core.comp, layer, key, core.time, prop);
  const label = def.label;
  const write = (v) => M.setPropValue(prop, core.time, v);
  const wrap = el('div', { class: 'pv' });
  const refreshers = [];
  const type = def.type;
  if (type === 'num' || type === 'angle') {
    const s = scrubber({
      get: () => value(), step: def.step || 1, min: def.min ?? -Infinity, max: def.max ?? Infinity, unit: def.unit === '%' ? ' %' : def.unit === '°' ? '°' : def.unit ? ` ${def.unit}` : '',
      begin: () => core.beginDrag(), set: (v) => {
        write(v);
        core.live();
      }, end: () => core.endDrag(label), commit: (v) => core.change(label, () => write(v)),
    });
    wrap.append(s);
    refreshers.push(s.refresh);
  } else if (type === 'vec2' || type === 'vec4') {
    const n = type === 'vec2' ? 2 : 4;
    let linked = def.link ? layer.__unlink?.[key] !== true : false;
    for (let i = 0; i < n; i++) {
      const s = scrubber({
        get: () => value()?.[i] ?? 0, step: def.step || 1, min: def.min ?? -Infinity, max: def.max ?? Infinity, unit: def.unit === '%' ? ' %' : '',
        begin: () => core.beginDrag(),
        set: (v) => {
          const cur = M.clone(value());
          if (linked && n === 2) {
            const r = cur[i] ? v / cur[i] : 1;
            cur[1 - i] = cur[i] ? cur[1 - i] * r : v;
          }
          cur[i] = v;
          write(cur);
          core.live();
          refreshers.forEach((f) => f());
        },
        end: () => core.endDrag(label),
        commit: (v) => core.change(label, () => {
          const cur = M.clone(value());
          if (linked && n === 2 && cur[i]) cur[1 - i] *= v / cur[i];
          cur[i] = v;
          write(cur);
        }),
      });
      wrap.append(s);
      refreshers.push(s.refresh);
    }
    if (def.link) {
      const b = el('button', { class: `mini-btn${linked ? ' on' : ''}`, title: 'Conserver les proportions', html: icon('link', 13) });
      b.onclick = () => {
        linked = !linked;
        layer.__unlink ||= {};
        layer.__unlink[key] = !linked;
        b.classList.toggle('on', linked);
      };
      wrap.prepend(b);
    }
  } else if (type === 'color') {
    const sw = el('button', { class: 'color-input small', title: label });
    const show = () => (sw.style.background = value());
    show();
    sw.onclick = (e) => {
      e.stopPropagation();
      core.beginDrag();
      colorPicker(sw, value(), (hex) => {
        write(hex);
        sw.style.background = hex;
        core.live();
        clearTimeout(sw.__t);
        sw.__t = setTimeout(() => core.endDrag(label), 400);
      });
    };
    wrap.append(sw);
    refreshers.push(show);
  } else if (type === 'select') {
    const s = el('select', { class: 'mini-select' }, ...def.options.map(([v, l]) => el('option', { value: v }, l)));
    s.value = String(prop.v);
    s.onchange = () => core.change(label, () => (prop.v = s.value));
    s.addEventListener('keydown', (e) => e.stopPropagation());
    wrap.append(s);
    refreshers.push(() => (s.value = String(prop.v)));
  } else if (type === 'bool') {
    const c = el('input', { type: 'checkbox', checked: !!prop.v });
    c.onchange = () => core.change(label, () => (prop.v = c.checked));
    wrap.append(c);
    refreshers.push(() => (c.checked = !!prop.v));
  } else if (type === 'text') {
    if (compact) {
      const b = el('button', { class: 'btn small' }, 'Modifier le texte…');
      b.onclick = () => core.emit('edit-text', layer);
      wrap.append(b);
    } else {
      const ta = el('textarea', { rows: 2, class: 'pv-text' }, prop.v);
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      ta.addEventListener('input', () => {
        core.beginDrag();
        prop.v = ta.value;
        core.live();
      });
      ta.addEventListener('change', () => core.endDrag('Texte'));
      wrap.append(ta);
      refreshers.push(() => document.activeElement !== ta && (ta.value = prop.v));
    }
  }
  return { el: wrap, refresh: () => refreshers.forEach((f) => f()), prop, key };
}

// Chronomètre + navigation ◀ ◆ ▶ pour une propriété animable.
export function keyControls(core, layer, item) {
  const prop = M.propOf(layer, item);
  const def = item.def || item;
  const animatable = !['select', 'bool', 'text'].includes(def.type);
  const box = el('span', { class: 'kc' });
  if (!animatable) {
    box.append(el('span', { class: 'kc-sp' }));
    return { el: box, refresh() {} };
  }
  const sw = el('button', { class: 'kc-sw', title: 'Activer / désactiver l’animation (chronomètre)', html: icon('stopwatch', 14) });
  sw.onclick = (e) => {
    e.stopPropagation();
    core.change(prop.k?.length ? 'Animation désactivée' : 'Animation activée', () => M.toggleStopwatch(prop, core.time));
  };
  const prev = el('button', { class: 'kc-nav', title: 'Image clé précédente', html: icon('step-back', 12) });
  const add = el('button', { class: 'kc-add', title: 'Ajouter / supprimer une image clé ici', html: icon('key', 11) });
  const next = el('button', { class: 'kc-nav', title: 'Image clé suivante', html: icon('step-fwd', 12) });
  prev.onclick = (e) => {
    e.stopPropagation();
    const k = [...(prop.k || [])].reverse().find((x) => x.t < core.time - 1e-4);
    if (k) core.setTime(k.t);
  };
  next.onclick = (e) => {
    e.stopPropagation();
    const k = (prop.k || []).find((x) => x.t > core.time + 1e-4);
    if (k) core.setTime(k.t);
  };
  add.onclick = (e) => {
    e.stopPropagation();
    const ex = M.keyAt(prop, core.time);
    core.change(ex ? 'Image clé supprimée' : 'Image clé ajoutée', () => {
      if (ex) M.removeKey(prop, ex);
      else M.setKey(prop, core.time, core.engine.pv(core.comp, layer, propKey(item), core.time, prop));
    });
  };
  const refresh = () => {
    const on = !!prop.k?.length;
    sw.classList.toggle('on', on);
    prev.style.visibility = next.style.visibility = add.style.visibility = on ? 'visible' : 'hidden';
    add.classList.toggle('on', !!M.keyAt(prop, core.time));
    sw.classList.toggle('expr', !!prop.x);
  };
  refresh();
  box.append(sw, prev, add, next);
  return { el: box, refresh };
}

// Champ d'expression (affiché quand une expression existe ou sur demande).
export function exprEditor(core, layer, item) {
  const prop = M.propOf(layer, item);
  const ta = el('textarea', { class: 'expr', rows: 1, spellcheck: 'false', placeholder: 'Expression JavaScript : wiggle(2, 30), time * 90, loopOut(), value…' }, prop.x || '');
  const err = el('div', { class: 'expr-err' });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ta.blur();
    }
  });
  ta.addEventListener('change', () => {
    const v = ta.value.trim();
    core.change(v ? 'Expression' : 'Expression supprimée', () => {
      if (v) prop.x = v;
      else delete prop.x;
    });
  });
  const refresh = () => {
    const e = M.expressionError(prop);
    err.textContent = e ? `⚠ ${e}` : '';
  };
  refresh();
  return { el: el('div', { class: 'expr-box' }, ta, err), refresh };
}
