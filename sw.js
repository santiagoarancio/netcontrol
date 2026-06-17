const CACHE = 'netcontrol-v1';
const ASSETS = [
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Instalar: cachear assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activar: limpiar caches viejos
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first para assets propios, network-first para el router
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Requests al router (192.168.x.x) — siempre red, nunca cache
  if (url.hostname.startsWith('192.168.')) {
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({ error: 'Router no disponible' }), {
        headers: { 'Content-Type': 'application/json' }
      })
    ));
    return;
  }

  // Assets propios — cache first
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
