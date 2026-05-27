import { createClient } from '@supabase/supabase-js';

// ── SUPABASE ──────────────────────────────────────────────────────────────────
const SUPA_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPA_KEY = import.meta.env.VITE_SUPABASE_KEY;
// Всегда через прокси /sb — в dev Vite проксирует сам, в проде — Vercel
// Браузер никогда не ходит напрямую на supabase.co (обход РКН)
const db = createClient(window.location.origin + '/sb', SUPA_KEY);
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
let S = {
  type:'expense', amount:'', catId:null,
  histCat:null, histType:'expense', catSettTab:'expense',
  budColor:COLORS[0], budDays:0,
  txs:[], cats:[], budget:{amount:0,days:0,deadline:null,set_at:null}
};

let _budDirtyTs=0; // timestamp последнего локального сохранения бюджета
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
    } else { S.budget={amount:0,days:0,deadline:null,set_at:null,spent_at_start:0}; }
    S.budDays=S.budget.days||0;
  } catch(e){ S.txs=[]; S.cats=[...DEF_CATS]; S.budget={amount:0,deadline:null}; }
}
function _store(k,v){ try{localStorage.setItem(k,v);}catch(e){} try{sessionStorage.setItem(k,v);}catch(e){} }
function _load(k){ try{var v=localStorage.getItem(k);if(v)return v;}catch(e){} try{return sessionStorage.getItem(k);}catch(e){} return null; }
function saveLocal(){
  _store(K.tx,JSON.stringify(S.txs));
  _store(K.cats,JSON.stringify(S.cats));
  _store(K.budget,JSON.stringify(S.budget));
}

// ── SUPABASE SYNC ─────────────────────────────────────────────────────────────
async function syncFromSupabase(){
  if(!currentUser) return;
  try {
    const [txRes,catRes,budRes]=await Promise.all([
      db.from('transactions').select('*').eq('user_id',currentUser.id).order('date',{ascending:false}),
      db.from('categories').select('*').eq('user_id',currentUser.id).order('sort_order'),
      db.from('budget_settings').select('*').eq('user_id',currentUser.id).maybeSingle()
    ]);
    if(txRes.data&&txRes.data.length>0)
      S.txs=txRes.data.map(r=>({id:r.id,amount:r.amount,type:r.type,catId:r.cat_id,note:r.note||'',date:r.date}));
    if(catRes.data&&catRes.data.length>0){
      S.cats=catRes.data.map(function(r){var ic=r.icon||'';if(!ic){var b=r.id.replace(/_[a-zA-Z0-9]{1,8}$/,'');var df=DEF_CATS.find(function(d){return d.id===b||d.id===r.id;});if(df)ic=df.icon||'';}return {id:r.id,name:r.name,color:r.color,icon:ic,ctype:r.ctype||determineCtype(r.id,[...S.cats])};});
    }
    else await seedDefaultCats();
    if(budRes.data&&budRes.data.amount&&(Date.now()-_budDirtyTs>5000)){
      var budSetAt=budRes.data.set_at||null;
      // Пересчитываем baseline: всё потраченное ДО даты бюджета
      var _baseline=S.txs.filter(function(t){
        if(t.type!=='expense') return false;
        if(!budSetAt) return true; // без даты — всё считается baseline
        return localDateStr(t.date)<budSetAt;
      }).reduce(function(sum,t){ return sum+t.amount; },0);
      S.budget={amount:Number(budRes.data.amount)||0,days:Number(budRes.data.days)||0,deadline:budRes.data.deadline||null,set_at:budSetAt,spent_at_start:_baseline};
      S.budDays=S.budget.days||0;
    }
    saveLocal(); setSyncDot(true); renderMain(); processQueue();
  } catch(e){ setSyncDot(false); }
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
async function pushTx(tx,isRetry=false){
  if(!currentUser) return;
  try { await db.from('transactions').upsert({id:tx.id,user_id:currentUser.id,amount:tx.amount,type:tx.type,cat_id:tx.catId,note:tx.note||'',date:tx.date}); setSyncDot(true); }
  catch(e){ setSyncDot(false); if(!isRetry){offlineQueue.push({op:'pushTx',data:tx}); saveQueue();} }
}
async function deleteTxRemote(id){
  if(!currentUser) return;
  try { await db.from('transactions').delete().eq('id',id).eq('user_id',currentUser.id); } catch(e){}
}
async function pushCats(){
  if(!currentUser) return;
  try { await db.from('categories').upsert(S.cats.map((c,i)=>({id:c.id,user_id:currentUser.id,name:c.name,color:c.color,icon:c.icon||'',ctype:c.ctype||'expense',sort_order:i}))); setSyncDot(true); } catch(e){ setSyncDot(false); offlineQueue.push({op:'pushCats'}); saveQueue(); }
}
async function deleteCatRemote(id){
  if(!currentUser) return;
  try { await db.from('categories').delete().eq('id',id).eq('user_id',currentUser.id); } catch(e){}
}
async function pushBudget(){
  if(!currentUser) return;
  try { await db.from('budget_settings').upsert({user_id:currentUser.id,amount:S.budget.amount,days:S.budget.days||0,deadline:S.budget.deadline,set_at:S.budget.set_at||todayStr()}); setSyncDot(true); }
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
  if(_syncStatus==='syncing'){
    icon.textContent='🔄'; icon.classList.add('spin');
    title.textContent='Синхронизируется…';
    time.textContent='';
  } else if(_syncStatus==='offline'){
    icon.textContent='🔴'; icon.classList.remove('spin');
    title.textContent='Нет соединения';
    time.textContent='Данные сохранены локально';
  } else {
    icon.textContent='🟢'; icon.classList.remove('spin');
    title.textContent='Синхронизировано';
    time.textContent=_lastSyncTs ? timeAgo(_lastSyncTs) : '';
  }
}

// Обновляем надпись «N минут назад» каждые 30 сек, пока открыты настройки
setInterval(function(){
  if(document.getElementById('s-settings') &&
     !document.getElementById('s-settings').classList.contains('hidden')){
    updateSyncCard();
  }
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
  ['s-main','s-history','s-budget','s-settings'].forEach(s=>{
    document.getElementById(s).classList.toggle('hidden',s!==id);
  });
}
function goMain(){ show('s-main'); renderMain(); }
function goHistory(){
  S.histType='expense';
  S.histCat=null;
  show('s-history');
  setTimeout(renderHistory,0);
}
function goBudget(){ show('s-budget'); renderBudgetScreen(); }
function goSettings(){
  updateSyncCard();
  show('s-settings');
  renderSettings();
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
function renderMain(){
  const numEl=document.getElementById('today-num');
  const lblEl=document.getElementById('today-label');
  const pill=document.getElementById('budget-pill');
  const budgetAmount=Number((S.budget&&S.budget.amount)||0);
  const budgetDeadline=S.budget&&S.budget.deadline?S.budget.deadline:null;
  const hasBudget=budgetAmount>0 && !!budgetDeadline;

  if(hasBudget){
    // Считаем расходы через baseline: только то что потрачено ПОСЛЕ установки бюджета
    var totalEverSpent=S.txs.filter(function(t){ return t.type==='expense'; })
                            .reduce(function(sum,t){ return sum+t.amount; },0);
    var spentAtStart=Number((S.budget&&S.budget.spent_at_start)||0);
    var spentInBudget=Math.max(0, totalEverSpent - spentAtStart);
    const remaining=budgetAmount-spentInBudget;
    numEl.textContent=(remaining<0?'−':'')+fmt(Math.abs(remaining));
    fitBudgetNum(numEl);

    if(remaining>0){
      lblEl.textContent='Осталось';
      numEl.style.color='rgba(255,255,255,.95)';
      lblEl.style.color='rgba(255,255,255,.38)';
    } else {
      lblEl.textContent='Перерасход';
      numEl.style.color='rgba(255,90,80,.9)';   // красноватый
      lblEl.style.color='rgba(255,90,80,.65)';  // лейбл тоже в тон
    }

    const daysLeft=Math.max(daysUntil(budgetDeadline),1);
    const perDay=fmt(Math.max(Math.round(Math.max(remaining,0)/daysLeft),0));
    pill.textContent=perDay+' ₽/день';
    pill.classList.remove('nav-pill--highlight');
    // Цвет pill по статусу бюджета
    pill.style.cssText='';
  } else {
    const todayExpenses=S.txs.filter(function(t){
      return t.type==='expense' && t.date && localDateStr(t.date)===todayStr();
    }).reduce(function(s,t){ return s+t.amount; },0);
    numEl.textContent=fmt(todayExpenses);
    fitBudgetNum(numEl);
    numEl.style.color='rgba(255,255,255,.9)';
    lblEl.textContent='Потрачено сегодня';
    lblEl.style.color='rgba(255,255,255,.38)';
    pill.textContent='Бюджет';
    pill.classList.add('nav-pill--highlight');
    lblEl.textContent='Задай бюджет — начнём считать траты';
    lblEl.style.color='rgba(255,80,80,.55)';
  }


  lblEl.style.cursor='';
  lblEl.onclick=null;
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
      if(hasBudget){
        // reset_ts — точный момент запуска бюджета; фильтруем строго после него
        if(S.budget&&S.budget.reset_ts){
          if(t.date<S.budget.reset_ts) return false;
        } else if(S.budget&&S.budget.set_at){
          if(localDateStr(t.date)<S.budget.set_at) return false;
        }
        if(S.budget&&S.budget.deadline&&localDateStr(t.date)>S.budget.deadline) return false;
      } else {
        if(localDateStr(t.date)!==todayStr()) return false;
      }
      return true;
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
function renderModeRow(){
  var expBtn=document.getElementById('sign-btn-exp');
  var incBtn=document.getElementById('sign-btn-inc');
  var toggleBtn=document.getElementById('np-toggle');
  if(toggleBtn){toggleBtn.textContent=S.type==='income'?'+':'−';toggleBtn.className='np-btn np-toggle'+(S.type==='income'?' inc':'');}
  if(expBtn) expBtn.classList.toggle('on', S.type==='expense');
  if(incBtn) incBtn.classList.toggle('on', S.type==='income');
  var tExp=document.getElementById('type-exp'); if(tExp) tExp.className='type-btn exp'+(S.type==='expense'?' on':'');
  var tInc=document.getElementById('type-inc'); if(tInc) tInc.className='type-btn inc'+(S.type==='income'?' on':'');
  // Keep enter button color
  var enter=document.getElementById('np-enter');
  if(enter) enter.className='np-btn np-enter'+(S.type==='income'?' inc-mode':'');
  renderAmountRow();
}
function toggleType(){ setType(S.type==='expense'?'income':'expense'); }
function setType(t){
  S.type=t; S.catId=null;
  renderModeRow();
  document.getElementById('np-enter').className='np-btn np-enter'+(t==='income'?' inc-mode':'');
  var tog=document.getElementById('np-toggle');
  if(tog){ tog.textContent=t==='income'?'+':'−'; tog.className='np-btn np-toggle'+(t==='income'?' inc':''); }
  var noteInp=document.getElementById('note-inp');
  if(noteInp) noteInp.placeholder=t==='income'?'Уточни детали (необязательно)':'Уточни детали (необязательно)';
  renderCatRow();
  renderMain();
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
    toast('Сначала настройте бюджет 👆');
    return;
  }
  // подсказка без блокировки если нет бюджета - уже handled in renderMain
  const note=document.getElementById('note-inp').value.trim();
  const catId=S.catId||null; // null = без категории
  const tx={id:Date.now()+'',amount:amt,type:S.type,catId:catId,note:note,date:new Date().toISOString()};
  S.txs.unshift(tx); saveLocal(); pushTx(tx);
  S.amount=''; document.getElementById('note-inp').value=''; S.amount=''; renderAmountRow();
  renderMain(); toastWithUndo((S.type==='expense'?'− ':'+ ')+fmt(amt)+'₽'+(catId?' · '+getCat(catId).name:''), tx);
}

// ── HISTORY ───────────────────────────────────────────────────────────────────
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
  var visCats=S.histType?S.cats.filter(function(x){return (x.ctype||'expense')===S.histType;}):S.cats;
  var tabs=document.getElementById('hist-tabs');
  if(tabs) tabs.innerHTML=visCats.map(function(x){
    return '<button class="ctab'+(S.histCat===x.id?' on':'')+'" data-id="'+x.id+'" onclick="selHistTab(this.dataset.id)">'
      +(x.icon?x.icon+' ':'')+esc(x.name)+'</button>';
  }).join('');
  renderHistContent();
}
function selHistTab(id){ S.histCat=(S.histCat===id?null:id); renderHistory(); }
function renderHistContent(){
  var con=document.getElementById('hist-content');
  if(!con) return;
  var txs=S.txs.slice();
  if(S.histType && S.histType!=='all') txs=txs.filter(function(t){ return t.type===S.histType; });
  if(S.histCat && S.histCat!=='all') txs=txs.filter(function(t){ return t.catId===S.histCat; });
  if(!txs.length){
    con.innerHTML='<div class="empty"><div class="empty-icon">📋</div><p>Записей пока нет</p></div>';
    return;
  }
  var groups={};
  txs.forEach(function(t){
    var d=localDateStr(t.date);
    if(!groups[d]) groups[d]=[];
    groups[d].push(t);
  });
  var html='';
  Object.keys(groups).sort(function(a,b){ return b.localeCompare(a); }).forEach(function(day){
    var dayTxs=groups[day];
    var expSum=0, incSum=0;
    dayTxs.forEach(function(t){ if(t.type==='expense') expSum+=t.amount; else if(t.type==='income') incSum+=t.amount; });
    html += '<div class="day-group">';
    html += '<div class="day-hdr"><span class="day-date">'+fmtDate(day)+'</span><div class="day-totals">';
    if(expSum>0) html += '<span class="day-exp">−'+fmt(expSum)+'</span>';
    if(incSum>0) html += '<span class="day-inc">+'+fmt(incSum)+'</span>';
    html += '</div></div>';
    dayTxs.forEach(function(t){
      var cat=getCat(t.catId);
      var tm=new Date(t.date).toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'});
      html += '<div class="tx-item'+(t.type==='income'?' income-row':'')+'" data-id="'+t.id+'" onclick="delTx(this.dataset.id)">';
      html += '<div class="tx-left"><div class="tx-dot" style="background:'+esc(cat.color)+'"></div><div class="tx-meta">';
      html += '<span class="tx-cat">'+(cat.icon?cat.icon+' ':'')+esc(cat.name)+'</span>';
      if(t.note) html += '<span class="tx-note">'+esc(t.note)+'</span>';
      html += '<span class="tx-time">'+tm+'</span></div></div>';
      html += '<div class="tx-right">';
      if(!t.catId) html += '<button class="assign-cat-btn" data-id="'+t.id+'" data-type="'+t.type+'" onclick="event.stopPropagation();showAssignCat(this.dataset.id,this.dataset.type)">+ кат.</button>';
      html += '<span class="tx-amt '+t.type+'">'+(t.type==='income'?'+':'−')+fmt(t.amount)+'</span>';
      html += '</div></div>';
    });
    html += '</div>';
  });
  con.innerHTML=html;
}

async function delTx(id){
  if(!await customConfirm('Удалить запись?')) return;
  S.txs=S.txs.filter(t=>t.id!==id); saveLocal(); deleteTxRemote(id); renderHistory(); toast('Удалено');
}

// ── BUDGET ────────────────────────────────────────────────────────────────────
// Простой и надёжный бюджет: сумма + кол-во дней
// S.budDays — выбранное кол-во дней (число)
// S.budgetDraft — {amount, days} во время редактирования
// S.budget — {amount, days, set_at, deadline} — сохранённый бюджет

const BUD_DAY_PRESETS = [3,7,14,30];

function renderBudgetScreen(){
  // Читаем текущий сохранённый бюджет в поля ввода
  var inp = document.getElementById('bud-amount');
  var existAmt = (S.budget && Number(S.budget.amount) > 0) ? S.budget.amount : '';
  inp.value = existAmt ? fmtBudInput(String(existAmt)) : '';
  var _ruble = document.getElementById('bud-ruble');
  var _mirror = document.getElementById('bud-mirror');
  if(_ruble){ _ruble.style.color = existAmt ? 'rgba(255,255,255,.4)' : 'rgba(255,255,255,.18)'; }
  fitInputToMirror(inp, _mirror);

  // Текущие дни из сохранённого бюджета (пересчитываем из deadline)
  var existDays = 0;
  if(S.budget && S.budget.days) {
    existDays = S.budget.days;
  } else if(S.budget && S.budget.deadline && S.budget.set_at) {
    var d1 = new Date(S.budget.set_at), d2 = new Date(S.budget.deadline);
    existDays = Math.max(1, Math.round((d2-d1)/86400000)+1);
  }
  S.budDays = existDays || S.budget.days || 0;

  renderBudDaysGrid();
  updateBudgetPreview();
  // Показываем подсказку о сбросе только если уже есть активный бюджет
  var hintEl = document.getElementById('bud-reset-hint');
  if(hintEl){
    var hasBud = S.budget && Number(S.budget.amount) > 0 && S.budget.set_at;
    hintEl.style.display = hasBud ? 'block' : 'none';
  }
}

function renderBudDaysGrid(){
  var grid = document.getElementById('bud-days-grid');
  if(!grid) return;
  var html = BUD_DAY_PRESETS.map(function(d){
    return '<button class="bud-day-btn'+(S.budDays===d?' sel':'')+'" onclick="selBudDays('+d+')">'+d+' дней</button>';
  }).join('');
  grid.innerHTML = html;
}

function selBudDays(d){
  S.budDays = (S.budDays === d ? 0 : d);
  renderBudDaysGrid();
  updateBudgetPreview();
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
  if(raw.length > 8) raw = raw.slice(0, 8);   // лимит 8 цифр
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
  var perday = document.getElementById('bud-perday-display');
  var deadlineRow = document.getElementById('bud-deadline-row');
  var deadlineTxt = document.getElementById('bud-deadline-text');

  if(amt > 0 && S.budDays > 0){
    perday.textContent = fmt(Math.round(amt/S.budDays))+' ₽ в день';
  } else if(amt > 0 && S.budDays === 0){
    perday.textContent = 'выберите количество дней';
  } else if(amt === 0 && S.budDays > 0){
    perday.textContent = S.budDays+' '+pluralDays(S.budDays);
  } else {
    perday.textContent = '';
  }

  if(S.budDays > 0 && deadlineRow && deadlineTxt){
    var dl = daysToDeadline(S.budDays);
    var dlDate = new Date(dl+'T00:00:00');
    var opts = {day:'numeric',month:'long'};
    deadlineTxt.textContent = 'до '+dlDate.toLocaleDateString('ru-RU',opts)+' включительно';
    deadlineRow.style.display='flex';
  } else if(deadlineRow){
    deadlineRow.style.display='none';
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
  if(!S.budDays || S.budDays <= 0){ toast('Выберите количество дней'); return; }

  var deadline = daysToDeadline(S.budDays);
  var startDate = todayStr();

  // Считаем всё потраченное ДО этого бюджета — это baseline
  var spentAtStart = S.txs.filter(function(t){ return t.type==='expense'; })
                          .reduce(function(sum,t){ return sum+t.amount; }, 0);
  S.budget = {
    amount: amt,
    days: S.budDays,
    deadline: deadline,
    set_at: startDate,
    reset_ts: new Date().toISOString(),
    spent_at_start: spentAtStart
  };

  _budDirtyTs = Date.now() + 30000; // защита 30 сек от перезаписи синком
  saveLocal();

  show('s-main');
  // Принудительно перерисовываем с НОВЫМ бюджетом после CSS-перехода (280ms)
  renderMain();
  setTimeout(renderMain, 320);

  toast('Бюджет '+fmt(amt)+'₽ на '+S.budDays+' дн. сохранён ✓');
  await pushBudget();
  _budDirtyTs = Date.now();
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
function selCatSettTab(t){S.catSettTab=t;renderSettings();}
function renderSettings(){
  const cl=document.getElementById('cat-list');
  const tw=document.getElementById('cat-type-tabs-wrapper');
  const filteredCats=S.cats.filter(c=>(c.ctype||'expense')===S.catSettTab);
  const tabs=`<div class="cat-type-tabs">
    <button class="cat-type-tab${S.catSettTab==='expense'?' on':''}" onclick="selCatSettTab('expense')">Расходы</button>
    <button class="cat-type-tab${S.catSettTab==='income'?' on':''}" onclick="selCatSettTab('income')">Доходы</button>
  </div>`;
  if(tw) tw.innerHTML=tabs;
  cl.innerHTML=(filteredCats.length
    ? filteredCats.map(c=>`<div class="cat-item" onclick="showCatModal('${c.id}')"><div class="cat-nm"><div style="width:10px;height:10px;border-radius:50%;background:${esc(c.color)};flex-shrink:0"></div><span class="cat-nm-text">${c.icon?`${c.icon} `:''}${esc(c.name)}</span></div><button class="del-cat" onclick="event.stopPropagation();deleteCat('${c.id}')">Удалить</button></div>`).join('')
    : '<div class="sett-row"><span style="color:rgba(255,255,255,.3);font-size:14px">Нет категорий</span></div>');
}
function showMyCode(){
  const code=localStorage.getItem(K_CODE)||(currentUser&&currentUser.user_metadata&&currentUser.user_metadata.code)||'';
  if(!code){toast('Код не привязан');return;}
  showCodeRevealModal(code);
}
function deleteCat(id){
  customConfirm('Удалить категорию?').then(ok=>{ if(!ok) return; S.cats=S.cats.filter(c=>c.id!==id);saveLocal();pushCats();deleteCatRemote(id);renderSettings();renderCatRow();toast('Удалено'); });
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
      S.budget=d.budget||{amount:0,deadline:null};
      saveLocal();
      if(currentUser){
        S.txs.forEach(t=>pushTx(t));
        pushCats(); pushBudget();
      }
      renderMain(); renderSettings(); toast('Данные импортированы ✓');
    }catch(err){ toast('Ошибка чтения файла'); }
  };
  reader.readAsText(file);
  e.target.value='';
}
async function clearAll(){
  if(!await customConfirm('Сбросить всё? Все транзакции и бюджет удалятся, категории вернутся к стандартным.','Сбросить')) return;
  S.txs=[];S.cats=[...DEF_CATS];S.budget={amount:0,deadline:null};
  saveLocal();
  if(currentUser){
    // Сначала удалить ВСЁ из Supabase (sequentially, не fire-and-forget)
    await db.from('transactions').delete().eq('user_id',currentUser.id);
    await db.from('budget_settings').delete().eq('user_id',currentUser.id);
    await db.from('categories').delete().eq('user_id',currentUser.id);
    // Затем посеять дефолтные категории заново
    await seedDefaultCats();
  }
  toast('Данные сброшены ✓');
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
  document.getElementById('cat-modal').classList.add('vis');
  setTimeout(function(){document.getElementById('cat-name-inp').focus();},50);
}
function hideCatModal(){ _editCatId=null; document.getElementById('cat-modal').classList.remove('vis'); }
function modalBgClick(e){ if(e.target===document.getElementById('cat-modal')) hideCatModal(); }
function selIcon(ic){ S.budIcon=ic; document.querySelectorAll('.icon-opt').forEach(el=>el.classList.toggle('sel',el.textContent.trim()===ic)); }
function selColor(c){
  S.budColor=c;
  document.querySelectorAll('.clr-dot').forEach(el=>el.classList.toggle('sel',el.dataset.clr===c));
}
function saveCat(){
  const name=document.getElementById('cat-name-inp').value.trim();
  if(!name){toast('Введите название');return;}
  if(_editCatId){
    const idx=S.cats.findIndex(c=>c.id===_editCatId);
    if(idx>=0) S.cats[idx]={...S.cats[idx],name,color:S.budColor,icon:S.budIcon||ICON_OPTIONS[0]};
    _editCatId=null;
    saveLocal();pushCats();hideCatModal();renderSettings();renderCatRow();
    toast('"'+name+'" обновлена ✓');
  } else {
    // Определяем тип: из вкладки настроек или из переключателя на главной
    const onSettings=!document.getElementById('s-settings').classList.contains('hidden');
    const ctype=onSettings?S.catSettTab:S.type;
    const _sfx=ctype==='income'?'_inc':'_exp';
    S.cats.unshift({id:'c'+Date.now()+_sfx,name,color:S.budColor,icon:S.budIcon||ICON_OPTIONS[0],ctype});
    saveLocal();pushCats();hideCatModal();renderSettings();renderCatRow();
    setTimeout(()=>{ const r=document.getElementById('cat-row'); if(r) r.scrollLeft=0; },60);
    toast('"'+name+'" добавлена ✓');
  }
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function getCat(id){ if(!id) return {name:'Без категории',color:'#9E9E9E',icon:''}; return S.cats.find(function(x){return x.id===id;})||{name:'Без категории',color:'#9E9E9E',icon:''}; }
function todayStr(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function localDateStr(isoStr){ const d=new Date(isoStr); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function daysUntil(ds){
  const p=ds.split('-'); const t=new Date(+p[0],+p[1]-1,+p[2]);
  const n=new Date(); n.setHours(0,0,0,0);
  return Math.max(1,Math.ceil((t-n)/864e5));
}
function fmt(n){ var r=Math.round(n*100)/100; return r.toLocaleString('ru-RU',{maximumFractionDigits:2}); }
function fmtDate(ds){
  const t=todayStr(),y=new Date();y.setDate(y.getDate()-1);const ys=y.toISOString().slice(0,10);
  if(ds===t)return'Сегодня';if(ds===ys)return'Вчера';
  return new Date(ds+'T12:00:00').toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
}

function pluralDays(n){
  if(n%10===1&&n%100!==11)return'день';
  if([2,3,4].includes(n%10)&&![12,13,14].includes(n%100))return'дня';
  return'дней';
}
// ── ASSIGN CATEGORY MODAL ────────────────────────────────────────────────────
function showAssignCat(txId,txType){
  const cats=S.cats.filter(c=>(c.ctype||'expense')===txType);
  const modal=document.getElementById('assign-cat-modal');
  document.getElementById('assign-cat-list').innerHTML=cats.map(c=>`
    <button class="assign-cat-item" onclick="assignCat('${txId}','${c.id}')">
      <div style="width:10px;height:10px;border-radius:50%;background:${esc(c.color)};flex-shrink:0"></div>
      <span>${esc(c.name)}</span>
    </button>`).join('');
  modal.classList.add('vis');
}
function hideAssignCat(){ document.getElementById('assign-cat-modal').classList.remove('vis'); }
function assignCat(txId,catId){
  const tx=S.txs.find(t=>t.id===txId);
  if(tx){ tx.catId=catId; saveLocal(); pushTx(tx); renderHistory(); renderMain(); }
  hideAssignCat();
  toast('Категория назначена ✓');
}

// ── CUSTOM CONFIRM ───────────────────────────────────────────────────────────
let _confirmCb=null;
function customConfirm(msg,okText='Удалить',dangerOk=true){
  const el=document.getElementById('confirm-modal');
  document.getElementById('confirm-msg').textContent=msg;
  const ok=document.getElementById('confirm-ok-btn');
  ok.textContent=okText;
  ok.style.background=dangerOk?'#FF3B30':'#3DBD74';
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
  toast('Отменено ✓');
}

function toastWithUndo(msg, tx){
  _lastTx=tx;
  const t=document.getElementById('toast');
  t.innerHTML='<span>'+msg+'</span><button class="toast-undo" onclick="toastUndo()">Отменить</button>';
  t.classList.add('show');
  clearTimeout(t._t);
  t._t=setTimeout(function(){ t.classList.remove('show'); _lastTx=null; }, 4000);
}
function toast(msg){
  const t=document.getElementById('toast');t.innerHTML='<span>'+msg+'</span>';t.classList.add('show');
  clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2200);
}

// ── CODE RECOVERY AUTH ────────────────────────────────────────────────────────
const K_CODE='tk_rccode';

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

async function initApp(){
  loadQueue(); // Загружаем offline queue при старте
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
    setTimeout(()=>showCodeRevealModal(code),600);
  }catch(e){
    // Даже при ошибке сети — код в localStorage, показываем его
    document.getElementById('s-auth').style.display='none';
    loadLocal();goMain();
    setTimeout(()=>showCodeRevealModal(code),600);
    setSyncDot(false);
    btn.disabled=false;btn.textContent='Начать с нуля';
    document.getElementById('auth-err').textContent='Ошибка соединения с сервером';
  }
}
async function recoverWithCode(){
  const raw=document.getElementById('auth-code').value.replace(/[^A-Za-z0-9]/g,'').toUpperCase();
  const code=raw.length===8?raw.slice(0,4)+'-'+raw.slice(4):'';
  if(code.length!==9){document.getElementById('auth-err').textContent='Введите код из 8 символов';return;}
  const btn=document.querySelector('#s-auth .auth-btn');
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
    loadLocal();goMain();
    await syncFromSupabase();
    renderMain();
    setSyncDot(true);toast('Данные восстановлены ✓');
    setTimeout(()=>showCodeRevealModal(code),700);
  }catch(e){
    document.getElementById('auth-err').textContent='Ошибка соединения с сервером';
    btn.disabled=false;btn.textContent=orig;
  }
}
function showCodeRevealModal(code){
  document.getElementById('code-reveal-value').textContent=code;
  document.getElementById('code-reveal-modal').classList.add('vis');
}
function dismissCodeReveal(){document.getElementById('code-reveal-modal').classList.remove('vis');}
function copyCodeReveal(){
  const code=document.getElementById('code-reveal-value').textContent;
  copyToClipboard(code).then(()=>{
    const b=document.getElementById('copy-code-btn');
    b.textContent='Скопировано ✓';setTimeout(()=>b.textContent='Скопировать код',1800);
  });
}
function copyCode(){
  const code=localStorage.getItem(K_CODE);
  if(!code)return;
  copyToClipboard(code).then(()=>toast('Код скопирован ✓'));
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
  customConfirm('Данные этого устройства будут заменены данными введённого аккаунта.','Продолжить').then(ok=>{
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
    S.txs=[];S.cats=[];S.budget={amount:0,deadline:null};
    saveLocal();
    await syncFromSupabase();
    renderMain();
    toast('Данные восстановлены ✓');
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

// Expose functions for inline onclick handlers in HTML
Object.assign(window, {
  goMain, goHistory, goBudget, goSettings,
  np, npDel, confirm_, toggleType, selCat,
  selBudDays, onBudAmtInput, saveBudget,
  selCatSettTab, renderSettings,
  showCatModal, hideCatModal, modalBgClick, selIcon, selColor, saveCat,
  showMyCode, deleteCat, exportData, importData, clearAll,
  showEnterCodeModal, hideEnterCodeModal, submitEnterCode,
  copyCodeReveal, dismissCodeReveal, copyCode,
  recoverWithCode, createNewAccount,
  selHistType, selHistTab,
  delTx, showAssignCat, hideAssignCat, assignCat,
  _confOk, _confNo,
  toastUndo, fmtCodeInput,
});
