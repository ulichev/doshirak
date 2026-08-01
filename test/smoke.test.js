import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, teardown, seed, tx, $, txt } from './helpers/boot.js';

afterEach(teardown);

describe('загрузка приложения', () => {
  it('поднимается в jsdom и отдаёт тестовый хук', async () => {
    const t = await bootApp();
    expect(t).toBeTruthy();
    expect(typeof t.fmt).toBe('function');
    // Без авторизации данные не подгружаются — приложение ждёт на экране входа
    expect(t.S.txs).toEqual([]);
    // ...а после loadLocal() встают дефолтные категории
    t.loadLocal();
    expect(t.S.cats.length).toBe(t.DEF_CATS.length);
  });

  it('без бюджета главный экран показывает траты за сегодня', async () => {
    const t = await bootApp({ now: '2026-08-01T10:00:00' });
    seed(t, { txs: [tx({ date: '2026-08-01', amount: 250 }), tx({ date: '2026-07-31', amount: 999 })] });
    t.renderMain();
    expect(txt('today-num')).toBe('250');
    expect(txt('budget-pill')).toBe('Бюджет');
  });

  it('переключение экранов работает', async () => {
    await bootApp();
    window.goHistory();
    expect($('s-history').classList.contains('hidden')).toBe(false);
    expect($('s-main').classList.contains('hidden')).toBe(true);
    window.goMain();
    expect($('s-main').classList.contains('hidden')).toBe(false);
  });
});
