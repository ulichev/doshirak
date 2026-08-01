import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { bootApp, teardown, seed, tx, $, txt, tick } from './helpers/boot.js';

afterEach(teardown);

let t;
const NOW = '2026-08-01T10:00:00';
const T1 = tx({ date: '2026-07-20T15:30:00', amount: 1500, catId: 'food', note: 'магнит', id: 'a1' });
const T2 = tx({ date: '2026-07-21', amount: 40000, type: 'income', catId: 'salary', id: 'a2' });

beforeEach(async () => {
  t = await bootApp({ now: NOW });
  seed(t, {
    txs: [T1, T2],
    budget: { amount: 30000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01', spent_at_start: 1500 },
  });
  window.goHistory();
  await tick();
});

describe('модалка редактирования транзакции', () => {
  it('открывается с данными записи', () => {
    window.showTxEdit('a1');
    expect($('tx-edit-modal').classList.contains('vis')).toBe(true);
    expect($('tx-edit-amount').value.replace(/\u00A0/g, ' ')).toBe('1 500');
    expect($('tx-edit-note').value).toBe('магнит');
    expect($('tx-edit-avatar').textContent).toBe('🍔');
  });

  it('несуществующий id ничего не открывает', () => {
    window.showTxEdit('нет-такого');
    expect($('tx-edit-modal').classList.contains('vis')).toBe(false);
  });

  it('меняет сумму, категорию и заметку', () => {
    window.showTxEdit('a1');
    $('tx-edit-amount').value = '2 300';
    window.selectEditCat('transport');
    $('tx-edit-note').value = '  метро  ';
    window.saveTxEdit();
    const saved = t.S.txs.find((x) => x.id === 'a1');
    expect(saved).toMatchObject({ amount: 2300, catId: 'transport', note: 'метро' });
    expect(JSON.parse(localStorage.getItem(t.K.tx)).find((x) => x.id === 'a1').amount).toBe(2300);
  });

  it('принимает дробную сумму с запятой', () => {
    window.showTxEdit('a1');
    $('tx-edit-amount').value = '1 234,56';
    window.saveTxEdit();
    expect(t.S.txs.find((x) => x.id === 'a1').amount).toBe(1234.56);
  });

  it('нулевая или мусорная сумма не затирает прежнюю', () => {
    window.showTxEdit('a1');
    $('tx-edit-amount').value = '0';
    window.saveTxEdit();
    expect(t.S.txs.find((x) => x.id === 'a1').amount).toBe(1500);
    window.showTxEdit('a1');
    $('tx-edit-amount').value = 'абв';
    window.saveTxEdit();
    expect(t.S.txs.find((x) => x.id === 'a1').amount).toBe(1500);
  });

  it('поле суммы форматирует ввод на лету', () => {
    window.showTxEdit('a1');
    $('tx-edit-amount').value = '1234567,999';
    window.onTxEditAmtInput();
    expect($('tx-edit-amount').value.replace(/\u00A0/g, ' ')).toBe('1 234 567,99');
  });

  it('меняет дату, сохраняя время', () => {
    window.showTxEdit('a1');
    $('tx-edit-date-input').value = '2026-07-25';
    window.onTxEditDateChange();
    window.saveTxEdit();
    const saved = t.S.txs.find((x) => x.id === 'a1');
    expect(t.localDateStr(saved.date)).toBe('2026-07-25');
    const d = new Date(saved.date);
    expect(d.getHours()).toBe(15);
    expect(d.getMinutes()).toBe(30);
  });

  it('будущая дата отклоняется', () => {
    window.showTxEdit('a1');
    $('tx-edit-date-input').value = '2026-09-01';
    window.onTxEditDateChange();
    expect(txt('toast')).toContain('будущую дату');
    window.saveTxEdit();
    expect(t.localDateStr(t.S.txs.find((x) => x.id === 'a1').date)).toBe('2026-07-20');
  });

  it('сегодняшняя дата допустима', () => {
    window.showTxEdit('a1');
    $('tx-edit-date-input').value = '2026-08-01';
    window.onTxEditDateChange();
    window.saveTxEdit();
    expect(t.localDateStr(t.S.txs.find((x) => x.id === 'a1').date)).toBe('2026-08-01');
  });

  it('закрытие без сохранения не меняет запись', () => {
    window.showTxEdit('a1');
    $('tx-edit-amount').value = '99999';
    window.hideTxEdit();
    window.saveTxEdit();
    expect(t.S.txs.find((x) => x.id === 'a1').amount).toBe(1500);
  });

  it('в модалке дохода предлагаются только доходные категории', () => {
    window.showTxEdit('a2');
    const ids = [...document.querySelectorAll('#tx-edit-cat-list [data-cid]')].map((e) => e.dataset.cid);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => ['salary', 'gift'].includes(id))).toBe(true);
  });

  it('удаление убирает запись из состояния и хранилища', async () => {
    window.showTxEdit('a1');
    const p = window.deleteTxFromEdit();
    await tick();
    window._confOk();
    await p;
    expect(t.S.txs.map((x) => x.id)).toEqual(['a2']);
    expect(JSON.parse(localStorage.getItem(t.K.tx)).length).toBe(1);
  });

  it('отказ в подтверждении оставляет запись', async () => {
    window.showTxEdit('a1');
    const p = window.deleteTxFromEdit();
    await tick();
    window._confNo();
    await p;
    expect(t.S.txs.length).toBe(2);
  });

  it('после правки суммы история и главный экран пересчитываются', () => {
    window.selHistPeriodOption('2026-07');
    window.selHistTab('food');
    window.showTxEdit('a1');
    $('tx-edit-amount').value = '2 500';
    window.saveTxEdit();
    expect(txt('hist-exp-total')).toBe('−2 500 ₽');
  });
});
