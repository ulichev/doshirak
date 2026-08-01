import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { bootApp, teardown, seed, tx, $, txt, tick } from './helpers/boot.js';

afterEach(teardown);

let t;
const num = (s) => Number(String(s).replace(/[\s ₽]/g, '').replace('−', '-').replace(',', '.'));
const BUD = {
  amount: 30000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01',
  spent_at_start: 8000, reset_ts: '2026-08-01T00:00:00.000Z',
};

beforeEach(async () => {
  t = await bootApp({ now: '2026-08-01T10:00:00' });
});

describe('остаток бюджета не зависит от трат вне периода', () => {
  it('удаление старой траты не должно раздувать остаток', async () => {
    seed(t, {
      txs: [
        tx({ date: '2026-07-15', amount: 8000, id: 'old' }), // до бюджета, лежит в spent_at_start
        tx({ date: '2026-08-01', amount: 2000, id: 'new' }),
      ],
      budget: BUD,
    });
    t.renderMain();
    expect(num(txt('today-num'))).toBe(28000);

    // Пользователь удаляет старую, до-бюджетную запись
    window.showTxEdit('old');
    const p = window.deleteTxFromEdit();
    await tick();
    window._confOk();
    await p;

    // В периоде по-прежнему потрачено 2000 → остаток должен остаться 28 000
    expect(num(txt('today-num'))).toBe(28000);
  });

  it('уменьшение суммы старой траты не должно менять остаток', () => {
    seed(t, {
      txs: [tx({ date: '2026-07-15', amount: 8000, id: 'old' }), tx({ date: '2026-08-01', amount: 2000 })],
      budget: BUD,
    });
    t.renderMain();
    window.showTxEdit('old');
    $('tx-edit-amount').value = '100';
    window.saveTxEdit();
    expect(num(txt('today-num'))).toBe(28000);
  });

  it('трата, внесённая задним числом до старта бюджета, не должна съедать остаток', () => {
    seed(t, { txs: [tx({ date: '2026-08-01', amount: 2000 })], budget: { ...BUD, spent_at_start: 0 } });
    t.renderMain();
    expect(num(txt('today-num'))).toBe(28000);
    // вспомнил про забытую трату прошлого месяца и добавил её
    t.S.txs.push(tx({ date: '2026-07-15', amount: 5000 }));
    t.renderMain();
    expect(num(txt('today-num'))).toBe(28000);
  });

  it('трата после дедлайна не должна списываться с завершённого периода', () => {
    seed(t, {
      txs: [tx({ date: '2026-07-05', amount: 1000 }), tx({ date: '2026-07-25', amount: 4000 })],
      budget: { amount: 10000, days: 10, deadline: '2026-07-10', set_at: '2026-07-01', spent_at_start: 0, reset_ts: '2026-07-01T00:00:00.000Z' },
    });
    t.renderMain();
    // Период 1–10 июля: потрачена 1000. Трата 25 июля — уже вне периода.
    expect(num(txt('today-num'))).toBe(9000);
  });

  it('остаток и топ-3 категорий считаются по одному и тому же периоду', () => {
    seed(t, {
      txs: [
        tx({ date: '2026-07-15', amount: 8000, catId: 'food' }),
        tx({ date: '2026-08-01', amount: 2000, catId: 'food' }),
      ],
      budget: { ...BUD, spent_at_start: 0 },
    });
    t.renderMain();
    const top = document.querySelector('#cat-breakdown .cb-row:not(.cb-row--empty) .cb-amt').textContent;
    const spentByRemaining = 30000 - num(txt('today-num'));
    expect(num(top)).toBe(spentByRemaining);
  });
});

describe('экран бюджета после завершения периода', () => {
  it('в поле даты не должно оставаться прошедшего дедлайна', () => {
    seed(t, { txs: [], budget: { ...BUD, deadline: '2026-07-20', set_at: '2026-07-01', spent_at_start: 0 } });
    window.goBudget();
    const shown = $('bud-date-input').value;
    // Либо пусто, либо дата не в прошлом — иначе подпись и сохраняемое значение разъезжаются
    expect(shown === '' || shown >= t.todayStr()).toBe(true);
  });

  it('после завершения периода требуется выбрать новую дату, а не молча сохранить старую', async () => {
    seed(t, { txs: [], budget: { ...BUD, deadline: '2026-07-20', set_at: '2026-07-01', spent_at_start: 0 } });
    window.goBudget();
    expect(txt('bud-date-label')).toBe('Указать дату');
    await window.saveBudget();
    expect(txt('toast')).toContain('Выберите дату');
    expect(t.S.budget.deadline).toBe('2026-07-20');
  });

  it('новая дата после завершения периода сохраняется корректно', async () => {
    seed(t, { txs: [], budget: { ...BUD, deadline: '2026-07-20', set_at: '2026-07-01', spent_at_start: 0 } });
    window.goBudget();
    $('bud-date-input').value = '2026-08-15';
    window.onBudDateChange();
    expect(txt('bud-date-label')).toBe('до 15 августа');
    await window.saveBudget();
    expect(t.S.budget.deadline).toBe('2026-08-15');
  });
});

describe('период истории после удаления последней записи месяца', () => {
  it('приложение не залипает на месяце, которого больше нет', async () => {
    seed(t, { txs: [tx({ date: '2026-07-05', amount: 100, catId: 'food', id: 'only' })] });
    window.goHistory();
    await tick();
    window.selHistPeriodOption('2026-07');
    window.showTxEdit('only');
    const p = window.deleteTxFromEdit();
    await tick();
    window._confOk();
    await p;
    window.showHistPeriodSheet();
    const options = [...document.querySelectorAll('#hist-period-sheet-list .hps-option.on')];
    // Выбранный месяц обязан присутствовать в списке выбора
    expect(options.length).toBe(1);
  });
});
