import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { bootApp, teardown, seed, tx, $, txt, histTotals, histRows, tick } from './helpers/boot.js';

afterEach(teardown);

const DATA = [
  tx({ date: '2026-07-05', amount: 1000, catId: 'food' }),
  tx({ date: '2026-07-06', amount: 500, catId: 'food' }),
  tx({ date: '2026-07-07', amount: 300, catId: 'transport' }),
  tx({ date: '2026-07-10', amount: 50000, type: 'income', catId: 'salary' }),
  tx({ date: '2026-06-30', amount: 200, catId: 'food' }),
  tx({ date: '2025-12-31', amount: 100, catId: 'food' }),
];

let t;
beforeEach(async () => {
  t = await bootApp({ now: '2026-08-01T10:00:00' });
  seed(t, { txs: DATA });
  window.goHistory();
  await tick();
});

function pick(from, to) {
  window.showHistPeriodSheet();
  if (from != null) { $('hps-from').value = from; window.onHpsDate('from'); }
  if (to != null) { $('hps-to').value = to; window.onHpsDate('to'); }
}

describe('история: свой диапазон дат', () => {
  it('диапазон ограничивает суммы и список, границы включительно', () => {
    pick('2026-06-30', '2026-07-06');
    window.applyHistPeriod();
    expect(histTotals()).toEqual({ exp: -1700, inc: 0 });
    expect(histRows().length).toBe(3);
    expect(txt('hist-period-label')).toBe('30.06–06.07');
    expect($('hist-period-sheet-bg').classList.contains('vis')).toBe(false);
  });

  it('одна дата «С» — показывается этот день', () => {
    pick('2026-07-07');
    expect($('hps-to').value).toBe('2026-07-07');
    window.applyHistPeriod();
    expect(histRows().length).toBe(1);
    expect(txt('hist-period-label')).toBe('7 июл');
  });

  it('«По» раньше «С» — «С» подтягивается, пустой диапазон не применить', () => {
    window.showHistPeriodSheet();
    expect($('hps-apply').disabled).toBe(false); // «За всё время» — тоже выбор
    pick('2026-07-10', '2026-07-05');
    expect($('hps-from').value).toBe('2026-07-05');
    expect($('hps-apply').disabled).toBe(false);
  });

  it('другой год подписывается с годом', () => {
    pick('2025-12-31', '2025-12-31');
    window.applyHistPeriod();
    expect(txt('hist-period-label')).toBe('31 дек 2025');
    expect(histTotals().exp).toBe(-100);
  });

  it('повторное открытие показывает выбранный диапазон, месяц его сбрасывает', () => {
    pick('2026-07-05', '2026-07-07');
    window.applyHistPeriod();
    window.showHistPeriodSheet();
    expect($('hps-from').value).toBe('2026-07-05');
    expect($('hps-to').value).toBe('2026-07-07');
    window.selHistPeriodOption('2026-06');
    expect(txt('hist-period-label')).toBe('Июнь');
    window.showHistPeriodSheet();
    expect($('hps-from').value).toBe('');
  });

  it('после диапазона можно вернуться на «За всё время»', () => {
    pick('2026-07-05', '2026-07-07');
    window.applyHistPeriod();
    window.showHistPeriodSheet();
    // select стоит на заглушке — выбор «За всё время» будет настоящим изменением
    expect($('hps-month').value).toBe('range');
    expect(txt('hps-month-val')).toBe('Выбрать месяц');
    $('hps-month').value = '';
    window.onHpsMonth();
    expect($('hps-from').value).toBe('');
    expect(txt('hps-month-val')).toBe('За всё время');
    window.applyHistPeriod();
    expect(t.S.histPeriod).toBe(null);
    expect(txt('hist-period-label')).toBe('Всё время');
    expect(histRows().length).toBe(6);
  });

  it('даты после выбора месяца перебивают месяц', () => {
    window.showHistPeriodSheet();
    $('hps-month').value = '2026-06';
    window.onHpsMonth();
    $('hps-from').value = '2026-07-06';
    window.onHpsDate('from');
    expect($('hps-month').value).toBe('range');
    window.applyHistPeriod();
    expect(txt('hist-period-label')).toBe('6 июл');
  });

  it('в полях — полное название месяца', () => {
    pick('2026-08-28', '2026-09-03');
    expect(txt('hps-from-val')).toBe('28 августа');
    expect(txt('hps-to-val')).toBe('3 сентября');
    pick('2025-12-31');
    expect(txt('hps-from-val')).toBe('31 декабря 2025');
  });

  it('диапазон внутри месяца и через год подписывается коротко (без года)', () => {
    pick('2026-07-01', '2026-07-07');
    window.applyHistPeriod();
    expect(txt('hist-period-label')).toMatch(/^1–7 июл/);
    pick('2025-12-28', '2026-07-14');
    window.applyHistPeriod();
    expect(txt('hist-period-label')).toBe('28.12–14.07');
  });

  it('фильтр по категории работает внутри диапазона', () => {
    pick('2026-07-01', '2026-07-31');
    window.applyHistPeriod();
    window.selHistTab('food');
    expect(histTotals().exp).toBe(-1500);
  });
});
