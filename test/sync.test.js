import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, teardown, settle, tick, txt, $ } from './helpers/boot.js';
import { makeServer, upserts } from './helpers/server.js';

afterEach(teardown);

const CODE = 'ABCD-EFGH';
const NOW = '2026-08-10T10:00:00';
const BUDGET = { amount: 30000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01', spent_at_start: 0, reset_ts: '2026-08-01T00:00:00.000Z' };
const typeAmount = (str) => { for (const ch of str) window.np(ch); };

/** Приложение с сохранённым кодом входа: при старте входит и синхронизируется */
async function bootSignedIn({ tables = {}, storage = {}, now = NOW, prep } = {}) {
  const server = makeServer({ users: [CODE] });
  const uid = server.uid(CODE);
  Object.entries(tables).forEach(([tb, rows]) => {
    server.tables[tb] = rows.map((r) => ({ user_id: uid, ...r }));
  });
  if (prep) prep(server);
  const t = await bootApp({ now, server, storage: { tk_rccode: CODE, ...storage } });
  return { t, server, uid };
}

describe('вход по сохранённому коду и первая синхронизация', () => {
  it('входит и забирает с сервера траты, категории и бюджет', async () => {
    const { t, uid } = await bootSignedIn({
      tables: {
        transactions: [
          { id: 'a', amount: 100, type: 'expense', cat_id: '', note: '', date: '2026-08-05T10:00:00+00:00', in_budget: false },
          { id: 'b', amount: 200, type: 'expense', cat_id: 'food_x', note: 'обед', date: '2026-08-09T10:00:00+00:00', in_budget: false },
        ],
        categories: [{ id: 'food_x', name: 'Еда', color: '#F5A623', icon: '🍔', ctype: 'expense', sort_order: 0 }],
        budget_settings: [{ amount: 30000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01', reset_ts: '2026-08-01T00:00:00+00:00' }],
      },
    });
    expect(t.currentUser.id).toBe(uid);
    expect(t.S.txs.map((x) => x.id)).toEqual(['b', 'a']); // новые сверху
    expect(t.S.txs[1].catId).toBeNull(); // пустая строка с сервера → «без категории»
    expect(t.S.cats.map((c) => c.id)).toEqual(['food_x']);
    expect(t.S.budget).toMatchObject({ amount: 30000, deadline: '2026-08-30' });
    expect(t.budgetRemaining()).toBe(29700);
    expect(txt('sync-title')).toBe('Синхронизировано');
    // и всё это сохранено в памяти телефона
    expect(JSON.parse(localStorage.getItem(t.K.tx))).toHaveLength(2);
  });

  it('неизвестный код — экран входа, данных нет', async () => {
    const server = makeServer({ users: [] });
    const t = await bootApp({ now: NOW, server, storage: { tk_rccode: CODE }, keepAuth: true });
    expect(t.currentUser).toBeNull();
    expect($('s-auth').style.display).toBe('flex');
  });

  it('без сети при сохранённой сессии открывает локальные данные, а не экран входа', async () => {
    const server = makeServer({ users: [CODE], session: CODE });
    server.offline = true;
    const t = await bootApp({
      now: NOW, server, keepAuth: true,
      storage: {
        tk_rccode: CODE,
        tk_tx: [{ id: 'loc', amount: 500, type: 'expense', catId: null, note: '', date: '2026-08-09T10:00:00.000Z' }],
        tk_budget: BUDGET,
      },
    });
    expect($('s-auth').style.display).not.toBe('flex');
    expect(t.S.txs.map((x) => x.id)).toEqual(['loc']);
    expect(t.budgetRemaining()).toBe(29500);
    expect(txt('sync-title')).toBe('Нет соединения');
  });

  it('пустые категории на сервере — засевает стандартные с суффиксом пользователя', async () => {
    const { t, server, uid } = await bootSignedIn();
    const ids = server.tables.categories.map((c) => c.id);
    expect(ids.length).toBeGreaterThanOrEqual(10);
    expect(ids.every((id) => id.endsWith('_' + uid.slice(0, 8)))).toBe(true);
    expect(t.S.cats.length).toBe(ids.length);
  });

  it('засев категорий не дублируется при повторной синхронизации', async () => {
    const { t, server } = await bootSignedIn();
    const n = server.tables.categories.length;
    await t.syncFromSupabase();
    await settle();
    expect(server.tables.categories.length).toBe(n);
  });
});

describe('слияние локальных данных с сервером', () => {
  it('трата из оффлайн-очереди не теряется, если сервер её ещё не видел', async () => {
    const pending = { id: 'p1', amount: 700, type: 'expense', catId: null, note: '', date: '2026-08-09T11:00:00.000Z' };
    const { t, server } = await bootSignedIn({
      storage: { tk_tx: [pending], tk_oq: [{ op: 'pushTx', data: pending }], tk_budget: BUDGET },
      tables: { transactions: [{ id: 'srv', amount: 100, type: 'expense', cat_id: '', note: '', date: '2026-08-05T10:00:00+00:00', in_budget: false }] },
    });
    expect(t.S.txs.map((x) => x.id).sort()).toEqual(['p1', 'srv']);
    // очередь дошла до сервера
    expect(server.tables.transactions.map((x) => x.id).sort()).toEqual(['p1', 'srv']);
    expect(JSON.parse(localStorage.getItem('tk_oq'))).toEqual([]);
  });

  it('локальная трата, которой нет ни на сервере, ни в очереди, убирается (удалена на другом устройстве)', async () => {
    const { t } = await bootSignedIn({
      storage: { tk_tx: [{ id: 'gone', amount: 1, type: 'expense', catId: null, note: '', date: '2026-08-09T11:00:00.000Z' }] },
      tables: { transactions: [{ id: 'srv', amount: 100, type: 'expense', cat_id: '', note: '', date: '2026-08-05T10:00:00+00:00', in_budget: false }] },
    });
    expect(t.S.txs.map((x) => x.id)).toEqual(['srv']);
  });

  it('флаг «доход в бюджет»: локальный true побеждает и дозаливается на сервер', async () => {
    const inc = { id: 'inc', amount: 5000, type: 'income', catId: null, note: '', date: '2026-08-05T10:00:00.000Z', inBudget: true };
    const { t, server } = await bootSignedIn({
      storage: { tk_tx: [inc], tk_budget: BUDGET },
      tables: {
        transactions: [{ id: 'inc', amount: 5000, type: 'income', cat_id: '', note: '', date: '2026-08-05T10:00:00+00:00', in_budget: false }],
        budget_settings: [{ amount: 30000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01', reset_ts: '2026-08-01T00:00:00+00:00' }],
      },
    });
    expect(t.S.txs[0].inBudget).toBe(true);
    expect(t.budgetRemaining()).toBe(35000);
    expect(server.tables.transactions[0].in_budget).toBe(true);
  });

  it('бюджет с сервера главнее локального, reset_ts — тоже с сервера', async () => {
    const { t } = await bootSignedIn({
      storage: { tk_budget: { ...BUDGET, amount: 1000 } },
      tables: { budget_settings: [{ amount: 45000, days: 20, deadline: '2026-08-25', set_at: '2026-08-06', reset_ts: '2026-08-06T09:30:00+00:00' }] },
    });
    expect(t.S.budget).toMatchObject({ amount: 45000, deadline: '2026-08-25', reset_ts: '2026-08-06T09:30:00+00:00' });
  });

  it('только что сохранённый бюджет не перетирается синком в течение 30 секунд', async () => {
    const { t, server } = await bootSignedIn({ tables: { budget_settings: [{ amount: 1000, days: 5, deadline: '2026-08-14', set_at: '2026-08-10', reset_ts: '2026-08-10T00:00:00+00:00' }] } });
    window.goBudget();
    $('bud-amount').value = '50000'; window.onBudAmtInput();
    $('bud-date-input').value = '2026-08-31'; window.onBudDateChange();
    const p = window.saveBudget();
    // другое устройство тем временем записало старое значение
    server.tables.budget_settings[0].amount = 1000;
    await t.syncFromSupabase();
    expect(t.S.budget.amount).toBe(50000);
    await p;
  });

  it('ошибка базы при синке — красная точка с кодом, локальные данные целы', async () => {
    const { t, server } = await bootSignedIn({ storage: { tk_tx: [{ id: 'x', amount: 1, type: 'expense', catId: null, note: '', date: '2026-08-09T11:00:00.000Z' }] } });
    server.fail = ({ table, op }) => (table === 'transactions' && op === 'select' ? { code: '42501', message: 'permission denied' } : null);
    t.S.txs = [{ id: 'x', amount: 1, type: 'expense', catId: null, note: '', date: '2026-08-09T11:00:00.000Z' }];
    await t.syncFromSupabase();
    expect(txt('sync-title')).toBe('Ошибка синхронизации');
    expect(txt('sync-time')).toContain('42501');
    expect(t.S.txs.map((x) => x.id)).toEqual(['x']);
  });

  it('недоступная таблица истории периодов не портит статус синхронизации', async () => {
    const { t, server } = await bootSignedIn();
    server.fail = ({ table }) => (table === 'budget_history' ? { code: 'PGRST205', message: 'no table' } : null);
    await t.syncFromSupabase();
    expect(txt('sync-title')).toBe('Синхронизировано');
  });

  it('история периодов: сервер + локальные объединяются, локальные дозаливаются, старые строки пропускаются', async () => {
    const local = { id: '11111111-1111-4111-8111-111111111111', from: '2026-07-01', to: '2026-07-31', deadline: '2026-07-31', amount: 20000, spent: 21000, income: 0, result: -1000, early: false, top: [], closed_at: '2026-08-01T00:00:00.000Z' };
    const { t, server } = await bootSignedIn({
      storage: { tk_budperiods: [local] },
      tables: {
        budget_history: [
          { id: '22222222-2222-4222-8222-222222222222', ts: '2026-07-01T00:00:00+00:00', amount: 20000, days: 30, deadline: '2026-06-30', start_day: '2026-06-01', end_day: '2026-06-30', spent: 15000, income: 0, result: 5000, early: false, top_cats: [{ name: 'Еда', amount: 9000 }] },
          { id: '33333333-3333-4333-8333-333333333333', ts: '2026-05-28T00:00:00+00:00', amount: 5000, days: 30, deadline: '2025-01-01', prev_amount: null },
        ],
      },
    });
    expect(t.S.budHist.map((r) => r.to)).toEqual(['2026-07-31', '2026-06-30']);
    expect(t.S.budHist[1].top[0].name).toBe('Еда');
    const pushed = server.tables.budget_history.find((r) => r.id === local.id);
    expect(pushed).toMatchObject({ start_day: '2026-07-01', end_day: '2026-07-31', days: 31, result: -1000 });
  });
});

describe('запись на сервер', () => {
  it('новая трата уходит на сервер с пользователем и пустым cat_id', async () => {
    const { t, server, uid } = await bootSignedIn({ storage: { tk_budget: BUDGET }, tables: { budget_settings: [{ ...BUDGET, reset_ts: '2026-08-01T00:00:00+00:00' }] } });
    typeAmount('450');
    window.confirm_();
    await settle();
    expect(server.tables.transactions).toHaveLength(1);
    expect(server.tables.transactions[0]).toMatchObject({ user_id: uid, amount: 450, type: 'expense', cat_id: '', in_budget: false });
    expect(t.S.txs[0].amount).toBe(450);
  });

  it('без сети трата ждёт в очереди и уходит, когда сеть вернулась', async () => {
    const { t, server } = await bootSignedIn({ storage: { tk_budget: BUDGET }, tables: { budget_settings: [{ ...BUDGET, reset_ts: '2026-08-01T00:00:00+00:00' }] } });
    server.offline = true;
    typeAmount('300');
    window.confirm_();
    await settle();
    expect(server.tables.transactions).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('tk_oq'))).toHaveLength(1);
    expect(txt('sync-title')).toBe('Нет соединения');

    server.offline = false;
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(server.tables.transactions).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('tk_oq'))).toEqual([]);
    expect(txt('sync-title')).toBe('Синхронизировано');
    expect(t.S.txs).toHaveLength(1);
  });

  it('запись, которую сервер отбивает, остаётся в очереди и не теряется', async () => {
    const { server } = await bootSignedIn({ storage: { tk_budget: BUDGET }, tables: { budget_settings: [{ ...BUDGET, reset_ts: '2026-08-01T00:00:00+00:00' }] } });
    server.fail = ({ table, op }) => (table === 'transactions' && op === 'upsert' ? { code: '500', message: 'boom' } : null);
    typeAmount('10');
    window.confirm_();
    await settle();
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(JSON.parse(localStorage.getItem('tk_oq'))).toHaveLength(1);
    server.fail = null;
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(server.tables.transactions).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('tk_oq'))).toEqual([]);
  });

  it('«Отменить» в тосте удаляет трату и на сервере', async () => {
    const { server } = await bootSignedIn({ storage: { tk_budget: BUDGET }, tables: { budget_settings: [{ ...BUDGET, reset_ts: '2026-08-01T00:00:00+00:00' }] } });
    typeAmount('99');
    window.confirm_();
    await settle();
    expect(server.tables.transactions).toHaveLength(1);
    window.toastUndo();
    await settle();
    expect(server.tables.transactions).toHaveLength(0);
  });

  it('удаление без сети доходит до сервера позже', async () => {
    const { t, server } = await bootSignedIn({
      tables: { transactions: [{ id: 'd1', amount: 100, type: 'expense', cat_id: '', note: '', date: '2026-08-05T10:00:00+00:00', in_budget: false }] },
    });
    server.offline = true;
    window.showTxEdit('d1');
    const p = window.deleteTxFromEdit();
    await tick();
    window._confOk();
    await p; await settle();
    expect(t.S.txs).toHaveLength(0);
    expect(server.tables.transactions).toHaveLength(1);
    server.offline = false;
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(server.tables.transactions).toHaveLength(0);
  });

  it('правка траты обновляет запись на сервере', async () => {
    const { server } = await bootSignedIn({
      tables: { transactions: [{ id: 'e1', amount: 100, type: 'expense', cat_id: '', note: '', date: '2026-08-05T10:00:00+00:00', in_budget: false }] },
    });
    window.showTxEdit('e1');
    $('tx-edit-amount').value = '250';
    window.onTxEditAmtInput();
    $('tx-edit-note').value = 'такси';
    window.saveTxEdit();
    await settle();
    expect(server.tables.transactions[0]).toMatchObject({ id: 'e1', amount: 250, note: 'такси' });
  });

  it('без колонки in_budget (миграция не применена) трата всё равно сохраняется', async () => {
    const { server } = await bootSignedIn({
      storage: { tk_budget: BUDGET },
      tables: { budget_settings: [{ ...BUDGET, reset_ts: '2026-08-01T00:00:00+00:00' }] },
      prep: (s) => { s.missingCols.transactions = ['in_budget']; },
    });
    typeAmount('70');
    window.confirm_();
    await settle();
    expect(server.tables.transactions).toHaveLength(1);
    expect('in_budget' in server.tables.transactions[0]).toBe(false);
  });

  it('новый бюджет: настройки, итог старого периода и сброс флагов доходов — всё на сервере', async () => {
    const { server, uid } = await bootSignedIn({
      now: '2026-09-02T10:00:00',
      tables: {
        budget_settings: [{ ...BUDGET, reset_ts: '2026-08-01T00:00:00+00:00' }],
        transactions: [
          { id: 's1', amount: 32000, type: 'expense', cat_id: 'food_x', note: '', date: '2026-08-10T10:00:00+00:00', in_budget: false },
          { id: 'i1', amount: 1000, type: 'income', cat_id: '', note: '', date: '2026-08-11T10:00:00+00:00', in_budget: true },
        ],
        categories: [{ id: 'food_x', name: 'Еда', color: '#F5A623', icon: '🍔', ctype: 'expense', sort_order: 0 }],
      },
    });
    window.goBudget();
    $('bud-amount').value = '40000'; window.onBudAmtInput();
    $('bud-date-input').value = '2026-09-30'; window.onBudDateChange();
    await window.saveBudget();
    await settle();
    expect(server.tables.budget_settings[0]).toMatchObject({ user_id: uid, amount: 40000, deadline: '2026-09-30' });
    expect(server.tables.transactions.find((x) => x.id === 'i1').in_budget).toBe(false);
    expect(server.tables.budget_history).toHaveLength(1);
    expect(server.tables.budget_history[0]).toMatchObject({
      user_id: uid, start_day: '2026-08-01', end_day: '2026-08-30', days: 30, amount: 30000,
      spent: 32000, income: 1000, result: -1000, early: false,
    });
    expect(server.tables.budget_history[0].top_cats[0]).toMatchObject({ name: 'Еда', amount: 32000 });
    expect(txt('sync-title')).toBe('Синхронизировано');
  });

  it('история периодов без колонок в базе — остаётся локальной и не краснит статус', async () => {
    const { t, server } = await bootSignedIn({
      now: '2026-09-02T10:00:00',
      tables: {
        budget_settings: [{ ...BUDGET, reset_ts: '2026-08-01T00:00:00+00:00' }],
        transactions: [{ id: 's1', amount: 100, type: 'expense', cat_id: '', note: '', date: '2026-08-10T10:00:00+00:00', in_budget: false }],
      },
      prep: (s) => { s.missingCols.budget_history = ['start_day', 'end_day', 'spent', 'income', 'result', 'early', 'top_cats']; },
    });
    window.goBudget();
    $('bud-amount').value = '40000'; window.onBudAmtInput();
    $('bud-date-input').value = '2026-09-30'; window.onBudDateChange();
    await window.saveBudget();
    await settle();
    expect(t.S.budHist).toHaveLength(1);
    expect(server.tables.budget_history).toHaveLength(0);
    expect(txt('sync-title')).toBe('Синхронизировано');
    // и в оффлайн-очередь история не кладётся
    expect(JSON.parse(localStorage.getItem('tk_oq') || '[]').some((i) => /Hist/i.test(i.op))).toBe(false);
  });

  it('категории: добавление, правка и удаление доходят до сервера', async () => {
    const { server } = await bootSignedIn({
      tables: { categories: [{ id: 'food_x', name: 'Еда', color: '#F5A623', icon: '🍔', ctype: 'expense', sort_order: 0 }] },
    });
    window.goCategories();
    window.showCatModal();
    $('cat-name-inp').value = 'Кофе';
    window.saveCat();
    await settle();
    expect(server.tables.categories.map((c) => c.name)).toContain('Кофе');

    window.showCatModal('food_x');
    $('cat-name-inp').value = 'Продукты';
    window.saveCat();
    await settle();
    expect(server.tables.categories.find((c) => c.id === 'food_x').name).toBe('Продукты');

    const p = window.deleteCat('food_x');
    await tick();
    window._confOk();
    await p; await settle();
    expect(server.tables.categories.find((c) => c.id === 'food_x')).toBeUndefined();
  });

  it('upsert шлёт только свои строки (RLS)', async () => {
    const { server, uid } = await bootSignedIn({ storage: { tk_budget: BUDGET }, tables: { budget_settings: [{ ...BUDGET, reset_ts: '2026-08-01T00:00:00+00:00' }] } });
    typeAmount('5');
    window.confirm_();
    await settle();
    expect(upserts(server, 'transactions').every((r) => r.user_id === uid)).toBe(true);
  });
});
