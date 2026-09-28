import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { bootApp, teardown, seed, tx, CATS } from './helpers/boot.js';

afterEach(teardown);

const EXP = [
  ...CATS,
  { id: 'fun', name: 'Развлечения', color: '#FF6B6B', icon: '🎮', ctype: 'expense' },
];
const pillIds = () =>
  [...document.querySelectorAll('#cat-row .cat-pill[data-id]')].map((b) => b.dataset.id);

let t;
beforeEach(async () => {
  t = await bootApp({ now: '2026-08-01T10:00:00' });
});

describe('порядок категорий на главном', () => {
  it('без операций — ручной порядок из настроек', () => {
    seed(t, { txs: [], cats: EXP });
    window.goMain();
    t.setType('expense');
    expect(pillIds()).toEqual(['food', 'transport', 'fun']);
  });

  it('частые категории уходят в начало, при равенстве — ручной порядок', () => {
    seed(t, {
      cats: EXP,
      txs: [
        tx({ date: '2026-07-30', amount: 100, catId: 'fun' }),
        tx({ date: '2026-07-29', amount: 100, catId: 'fun' }),
        tx({ date: '2026-07-28', amount: 100, catId: 'transport' }),
      ],
    });
    window.goMain();
    t.setType('expense');
    expect(pillIds()).toEqual(['fun', 'transport', 'food']);
  });

  it('операции старше 90 дней не влияют на порядок', () => {
    seed(t, {
      cats: EXP,
      txs: [
        tx({ date: '2026-03-01', amount: 100, catId: 'fun' }),
        tx({ date: '2026-03-02', amount: 100, catId: 'fun' }),
        tx({ date: '2026-07-28', amount: 100, catId: 'transport' }),
      ],
    });
    window.goMain();
    t.setType('expense');
    expect(pillIds()).toEqual(['transport', 'food', 'fun']);
  });

  it('доходы сортируются по своей частоте', () => {
    seed(t, {
      cats: EXP,
      txs: [tx({ date: '2026-07-30', amount: 500, type: 'income', catId: 'gift' })],
    });
    window.goMain();
    t.setType('income');
    expect(pillIds()).toEqual(['gift', 'salary']);
  });
});
