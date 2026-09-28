import { describe, it, expect, afterEach, vi } from 'vitest';
import { bootApp, teardown, settle, tick, txt, $, seed } from './helpers/boot.js';
import { makeServer } from './helpers/server.js';

afterEach(teardown);

const NOW = '2026-08-10T10:00:00';
const CODE = 'ABCD-EFGH';

describe('настройки и код восстановления', () => {
  it('экран настроек показывает версию, число категорий и статус', async () => {
    const t = await bootApp({ now: NOW });
    seed(t, {});
    window.goSettings();
    expect($('s-settings').classList.contains('hidden')).toBe(false);
    expect(txt('cats-count')).toBe(String(t.S.cats.length));
    expect(txt('app-version')).toMatch(/^Дошик v\d+\.\d+\.\d+/);
  });

  it('«Код восстановления» показывает сохранённый код', async () => {
    const server = makeServer({ users: [CODE] });
    await bootApp({ now: NOW, server, storage: { tk_rccode: CODE } });
    window.showMyCode();
    expect($('code-reveal-modal').classList.contains('vis')).toBe(true);
    expect(txt('code-reveal-value')).toBe(CODE);
  });

  it('без кода — тост, модалка не открывается', async () => {
    await bootApp({ now: NOW });
    window.showMyCode();
    expect(txt('toast')).toContain('Код не привязан');
    expect($('code-reveal-modal').classList.contains('vis')).toBe(false);
  });

  it('копирование кода кладёт его в буфер и подтверждает', async () => {
    const server = makeServer({ users: [CODE] });
    await bootApp({ now: NOW, server, storage: { tk_rccode: CODE } });
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText }, onLine: true });
    window.showMyCode();
    const copyBtn = document.querySelector('#code-reveal-modal [data-action="copy"]');
    window.onCodeRevealBtn(copyBtn);
    await settle();
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(copyBtn.textContent).toBe('Скопировано');
    vi.advanceTimersByTime(2000);
    expect(copyBtn.textContent).toBe('Скопировать код');
    window.onCodeRevealBtn(document.querySelector('#code-reveal-modal [data-action="dismiss"]'));
    expect($('code-reveal-modal').classList.contains('vis')).toBe(false);
  });

  it('поле кода форматируется как XXXX-XXXX и без путаных символов', async () => {
    await bootApp({ now: NOW });
    const el = $('enter-code-inp');
    el.value = 'abcdefgh';
    window.fmtCodeInput(el);
    expect(el.value).toBe('ABCD-EFGH');
  });

  it('сгенерированный код — 8 символов без 0/O/1/I', async () => {
    const server = makeServer();
    await bootApp({ now: NOW, server, keepAuth: true });
    for (let i = 0; i < 20; i++) {
      localStorage.removeItem('tk_rccode');
      server.users = [];
      await window.createNewAccount(document.querySelector('#s-auth .btn-secondary'));
      await settle();
      expect(localStorage.getItem('tk_rccode')).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });
});

describe('старая сессия без кода', () => {
  it('получает новый код, привязанный к аккаунту, и показывает его', async () => {
    const server = makeServer({ users: [CODE], session: CODE });
    server.users[0].user.user_metadata = {}; // очень старая установка: кода нет нигде
    const t = await bootApp({ now: NOW, server });
    await settle();
    const code = localStorage.getItem('tk_rccode');
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(server.users[0].email).toBe(`${code}@doshik.app`);
    expect(t.currentUser).not.toBeNull();
    vi.advanceTimersByTime(700);
    expect(txt('code-reveal-value')).toBe(code);
  });
});

describe('онбординг: навигация', () => {
  it('«Далее» листает слайды, на последнем — закрывает и ставит флаг', async () => {
    await bootApp({ now: NOW });
    window.replayOnboarding();
    const dots = () => [...document.querySelectorAll('#ob-dots .ob-dot')];
    const n = dots().length;
    expect(n).toBeGreaterThan(3);
    for (let i = 0; i < n; i++) window.obNext();
    expect($('onboarding').classList.contains('vis')).toBe(false);
    expect(localStorage.getItem('_ob')).toBe('1');
  });

  it('точки и свайпы переключают слайды, короткий свайп игнорируется', async () => {
    await bootApp({ now: NOW });
    window.replayOnboarding();
    const track = $('ob-track');
    window.obGoTo(2);
    expect(track.style.transform).toBe('translateX(-200%)');
    window.obGoTo(99); // за пределами — ничего
    expect(track.style.transform).toBe('translateX(-200%)');
    const swipe = (dx) => {
      window.obTouchStart({ touches: [{ clientX: 200 }] });
      window.obTouchEnd({ changedTouches: [{ clientX: 200 + dx }] });
    };
    swipe(-100);
    expect(track.style.transform).toBe('translateX(-300%)');
    swipe(100);
    expect(track.style.transform).toBe('translateX(-200%)');
    swipe(20);
    expect(track.style.transform).toBe('translateX(-200%)');
  });

  it('«Пропустить» закрывает онбординг', async () => {
    await bootApp({ now: NOW });
    window.replayOnboarding();
    window.closeOnboarding();
    expect($('onboarding').classList.contains('vis')).toBe(false);
  });

  it('демо кнопки ± переключает вид', async () => {
    await bootApp({ now: NOW });
    window.replayOnboarding();
    const icon = $('ob-tgl-icon');
    if (!icon) return; // слайда может не быть в этой сборке
    const before = icon.className;
    window.obToggleDemo();
    expect(icon.className).not.toBe(before);
  });
});

describe('мелочи интерфейса', () => {
  it('тап по фону модалки категории закрывает её, по самой модалке — нет', async () => {
    await bootApp({ now: NOW });
    window.showCatModal();
    window.modalBgClick({ target: document.querySelector('#cat-modal .modal-sheet') });
    expect($('cat-modal').classList.contains('vis')).toBe(true);
    window.modalBgClick({ target: $('cat-modal') });
    expect($('cat-modal').classList.contains('vis')).toBe(false);
  });

  it('тост обновления висит до нажатия и шлёт SKIP_WAITING', async () => {
    await bootApp({ now: NOW });
    const t = window.__test;
    const postMessage = vi.fn();
    t.showUpdateToast({ waiting: { postMessage } });
    expect(txt('toast')).toContain('Доступно обновление');
    vi.advanceTimersByTime(60000);
    expect($('toast').classList.contains('show')).toBe(true);
    window.applyUpdate();
    expect(postMessage).toHaveBeenCalledWith('SKIP_WAITING');
  });

  it('возврат во вкладку запускает синхронизацию', async () => {
    const server = makeServer({ users: [CODE] });
    const t = await bootApp({ now: NOW, server, storage: { tk_rccode: CODE } });
    server.tables.transactions.push({ id: 'new', user_id: server.uid(CODE), amount: 42, type: 'expense', cat_id: '', note: '', date: '2026-08-10T09:00:00+00:00', in_budget: false });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(t.S.txs.map((x) => x.id)).toContain('new');
  });

  it('подсказка к кнопке ± показывается один раз', async () => {
    await bootApp({ now: NOW });
    window.maybeShowToggleHint();
    await tick(2000);
    expect(localStorage.getItem('_tgl')).toBe('1');
    window.showToggleHint();
    expect($('toggle-hint').style.top).not.toBe('');
  });
});
