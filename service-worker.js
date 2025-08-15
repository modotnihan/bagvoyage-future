// ===== Bagvoyage — service-worker.js =====
const CACHE_VERSION = 'v1.2.8';
const CACHE_NAME = `bagvoyage-${CACHE_VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './img/bagvoyage-icon-32.png',
  './img/bagvoyage-icon-180.png',
  './img/bagvoyage-icon-192.png',
  './img/bagvoyage-icon-512.png'
];

// Install: pre-cache core assets
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k.startsWith('bagvoyage-') && k !== CACHE_NAME)
        .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch strategy:
// - HTML/doc => network-first (fallback to cache)
// - Others => cache-first (fallback to network)
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const accept = req.headers.get('accept') || '';
  const isHTML = req.destination === 'document' || accept.includes('text/html');

  if (isHTML) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('./index.html')))
    );
  } else {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res.ok && (req.url.startsWith(self.location.origin) || req.destination)) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, copy));
          }
          return res;
        });
      })
    );
  }
});
