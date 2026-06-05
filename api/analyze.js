export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { txs = [], cats = [], budget = null } = req.body || {};

  if (txs.length < 3) {
    return res.status(200).json({ insights: [], recommendations: [], error: 'few_data' });
  }

  const catMap = {};
  (cats || []).forEach(c => { catMap[c.id] = c.name; });

  // Берём последние 30 дней (или всё если меньше)
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const period = txs.filter(t => t.date >= cutoffStr);
  const working = period.length >= 3 ? period : txs;

  const expenses = working.filter(t => t.type === 'expense');
  const incomes  = working.filter(t => t.type === 'income');

  const totalExp = expenses.reduce((s, t) => s + t.amount, 0);
  const totalInc = incomes.reduce((s, t)  => s + t.amount, 0);

  // Агрегация расходов по категориям
  const byCat = {};
  expenses.forEach(t => {
    const c = catMap[t.catId] || 'Другое';
    byCat[c] = (byCat[c] || 0) + t.amount;
  });
  const catLines = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .map(([c, a]) => `${c}: ${Math.round(a)}₽ (${totalExp > 0 ? Math.round(a / totalExp * 100) : 0}%)`)
    .join('\n');

  // Агрегация по дням (чтобы модель видела паттерн по датам)
  const byDay = {};
  expenses.forEach(t => {
    const d = t.date.slice(0, 10);
    byDay[d] = (byDay[d] || 0) + t.amount;
  });
  const dayLines = Object.entries(byDay)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([d, a]) => `${d}: ${Math.round(a)}₽`)
    .join('\n');

  const daysCount = Object.keys(byDay).length || 1;
  const avgPerDay = Math.round(totalExp / daysCount);

  const budStr = (budget && budget.amount > 0)
    ? `Бюджет: ${Math.round(budget.amount)}₽ на ${budget.days} дней.\n`
    : '';

  const dataBlock =
`${budStr}Период: ${working.length} транзакций.
Расходы всего: ${Math.round(totalExp)}₽, доходы всего: ${Math.round(totalInc)}₽.
Среднее в день (по дням с тратами): ${avgPerDay}₽/день.

Расходы по категориям:
${catLines}

Расходы по дням:
${dayLines}`;

  const userPrompt =
`Вот статистика моих финансов:\n\n${dataBlock}\n\n` +
`Ответь СТРОГО в формате (ничего лишнего, только этот блок):
ИНСАЙТЫ
<инсайт 1 — одно предложение с числами из данных>
<инсайт 2 — одно предложение с числами из данных>
<инсайт 3 — одно предложение с числами из данных>
РЕКОМЕНДАЦИИ
<рекомендация 1 — конкретная категория, на сколько урезать, сколько сэкономишь за месяц>
<рекомендация 2 — конкретная категория или привычка, конкретная экономия>

Используй только реальные числа из данных выше. Не придумывай.`;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + (process.env.GROQ_API_KEY || ''),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 500,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: 'Ты личный финансовый аналитик. Пиши по-русски, кратко и конкретно. Используй ТОЛЬКО цифры из предоставленных данных. Ни в коем случае не выдумывай числа.'
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

    // Парсим блоки ИНСАЙТЫ / РЕКОМЕНДАЦИИ
    const insightMatch = raw.match(/ИНСАЙТЫ\s*([\s\S]*?)(?=РЕКОМЕНДАЦИИ|$)/i);
    const recMatch     = raw.match(/РЕКОМЕНДАЦИИ\s*([\s\S]*?)$/i);

    const parseBlock = (m) => (m ? m[1] : '').split('\n').map(l => l.trim()).filter(l => l.length > 2);

    return res.status(200).json({
      insights:        parseBlock(insightMatch),
      recommendations: parseBlock(recMatch),
    });
  } catch (e) {
    console.error('analyze catch:', e.message);
    return res.status(200).json({ insights: [], recommendations: [], error: 'unavailable' });
  }
}
