import { describe, it, expect, afterEach, vi } from 'vitest';
import { bootApp, teardown, settle, tick, txt, $ } from './helpers/boot.js';
import { makeServer } from './helpers/server.js';

afterEach(teardown);

const NOW = '2026-08-10T10:00:00';
const A = 'AAAA-AAAA';
const B = 'BBBB-BBBB';
const BUDGET = { amount: 30000, days: 30, deadline: '2026-08-30', set_at: '2026-08-01', spent_at_start: 0, reset_ts: '2026-08-01T00:00:00.000Z' };
const tx = (id, o = {}) => ({ id, amount: 100, type: 'expense', catId: null, note: '', date: '2026-08-09T10:00:00.000Z', ...o });

async function freshStart(server) {
  return bootApp({ now: NOW, server, keepAuth: true });
}

describe('«Начать с нуля»', () => {
  it('создаёт аккаунт, сохраняет код, засевает категории и открывает онбординг', async () => {
    const server = makeServer();
    const t = await freshStart(server);
    expect($('s-auth').style.display).toBe('flex');
    await window.createNewAccount(document.querySelector('#s-auth .btn-secondary'));
    await settle();
    const code = localStorage.getItem('tk_rccode');
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(server.users.map((u) => u.email)).toEqual([`${code}@doshik.app`]);
    expect(t.currentUser).not.toBeNull();
    expect(server.tables.categories.length).toBeGreaterThanOrEqual(10);
    expect($('onboarding').classList.contains('vis') || $('onboarding').classList.contains('show') || getComputedStyle($('onboarding')).display !== 'none').toBe(true);
  });

  it('без сети — работает локально, код сохранён, ошибка подписана', async () => {
    const server = makeServer();
    server.offline = true;
    const t = await freshStart(server);
    const btn = document.querySelector('#s-auth .btn-secondary');
    await window.createNewAccount(btn);
    await settle();
    expect(t.currentUser).toBeNull();
    expect(localStorage.getItem('tk_rccode')).toBeTruthy();
    expect($('s-auth').style.display).toBe('none');
    expect(txt('auth-err')).toContain('Ошибка соединения');
    expect(btn.disabled).toBe(false);
  });
});

describe('«Войти по коду» с экрана входа', () => {
  it('короткий код не отправляется', async () => {
    const server = makeServer({ users: [A] });
    await freshStart(server);
    $('auth-code').value = 'AAAA';
    await window.recoverWithCode();
    expect(txt('auth-err')).toContain('8 символов');
    expect(server.calls.some((c) => c.auth === 'signIn')).toBe(false);
  });

  it('неизвестный код — «Код не найден»', async () => {
    const server = makeServer({ users: [A] });
    await freshStart(server);
    $('auth-code').value = 'ZZZZ-ZZZZ';
    await window.recoverWithCode();
    expect(txt('auth-err')).toContain('Код не найден');
  });

  it('код вводится без дефиса и в нижнем регистре', async () => {
    const server = makeServer({ users: [A] });
    const t = await freshStart(server);
    $('auth-code').value = 'aaaaaaaa';
    await window.recoverWithCode();
    await settle();
    expect(t.currentUser).not.toBeNull();
    expect(localStorage.getItem('tk_rccode')).toBe(A);
  });

  it('верный код подтягивает данные аккаунта и выбрасывает чужие локальные', async () => {
    const server = makeServer({ users: [A] });
    const uid = server.uid(A);
    server.tables.transactions = [{ id: 'srv', user_id: uid, amount: 777, type: 'expense', cat_id: '', note: '', date: '2026-08-09T10:00:00+00:00', in_budget: false }];
    server.tables.categories = [{ id: 'c1', user_id: uid, name: 'Еда', color: '#fff', icon: '', ctype: 'expense', sort_order: 0 }];
    const t = await bootApp({ now: NOW, server, keepAuth: true, storage: { tk_tx: [tx('foreign')] } });
    $('auth-code').value = A;
    await window.recoverWithCode();
    await settle();
    expect(t.S.txs.map((x) => x.id)).toEqual(['srv']);
    expect(txt('sync-title')).toBe('Синхронизировано');
  });
});

describe('«Войти с другим кодом» из настроек', () => {
  it('переключает аккаунт: данные — только нового', async () => {
    const server = makeServer({ users: [A, B] });
    server.tables.transactions = [{ id: 'b1', user_id: server.uid(B), amount: 5, type: 'expense', cat_id: '', note: '', date: '2026-08-09T10:00:00+00:00', in_budget: false }];
    const t = await bootApp({ now: NOW, server, storage: { tk_rccode: A, tk_tx: [tx('a1')] } });
    window.showEnterCodeModal();
    $('enter-code-inp').value = B;
    await window.submitEnterCode();
    await settle();
    expect(t.currentUser.id).toBe(server.uid(B));
    expect(t.S.txs.map((x) => x.id)).toEqual(['b1']);
    expect(localStorage.getItem('tk_rccode')).toBe(B);
  });

  it('неотправленные траты прошлого аккаунта не утекают в новый', async () => {
    const server = makeServer({ users: [A, B], session: A }); // сессия A сохранена на телефоне
    server.offline = true;
    const t = await bootApp({ now: NOW, server, storage: { tk_rccode: A, tk_budget: BUDGET } });
    expect(t.currentUser.id).toBe(server.uid(A));
    // у A без сети накопилась трата в очереди
    t.S.budget = { ...BUDGET };
    for (const ch of '123') window.np(ch);
    window.confirm_();
    await settle();
    expect(JSON.parse(localStorage.getItem('tk_oq'))).toHaveLength(1);
    // сеть вернулась — но пользователь сразу входит в аккаунт B
    server.offline = false;
    window.showEnterCodeModal();
    $('enter-code-inp').value = B;
    await window.submitEnterCode();
    await settle();
    window.dispatchEvent(new Event('online'));
    await settle();
    const leaked = server.tables.transactions.filter((r) => r.user_id === server.uid(B));
    expect(leaked).toEqual([]);
  });

  it('неотправленное прошлого аккаунта дойдёт, когда в него вернутся', async () => {
    const server = makeServer({ users: [A, B], session: A });
    server.offline = true;
    const t = await bootApp({ now: NOW, server, storage: { tk_rccode: A, tk_budget: BUDGET } });
    t.S.budget = { ...BUDGET };
    for (const ch of '55') window.np(ch);
    window.confirm_();
    await settle();
    server.offline = false;
    for (const code of [B, A]) {
      window.showEnterCodeModal();
      $('enter-code-inp').value = code;
      await window.submitEnterCode();
      await settle();
    }
    window.dispatchEvent(new Event('online'));
    await settle();
    const mine = server.tables.transactions.filter((r) => r.user_id === server.uid(A));
    expect(mine.map((r) => r.amount)).toEqual([55]);
    expect(server.tables.transactions.filter((r) => r.user_id === server.uid(B))).toEqual([]);
    expect(JSON.parse(localStorage.getItem('tk_oq'))).toEqual([]);
  });

  it('неверный код не трогает текущий аккаунт', async () => {
    const server = makeServer({ users: [A] });
    const t = await bootApp({ now: NOW, server, storage: { tk_rccode: A } });
    const uid = t.currentUser.id;
    window.showEnterCodeModal();
    $('enter-code-inp').value = 'ZZZZ-ZZZZ';
    await window.submitEnterCode();
    expect(txt('enter-code-err')).toContain('Код не найден');
    expect(t.currentUser.id).toBe(uid);
    expect(localStorage.getItem('tk_rccode')).toBe(A);
  });
});

describe('сессия без кода в памяти (старые установки)', () => {
  it('код восстанавливается из профиля', async () => {
    const server = makeServer({ users: [A], session: A });
    const t = await bootApp({ now: NOW, server });
    expect(localStorage.getItem('tk_rccode')).toBe(A);
    expect(t.currentUser).not.toBeNull();
  });
});

describe('«Стереть все данные»', () => {
  it('чистит сервер (включая историю периодов) и телефон, чужие данные не трогает', async () => {
    const server = makeServer({ users: [A, B] });
    const a = server.uid(A), b = server.uid(B);
    const row = (id, u) => ({ id, user_id: u, amount: 1, type: 'expense', cat_id: '', note: '', date: '2026-08-09T10:00:00+00:00', in_budget: false });
    server.tables.transactions = [row('a1', a), row('b1', b)];
    server.tables.budget_settings = [{ user_id: a, amount: 1, days: 1, deadline: '2026-08-30', set_at: '2026-08-01' }];
    server.tables.budget_history = [{ id: 'h1', user_id: a, amount: 1, days: 1, start_day: '2026-07-01', end_day: '2026-07-31', result: 1 }];
    const t = await bootApp({ now: NOW, server, storage: { tk_rccode: A } });
    const p = window.clearAll();
    await tick();
    window._confOk();
    await p; await settle();
    expect(server.tables.transactions.map((r) => r.id)).toEqual(['b1']);
    expect(server.tables.budget_settings).toEqual([]);
    expect(server.tables.budget_history).toEqual([]);
    expect(t.S.txs).toEqual([]);
    expect(t.S.budHist).toEqual([]);
    expect(t.S.budget.amount).toBe(0);
    expect(JSON.parse(localStorage.getItem('tk_budperiods'))).toEqual([]);
  });

  it('если сервер недоступен — локальные данные не трогаются', async () => {
    const server = makeServer({ users: [A] });
    const t = await bootApp({ now: NOW, server, storage: { tk_rccode: A } });
    t.S.txs = [tx('keep')];
    server.offline = true;
    const p = window.clearAll();
    await tick();
    window._confOk();
    await p; await settle();
    expect(t.S.txs.map((x) => x.id)).toEqual(['keep']);
    expect(txt('toast')).toContain('Не удалось очистить сервер');
  });
});

describe('экспорт и импорт с аккаунтом', () => {
  it('экспорт содержит историю периодов', async () => {
    const server = makeServer({ users: [A] });
    const t = await bootApp({ now: NOW, server, storage: { tk_rccode: A } });
    let captured = null;
    vi.stubGlobal('URL', { createObjectURL: (b) => ((captured = b), 'blob:x'), revokeObjectURL: () => {} });
    t.S.budHist = [{ id: 'h', from: '2026-07-01', to: '2026-07-31', deadline: '2026-07-31', amount: 1, spent: 0, income: 0, result: 1, early: false, top: [] }];
    window.exportData();
    const json = JSON.parse(await captured.text());
    expect(json.budHist).toHaveLength(1);
    expect(json.txs).toBeDefined();
  });

  it('импорт отправляет траты, бюджет и историю на сервер', async () => {
    const server = makeServer({ users: [A] });
    const t = await bootApp({ now: NOW, server, storage: { tk_rccode: A } });
    const data = {
      txs: [tx('i1'), tx('i2', { amount: 5 })],
      cats: [{ id: 'c1', name: 'Еда', color: '#fff', icon: '', ctype: 'expense' }],
      budget: BUDGET,
      budHist: [
        { id: '44444444-4444-4444-8444-444444444444', from: '2026-07-01', to: '2026-07-31', deadline: '2026-07-31', amount: 1000, spent: 900, income: 0, result: 100, early: false, top: [] },
        { id: 'bad', amount: 1 }, // битая запись отбрасывается
      ],
    };
    let onload;
    vi.stubGlobal('FileReader', vi.fn(function () {
      this.readAsText = () => onload({ target: { result: JSON.stringify(data) } });
      Object.defineProperty(this, 'onload', { set(fn) { onload = fn; } });
    }));
    window.importData({ target: { files: [new Blob()], value: 'x' } });
    await tick();
    window._confOk();
    await settle();
    expect(t.S.txs.map((x) => x.id).sort()).toEqual(['i1', 'i2']);
    expect(server.tables.transactions.map((r) => r.id).sort()).toEqual(['i1', 'i2']);
    expect(server.tables.budget_settings[0].amount).toBe(30000);
    expect(t.S.budHist).toHaveLength(1);
    expect(server.tables.budget_history.map((r) => r.id)).toEqual(['44444444-4444-4444-8444-444444444444']);
  });
});

describe('онбординг: бюджет из слайда', () => {
  it('сохраняет бюджет, отправляет на сервер и архивирует прошлый период', async () => {
    const server = makeServer({ users: [A] });
    const uid = server.uid(A);
    server.tables.budget_settings = [{ user_id: uid, amount: 10000, days: 10, deadline: '2026-08-05', set_at: '2026-07-27', reset_ts: '2026-07-27T00:00:00+00:00' }];
    server.tables.transactions = [{ id: 's', user_id: uid, amount: 12000, type: 'expense', cat_id: '', note: '', date: '2026-07-30T10:00:00+00:00', in_budget: false }];
    const t = await bootApp({ now: NOW, server, storage: { tk_rccode: A } });
    window.replayOnboarding();
    await settle();
    $('ob-bud-amount').value = '20000';
    window.obBudAmtInput();
    $('ob-bud-date-input').value = '2026-08-20';
    window.obBudDateChange();
    await window.obSaveBudget();
    await settle();
    expect(t.S.budget).toMatchObject({ amount: 20000, deadline: '2026-08-20' });
    expect(server.tables.budget_settings[0]).toMatchObject({ amount: 20000, deadline: '2026-08-20' });
    expect(t.S.budHist).toHaveLength(1);
    expect(t.S.budHist[0]).toMatchObject({ from: '2026-07-27', to: '2026-08-05', result: -2000 });
    expect(server.tables.budget_history).toHaveLength(1);
  });

  it('без суммы или даты бюджет не сохраняется', async () => {
    const t = await bootApp({ now: NOW });
    window.replayOnboarding();
    await settle();
    await window.obSaveBudget();
    expect(t.S.budget.amount).toBe(0);
    expect(txt('toast')).toContain('Введите сумму');
  });
});
