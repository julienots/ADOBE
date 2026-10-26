// Service worker : fonctionnement hors ligne (stratégie « réseau d'abord, cache en secours »).
const CACHE = 'prisme-v2';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/app.js', 'js/util.js', 'js/doc.js', 'js/history.js', 'js/view.js', 'js/selection.js', 'js/imaging.js',
  'js/develop.js', 'js/filters.js', 'js/text.js', 'js/icons.js', 'js/ui.js', 'js/panels.js', 'js/actions.js', 'js/io.js',
  'js/ai.js', 'js/inpaint.js', 'vendor/ort/ort.wasm.min.js', 'vendor/ort/ort-wasm-simd-threaded.mjs', 'vendor/ort/ort-wasm-simd-threaded.wasm', 'models/u2netp.onnx',
  'js/tools/base.js', 'js/tools/paint.js', 'js/tools/select.js', 'js/tools/misc.js',
  'icons/icon-192.png', 'icons/icon-256.png', 'icons/icon-32.png', 'icons/logo-ui.png', 'icons/superessence.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});
