const BUILD_TIME = '__BUILD_TIME__';
const CACHE = 'doshik-' + BUILD_TIME;

// Кэшируем app shell при установке нового SW
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/'])));
  // Не skipWaiting — ждём, пока пользователь нажмёт «Обновить» в тосте
});

// Удаляем старые кэши при активации
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  // POST и прочие мутации не кэшируем (cache.put с POST бросает TypeError)
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Supabase API — только сеть, не кэшируем
  if (url.pathname.startsWith('/sb/')) {
    e.respondWith(fetch(request).catch(() => new Response('', { status: 503 })));
    return;
  }

  // Навигация (HTML) — сеть первична, кэш как fallback при оффлайне
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // JS/CSS с content-hash от Vite — кэш первичен (immutable assets)
  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(request, res.clone()));
        return res;
      });
    })
  );
});

// Приложение посылает SKIP_WAITING → активируем новый SW → страница перезагружается
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
