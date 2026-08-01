import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { bootApp, teardown, seed, tx, CATS, $, txt, tick } from './helpers/boot.js';

afterEach(teardown);

let t;
beforeEach(async () => {
  t = await bootApp({ now: '2026-08-01T10:00:00' });
  seed(t, { txs: [] });
});

describe('создание и правка категорий', () => {
  it('новая категория с экрана категорий получает тип активной вкладки', () => {
    window.goCategories();
    window.selCatSettTab('income');
    window.showCatModal();
    $('cat-name-inp').value = 'Кэшбэк';
    window.selIcon('💵');
    window.selColor('#FF6B6B');
    window.saveCat();
    const cat = t.S.cats[0];
    expect(cat).toMatchObject({ name: 'Кэшбэк', icon: '💵', color: '#FF6B6B', ctype: 'income' });
    expect(cat.id.endsWith('_inc')).toBe(true);
  });

  it('новая категория с главного экрана берёт тип из режима ввода', () => {
    window.goMain();
    t.setType('expense');
    window.showCatModal();
    $('cat-name-inp').value = 'Подписки';
    window.saveCat();
    expect(t.S.cats[0]).toMatchObject({ name: 'Подписки', ctype: 'expense' });
    expect(t.S.cats[0].id.endsWith('_exp')).toBe(true);
  });

  it('пустое название не сохраняется', () => {
    const before = t.S.cats.length;
    window.showCatModal();
    $('cat-name-inp').value = '   ';
    window.saveCat();
    expect(t.S.cats.length).toBe(before);
    expect(txt('toast')).toContain('Введите название');
  });

  it('редактирование меняет имя, иконку и цвет, не трогая id и тип', () => {
    window.goCategories();
    window.showCatModal('food');
    $('cat-name-inp').value = 'Продукты';
    window.selIcon('🍕');
    window.saveCat();
    const cat = t.S.cats.find((c) => c.id === 'food');
    expect(cat).toMatchObject({ id: 'food', name: 'Продукты', icon: '🍕', ctype: 'expense' });
  });

  it('удаление убирает категорию из списка и хранилища', async () => {
    const p = window.deleteCat('transport');
    await tick();
    window._confOk();
    await p;
    expect(t.S.cats.find((c) => c.id === 'transport')).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(t.K.cats)).find((c) => c.id === 'transport')).toBeUndefined();
  });

  it('вкладки на экране категорий разделяют расходы и доходы', () => {
    window.goCategories();
    window.selCatSettTab('expense');
    const names = () =>
      [...document.querySelectorAll('#cat-list .cat-nm-text:not(.cat-add-label)')].map((e) => e.textContent);
    expect(names()).toEqual(['Еда', 'Транспорт']);
    window.selCatSettTab('income');
    expect(names()).toEqual(['Зарплата', 'Подарок']);
  });

  it('имя категории экранируется в списке категорий', () => {
    window.goCategories();
    window.showCatModal();
    $('cat-name-inp').value = '<b>жирный</b>';
    window.saveCat();
    expect($('cat-list').querySelector('b')).toBe(null);
    expect($('cat-list').textContent).toContain('<b>жирный</b>');
  });
});

describe('определение типа категории (determineCtype)', () => {
  it('берёт тип из локального списка', () => {
    expect(t.determineCtype('salary')).toBe('income');
    expect(t.determineCtype('food')).toBe('expense');
  });

  it('понимает суффиксы пользовательских категорий', () => {
    expect(t.determineCtype('c1700000000000_inc')).toBe('income');
    expect(t.determineCtype('c1700000000000_exp')).toBe('expense');
  });

  it('понимает дефолтные id с суффиксом пользователя', () => {
    expect(t.determineCtype('gift_ab12cd34')).toBe('income');
    expect(t.determineCtype('cafe_ab12cd34')).toBe('expense');
  });

  it('неизвестное считает расходом', () => {
    expect(t.determineCtype('чтототакое')).toBe('expense');
  });
});

describe('удалённая категория и старые транзакции', () => {
  it('транзакция с несуществующей категорией не ломает историю', async () => {
    seed(t, { txs: [tx({ date: '2026-07-10', amount: 500, catId: 'удалённая' })], cats: CATS });
    window.goHistory();
    await tick();
    expect(document.querySelectorAll('#hist-content .tx-item').length).toBe(1);
    expect($('hist-content').textContent).toContain('Без категории');
  });

  it('сумма такой транзакции всё равно попадает в итог', async () => {
    seed(t, { txs: [tx({ date: '2026-07-10', amount: 500, catId: 'удалённая' })], cats: CATS });
    window.goHistory();
    await tick();
    expect(txt('hist-exp-total')).toBe('−500 ₽');
  });
});
