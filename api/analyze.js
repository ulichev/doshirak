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

  const allExp  = txs.filter(t => t.type === 'expense' && t.amount > 0);
  const curExp  = allExp.filter(t => now - ts(t) <= 30 * DAY);
  const prevExp = allExp.filter(t => { const a = now - ts(t); return a > 30 * DAY && a <= 60 * DAY; });

  if (curExp.length < 3) {
    return res.status(200).json({ insights: [], recommendations: [], error: 'few_data' });
  }

  const curTotal  = sum(curExp);
  const prevTotal = sum(prevExp);
  const hasPrev   = prevExp.length >= 3;

  const facts   = [];   // материал для блока ИНСАЙТЫ
  const actions = [];   // материал для блока РЕКОМЕНДАЦИИ

  // ── сводка ───────────────────────────────────────────────────────
  const curDays = new Set(curExp.map(dayOf)).size || 1;
  facts.push(`За последние 30 дней потрачено ${round(curTotal)}₽ за ${curExp.length} операций (≈${round(curTotal / curDays)}₽ в активный день).`);
  if (hasPrev) {
    const totDelta = prevTotal > 0 ? Math.round((curTotal - prevTotal) / prevTotal * 100) : 0;
    if (Math.abs(totDelta) >= 15) {
      facts.push(`Суммарные траты ${totDelta > 0 ? 'выросли' : 'снизились'} на ${Math.abs(totDelta)}% к прошлым 30 дням (было ${round(prevTotal)}₽).`);
    }
  }

  // ── сигнал 1: категории — концентрация и динамика ───────────────
  const byCatCur = {}, byCatPrev = {};
  curExp.forEach(t  => { byCatCur[t.catId]  = (byCatCur[t.catId]  || 0) + t.amount; });
  prevExp.forEach(t => { byCatPrev[t.catId] = (byCatPrev[t.catId] || 0) + t.amount; });

  const catRows = Object.keys(byCatCur).map(id => ({
    id, name: catName(id), cur: byCatCur[id], prev: byCatPrev[id] || 0,
    share: curTotal > 0 ? byCatCur[id] / curTotal : 0
  })).sort((a, b) => b.cur - a.cur);

  if (catRows.length) {
    const top = catRows[0];
    facts.push(`Самая крупная категория — ${top.name}: ${round(top.cur)}₽ (${Math.round(top.share * 100)}% всех трат).`);
  }

  if (hasPrev) {
    catRows.forEach(r => {
      if (r.cur < 300) return;
      if (r.prev === 0) {
        if (r.cur >= 700) {
          facts.push(`Новая статья: ${r.name} — ${round(r.cur)}₽ (в прошлом периоде не было).`);
          actions.push(`Появилась новая категория «${r.name}» на ${round(r.cur)}₽ — проверь, разовая это трата или новая регулярная статья.`);
        }
        return;
      }
      const deltaPct = Math.round((r.cur - r.prev) / r.prev * 100);
      const deltaAbs = round(r.cur - r.prev);
      if (deltaPct >= 25 && deltaAbs >= 300) {
        facts.push(`${r.name}: ${round(r.cur)}₽ — рост на ${deltaPct}% к прошлым 30 дням (было ${round(r.prev)}₽, +${deltaAbs}₽).`);
        actions.push(`«${r.name}» выросла на ${deltaPct}% (+${deltaAbs}₽). Если вернуть к прежним ${round(r.prev)}₽ — экономия ${deltaAbs}₽ в месяц.`);
      } else if (deltaPct <= -25 && -deltaAbs >= 300) {
        facts.push(`${r.name}: ${round(r.cur)}₽ — снижение на ${Math.abs(deltaPct)}% к прошлым 30 дням (было ${round(r.prev)}₽).`);
      }
    });
  }

  // ── сигнал 2: подписки (по заметке: стабильная сумма ~раз в месяц) ─
  // Отличаем подписку (отменяемую) от частого магазина по каденции:
  // подписка повторяется примерно раз в 18+ дней со стабильной суммой,
  // а продуктовый магазин — много раз в месяц.
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
    facts.push(`Похоже на регулярные платежи/подписки: ${topSubs.map(r => `${r.label} ~${r.monthly}₽/мес`).join(', ')} — итого ~${totalSubs}₽/мес.`);
    if (totalSubs >= 300) {
      actions.push(`Регулярные платежи на ~${totalSubs}₽/мес (${topSubs.map(r => r.label).join(', ')}). Проверь, всеми ли пользуешься — отмена ненужного освободит до ${totalSubs}₽ ежемесячно.`);
    }
  }

  // ── сигнал 3: частая привычка (много мелких трат в категории) ───
  const catCount = {};
  curExp.forEach(t => { catCount[t.catId] = (catCount[t.catId] || 0) + 1; });
  Object.entries(catCount).forEach(([id, n]) => {
    if (n >= 10) {
      const avg = round(byCatCur[id] / n);
      facts.push(`${catName(id)}: ${n} покупок за месяц в среднем по ${avg}₽ — частая привычка.`);
    }
  });

  // ── сигнал 4: крупнейшие разовые траты ──────────────────────────
  const avgTx = curTotal / curExp.length;
  const big = [...curExp].sort((a, b) => b.amount - a.amount).slice(0, 3)
    .filter(t => t.amount >= avgTx * 2.5 && t.amount >= 1000);
  if (big.length) {
    facts.push(`Крупнейшие разовые траты: ${big.map(t => `${round(t.amount)}₽ (${t.note ? t.note : catName(t.catId)})`).join(', ')}.`);
  }

  // ── сигнал 5: прогноз бюджета ────────────────────────────────────
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
    facts.push(`Бюджет ${round(budget.amount)}₽ на ${totalDays} дн.: за ${elapsed} дн. потрачено ${round(spent)}₽ (${round(burn)}₽/день).`);

    if (spent >= budget.amount) {
      // Бюджет уже исчерпан — «трать 0₽/день» бессмысленно, говорим прямо
      const overNow = round(spent - budget.amount);
      if (overNow > 0) {
        facts.push(`Бюджет уже превышен на ${overNow}₽${remaining > 0 ? `, а до конца срока ещё ${remaining} дн.` : ''}.`);
        actions.push(remaining > 0
          ? `Бюджет на этот период исчерпан (перерасход ${overNow}₽), но срок ещё не вышел. Сократи всё необязательное до конца периода, а на следующий — заложи реалистичнее.`
          : `Период закрыт с перерасходом ${overNow}₽. На следующий период имеет смысл поднять бюджет или заранее урезать крупнейшую категорию.`);
      } else {
        facts.push(`Бюджет выбран полностью (${round(spent)}₽ из ${round(budget.amount)}₽).`);
      }
    } else if (remaining > 0) {
      const dailyLeft = (budget.amount - spent) / remaining;        // > 0, т.к. spent < budget
      // Прогноз надёжен только если прошло хотя бы 3 дня
      const projected = burn * totalDays;
      const over = projected - budget.amount;
      if (elapsed >= 3 && over > budget.amount * 0.05) {
        const exhaust = burn > 0 ? Math.max(0, Math.round((budget.amount - spent) / burn)) : remaining;
        actions.push(`Темп ${round(burn)}₽/день — при нём бюджета хватит ещё на ~${exhaust} дн. (на ${Math.max(0, remaining - exhaust)} дн. меньше срока), перерасход выйдет ~${round(over)}₽. Чтобы дотянуть, держи не больше ${round(dailyLeft)}₽/день.`);
      } else if (spent > 0) {
        facts.push(`Идёшь в рамках бюджета: оставшиеся ${remaining} дн. можно тратить до ${round(dailyLeft)}₽/день.`);
      }
    }
  }

  // ── сигнал 6: выходные ───────────────────────────────────────────
  const weekendExp = sum(curExp.filter(t => { const d = new Date(t.date).getDay(); return d === 0 || d === 6; }));
  if (curTotal > 0 && weekendExp / curTotal >= 0.45) {
    facts.push(`${Math.round(weekendExp / curTotal * 100)}% трат приходится на выходные.`);
  }

  // ── комментарии к тратам — сырьё для качественного инсайта ──────
  // Категории не передают «доставка вечером» или «такси, хотя есть проездной».
  // Группируем одинаковые заметки (повтор = привычка) — нагляднее и экономит токены.
  const noteAgg = {};
  curExp.forEach(t => {
    const k = norm(t.note);
    if (k.length < 2) return;
    const g = noteAgg[k] || (noteAgg[k] = { label: t.note.slice(0, 40), cat: catName(t.catId), count: 0, total: 0, last: 0 });
    g.count++; g.total += t.amount; g.last = Math.max(g.last, ts(t));
  });
  const noted = Object.values(noteAgg)
    .sort((a, b) => (b.count > 1 || a.count > 1 ? b.total - a.total : b.last - a.last))
    .slice(0, 20)
    .map(g => g.count > 1
      ? `${g.label} ×${g.count} — ${round(g.total)}₽ суммарно [${g.cat}]`
      : `${g.label} — ${round(g.total)}₽ [${g.cat}]`);

  // ── сборка промпта ───────────────────────────────────────────────
  const factsBlock  = facts.map(f => `- ${f}`).join('\n');
  const actionBlock = actions.length ? actions.map(a => `- ${a}`).join('\n') : '(значимых поводов для рекомендаций нет)';
  const notesBlock  = noted.length ? noted.map(n => `- ${n}`).join('\n') : '(комментариев нет)';

  const userPrompt =
`Посчитанные факты о тратах пользователя. Все числа уже точные — бери только их, ничего не считай заново и не выдумывай.

ФАКТЫ:
${factsBlock}

ВОЗМОЖНЫЕ ДЕЙСТВИЯ (основа для рекомендаций):
${actionBlock}

КОММЕНТАРИИ К ТРАТАМ (что человек писал сам — ищи здесь конкретные привычки, которые не видны по категориям):
${notesBlock}

Ответь СТРОГО в этом формате, без вступлений, пояснений и Markdown:
ИНСАЙТЫ
<2-3 строки>
РЕКОМЕНДАЦИИ
<1-3 строки>

Как писать (стиль):
- Обращайся на «ты», по-дружески, без канцелярита.
- Одна строка — одна мысль, коротко (до ~18 слов). Начинай с главного числа или факта, а не с воды.
- Инсайт должен быть НЕОЧЕВИДНЫМ: не «самая большая категория — Еда», а сдвиг или привычка (рост к прошлому месяцу, частое из КОММЕНТАРИЕВ, перекос в выходные).
- Хотя бы один инсайт построй на КОММЕНТАРИЯХ, если они есть (конкретно: «доставка», «кофе», «такси»).
- Рекомендация = конкретное действие + сумма выгоды из ВОЗМОЖНЫХ ДЕЙСТВИЙ.

Пример нужного стиля (НЕ копируй числа и текст, ориентируйся только на тон и длину):
ИНСАЙТЫ
Доставка съела 9 400₽ — почти вдвое больше, чем месяц назад.
На кофе навынос ушло 4 060₽: 14 стаканов за месяц.
РЕКОМЕНДАЦИИ
Готовь дома 2-3 раза в неделю вместо доставки — вернёшь ~4 700₽.

Жёсткие правила:
- Только числа из данных выше. Сумму экономии бери из ВОЗМОЖНЫХ ДЕЙСТВИЙ, не выдумывай.
- Если «возможных действий» нет — дай ровно одну рекомендацию: «Траты под контролем, резких аномалий нет — продолжай фиксировать расходы, чтобы накопить историю».
- Никогда не советуй «лимит 0₽/день», «не трать вообще» или прочие нереалистичные крайности.
- Без банальностей «тратьте меньше», «ведите учёт». Без нумерации, маркеров и заголовков внутри блоков.`;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + (process.env.GROQ_API_KEY || ''),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 600,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'Ты личный финансовый аналитик. Тебе дают УЖЕ ПОСЧИТАННЫЕ факты о тратах — твоя работа выбрать самое важное и сформулировать кратко и по-человечески на русском. НИКОГДА не выдумывай числа: используй только те, что в данных.'
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

    const insightMatch = raw.match(/ИНСАЙТЫ\s*([\s\S]*?)(?=РЕКОМЕНДАЦИИ|$)/i);
    const recMatch     = raw.match(/РЕКОМЕНДАЦИИ\s*([\s\S]*?)$/i);

    const parseBlock = (m) => (m ? m[1] : '')
      .split('\n')
      .map(l => l.trim().replace(/^[-•*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
      .filter(l => l.length > 2);

    return res.status(200).json({
      insights:        parseBlock(insightMatch),
      recommendations: parseBlock(recMatch),
    });
  } catch (e) {
    console.error('analyze catch:', e.message);
    return res.status(200).json({ insights: [], recommendations: [], error: 'unavailable' });
  }
}
