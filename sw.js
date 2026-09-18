// Offline after the first visit: every file of the app is cached and served from the phone.
// Files are requested with ?v=N, so an update never mixes old and new code.
const VERSION = 11;
const CACHE = 'hams-v' + VERSION;
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'fonts/readex-pro-300-700-arabic.woff2', 'fonts/readex-pro-300-700-latin.woff2', 'fonts/readex-pro-300-700-latin-ext.woff2',
  'fonts/ibm-plex-mono-400-latin.woff2', 'fonts/ibm-plex-mono-500-latin.woff2',
  ...['app.js', 'modem.js', 'protocol.js', 'codec.js', 'fonts/fonts.css'].map((f) => `${f}?v=${VERSION}`),
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first, and past the browser's own cache for this site's files, so whoever is online
// always gets the current version; the cached copy only when there is no network.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const own = new URL(e.request.url).origin === location.origin;
  e.respondWith(
    fetch(e.request, own ? { cache: 'no-cache' } : undefined)
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request)),
  );
});
