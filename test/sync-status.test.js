import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { bootApp, teardown, txt, $ } from './helpers/boot.js';

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

  it('ошибка без кода показывается одним текстом', () => {
    expect(t.describeSyncErr({ message: 'JWT expired' })).toEqual({ code: '', message: 'JWT expired' });
    expect(t.describeSyncErr(new TypeError('NetworkError when attempting to fetch resource'))).toBe(null);
  });
});
