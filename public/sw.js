'use strict';

// Service Worker: App-Shell offline verfügbar.
// Die Daten selbst speichert die App lokal und synchronisiert sie selbst –
// API-Aufrufe laufen daher immer direkt zum Server.

const VERSION = 'dakle-ranking-v7';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // App-Shell: sofort aus dem Cache (auch wenn der Server gerade aufwacht oder
  // keine Verbindung besteht) und im Hintergrund aktualisieren.
  // Neue Versionen sind damit spätestens beim übernächsten Öffnen da.
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: true })
      || (req.mode === 'navigate' ? await cache.match('index.html') : undefined);
    const network = fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
    if (cached) {
      event.waitUntil(network.catch(() => {}));
      return cached;
    }
    return network.catch(() => caches.match('index.html'));
  })());
});
