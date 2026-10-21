// Offline app shell: first visit (online) caches these files, later visits work without
// a network. Bump VERSION whenever any file below changes so phones pick up the update.
const VERSION = 'pm-capture-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'db.js', 'zip.js', 'manifest.webmanifest',
               'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
