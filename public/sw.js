const CACHE = 'muck-v30';
const PRECACHE = [
  '/',
  '/index.html',
  '/login.html',
  '/register.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/style.css',
  '/auth.css',
  '/dm-features.css',
  '/app.js',
  '/voice.js',
  '/dm-features.js',
  '/chat-features.js',
  '/auth-login.js',
  '/auth-register.js',
  '/auth-common.js',
];

async function precache() {
  const cache = await caches.open(CACHE);
  await Promise.all(
    PRECACHE.map((url) => cache.add(url).catch(() => null))
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/api/')) return;

  // SPA navigasyonları — çevrimdışıysa offline.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/index.html', copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match('/index.html') || await caches.match('/');
          return cached || caches.match('/offline.html');
        })
    );
    return;
  }

  const isAppFile = /\.(html|js|css|webmanifest)$/.test(url.pathname)
    || url.pathname === '/'
    || url.pathname === '/manifest.webmanifest';

  if (isAppFile) {
    event.respondWith(
      fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => caches.match(request).then((c) => c || caches.match('/offline.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    }).catch(() => cached))
  );
});
