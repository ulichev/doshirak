import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, teardown, seed, tx, $, CATS } from './helpers/boot.js';

afterEach(teardown);

const budget = (o = {}) => ({
  amount: 30000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01',
  spent_at_start: 0, reset_ts: '2026-08-01T00:00:00.000Z', ...o,
});
async function saveNewBudget(amount, date) {
  window.goBudget();
  $('bud-amount').value = String(amount);
  window.onBudAmtInput();
  $('bud-date-input').value = date;
  window.onBudDateChange();
  await window.saveBudget();
}

describe('итог периода: что в него входит', () => {
  it('доход «в бюджет» увеличивает рамку, обычный доход — нет', async () => {
    const t = await bootApp({ now: '2026-09-02T10:00:00' });
    seed(t, {
      budget: budget(),
      txs: [
        tx({ date: '2026-08-05', amount: 31000 }),
        tx({ date: '2026-08-06', amount: 2000, type: 'income', inBudget: true }),
        tx({ date: '2026-08-07', amount: 50000, type: 'income', inBudget: false }),
      ],
    });
    await saveNewBudget(10000, '2026-09-10');
    expect(t.S.budHist[0]).toMatchObject({ amount: 30000, income: 2000, spent: 31000, result: 1000 });
  });

  it('новый бюджет через недели после дедлайна: конец периода — дедлайн, поздние траты не в счёт', async () => {
    const t = await bootApp({ now: '2026-09-20T10:00:00' });
    seed(t, {
      budget: budget(),
      txs: [tx({ date: '2026-08-10', amount: 1000 }), tx({ date: '2026-09-05', amount: 99999 })],
    });
    await saveNewBudget(10000, '2026-09-30');
    expect(t.S.budHist[0]).toMatchObject({ from: '2026-08-01', to: '2026-08-30', spent: 1000, early: false });
  });

  it('трата до запуска бюджета в тот же день не входит в период', async () => {
    const t = await bootApp({ now: '2026-08-20T10:00:00' });
    seed(t, {
      budget: budget({ set_at: '2026-08-05', reset_ts: new Date('2026-08-05T15:00:00').toISOString() }),
      txs: [tx({ date: '2026-08-05T09:00:00', amount: 500 }), tx({ date: '2026-08-05T18:00:00', amount: 300 })],
    });
    await saveNewBudget(10000, '2026-08-31');
    expect(t.S.budHist[0].spent).toBe(300);
  });

  it('топ категорий хранит имя — удаление категории не ломает историю', async () => {
    const t = await bootApp({ now: '2026-09-02T10:00:00' });
    seed(t, {
      budget: budget(),
      txs: [tx({ date: '2026-08-05', amount: 700, catId: 'transport' }), tx({ date: '2026-08-06', amount: 300, catId: 'food' })],
    });
    await saveNewBudget(10000, '2026-09-10');
    t.S.cats = t.S.cats.filter((c) => c.id !== 'transport');
    window.goBudget();
    const card = document.querySelector('#bh-list .bh-item').textContent;
    expect(card).toContain('Транспорт');
    expect(card).toContain('70%');
  });

  it('больше трёх категорий — в топе три самые крупные', async () => {
    const t = await bootApp({ now: '2026-09-02T10:00:00' });
    seed(t, {
      budget: budget(),
      txs: [
        tx({ date: '2026-08-05', amount: 10, catId: 'food' }),
        tx({ date: '2026-08-05', amount: 40, catId: 'transport' }),
        tx({ date: '2026-08-05', amount: 30 }),
        tx({ date: '2026-08-05', amount: 20, catId: 'food' }),
        tx({ date: '2026-08-05', amount: 5, catId: 'x-unknown' }),
      ],
    });
    await saveNewBudget(10000, '2026-09-10');
    // трата удалённой категории (x-unknown) считается вместе с «Без категории»
    expect(t.S.budHist[0].top.map((c) => [c.name, c.amount])).toEqual([['Транспорт', 40], ['Без категории', 35], ['Еда', 30]]);
  });

  it('доходы в топ категорий трат не попадают', async () => {
    const t = await bootApp({ now: '2026-09-02T10:00:00' });
    seed(t, {
      cats: CATS,
      budget: budget(),
      txs: [tx({ date: '2026-08-05', amount: 100, catId: 'food' }), tx({ date: '2026-08-05', amount: 9000, type: 'income', catId: 'salary' })],
    });
    await saveNewBudget(10000, '2026-09-10');
    expect(t.S.budHist[0].top.map((c) => c.name)).toEqual(['Еда']);
  });

  it('несколько смен бюджета подряд — периоды не пересекаются и идут новые сверху', async () => {
    const t = await bootApp({ now: '2026-08-10T10:00:00' });
    seed(t, { budget: budget(), txs: [tx({ date: '2026-08-03', amount: 100 })] });
    await saveNewBudget(5000, '2026-08-20'); // досрочно: 1–10 авг
    t.S.txs.push(tx({ date: '2026-08-10T23:00:00', amount: 50 }));
    // через 5 дней снова меняем
    const { vi } = await import('vitest');
    vi.setSystemTime(new Date('2026-08-15T10:00:00'));
    await saveNewBudget(7000, '2026-08-31');
    expect(t.S.budHist.map((r) => [r.from, r.to])).toEqual([['2026-08-10', '2026-08-15'], ['2026-08-01', '2026-08-10']]);
    expect(t.S.budHist[0].spent).toBe(50);
  });

  it('повторное сохранение того же бюджета в день запуска не плодит пустые периоды', async () => {
    const t = await bootApp({ now: '2026-08-10T10:00:00' });
    seed(t, {});
    await saveNewBudget(5000, '2026-08-20');
    await saveNewBudget(6000, '2026-08-20');
    await saveNewBudget(7000, '2026-08-25');
    expect(t.S.budHist).toEqual([]);
    expect(t.S.budget.amount).toBe(7000);
  });
});

describe('устойчивость хранилища', () => {
  it('битый JSON истории периодов не роняет приложение', async () => {
    const t = await bootApp({ now: '2026-08-10T10:00:00' });
    localStorage.setItem(t.K.budHist, '{oops');
    localStorage.setItem(t.K.budget, JSON.stringify(budget()));
    t.loadLocal();
    window.goBudget();
    expect(t.S.budHist).toEqual([]);
  });

  it('история переживает перезапуск в том же порядке', async () => {
    const t = await bootApp({ now: '2026-09-02T10:00:00' });
    seed(t, { budget: budget(), txs: [tx({ date: '2026-08-05', amount: 100 })] });
    await saveNewBudget(10000, '2026-09-10');
    const before = JSON.stringify(t.S.budHist);
    t.loadLocal();
    expect(JSON.stringify(t.S.budHist)).toBe(before);
  });

  it('оффлайн-очередь переживает перезапуск', async () => {
    const t = await bootApp({ now: '2026-08-10T10:00:00' });
    localStorage.setItem('tk_oq', '[{"op":"pushTx","data":{"id":"q"}}]');
    const t2 = await bootApp({ now: '2026-08-10T10:00:00', storage: { tk_oq: [{ op: 'pushTx', data: { id: 'q' } }] } });
    expect(JSON.parse(localStorage.getItem('tk_oq'))).toHaveLength(1);
    expect(t && t2).toBeTruthy();
  });

  it('битая оффлайн-очередь не роняет приложение', async () => {
    const t = await bootApp({ now: '2026-08-10T10:00:00', storage: { tk_oq: '{bad' } });
    expect(t.S).toBeTruthy();
  });
});
