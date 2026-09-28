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


-- ── 6. Итоги прошлых периодов бюджета (v1.11.0) ──────────────────────────────
-- Таблица budget_history осталась от старой версии (RLS «свой user_id» уже есть).
-- С 1.11.0 клиент при смене бюджета пишет туда итог уходящего периода: границы,
-- сколько потрачено, доходы «в бюджет», остаток/перерасход и топ-3 категорий — для блока
-- «Прошлые периоды» на экране бюджета. Пересчитать итог задним числом нельзя,
-- поэтому храним снимок. Старые строки без result клиент пропускает.
-- До применения миграции история живёт только локально и до-заливается синком.
alter table public.budget_history
  add column if not exists start_day date,
  add column if not exists end_day   date,
  add column if not exists spent     numeric,
  add column if not exists income    numeric,
  add column if not exists result    numeric,
  add column if not exists early     boolean not null default false,
  add column if not exists top_cats  jsonb;   -- топ-3 категорий трат: [{id,name,icon,color,amount}]

create index if not exists budget_history_user_idx
  on public.budget_history (user_id);
