// Prisme Motion — modèles de compositions prêts à l'emploi.

import * as M from './model.js';

const key = (p, t, v, e = 'ease') => M.setKey(p, t, v, e);

function bgLayer(comp, c1, c2) {
  const bg = M.makeLayer(comp, 'solid', { name: 'Fond', content: { color: c1 } });
  const ramp = M.makeEffect('ramp');
  ramp.p.type.v = 'radial';
  ramp.p.start.v = [50, 45];
  ramp.p.end.v = [110, 110];
  ramp.p.c1.v = c1;
  ramp.p.c2.v = c2;
  const vig = M.makeEffect('vignette');
  bg.effects.push(ramp, vig);
  bg.locked = true;
  return bg;
}

export const TEMPLATES = [
  {
    id: 'title', name: 'Titre animé', desc: 'Titre cinématique, lettres qui montent, particules et lueur',
    build() {
      const comp = M.makeComp({ name: 'Titre animé', duration: 6 });
      const W = comp.width, H = comp.height;
      const bg = bgLayer(comp, '#2a1a5e', '#06040f');
      const parts = M.makeLayer(comp, 'particles', { name: 'Poussière lumineuse' });
      Object.assign(parts.p['c.emitter'], { v: [W / 2, H * 0.62] });
      parts.p['c.emitSize'].v = [W * 0.9, 60];
      parts.p['c.rate'].v = 90;
      parts.p['c.speed'].v = 60;
      parts.p['c.gravity'].v = -25;
      parts.p['c.spread'].v = 120;
      parts.p['c.life'].v = 4;
      parts.p['c.sizeStart'].v = 7;
      parts.p['c.sizeEnd'].v = 1;
      const glowP = M.makeEffect('glow');
      glowP.p.threshold.v = 20;
      glowP.p.radius.v = 18;
      parts.effects.push(glowP);
      const title = M.makeLayer(comp, 'text', { name: 'Titre', content: { text: 'PRISME MOTION', fontSize: 150, weight: '900', tracking: 80, animator: 'rise', reveal: 0, spread: 40 } });
      title.p.position.v = [W / 2, H * 0.46];
      key(title.p['c.reveal'], 0.3, 0, 'easeOut');
      key(title.p['c.reveal'], 1.8, 100);
      key(title.p['c.tracking'], 0.3, 260, 'expo');
      key(title.p['c.tracking'], 5.5, 60);
      const g = M.makeEffect('glow');
      g.p.threshold.v = 60;
      g.p.radius.v = 40;
      g.p.intensity.v = 1.2;
      title.effects.push(g);
      title.motionBlur = true;
      const sub = M.makeLayer(comp, 'text', { name: 'Sous-titre', content: { text: 'Animation · Composition · Effets', fontSize: 46, weight: '400', tracking: 160, fill: '#c9bfff', animator: 'type', reveal: 0 } });
      sub.p.position.v = [W / 2, H * 0.58];
      key(sub.p['c.reveal'], 1.6, 0, 'linear');
      key(sub.p['c.reveal'], 3, 100);
      const line = M.makeLayer(comp, 'shape', { name: 'Ligne', content: { shape: 'line', size: [760, 0], fillOn: false, strokeOn: true, stroke: '#f455d8', strokeWidth: 4, trimEnd: 0 } });
      line.p.position.v = [W / 2, H * 0.53];
      key(line.p['c.trimStart'], 1.2, 50, 'expo');
      key(line.p['c.trimStart'], 2.4, 0);
      key(line.p['c.trimEnd'], 1.2, 50, 'expo');
      key(line.p['c.trimEnd'], 2.4, 100);
      for (const l of [title, sub, line]) {
        key(l.p.opacity, 5.2, 100);
        key(l.p.opacity, 5.9, 0);
      }
      comp.layers.push(title, sub, line, parts, bg);
      return comp;
    },
  },
  {
    id: 'lower', name: 'Bandeau (lower third)', desc: 'Nom et fonction pour interview ou vlog',
    build() {
      const comp = M.makeComp({ name: 'Lower third', duration: 6, bg: '#101018' });
      const W = comp.width, H = comp.height;
      const bar = M.makeLayer(comp, 'shape', { name: 'Barre', content: { shape: 'rect', size: [720, 120], roundness: 14, fill: '#7b5cff' } });
      bar.p.anchor.v = [-360, 0];
      bar.p.position.v = [140, H - 200];
      key(bar.p.scale, 0.2, [0, 100], 'expo');
      key(bar.p.scale, 0.9, [100, 100]);
      key(bar.p.scale, 5, [100, 100], 'easeIn');
      key(bar.p.scale, 5.6, [0, 100]);
      const accent = M.makeLayer(comp, 'shape', { name: 'Accent', content: { shape: 'rect', size: [12, 120], fill: '#ff9d3d' } });
      accent.p.position.v = [134, H - 200];
      const name = M.makeLayer(comp, 'text', { name: 'Nom', content: { text: 'Camille Martin', fontSize: 56, align: 'left', weight: '700' } });
      name.p.position.v = [176, H - 222];
      const role = M.makeLayer(comp, 'text', { name: 'Fonction', content: { text: 'Réalisatrice · SuperEssence Studio', fontSize: 30, align: 'left', weight: '400', fill: '#e6e0ff' } });
      role.p.position.v = [178, H - 168];
      for (const [l, d] of [[name, 0.5], [role, 0.7]]) {
        key(l.p.position, d, [l.p.position.v[0] - 60, l.p.position.v[1]], 'expo');
        key(l.p.position, d + 0.7, l.p.position.v);
        key(l.p.opacity, d, 0);
        key(l.p.opacity, d + 0.5, 100);
        key(l.p.opacity, 4.9, 100);
        key(l.p.opacity, 5.3, 0);
      }
      bar.matte = '';
      comp.layers.push(name, role, accent, bar);
      void W;
      return comp;
    },
  },
  {
    id: 'logo', name: 'Révélation de logo', desc: 'Étoile, éclat de particules et ouverture en iris',
    build() {
      const comp = M.makeComp({ name: 'Logo reveal', duration: 5 });
      const W = comp.width, H = comp.height;
      const bg = bgLayer(comp, '#0d2a4a', '#02050c');
      const burst = M.makeLayer(comp, 'particles', { name: 'Éclat', out: 2.5 });
      Object.assign(burst.p['c.emitter'], { v: [W / 2, H / 2] });
      burst.p['c.emitSize'].v = [10, 10];
      burst.p['c.spread'].v = 360;
      burst.p['c.speed'].v = 700;
      burst.p['c.gravity'].v = 0;
      burst.p['c.rate'].v = 0;
      key(burst.p['c.rate'], 0.55, 0, 'hold');
      key(burst.p['c.rate'], 0.6, 1500, 'hold');
      key(burst.p['c.rate'], 0.75, 0, 'hold');
      burst.p['c.life'].v = 1.2;
      burst.p['c.colorStart'].v = '#9fe8ff';
      burst.p['c.colorEnd'].v = '#7b5cff';
      const logo = M.makeLayer(comp, 'shape', { name: 'Logo', content: { shape: 'star', size: [380, 380], points: 6, innerRatio: 50, fill: '#3db5ff', strokeOn: true, stroke: '#ffffff', strokeWidth: 6 } });
      key(logo.p.scale, 0.4, [0, 0], 'back');
      key(logo.p.scale, 1.1, [100, 100]);
      key(logo.p.rotation, 0.4, -120, 'expo');
      key(logo.p.rotation, 1.4, 0);
      logo.motionBlur = true;
      const g = M.makeEffect('glow');
      g.p.radius.v = 50;
      logo.effects.push(g);
      const iris = M.makeEffect('iris');
      key(iris.p.completion, 0.3, 100, 'expo');
      key(iris.p.completion, 1.2, 0);
      const name = M.makeLayer(comp, 'text', { name: 'Marque', content: { text: 'SUPERESSENCE', fontSize: 90, weight: '900', tracking: 220, animator: 'fade', reveal: 0 } });
      name.p.position.v = [W / 2, H / 2 + 300];
      key(name.p['c.reveal'], 1.2, 0, 'easeOut');
      key(name.p['c.reveal'], 2.4, 100);
      bg.effects.push(iris);
      comp.layers.push(name, logo, burst, bg);
      return comp;
    },
  },
  {
    id: 'story', name: 'Story / Reel vertical', desc: '1080×1920 : formes, titre pop et dégradé animé',
    build() {
      const comp = M.makeComp({ name: 'Story', width: 1080, height: 1920, duration: 7 });
      const W = comp.width, H = comp.height;
      const bg = M.makeLayer(comp, 'solid', { name: 'Fond', content: { color: '#ff3b6b' } });
      const ramp = M.makeEffect('ramp');
      ramp.p.c1.v = '#ff9d3d';
      ramp.p.c2.v = '#7b5cff';
      key(ramp.p.start, 0, [0, 0], 'linear');
      key(ramp.p.start, 7, [100, 30]);
      bg.effects.push(ramp);
      const circle = M.makeLayer(comp, 'shape', { name: 'Cercles', content: { shape: 'ellipse', size: [260, 260], fillOn: false, strokeOn: true, stroke: '#ffffff', strokeWidth: 10, copies: 6, repScale: 130, repFade: 0 } });
      circle.p.position.v = [W / 2, H * 0.4];
      circle.p.rotation.x = 'time * 20';
      key(circle.p['c.trimEnd'], 0, 0, 'expo');
      key(circle.p['c.trimEnd'], 1.5, 100);
      const title = M.makeLayer(comp, 'text', { name: 'Titre', content: { text: 'NOUVEAU\nDROP', fontSize: 190, weight: '900', animator: 'pop', reveal: 0, leading: 1 } });
      title.p.position.v = [W / 2, H * 0.4];
      key(title.p['c.reveal'], 0.6, 0, 'linear');
      key(title.p['c.reveal'], 1.4, 100);
      const sh = M.makeEffect('shadow');
      sh.p.distance.v = 16;
      sh.p.opacity.v = 45;
      title.effects.push(sh);
      const cta = M.makeLayer(comp, 'shape', { name: 'Bouton', content: { shape: 'rect', size: [620, 140], roundness: 70, fill: '#ffffff' } });
      cta.p.position.v = [W / 2, H * 0.78];
      const ctaT = M.makeLayer(comp, 'text', { name: 'Texte du bouton', content: { text: 'Découvrir →', fontSize: 64, fill: '#7b5cff' } });
      ctaT.p.position.v = [W / 2, H * 0.78];
      ctaT.parent = cta.id;
      ctaT.p.position.v = [0, 0];
      key(cta.p.scale, 2, [0, 0], 'back');
      key(cta.p.scale, 2.6, [100, 100]);
      cta.p.rotation.x = 'value + 3 * Math.sin(time * 6)';
      comp.layers.push(ctaT, cta, title, circle, bg);
      return comp;
    },
  },
];
