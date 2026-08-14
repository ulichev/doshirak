import { createClient } from '@supabase/supabase-js';

// ── SUPABASE ──────────────────────────────────────────────────────────────────
// Всегда через прокси /sb — в dev Vite проксирует сам, в проде — Vercel
// Браузер никогда не ходит напрямую на supabase.co (обход РКН)
// В нативной сборке (Android APK) страница открыта с https://localhost, прокси там
// нет — VITE_API_BASE подставляет прод-домен, чтобы /sb и /api остались рабочими.
const API_BASE = import.meta.env.VITE_API_BASE || window.location.origin;
const db = createClient(API_BASE + '/sb', import.meta.env.VITE_SUPABASE_KEY);
let currentUser = null;

// ── DATA ──────────────────────────────────────────────────────────────────────
const K = { tx:'tk_tx', cats:'tk_cats', budget:'tk_budget' };
const COLORS = ['#F5A623','#FF6B6B','#3DBD74','#4A9EFF','#AF6FE8','#00C2CB','#FF9500','#F06292','#78909C','#A1887F'];
const DEF_CATS_EXP = [
  {id:'food',name:'Еда',color:'#F5A623',icon:'🍔',ctype:'expense'},
  {id:'transport',name:'Транспорт',color:'#4A9EFF',icon:'🚌',ctype:'expense'},
  {id:'cafe',name:'Кафе/Рест.',color:'#FF6B6B',icon:'☕',ctype:'expense'},
  {id:'shopping',name:'Покупки',color:'#AF6FE8',icon:'🛍',ctype:'expense'},
  {id:'health',name:'Здоровье',color:'#3DBD74',icon:'💊',ctype:'expense'},
  {id:'fun',name:'Развлечения',color:'#00C2CB',icon:'🎮',ctype:'expense'},
];
const DEF_CATS_INC = [
  {id:'salary',name:'Зарплата',color:'#3DBD74',icon:'💼',ctype:'income'},
  {id:'freelance',name:'Подработка',color:'#4A9EFF',icon:'💻',ctype:'income'},
  {id:'gift',name:'Подарок',color:'#AF6FE8',icon:'🎁',ctype:'income'},
  {id:'debt_ret',name:'Возврат долга',color:'#F5A623',icon:'🤝',ctype:'income'},
];
const DEF_CATS = [...DEF_CATS_EXP, ...DEF_CATS_INC];

const ICON_OPTIONS=['🍔','🛍','🚌','☕','💊','🎮','🏠','✈️','💄','🎵',
  '📚','🏋','⚽','🎬','🐾','🎁','🔧','📱','🌮','🍕','🍺','💡','🔑',
  '🌿','🎸','🧴','🍫','🎯','💎','🚀','💼','💻','💵','🤝','🎲'];

// Определяем тип категории без хранения в Supabase
function determineCtype(catId, oldCats){
  const src = oldCats || S.cats;
  // 1. Из локального кэша
  const loc = src.find(c=>c.id===catId);
  if(loc?.ctype) return loc.ctype;
  // 2. Суффикс в ID (_inc / _exp) — для новых пользовательских категорий
  if(catId.endsWith('_inc')) return 'income';
  if(catId.endsWith('_exp')) return 'expense';
  // 3. Точное совпадение в DEF_CATS
  const def = DEF_CATS.find(c=>c.id===catId);
  if(def) return def.ctype||'expense';
  // 4. Префикс DEF_CATS + пользовательский суффикс (food_abc12345)
  for(const d of DEF_CATS){
    if(catId.startsWith(d.id+'_')) return d.ctype||'expense';
  }
  return 'expense';
}

// Парсим дату всегда через T12:00:00 чтобы избежать timezone-сдвига на ±1 день
function parseLocalDate(s){ return new Date(s+'T12:00:00'); }
function daysBetween(from,to){ return Math.round((parseLocalDate(to)-parseLocalDate(from))/86400000); }

function vibrate(ms){ try{ navigator.vibrate?.(ms); }catch(e){} }

function emptyBudget(){ return {amount:0,days:0,deadline:null,set_at:null,spent_at_start:0,reset_ts:null}; }

let S = {
  type:'expense', amount:'', catId:null,
  histCat:null, histType:null, histPeriod:null, catSettTab:'expense',
  budColor:COLORS[0], budDays:0,
  txs:[], cats:[], budget:emptyBudget(),
};

let _budLockUntil=0; // до этого момента синхронизация не перезаписывает локальный бюджет
// ── OFFLINE QUEUE ─────────────────────────────────────────────────────────────
let offlineQueue=[];
function saveQueue(){ try{localStorage.setItem('tk_oq',JSON.stringify(offlineQueue));}catch(e){} }
function loadQueue(){ try{offlineQueue=JSON.parse(localStorage.getItem('tk_oq')||'[]');}catch(e){offlineQueue=[];} }
async function processQueue(){
  if(!currentUser||!navigator.onLine||!offlineQueue.length) return;
  const q=[...offlineQueue]; offlineQueue=[]; saveQueue();
  for(const item of q){
    try{
      if(item.op==='pushTx') await pushTx(item.data,true);
      else if(item.op==='deleteTx') await deleteTxRemote(item.data,true);
      else if(item.op==='deleteCat') await deleteCatRemote(item.data,true);
      else if(item.op==='pushCats') await pushCats();
      else if(item.op==='pushBudget') await pushBudget();
    }catch(e){ offlineQueue.push(item); }
  }
  saveQueue(); if(offlineQueue.length===0) setSyncDot(true);
}
window.addEventListener('online',()=>{ setSyncDot(null); processQueue(); });

// ── LOCAL STORAGE ─────────────────────────────────────────────────────────────
function loadLocal(){
  try {
    S.txs=JSON.parse(_load(K.tx)||'[]');
    var _sc=JSON.parse(_load(K.cats)||'null');
    S.cats=_sc?_sc.map(function(ct){
      if(!ct.icon){var b=ct.id.replace(/_[a-zA-Z0-9]{1,8}$/,'');var df=DEF_CATS.find(function(d){return d.id===b||d.id===ct.id;});if(df)ct.icon=df.icon||'';}
      return Object.assign({},ct,{ctype:ct.ctype||'expense',icon:ct.icon||''});
    }):[...DEF_CATS];
    var _sb=JSON.parse(_load(K.budget)||'null');
    if(_sb&&Number(_sb.amount)>0){
      var _lbSetAt=_sb.set_at||null;
      var _lbBaseline=(_sb.spent_at_start!=null)?Number(_sb.spent_at_start):
        S.txs.filter(function(t){ if(t.type!=='expense') return false; if(!_lbSetAt) return true; return localDateStr(t.date)<_lbSetAt; }).reduce(function(s,t){ return s+t.amount; },0);
      S.budget={amount:Number(_sb.amount)||0,days:Number(_sb.days)||0,deadline:_sb.deadline||null,set_at:_lbSetAt,spent_at_start:_lbBaseline};
    } else { S.budget=emptyBudget(); }
  } catch(e){ S.txs=[]; S.cats=[...DEF_CATS]; S.budget=emptyBudget(); }
}
function _store(k,v){ try{localStorage.setItem(k,v);}catch(e){} try{sessionStorage.setItem(k,v);}catch(e){} }
function _load(k){ try{var v=localStorage.getItem(k);if(v)return v;}catch(e){} try{return sessionStorage.getItem(k);}catch(e){} return null; }
function saveLocal(){
  _store(K.tx,JSON.stringify(S.txs));
  _store(K.cats,JSON.stringify(S.cats));
  _store(K.budget,JSON.stringify(S.budget));
}

// ── SUPABASE SYNC ─────────────────────────────────────────────────────────────
let _syncInFlight=false;
async function syncFromSupabase(){
  if(!currentUser||_syncInFlight) return;
  _syncInFlight=true;
  try {
    const [txRes,catRes,budRes]=await Promise.all([
      db.from('transactions').select('*').eq('user_id',currentUser.id).order('date',{ascending:false}),
      db.from('categories').select('*').eq('user_id',currentUser.id).order('sort_order'),
      db.from('budget_settings').select('*').eq('user_id',currentUser.id).maybeSingle(),
    ]);
    if(txRes.data&&txRes.data.length>0){
      // Сохраняем inBudget-флаги из localStorage — они не хранятся в Supabase
      var _inBudgetMap={};
      S.txs.forEach(function(t){ if(t.inBudget) _inBudgetMap[t.id]=true; });
      var serverTxs=txRes.data.map(function(r){
        var t={id:r.id,amount:r.amount,type:r.type,catId:r.cat_id,note:r.note||'',date:r.date};
        if(_inBudgetMap[r.id]) t.inBudget=true;
        return t;
      });
      // Не затираем локальные записи, которые ещё не дошли до сервера (ждут в оффлайн-очереди)
      var _srvIds={}; serverTxs.forEach(function(t){ _srvIds[t.id]=true; });
      var _pendIds={}; offlineQueue.forEach(function(i){ if(i.op==='pushTx'&&i.data) _pendIds[i.data.id]=true; });
      var localPending=S.txs.filter(function(t){ return _pendIds[t.id]&&!_srvIds[t.id]; });
      S.txs=localPending.concat(serverTxs).sort(function(a,b){ return a.date<b.date?1:-1; });
    }
    if(catRes.data&&catRes.data.length>0){
      S.cats=catRes.data.map(function(r){var ic=r.icon||'';if(!ic){var b=r.id.replace(/_[a-zA-Z0-9]{1,8}$/,'');var df=DEF_CATS.find(function(d){return d.id===b||d.id===r.id;});if(df)ic=df.icon||'';}return {id:r.id,name:r.name,color:r.color,icon:ic,ctype:r.ctype||determineCtype(r.id,[...S.cats])};});
    }
    else await seedDefaultCats();
    if(budRes.data&&budRes.data.amount&&Date.now()>_budLockUntil){
      var budSetAt=budRes.data.set_at||null;
      var _baseline;
      // Если в памяти уже есть spent_at_start для того же периода бюджета — сохраняем его.
      // Пересчёт по date < set_at некорректен: он не учитывает расходы в день сохранения бюджета.
      if(S.budget&&S.budget.set_at===budSetAt&&S.budget.spent_at_start!=null){
        _baseline=Number(S.budget.spent_at_start);
      } else {
        _baseline=S.txs.filter(function(t){
          if(t.type!=='expense') return false;
          if(!budSetAt) return true;
          return localDateStr(t.date)<budSetAt;
        }).reduce(function(sum,t){ return sum+t.amount; },0);
      }
      S.budget={amount:Number(budRes.data.amount)||0,days:Number(budRes.data.days)||0,deadline:budRes.data.deadline||null,set_at:budSetAt,spent_at_start:_baseline};
    }
    saveLocal(); setSyncDot(true); renderMain(); processQueue();
  } catch(e){
    setSyncDot(false);
  } finally {
    _syncInFlight=false;
  }
}
async function seedDefaultCats(){
  if(!currentUser) return;
  // Проверяем — есть ли уже категории в БД (защита от дублей)
  const {data:existing}=await db.from('categories').select('id').eq('user_id',currentUser.id);
  if(existing&&existing.length>0) return; // уже есть — не сеять повторно
  const rows=DEF_CATS.map((c,i)=>({id:c.id+'_'+currentUser.id.slice(0,8),user_id:currentUser.id,name:c.name,color:c.color,icon:c.icon||'',ctype:c.ctype||'expense',sort_order:i}));
  const {error}=await db.from('categories').upsert(rows);
  if(!error){ S.cats=DEF_CATS.map((c)=>({...c,id:c.id+'_'+currentUser.id.slice(0,8),ctype:c.ctype||'expense'})); saveLocal(); }
}
// supabase-js не бросает исключений на ошибках запроса — возвращает {error}.
// Поэтому везде: if(error) throw error, иначе catch никогда не сработает.
async function pushTx(tx,isRetry=false){
  if(!currentUser) return;
  try {
    const {error}=await db.from('transactions').upsert({id:tx.id,user_id:currentUser.id,amount:tx.amount,type:tx.type,cat_id:tx.catId,note:tx.note||'',date:tx.date});
    if(error) throw error;
    setSyncDot(true);
  }
  catch(e){ setSyncDot(false); if(isRetry) throw e; offlineQueue.push({op:'pushTx',data:tx}); saveQueue(); }
}
async function deleteTxRemote(id,isRetry=false){
  if(!currentUser) return;
  try {
    const {error}=await db.from('transactions').delete().eq('id',id).eq('user_id',currentUser.id);
    if(error) throw error;
  } catch(e){ if(isRetry) throw e; offlineQueue.push({op:'deleteTx',data:id}); saveQueue(); }
}
async function pushCats(){
  if(!currentUser) return;
  try {
    const {error}=await db.from('categories').upsert(S.cats.map((c,i)=>({id:c.id,user_id:currentUser.id,name:c.name,color:c.color,icon:c.icon||'',ctype:c.ctype||'expense',sort_order:i})));
    if(error) throw error;
    setSyncDot(true);
  } catch(e){ setSyncDot(false); offlineQueue.push({op:'pushCats'}); saveQueue(); }
}
async function pushCat(cat){
  if(!currentUser) return;
  const idx=S.cats.indexOf(cat);
  try {
    const {error}=await db.from('categories').upsert({id:cat.id,user_id:currentUser.id,name:cat.name,color:cat.color,icon:cat.icon||'',ctype:cat.ctype||'expense',sort_order:idx>=0?idx:0});
    if(error) throw error;
    setSyncDot(true);
  } catch(e){ setSyncDot(false); offlineQueue.push({op:'pushCats'}); saveQueue(); }
}
async function deleteCatRemote(id,isRetry=false){
  if(!currentUser) return;
  try {
    const {error}=await db.from('categories').delete().eq('id',id).eq('user_id',currentUser.id);
    if(error) throw error;
  } catch(e){ if(isRetry) throw e; offlineQueue.push({op:'deleteCat',data:id}); saveQueue(); }
}
async function pushBudget(){
  if(!currentUser) return;
  try {
    const {error}=await db.from('budget_settings').upsert({user_id:currentUser.id,amount:S.budget.amount,days:S.budget.days||0,deadline:S.budget.deadline,set_at:S.budget.set_at||todayStr()});
    if(error) throw error;
    setSyncDot(true);
  }
  catch(e){ setSyncDot(false); offlineQueue.push({op:'pushBudget'}); saveQueue(); }
}

// ── SYNC STATUS ──────────────────────────────────────────────────────────────
var _lastSyncTs = null;   // Date объект последней успешной синхронизации
var _syncStatus = 'ok';   // 'ok' | 'syncing' | 'offline'

function timeAgo(date){
  if(!date) return '';
  var sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if(sec < 15)  return 'только что';
  if(sec < 60)  return 'меньше минуты назад';
  var min = Math.floor(sec/60);
  if(min < 60)  return min + ' ' + plural(min,'минуту','минуты','минут') + ' назад';
  var hr = Math.floor(min/60);
  if(hr < 24)   return hr + ' ' + plural(hr,'час','часа','часов') + ' назад';
  var d = Math.floor(hr/24);
  return d + ' ' + plural(d,'день','дня','дней') + ' назад';
}
function plural(n,one,few,many){
  var m10=n%10, m100=n%100;
  if(m10===1&&m100!==11) return one;
  if(m10>=2&&m10<=4&&(m100<10||m100>=20)) return few;
  return many;
}

function updateSyncCard(){
  var icon  = document.getElementById('sync-icon');
  var title = document.getElementById('sync-title');
  var time  = document.getElementById('sync-time');
  if(!icon||!title||!time) return;
  icon.className='sync-dot';
  if(_syncStatus==='syncing'){
    icon.classList.add('sync-dot--sync');
    title.textContent='Синхронизируется…';
    time.textContent='';
  } else if(_syncStatus==='offline'){
    icon.classList.add('sync-dot--err');
    title.textContent='Нет соединения';
    time.textContent='Данные сохранены локально';
  } else {
    icon.classList.add('sync-dot--ok');
    title.textContent='Синхронизировано';
    time.textContent=_lastSyncTs ? timeAgo(_lastSyncTs) : '';
  }
}

// Обновляем надпись «N минут назад» каждые 30 сек, пока открыт экран настроек
setInterval(function(){
  var s=document.getElementById('s-settings');
  if(s && !s.classList.contains('hidden')) updateSyncCard();
}, 30000);

function setSyncDot(ok){
  // ok=true → синхронизировано, ok=false → оффлайн, ok=null → идёт синхронизация
  if(ok===true){
    _syncStatus='ok';
    _lastSyncTs=new Date();
  } else if(ok===null){
    _syncStatus='syncing';
  } else {
    _syncStatus='offline';
  }
  updateSyncCard();
}

// ── SCREENS ───────────────────────────────────────────────────────────────────
function show(id){
  ['s-main','s-history','s-budget','s-settings','s-cats'].forEach(s=>{
    document.getElementById(s).classList.toggle('hidden',s!==id);
  });
}
let _histScrollTop=0;
function goMain(){
  hideSplash();
  if(!document.getElementById('s-history').classList.contains('hidden')){
    const hc=document.getElementById('hist-content');
    if(hc) _histScrollTop=hc.scrollTop;
  }
  show('s-main'); renderMain();
}
function goHistory(){
  show('s-history');
  setTimeout(()=>{
    renderHistory();
    const hc=document.getElementById('hist-content');
    if(hc&&_histScrollTop>0) hc.scrollTop=_histScrollTop;
  },0);
}
function goBudget(){ show('s-budget'); renderBudgetScreen(); }
function goSettings(){
  updateSyncCard();
  show('s-settings');
  renderSettings();
}
function goCategories(){
  show('s-cats');
  renderCats();
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

function fitBudgetNum(el){
  // Подбираем размер шрифта по длине числа
  var len = (el.textContent||'').replace(/\s/g,'').length;
  var size, ls;
  if(len <= 6)      { size=78; ls='-2px'; }
  else if(len <= 8) { size=64; ls='-2px'; }
  else if(len <= 10){ size=50; ls='-1px'; }
  else              { size=40; ls='-1px'; }
  el.style.setProperty('font-size', size+'px', 'important');
  el.style.setProperty('letter-spacing', ls, 'important');
}
// Транзакция попадает в текущий период бюджета: от момента запуска (reset_ts,
// для старых бюджетов — set_at) до дедлайна включительно.
// Считаем именно по периоду, а не «всего потрачено минус отметка на старте»:
// иначе правка или удаление старой траты вне периода двигает остаток.
function inBudgetPeriod(t){
  if(!S.budget) return false;
  if(S.budget.reset_ts){ if(t.date<S.budget.reset_ts) return false; }
  else if(S.budget.set_at){ if(localDateStr(t.date)<S.budget.set_at) return false; }
  if(S.budget.deadline&&localDateStr(t.date)>S.budget.deadline) return false;
  return true;
}
function spentInBudgetPeriod(){
  return S.txs.filter(function(t){ return t.type==='expense'&&inBudgetPeriod(t); })
              .reduce(function(s,t){ return s+t.amount; },0);
}
function incomeInBudgetPeriod(){
  return S.txs.filter(function(t){ return t.type==='income'&&t.inBudget&&inBudgetPeriod(t); })
              .reduce(function(s,t){ return s+t.amount; },0);
}
function budgetRemaining(){
  var amt=Number((S.budget&&S.budget.amount)||0);
  if(!(amt>0)) return 0;
  return amt+incomeInBudgetPeriod()-spentInBudgetPeriod();
}

function renderMain(){
  const numEl=document.getElementById('today-num');
  const lblEl=document.getElementById('today-label');
  const pill=document.getElementById('budget-pill');
  const budgetAmount=Number((S.budget&&S.budget.amount)||0);
  const budgetDeadline=S.budget&&S.budget.deadline?S.budget.deadline:null;
  const hasBudget=budgetAmount>0 && !!budgetDeadline;

  lblEl.style.cursor='';
  lblEl.onclick=null;

  if(hasBudget){
    const remaining=budgetRemaining();
    numEl.textContent=(remaining<0?'−':'')+fmt(Math.abs(remaining));
    fitBudgetNum(numEl);

    var isExpired=budgetDeadline<todayStr();
    if(isExpired){
      lblEl.textContent='Период завершён';
      numEl.style.color='rgba(255,255,255,.45)';
      lblEl.style.color='rgba(245,166,35,.75)';
      lblEl.style.cursor='pointer';
      lblEl.onclick=goBudget;
      pill.textContent='Обновить';
      pill.classList.add('nav-pill--highlight');
      pill.style.cssText='';
    } else if(remaining>0){
      lblEl.textContent='Старайся вносить каждую трату, чтобы понимать, на что уходят твои деньги';
      numEl.style.color='rgba(255,255,255,.95)';
      lblEl.style.color='rgba(255,255,255,.38)';
      const daysLeft=Math.max(daysUntil(budgetDeadline),1);
      const perDay=fmt(Math.max(Math.round(Math.max(remaining,0)/daysLeft),0));
      pill.textContent=perDay+' ₽/день до '+fmtDeadlineShort(budgetDeadline);
      pill.classList.remove('nav-pill--highlight');
      pill.style.cssText='';
    } else {
      lblEl.textContent='Не останавливайся — вноси траты, чтобы понять реальный перерасход';
      numEl.style.color='rgba(255,90,80,.9)';
      lblEl.style.color='rgba(255,90,80,.65)';
      pill.textContent='0 ₽/день до '+fmtDeadlineShort(budgetDeadline);
      pill.classList.remove('nav-pill--highlight');
      pill.style.cssText='';
    }
  } else {
    const todayExpenses=S.txs.filter(function(t){
      return t.type==='expense' && t.date && localDateStr(t.date)===todayStr();
    }).reduce(function(s,t){ return s+t.amount; },0);
    numEl.textContent=fmt(todayExpenses);
    fitBudgetNum(numEl);
    numEl.style.color='rgba(255,255,255,.9)';
    lblEl.textContent='Задай бюджет — начнём считать траты';
    lblEl.style.color='rgba(255,90,80,.55)';
    pill.textContent='Бюджет';
    pill.classList.add('nav-pill--highlight');
  }
  renderAmountRow();
  renderModeRow();
  renderCatRow();

  // populate category breakdown chips
  var cbEl=document.getElementById('cat-breakdown');
  if(cbEl){
    // Фильтр транзакций по периоду
    var isInc=S.type==='income';
    var periodTxs=(S.txs||[]).filter(function(t){
      if(t.type!==S.type) return false;
      // Тот же период, по которому считается остаток — числа на экране не расходятся
      return hasBudget?inBudgetPeriod(t):localDateStr(t.date)===todayStr();
    });
    var totals={};
    periodTxs.forEach(function(t){
      var cid=t.catId||'other';
      var cat=(S.cats||[]).find(function(c){return c.id===cid;});
      if(!totals[cid]) totals[cid]={name:cat?cat.name:'Другое',color:cat?(cat.color||'#888'):'#888',total:0};
      totals[cid].total+=t.amount;
    });
    var top3=Object.values(totals).sort(function(a,b){return b.total-a.total;}).slice(0,3);
    // Всегда 3 строки — пустые места заполняются плейсхолдером, чтобы не было прыжка
    var rows=[];
    for(var i=0;i<3;i++){
      if(top3[i]){
        var c=top3[i];
        rows.push('<div class="cb-row">'
          +'<div class="cb-left"><span class="cb-dot" style="background:'+c.color+'"></span>'
          +'<span class="cb-name">'+esc(c.name)+'</span></div>'
          +'<span class="cb-amt'+(isInc?' inc':'')+'">'+fmt(c.total)+' ₽</span></div>');
      } else {
        rows.push('<div class="cb-row cb-row--empty">'
          +'<div class="cb-left"><span class="cb-dot cb-dot--empty"></span>'
          +'<span class="cb-name cb-name--empty">—</span></div>'
          +'<span class="cb-amt cb-amt--empty">—</span></div>');
      }
    }
    cbEl.innerHTML=rows.join('');
  }
}
function renderCatRow(){
  var filtered=S.cats.filter(function(x){return (x.ctype||'expense')===S.type;});
  document.getElementById('cat-row').innerHTML=filtered.map(function(x){
    var isInc=S.type==='income';
    var iconHtml=x.icon?'<span class="cat-pill-icon-wrap">'+x.icon+'</span>':'';
    return '<button class="cat-pill'+(S.catId===x.id?' sel'+(isInc?' inc':''):'')+'" data-id="'+x.id+'" onclick="selCat(this.dataset.id)">'
      +iconHtml+'<span>'+esc(x.name)+'</span></button>';
  }).join('')+'<button class="cat-pill add" onclick="showCatModal()">＋ Новая</button>';
}
function selCat(id){ S.catId=(S.catId===id?null:id); renderCatRow(); }

// ── АНАЛИТИКА ТРАТ ────────────────────────────────────────────────────────────
// Минимум расходных операций, при котором анализ осмысленный.
// Меньше — показываем пример, не дёргая API (мгновенно + не жжём лимит Groq).
var ANALYTICS_MIN_TX = 8;
var ANALYTICS_DEMO = {
  insights: [
    '🛵 42% твоей «Еды» — это доставка: 6 000₽ за 8 заказов, по чеку незаметно.',
    '💸 38% дохода отложено — отличный темп, держи планку.'
  ],
  recommendations: [
    '«доставка» — это 42% твоей «Еды»: 6 000₽/мес за 8 раз, 72 000₽ за год. По отдельным чекам незаметно — глянь, что здесь можно урезать.',
    'Регулярные платежи — 3 067₽/мес (Netflix, Spotify, iCloud), а за год это 36 804₽. Пройдись по списку и отмени то, чем не пользуешься — деньги списываются незаметно.'
  ]
};

// Рубильник AI-анализа. false — фича полностью скрыта от пользователя (кнопка в
// истории, слайд онбординга, вход в runAnalytics), но весь код остаётся на месте:
// чтобы вернуть — поставить true, ничего больше менять не нужно.
var AI_ENABLED = false;

// Кэш последнего анализа + память показанных инсайтов (для «не повторяйся»)
var ANALYTICS_CACHE_KEY = 'tk_ai_cache';
var ANALYTICS_SEEN_KEY  = 'tk_ai_seen';
var ANALYTICS_CACHE_TTL = 3 * 86400000;  // старше 3 дней — не показываем, считаем заново
var ANALYTICS_SEEN_TTL  = 30 * 86400000; // что показывали месяц назад, можно повторить

function _aiCacheLoad() {
  try {
    var c = JSON.parse(_load(ANALYTICS_CACHE_KEY) || 'null');
    if (c && c.ts && Date.now() - c.ts < ANALYTICS_CACHE_TTL && (c.insights || []).length) return c;
  } catch (e) {}
  return null;
}
function _aiSeenLoad() {
  var s;
  try { s = JSON.parse(_load(ANALYTICS_SEEN_KEY) || 'null'); } catch (e) {}
  if (!s || !s.insights || !s.recKeys) s = { insights: [], recKeys: [] };
  var cut = Date.now() - ANALYTICS_SEEN_TTL;
  s.insights = s.insights.filter(function(x) { return x.ts > cut; });
  s.recKeys  = s.recKeys.filter(function(x) { return x.ts > cut; });
  return s;
}
function _aiSeenAdd(insights, recKeys) {
  var s = _aiSeenLoad(), now = Date.now();
  (insights || []).forEach(function(t) {
    if (!s.insights.some(function(x) { return x.t === t; })) s.insights.push({ t: t, ts: now });
  });
  (recKeys || []).forEach(function(k) {
    s.recKeys = s.recKeys.filter(function(x) { return x.k !== k; });
    s.recKeys.push({ k: k, ts: now });
  });
  // Храним только хвост — больше серверу всё равно не шлём
  s.insights = s.insights.slice(-12);
  s.recKeys  = s.recKeys.slice(-30);
  _store(ANALYTICS_SEEN_KEY, JSON.stringify(s));
}
function _fmtAnalysisDate(ts) {
  var d = new Date(ts), n = new Date();
  var time = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  if (d.toDateString() === n.toDateString()) return 'сегодня в ' + time;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + ' в ' + time;
}

function renderAnalyticsResult(body, insights, recs, demo, remaining, cachedAt) {
  var sub = document.getElementById('analytics-hdr-sub');
  if (sub) sub.textContent = demo ? 'Пример — как будет с твоими данными'
    : cachedAt ? 'За 30 дней · от ' + _fmtAnalysisDate(cachedAt)
    : 'За 30 дней · Llama 3';
  var html = '';
  if (demo) {
    var more = (typeof remaining === 'number' && remaining > 0)
      ? 'Добавь ещё ' + remaining + ' ' + plural(remaining, 'запись', 'записи', 'записей') + ' расходов с комментариями — и здесь появятся твои реальные инсайты.'
      : 'Записывай траты с комментариями — и здесь появятся твои реальные инсайты.';
    html += '<div class="analytics-demo-note">✨ Это пример. ' + more + '</div>';
  }
  if (insights.length) {
    html += '<div class="analytics-section-label">Инсайты</div>';
    html += insights.map(function(l) {
      return '<div class="analytics-insight">' + esc(l) + '</div>';
    }).join('');
  }
  if (recs.length) {
    html += '<div class="analytics-section-label analytics-section-label--rec">Рекомендации</div>';
    html += recs.map(function(l) {
      return '<div class="analytics-insight analytics-rec">' + esc(l) + '</div>';
    }).join('');
  }
  if (!html) html = '<div class="analytics-empty">Нет данных.</div>';
  body.innerHTML = html;
  var refreshBtn = document.getElementById('analytics-refresh-btn');
  if (refreshBtn) refreshBtn.style.display = cachedAt ? '' : 'none';
}

function runAnalytics(force) {
  if (!AI_ENABLED) return;
  var modal = document.getElementById('analytics-modal');
  var body = document.getElementById('analytics-body');
  if (!modal || !body) return;
  modal.classList.add('vis');
  var refreshBtn = document.getElementById('analytics-refresh-btn');
  if (refreshBtn) refreshBtn.style.display = 'none';

  // Шлём 60 дней — движок сравнивает текущий период с предыдущим
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  var cutoffStr = cutoff.toISOString().slice(0, 10);
  var recent = S.txs.filter(function(t) { return t.date >= cutoffStr; });
  var expCount = recent.filter(function(t) { return t.type === 'expense'; }).length;

  // Мало данных — показываем пример без захода в API
  if (expCount < ANALYTICS_MIN_TX) {
    renderAnalyticsResult(body, ANALYTICS_DEMO.insights, ANALYTICS_DEMO.recommendations, true, ANALYTICS_MIN_TX - expCount);
    return;
  }

  // Кэш: повторное открытие — мгновенно готовый результат без запроса к Groq
  if (!force) {
    var cached = _aiCacheLoad();
    if (cached) {
      renderAnalyticsResult(body, cached.insights || [], cached.recommendations || [], false, 0, cached.ts);
      return;
    }
  }

  body.innerHTML = '<div class="analytics-loading"><div class="analytics-spinner"></div><span>Анализирую...</span></div>';
  // S.txs отсортирован от новых к старым — берём первые 400 (самые свежие)
  var toSend = recent.slice(0, 400);
  var seen = _aiSeenLoad();

  // Серверная функция пускает к Groq только залогиненных — шлём токен сессии
  db.auth.getSession().then(function(sess) {
    var token = sess && sess.data && sess.data.session ? sess.data.session.access_token : '';
    return fetch(API_BASE + '/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
      body: JSON.stringify({
        txs: toSend, cats: S.cats, budget: S.budget,
        seen: {
          insights: seen.insights.map(function(x) { return x.t; }),
          recKeys: seen.recKeys.map(function(x) { return x.k; })
        }
      })
    });
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.error === 'unauthorized') {
      body.innerHTML = '<div class="analytics-empty">Анализ доступен после синхронизации с сервером — проверь соединение и попробуй ещё раз.</div>';
      return;
    }
    if (data.error === 'few_data') {
      renderAnalyticsResult(body, ANALYTICS_DEMO.insights, ANALYTICS_DEMO.recommendations, true, ANALYTICS_MIN_TX - expCount);
      return;
    }
    if (data.error === 'unavailable' || (!data.insights && !data.recommendations)) {
      body.innerHTML = '<div class="analytics-empty">Нет соединения — попробуй позже.</div>';
      return;
    }
    _store(ANALYTICS_CACHE_KEY, JSON.stringify({ ts: Date.now(), insights: data.insights || [], recommendations: data.recommendations || [] }));
    _aiSeenAdd(data.insights || [], data.recKeys || []);
    renderAnalyticsResult(body, data.insights || [], data.recommendations || [], false);
  }).catch(function() {
    body.innerHTML = '<div class="analytics-empty">Нет соединения — попробуй позже.</div>';
  });
}
function closeAnalytics() {
  var modal = document.getElementById('analytics-modal');
  if (modal) modal.classList.remove('vis');
}

function renderModeRow(){
  var toggleBtn=document.getElementById('np-toggle');
  if(toggleBtn){
    toggleBtn.textContent=S.type==='income'?'+':'−';
    toggleBtn.className='np-btn np-toggle'+(S.type==='income'?' inc':'');
  }
  var enter=document.getElementById('np-enter');
  if(enter) enter.className='np-btn np-enter'+(S.type==='income'?' inc-mode':'');
}
function toggleType(){ setType(S.type==='expense'?'income':'expense'); }
function setType(t){
  S.type=t; S.catId=null;
  renderMain(); // renderMain сам вызывает renderAmountRow/renderModeRow/renderCatRow
}

// ── NUMPAD ────────────────────────────────────────────────────────────────────
function renderAmountRow(){
  var el=document.getElementById('amount-row');
  if(!el) return;
  var raw=S.amount||'0';
  var parts=raw.split('.');
  var intFormatted=fmtThousands(parts[0]);
  if(parts.length>1){
    // Целая часть большим шрифтом, дробная — маленьким
    el.innerHTML='<span class="amount-int">'+intFormatted+'</span>'
                +'<span class="amount-dec">,'+parts[1]+'</span>';
  } else {
    el.innerHTML='<span class="amount-int">'+intFormatted+'</span>';
  }
  el.style.fontSize='';
  el.style.letterSpacing='';
  // Placeholder-эффект: серый для нуля, яркий при вводе
  var isEmpty=!S.amount||S.amount==='0';
  var baseColor=S.type==='income'?'#3DBD74':'rgba(255,255,255,.9)';
  el.style.color=isEmpty?'rgba(255,255,255,.22)':baseColor;
}
function np(v){
  if(v===',') v='.';
  if(v==='.'){
    if(S.amount.includes('.')) return;      // уже есть запятая
    var intDigits=(S.amount||'0').replace(/\D/g,'').length;
    if(intDigits>=7) return;               // 7 цифр — запятая не разрешена
    S.amount=(S.amount||'0')+'.';
    renderAmountRow(); return;
  }
  var parts=S.amount.split('.');
  if(parts.length>1){
    if(parts[1].length>=2) return;          // максимум 2 знака после запятой
  } else {
    var intLimit=S.amount.includes('.')?6:7; // с дробью: 6 цифр, без: 7
    if(parts[0].replace(/\D/g,'').length>=intLimit) return;
  }
  S.amount=(S.amount==='0')?v:S.amount+v;
  renderAmountRow();
}
function npDel(){ S.amount=S.amount.slice(0,-1); renderAmountRow(); }
function confirm_(){
  const amt=parseFloat(S.amount);
  if(!amt||amt<=0){toast('Введите сумму');return;}
  if(S.type==='expense'&&!(S.budget&&S.budget.amount>0&&S.budget.deadline)){
    toast('Сначала настройте бюджет');
    return;
  }
  const note=document.getElementById('note-inp').value.trim();
  const catId=S.catId||null;
  const tx={id:genUuid(),amount:amt,type:S.type,catId:catId,note:note,date:new Date().toISOString()};
  // Для дохода с активным бюджетом — показываем sheet выбора
  const hasBudgetNow=S.budget&&S.budget.amount>0&&S.budget.deadline&&S.budget.deadline>=todayStr();
  if(S.type==='income'&&hasBudgetNow){
    _showIncomeBudgetSheet(tx);
    return;
  }
  vibrate(40);
  S.txs.unshift(tx); saveLocal(); pushTx(tx);
  S.amount=''; document.getElementById('note-inp').value=''; renderAmountRow();
  renderMain(); toastWithUndo((S.type==='expense'?'− ':'+ ')+fmt(amt)+'₽'+(catId?' · '+getCat(catId).name:''), tx);
}

// ── INCOME BUDGET SHEET ───────────────────────────────────────────────────────
var _pendingIncomeTx=null;
function _showIncomeBudgetSheet(tx){
  _pendingIncomeTx=tx;
  const cat=getCat(tx.catId);
  const heroEl=document.getElementById('inc-bud-hero');
  if(heroEl){
    heroEl.innerHTML=
      '<div class="inc-bud-sheet-avatar" style="background:'+esc((cat.color||'#3DBD74')+'22')+'">'+esc(cat.icon||'●')+'</div>'
      +'<div class="inc-bud-sheet-amt">+'+fmt(tx.amount)+' ₽</div>'
      +(cat.name?'<div class="inc-bud-sheet-cat">'+esc(cat.name)+'</div>':'');
  }
  document.getElementById('inc-budget-sheet').classList.add('vis');
}
function _incBudConfirm(inBudget){
  if(!_pendingIncomeTx) return;
  const tx=Object.assign({},_pendingIncomeTx,{inBudget});
  _pendingIncomeTx=null;
  document.getElementById('inc-budget-sheet').classList.remove('vis');
  vibrate(40);
  S.txs.unshift(tx); saveLocal(); pushTx(tx);
  S.amount=''; document.getElementById('note-inp').value=''; renderAmountRow();
  renderMain(); toastWithUndo('+ '+fmt(tx.amount)+'₽'+(tx.catId?' · '+getCat(tx.catId).name:''), tx);
}
function _incBudCancel(){
  _pendingIncomeTx=null;
  document.getElementById('inc-budget-sheet').classList.remove('vis');
}

// ── HISTORY ───────────────────────────────────────────────────────────────────
var _MONTHS_RU=['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
function fmtMonthYM(ym){ var p=ym.split('-'); return _MONTHS_RU[parseInt(p[1],10)-1]+' '+p[0]; }
// Короткая подпись для пилюли: «Июнь», но «Июнь 2025» если год не текущий
function fmtMonthPill(ym){ var p=ym.split('-'); var m=_MONTHS_RU[parseInt(p[1],10)-1]; return p[0]===todayStr().slice(0,4)?m:m+' '+p[0]; }
function getTxsForPeriod(type,catId){
  var period=S.histPeriod; // null = all time, 'YYYY-MM' = specific month
  return S.txs.filter(function(t){
    if(type&&t.type!==type) return false;
    if(catId&&t.catId!==catId) return false;
    if(period&&localDateStr(t.date).slice(0,7)!==period) return false;
    return true;
  });
}
function _histAvailMonths(){
  var set={};
  S.txs.forEach(function(t){ set[localDateStr(t.date).slice(0,7)]=true; });
  set[todayStr().slice(0,7)]=true;
  // Выбранный месяц всегда в списке, даже если из него удалили все записи
  if(S.histPeriod) set[S.histPeriod]=true;
  return Object.keys(set).sort().reverse(); // от новых к старым
}
function showHistPeriodSheet(){
  var cur=S.histPeriod||null;
  var html='<button class="hps-option'+(cur===null?' on':'')+'" onclick="selHistPeriodOption(null)">'
    +'<span>За всё время</span>'+(cur===null?_hpsCheck():'')+'</button>';
  _histAvailMonths().forEach(function(ym){
    html+='<button class="hps-option'+(cur===ym?' on':'')+'" onclick="selHistPeriodOption(\''+ym+'\')">'
      +'<span>'+fmtMonthYM(ym)+'</span>'+(cur===ym?_hpsCheck():'')+'</button>';
  });
  document.getElementById('hist-period-sheet-list').innerHTML=html;
  document.getElementById('hist-period-sheet-bg').classList.add('vis');
}
function _hpsCheck(){ return '<svg class="hps-check" width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'; }
function hideHistPeriodSheet(){ document.getElementById('hist-period-sheet-bg').classList.remove('vis'); }
function selHistPeriodOption(ym){ S.histPeriod=ym; hideHistPeriodSheet(); renderHistory(); }
function selHistType(tp){
  S.histType=(S.histType===tp?null:tp); S.histCat=null;
  updateHistTypeTabs(); renderHistory();
}
function updateHistTypeTabs(){
  var eEl=document.getElementById('htile-exp');
  var iEl=document.getElementById('htile-inc');
  if(eEl) eEl.classList.toggle('on', S.histType==='expense');
  if(iEl) iEl.classList.toggle('on', S.histType==='income');
}
function renderHistory(){
  updateHistTypeTabs();
  // histPeriod допускает только null («Всё время») или 'YYYY-MM'
  if(S.histPeriod && !/^\d{4}-\d{2}$/.test(S.histPeriod)) S.histPeriod=null;
  var plbl=document.getElementById('hist-period-label');
  if(plbl) plbl.textContent=S.histPeriod?fmtMonthPill(S.histPeriod):'Всё время';
  var aBar=document.getElementById('analytics-bar');
  if(aBar) aBar.classList.toggle('hidden', !AI_ENABLED || S.txs.length < 3);
  // Суммы считаются в рамках выбранного периода И выбранной категории
  var totalExp=getTxsForPeriod('expense',S.histCat).reduce(function(s,t){return s+t.amount;},0);
  var totalInc=getTxsForPeriod('income',S.histCat).reduce(function(s,t){return s+t.amount;},0);
  var expAmtEl=document.getElementById('hist-exp-total');
  var incAmtEl=document.getElementById('hist-inc-total');
  if(expAmtEl) expAmtEl.textContent='−'+fmt(totalExp)+' ₽';
  if(incAmtEl) incAmtEl.textContent='+'+fmt(totalInc)+' ₽';
  // Category tabs — expense first, then income (logical order)
  var visCats=S.histType
    ?S.cats.filter(function(x){return (x.ctype||'expense')===S.histType;})
    :S.cats.filter(function(x){return (x.ctype||'expense')==='expense';}).concat(S.cats.filter(function(x){return x.ctype==='income';}));
  var tabs=document.getElementById('hist-tabs');
  if(tabs) tabs.innerHTML=visCats.map(function(x){
    var isInc=(x.ctype||'expense')==='income';
    return '<button class="ctab'+(isInc?' inc':'')+(S.histCat===x.id?' on':'')+'" data-id="'+x.id+'" onclick="selHistTab(this.dataset.id)">'
      +(x.icon?x.icon+' ':'')+esc(x.name)+'</button>';
  }).join('');
  renderHistContent();
}
function selHistTab(id){ S.histCat=(S.histCat===id?null:id); renderHistory(); }
function renderHistContent(){
  var con=document.getElementById('hist-content');
  if(!con) return;
  var txs=getTxsForPeriod(S.histType,S.histCat);

  if(!txs.length){
    con.innerHTML='<div class="empty">'
      +'<div class="empty-icon" aria-hidden="true">'
      +'<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">'
      +'<path d="M9 4h6a2 2 0 0 1 2 2v0H7v0a2 2 0 0 1 2-2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
      +'<path d="M5 6h14v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
      +'<path d="M9 13h6M9 17h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
      +'</svg>'
      +'</div>'
      +'<p>'+((S.histPeriod||S.histType||S.histCat)?'Нет записей по фильтру':'Записей пока нет')+'</p></div>';
    return;
  }
  var groups={};
  txs.forEach(function(t){
    var d=localDateStr(t.date);
    if(!groups[d]) groups[d]=[];
    groups[d].push(t);
  });

  var html='';
  var sortedDays=Object.keys(groups).sort(function(a,b){ return b.localeCompare(a); });

  sortedDays.forEach(function(day){
    var dayTxs=groups[day];
    html += '<div class="day-section">';
    var dayExp=dayTxs.filter(function(t){return t.type==='expense';}).reduce(function(s,t){return s+t.amount;},0);
    var dayInc=dayTxs.filter(function(t){return t.type==='income';}).reduce(function(s,t){return s+t.amount;},0);
    var dayParts=[];
    if(dayExp>0) dayParts.push('<span class="day-sec-exp">−'+fmt(dayExp)+' ₽</span>');
    if(dayInc>0) dayParts.push('<span class="day-sec-inc">+'+fmt(dayInc)+' ₽</span>');
    html += '<div class="day-card">';
    html += '<div class="day-sec-label"><span>'+fmtDate(day)+'</span><span class="day-sec-total">'+dayParts.join('<span class="day-sec-gap"></span>')+'</span></div>';
    dayTxs.forEach(function(t){
      var cat=getCat(t.catId);
      var avatarBg=esc((cat.color||'#9E9E9E')+'22');
      var txTime=new Date(t.date).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
      var subtext=t.note||txTime;
      html += '<div class="tx-item" data-id="'+t.id+'" onclick="showTxEdit(this.dataset.id)">';
      html += '<div class="tx-avatar" style="background:'+avatarBg+'">'+(cat.icon?esc(cat.icon):'●')+'</div>';
      html += '<div class="tx-meta" style="flex:1;min-width:0;margin:0 12px">';
      html += '<span class="tx-cat-name">'+esc(cat.name)+'</span>';
      html += '<span class="tx-sub">'+esc(subtext)+'</span>';
      html += '</div>';
      html += '<div class="tx-right">';
      html += '<span class="tx-amt-main '+t.type+'">'+(t.type==='income'?'+':'−')+fmt(t.amount)+' ₽</span>';
      html += '</div></div>';
    });
    html += '</div></div>';
  });
  con.innerHTML=html;
}

// ── BUDGET ────────────────────────────────────────────────────────────────────
// S.budDays — выбранное кол-во дней (число), вычисляется из выбранной даты
// S.budget — {amount, days, set_at, deadline, spent_at_start, reset_ts}

function renderBudgetScreen(){
  var inp = document.getElementById('bud-amount');
  var baseAmt = (S.budget && Number(S.budget.amount) > 0) ? Number(S.budget.amount) : 0;
  // Показываем остаток (как главный экран): бюджет + доходы «в бюджет» − траты периода
  var remaining = baseAmt > 0 ? Math.max(0, budgetRemaining()) : 0;
  var existAmt = baseAmt > 0 ? remaining : '';
  inp.value = existAmt !== '' ? fmtBudInput(String(Math.round(Number(existAmt)))) : '';
  var _ruble = document.getElementById('bud-ruble');
  var _mirror = document.getElementById('bud-mirror');
  if(_ruble){ _ruble.style.color = existAmt !== '' ? 'rgba(255,255,255,.4)' : 'rgba(255,255,255,.18)'; }
  fitInputToMirror(inp, _mirror);

  // Дата окончания — это фиксированная сохранённая дата (deadline), а не «N дней от сегодня».
  // Поэтому показываем сохранённый deadline как есть, а S.budDays считаем как остаток дней
  // от сегодня до этого дедлайна (чтобы пересохранение давало ровно ту же дату, без дрейфа).
  var dInp = document.getElementById('bud-date-input');
  if(dInp){
    dInp.min = todayStr();
    // Прошедший дедлайн не подставляем: input его не примет, а подпись и то,
    // что реально сохранится, разъедутся. Период завершён — нужна новая дата.
    if(S.budget && S.budget.deadline && S.budget.deadline >= todayStr()){
      dInp.value = S.budget.deadline;
      S.budDays = Math.max(daysBetween(todayStr(), S.budget.deadline) + 1, 1);
    } else {
      dInp.value = '';
      S.budDays = 0;
    }
  }
  updateBudDateBtn();
  updateBudgetPreview();
  // ₽/день = остаток / оставшихся дней — одинаково с главным экраном
  if(baseAmt > 0 && S.budget.deadline) {
    var _dLeft=Math.max(daysUntil(S.budget.deadline),1);
    var _sub=document.getElementById('bud-perday-display');
    if(_sub&&remaining>0) _sub.textContent=fmt(Math.round(remaining/_dLeft))+' ₽ в день · '+S.budDays+' '+pluralDays(S.budDays);
  }
  var hintEl=document.getElementById('bud-change-hint');
  if(hintEl) hintEl.style.display=(S.budget&&Number(S.budget.amount)>0)?'':'none';
}

function onBudDateChange(){
  var inp = document.getElementById('bud-date-input');
  if(!inp || !inp.value){ S.budDays = 0; updateBudDateBtn(); updateBudgetPreview(); return; }
  var days = daysBetween(todayStr(), inp.value) + 1;
  if(days < 1){ toast('Дата должна быть сегодня или позже'); inp.value=''; S.budDays = 0; updateBudDateBtn(); updateBudgetPreview(); return; }
  S.budDays = days;
  updateBudDateBtn();
  updateBudgetPreview();
}

function updateBudDateBtn(){
  var tile = document.getElementById('bud-date-tile');
  var lbl = document.getElementById('bud-date-label');
  if(!tile || !lbl) return;
  if(S.budDays > 0){
    tile.classList.add('sel');
    var dl = new Date(daysToDeadline(S.budDays)+'T00:00:00');
    lbl.textContent = 'до '+dl.toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
  } else {
    tile.classList.remove('sel');
    lbl.textContent = 'Указать дату';
  }
}

function fmtThousands(str){
  // Единый форматер тысяч для всего приложения: "1000000" → "1 000 000"
  var parts=(str||'').split('.');
  parts[0]=parts[0].replace(/\B(?=(\d{3})+(?!\d))/g,' ');
  return parts.join('.');
}
// Алиас для совместимости
function fmtBudInput(raw){ return fmtThousands(raw); }
function onBudAmtInput(){
  var inp    = document.getElementById('bud-amount');
  var ruble  = document.getElementById('bud-ruble');
  var mirror = document.getElementById('bud-mirror');
  var raw = inp.value.replace(/[^0-9]/g,'');
  if(raw.length > 1 && raw[0] === '0') raw = '0';
  if(raw.length > 7) raw = raw.slice(0, 7);   // лимит 7 цифр
  inp.value = fmtBudInput(raw);
  // Цвет ₽: placeholder-оттенок когда пусто, активный когда есть цифры
  if(ruble){
    ruble.style.color = raw.length > 0
      ? 'rgba(255,255,255,.4)'
      : 'rgba(255,255,255,.18)';
  }
  fitInputToMirror(inp, mirror);
  updateBudgetPreview();
}

function fitInputToMirror(inp, mirror){
  if(!mirror) return;
  var display = inp.value || inp.placeholder || '0';
  mirror.textContent = display;
  var cs = window.getComputedStyle(inp);
  mirror.style.fontSize      = cs.fontSize;
  mirror.style.letterSpacing = cs.letterSpacing;
  mirror.style.fontWeight    = cs.fontWeight;
  mirror.style.fontFamily    = cs.fontFamily;
  var ls = parseFloat(cs.letterSpacing) || 0;
  var w  = mirror.offsetWidth - ls;
  // min-width:0 — не даём CSS-правилам растянуть инпут сверх нужного
  inp.style.minWidth = '0';
  inp.style.width = Math.max(10, w) + 'px';
}


function updateBudgetPreview(){
  var raw = document.getElementById('bud-amount').value.replace(/[^0-9]/g,'');
  var amt = parseInt(raw, 10) || 0;
  var sub = document.getElementById('bud-perday-display');

  if(amt > 0 && S.budDays > 0){
    sub.textContent = fmt(Math.round(amt/S.budDays))+' ₽ в день · '+S.budDays+' '+pluralDays(S.budDays);
  } else if(amt > 0){
    sub.textContent = 'Укажи дату';
  } else {
    sub.textContent = 'Сколько ты готов потратить';
  }
}
function daysToDeadline(days){
  var d = new Date();
  d.setDate(d.getDate() + days - 1);
  // Use LOCAL date components (not UTC via toISOString) to avoid timezone drift
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

async function saveBudget(){
  var raw = document.getElementById('bud-amount').value.replace(/[^0-9]/g,'');
  var amt = parseInt(raw, 10);
  if(!amt || amt <= 0){ toast('Введите сумму'); return; }
  if(!S.budDays || S.budDays <= 0){ toast('Выберите дату'); return; }

  var deadline = daysToDeadline(S.budDays);
  var startDate = todayStr();
  var now = new Date().toISOString();

  var spentAtStart = S.txs.filter(function(t){ return t.type==='expense'; })
                          .reduce(function(sum,t){ return sum+t.amount; }, 0);

  S.budget = {
    amount: amt,
    days: S.budDays,
    deadline: deadline,
    set_at: startDate,
    reset_ts: now,
    spent_at_start: spentAtStart
  };
  // Сбрасываем inBudget-флаги — их сумма уже поглощена в сохранённый amt
  S.txs.forEach(function(t){ if(t.inBudget) t.inBudget=false; });

  _budLockUntil = Date.now() + 30000; // защита 30 сек от перезаписи синком
  saveLocal();

  show('s-main');
  renderMain();
  setTimeout(renderMain, 320);
  maybeShowToggleHint();

  toast('Бюджет установлен');
  await pushBudget();
  _budLockUntil = Date.now() + 5000;
}


function genUuid(){
  try {
    if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch(e){}
  // RFC4122-ish fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){
    var r=(Math.random()*16)|0, v=c==='x'?r:(r&0x3|0x8);
    return v.toString(16);
  });
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
function selCatSettTab(t){S.catSettTab=t;renderCats();}
function renderSettings(){
  const countEl=document.getElementById('cats-count');
  if(countEl) countEl.textContent=S.cats.length;
  updateSyncCard();
}
function renderCats(){
  const cl=document.getElementById('cat-list');
  const tw=document.getElementById('cat-type-tabs-wrapper');
  if(!cl||!tw) return;
  const filteredCats=S.cats.filter(c=>(c.ctype||'expense')===S.catSettTab);
  const incClass=S.catSettTab==='income'?' inc':'';
  tw.innerHTML=`<div class="cat-type-tabs">
    <button class="cat-type-tab${S.catSettTab==='expense'?' on':''}" onclick="selCatSettTab('expense')">Расходы</button>
    <button class="cat-type-tab${incClass}${S.catSettTab==='income'?' on':''}" onclick="selCatSettTab('income')">Доходы</button>
  </div>`;
  const trashSvg='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const plusSvg='<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';
  const catItems=filteredCats.map(c=>{
    const avatarBg=esc((c.color||'#9E9E9E')+'22');
    const icon=c.icon?esc(c.icon):'●';
    return `<div class="cat-item" onclick="showCatModal('${c.id}')">`
      +`<div class="cat-avatar" style="background:${avatarBg};color:${esc(c.color||'#fff')}">${icon}</div>`
      +`<div class="cat-nm"><span class="cat-nm-text">${esc(c.name)}</span></div>`
      +`<button class="del-cat" aria-label="Удалить" onclick="event.stopPropagation();deleteCat('${c.id}')">${trashSvg}</button>`
      +`</div>`;
  }).join('');
  const emptyMsg=filteredCats.length===0
    ?'<div class="sett-row" style="justify-content:center;border-bottom:1px solid rgba(255,255,255,.06)"><span style="color:rgba(255,255,255,.3);font-size:14px">Нет категорий</span></div>'
    :'';
  const addItem=`<div class="cat-item cat-add-item" onclick="showCatModal()">`
    +`<div class="cat-avatar cat-avatar--add">${plusSvg}</div>`
    +`<div class="cat-nm"><span class="cat-nm-text cat-add-label">Добавить категорию</span></div>`
    +`</div>`;
  cl.innerHTML=emptyMsg+catItems+addItem;
}
function showMyCode(){
  const code=localStorage.getItem(K_CODE)||(currentUser&&currentUser.user_metadata&&currentUser.user_metadata.code)||'';
  if(!code){toast('Код не привязан');return;}
  showCodeRevealModal(code,true);
}
function deleteCat(id){
  customConfirm('Удалить категорию?').then(ok=>{ if(!ok) return; S.cats=S.cats.filter(c=>c.id!==id);saveLocal();pushCats();deleteCatRemote(id);renderCats();renderSettings();renderCatRow();toast('Удалено'); });
}
function exportData(){
  const blob=new Blob([JSON.stringify({txs:S.txs,cats:S.cats,budget:S.budget,date:new Date().toISOString()},null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='doshik-'+todayStr()+'.json';a.click();URL.revokeObjectURL(a.href);toast('Экспортировано');
}
function importData(e){
  const file=e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=async function(ev){
    try{
      const d=JSON.parse(ev.target.result);
      if(!d.txs||!d.cats){toast('Неверный формат файла');return;}
      if(!await customConfirm('Заменить все текущие данные данными из файла?','Заменить')) return;
      S.txs=d.txs||[];
      S.cats=(d.cats||[]).map(c=>({...c,ctype:c.ctype||'expense'}));
      var ib=d.budget||{};
      var ibSetAt=ib.set_at||null;
      var ibBaseline=(ib.spent_at_start!=null)?Number(ib.spent_at_start)
        :S.txs.filter(t=>{if(t.type!=='expense')return false;if(!ibSetAt)return true;return localDateStr(t.date)<ibSetAt;}).reduce((s,t)=>s+t.amount,0);
      S.budget={amount:Number(ib.amount)||0,days:Number(ib.days)||0,deadline:ib.deadline||null,set_at:ibSetAt,spent_at_start:ibBaseline,reset_ts:ib.reset_ts||null};
      saveLocal();
      if(currentUser){
        const txRows=S.txs.map(t=>({id:t.id,user_id:currentUser.id,amount:t.amount,type:t.type,cat_id:t.catId,note:t.note||'',date:t.date}));
        if(txRows.length){
          const {error}=await db.from('transactions').upsert(txRows);
          if(error){ setSyncDot(false); S.txs.forEach(t=>offlineQueue.push({op:'pushTx',data:t})); saveQueue(); }
        }
        pushCats(); pushBudget();
      }
      renderMain(); renderSettings(); toast('Данные импортированы');
    }catch(err){ toast('Ошибка чтения файла'); }
  };
  reader.readAsText(file);
  e.target.value='';
}
async function clearAll(){
  if(!await customConfirm('Сбросить всё? Все транзакции и бюджет удалятся, категории вернутся к стандартным.','Сбросить')) return;
  if(currentUser){
    // Сначала удалить ВСЁ из Supabase — если не вышло, не трогаем локальные данные,
    // иначе после reload синк вернёт «удалённое» с сервера
    const results=await Promise.all([
      db.from('transactions').delete().eq('user_id',currentUser.id),
      db.from('budget_settings').delete().eq('user_id',currentUser.id),
      db.from('categories').delete().eq('user_id',currentUser.id),
    ]);
    if(results.some(r=>r.error)){ toast('Не удалось очистить сервер — проверь соединение'); return; }
    await db.from('budget_history').delete().eq('user_id',currentUser.id); // таблицы может не быть — ошибку игнорируем
  }
  offlineQueue=[]; saveQueue();
  S.txs=[];S.cats=[...DEF_CATS];S.budget=emptyBudget();
  saveLocal();
  if(currentUser) await seedDefaultCats();
  toast('Данные сброшены');
  setTimeout(()=>location.reload(),800);
}

// ── CAT MODAL ─────────────────────────────────────────────────────────────────
var _editCatId=null;
function showCatModal(editId){
  _editCatId=editId||null;
  const cat=editId?S.cats.find(c=>c.id===editId):null;
  S.budColor=cat?cat.color:COLORS[0];
  S.budIcon=cat?(cat.icon||ICON_OPTIONS[0]):ICON_OPTIONS[0];
  document.getElementById('cat-name-inp').value=cat?cat.name:'';
  document.getElementById('cat-modal-title').textContent=cat?'Редактировать категорию':'Новая категория';
  document.getElementById('cat-save-btn').textContent=cat?'Сохранить':'Добавить';
  var ig=document.getElementById('icon-grid');
  if(ig) ig.innerHTML=ICON_OPTIONS.map(function(ic){
    return '<div class="icon-opt'+(ic===S.budIcon?' sel':'')+'" data-ic="'+ic+'" onclick="selIcon(this.dataset.ic)">'+ic+'</div>';
  }).join('');
  document.getElementById('color-grid').innerHTML=COLORS.map(function(cl){
    return '<div class="clr-dot'+(cl===S.budColor?' sel':'')+'" data-clr="'+cl+'" style="background:'+cl+'" onclick="selColor(this.dataset.clr)"></div>';
  }).join('');
  updateCatPreview();
  document.getElementById('cat-modal').classList.add('vis');
  // Скроллим выбранные элементы в зону видимости стрипов
  setTimeout(function(){
    var selIcon=document.querySelector('#icon-grid .icon-opt.sel');
    if(selIcon) selIcon.scrollIntoView({inline:'center',block:'nearest'});
    var selClr=document.querySelector('#color-grid .clr-dot.sel');
    if(selClr) selClr.scrollIntoView({inline:'center',block:'nearest'});
    document.getElementById('cat-name-inp').focus();
  },50);
}
function updateCatPreview(){
  var pv=document.getElementById('cat-preview');
  if(!pv) return;
  var c=S.budColor||COLORS[0];
  pv.textContent=S.budIcon||'●';
  pv.style.background=c+'2a';
  pv.style.color=c;
}
function hideCatModal(){ _editCatId=null; document.getElementById('cat-modal').classList.remove('vis'); }
function modalBgClick(e){ if(e.target===document.getElementById('cat-modal')) hideCatModal(); }
function selIcon(ic){
  S.budIcon=ic;
  document.querySelectorAll('.icon-opt').forEach(el=>el.classList.toggle('sel',el.textContent.trim()===ic));
  updateCatPreview();
}
function selColor(c){
  S.budColor=c;
  document.querySelectorAll('.clr-dot').forEach(el=>el.classList.toggle('sel',el.dataset.clr===c));
  updateCatPreview();
}
function saveCat(){
  const name=document.getElementById('cat-name-inp').value.trim();
  if(!name){toast('Введите название');return;}
  if(_editCatId){
    const idx=S.cats.findIndex(c=>c.id===_editCatId);
    _editCatId=null;
    if(idx<0){ hideCatModal(); return; }
    S.cats[idx]={...S.cats[idx],name,color:S.budColor,icon:S.budIcon||ICON_OPTIONS[0]};
    saveLocal();pushCat(S.cats[idx]);hideCatModal();renderCats();renderSettings();renderCatRow();
    toast('"'+name+'" обновлена');
  } else {
    const onCats=!document.getElementById('s-cats').classList.contains('hidden');
    const ctype=onCats?S.catSettTab:S.type;
    const _sfx=ctype==='income'?'_inc':'_exp';
    S.cats.unshift({id:'c'+Date.now()+_sfx,name,color:S.budColor,icon:S.budIcon||ICON_OPTIONS[0],ctype});
    saveLocal();pushCat(S.cats[0]);hideCatModal();renderCats();renderSettings();renderCatRow();
    setTimeout(()=>{ const r=document.getElementById('cat-row'); if(r) r.scrollLeft=0; },60);
    toast('"'+name+'" добавлена');
  }
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function getCat(id){ if(!id) return {name:'Без категории',color:'#9E9E9E',icon:''}; return S.cats.find(function(x){return x.id===id;})||{name:'Без категории',color:'#9E9E9E',icon:''}; }
function todayStr(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
// Мемоизация: вызывается на каждую транзакцию при каждом рендере, new Date() дорогой
const _ldsCache=new Map();
function localDateStr(isoStr){
  let v=_ldsCache.get(isoStr);
  if(v===undefined){
    const d=new Date(isoStr);
    v=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    if(_ldsCache.size>10000) _ldsCache.clear();
    _ldsCache.set(isoStr,v);
  }
  return v;
}
function daysUntil(ds){
  if(!ds||typeof ds!=='string') return 1;
  const p=ds.split('-'); const t=new Date(+p[0],+p[1]-1,+p[2]);
  const n=new Date(); n.setHours(0,0,0,0);
  return Math.max(1,Math.ceil((t-n)/864e5));
}
function fmt(n){ var r=Math.round(n*100)/100; return r.toLocaleString('ru-RU',{maximumFractionDigits:2}); }
function fmtDate(ds){
  const t=todayStr();
  const y=new Date(); y.setDate(y.getDate()-1);
  const ys=y.getFullYear()+'-'+String(y.getMonth()+1).padStart(2,'0')+'-'+String(y.getDate()).padStart(2,'0');
  if(ds===t)return'Сегодня';if(ds===ys)return'Вчера';
  return new Date(ds+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
}

// Короткая дата для пилюли бюджета: «31 авг». Год не пишем — бюджет ставится
// максимум на несколько месяцев вперёд, а место в шапке дорогое.
function fmtDeadlineShort(ds){
  return new Date(ds+'T12:00:00')
    .toLocaleDateString('ru-RU',{day:'numeric',month:'short'})
    .replace('.','');
}

function pluralDays(n){
  if(n%10===1&&n%100!==11)return'день';
  if([2,3,4].includes(n%10)&&![12,13,14].includes(n%100))return'дня';
  return'дней';
}
// ── TX EDIT MODAL ─────────────────────────────────────────────────────────────
var _editTxId=null;
var _editTxCatId=null;
var _editTxDate=null;

function showTxEdit(id){
  var tx=S.txs.find(function(t){return t.id===id;});
  if(!tx) return;
  _editTxId=id;
  _editTxCatId=tx.catId||null;
  _editTxDate=tx.date;
  var cat=getCat(tx.catId);
  var avatarEl=document.getElementById('tx-edit-avatar');
  var amtInputEl=document.getElementById('tx-edit-amount');
  var dateDisplayEl=document.getElementById('tx-edit-date-display');
  var dateInpEl=document.getElementById('tx-edit-date-input');
  var noteEl=document.getElementById('tx-edit-note');
  avatarEl.style.background=esc((cat.color||'#9E9E9E')+'26');
  avatarEl.textContent=cat.icon||'●';
  if(amtInputEl){
    amtInputEl.value=fmt(tx.amount);
    amtInputEl.style.color=tx.type==='income'?'#3DBD74':'rgba(255,255,255,.95)';
  }
  var signEl=document.getElementById('tx-edit-sign');
  if(signEl){
    signEl.textContent=tx.type==='income'?'+':'−';
    signEl.classList.toggle('inc',tx.type==='income');
  }
  setTimeout(fitTxAmtInput,0);
  var d=new Date(tx.date);
  if(dateDisplayEl) dateDisplayEl.textContent=fmtDate(localDateStr(tx.date))+' · '+d.toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
  if(dateInpEl){ dateInpEl.value=localDateStr(tx.date); dateInpEl.max=todayStr(); }
  noteEl.value=tx.note||'';
  renderTxEditCats(tx.type);
  document.getElementById('tx-edit-modal').classList.add('vis');
}

function renderTxEditCats(txType){
  var cats=S.cats.filter(function(c){return (c.ctype||'expense')===txType;});
  var listEl=document.getElementById('tx-edit-cat-list');
  if(!listEl) return;
  listEl.innerHTML=cats.map(function(c){
    var isSel=_editTxCatId===c.id;
    return '<button class="assign-cat-item'+(isSel?' sel-cat':'')+'" data-cid="'+c.id+'" onclick="selectEditCat(this.dataset.cid)">'
      +'<div style="width:10px;height:10px;border-radius:50%;background:'+esc(c.color)+';flex-shrink:0"></div>'
      +(c.icon?'<span>'+esc(c.icon)+'</span>':'')
      +'<span style="flex:1">'+esc(c.name)+'</span>'
      +(isSel?'<span style="color:#F5A623;font-size:16px;flex-shrink:0">✓</span>':'')
      +'</button>';
  }).join('');
}

function selectEditCat(catId){
  _editTxCatId=(_editTxCatId===catId?null:catId);
  var tx=S.txs.find(function(t){return t.id===_editTxId;});
  if(tx) renderTxEditCats(tx.type);
}

function fitTxAmtInput(){
  var inp=document.getElementById('tx-edit-amount');
  var mir=document.getElementById('tx-edit-amt-mirror');
  if(!inp||!mir) return;
  mir.textContent=inp.value||inp.placeholder||'0';
  var cs=window.getComputedStyle(inp);
  mir.style.fontSize=cs.fontSize;
  mir.style.letterSpacing=cs.letterSpacing;
  mir.style.fontWeight=cs.fontWeight;
  mir.style.fontFamily=cs.fontFamily;
  var ls=parseFloat(cs.letterSpacing)||0;
  var w=mir.offsetWidth-ls;
  inp.style.width=Math.max(12,w+2)+'px';
}

function onTxEditAmtInput(){
  var inp=document.getElementById('tx-edit-amount');
  if(!inp) return;
  // Разрешаем цифры, одну точку или запятую, пробелы как разделители тысяч
  var raw=inp.value.replace(/[^\d.,]/g,'').replace(',','.');
  var parts=raw.split('.');
  var intDigits=parts[0].replace(/\D/g,'').slice(0,8);
  var fraction=parts.length>1?parts[1].replace(/\D/g,'').slice(0,2):'';
  var formatted=intDigits.replace(/\B(?=(\d{3})+(?!\d))/g,' ');
  if(parts.length>1) formatted += ','+fraction;
  inp.value=formatted;
  fitTxAmtInput();
}

function hideTxEdit(){
  _editTxId=null;
  _editTxCatId=null;
  _editTxDate=null;
  document.getElementById('tx-edit-modal').classList.remove('vis');
}

function onTxEditDateChange(){
  const inp=document.getElementById('tx-edit-date-input');
  if(!inp||!inp.value) return;
  if(inp.value>todayStr()){
    toast('Нельзя ставить будущую дату');
    inp.value=localDateStr(_editTxDate||new Date().toISOString());
    return;
  }
  const orig=new Date(_editTxDate||new Date().toISOString());
  const [y,m,d]=inp.value.split('-').map(Number);
  orig.setFullYear(y,m-1,d);
  _editTxDate=orig.toISOString();
  const disp=document.getElementById('tx-edit-date-display');
  if(disp) disp.textContent=fmtDate(localDateStr(_editTxDate))+' · '+orig.toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
}

function saveTxEdit(){
  if(!_editTxId) return;
  var tx=S.txs.find(function(t){return t.id===_editTxId;});
  if(!tx){hideTxEdit();return;}
  tx.catId=_editTxCatId||null;
  tx.note=(document.getElementById('tx-edit-note').value||'').trim();
  if(_editTxDate) tx.date=_editTxDate;
  var _amtInp=document.getElementById('tx-edit-amount');
  if(_amtInp){
    var _newAmt=parseFloat(String(_amtInp.value).replace(/\s/g,'').replace(',','.'));
    if(_newAmt>0) tx.amount=_newAmt;
  }
  saveLocal(); pushTx(tx);
  hideTxEdit(); renderHistory(); renderMain();
  toast('Сохранено');
}

async function deleteTxFromEdit(){
  if(!_editTxId) return;
  if(!await customConfirm('Удалить запись?')) return;
  var id=_editTxId;
  hideTxEdit();
  S.txs=S.txs.filter(function(t){return t.id!==id;});
  saveLocal(); deleteTxRemote(id); renderHistory(); renderMain();
  toast('Удалено');
}

// ── CUSTOM CONFIRM ───────────────────────────────────────────────────────────
let _confirmCb=null;
function customConfirm(msg,okText='Удалить',dangerOk=true){
  const el=document.getElementById('confirm-modal');
  document.getElementById('confirm-msg').textContent=msg;
  const ok=document.getElementById('confirm-ok-btn');
  ok.textContent=okText;
  ok.style.background=dangerOk==='warn'?'#F5A623':dangerOk?'#FF3B30':'#3DBD74';
  const icon=document.getElementById('confirm-icon');
  if(icon) icon.classList.toggle('modal-hero-icon--danger',!!dangerOk);
  el.classList.add('vis');
  return new Promise(r=>{_confirmCb=r;});
}
function _confOk(){ document.getElementById('confirm-modal').classList.remove('vis'); if(_confirmCb){_confirmCb(true);_confirmCb=null;} }
function _confNo(){ document.getElementById('confirm-modal').classList.remove('vis'); if(_confirmCb){_confirmCb(false);_confirmCb=null;} }


var _lastTx=null;
function toastUndo(){
  if(!_lastTx) return;
  S.txs=S.txs.filter(function(t){ return t.id!==_lastTx.id; });
  deleteTxRemote(_lastTx.id);
  saveLocal(); renderMain(); _lastTx=null;
  toast('Отменено');
}

// msg всегда эскейпим — туда попадают пользовательские строки (имена категорий)
function toastWithUndo(msg, tx){
  _lastTx=tx;
  const t=document.getElementById('toast');
  t.innerHTML='<span>'+esc(msg)+'</span><button class="toast-undo" onclick="toastUndo()">Отменить</button>';
  t.classList.add('show','toast--undo');
  clearTimeout(t._t);
  t._t=setTimeout(function(){ t.classList.remove('show','toast--undo'); _lastTx=null; }, 6000);
}
function toast(msg){
  const t=document.getElementById('toast');
  t.innerHTML='<span>'+esc(msg)+'</span>';
  t.classList.remove('toast--undo');
  t.classList.add('show');
  clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2200);
}

// ── CODE RECOVERY AUTH ────────────────────────────────────────────────────────
const K_CODE='tk_rccode';
const K_OB='_ob'; // флаг: онбординг пройден

function generateCode(){
  const ch='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c='';for(let i=0;i<8;i++){if(i===4)c+='-';c+=ch[Math.floor(Math.random()*ch.length)];}
  return c;
}
function fmtCodeInput(el){
  let v=el.value.replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0,8);
  if(v.length>4)v=v.slice(0,4)+'-'+v.slice(4);
  el.value=v;
}

function hideSplash(){
  const el=document.getElementById('splash');
  if(!el||el.classList.contains('hiding')) return;
  el.classList.add('hiding');
  setTimeout(()=>el.remove(),400);
}

async function initApp(){
  loadQueue();
  const saved=localStorage.getItem(K_CODE);

  // Путь 1: K_CODE есть — входим
  if(saved){
    try{
      const{data,error}=await db.auth.signInWithPassword({email:`${saved}@doshik.app`,password:saved});
      if(!error&&data.user){currentUser=data.user;loadLocal();goMain();syncFromSupabase().then(()=>renderMain());return;}
    }catch(e){}
  }

  // Путь 2: Есть сессия браузера
  try{
    const{data:{session}}=await db.auth.getSession();
    if(session&&session.user){
      currentUser=session.user;
      // Пробуем восстановить код из user_metadata (резервный уровень)
      const metaCode=session.user.user_metadata?.code;
      if(metaCode&&!saved){
        localStorage.setItem(K_CODE,metaCode);
        loadLocal();goMain();syncFromSupabase().then(()=>renderMain());
        return;
      }
      // Если кода нет совсем — создаём новый через updateUser
      if(!saved&&!metaCode){
        await generateAndLinkCode(true);
      } else {
        loadLocal();goMain();syncFromSupabase();
      }
      return;
    }
  }catch(e){}

  // Путь 3: Нет ничего — экран входа
  hideSplash();
  document.getElementById('s-auth').style.display='flex';
}
async function generateAndLinkCode(showModal=false){
  const code=generateCode();
  // Сохраняем в localStorage СРАЗУ — до любых сетевых вызовов
  localStorage.setItem(K_CODE,code);
  try{
    // updateUser обновляет ТЕКУЩЕГО юзера (не создаёт нового)
    const{error}=await db.auth.updateUser({
      email:`${code}@doshik.app`,
      password:code,
      data:{code} // резервная копия в user_metadata
    });
    if(!error){
      loadLocal();goMain();await syncFromSupabase();await seedDefaultCats();
      if(showModal)setTimeout(()=>showCodeRevealModal(code),600);
      setSyncDot(true);return;
    }
  }catch(e){}
  // Даже если Supabase недоступен — код сохранён в localStorage
  loadLocal();goMain();syncFromSupabase();
  if(showModal)setTimeout(()=>showCodeRevealModal(code),600);
}
async function createNewAccount(btn){
  btn.disabled=true;btn.textContent='Создаём...';
  const code=generateCode();
  // Сохраняем код СРАЗУ — до сетевого вызова
  localStorage.setItem(K_CODE,code);
  try{
    const{data,error}=await db.auth.signUp({
      email:`${code}@doshik.app`,
      password:code,
      options:{data:{code}} // резервная копия в user_metadata
    });
    if(error)throw error;
    currentUser=data.user||data.session?.user;
    document.getElementById('s-auth').style.display='none';
    loadLocal();goMain();
    if(currentUser){await seedDefaultCats();setSyncDot(true);}
    setTimeout(()=>showOnboarding(code),0);
  }catch(e){
    document.getElementById('s-auth').style.display='none';
    loadLocal();goMain();
    setTimeout(()=>showOnboarding(code),0);
    setSyncDot(false);
    btn.disabled=false;btn.textContent='Начать с нуля';
    document.getElementById('auth-err').textContent='Ошибка соединения с сервером';
  }
}
async function recoverWithCode(){
  const raw=document.getElementById('auth-code').value.replace(/[^A-Za-z0-9]/g,'').toUpperCase();
  const code=raw.length===8?raw.slice(0,4)+'-'+raw.slice(4):'';
  if(code.length!==9){document.getElementById('auth-err').textContent='Введите код из 8 символов';return;}
  const btn=document.querySelector('#s-auth .btn-primary');
  const orig=btn.textContent;btn.disabled=true;btn.textContent='Проверяем...';
  document.getElementById('auth-err').textContent='';
  try{
    const{data,error}=await db.auth.signInWithPassword({email:`${code}@doshik.app`,password:code});
    if(error||!data.user){
      document.getElementById('auth-err').textContent='Код не найден. Проверьте правильность';
      btn.disabled=false;btn.textContent=orig;return;
    }
    localStorage.setItem(K_CODE,code);currentUser=data.user;
    document.getElementById('s-auth').style.display='none';
    // Не подгружаем локальные данные предыдущего юзера — берём только с сервера
    S.txs=[];S.cats=[];S.budget=emptyBudget();
    saveLocal();
    goMain();
    await syncFromSupabase();
    renderMain();
    setSyncDot(true);toast('Данные восстановлены');
    setTimeout(()=>showCodeRevealModal(code),700);
  }catch(e){
    document.getElementById('auth-err').textContent='Ошибка соединения с сервером';
    btn.disabled=false;btn.textContent=orig;
  }
}
function showCodeRevealModal(code,fromSettings){
  document.getElementById('code-reveal-value').textContent=code;
  document.getElementById('code-reveal-hint').textContent=fromSettings
    ?'Сохрани его в надёжном месте — без него не вернуть данные, если потеряешь доступ к устройству.'
    :'Он нужен, чтобы вернуть данные на другом устройстве. Найдёшь его в настройках в любой момент.';
  document.getElementById('code-reveal-foot').style.display=fromSettings?'':'none';
  const b1=document.getElementById('code-reveal-btn-1');
  const b2=document.getElementById('code-reveal-btn-2');
  if(fromSettings){
    b1.textContent='Скопировать код';b1.dataset.action='copy';
    b2.textContent='Понял';b2.dataset.action='dismiss';
  }else{
    b1.textContent='Понятно';b1.dataset.action='dismiss';
    b2.textContent='Скопировать код';b2.dataset.action='copy';
  }
  document.getElementById('code-reveal-modal').classList.add('vis');
}
function dismissCodeReveal(){document.getElementById('code-reveal-modal').classList.remove('vis');}
function onCodeRevealBtn(b){
  if(b.dataset.action==='copy')copyCodeReveal(b);
  else dismissCodeReveal();
}
function copyCodeReveal(b){
  const code=document.getElementById('code-reveal-value').textContent;
  copyToClipboard(code).then(()=>{
    const btn=b||document.querySelector('#code-reveal-modal [data-action="copy"]');
    if(!btn)return;
    btn.textContent='Скопировано';setTimeout(()=>btn.textContent='Скопировать код',1800);
  });
}

function copyToClipboard(text){
  if(navigator.clipboard&&navigator.clipboard.writeText)
    return navigator.clipboard.writeText(text).catch(()=>legacyCopy(text));
  return legacyCopy(text);
}
function legacyCopy(text){
  const ta=document.createElement('textarea');
  ta.value=text;ta.style.cssText='position:fixed;opacity:0;pointer-events:none';
  document.body.appendChild(ta);ta.select();document.execCommand('copy');
  document.body.removeChild(ta);return Promise.resolve();
}


function showEnterCodeModal(){
  customConfirm('Данные этого устройства будут заменены данными введённого аккаунта.','Продолжить','warn').then(ok=>{
    if(!ok) return;
    document.getElementById('enter-code-inp').value='';
    document.getElementById('enter-code-err').textContent='';
    document.getElementById('enter-code-modal').classList.add('vis');
    setTimeout(()=>document.getElementById('enter-code-inp').focus(),300);
  });
}
function hideEnterCodeModal(){
  document.getElementById('enter-code-modal').classList.remove('vis');
}
async function submitEnterCode(){
  const raw=document.getElementById('enter-code-inp').value.replace(/[^A-Za-z0-9]/g,'').toUpperCase();
  const code=raw.length===8?raw.slice(0,4)+'-'+raw.slice(4):'';
  if(code.length!==9){document.getElementById('enter-code-err').textContent='Введите код из 8 символов';return;}
  const btn=document.getElementById('enter-code-btn');
  btn.disabled=true;btn.textContent='Проверяем...';
  document.getElementById('enter-code-err').textContent='';
  try{
    const{data,error}=await db.auth.signInWithPassword({email:`${code}@doshik.app`,password:code});
    if(error||!data.user){
      document.getElementById('enter-code-err').textContent='Код не найден. Проверьте правильность';
      btn.disabled=false;btn.textContent='Войти';return;
    }
    localStorage.setItem(K_CODE,code);
    currentUser=data.user;
    hideEnterCodeModal();
    // Reset local data and sync from server
    S.txs=[];S.cats=[];S.budget=emptyBudget();
    saveLocal();
    await syncFromSupabase();
    renderMain();
    toast('Данные восстановлены');
  }catch(e){
    document.getElementById('enter-code-err').textContent='Ошибка соединения';
    btn.disabled=false;btn.textContent='Войти';
  }
}


// Синхронизация при возврате на вкладку / разблокировке экрана
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden&&currentUser){
    syncFromSupabase().then(()=>{
      renderMain();
      if(!document.getElementById('s-history').classList.contains('hidden')) renderHistory();
    }).catch(()=>{});
  }
});
initApp();

// ── TOGGLE HINT ──────────────────────────────────────────────────────────────
const K_TGL='_tgl';

function showToggleHint(){
  const btn=document.getElementById('np-toggle');
  const hint=document.getElementById('toggle-hint');
  if(!btn||!hint)return;
  const rect=btn.getBoundingClientRect();
  const gap=12;
  const w=hint.offsetWidth||140;
  const btnCX=rect.left+rect.width/2;
  const left=Math.max(gap, btnCX-w/2);
  hint.style.left=left+'px';
  hint.style.top=(rect.top-12)+'px';
  hint.style.transform='translateY(-100%)';
  hint.style.setProperty('--arrow-left',Math.round(btnCX-left)+'px');
  hint.classList.add('show');
  btn.classList.add('np-toggle--hint');
  const dismiss=()=>{hint.classList.remove('show');btn.classList.remove('np-toggle--hint');};
  btn.addEventListener('click',dismiss,{once:true});
  setTimeout(dismiss,5000);
}

let _tglPending=false;
function maybeShowToggleHint(){
  if(localStorage.getItem(K_TGL)||_tglPending)return;
  _tglPending=true;
  setTimeout(()=>{
    _tglPending=false;
    if(document.getElementById('onboarding').classList.contains('vis'))return;
    localStorage.setItem(K_TGL,'1');
    showToggleHint();
  },1500);
}

// ── ONBOARDING ───────────────────────────────────────────────────────────────
let _obIdx=0, _obCode='', _obSlides=[], _obBudDays=0;

function buildObSlides(code){
  return [
    {
      icon:'🍜',
      title:'Привет! Ты в Дошике',
      text:'Лучшее приложение для учёта доходов и расходов. Здесь ты разберёшься, на что улетают деньги.',
      btn:'Кайф, погнали!'
    },
    {
      icon:'🔑', code,
      title:'Это твой код доступа',
      text:'Он восстановит все данные на любом устройстве. Всегда доступен в настройках.',
      btn:'Что там дальше?'
    },
    {
      budgetForm:true, icon:'💰',
      title:'Сперва задай бюджет',
      btn:'Сделаю позже'
    },
    {
      toggleDemo:true,
      title:'Тратишь или получаешь?',
      text:'Тратишь деньги — оранжевый минус. Получил деньги — зелёный плюс. Попробуй покликай на иконку сверху',
      btn:'Прошу доходы у вселенной'
    },
    {
      icon:'🔍',
      title:'Где деньги, Лебовски?',
      text:'Всё фиксируется: траты, доходы и категории. Выбирай период в истории (месяц или всё время) и смотри, куда уходят деньги.',
      btn:'Понятненько'
    },
    {
      icon:'🤖', ai:true,
      title:'AI-анализ трат',
      text:'Накопишь записей — нажми «AI-анализ трат» внизу истории. Нейросеть разберёт твои расходы и скажет, где реально утекают деньги.',
      btn:'Красавчик!'
    },
    {
      icon:'🎤🧑',
      title:'Окээээй лэтсгоу!',
      text:'Вноси каждую трату, даже самую мелкую. Уже через неделю увидишь, куда улетают деньги. И да — единственный доширак, который тебе нужен, это мы 💛',
      btn:'Поехали!'
    }
  ].filter(sl=>!sl.ai||AI_ENABLED);  // слайд про AI показываем только когда фича включена
}

function _obRenderSlides(){
  document.getElementById('ob-track').innerHTML=_obSlides.map(sl=>{
    if(sl.budgetForm){
      const calSvg=`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="18" height="16" rx="2.5" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
      return `<div class="ob-slide ob-slide-compact">
        <div class="ob-icon">${sl.icon}</div>
        <div class="ob-title">${sl.title}</div>
        <div class="ob-bud-form">
          <div class="ob-bud-hero">
            <div style="position:relative">
              <span class="bud-mirror" id="ob-bud-mirror" aria-hidden="true"></span>
              <div class="bud-amount-wrap" onclick="document.getElementById('ob-bud-amount').focus()">
                <input type="text" inputmode="numeric" id="ob-bud-amount" class="bud-amount-hero"
                  placeholder="0" oninput="obBudAmtInput()" autocomplete="off" spellcheck="false">
                <span class="bud-ruble" id="ob-bud-ruble">₽</span>
              </div>
            </div>
          </div>
          <div class="ob-bud-perday" id="ob-bud-preview">До зарплаты, халтурки или доната от любимой мамы</div>
          <label class="bud-date-tile" id="ob-bud-date-tile" for="ob-bud-date-input">
            <span class="bud-date-icon">${calSvg}</span>
            <span class="bud-date-text">
              <span class="bud-date-cap">До какого числа</span>
              <span class="bud-date-val" id="ob-bud-date-label">Указать дату</span>
            </span>
            <input type="date" id="ob-bud-date-input" onchange="obBudDateChange()">
          </label>
          <button class="action-btn btn-primary ob-bud-save-btn" onclick="obSaveBudget()">Сохранить и продолжить</button>
        </div>
      </div>`;
    }
    if(sl.toggleDemo){
      return `<div class="ob-slide">
        <div class="ob-tgl-wrap">
          <div class="ob-tgl-icon exp" id="ob-tgl-icon" onclick="obToggleDemo()">−</div>
        </div>
        <div class="ob-title">${sl.title}</div>
        <div class="ob-text">${sl.text}</div>
      </div>`;
    }
    const topHtml=`<div class="ob-icon">${sl.icon}</div>`;
    const codeHtml=sl.code
      ?`<div class="ob-code-block"><div class="code-display ob-code ob-code-tap" onclick="obCopyCode(this)">${sl.code}</div><div class="ob-copy-hint">нажми чтобы скопировать</div></div>`
      :'';
    return `<div class="ob-slide">${topHtml}<div class="ob-title">${sl.title}</div>${codeHtml}<div class="ob-text">${sl.text}</div></div>`;
  }).join('');
}

function _obUpdateState(){
  document.getElementById('ob-dots').querySelectorAll('.ob-dot').forEach((d,i)=>d.classList.toggle('on',i===_obIdx));
  const sl=_obSlides[_obIdx];
  const btn=document.getElementById('ob-btn');
  btn.textContent=sl.btn||'Далее';
  btn.classList.toggle('ob-cta-ghost',!!sl.budgetForm);
}

function showOnboarding(code){
  _obCode=code||''; _obIdx=0;
  _obSlides=buildObSlides(code);
  _obRenderSlides();
  document.getElementById('ob-dots').innerHTML=_obSlides.map((_,i)=>`<div class="ob-dot${i===0?' on':''}" onclick="obGoTo(${i})"></div>`).join('');
  document.getElementById('ob-btn').textContent=_obSlides[0].btn||'Далее';
  document.getElementById('ob-track').style.transform='translateX(0)';
  document.getElementById('onboarding').classList.add('vis');
}

function obNext(){
  if(_obIdx<_obSlides.length-1){
    _obIdx++;
    document.getElementById('ob-track').style.transform=`translateX(${-_obIdx*100}%)`;
    _obUpdateState();
  }else{
    closeOnboarding();
  }
}

function obGoTo(idx){
  if(idx<0||idx>=_obSlides.length)return;
  _obIdx=idx;
  document.getElementById('ob-track').style.transform=`translateX(${-_obIdx*100}%)`;
  _obUpdateState();
}

function closeOnboarding(){
  localStorage.setItem(K_OB,'1');
  document.getElementById('onboarding').classList.remove('vis');
  renderMain();
  // Подсказка к кнопке +/− только если бюджет уже задан в онбординге
  if(S.budget&&S.budget.amount>0) maybeShowToggleHint();
}

function obCopyCode(el){
  if(!_obCode)return;
  copyToClipboard(_obCode).then(()=>{
    const hint=el.nextElementSibling;
    if(hint){hint.textContent='✓ скопировано';hint.style.color='#3DBD74';}
    el.style.borderColor='rgba(61,189,116,.4)';
    setTimeout(()=>{
      if(hint){hint.textContent='нажми чтобы скопировать';hint.style.color='';}
      el.style.borderColor='';
    },2000);
  });
}

function obBudAmtInput(){
  var inp=document.getElementById('ob-bud-amount');
  var ruble=document.getElementById('ob-bud-ruble');
  var mirror=document.getElementById('ob-bud-mirror');
  var raw=inp.value.replace(/[^0-9]/g,'');
  if(raw.length>1&&raw[0]==='0') raw='0';
  if(raw.length>7) raw=raw.slice(0,7);   // лимит 7 цифр — как на экране бюджета
  inp.value=fmtBudInput(raw);
  if(ruble) ruble.style.color=raw.length>0?'rgba(255,255,255,.4)':'rgba(255,255,255,.18)';
  fitInputToMirror(inp,mirror);
  _obUpdateBudPreview();
}

function obBudDateChange(){
  const inp=document.getElementById('ob-bud-date-input');
  if(!inp||!inp.value){_obBudDays=0;_obUpdateBudPreview();return;}
  const days=daysBetween(todayStr(),inp.value)+1;
  if(days<1){toast('Дата должна быть сегодня или позже');inp.value='';_obBudDays=0;_obUpdateBudPreview();return;}
  _obBudDays=days;
  const lbl=document.getElementById('ob-bud-date-label');
  if(lbl){const d=new Date(inp.value+'T12:00:00');lbl.textContent=d.toLocaleDateString('ru-RU',{day:'numeric',month:'long'});}
  const tile=document.getElementById('ob-bud-date-tile');
  if(tile)tile.classList.add('sel');
  _obUpdateBudPreview();
}

function _obUpdateBudPreview(){
  const raw=(document.getElementById('ob-bud-amount')||{value:''}).value.replace(/[^0-9]/g,'');
  const amt=parseInt(raw,10)||0;
  const preview=document.getElementById('ob-bud-preview');
  if(!preview)return;
  if(amt>0&&_obBudDays>0){
    preview.textContent=Math.floor(amt/_obBudDays).toLocaleString('ru-RU')+' ₽ в день';
    preview.classList.add('ob-bud-perday-active');
  } else {
    preview.textContent='До зарплаты, халтурки или доната от любимой мамы';
    preview.classList.remove('ob-bud-perday-active');
  }
}

async function obSaveBudget(){
  var raw=(document.getElementById('ob-bud-amount').value||'').replace(/[^0-9]/g,'');
  var amt=parseInt(raw,10);
  if(!amt||amt<=0){toast('Введите сумму');return;}
  if(!_obBudDays||_obBudDays<=0){toast('Укажите дату');return;}
  var deadline=daysToDeadline(_obBudDays);
  var startDate=todayStr();
  var now=new Date().toISOString();
  var spentAtStart=S.txs.filter(t=>t.type==='expense').reduce((sum,t)=>sum+t.amount,0);
  S.budget={amount:amt,days:_obBudDays,deadline,set_at:startDate,reset_ts:now,spent_at_start:spentAtStart};
  _budLockUntil=Date.now()+30000;
  saveLocal();
  toast('Бюджет установлен');
  await pushBudget();
  _budLockUntil=Date.now()+5000;
  obNext();
}

function obToggleDemo(){
  const icon=document.getElementById('ob-tgl-icon');
  if(!icon)return;
  const isExp=icon.classList.contains('exp');
  icon.classList.toggle('exp',!isExp);
  icon.classList.toggle('inc',isExp);
  icon.textContent=isExp?'+':'−';
}

function replayOnboarding(){
  const code=localStorage.getItem(K_CODE)||'';
  showOnboarding(code);
}

let _obTouchX=0;
function obTouchStart(e){_obTouchX=e.touches[0].clientX;}
function obTouchEnd(e){
  const dx=e.changedTouches[0].clientX-_obTouchX;
  if(Math.abs(dx)<45)return;
  if(dx<0&&_obIdx<_obSlides.length-1)obNext();
  else if(dx>0&&_obIdx>0){
    _obIdx--;
    document.getElementById('ob-track').style.transform=`translateX(${-_obIdx*100}%)`;
    _obUpdateState();
  }
}

// Expose functions for inline onclick handlers in HTML
Object.assign(window, {
  goMain, goHistory, goBudget, goSettings, goCategories,
  np, npDel, confirm_, toggleType, selCat,
  onBudDateChange, onBudAmtInput, saveBudget,
  selCatSettTab,
  showCatModal, hideCatModal, modalBgClick, selIcon, selColor, saveCat,
  showMyCode, deleteCat, exportData, importData, clearAll,
  _incBudConfirm, _incBudCancel,
  showEnterCodeModal, hideEnterCodeModal, submitEnterCode,
  copyCodeReveal, dismissCodeReveal, onCodeRevealBtn,
  recoverWithCode, createNewAccount,
  showToggleHint, maybeShowToggleHint,
  showOnboarding, obNext, obGoTo, closeOnboarding, obCopyCode, obTouchStart, obTouchEnd, replayOnboarding,
  obBudAmtInput, obBudDateChange, obSaveBudget, obToggleDemo,
  selHistType, selHistTab,
  showHistPeriodSheet, hideHistPeriodSheet, selHistPeriodOption,
  showTxEdit, hideTxEdit, saveTxEdit, deleteTxFromEdit, selectEditCat, onTxEditAmtInput, onTxEditDateChange,
  _confOk, _confNo,
  toastUndo, fmtCodeInput,
  runAnalytics, closeAnalytics,
});

// Тестовый хук: даёт тестам доступ к состоянию и чистым хелперам.
// В прод-сборке import.meta.env.MODE === 'production', и весь блок вырезается минификатором.
if(import.meta.env.MODE === 'test'){
  window.__test = {
    get S(){ return S; },
    get currentUser(){ return currentUser; },
    K, DEF_CATS,
    fmt, fmtThousands, fmtDate, esc, plural, pluralDays, timeAgo,
    todayStr, localDateStr, daysUntil, daysBetween, daysToDeadline,
    determineCtype, getTxsForPeriod, emptyBudget,
    loadLocal, saveLocal, renderMain, renderHistory, renderBudgetScreen, renderCats, setType,
  };
}

// ── PWA: регистрация service worker + детектор обновлений ────────────────────
function showUpdateToast(reg){
  window._updateReg=reg;
  const t=document.getElementById('toast');
  t.innerHTML='<span>Доступно обновление</span><button class="toast-undo" onclick="applyUpdate()">Обновить</button>';
  clearTimeout(t._t);
  t.classList.add('show','toast--undo');
  // Тост остаётся до тапа — не ставим авто-скрытие
}
function applyUpdate(){
  const reg=window._updateReg;
  if(reg&&reg.waiting) reg.waiting.postMessage('SKIP_WAITING');
  else location.reload();
}

// В нативной сборке ассеты лежат в APK — service worker не нужен, а тост
// «Доступно обновление» там бессмысленен: обновление приходит новым APK.
if(!import.meta.env.VITE_NATIVE && 'serviceWorker' in navigator){
  // Перезагружаем страницу когда новый SW берёт управление
  var _swRefreshing=false;
  navigator.serviceWorker.addEventListener('controllerchange',function(){
    if(!_swRefreshing){ _swRefreshing=true; location.reload(); }
  });

  window.addEventListener('load',function(){
    navigator.serviceWorker.register('/sw.js').then(function(reg){
      // Новый SW нашёлся в процессе установки
      reg.addEventListener('updatefound',function(){
        var newSw=reg.installing;
        newSw.addEventListener('statechange',function(){
          // Новая версия установлена и готова, старая ещё активна
          if(newSw.state==='installed'&&navigator.serviceWorker.controller){
            showUpdateToast(reg);
          }
        });
      });
    }).catch(function(){});
  });
}

Object.assign(window,{applyUpdate});

// Версия и дата сборки в футере настроек
(function(){
  const el=document.getElementById('app-version');
  if(!el) return;
  const v=import.meta.env.VITE_APP_VERSION||'1.0.0';
  const d=import.meta.env.VITE_BUILD_DATE||'';
  el.textContent='Дошик v'+v+(d?' · '+d:'');
})();
