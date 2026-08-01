import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { bootApp, teardown, seed, tx, CATS, txt, tick } from './helpers/boot.js';

afterEach(teardown);

let t;
beforeEach(async () => {
  t = await bootApp({ now: '2026-08-01T10:00:00' });
  seed(t, { txs: [] });
});

const nb = (s) => String(s).replace(/\u00A0/g, ' ');

describe('форматирование чисел', () => {
  it('разделяет тысячи', () => {
    expect(nb(t.fmt(1234567))).toBe('1 234 567');
    expect(nb(t.fmt(999))).toBe('999');
  });

  it('округляет до двух знаков', () => {
    expect(nb(t.fmt(12.345))).toBe('12,35');
    expect(nb(t.fmt(12.3))).toBe('12,3');
    expect(nb(t.fmt(12))).toBe('12');
  });

  it('fmtThousands работает со строками и дробями', () => {
    expect(nb(t.fmtThousands('1000000'))).toBe('1 000 000');
    expect(nb(t.fmtThousands('1234.5'))).toBe('1 234.5');
    expect(t.fmtThousands('')).toBe('');
  });

  it('esc экранирует html', () => {
    expect(t.esc('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});

describe('склонения', () => {
  it('дни', () => {
    expect(t.pluralDays(1)).toBe('день');
    expect(t.pluralDays(2)).toBe('дня');
    expect(t.pluralDays(5)).toBe('дней');
    expect(t.pluralDays(11)).toBe('дней');
    expect(t.pluralDays(21)).toBe('день');
    expect(t.pluralDays(22)).toBe('дня');
    expect(t.pluralDays(112)).toBe('дней');
    expect(t.pluralDays(101)).toBe('день');
  });

  it('произвольные слова', () => {
    expect(t.plural(1, 'минуту', 'минуты', 'минут')).toBe('минуту');
    expect(t.plural(3, 'минуту', 'минуты', 'минут')).toBe('минуты');
    expect(t.plural(15, 'минуту', 'минуты', 'минут')).toBe('минут');
  });
});

describe('даты', () => {
  it('todayStr — локальная дата', () => {
    expect(t.todayStr()).toBe('2026-08-01');
  });

  it('localDateStr не съезжает на сутки', () => {
    expect(t.localDateStr(new Date('2026-07-20T12:00:00').toISOString())).toBe('2026-07-20');
  });

  it('fmtDate знает «Сегодня» и «Вчера»', () => {
    expect(t.fmtDate('2026-08-01')).toBe('Сегодня');
    expect(t.fmtDate('2026-07-31')).toBe('Вчера');
    expect(t.fmtDate('2026-07-20')).toBe('20 июля');
  });

  it('«Вчера» корректно работает на границе месяца', async () => {
    teardown();
    t = await bootApp({ now: '2026-03-01T10:00:00' });
    expect(t.fmtDate('2026-02-28')).toBe('Вчера');
  });

  it('daysBetween считает включительно-разностно', () => {
    expect(t.daysBetween('2026-08-01', '2026-08-10')).toBe(9);
    expect(t.daysBetween('2026-08-01', '2026-08-01')).toBe(0);
    expect(t.daysBetween('2026-08-10', '2026-08-01')).toBe(-9);
  });

  it('daysBetween переживает перевод часов', () => {
    // конец марта / конец октября — типичные DST-переходы
    expect(t.daysBetween('2026-03-25', '2026-04-05')).toBe(11);
    expect(t.daysBetween('2026-10-20', '2026-11-05')).toBe(16);
  });

  it('daysUntil не опускается ниже 1', () => {
    expect(t.daysUntil('2026-08-10')).toBe(9);
    expect(t.daysUntil('2026-08-01')).toBe(1);
    expect(t.daysUntil('2026-07-01')).toBe(1);
    expect(t.daysUntil(null)).toBe(1);
  });

  it('daysToDeadline обратен daysUntil', () => {
    expect(t.daysToDeadline(1)).toBe('2026-08-01');
    expect(t.daysToDeadline(30)).toBe('2026-08-30');
  });
});

describe('экспорт и импорт', () => {
  const DATA = [
    tx({ date: '2026-07-05', amount: 1000, catId: 'food', id: 'x1' }),
    tx({ date: '2026-07-10', amount: 5000, type: 'income', catId: 'salary', id: 'x2' }),
  ];

  function importFile(obj) {
    let onload;
    const FR = vi.fn(function () {
      this.readAsText = () => onload({ target: { result: JSON.stringify(obj) } });
      Object.defineProperty(this, 'onload', { set(fn){ onload = fn; } });
    });
    vi.stubGlobal('FileReader', FR);
    const input = { files: [new Blob()], value: 'x' };
    return window.importData({ target: input });
  }

  it('экспорт отдаёт транзакции, категории и бюджет', () => {
    seed(t, { txs: DATA, budget: { amount: 10000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01' } });
    let captured = null;
    vi.stubGlobal('URL', { createObjectURL: (b) => ((captured = b), 'blob:x'), revokeObjectURL: () => {} });
    window.exportData();
    expect(captured).toBeTruthy();
    expect(captured.type).toBe('application/json');
  });

  it('импорт заменяет данные', async () => {
    importFile({ txs: DATA, cats: CATS, budget: { amount: 7000, days: 10, deadline: '2026-08-10', set_at: '2026-08-01' } });
    await tick();
    window._confOk();
    await tick();
    expect(t.S.txs.map((x) => x.id)).toEqual(['x1', 'x2']);
    expect(t.S.budget.amount).toBe(7000);
    expect(JSON.parse(localStorage.getItem(t.K.tx)).length).toBe(2);
  });

  it('файл без нужных полей отклоняется', async () => {
    seed(t, { txs: DATA });
    importFile({ nonsense: true });
    await tick();
    expect(txt('toast')).toContain('Неверный формат');
    expect(t.S.txs.length).toBe(2);
  });

  it('отказ в подтверждении оставляет данные как были', async () => {
    seed(t, { txs: DATA });
    importFile({ txs: [], cats: CATS });
    await tick();
    window._confNo();
    await tick();
    expect(t.S.txs.length).toBe(2);
  });

  it('импорт без spent_at_start восстанавливает базу по дате старта', async () => {
    importFile({
      txs: [tx({ date: '2026-07-01', amount: 3000, id: 'old' }), tx({ date: '2026-08-01', amount: 200, id: 'new' })],
      cats: CATS,
      budget: { amount: 10000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01' },
    });
    await tick();
    window._confOk();
    await tick();
    expect(t.S.budget.spent_at_start).toBe(3000);
  });
});

describe('оффлайн-очередь', () => {
  it('без пользователя транзакция всё равно сохраняется локально', () => {
    seed(t, {
      txs: [],
      budget: { amount: 5000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01', spent_at_start: 0 },
    });
    window.goMain();
    window.np('1');
    window.np('0');
    window.np('0');
    window.confirm_();
    expect(JSON.parse(localStorage.getItem(t.K.tx)).length).toBe(1);
    expect(t.currentUser).toBe(null);
  });
});
