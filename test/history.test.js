import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { bootApp, teardown, seed, tx, CATS, $, txt, histTotals, histRows, tick } from './helpers/boot.js';

afterEach(teardown);

// Данные: июль (еда 1000+500, транспорт 300, зарплата 50000, подарок 700)
//         июнь (еда 9000, транспорт 400, зарплата 40000)
const DATA = [
  tx({ date: '2026-07-05', amount: 1000, catId: 'food', note: 'магнит' }),
  tx({ date: '2026-07-06', amount: 500, catId: 'food', note: 'дикси' }),
  tx({ date: '2026-07-07', amount: 300, catId: 'transport' }),
  tx({ date: '2026-07-10', amount: 50000, type: 'income', catId: 'salary' }),
  tx({ date: '2026-07-11', amount: 700, type: 'income', catId: 'gift' }),
  tx({ date: '2026-06-05', amount: 9000, catId: 'food' }),
  tx({ date: '2026-06-06', amount: 400, catId: 'transport' }),
  tx({ date: '2026-06-10', amount: 40000, type: 'income', catId: 'salary' }),
];

let t;
beforeEach(async () => {
  t = await bootApp({ now: '2026-08-01T10:00:00' });
  seed(t, { txs: DATA });
  window.goHistory();
  await tick();
});

describe('история: фильтр по периоду', () => {
  it('«Всё время» показывает все записи и общие суммы', () => {
    expect(histTotals()).toEqual({ exp: -11200, inc: 90700 });
    expect(histRows().length).toBe(8);
    expect(txt('hist-period-label')).toBe('Всё время');
  });

  it('выбор месяца ограничивает и суммы, и список', () => {
    window.selHistPeriodOption('2026-07');
    expect(histTotals()).toEqual({ exp: -1800, inc: 50700 });
    expect(histRows().length).toBe(5);
    expect(txt('hist-period-label')).toBe('Июль');
  });

  it('в списке нет записей из других месяцев', () => {
    window.selHistPeriodOption('2026-06');
    expect(histRows().length).toBe(3);
    expect($('hist-content').textContent).not.toContain('магнит');
    expect(histTotals()).toEqual({ exp: -9400, inc: 40000 });
  });

  it('месяц без записей даёт нули и пустое состояние', () => {
    window.selHistPeriodOption('2026-08');
    expect(histTotals()).toEqual({ exp: 0, inc: 0 });
    expect(histRows().length).toBe(0);
    expect($('hist-content').textContent).toContain('Нет записей');
  });

  it('в списке месяцев только месяцы с данными плюс текущий', () => {
    window.showHistPeriodSheet();
    const html = $('hist-period-sheet-list').innerHTML;
    expect(html).toContain('Июнь 2026');
    expect(html).toContain('Июль 2026');
    expect(html).toContain('Август 2026');
    expect(html).toContain('За всё время');
    expect(html).not.toContain('Май 2026');
  });
});

describe('история: фильтр по категории', () => {
  it('категория сужает суммы и список внутри выбранного месяца', () => {
    window.selHistPeriodOption('2026-07');
    window.selHistTab('food');
    expect(histTotals()).toEqual({ exp: -1500, inc: 0 });
    expect(histRows().length).toBe(2);
  });

  it('та же категория в другом месяце даёт другие числа', () => {
    window.selHistPeriodOption('2026-06');
    window.selHistTab('food');
    expect(histTotals()).toEqual({ exp: -9000, inc: 0 });
    expect(histRows().length).toBe(1);
  });

  it('категория без периода считает за всё время', () => {
    window.selHistTab('food');
    expect(histTotals()).toEqual({ exp: -10500, inc: 0 });
    expect(histRows().length).toBe(3);
  });

  it('доходная категория даёт нулевые расходы', () => {
    window.selHistPeriodOption('2026-07');
    window.selHistTab('salary');
    expect(histTotals()).toEqual({ exp: 0, inc: 50000 });
    expect(histRows().length).toBe(1);
  });

  it('категория сохраняется при смене периода', () => {
    window.selHistTab('food');
    window.selHistPeriodOption('2026-07');
    expect(t.S.histCat).toBe('food');
    expect(histTotals().exp).toBe(-1500);
  });

  it('повторный тап снимает фильтр категории', () => {
    window.selHistPeriodOption('2026-07');
    window.selHistTab('food');
    window.selHistTab('food');
    expect(t.S.histCat).toBe(null);
    expect(histTotals()).toEqual({ exp: -1800, inc: 50700 });
  });

  it('активная категория подсвечена в табах', () => {
    window.selHistTab('food');
    const on = [...document.querySelectorAll('#hist-tabs .ctab.on')];
    expect(on.length).toBe(1);
    expect(on[0].dataset.id).toBe('food');
  });

  it('пустое пересечение категории и месяца — нули и заглушка', () => {
    window.selHistPeriodOption('2026-08');
    window.selHistTab('transport');
    expect(histTotals()).toEqual({ exp: 0, inc: 0 });
    expect($('hist-content').textContent).toContain('Нет записей');
  });
});

describe('история: фильтр по типу', () => {
  it('плитка «Расходы» оставляет только расходы', () => {
    window.selHistType('expense');
    expect(histRows().length).toBe(5);
    expect($('htile-exp').classList.contains('on')).toBe(true);
  });

  it('переключение типа сбрасывает категорию', () => {
    window.selHistTab('food');
    window.selHistType('income');
    expect(t.S.histCat).toBe(null);
    expect(histRows().length).toBe(3);
  });

  it('в табах при выбранном типе только категории этого типа', () => {
    window.selHistType('income');
    const ids = [...document.querySelectorAll('#hist-tabs .ctab')].map((b) => b.dataset.id);
    expect(ids).toEqual(['salary', 'gift']);
  });

  it('тип + категория + период работают вместе', () => {
    window.selHistType('expense');
    window.selHistPeriodOption('2026-07');
    window.selHistTab('transport');
    expect(histRows().length).toBe(1);
    expect(histTotals()).toEqual({ exp: -300, inc: 0 });
  });
});

describe('история: вёрстка списка', () => {
  it('дни идут от новых к старым, внутри дня — итог по дню', () => {
    window.selHistPeriodOption('2026-07');
    const days = [...document.querySelectorAll('#hist-content .day-sec-label')].map((d) =>
      d.firstElementChild.textContent
    );
    expect(days).toEqual(['11 июля', '10 июля', '7 июля', '6 июля', '5 июля']);
  });

  it('битый histPeriod сбрасывается на «Всё время»', () => {
    t.S.histPeriod = 'мусор';
    t.renderHistory();
    expect(t.S.histPeriod).toBe(null);
    expect(histRows().length).toBe(8);
  });

  // AI_ENABLED=false — фича выключена рубильником в src/app.js. Когда вернём её,
  // сюда возвращается прежняя проверка «видна при ≥3 записях».
  it('кнопка AI-анализа скрыта при выключенной фиче', async () => {
    seed(t, { txs: [tx({ date: '2026-07-05', amount: 100, catId: 'food' })] });
    t.renderHistory();
    expect($('analytics-bar').classList.contains('hidden')).toBe(true);
    seed(t, { txs: DATA });
    t.renderHistory();
    expect($('analytics-bar').classList.contains('hidden')).toBe(true);
  });

  it('имя категории экранируется в списке', () => {
    seed(t, {
      txs: [tx({ date: '2026-07-05', amount: 100, catId: 'xss' })],
      cats: [...CATS, { id: 'xss', name: '<img src=x onerror=alert(1)>', color: '#fff', icon: '', ctype: 'expense' }],
    });
    t.renderHistory();
    expect($('hist-content').querySelector('img')).toBe(null);
    expect($('hist-content').textContent).toContain('<img src=x');
  });
});
