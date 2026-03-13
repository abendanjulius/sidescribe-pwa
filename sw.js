const CACHE_NAME = 'sidescribe-pwa-v4';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './gdrive-sync.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Install — cache shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — clear old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network-first for API calls, cache-first for assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-only for Google APIs
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('accounts.google.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-first for app shell
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => caches.match('./index.html'))
  );
});
