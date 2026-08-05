const CACHE_NAME = 'valia-calculadora-v1';
const ARCHIVOS_A_GUARDAR = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

// Al instalar, guarda una copia de la app para que funcione sin internet
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS_A_GUARDAR))
  );
  self.skipWaiting();
});

// Al activar, borra copias viejas de versiones anteriores
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(
        nombres
          .filter((n) => n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

// Estrategia: primero intenta la red (para tener datos frescos si hay internet),
// y si falla (sin conexión), usa la copia guardada.
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((respuesta) => {
        const copia = respuesta.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia));
        return respuesta;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('./index.html')))
  );
});
