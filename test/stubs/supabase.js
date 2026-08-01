// Заглушка @supabase/supabase-js для тестов.
// Возвращает цепочку, которая на любом методе остаётся цепочкой,
// а при await отдаёт {data:[],error:null}. Все вызовы пишутся в calls —
// тесты могут проверить, что приложение пыталось синкать.

export const calls = [];
export function resetCalls(){ calls.length = 0; }

function chain(table, path){
  const target = function(){};
  return new Proxy(target, {
    get(_t, prop){
      if(prop === 'then'){
        // await на цепочке → успешный пустой ответ
        return (res) => Promise.resolve(res({ data: [], error: null }));
      }
      if(typeof prop !== 'string') return undefined;
      return (...args) => {
        calls.push({ table, op: [...path, prop].join('.'), args });
        return chain(table, [...path, prop]);
      };
    }
  });
}

export function createClient(){
  return {
    from(table){ calls.push({ table, op: 'from', args: [] }); return chain(table, []); },
    auth: {
      // Нет сессии и нет аккаунта — приложение уходит на экран входа
      signInWithPassword: async () => ({ data: { user: null }, error: { message: 'stub: no user' } }),
      getSession: async () => ({ data: { session: null } }),
      signUp: async () => ({ data: { user: null }, error: { message: 'stub: offline' } }),
      updateUser: async () => ({ data: { user: null }, error: { message: 'stub: offline' } }),
      signOut: async () => ({ error: null }),
    },
  };
}

export default { createClient };
