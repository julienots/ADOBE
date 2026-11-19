// Prisme Motion — médias : import d'images, de vidéos et de sons.
//
// Les vidéos sont décodées image par image par WebCodecs (bibliothèque Mediabunny) :
// lecture séquentielle ultra rapide (décodage matériel, images pré-décodées à l'avance) et accès
// précis à n'importe quelle image pour le défilement et l'export. Si le codec n'est pas pris en
// charge par WebCodecs, on se replie sur un élément <video> classique.

import { mid } from './model.js';

let MB = null;
export async function mediabunny() {
  MB ||= import('../../vendor/mediabunny/mediabunny.min.mjs');
  return MB;
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg|ico|heic|heif|tiff?|psd|dng|cr2|cr3|nef|arw|orf|rw2|raf|pef)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|ogv|avi|3gp|ts|mts)$/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba)$/i;

export function mediaKind(file) {
  const t = file.type || '';
  if (t.startsWith('video/') || VIDEO_EXT.test(file.name)) return 'video';
  if (t.startsWith('audio/') || AUDIO_EXT.test(file.name)) return 'audio';
  if (t.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image';
  return null;
}

export const MEDIA_ACCEPT = 'image/*,video/*,audio/*,.mp4,.mov,.m4v,.webm,.mkv,.mp3,.wav,.m4a,.aac,.ogg,.flac,.opus,.heic,.heif,.tif,.tiff,.psd,.prismemotion';

let audioCtx = null;
export function getAudioContext() {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

async function decodeImageAny(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'premultiply' });
  } catch {
    // Formats spéciaux (HEIC, TIFF, PSD, RAW) : on réutilise les décodeurs de Prisme Photo.
    const { decodeImage } = await import('../io.js');
    const c = await decodeImage(file);
    return c;
  }
}

function thumbOf(src, w, h) {
  const tw = 96, th = Math.max(1, Math.round((96 * h) / w)) || 54;
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = Math.min(th, 96);
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

async function decodeAudio(blob) {
  try {
    const buf = await blob.arrayBuffer();
    return await getAudioContext().decodeAudioData(buf);
  } catch (e) {
    console.warn('Audio non décodable', e);
    return null;
  }
}

// Importe un fichier et renvoie l'élément de métrage (asset).
export async function importMedia(file) {
  const kind = mediaKind(file);
  if (!kind) throw new Error('Format non pris en charge');
  const asset = { id: mid('as'), type: kind, name: file.name.replace(/\.[^.]+$/, '') || file.name, file: file.name, mime: file.type, size: file.size };
  await hydrateAsset(asset, file);
  return asset;
}

// Prépare les données d'exécution d'un élément (après import ou réouverture d'un projet).
export async function hydrateAsset(asset, blob) {
  asset.__blob = blob;
  if (asset.type === 'image') {
    const img = await decodeImageAny(blob);
    asset.__img = img;
    asset.w = img.width;
    asset.h = img.height;
    asset.thumb ||= thumbOf(img, img.width, img.height);
    asset.__version = (asset.__version || 0) + 1;
  } else if (asset.type === 'video') {
    const reader = await VideoReader.open(blob);
    asset.__reader = reader;
    asset.w = reader.width;
    asset.h = reader.height;
    asset.duration = reader.duration;
    asset.fps = reader.fps;
    asset.hasAudio = reader.hasAudio;
    if (!asset.thumb) {
      const f = await reader.frameAt(Math.min(0.5, reader.duration / 3));
      if (f) asset.thumb = thumbOf(f, reader.width, reader.height);
    }
    if (reader.hasAudio) decodeAudio(blob).then((b) => (asset.__audio = b));
  } else if (asset.type === 'audio') {
    const buf = await decodeAudio(blob);
    asset.__audio = buf;
    asset.duration = buf ? buf.duration : 0;
    asset.__peaks = buf ? peaks(buf, 600) : null;
  }
  return asset;
}

// Forme d'onde réduite pour l'affichage dans la timeline.
export function peaks(buf, n) {
  const ch = buf.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / n));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = i * step, e = Math.min(ch.length, j + step); j < e; j += 8) m = Math.max(m, Math.abs(ch[j]));
    out[i] = m;
  }
  return out;
}

// ---------- Lecteur vidéo image par image ----------

export class VideoReader {
  static async open(blob) {
    const r = new VideoReader();
    r.blob = blob;
    try {
      const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await mediabunny();
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('Pas de piste vidéo');
      if (!(await track.canDecode())) throw new Error('Codec non décodable par WebCodecs');
      r.input = input;
      r.track = track;
      r.width = track.displayWidth;
      r.height = track.displayHeight;
      r.duration = await input.computeDuration();
      try {
        const stats = await track.computePacketStats(120);
        r.fps = Math.round((stats.averagePacketRate || 30) * 100) / 100;
      } catch {
        r.fps = 30;
      }
      r.hasAudio = !!(await input.getPrimaryAudioTrack().catch(() => null));
      r.sink = new CanvasSink(track, { poolSize: 8, alpha: true });
      r.mode = 'webcodecs';
    } catch (e) {
      console.warn('Décodage WebCodecs indisponible, repli sur <video> :', e.message);
      await r.openElement(blob);
    }
    return r;
  }

  async openElement(blob) {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.src = URL.createObjectURL(blob);
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error('Vidéo illisible'));
    });
    this.video = v;
    this.width = v.videoWidth;
    this.height = v.videoHeight;
    this.duration = v.duration;
    this.fps = 30;
    this.hasAudio = true;
    this.mode = 'element';
  }

  // Renvoie une image (canvas ou <video>) pour l'instant t (secondes, temps de la source).
  // Les appels sont sérialisés : un seul décodage à la fois par vidéo.
  frameAt(t) {
    const run = () => this.frameAtNow(t);
    this.queue = (this.queue || Promise.resolve()).then(run, run);
    return this.queue;
  }

  async frameAtNow(t) {
    t = Math.max(0, Math.min(t, (this.duration || 0) - 1e-3));
    if (this.mode === 'element') return this.elementFrame(t);
    const cur = this.cur;
    // Même image que la précédente : rien à décoder.
    if (cur && t >= cur.timestamp - 1e-4 && t < cur.timestamp + cur.duration - 1e-4) return cur.canvas;
    // Avancée séquentielle (lecture, export) : on consomme l'itérateur qui pré-décode à l'avance.
    if (this.iter && cur && t > cur.timestamp && t < cur.timestamp + 2) {
      const f = await this.advance(t);
      if (f) return f;
    }
    // Saut (défilement) : nouvel itérateur à partir de t.
    await this.resetIter();
    this.iter = this.sink.canvases(t);
    this.cur = null;
    this.next = null;
    return this.advance(t);
  }

  async advance(t) {
    for (;;) {
      const n = this.next || (await this.iter.next()).value;
      this.next = null;
      if (!n) return this.cur?.canvas || null;
      if (n.timestamp > t + 1e-4 && this.cur) {
        // L'image suivante commence après t : l'image courante reste valable.
        this.next = n;
        return this.cur.canvas;
      }
      this.cur = n;
      if (n.timestamp + n.duration > t + 1e-4) return n.canvas;
    }
  }

  async resetIter() {
    if (this.iter) {
      try {
        await this.iter.return();
      } catch {
        /* itérateur déjà terminé */
      }
    }
    this.iter = null;
  }

  async elementFrame(t) {
    const v = this.video;
    if (Math.abs(v.currentTime - t) > 0.5 / (this.fps || 30)) {
      await new Promise((res) => {
        const done = () => {
          v.removeEventListener('seeked', done);
          res();
        };
        v.addEventListener('seeked', done);
        v.currentTime = t;
        setTimeout(done, 1500);
      });
    }
    return v;
  }
}

// ---------- Lecture audio synchronisée ----------

export class AudioEngine {
  constructor() {
    this.nodes = [];
  }

  // Démarre la lecture de toutes les pistes audio de la composition à partir de t.
  play(project, comp, t, rate = 1) {
    this.stop();
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime + 0.03;
    const visit = (c, offset, depth, gainMul) => {
      if (depth > 8) return;
      const solo = c.layers.some((l) => l.solo);
      for (const l of c.layers) {
        if (solo && !l.solo) continue;
        if (!l.audio || l.out <= t - offset) continue;
        if (l.type === 'comp') {
          const sub = project.comps.find((x) => x.id === l.source);
          if (sub) visit(sub, offset + l.start, depth + 1, gainMul * dbToGain(l.p['au.level']?.v ?? 0));
          continue;
        }
        if (l.type !== 'video' && l.type !== 'audio') continue;
        const asset = project.assets.find((a) => a.id === l.source);
        const buf = asset?.__audio;
        if (!buf) continue;
        const lin = offset + l.in, lout = offset + l.out;
        const startComp = Math.max(t, lin);
        if (startComp >= lout) continue;
        const srcOffset = (startComp - (offset + l.start)) * (l.speed || 1);
        if (srcOffset >= buf.duration) continue;
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.playbackRate.value = (l.speed || 1) * rate;
        const g = ctx.createGain();
        g.gain.value = gainMul * dbToGain(l.p['au.level']?.v ?? 0);
        node.connect(g).connect(ctx.destination);
        const when = now + (startComp - t) / rate;
        const dur = (lout - startComp) / rate;
        node.start(when, Math.max(0, srcOffset), dur * (l.speed || 1) * rate);
        this.nodes.push(node);
      }
    };
    visit(comp, 0, 0, 1);
  }

  stop() {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* déjà arrêté */
      }
    }
    this.nodes = [];
  }
}

export const dbToGain = (db) => (db <= -60 ? 0 : Math.pow(10, db / 20));

// Mixe l'audio d'une composition dans un AudioBuffer (pour l'export).
export async function mixdown(project, comp, t0, t1, sampleRate = 48000) {
  const len = Math.max(1, Math.ceil((t1 - t0) * sampleRate));
  const ctx = new OfflineAudioContext(2, len, sampleRate);
  let any = false;
  const visit = (c, offset, depth, gainMul) => {
    if (depth > 8) return;
    const solo = c.layers.some((l) => l.solo);
    for (const l of c.layers) {
      if (solo && !l.solo) continue;
      if (!l.audio) continue;
      if (l.type === 'comp') {
        const sub = project.comps.find((x) => x.id === l.source);
        if (sub) visit(sub, offset + l.start, depth + 1, gainMul * dbToGain(l.p['au.level']?.v ?? 0));
        continue;
      }
      if (l.type !== 'video' && l.type !== 'audio') continue;
      const asset = project.assets.find((a) => a.id === l.source);
      const buf = asset?.__audio;
      if (!buf) continue;
      const lin = Math.max(t0, offset + l.in), lout = Math.min(t1, offset + l.out);
      if (lout <= lin) continue;
      const srcOffset = (lin - (offset + l.start)) * (l.speed || 1);
      if (srcOffset >= buf.duration) continue;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.playbackRate.value = l.speed || 1;
      const g = ctx.createGain();
      const prop = l.p['au.level'];
      if (prop?.k?.length) {
        const n = Math.max(2, Math.ceil((lout - lin) * 30));
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          const tt = lin + ((lout - lin) * i) / (n - 1) - offset;
          curve[i] = gainMul * dbToGain(levelAt(prop, tt));
        }
        g.gain.setValueCurveAtTime(curve, lin - t0, lout - lin);
      } else g.gain.value = gainMul * dbToGain(prop?.v ?? 0);
      node.connect(g).connect(ctx.destination);
      node.start(lin - t0, Math.max(0, srcOffset), (lout - lin) * (l.speed || 1));
      any = true;
    }
  };
  visit(comp, 0, 0, 1);
  if (!any) return null;
  return ctx.startRendering();
}

function levelAt(prop, t) {
  const k = prop.k;
  if (t <= k[0].t) return k[0].v;
  if (t >= k[k.length - 1].t) return k[k.length - 1].v;
  for (let i = 0; i < k.length - 1; i++) {
    if (t >= k[i].t && t <= k[i + 1].t) return k[i].v + ((k[i + 1].v - k[i].v) * (t - k[i].t)) / (k[i + 1].t - k[i].t || 1);
  }
  return prop.v;
}
