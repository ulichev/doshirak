import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { bootApp, teardown, txt, $, seed, tx } from './helpers/boot.js';

afterEach(teardown);

let t;
beforeEach(async () => {
  t = await bootApp({ now: '2026-08-14T22:00:00' });
});

// Красная точка раньше всегда подписывалась «Нет соединения» — отказ базы (RLS,
// схема, протухший токен) выглядел как оффлайн и не диагностировался на устройстве.
describe('статус синхронизации', () => {
  it('ошибка базы показывает код и текст, а не «нет соединения»', () => {
    t.setSyncDot(false, { code: '42501', message: 'new row violates row-level security policy for table "transactions"' });
    expect(txt('sync-title')).toBe('Ошибка синхронизации');
    expect(txt('sync-time')).toContain('42501');
    expect(txt('sync-time')).toContain('row-level security');
    expect($('sync-icon').classList.contains('sync-dot--err')).toBe(true);
  });

  it('обрыв сети остаётся «нет соединения»', () => {
    t.setSyncDot(false, new TypeError('Failed to fetch'));
    expect(txt('sync-title')).toBe('Нет соединения');
    expect(txt('sync-time')).toBe('Данные сохранены локально');
  });

  it('успешная синхронизация гасит прошлую ошибку', () => {
    t.setSyncDot(false, { code: '42501', message: 'denied' });
    t.setSyncDot(true);
    expect(txt('sync-title')).toBe('Синхронизировано');
    expect($('sync-icon').classList.contains('sync-dot--ok')).toBe(true);
  });

  it('длинный текст ошибки обрезается', () => {
    t.setSyncDot(false, { code: '500', message: 'x'.repeat(400) });
    expect(txt('sync-time').length).toBeLessThan(140);
  });

  // Колонка cat_id в БД NOT NULL, а категория в приложении необязательна:
  // null отбивался ошибкой 23502 и намертво вешал оффлайн-очередь.
  it('транзакция без категории уходит с пустым cat_id, а не с null', () => {
    const row = t.txRow({ id: 'a1', amount: 100, type: 'expense', catId: null, note: '', date: '2026-08-14T10:00:00' }, 'u1');
    expect(row.cat_id).toBe('');
    expect(row.cat_id).not.toBe(null);
  });

  it('выбранная категория уходит как есть', () => {
    const row = t.txRow({ id: 'a2', amount: 100, type: 'expense', catId: 'food_ab12', note: 'кофе', date: '2026-08-14T10:00:00' }, 'u1');
    expect(row).toMatchObject({ id: 'a2', user_id: 'u1', cat_id: 'food_ab12', note: 'кофе' });
  });

  it('флаг «доход в бюджет» уходит на сервер', () => {
    const row = t.txRow({ id: 'a3', amount: 5000, type: 'income', catId: 'salary_ab12', inBudget: true, note: '', date: '2026-08-14T10:00:00Z' }, 'u1');
    expect(row.in_budget).toBe(true);
    expect(t.txRow({ id: 'a4', amount: 5000, type: 'income', catId: 'salary_ab12', note: '', date: '2026-08-14T10:00:00Z' }, 'u1').in_budget).toBe(false);
  });

  // Локально дата пишется как «…Z», с сервера приходит как «…+00:00» — это один
  // момент, но разные строки. Сравнение строк ломало границу периода бюджета.
  it('форматы даты сервера и клиента сравниваются как один момент', () => {
    expect(t.tsOf('2026-08-14T19:57:07.921+00:00')).toBe(t.tsOf('2026-08-14T19:57:07.921Z'));
    expect(t.tsOf('2026-08-14T22:57:07.921+03:00')).toBe(t.tsOf('2026-08-14T19:57:07.921Z'));
    expect(t.tsOf(null)).toBe(0);
  });

  it('ошибка «нет колонки» распознаётся для отката на старую схему', () => {
    expect(t.isMissingColumn({ code: 'PGRST204', message: "Could not find the 'in_budget' column of 'transactions'" }, 'in_budget')).toBe(true);
    expect(t.isMissingColumn({ code: '42703', message: 'column budget_settings.reset_ts does not exist' }, 'reset_ts')).toBe(true);
    expect(t.isMissingColumn({ code: '23502', message: 'null value in column "cat_id"' }, 'in_budget')).toBe(false);
    expect(t.isMissingColumn(null, 'in_budget')).toBe(false);
  });

  it('ошибка без кода показывается одним текстом', () => {
    expect(t.describeSyncErr({ message: 'JWT expired' })).toEqual({ code: '', message: 'JWT expired' });
    expect(t.describeSyncErr(new TypeError('NetworkError when attempting to fetch resource'))).toBe(null);
  });
});

// Состояние, от которого зависит остаток бюджета, должно быть одинаковым на всех
// устройствах и переживать перезапуск. Раньше reset_ts и inBudget жили только
// в localStorage — Android и iPhone показывали разные остатки.
describe('единство состояния бюджета', () => {
  const BUD = {
    amount: 30000, days: 30, deadline: '2026-08-30', set_at: '2026-08-14',
    reset_ts: '2026-08-14T19:00:00.000Z', spent_at_start: 0,
  };

  it('reset_ts переживает перезапуск приложения', () => {
    seed(t, { txs: [], budget: BUD });
    expect(t.S.budget.reset_ts).toBe('2026-08-14T19:00:00.000Z');
  });

  it('трата до старта периода не съедает бюджет, после — съедает', () => {
    seed(t, {
      txs: [
        tx({ date: '2026-08-14T18:00:00Z', amount: 5000 }), // до сохранения бюджета
        tx({ date: '2026-08-14T20:00:00Z', amount: 1000 }), // после
      ],
      budget: BUD,
    });
    expect(t.budgetRemaining()).toBe(29000);
  });

  it('граница периода не зависит от формата даты с сервера', () => {
    seed(t, { txs: [], budget: BUD });
    const serverFormat = { type: 'expense', date: '2026-08-14T20:00:00.000+00:00' };
    const clientFormat = { type: 'expense', date: '2026-08-14T20:00:00.000Z' };
    expect(t.inBudgetPeriod(serverFormat)).toBe(t.inBudgetPeriod(clientFormat));
    expect(t.inBudgetPeriod(serverFormat)).toBe(true);
  });

  it('доход «в бюджет» прибавляется к остатку только внутри периода', () => {
    seed(t, {
      txs: [
        tx({ date: '2026-08-14T20:00:00Z', amount: 5000, type: 'income', inBudget: true }),
        tx({ date: '2026-08-14T18:00:00Z', amount: 9000, type: 'income', inBudget: true }),
      ],
      budget: BUD,
    });
    expect(t.budgetRemaining()).toBe(35000);
  });
});
