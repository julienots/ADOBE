// Prisme Motion — file de rendu : export vidéo MP4 / MOV / WebM (avec audio), WebM transparent,
// GIF animé et image PNG. L'encodage utilise WebCodecs (accélération matérielle quand elle existe)
// et se fait plus vite que le temps réel : chaque image est rendue par le GPU puis encodée aussitôt.

import { el } from '../util.js';
import { modal, formDialog, toast } from '../ui.js';
import { saveBlob } from '../io.js';
import { mediabunny, mixdown } from './media.js';
import { timecode } from './model.js';

const FORMATS = [
  ['mp4', 'MP4 (H.264 / HEVC) — universel'],
  ['mov', 'QuickTime MOV'],
  ['webm', 'WebM (VP9)'],
  ['webm-alpha', 'WebM avec transparence (VP9 alpha)'],
  ['gif', 'GIF animé'],
  ['png', 'Image PNG (image courante)'],
];

export async function exportDialog(mapp) {
  const core = mapp.core;
  const c = core.comp;
  core.pause();
  const vals = await formDialog({
    title: `Exporter « ${c.name} »`,
    okLabel: 'Lancer le rendu',
    rebuildOn: ['format'],
    fields: [
      { key: 'format', label: 'Format', type: 'select', options: FORMATS },
      { key: 'scale', label: 'Résolution', type: 'select', options: [['1', `Pleine (${c.width}×${c.height})`], ['0.75', '75 %'], ['0.5', `Moitié (${Math.round(c.width / 2)}×${Math.round(c.height / 2)})`], ['0.25', 'Quart'], ['2', 'Double (suréchantillonnage)']], when: (v) => v.format !== 'gif' },
      { key: 'gifW', label: 'Largeur du GIF (px)', type: 'select', options: [['320', '320'], ['480', '480'], ['640', '640'], ['800', '800']], when: (v) => v.format === 'gif' },
      { key: 'fps', label: 'Images par seconde', type: 'select', options: [...new Set([c.fps, 12, 15, 24, 25, 30, 50, 60])].map((f) => [String(f), `${f} i/s${f === c.fps ? ' (composition)' : ''}`]), when: (v) => v.format !== 'png' },
      { key: 'quality', label: 'Qualité', type: 'select', options: [['medium', 'Standard'], ['high', 'Haute'], ['veryhigh', 'Très haute'], ['low', 'Légère (petit fichier)']], when: (v) => !['png', 'gif'].includes(v.format) },
      { key: 'range', label: 'Durée', type: 'select', options: [['work', `Zone de travail (${timecode(c.workIn, c.fps)} → ${timecode(c.workOut, c.fps)})`], ['comp', `Composition entière (${c.duration.toFixed(2)} s)`]], when: (v) => v.format !== 'png' },
      { key: 'audio', label: 'Inclure le son', type: 'checkbox', when: (v) => ['mp4', 'mov', 'webm', 'webm-alpha'].includes(v.format) },
      { key: 'mb', label: 'Flou de mouvement', type: 'checkbox', when: (v) => v.format !== 'png' },
      { key: 'name', label: 'Nom du fichier', type: 'text' },
    ],
    values: { format: 'mp4', scale: '1', gifW: '480', fps: String(c.fps), quality: 'high', range: 'work', audio: true, mb: true, name: c.name.replace(/[\\/:*?"<>|]+/g, '_') },
  });
  if (!vals) return;
  if (vals.format === 'png') return exportPNG(mapp, vals);
  return renderMovie(mapp, vals);
}

export function exportFrame(mapp) {
  const c = mapp.core.comp;
  return exportPNG(mapp, { scale: '1', name: `${c.name} ${timecode(mapp.core.time, c.fps).replace(/:/g, '-')}` });
}

async function exportPNG(mapp, vals) {
  const core = mapp.core;
  await waitIdle(core);
  core.exporting = true;
  try {
    const canvas = await core.engine.renderFrame(core.comp, core.time, { scale: Number(vals.scale), bg: !core.transparent });
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    await saveBlob(blob, `${vals.name || 'image'}.png`);
  } finally {
    core.exporting = false;
    core.invalidate();
  }
}

async function waitIdle(core) {
  core.pause();
  while (core.rendering) await new Promise((r) => setTimeout(r, 10));
}

const even = (x) => Math.max(2, Math.round(x / 2) * 2);

async function renderMovie(mapp, vals) {
  const core = mapp.core;
  const c = core.comp;
  const eng = core.engine;
  const fps = Number(vals.fps);
  const t0 = vals.range === 'comp' ? 0 : c.workIn;
  const t1 = vals.range === 'comp' ? c.duration : c.workOut;
  const n = Math.max(1, Math.round((t1 - t0) * fps));
  const isGif = vals.format === 'gif';
  const scale = isGif ? Number(vals.gifW) / c.width : Number(vals.scale);
  const W = isGif ? Math.round(c.width * scale) : even(c.width * scale), H = isGif ? Math.round(c.height * scale) : even(c.height * scale);
  const alpha = vals.format === 'webm-alpha' || (isGif && core.transparent);

  // Fenêtre de progression
  const bar = el('div', { class: 'mx-progress' }, el('i'));
  const stats = el('div', { class: 'mx-stats' }, 'Préparation…');
  const preview = el('canvas', { class: 'mx-preview', width: 320, height: Math.round((320 * H) / W) });
  let cancelled = false;
  const m = modal({ title: `Rendu — ${vals.name}`, body: el('div', { class: 'mx-box' }, preview, bar, stats), buttons: [{ label: 'Annuler', onClick: () => (cancelled = true) }] });
  m.back.addEventListener('pointerdown', (e) => e.stopPropagation(), true);

  await waitIdle(core);
  core.exporting = true;
  eng.mbEnabled = !!vals.mb;
  const start = performance.now();
  const pctx = preview.getContext('2d');
  const report = (i) => {
    const el2 = (performance.now() - start) / 1000;
    const rate = i / Math.max(0.001, el2);
    bar.firstChild.style.width = `${(i / n) * 100}%`;
    stats.textContent = `Image ${i} / ${n} · ${rate.toFixed(1)} i/s (${(rate / fps).toFixed(2)}× temps réel) · reste ≈ ${Math.max(0, (n - i) / Math.max(rate, 0.01)).toFixed(0)} s · ${W}×${H}`;
    pctx.drawImage(eng.canvas, 0, 0, preview.width, preview.height);
  };
  try {
    if (isGif) {
      const blob = await renderGif(core, { t0, n, fps, scale, W, H, alpha, report, cancelled: () => cancelled });
      if (blob) await saveBlob(blob, `${vals.name || 'animation'}.gif`);
    } else {
      const MB = await mediabunny();
      const fmt = vals.format === 'mov' ? new MB.MovOutputFormat({ fastStart: 'in-memory' }) : vals.format === 'mp4' ? new MB.Mp4OutputFormat({ fastStart: 'in-memory' }) : new MB.WebMOutputFormat();
      const target = new MB.BufferTarget();
      const output = new MB.Output({ format: fmt, target });
      const quality = { low: MB.QUALITY_LOW, medium: MB.QUALITY_MEDIUM, high: MB.QUALITY_HIGH, veryhigh: MB.QUALITY_VERY_HIGH }[vals.quality] || MB.QUALITY_HIGH;
      const pref = alpha ? ['vp9'] : vals.format.startsWith('webm') ? ['vp9', 'av1', 'vp8'] : ['avc', 'hevc', 'av1', 'vp9'];
      const supported = fmt.getSupportedVideoCodecs();
      const codec = await MB.getFirstEncodableVideoCodec(pref.filter((x) => supported.includes(x)), { width: W, height: H, quality, frameRate: fps });
      if (!codec) throw new Error('Aucun encodeur vidéo disponible sur cet appareil pour ce format. Essayez WebM ou une résolution plus petite.');
      const video = new MB.CanvasSource(eng.canvas, { codec, quality, alpha: alpha ? 'keep' : 'discard', keyFrameInterval: 2, latencyMode: 'quality' });
      output.addVideoTrack(video, { frameRate: fps });
      let audio = null, audioBuf = null;
      if (vals.audio) {
        stats.textContent = 'Mixage audio…';
        audioBuf = await mixdown(core.project, c, t0, t1);
        if (audioBuf) {
          const asup = fmt.getSupportedAudioCodecs();
          const acodec = await MB.getFirstEncodableAudioCodec(['aac', 'opus', 'mp3', 'vorbis', 'pcm-s16'].filter((x) => asup.includes(x)), { numberOfChannels: 2, sampleRate: audioBuf.sampleRate });
          if (acodec) {
            audio = new MB.AudioBufferSource({ codec: acodec, quality });
            output.addAudioTrack(audio);
          } else toast('Pas d’encodeur audio : vidéo exportée sans le son', 3000);
        }
      }
      await output.start();
      for (let i = 0; i < n; i++) {
        if (cancelled) break;
        await eng.renderFrame(c, t0 + i / fps, { scale, bg: !alpha, size: [W, H] });
        await video.add(i / fps, 1 / fps);
        if (i % 3 === 0 || i === n - 1) report(i + 1);
      }
      if (cancelled) {
        await output.cancel();
      } else {
        if (audio && audioBuf) {
          stats.textContent = 'Encodage du son…';
          await audio.add(audioBuf);
        }
        stats.textContent = 'Finalisation du fichier…';
        await output.finalize();
        const blob = new Blob([target.buffer], { type: fmt.mimeType });
        const secs = ((performance.now() - start) / 1000).toFixed(1);
        await saveBlob(blob, `${vals.name || 'video'}${fmt.fileExtension}`);
        toast(`Rendu terminé en ${secs} s · ${codec.toUpperCase()} · ${(blob.size / 1048576).toFixed(1)} Mo`, 4000);
      }
    }
  } catch (e) {
    console.error(e);
    toast(`Échec du rendu : ${e.message}`, 5000);
  } finally {
    core.exporting = false;
    eng.mbEnabled = true;
    m.close();
    core.invalidate();
  }
}

// ---------- GIF animé (palette fixe 6×7×6 + tramage ordonné, compression LZW) ----------

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v / 16 - 0.5));

function gifPalette() {
  const pal = [];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let b = 0; b < 6; b++) pal.push([Math.round((r * 255) / 5), Math.round((g * 255) / 6), Math.round((b * 255) / 5)]);
  while (pal.length < 255) pal.push([0, 0, 0]);
  pal.push([0, 0, 0]); // 255 : transparent
  return pal;
}

function quantize(data, w, h, alpha) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      if (alpha && data[p + 3] < 128) {
        out[i] = 255;
        continue;
      }
      const d = BAYER[(y & 3) * 4 + (x & 3)];
      const r = Math.min(5, Math.max(0, Math.round((data[p] / 255) * 5 + d)));
      const g = Math.min(6, Math.max(0, Math.round((data[p + 1] / 255) * 6 + d)));
      const b = Math.min(5, Math.max(0, Math.round((data[p + 2] / 255) * 5 + d)));
      out[i] = r * 42 + g * 6 + b;
    }
  }
  return out;
}

function lzw(indices, minCode = 8) {
  const out = [];
  let cur = 0, bits = 0;
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, next = eoi + 1;
  let dict = new Map();
  const emit = (code) => {
    cur |= code << bits;
    bits += size;
    while (bits >= 8) {
      out.push(cur & 255);
      cur >>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const c = dict.get(key);
    if (c !== undefined) {
      prefix = c;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(clear);
      dict = new Map();
      size = minCode + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) out.push(cur & 255);
  return out;
}

async function renderGif(core, { t0, n, fps, scale, W, H, alpha, report, cancelled }) {
  const eng = core.engine;
  const c = core.comp;
  const pal = gifPalette();
  const bytes = [];
  const str = (s) => [...s].forEach((ch) => bytes.push(ch.charCodeAt(0)));
  const u16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
  str('GIF89a');
  u16(W);
  u16(H);
  bytes.push(0xf7, 0, 0);
  for (const [r, g, b] of pal) bytes.push(r, g, b);
  bytes.push(0x21, 0xff, 0x0b);
  str('NETSCAPE2.0');
  bytes.push(3, 1, 0, 0, 0);
  const tmp = document.createElement('canvas');
  tmp.width = W;
  tmp.height = H;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  const delay = Math.max(2, Math.round(100 / fps));
  for (let i = 0; i < n; i++) {
    if (cancelled()) return null;
    await eng.renderFrame(c, t0 + i / fps, { scale, bg: !alpha, size: [W, H] });
    tctx.clearRect(0, 0, W, H);
    tctx.drawImage(eng.canvas, 0, 0, W, H);
    const idx = quantize(tctx.getImageData(0, 0, W, H).data, W, H, alpha);
    bytes.push(0x21, 0xf9, 4, alpha ? 0x09 : 0x04);
    u16(delay);
    bytes.push(alpha ? 255 : 0, 0);
    bytes.push(0x2c);
    u16(0);
    u16(0);
    u16(W);
    u16(H);
    bytes.push(0, 8);
    const data = lzw(idx);
    for (let p = 0; p < data.length; p += 255) {
      const chunk = data.slice(p, p + 255);
      bytes.push(chunk.length, ...chunk);
    }
    bytes.push(0);
    if (i % 2 === 0 || i === n - 1) report(i + 1);
    if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  bytes.push(0x3b);
  return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
}
