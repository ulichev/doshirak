-- Дошик — миграции схемы Supabase.
-- Выполнять в Supabase → SQL Editor. Все шаги идемпотентны: повторный запуск безопасен.
--
-- Зачем: часть состояния жила только в localStorage и не переживала переход между
-- устройствами (Android ↔ iPhone) и переустановку PWA. Из-за этого остаток бюджета
-- на двух устройствах мог отличаться.
--
-- Клиент с версии 1.9.0 умеет работать и БЕЗ этих колонок (молча откатывается на
-- старую схему), так что порядок «сначала деплой, потом SQL» безопасен.

-- ── 1. Доход, зачисленный в бюджет ───────────────────────────────────────────
-- Флаг «прибавить доход к бюджету» (кнопка в шторке при добавлении дохода).
-- Жил только в localStorage: на втором устройстве доход не прибавлялся к остатку,
-- а при переустановке PWA на iOS терялся совсем.
alter table public.transactions
  add column if not exists in_budget boolean not null default false;

-- ── 2. Момент запуска периода бюджета ────────────────────────────────────────
-- Точное время сохранения бюджета. Без него период считается от полуночи set_at,
-- и траты, сделанные в день установки бюджета до его сохранения, то попадают
-- в период, то нет — остаток «плавает» между устройствами и перезапусками.
alter table public.budget_settings
  add column if not exists reset_ts timestamptz;

-- ── 3. Категория необязательна ───────────────────────────────────────────────
-- В приложении трату можно сохранить без категории, а колонка была NOT NULL:
-- такие записи отбивались ошибкой 23502 и навсегда оседали в офлайн-очереди.
-- Клиент 1.8.5+ обходит это пустой строкой; снимаем ограничение и нормализуем.
alter table public.transactions
  alter column cat_id drop not null;

update public.transactions set cat_id = null where cat_id = '';

-- ── 4. Индекс под основной запрос ────────────────────────────────────────────
-- Клиент всегда читает транзакции как: where user_id = ? order by date desc.
create index if not exists transactions_user_date_idx
  on public.transactions (user_id, date desc);

-- ── 5. Проверка результата ───────────────────────────────────────────────────
-- Ожидается: transactions.cat_id = YES (nullable), in_budget = NO с default false,
-- budget_settings.reset_ts = YES.
select table_name, column_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and (table_name, column_name) in (
    ('transactions','cat_id'), ('transactions','in_budget'), ('budget_settings','reset_ts')
  )
order by table_name, column_name;


-- ── ОПЦИОНАЛЬНО, отдельным шагом ─────────────────────────────────────────────
-- Таблица budget_history пустая, и приложение в неё ничего не пишет: остался
-- только DELETE при сбросе данных. Сначала убедитесь, что она действительно пуста:
--
--   select count(*) from public.budget_history;
--
-- Если 0 — таблицу можно удалить. Клиент это переживёт: удаление истории
-- обёрнуто в игнорирование ошибки.
--
--   drop table if exists public.budget_history;
