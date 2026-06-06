export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { txs = [], cats = [], budget = null } = req.body || {};
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
  const recs  = [];   // готовые РЕКОМЕНДАЦИИ {save, text} — отдаём напрямую, без LLM

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
      recs.push({ save: -saved, text: `Расходы за месяц превысили доход на ${rub(-saved)} — так растут долги. Урежь крупнейшую категорию или отложи необязательные покупки до следующего поступления.` });
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
          recs.push({ save: round(r.cur * 0.5), text: `Появилась новая статья «${r.name}» на ${rub(r.cur)}. Проверь: разовая это трата или новая регулярная — если регулярная, заложи её в бюджет заранее.` });
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
          recs.push({ save: deltaAbs, text: `${r.name} выросла на ${deltaPct}% за месяц (+${rub(deltaAbs)}). Разберись, что добавилось — вернув к прежним ${rub(r.prev)}, сэкономишь ${rub(deltaAbs)}/мес, ${yr(deltaAbs)} за год.` });
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
      recs.push({ save: totalSubs, text: `Регулярные платежи — ${rub(totalSubs)}/мес (${topSubs.map(r => r.label).join(', ')}), а за год это ${yr(totalSubs)}. Пройдись по списку и отмени то, чем не пользуешься — деньги списываются незаметно.` });
    }
  }

  // ── частая привычка по заметке (кофе/доставка/такси) ────────────
  // Группируем заметки текущего периода: повтор = привычка.
  const noteAgg = {};
  curExp.forEach(t => {
    const k = norm(t.note);
    if (k.length < 2) return;
    const g = noteAgg[k] || (noteAgg[k] = { label: t.note.slice(0, 40), cat: catName(t.catId), count: 0, total: 0, last: 0 });
    g.count++; g.total += t.amount; g.last = Math.max(g.last, ts(t));
  });
  // Привычка = частые мелкие траты (≥8 раз, в среднем <500₽ — отсекает продуктовые закупки).
  const habit = Object.values(noteAgg)
    .filter(g => g.count >= 8 && g.total / g.count < 500)
    .sort((a, b) => b.total - a.total)[0];
  if (habit) {
    facts.push(`«${habit.label}»: ${habit.count} раз за месяц на ${rub(habit.total)} — частая мелкая привычка.`);
    recs.push({ save: round(habit.total * 0.5), text: `«${habit.label}» — ${habit.count} раз за месяц на ${rub(habit.total)}, а за год это ${yr(habit.total)}. По чеку незаметно, но даже срезав вдвое, оставишь у себя ${rub(habit.total * 0.5)}/мес.` });
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
          ? { save: overNow, text: `Бюджет уже превышен на ${rub(overNow)}, а до конца ${remaining} дн. Поставь стоп на необязательное — доставку и развлечения — чтобы не уходить в минус глубже.` }
          : { save: overNow, text: `Период закрылся с перерасходом ${rub(overNow)}. На следующий заложи бюджет реалистичнее или заранее ужми крупнейшую категорию${catRows[0] ? ` — ${catRows[0].name}` : ''}.` });
      } else {
        facts.push(`Бюджет выбран полностью (${rub(spent)} из ${rub(budget.amount)}).`);
      }
    } else if (remaining > 0) {
      const dailyLeft = (budget.amount - spent) / remaining;
      const projected = burn * totalDays;
      const over = projected - budget.amount;
      if (elapsed >= 3 && over > budget.amount * 0.05) {
        recs.push({ save: round(over), text: `Тратишь ${rub(burn)}/день — это на ${rub(over)} выше бюджета к концу срока. Держись ${rub(dailyLeft)}/день оставшиеся ${remaining} дн., чтобы уложиться.` });
      } else if (spent > 0) {
        facts.push(`Идёшь в рамках бюджета: оставшиеся ${remaining} дн. можно тратить до ${rub(dailyLeft)}/день.`);
      }
    }
  }

  // ── выходные ─────────────────────────────────────────────────────
  const weekendExp = sum(curExp.filter(t => { const d = new Date(t.date).getDay(); return d === 0 || d === 6; }));
  if (curTotal > 0 && weekendExp / curTotal >= 0.45) {
    facts.push(`${Math.round(weekendExp / curTotal * 100)}% трат приходится на выходные.`);
  }

  // ── РЕКОМЕНДАЦИИ: ранжируем по выгоде, отдаём напрямую (без LLM) ──
  recs.sort((a, b) => b.save - a.save);
  const recommendations = recs.slice(0, 4).map(r => r.text);
  if (!recommendations.length) {
    recommendations.push('Траты под контролем — резких аномалий и перерасхода нет. Продолжай фиксировать расходы с комментариями, чтобы анализ был точнее.');
  }

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

  const userPrompt =
`Посчитанные факты о тратах пользователя. Все числа уже точные — бери только их, ничего не считай заново и не выдумывай.

ФАКТЫ:
${factsBlock}

КОММЕНТАРИИ К ТРАТАМ (что человек писал сам — здесь конкретные привычки, не видные по категориям):
${notesBlock}

Выбери 2-3 САМЫХ важных и неочевидных инсайта — то, что человек сам не замечает (сдвиг к прошлому месяцу, привычка из комментариев, норма сбережений, перекос). Хотя бы один построй на КОММЕНТАРИЯХ, если они есть.

Ответь ТОЛЬКО строками инсайтов, по одной на строку — без заголовков, нумерации, маркеров и Markdown.

Правила:
- На «ты», по-дружески, коротко (до ~18 слов). Начинай с числа или факта.
- Только числа из ФАКТОВ. Без оценочных эпитетов («необычная», «тревожная») и банальностей.`;

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
        max_tokens: 350,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: 'Ты личный финансовый аналитик. Тебе дают УЖЕ ПОСЧИТАННЫЕ факты о тратах — выбери самое важное и сформулируй кратко и по-человечески на русском. НИКОГДА не выдумывай числа.'
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
    const parsed = raw
      .split('\n')
      .map(l => l.trim().replace(/^[-•*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
      .filter(l => l.length > 2 && !/^(ИНСАЙТЫ|РЕКОМЕНДАЦИИ)\b/i.test(l))
      .slice(0, 3);
    insights = parsed.length ? parsed : fallbackInsights();
  } catch (e) {
    // Groq недоступен — рекомендации всё равно есть, инсайты заменяем фактами
    console.error('analyze insights catch:', e.message);
    insights = fallbackInsights();
  }

  return res.status(200).json({ insights, recommendations });
}
