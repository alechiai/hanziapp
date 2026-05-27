// Service Worker — HanziApp
// Cache-first per i file statici, network-first per Gemini API

const CACHE_NAME = 'hanziapp-v1';
const STATIC_FILES = [
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './data/hanzi.js',
  './icons/icon-192.svg',
  './icons/icon-512.svg',
  './icons/apple-touch-icon.svg'
];

// Installazione: pre-cache di tutti i file statici
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_FILES))
  );
  self.skipWaiting();
});

// Attivazione: elimina cache vecchie
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first per statici, network-first per Gemini
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Chiamate Gemini: sempre network (non cachare risposte AI)
  if (url.includes('generativelanguage.googleapis.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // File statici: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
