export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { txs = [], cats = [], budget = null } = req.body || {};

  if (txs.length < 3) {
    return res.status(200).json({ text: 'Маловато данных — добавь ещё несколько записей, чтобы я мог найти паттерны.' });
  }

  const catMap = {};
  (cats || []).forEach(function(c) { catMap[c.id] = c.name; });

  const rows = txs.slice(-60).map(function(t) {
    const r = { t: t.type === 'expense' ? '-' : '+', a: t.amount, c: catMap[t.catId] || '?', d: t.date };
    if (t.note) r.n = t.note;
    return r;
  });

  const budStr = (budget && budget.amount > 0)
    ? 'Бюджет: ' + budget.amount + '₽ на ' + budget.days + ' дней. '
    : '';

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
        messages: [
          {
            role: 'system',
            content: 'Ты финансовый аналитик. Пиши по-русски. СТРОГО используй только те цифры, которые есть в данных пользователя — никаких прогнозов, допущений и выдуманных чисел. Если данных мало — честно скажи об этом.'
          },
          {
            role: 'user',
            content: budStr + 'Вот мои реальные транзакции:\n' + JSON.stringify(rows) + '\n\nДай ровно 3 коротких инсайта — только на основе этих данных, только реальные числа из списка. Каждый инсайт — одно предложение. Разделяй переносом строки. Без нумерации.'
          }
        ]
      })
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('Groq error', resp.status, errBody);
      throw new Error(String(resp.status));
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || 'Нет данных.';
    return res.status(200).json({ text });
  } catch (e) {
    console.error('analyze catch:', e.message);
    return res.status(200).json({ text: 'Сервис временно недоступен — попробуй позже.' });
  }
}
