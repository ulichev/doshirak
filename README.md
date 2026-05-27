# Дошик 🍜

Минималистичный PWA-трекер доходов и расходов. Не отвлекает, считает оставшийся бюджет на день и работает оффлайн.

**Демо:** [doshik.vercel.app](https://doshik.vercel.app)

---

## Возможности

- **Бюджет на период** — задаёшь сумму и количество дней, приложение считает остаток на день и предупреждает о перерасходе.
- **История транзакций** — группировка по дням, отдельные тайлы сумм по расходам и доходам, фильтр по категории и типу.
- **Категории** — иконка + цвет, отдельные наборы для расходов и доходов, можно редактировать и добавлять.
- **Оффлайн-режим** — данные сохраняются в `localStorage`, при появлении сети уходят в Supabase из очереди.
- **Восстановление по коду** — формат `XXXX-XXXX`, без email и паролей; одним кодом данные переносятся между устройствами.
- **PWA** — устанавливается на Android через «Добавить на главный экран», работает в standalone-режиме.
- **Импорт/экспорт** — JSON-выгрузка и загрузка всех данных одной кнопкой.
- **Прокси Supabase** — запросы идут через `/sb` (Vercel rewrite + Vite proxy), что позволяет работать без VPN.

## Технологии

- Vanilla JavaScript (ES-модули, без фреймворков)
- [Vite](https://vitejs.dev) — сборщик и dev-сервер
- [Supabase](https://supabase.com) — авторизация и БД (PostgreSQL + RLS)
- [Vercel](https://vercel.com) — хостинг и автодеплой из `main`

## Установка

```bash
git clone https://github.com/ulichev/doshirak.git
cd doshirak
npm install
```

## Запуск

```bash
npm run dev      # dev-сервер с HMR на http://localhost:5173
npm run build    # production-сборка в dist/
npm run preview  # предпросмотр собранной версии
npm run lint     # eslint
```

## Переменные окружения

Создай `.env` в корне:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_KEY=your-publishable-anon-key
```

В коде используется только `VITE_SUPABASE_KEY` — запросы всегда идут через прокси `/sb`. `VITE_SUPABASE_URL` нужен для Vercel-rewrite и Vite-proxy конфига.

## База данных

Нужны три таблицы с включённым RLS (`auth.uid() = user_id`) и индексами по `user_id`:

| Таблица            | Колонки                                              |
|--------------------|------------------------------------------------------|
| `transactions`     | `user_id, amount, type, cat_id, note, date`          |
| `categories`       | `user_id, name, color, icon, ctype, sort_order`      |
| `budget_settings`  | `user_id, amount, days, deadline, set_at`            |

## Структура проекта

```
.
├── index.html          разметка всех экранов (auth, main, history, budget, settings)
├── src/
│   ├── app.js          вся логика — стейт, синк, рендер, обработчики
│   └── style.css       стили
├── public/
│   ├── icon.png        иконка PWA
│   ├── manifest.json   PWA-манифест
│   └── sw.js           service worker (pass-through, нужен для install on Android)
├── vite.config.js      dev-прокси /sb → Supabase
├── vercel.json         production-rewrite /sb/* → Supabase
└── eslint.config.js
```

## Архитектура

Приложение однофайловое в `src/app.js`. Глобальный стейт `S` содержит транзакции, категории, бюджет и UI-флаги. Все экраны лежат в DOM одновременно (`#s-auth`, `#s-main`, `#s-history`, `#s-budget`, `#s-settings`), переключение — через CSS-класс `.hidden`.

Авторизация — кастомная: код `XXXX-XXXX` превращается в email `{code}@doshik.app` и пароль той же строкой, всё через `signInWithPassword` Supabase. На каждое устройство копия данных синхронизируется через RLS по `user_id`.

Все клики на UI идут через inline `onclick` — функции экспонируются глобально через `Object.assign(window, {...})` в конце `app.js`.

## Деплой

Любой push в `main` автоматически деплоится на Vercel. В Vercel-проекте нужно прописать те же `VITE_SUPABASE_URL` и `VITE_SUPABASE_KEY`.

## Вклад в разработку

Багрепорты и PR — в [issues](https://github.com/ulichev/doshirak/issues). По вопросам: [@aulichev](https://t.me/aulichev).

## Лицензия

MIT
