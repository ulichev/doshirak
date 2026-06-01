// Service worker — включает возможность установки на Android (Add to Home Screen)
// Запросы не кэшируются, просто проксируются сети
const BUILD_TIME = '__BUILD_TIME__'; // заменяется при сборке → браузер видит новый SW
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => new Response('', {status: 503})));
});

// Позволяет приложению активировать новую версию SW без закрытия вкладки
self.addEventListener('message', e => {
  if(e.data === 'SKIP_WAITING') self.skipWaiting();
});
