import { vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
const BODY = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1];

// Прокручивает микротаски и таймеры с нулевой задержкой (goHistory рендерит через setTimeout 0)
export async function tick(ms = 1) {
  await Promise.resolve();
  vi.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Поднимает приложение в jsdom на «сегодня» = now.
 * Возвращает window.__test — состояние S и внутренние хелперы.
 */
export async function bootApp({ now = '2026-08-01T10:00:00' } = {}) {
  vi.useFakeTimers({ now: new Date(now) });
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = BODY;
  vi.resetModules();
  await import('../../src/app.js');
  await tick();
  // Приложение без аккаунта показывает экран входа — убираем его, работаем с основным UI
  document.getElementById('s-auth').style.display = 'none';
  return window.__test;
}

export function teardown() {
  vi.useRealTimers();
}

/** Транзакция: дата задаётся как 'YYYY-MM-DD' (полдень локального времени) или ISO-строкой */
let _n = 0;
export function tx({ date, amount, type = 'expense', catId = null, note = '', inBudget, id }) {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(date + 'T12:00:00').toISOString()
    : new Date(date).toISOString();
  const t = { id: id || 'tx' + (++_n), amount, type, catId, note, date: iso };
  if (inBudget !== undefined) t.inBudget = inBudget;
  return t;
}

export const CATS = [
  { id: 'food', name: 'Еда', color: '#F5A623', icon: '🍔', ctype: 'expense' },
  { id: 'transport', name: 'Транспорт', color: '#4A9EFF', icon: '🚌', ctype: 'expense' },
  { id: 'salary', name: 'Зарплата', color: '#3DBD74', icon: '💼', ctype: 'income' },
  { id: 'gift', name: 'Подарок', color: '#AF6FE8', icon: '🎁', ctype: 'income' },
];

/** Кладёт данные в localStorage и поднимает их штатным loadLocal() */
export function seed(t, { txs = [], cats = CATS, budget = null } = {}) {
  localStorage.setItem(t.K.tx, JSON.stringify(txs));
  localStorage.setItem(t.K.cats, JSON.stringify(cats));
  if (budget) localStorage.setItem(t.K.budget, JSON.stringify(budget));
  t.loadLocal();
}

export const $ = (id) => document.getElementById(id);
/** textContent с нормализацией неразрывных пробелов (toLocaleString('ru-RU') даёт U+00A0) */
export const txt = (id) => ($(id) ? $(id).textContent.replace(/\u00A0/g, ' ') : null);
/** Суммы из плиток истории как числа: '−1 500 ₽' → -1500 */
export function histTotals() {
  const num = (s) =>
    Number(
      String(s)
        .replace(/[\s\u00A0₽]/g, '')
        .replace('−', '-')
        .replace(',', '.')
    ) || 0;
  return { exp: num(txt('hist-exp-total')), inc: num(txt('hist-inc-total')) };
}
export const histRows = () => [...document.querySelectorAll('#hist-content .tx-item')];
