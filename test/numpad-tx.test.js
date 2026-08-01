import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { bootApp, teardown, seed, tx, $, txt, tick } from './helpers/boot.js';

afterEach(teardown);

let t;
const amountText = () => $('amount-row').textContent;
const type_ = (s) => [...s].forEach((c) => window.np(c));

const ACTIVE_BUDGET = {
  amount: 30000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01',
  spent_at_start: 0, reset_ts: '2026-08-01T09:00:00.000Z',
};

beforeEach(async () => {
  t = await bootApp({ now: '2026-08-01T10:00:00' });
  seed(t, { txs: [] });
  window.goMain();
});

describe('нампад: ввод суммы', () => {
  it('печатает цифры и форматирует тысячи', () => {
    type_('12345');
    expect(amountText()).toBe('12 345');
  });

  it('первый ноль не залипает', () => {
    type_('05');
    expect(amountText()).toBe('5');
  });

  it('запятая даёт максимум два знака', () => {
    type_('12');
    window.np(',');
    type_('3456');
    expect(amountText()).toBe('12,34');
  });

  it('вторая запятая игнорируется', () => {
    type_('1');
    window.np(',');
    window.np(',');
    type_('5');
    expect(t.S.amount).toBe('1.5');
  });

  it('целая часть ограничена 7 цифрами', () => {
    type_('123456789');
    expect(t.S.amount).toBe('1234567');
  });

  it('запятая недоступна после 7 цифр', () => {
    type_('1234567');
    window.np(',');
    expect(t.S.amount).toBe('1234567');
  });

  it('удаление стирает по символу', () => {
    type_('123');
    window.npDel();
    expect(t.S.amount).toBe('12');
  });

  it('пустая сумма показывает 0', () => {
    type_('1');
    window.npDel();
    expect(amountText()).toBe('0');
  });
});

describe('создание транзакции', () => {
  it('расход без бюджета не создаётся', () => {
    type_('500');
    window.confirm_();
    expect(t.S.txs.length).toBe(0);
    expect(txt('toast')).toContain('Сначала настройте бюджет');
  });

  it('нулевая сумма не создаётся', () => {
    seed(t, { txs: [], budget: ACTIVE_BUDGET });
    window.confirm_();
    expect(t.S.txs.length).toBe(0);
    expect(txt('toast')).toContain('Введите сумму');
  });

  it('расход с бюджетом создаётся, чистит поля и пишется в localStorage', () => {
    seed(t, { txs: [], budget: ACTIVE_BUDGET });
    window.selCat('food');
    $('note-inp').value = '  пятёрочка  ';
    type_('500');
    window.confirm_();
    expect(t.S.txs.length).toBe(1);
    const saved = JSON.parse(localStorage.getItem(t.K.tx));
    expect(saved[0]).toMatchObject({ amount: 500, type: 'expense', catId: 'food', note: 'пятёрочка' });
    expect(t.S.amount).toBe('');
    expect($('note-inp').value).toBe('');
  });

  it('дробная сумма сохраняется как число', () => {
    seed(t, { txs: [], budget: ACTIVE_BUDGET });
    type_('12');
    window.np(',');
    type_('50');
    window.confirm_();
    expect(t.S.txs[0].amount).toBe(12.5);
  });

  it('доход при активном бюджете спрашивает, учитывать ли его в бюджете', () => {
    seed(t, { txs: [], budget: ACTIVE_BUDGET });
    window.toggleType();
    type_('1000');
    window.confirm_();
    expect(t.S.txs.length).toBe(0);
    expect($('inc-budget-sheet').classList.contains('vis')).toBe(true);
    window._incBudConfirm(true);
    expect(t.S.txs.length).toBe(1);
    expect(t.S.txs[0]).toMatchObject({ type: 'income', inBudget: true });
  });

  it('отмена в шторке дохода не создаёт запись', () => {
    seed(t, { txs: [], budget: ACTIVE_BUDGET });
    window.toggleType();
    type_('1000');
    window.confirm_();
    window._incBudCancel();
    expect(t.S.txs.length).toBe(0);
    expect($('inc-budget-sheet').classList.contains('vis')).toBe(false);
  });

  it('доход без бюджета создаётся сразу', () => {
    window.toggleType();
    type_('1000');
    window.confirm_();
    expect(t.S.txs.length).toBe(1);
    expect(t.S.txs[0].type).toBe('income');
  });

  it('отмена через тост удаляет последнюю запись', async () => {
    seed(t, { txs: [], budget: ACTIVE_BUDGET });
    type_('500');
    window.confirm_();
    expect(t.S.txs.length).toBe(1);
    window.toastUndo();
    await tick();
    expect(t.S.txs.length).toBe(0);
    expect(JSON.parse(localStorage.getItem(t.K.tx))).toEqual([]);
  });

  it('переключение типа сбрасывает выбранную категорию', () => {
    window.selCat('food');
    expect(t.S.catId).toBe('food');
    window.toggleType();
    expect(t.S.catId).toBe(null);
    expect(t.S.type).toBe('income');
  });

  it('в строке категорий только категории текущего типа', () => {
    const names = () => [...document.querySelectorAll('#cat-row .cat-pill:not(.add)')].map((b) => b.dataset.id);
    expect(names()).toEqual(['food', 'transport']);
    window.toggleType();
    expect(names()).toEqual(['salary', 'gift']);
  });

  it('транзакция без категории допустима', () => {
    seed(t, { txs: [], budget: ACTIVE_BUDGET });
    type_('100');
    window.confirm_();
    expect(t.S.txs[0].catId).toBe(null);
  });

  it('топ-3 категории на главном считаются по периоду бюджета', () => {
    seed(t, {
      txs: [
        tx({ date: '2026-08-01', amount: 300, catId: 'food' }),
        tx({ date: '2026-08-01', amount: 200, catId: 'food' }),
        tx({ date: '2026-08-01', amount: 100, catId: 'transport' }),
        tx({ date: '2026-07-20', amount: 9999, catId: 'transport' }), // до старта бюджета
      ],
      budget: { ...ACTIVE_BUDGET, reset_ts: null },
    });
    t.renderMain();
    const rows = [...document.querySelectorAll('#cat-breakdown .cb-row:not(.cb-row--empty)')];
    expect(rows.map((r) => r.querySelector('.cb-name').textContent)).toEqual(['Еда', 'Транспорт']);
    expect(rows[0].querySelector('.cb-amt').textContent).toBe('500 ₽');
  });
});
