const FREE_MODELS = [
  'deepseek/deepseek-r1:free',
  'google/gemma-2-9b-it:free',
  'qwen/qwen-2.5-7b-instruct:free',
  'meta-llama/llama-3.2-3b-instruct:free',
];

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

  const messages = [
    { role: 'system', content: 'Ты краткий финансовый аналитик. Пиши по-русски, только факты с конкретными цифрами. Без воды и вводных слов.' },
    { role: 'user', content: budStr + 'Дай ровно 3 инсайта о тратах — каждый одним коротким предложением с числами. Разделяй переносом строки. Без нумерации.\n' + JSON.stringify(rows) }
  ];

  const headers = {
    'Authorization': 'Bearer ' + (process.env.OPENROUTER_API_KEY || ''),
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://doshik.vercel.app',
    'X-Title': 'Doshik'
  };

  for (const model of FREE_MODELS) {
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, max_tokens: 350, messages })
      });

      if (resp.status === 404) {
        console.log('model not available:', model);
        continue;
      }

      if (!resp.ok) {
        const errBody = await resp.text();
        console.error('OpenRouter error', resp.status, errBody);
        break;
      }

      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content || 'Нет данных.';
      console.log('success with model:', model);
      return res.status(200).json({ text });
    } catch (e) {
      console.error('fetch error for', model, e.message);
    }
  }

  return res.status(200).json({ text: 'Сервис временно недоступен — попробуй позже.' });
}
