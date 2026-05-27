// Service worker — включает возможность установки на Android (Add to Home Screen)
// Запросы не кэшируются, просто проксируются сети
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => new Response('', {status: 503})));
});
