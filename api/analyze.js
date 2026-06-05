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

  const apiKey = process.env.OPENROUTER_API_KEY || '';
  console.log('key_len:', apiKey.length, 'char0:', apiKey.charCodeAt(0), 'prefix:', apiKey.slice(0, 8));

  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://doshik.vercel.app',
        'X-Title': 'Дошик'
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.1-8b-instruct:free',
        max_tokens: 350,
        messages: [
          {
            role: 'system',
            content: 'Ты краткий финансовый аналитик. Пиши по-русски, только факты с конкретными цифрами. Без воды и вводных слов.'
          },
          {
            role: 'user',
            content: budStr + 'Дай ровно 3 инсайта о тратах — каждый одним коротким предложением с числами. Разделяй переносом строки. Без нумерации.\n' + JSON.stringify(rows)
          }
        ]
      })
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('OpenRouter error', resp.status, errBody);
      throw new Error(resp.status + ': ' + errBody);
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || 'Нет данных.';
    return res.status(200).json({ text });
  } catch (e) {
    console.error('analyze catch:', e.message);
    return res.status(200).json({ text: 'Сервис временно недоступен — попробуй позже.' });
  }
}
