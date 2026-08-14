import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { bootApp, teardown, seed, tx, $, txt } from './helpers/boot.js';

afterEach(teardown);

let t;
const NOW = '2026-08-01T10:00:00';
const budget = (o = {}) => ({
  amount: 30000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01',
  spent_at_start: 0, reset_ts: '2026-08-01T00:00:00.000Z', ...o,
});
const num = (s) => Number(String(s).replace(/[\s ₽]/g, '').replace('−', '-').replace(',', '.'));

beforeEach(async () => {
  t = await bootApp({ now: NOW });
});

describe('главный экран: остаток бюджета', () => {
  it('без бюджета показывает сумму трат за сегодня', () => {
    seed(t, { txs: [tx({ date: '2026-08-01', amount: 120 }), tx({ date: '2026-07-31', amount: 5000 })] });
    t.renderMain();
    expect(num(txt('today-num'))).toBe(120);
    expect(txt('today-label')).toContain('Задай бюджет');
  });

  it('остаток = бюджет − потраченное с момента старта', () => {
    seed(t, {
      txs: [tx({ date: '2026-08-01', amount: 5000 }), tx({ date: '2026-08-01', amount: 1000 })],
      budget: budget(),
    });
    t.renderMain();
    expect(num(txt('today-num'))).toBe(24000);
  });

  it('траты до старта бюджета не съедают остаток', () => {
    seed(t, {
      txs: [tx({ date: '2026-07-15', amount: 8000 }), tx({ date: '2026-08-01', amount: 2000 })],
      budget: budget({ spent_at_start: 8000 }),
    });
    t.renderMain();
    expect(num(txt('today-num'))).toBe(28000);
  });

  it('доход «в бюджет» увеличивает остаток', () => {
    seed(t, {
      txs: [
        tx({ date: '2026-08-01', amount: 2000 }),
        tx({ date: '2026-08-02', amount: 5000, type: 'income', inBudget: true }),
        tx({ date: '2026-08-02', amount: 9999, type: 'income', inBudget: false }),
      ],
      budget: budget(),
    });
    t.renderMain();
    expect(num(txt('today-num'))).toBe(33000);
  });

  it('доход «в бюджет» вне периода не учитывается', () => {
    seed(t, {
      txs: [tx({ date: '2026-09-15', amount: 5000, type: 'income', inBudget: true })],
      budget: budget(),
    });
    t.renderMain();
    expect(num(txt('today-num'))).toBe(30000);
  });

  it('перерасход показывается со знаком минус', () => {
    seed(t, { txs: [tx({ date: '2026-08-01', amount: 35000 })], budget: budget() });
    t.renderMain();
    expect(txt('today-num').startsWith('−')).toBe(true);
    expect(num(txt('today-num'))).toBe(-5000);
    expect(txt('budget-pill')).toBe('0 ₽/день · до 30 авг');
  });

  it('₽/день = остаток / оставшихся дней + дата дедлайна', () => {
    seed(t, { txs: [], budget: budget({ amount: 30000, deadline: '2026-08-31' }) });
    t.renderMain();
    expect(txt('budget-pill')).toBe('1 000 ₽/день · до 31 авг');
  });

  it('истёкший бюджет предлагает обновиться', () => {
    seed(t, { txs: [], budget: budget({ deadline: '2026-07-30', set_at: '2026-07-01' }) });
    t.renderMain();
    expect(txt('today-label')).toBe('Период завершён');
    expect(txt('budget-pill')).toBe('Обновить');
  });

  it('бюджет, кончающийся сегодня, ещё активен', () => {
    seed(t, { txs: [], budget: budget({ deadline: '2026-08-01' }) });
    t.renderMain();
    expect(txt('today-label')).not.toBe('Период завершён');
  });
});

describe('экран бюджета: сохранение', () => {
  const setForm = (amount, date) => {
    $('bud-amount').value = String(amount);
    window.onBudAmtInput();
    $('bud-date-input').value = date;
    window.onBudDateChange();
  };

  it('сохраняет сумму, дедлайн и базовую отметку трат', async () => {
    seed(t, { txs: [tx({ date: '2026-07-20', amount: 4000 })] });
    window.goBudget();
    setForm(50000, '2026-08-10');
    await window.saveBudget();
    expect(t.S.budget).toMatchObject({ amount: 50000, deadline: '2026-08-10', set_at: '2026-08-01', spent_at_start: 4000 });
    expect(t.S.budget.days).toBe(10);
    const stored = JSON.parse(localStorage.getItem(t.K.budget));
    expect(stored.amount).toBe(50000);
  });

  it('не сохраняет без суммы', async () => {
    window.goBudget();
    $('bud-date-input').value = '2026-08-10';
    window.onBudDateChange();
    await window.saveBudget();
    expect(t.S.budget.amount).toBe(0);
    expect(txt('toast')).toContain('Введите сумму');
  });

  it('не сохраняет без даты', async () => {
    window.goBudget();
    $('bud-amount').value = '5000';
    window.onBudAmtInput();
    await window.saveBudget();
    expect(t.S.budget.amount).toBe(0);
    expect(txt('toast')).toContain('Выберите дату');
  });

  it('прошедшая дата отклоняется', () => {
    window.goBudget();
    $('bud-date-input').value = '2026-07-01';
    window.onBudDateChange();
    expect(t.S.budDays).toBe(0);
    expect(txt('toast')).toContain('сегодня или позже');
  });

  it('сегодняшняя дата = 1 день', () => {
    window.goBudget();
    $('bud-date-input').value = '2026-08-01';
    window.onBudDateChange();
    expect(t.S.budDays).toBe(1);
    expect(txt('bud-date-label')).toBe('до 1 августа');
  });

  it('ввод суммы ограничен 7 цифрами и без ведущего нуля', () => {
    window.goBudget();
    $('bud-amount').value = '123456789';
    window.onBudAmtInput();
    expect($('bud-amount').value).toBe('1 234 567');
    $('bud-amount').value = '0123';
    window.onBudAmtInput();
    expect($('bud-amount').value).toBe('0');
  });

  it('новый бюджет гасит старые флаги «доход в бюджет»', async () => {
    seed(t, {
      txs: [tx({ date: '2026-07-20', amount: 1000, type: 'income', inBudget: true })],
      budget: budget({ set_at: '2026-07-01', deadline: '2026-07-30' }),
    });
    window.goBudget();
    setForm(10000, '2026-08-20');
    await window.saveBudget();
    expect(t.S.txs.every((x) => !x.inBudget)).toBe(true);
  });

  it('на экране бюджета в поле — текущий остаток, а не изначальная сумма', () => {
    seed(t, { txs: [tx({ date: '2026-08-01', amount: 7000 })], budget: budget() });
    window.goBudget();
    expect($('bud-amount').value).toBe('23 000');
  });

  it('дедлайн переживает повторное открытие экрана без дрейфа даты', async () => {
    seed(t, { txs: [], budget: budget({ deadline: '2026-08-20' }) });
    window.goBudget();
    await window.saveBudget();
    expect(t.S.budget.deadline).toBe('2026-08-20');
  });
});

describe('бюджет и локальное хранилище', () => {
  it('старый бюджет без spent_at_start получает базу из прошлых трат', () => {
    seed(t, {
      txs: [tx({ date: '2026-07-10', amount: 3000 }), tx({ date: '2026-08-01', amount: 500 })],
      budget: { amount: 10000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01' },
    });
    expect(t.S.budget.spent_at_start).toBe(3000);
    t.renderMain();
    expect(num(txt('today-num'))).toBe(9500);
  });

  it('битый JSON в хранилище не роняет приложение', () => {
    localStorage.setItem(t.K.tx, '{не json');
    t.loadLocal();
    expect(t.S.txs).toEqual([]);
    expect(t.S.budget.amount).toBe(0);
  });
});
