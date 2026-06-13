const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://stfdtkorhvdmsrhelide.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_KEY || '';

// Проверяем Supabase JWT — без валидного токена не пускаем к Groq,
// иначе любой может выжечь лимит API простым curl-ом
async function verifyUser(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !SUPABASE_KEY) return null;
  try {
    const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, authorization: 'Bearer ' + token }
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u : null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = await verifyUser(req);
  if (!user) {
    if (!SUPABASE_KEY) console.error('analyze: SUPABASE_ANON_KEY/VITE_SUPABASE_KEY не задан в env — все запросы отклоняются');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { txs = [], cats = [], budget = null, seen = {} } = req.body || {};
  // Память показанных инсайтов: клиент шлёт, что уже видел пользователь,
  // чтобы не крутить «заезженную пластинку» про один и тот же кофе
  const seenRecKeys = new Set(Array.isArray(seen.recKeys) ? seen.recKeys.slice(0, 30) : []);
  const seenInsights = (Array.isArray(seen.insights) ? seen.insights : [])
    .filter(s => typeof s === 'string' && s.length > 2).slice(0, 12);
  if (txs.length < 3) {
    return res.status(200).json({ insights: [], recommendations: [], error: 'few_data' });
  }

  const catMap = {};
  (cats || []).forEach(c => { catMap[c.id] = c.name; });
  const catName = id => catMap[id] || 'Без категории';

  // ── базовые помощники ───────────────────────────────────────────
  const DAY = 86400000;
  const now = Date.now();
  const ts = t => new Date(t.date).getTime();
  const dayOf = t => t.date.slice(0, 10);
  const sum = arr => arr.reduce((s, t) => s + t.amount, 0);
  const round = n => Math.round(n);
  const norm = s => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const sep = n => String(round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');  // 121000 → "121 000"
  const rub = n => sep(n) + '₽';
  const yr  = m => rub(m * 12);                                              // годовая проекция

  const allExp  = txs.filter(t => t.type === 'expense' && t.amount > 0);
  const curExp  = allExp.filter(t => now - ts(t) <= 30 * DAY);
  const prevExp = allExp.filter(t => { const a = now - ts(t); return a > 30 * DAY && a <= 60 * DAY; });
  const curInc  = sum(txs.filter(t => t.type === 'income' && t.amount > 0 && now - ts(t) <= 30 * DAY));

  if (curExp.length < 3) {
    return res.status(200).json({ insights: [], recommendations: [], error: 'few_data' });
  }

  const curTotal  = sum(curExp);
  const prevTotal = sum(prevExp);
  const hasPrev   = prevExp.length >= 3;

  const facts = [];   // материал для ИНСАЙТОВ (идёт в LLM)
  const recs  = [];   // готовые РЕКОМЕНДАЦИИ {key, save, text} — отдаём напрямую, без LLM
  // key — стабильный идентификатор темы рекомендации: по нему клиент помнит,
  // что уже показывал, и сервер опускает повторы в пользу свежих

  // ── сводка + норма сбережений (ключевой показатель финграмотности) ─
  const curDays = new Set(curExp.map(dayOf)).size || 1;
  facts.push(`За последние 30 дней потрачено ${rub(curTotal)} за ${curExp.length} операций (≈${rub(curTotal / curDays)} в активный день).`);
  if (hasPrev) {
    const totDelta = prevTotal > 0 ? Math.round((curTotal - prevTotal) / prevTotal * 100) : 0;
    if (Math.abs(totDelta) >= 15) {
      facts.push(`Суммарные траты ${totDelta > 0 ? 'выросли' : 'снизились'} на ${Math.abs(totDelta)}% к прошлым 30 дням (было ${rub(prevTotal)}).`);
    }
  }
  if (curInc > 0) {
    const saved = curInc - curTotal;
    const rate = Math.round(saved / curInc * 100);
    if (saved >= 0) {
      facts.push(`Доход за 30 дней ${rub(curInc)}, расход ${rub(curTotal)} — отложить удалось ${rub(saved)} (${rate}% дохода).`);
    } else {
      facts.push(`Расход за 30 дней (${rub(curTotal)}) превысил доход (${rub(curInc)}) на ${rub(-saved)}.`);
      recs.push({ key: 'overspend', save: -saved, text: `Расходы за месяц превысили доход на ${rub(-saved)} — так растут долги. Урежь крупнейшую категорию или отложи необязательные покупки до следующего поступления.` });
    }
  }

  // ── категории: концентрация и динамика ──────────────────────────
  const byCatCur = {}, byCatPrev = {};
  curExp.forEach(t  => { byCatCur[t.catId]  = (byCatCur[t.catId]  || 0) + t.amount; });
  prevExp.forEach(t => { byCatPrev[t.catId] = (byCatPrev[t.catId] || 0) + t.amount; });

  const catRows = Object.keys(byCatCur).map(id => ({
    id, name: catName(id), cur: byCatCur[id], prev: byCatPrev[id] || 0,
    share: curTotal > 0 ? byCatCur[id] / curTotal : 0
  })).sort((a, b) => b.cur - a.cur);

  // Категория «регулярная» = несколько покупок и нет одной доминирующей разовой.
  // Только такую честно проецировать на год (×12) и предлагать урезать —
  // иначе советуем «экономить каждый месяц» на разовых подарках/покупках.
  const catTxs = {};
  curExp.forEach(t => { (catTxs[t.catId] = catTxs[t.catId] || []).push(t.amount); });
  const isRecurringCat = (id, total) => {
    const a = catTxs[id] || [];
    return a.length >= 3 && Math.max(...a) < total * 0.55;
  };

  // Категории, по которым уже дали рекомендацию о росте суммы, —
  // чтобы не дублировать её рекомендацией о росте среднего чека
  const grownCats = new Set();

  if (catRows.length) {
    const top = catRows[0];
    facts.push(`Самая крупная категория — ${top.name}: ${rub(top.cur)} (${Math.round(top.share * 100)}% всех трат).`);
  }

  if (hasPrev) {
    catRows.forEach(r => {
      if (r.cur < 300) return;
      if (r.prev === 0) {
        if (r.cur >= 700) {
          facts.push(`Новая статья: ${r.name} — ${rub(r.cur)} (в прошлом периоде не было).`);
          recs.push({ key: 'newcat:' + r.name, save: round(r.cur * 0.5), text: `Появилась новая статья «${r.name}» на ${rub(r.cur)}. Проверь: разовая это трата или новая регулярная — если регулярная, заложи её в бюджет заранее.` });
        }
        return;
      }
      const deltaPct = Math.round((r.cur - r.prev) / r.prev * 100);
      const deltaAbs = round(r.cur - r.prev);
      if (deltaPct >= 25 && deltaAbs >= 300) {
        // Рост из-за одной крупной разовой траты — это всплеск, а не привычка:
        // аннуализировать и советовать «экономь каждый месяц» нельзя.
        const catMax = Math.max(...curExp.filter(t => t.catId === r.id).map(t => t.amount));
        const oneOff = catMax >= r.cur * 0.55;
        facts.push(`${r.name}: ${rub(r.cur)} — рост на ${deltaPct}% к прошлым 30 дням (было ${rub(r.prev)}, +${rub(deltaAbs)})${oneOff ? ', в основном из-за крупной разовой траты' : ''}.`);
        if (!oneOff) {
          recs.push({ key: 'growth:' + r.name, save: deltaAbs, text: `${r.name} выросла на ${deltaPct}% за месяц (+${rub(deltaAbs)}). Разберись, что добавилось — вернув к прежним ${rub(r.prev)}, сэкономишь ${rub(deltaAbs)}/мес, ${yr(deltaAbs)} за год.` });
          grownCats.add(r.id);
        }
      } else if (deltaPct <= -25 && -deltaAbs >= 300) {
        facts.push(`${r.name}: ${rub(r.cur)} — снижение на ${Math.abs(deltaPct)}% к прошлым 30 дням (было ${rub(r.prev)}).`);
      }
    });
  }

  // ── подписки (по заметке: стабильная сумма ~раз в месяц) ─────────
  // Отличаем подписку (отменяемую) от частого магазина по каденции.
  const groups = {};
  allExp.forEach(t => {
    const key = norm(t.note);
    if (!key || key.length < 2) return;
    (groups[key] = groups[key] || []).push(t);
  });
  const subs = [];
  Object.values(groups).forEach(arr => {
    const days = [...new Set(arr.map(dayOf))].sort();
    if (days.length < 2) return;
    const amounts = arr.map(t => t.amount);
    const minA = Math.min(...amounts), maxA = Math.max(...amounts);
    const spanDays = (new Date(days[days.length - 1]) - new Date(days[0])) / DAY;
    const interval = spanDays / (days.length - 1);
    if (interval >= 18 && maxA <= minA * 1.4) {
      const sorted = [...amounts].sort((a, b) => a - b);
      subs.push({ label: arr[0].note, monthly: round(sorted[Math.floor(sorted.length / 2)]) });
    }
  });
  subs.sort((a, b) => b.monthly - a.monthly);
  const topSubs = subs.slice(0, 5);
  if (topSubs.length) {
    const totalSubs = topSubs.reduce((s, r) => s + r.monthly, 0);
    facts.push(`Похоже на регулярные платежи/подписки: ${topSubs.map(r => `${r.label} ~${rub(r.monthly)}/мес`).join(', ')} — итого ~${rub(totalSubs)}/мес.`);
    if (totalSubs >= 300) {
      recs.push({ key: 'subs', save: totalSubs, text: `Регулярные платежи — ${rub(totalSubs)}/мес (${topSubs.map(r => r.label).join(', ')}), а за год это ${yr(totalSubs)}. Пройдись по списку и отмени то, чем не пользуешься — деньги списываются незаметно.` });
    }
  }

  // ── частая привычка по заметке (кофе/доставка/такси) ────────────
  // Группируем заметки текущего периода: повтор = привычка.
  const noteAgg = {};
  curExp.forEach(t => {
    const k = norm(t.note);
    if (k.length < 2) return;
    const g = noteAgg[k] || (noteAgg[k] = { label: t.note.slice(0, 40), cat: catName(t.catId), catId: t.catId, count: 0, total: 0, last: 0 });
    g.count++; g.total += t.amount; g.last = Math.max(g.last, ts(t));
  });
  // Привычка = частые мелкие траты (≥8 раз, в среднем <500₽ — отсекает продуктовые закупки).
  const habit = Object.values(noteAgg)
    .filter(g => g.count >= 8 && g.total / g.count < 500)
    .sort((a, b) => b.total - a.total)[0];
  if (habit) {
    facts.push(`«${habit.label}»: ${habit.count} раз за месяц на ${rub(habit.total)} — частая мелкая привычка.`);
    recs.push({ key: 'habit:' + norm(habit.label), save: round(habit.total * 0.5), text: `«${habit.label}» — ${habit.count} раз за месяц на ${rub(habit.total)}, а за год это ${yr(habit.total)}. По чеку незаметно, но даже срезав вдвое, оставишь у себя ${rub(habit.total * 0.5)}/мес.` });
  }

  // ── разбивка крупных категорий по заметкам (что внутри съедает деньги) ─
  // Доли считает движок — LLM получает готовые проценты, делить ей нечего.
  // Закрывает «не вижу, сколько внутри Еды уходит на кофе/доставку».
  const noteByCat = {};
  Object.values(noteAgg).forEach(g => {
    (noteByCat[g.catId] = noteByCat[g.catId] || []).push(g);
  });
  catRows.filter(r => r.cur >= 2000).slice(0, 3).forEach(r => {
    const groups = (noteByCat[r.id] || []).slice().sort((a, b) => b.total - a.total);
    if (!groups.length) return;
    // если заметками покрыто <40% категории — разбивка почти вся «без заметок», бесполезна
    const notedTotal = groups.reduce((s, g) => s + g.total, 0);
    if (notedTotal < r.cur * 0.4) return;
    const shown = groups.filter(g => g.total >= r.cur * 0.15).slice(0, 3);
    if (!shown.length) return;
    // одна заметка ≈ вся категория — скрытой структуры нет, разбивка бесполезна
    if (shown.length === 1 && shown[0].total >= r.cur * 0.85) return;
    const parts = shown.map(g =>
      `${g.label} — ${rub(g.total)} (${Math.round(g.total / r.cur * 100)}%${g.count > 1 ? `, ×${g.count}` : ''})`);
    const rest = r.cur - shown.reduce((s, g) => s + g.total, 0);
    let line = `Внутри «${r.name}» (${rub(r.cur)}): ${parts.join(', ')}`;
    if (rest >= r.cur * 0.1) line += `; остальное — ${rub(rest)} (${Math.round(rest / r.cur * 100)}%)`;
    facts.push(line + '.');

    // РЕКОМЕНДАЦИЯ: крупнейший «скрытый кусок» категории. Работает на 1 месяце
    // (прошлый период не нужен). Текст фактический, прескриптив мягкий — не знаем
    // наверняка, обязательная это трата. count≥3 → это повтор, а не разовый всплеск,
    // поэтому годовую проекцию давать честно. Дедуп против habit и подписок.
    const lead = shown[0];
    const leadKey = norm(lead.label);
    const dupHabit = habit && norm(habit.label) === leadKey;
    const dupSub = topSubs.some(s => norm(s.label) === leadKey);
    if (!dupHabit && !dupSub && lead.count >= 3 && lead.total >= 1500 && lead.total >= r.cur * 0.30) {
      recs.push({
        key: 'chunk:' + leadKey,
        save: round(lead.total * 0.3),
        text: `«${lead.label}» — это ${Math.round(lead.total / r.cur * 100)}% твоей «${r.name}»: ${rub(lead.total)}/мес за ${lead.count} раз, ${yr(lead.total)} за год. По отдельным чекам незаметно — глянь, что здесь можно урезать.`
      });
    }
  });

  // ── концентрация: топ-категория съедает большую долю (работает на 1 мес) ──
  // Прошлый период не нужен. Если бюджета нет — подсказываем задать его на
  // главную статью (безопасно даже для обязательных категорий вроде жилья).
  if (catRows.length && (!budget || !budget.amount) && curTotal > 0) {
    const t = catRows[0];
    // только регулярная категория — годовую проекцию на разовых подарках не даём
    if (t.cur >= 2000 && t.cur / curTotal >= 0.45 && isRecurringCat(t.id, t.cur)) {
      recs.push({
        key: 'concentration',
        save: round(t.cur * 0.05),
        text: `«${t.name}» — ${Math.round(t.cur / curTotal * 100)}% всех трат (${rub(t.cur)}/мес, ${yr(t.cur)} за год), твоя крупнейшая статья. Задай на неё бюджет — так проще держать под контролем.`
      });
    }
  }

  // ── привычка по категории (если заметок нет) ────────────────────
  const catCount = {};
  curExp.forEach(t => { catCount[t.catId] = (catCount[t.catId] || 0) + 1; });
  Object.entries(catCount).forEach(([id, n]) => {
    if (n >= 10) facts.push(`${catName(id)}: ${n} покупок за месяц в среднем по ${rub(byCatCur[id] / n)} — частая привычка.`);
  });

  // ── крупнейшие разовые траты ────────────────────────────────────
  const avgTx = curTotal / curExp.length;
  const big = [...curExp].sort((a, b) => b.amount - a.amount).slice(0, 3)
    .filter(t => t.amount >= avgTx * 2.5 && t.amount >= 1000);
  if (big.length) {
    facts.push(`Крупнейшие разовые траты: ${big.map(t => `${rub(t.amount)} (${t.note ? t.note : catName(t.catId)})`).join(', ')}.`);
  }

  // ── прогноз бюджета ──────────────────────────────────────────────
  if (budget && budget.amount > 0 && budget.set_at) {
    const start = new Date(budget.set_at + 'T00:00:00').getTime();
    const totalDays = budget.deadline
      ? Math.max(1, Math.round((new Date(budget.deadline + 'T23:59:59').getTime() - start) / DAY))
      : (budget.days || 30);
    const deadline = start + totalDays * DAY;
    const elapsed = Math.max(1, Math.min(totalDays, Math.round((now - start) / DAY)));
    const remaining = Math.max(0, totalDays - elapsed);
    const spent = sum(allExp.filter(t => { const x = ts(t); return x >= start && x <= Math.min(now, deadline); }));
    const burn = spent / elapsed;
    facts.push(`Бюджет ${rub(budget.amount)} на ${totalDays} дн.: за ${elapsed} дн. потрачено ${rub(spent)} (${rub(burn)}/день).`);

    if (spent >= budget.amount) {
      const overNow = round(spent - budget.amount);
      if (overNow > 0) {
        facts.push(`Бюджет уже превышен на ${rub(overNow)}${remaining > 0 ? `, а до конца срока ещё ${remaining} дн.` : ''}.`);
        recs.push(remaining > 0
          ? { key: 'budget_over', save: overNow, text: `Бюджет уже превышен на ${rub(overNow)}, а до конца ${remaining} дн. Поставь стоп на необязательное — доставку и развлечения — чтобы не уходить в минус глубже.` }
          : { key: 'budget_closed', save: overNow, text: `Период закрылся с перерасходом ${rub(overNow)}. На следующий заложи бюджет реалистичнее или заранее ужми крупнейшую категорию${catRows[0] ? ` — ${catRows[0].name}` : ''}.` });
      } else {
        facts.push(`Бюджет выбран полностью (${rub(spent)} из ${rub(budget.amount)}).`);
      }
    } else if (remaining > 0) {
      const dailyLeft = (budget.amount - spent) / remaining;
      const projected = burn * totalDays;
      const over = projected - budget.amount;
      if (elapsed >= 3 && over > budget.amount * 0.05) {
        recs.push({ key: 'budget_pace', save: round(over), text: `Тратишь ${rub(burn)}/день — это на ${rub(over)} выше бюджета к концу срока. Держись ${rub(dailyLeft)}/день оставшиеся ${remaining} дн., чтобы уложиться.` });
      } else if (spent > 0) {
        facts.push(`Идёшь в рамках бюджета: оставшиеся ${remaining} дн. можно тратить до ${rub(dailyLeft)}/день.`);
      }
    }
  }

  // ── средний чек по категории: та же частота, но дороже ──────────
  // Сумма может расти не из-за лишних покупок, а из-за подорожания —
  // человек этого не видит, потому что частота не изменилась.
  if (hasPrev) {
    const cntCur = {}, cntPrev = {};
    curExp.forEach(t  => { cntCur[t.catId]  = (cntCur[t.catId]  || 0) + 1; });
    prevExp.forEach(t => { cntPrev[t.catId] = (cntPrev[t.catId] || 0) + 1; });
    catRows.forEach(r => {
      const nc = cntCur[r.id] || 0, np = cntPrev[r.id] || 0;
      if (nc < 3 || np < 3) return;
      if (Math.abs(nc - np) > Math.max(1, np * 0.3)) return;  // частота должна быть сопоставимой
      const avgCur = r.cur / nc, avgPrev = r.prev / np;
      const growth = Math.round((avgCur - avgPrev) / avgPrev * 100);
      if (growth >= 25 && avgCur - avgPrev >= 100) {
        facts.push(`${r.name}: покупок столько же (${nc} за месяц), но средний чек вырос с ${rub(avgPrev)} до ${rub(avgCur)} (+${growth}%).`);
        if (!grownCats.has(r.id)) {
          const extra = round((avgCur - avgPrev) * nc);
          recs.push({ key: 'avgcheck:' + r.name, save: extra, text: `В «${r.name}» покупаешь так же часто, но средний чек вырос на ${growth}% — это +${rub(extra)}/мес. Глянь, что подорожало: возможно, есть замена дешевле.` });
        }
      }
    });
  }

  // ── дни без трат: позитивный сигнал контроля ─────────────────────
  // Окно ограничиваем первой записью: до неё «нулевые» дни — это
  // отсутствие данных, а не отсутствие трат.
  const firstTs = Math.min(...allExp.map(ts));
  const windowDays = Math.min(30, Math.floor((now - firstTs) / DAY) + 1);
  const zeroDays = Math.max(0, windowDays - curDays);
  if (windowDays >= 14 && zeroDays >= 5) {
    facts.push(`${zeroDays} из последних ${windowDays} дней прошли вообще без трат — хороший признак контроля.`);
  }

  // ── календарные месяцы: понятнее человеку, чем скользящие 30 дней ─
  // Сравниваем месяц-к-дате с теми же днями прошлого месяца — честно
  // даже в середине месяца. Движок выше остаётся на скользящих окнах,
  // они устойчивее в начале месяца.
  const today = new Date(now);
  const dom = today.getDate();
  if (dom >= 7) {
    const curMonthStart  = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
    const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1).getTime();
    const prevSameDay    = new Date(today.getFullYear(), today.getMonth() - 1, dom, 23, 59, 59).getTime();
    const curM  = sum(allExp.filter(t => ts(t) >= curMonthStart));
    const prevM = sum(allExp.filter(t => { const x = ts(t); return x >= prevMonthStart && x <= prevSameDay; }));
    if (curM > 0 && prevM > 0) {
      // «11 июня» → «июня»: родительный падеж из локали
      const monthGen = d => d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }).split(' ')[1];
      const d = Math.round((curM - prevM) / prevM * 100);
      if (Math.abs(d) >= 15) {
        facts.push(`За первые ${dom} дней ${monthGen(today)} потрачено ${rub(curM)} — на ${Math.abs(d)}% ${d > 0 ? 'больше' : 'меньше'}, чем за те же дни ${monthGen(new Date(prevMonthStart))} (${rub(prevM)}).`);
      }
    }
  }

  // ── зарплатный всплеск: рост трат в первые дни после дохода ──────
  const paydayIncs = txs.filter(t => t.type === 'income' && t.amount > 0 && now - ts(t) <= 60 * DAY)
    .sort((a, b) => b.amount - a.amount);
  if (paydayIncs.length) {
    // «Зарплатные» поступления — сопоставимые с крупнейшим (отсекаем кэшбек и мелочь)
    const paydays = paydayIncs.filter(t => t.amount >= paydayIncs[0].amount * 0.4).map(ts);
    let afterSpend = 0, afterDays = 0;
    paydays.forEach(p => {
      const end = Math.min(p + 3 * DAY, now);
      if (end <= p) return;
      afterSpend += sum(allExp.filter(t => { const x = ts(t); return x >= p && x < end; }));
      afterDays += (end - p) / DAY;
    });
    const baseTotal = sum(allExp.filter(t => now - ts(t) <= 60 * DAY));
    const baseRate = baseTotal / Math.min(60, Math.max(1, Math.floor((now - firstTs) / DAY) + 1));
    const rate = afterDays > 0 ? afterSpend / afterDays : 0;
    if (afterDays >= 3 && baseRate > 0 && rate >= baseRate * 1.8 && afterSpend >= 2000) {
      const x = Math.round(rate / baseRate * 10) / 10;
      facts.push(`В первые 3 дня после поступления денег уходит ~${rub(rate)}/день — в ${x} раза выше обычного темпа (${rub(baseRate)}/день).`);
      recs.push({ key: 'payday', save: round((rate - baseRate) * 3 * 0.5), text: `После поступления денег траты подскакивают до ${rub(rate)}/день против обычных ${rub(baseRate)}. Попробуй в день зарплаты сразу откладывать часть, а крупные покупки решать через 48 часов.` });
    }
  }

  // ── выходные ─────────────────────────────────────────────────────
  const weekendExp = sum(curExp.filter(t => { const d = new Date(t.date).getDay(); return d === 0 || d === 6; }));
  if (curTotal > 0 && weekendExp / curTotal >= 0.45) {
    facts.push(`${Math.round(weekendExp / curTotal * 100)}% трат приходится на выходные.`);
  }

  // ── РЕКОМЕНДАЦИИ: ранжируем по выгоде, отдаём напрямую (без LLM) ──
  // Уже показанные темы уступают место свежим, но не выбрасываются:
  // если новых мало, повторяем самые выгодные из старых.
  recs.sort((a, b) => b.save - a.save);
  const freshRecs = recs.filter(r => !seenRecKeys.has(r.key));
  const staleRecs = recs.filter(r => seenRecKeys.has(r.key));
  const picked = freshRecs.concat(staleRecs).slice(0, 4).sort((a, b) => b.save - a.save);
  if (!picked.length) {
    // Гарантированный совет: главный рычаг — крупнейшая РЕГУЛЯРНАЯ категория.
    // Разовые всплески (подарки, крупная покупка) пропускаем — их нельзя честно
    // проецировать на год и советовать «урезать на 10%/мес».
    const t = (curTotal > 0 ? catRows : []).find(r => r.cur >= 1000 && isRecurringCat(r.id, r.cur));
    if (t) {
      const pct = Math.round(t.cur / curTotal * 100);
      picked.push({ key: 'top:' + t.name, save: round(t.cur * 0.1), text: `Резких аномалий нет. Главный рычаг — «${t.name}»: ${rub(t.cur)}/мес (${pct}% трат), ${yr(t.cur)} за год. Урежешь на 10% — оставишь у себя ${rub(round(t.cur * 0.1))}/мес.` });
    } else {
      picked.push({ key: 'all_good', save: 0, text: 'Резких аномалий и перерасхода нет. Записывай траты с комментариями и задай бюджет — со временем анализ найдёт, на чём сэкономить.' });
    }
  }
  const recommendations = picked.map(r => r.text);
  const recKeys = picked.map(r => r.key);

  // ── ИНСАЙТЫ: через LLM (читает заметки), с fallback на факты ─────
  const fallbackInsights = () => facts.slice(0, 3);

  const noted = Object.values(noteAgg)
    .sort((a, b) => (b.count > 1 || a.count > 1 ? b.total - a.total : b.last - a.last))
    .slice(0, 20)
    .map(g => g.count > 1
      ? `${g.label} ×${g.count} — ${rub(g.total)} суммарно [${g.cat}]`
      : `${g.label} — ${rub(g.total)} [${g.cat}]`);

  const factsBlock = facts.map(f => `- ${f}`).join('\n');
  const notesBlock = noted.length ? noted.map(n => `- ${n}`).join('\n') : '(комментариев нет)';

  const seenBlock = seenInsights.length
    ? `\n\nУЖЕ ПОКАЗЫВАЛ РАНЬШЕ (не повторяй эти мысли, даже другими словами — выбери другие углы):\n${seenInsights.map(s => `- ${s}`).join('\n')}`
    : '';

  const userPrompt =
`Факты о тратах пользователя. Все числа уже точные — используй только их.

ФАКТЫ:
${factsBlock}

КОММЕНТАРИИ К ТРАТАМ (что человек писал сам — здесь конкретные привычки и состав категорий, не видные по названию категории):
${notesBlock}${seenBlock}

ЗАДАЧА: выбери 2-3 самых важных и неочевидных инсайта — то, что человек сам не замечает (состав категории по комментариям, сдвиг к прошлому месяцу, привычка, норма сбережений, перекос). Если во входе есть разбивка категории по комментариям (строки «Внутри ...») — обязательно построй на ней хотя бы один инсайт: что именно внутри категории съедает деньги и какая это доля. Если данных мало — дай 1-2 точных инсайта, не выдумывай третий.

Ответь ТОЛЬКО JSON-объектом вида:
{"insights":[{"emoji":"☕","text":"..."}]}

Правила:
- emoji — один эмодзи по теме инсайта.
- text: на «ты», по-дружески, коротко (до ~18 слов). Начинай с числа или факта.
- Числа и названия бери ДОСЛОВНО из входа (формат «4500₽» не меняй). Если нужного числа во входе нет — не пиши его.
- Без оценочных эпитетов («необычная», «тревожная»), без банальностей, без советов и сумм экономии.
- Не повторяй мысли из блока «уже показывал», даже другими словами.`;

  let insights;
  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + (process.env.GROQ_API_KEY || ''),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 400,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Ты — личный финансовый аналитик в приложении «Дошик». Тебе дают УЖЕ ПОСЧИТАННЫЕ факты о тратах. ГЛАВНОЕ: ты ничего не считаешь и не выдумываешь — каждое число, процент и название в ответе обязано ДОСЛОВНО присутствовать во входе; нет во входе — не пиши. Никакой арифметики. Делай только описательные наблюдения; советы и суммы экономии считает движок, не ты. Отвечай строго JSON-объектом, без markdown и текста вокруг.'
          },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('Groq error', resp.status, errBody);
      throw new Error(String(resp.status));
    }

    const data = await resp.json();
    const raw = (data.choices?.[0]?.message?.content || '').trim();
    const obj = JSON.parse(raw);
    const parsed = (Array.isArray(obj.insights) ? obj.insights : [])
      .map(i => {
        const text = String((i && i.text) || '').trim();
        if (text.length <= 2) return '';
        const emoji = String((i && i.emoji) || '').trim().slice(0, 8);
        return emoji ? `${emoji} ${text}` : text;
      })
      .filter(Boolean)
      .slice(0, 3);
    insights = parsed.length ? parsed : fallbackInsights();
  } catch (e) {
    // Groq недоступен — рекомендации всё равно есть, инсайты заменяем фактами
    console.error('analyze insights catch:', e.message);
    insights = fallbackInsights();
  }

  return res.status(200).json({ insights, recommendations, recKeys, at: Date.now() });
}
