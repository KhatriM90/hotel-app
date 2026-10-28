/*
 * YeaStay PWA service worker: caches the app shell so the device opens without
 * internet. API calls are never cached or faked: a request that cannot reach the
 * server fails visibly (OPS-04 "prevent false posting/payment success").
 * Orders taken offline are queued by the app itself (src/queue.ts, OPS-05), not here.
 */
const SHELL_CACHE = 'yeastay-shell-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(['/pwa/', '/pwa/manifest.webmanifest', '/pwa/brand/yeastay-logo-white.svg']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/pwa/')) return;
  // Network first, falling back to the cached shell.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit ?? caches.match('/pwa/'))),
  );
});
