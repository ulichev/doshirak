// Сервер-заглушка для тестов синхронизации и входа (см. test/stubs/supabase.js).
import { emptyServer } from '../stubs/supabase.js';

/**
 * Сервер в памяти. users — коды вида 'ABCD-EFGH': для каждого заводится аккаунт
 * {code}@doshik.app с паролем = код, как в приложении. Возвращает сервер и
 * uid(code) → id пользователя.
 */
export function makeServer({ users = [], tables = {}, session = null } = {}) {
  const s = emptyServer();
  users.forEach((code, i) => {
    const user = { id: 'u' + (i + 1) + '-' + code.toLowerCase(), email: `${code}@doshik.app`, user_metadata: { code } };
    s.users.push({ email: user.email, password: code, user });
  });
  Object.entries(tables).forEach(([t, rows]) => { s.tables[t] = rows.map((r) => ({ ...r })); });
  if (session) s.session = { user: s.users.find((u) => u.user.user_metadata.code === session).user };
  s.uid = (code) => s.users.find((u) => u.user.user_metadata.code === code).user.id;
  return s;
}

/** Все записи, которые приложение пыталось отправить в таблицу (upsert) */
export const upserts = (s, table) => s.calls.filter((c) => c.table === table && c.op === 'upsert').flatMap((c) => c.rows);
