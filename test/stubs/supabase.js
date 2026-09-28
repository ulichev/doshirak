// Заглушка @supabase/supabase-js для тестов — маленький сервер в памяти.
//
// Состояние живёт в globalThis.__sb, а не в модуле: bootApp() перезагружает модули
// (vi.resetModules), а тесту нужно подготовить «сервер» до старта приложения и
// проверить его после. Создаётся через makeServer() из test/helpers/server.js.
//
// Умеет то, чем пользуется приложение: select/eq/order/maybeSingle, upsert по
// первичному ключу, delete по фильтрам, вход по email+паролю, сессию, updateUser.
// Как настоящий сервер: даты timestamptz возвращает в формате «…+00:00», проверяет
// RLS (user_id = текущий пользователь), NOT NULL и наличие колонок. Сбои задаются
// через server.offline (обрыв сети) и server.fail(ctx) (любая ошибка базы).

const PK = { transactions: 'id', categories: 'id', budget_settings: 'user_id', budget_history: 'id' };
const NOT_NULL = { budget_history: ['id', 'user_id', 'amount', 'days'], transactions: ['id', 'user_id', 'amount', 'type'] };
const TS_COLS = ['date', 'reset_ts', 'ts'];

function emptyServer() {
  return {
    tables: { transactions: [], categories: [], budget_settings: [], budget_history: [] },
    users: [], session: null, offline: false, fail: null, missingCols: {}, calls: [],
  };
}
function srv() {
  if (!globalThis.__sb) globalThis.__sb = emptyServer();
  return globalThis.__sb;
}
const NET_ERR = { message: 'TypeError: Failed to fetch' };
const clone = (v) => JSON.parse(JSON.stringify(v));
// Сервер хранит и отдаёт timestamptz как «…+00:00», клиент пишет «…Z»
function toServerTs(row) {
  const r = { ...row };
  TS_COLS.forEach((c) => {
    if (typeof r[c] === 'string' && /T.*Z$/.test(r[c])) r[c] = new Date(r[c]).toISOString().replace('Z', '+00:00');
  });
  return r;
}

function builder(table) {
  const q = { table, op: 'select', filters: [], order: null, single: false, rows: null };
  const api = {
    select() { if (q.op !== 'upsert' && q.op !== 'delete') q.op = 'select'; return api; },
    upsert(rows) { q.op = 'upsert'; q.rows = Array.isArray(rows) ? rows : [rows]; return api; },
    insert(rows) { q.op = 'upsert'; q.rows = Array.isArray(rows) ? rows : [rows]; return api; },
    delete() { q.op = 'delete'; return api; },
    eq(col, val) { q.filters.push([col, val]); return api; },
    order(col, opts) { q.order = [col, !opts || opts.ascending !== false]; return api; },
    maybeSingle() { q.single = true; return api; },
    then(res, rej) { return Promise.resolve(exec(q)).then(res, rej); },
  };
  return api;
}

function exec(q) {
  const s = srv();
  s.calls.push({ table: q.table, op: q.op, rows: q.rows && clone(q.rows), filters: q.filters });
  if (s.offline) return { data: null, error: NET_ERR };
  const injected = s.fail && s.fail({ table: q.table, op: q.op, rows: q.rows, filters: q.filters });
  if (injected) return { data: null, error: injected };
  const uid = s.session && s.session.user.id;
  if (!uid) return { data: q.single ? null : [], error: null }; // анонимно RLS ничего не отдаёт
  const tbl = s.tables[q.table];
  if (!tbl) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${q.table}' in the schema cache` } };
  const match = (r) => q.filters.every(([c, v]) => r[c] === v);

  if (q.op === 'upsert') {
    const missing = s.missingCols[q.table] || [];
    for (const row of q.rows) {
      const bad = Object.keys(row).find((k) => missing.includes(k));
      if (bad) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${bad}' column of '${q.table}' in the schema cache` } };
      if (row.user_id !== uid) return { data: null, error: { code: '42501', message: `new row violates row-level security policy for table "${q.table}"` } };
      const nn = (NOT_NULL[q.table] || []).find((c) => row[c] == null || (typeof row[c] === 'number' && isNaN(row[c])));
      if (nn) return { data: null, error: { code: '23502', message: `null value in column "${nn}" of relation "${q.table}" violates not-null constraint` } };
    }
    const pk = PK[q.table];
    for (const row of q.rows) {
      const r = toServerTs(clone(row));
      const i = tbl.findIndex((x) => x[pk] === r[pk]);
      if (i >= 0) tbl[i] = { ...tbl[i], ...r }; else tbl.push(r);
    }
    return { data: null, error: null };
  }
  if (q.op === 'delete') {
    s.tables[q.table] = tbl.filter((r) => !(r.user_id === uid && match(r)));
    return { data: null, error: null };
  }
  let out = tbl.filter((r) => r.user_id === uid && match(r)).map(clone);
  if (q.order) {
    const [c, asc] = q.order;
    out.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
  }
  if (q.single) return { data: out[0] || null, error: null };
  return { data: out, error: null };
}

let _uid = 0;
const auth = {
  async signInWithPassword({ email, password }) {
    const s = srv();
    s.calls.push({ auth: 'signIn', email });
    if (s.offline) return { data: { user: null, session: null }, error: NET_ERR };
    const u = s.users.find((x) => x.email === email && x.password === password);
    if (!u) return { data: { user: null, session: null }, error: { message: 'Invalid login credentials' } };
    s.session = { user: clone(u.user) };
    return { data: { user: clone(u.user), session: s.session }, error: null };
  },
  async signUp({ email, password, options }) {
    const s = srv();
    s.calls.push({ auth: 'signUp', email });
    if (s.offline) return { data: { user: null, session: null }, error: NET_ERR };
    const user = { id: 'uid-' + (++_uid) + '-' + Math.random().toString(36).slice(2, 8), email, user_metadata: (options && options.data) || {} };
    s.users.push({ email, password, user });
    s.session = { user: clone(user) };
    return { data: { user: clone(user), session: s.session }, error: null };
  },
  async getSession() { return { data: { session: srv().session } }; },
  async updateUser({ email, password, data }) {
    const s = srv();
    s.calls.push({ auth: 'updateUser', email });
    if (s.offline) return { data: { user: null }, error: NET_ERR };
    if (!s.session) return { data: { user: null }, error: { message: 'Auth session missing!' } };
    const u = s.users.find((x) => x.user.id === s.session.user.id);
    if (u) { u.email = email; u.password = password; u.user.email = email; u.user.user_metadata = { ...u.user.user_metadata, ...data }; }
    return { data: { user: u && clone(u.user) }, error: null };
  },
  async signOut() { srv().session = null; return { error: null }; },
};

export function createClient() {
  return { from: (table) => builder(table), auth };
}
export { emptyServer };
export default { createClient };
