import { describe, it, expect, afterEach } from 'vitest';
import { bootApp, teardown, seed, tx, $, txt } from './helpers/boot.js';

afterEach(teardown);

const budget = (o = {}) => ({
  amount: 30000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01',
  spent_at_start: 0, reset_ts: '2026-08-01T00:00:00.000Z', ...o,
});
const setForm = (amount, date) => {
  $('bud-amount').value = String(amount);
  window.onBudAmtInput();
  $('bud-date-input').value = date;
  window.onBudDateChange();
};

describe('прошлые периоды бюджета', () => {
  it('новый бюджет после завершённого периода сохраняет итог старого (перерасход)', async () => {
    const t = await bootApp({ now: '2026-09-02T10:00:00' });
    seed(t, {
      txs: [
        tx({ date: '2026-08-05', amount: 20000, catId: 'food' }),
        tx({ date: '2026-08-12', amount: 4000, catId: 'transport' }),
        tx({ date: '2026-08-20', amount: 11000 }),
        tx({ date: '2026-08-10', amount: 2000, type: 'income', inBudget: true }),
        tx({ date: '2026-09-01', amount: 999 }), // после дедлайна — не в периоде
      ],
      budget: budget(),
    });
    window.goBudget();
    setForm(40000, '2026-09-30');
    await window.saveBudget();

    expect(t.S.budHist).toHaveLength(1);
    // Топ категорий — снимок с именами, чтобы пережить переименование/удаление категории
    expect(t.S.budHist[0].top.map((c) => [c.name, c.amount])).toEqual([
      ['Еда', 20000], ['Без категории', 11000], ['Транспорт', 4000],
    ]);
    expect(t.S.budHist[0]).toMatchObject({
      from: '2026-08-01', to: '2026-08-30', amount: 30000, spent: 35000, income: 2000, result: -3000, early: false,
    });
    // История переживает перезапуск
    t.loadLocal();
    expect(t.S.budHist[0].result).toBe(-3000);
  });

  it('досрочная смена бюджета — период с пометкой «досрочно», конец = сегодня', async () => {
    const t = await bootApp({ now: '2026-08-15T10:00:00' });
    seed(t, { txs: [tx({ date: '2026-08-03', amount: 10000 })], budget: budget() });
    window.goBudget();
    setForm(20000, '2026-08-31');
    await window.saveBudget();
    expect(t.S.budHist[0]).toMatchObject({ from: '2026-08-01', to: '2026-08-15', result: 20000, early: true });
  });

  it('правка бюджета в день запуска или без трат — не период', async () => {
    const t = await bootApp({ now: '2026-08-01T15:00:00' });
    seed(t, { txs: [tx({ date: '2026-08-01T12:00:00', amount: 500 })], budget: budget() });
    expect(t.snapshotBudgetPeriod()).toBeNull();

    const t2 = await bootApp({ now: '2026-08-10T15:00:00' });
    seed(t2, { txs: [], budget: budget() });
    expect(t2.snapshotBudgetPeriod()).toBeNull();
  });

  it('новый бюджет не стирает прошлые периоды — история только растёт', async () => {
    const t = await bootApp({ now: '2026-09-02T10:00:00' });
    const old = { id: 'old', from: '2026-07-01', to: '2026-07-31', deadline: '2026-07-31', amount: 20000, spent: 21000, income: 0, result: -1000, early: false, top: [] };
    seed(t, { txs: [tx({ date: '2026-08-05', amount: 1000 })], budget: budget() });
    t.S.budHist = [old];
    window.goBudget();
    setForm(40000, '2026-09-30');
    await window.saveBudget();
    expect(t.S.budHist.map((r) => r.to)).toEqual(['2026-08-30', '2026-07-31']);
    expect(JSON.parse(localStorage.getItem(t.K.budHist))).toHaveLength(2);
  });

  it('подпись к сохранению обещает итог в истории, только если он туда попадёт', async () => {
    const t = await bootApp({ now: '2026-08-10T10:00:00' });
    seed(t, { txs: [tx({ date: '2026-08-05', amount: 1000 })], budget: budget() });
    window.goBudget();
    expect(txt('bud-change-hint')).toContain('Новый бюджет — новый период');
    expect(txt('bud-change-sub')).toContain('Итог текущего сохранится ниже.');

    const t2 = await bootApp({ now: '2026-08-01T15:00:00' }); // правка в день запуска
    seed(t2, { txs: [tx({ date: '2026-08-01T12:00:00', amount: 500 })], budget: budget() });
    window.goBudget();
    expect(txt('bud-change-sub')).toContain('Топ трат на главном начнётся с нуля');
    expect(txt('bud-change-sub')).not.toContain('Итог текущего');
  });

  it('первый бюджет ничего не архивирует', async () => {
    const t = await bootApp({ now: '2026-08-01T10:00:00' });
    seed(t, { txs: [] });
    window.goBudget();
    setForm(10000, '2026-08-10');
    await window.saveBudget();
    expect(t.S.budHist).toEqual([]);
  });

  it('экран бюджета сразу показывает сводку и карточки прошлых периодов вместо лапши', async () => {
    const t = await bootApp({ now: '2026-09-02T10:00:00' });
    seed(t, { budget: budget({ deadline: '2026-09-30', set_at: '2026-09-01', reset_ts: '2026-09-01T00:00:00.000Z' }) });
    t.S.budHist = [
      { id: 'a', from: '2026-08-01', to: '2026-08-31', deadline: '2026-08-31', amount: 30000, spent: 33000, income: 0, result: -3000, early: false,
        top: [{ id: 'food', name: 'Еда', icon: '🍔', color: '#F5A623', amount: 16500 }] },
      { id: 'b', from: '2026-07-01', to: '2026-07-31', deadline: '2026-07-31', amount: 30000, spent: 25000, income: 0, result: 5000, early: false },
    ];
    window.goBudget();
    expect($('bh-empty').style.display).toBe('none');
    // лапша остаётся — в конце прокрутки
    expect(document.querySelector('#s-budget .bud-noodles').style.display).toBe('');
    expect(document.querySelector('#s-budget .budget-screen-content').classList.contains('has-hist')).toBe(true);
    expect(txt('bh-stats')).toBe('Перерасход в 1 из 2 периодов');
    expect([...document.querySelectorAll('#bh-stats .bh-seg')].map((e) => e.className)).toEqual([
      'bh-seg bh-seg--pos', 'bh-seg bh-seg--neg', // старые слева
    ]);
    const items = document.querySelectorAll('#bh-list .bh-item');
    expect(items).toHaveLength(2);
    const t0 = items[0].textContent.replace(/\u00A0/g, ' ');
    expect(t0).toContain('1–31 авг');
    expect(t0).toContain('Перерасход 3 000 ₽');
    expect(t0).toContain('на 10% больше');
    expect(t0).toContain('Еда');
    expect(t0).toContain('16 500 ₽');
    expect(t0).toContain('50%'); // доля от всех трат периода, а не от топ-3
    expect(items[1].classList.contains('bh-item--pos')).toBe(true);
    expect(items[1].textContent.replace(/\u00A0/g, ' ')).toContain('Осталось 5 000 ₽');
  });

  it('без истории блок скрыт, лапша на месте', async () => {
    const t = await bootApp({ now: '2026-08-01T10:00:00' });
    seed(t, {});
    window.goBudget();
    expect($('bh-empty').style.display).toBe('');
    expect($('bh-stats').style.display).toBe('none');
    expect(txt('bh-empty')).toContain('Задай бюджет');
    expect(document.querySelector('#s-budget .bud-noodles').style.display).toBe('');
  });

  it('пустое состояние при активном бюджете называет дату первого итога', async () => {
    const t = await bootApp({ now: '2026-08-05T10:00:00' });
    seed(t, { budget: budget() });
    window.goBudget();
    expect(txt('bh-empty')).toContain('после 30 августа');
  });

  it('синк: объединяет сервер и локальные записи, пропускает старые строки без итога', async () => {
    const t = await bootApp({ now: '2026-09-02T10:00:00' });
    seed(t, {});
    t.S.budHist = [{ id: 'loc', from: '2026-08-01', to: '2026-08-31', deadline: '2026-08-31', amount: 1, spent: 0, income: 0, result: 1, early: false }];
    t.mergeBudHist([
      { id: 'srv', start_day: '2026-07-01', end_day: '2026-07-31', deadline: '2026-07-31', amount: '100', spent: '150', income: '0', result: '-50', early: false, ts: '2026-08-01T00:00:00Z' },
      { id: 'old', amount: 5000, days: 30, deadline: '2025-01-01', prev_amount: null, ts: '2025-01-01T00:00:00Z' },
    ]);
    expect(t.S.budHist.map((r) => r.id)).toEqual(['loc', 'srv']);
    expect(t.S.budHist[1].result).toBe(-50);
  });

  it('старая «история бюджета» из прошлых версий (tk_budhist) не ломает экран и синк', async () => {
    const t = await bootApp({ now: '2026-09-28T10:00:00' });
    // Формат старых версий: без дат периода и итога — так было на реальном iPhone
    localStorage.setItem('tk_budhist', JSON.stringify([
      { id: 'b1', ts: '2026-05-28T10:00:00Z', amount: 20000, days: 30, deadline: '2026-06-27', prev_amount: 0 },
    ]));
    seed(t, { budget: budget({ deadline: '2026-09-30' }) });
    expect(t.S.budHist).toEqual([]);
    expect(localStorage.getItem('tk_budhist')).toBeNull(); // старый ключ вычищен
    window.goBudget();
    expect($('bh-empty').style.display).toBe('');
    expect(document.querySelectorAll('#bh-list .bh-item')).toHaveLength(0);

    // Даже если битая запись окажется в памяти — синк её не шлёт и не показывает
    t.S.budHist = [{ id: 'bad', amount: 1 }];
    t.mergeBudHist([]);
    expect(t.S.budHist).toEqual([]);
    expect(t.isBudHistRec({ id: 'x', from: '2026-08-01', to: '2026-08-31', amount: 1, spent: 0, result: 1 })).toBe(true);
  });

  it('диапазон дат: один месяц, через месяцы, прошлый год', async () => {
    const t = await bootApp({ now: '2026-09-02T10:00:00' });
    expect(t.fmtBudHistRange('2026-08-01', '2026-08-30')).toBe('1–30 авг');
    expect(t.fmtBudHistRange('2026-08-28', '2026-09-03')).toBe('28 авг – 3 сент');
    expect(t.fmtBudHistRange('2025-12-20', '2026-01-10')).toBe('20 дек 2025 – 10 янв');
  });
});
