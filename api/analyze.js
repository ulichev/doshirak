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

  const prompt = budStr + 'Дай ровно 3 инсайта о тратах — каждый одним коротким предложением с числами. Разделяй переносом строки. Без нумерации.\n' + JSON.stringify(rows);

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: 'Ты краткий финансовый аналитик. Пиши по-русски, только факты с конкретными цифрами. Без воды и вводных слов.' }]
        },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 350 }
      })
    });
    if (!resp.ok) throw new Error(String(resp.status));
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Нет данных.';
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(200).json({ text: 'Сервис временно недоступен — попробуй позже.' });
  }
}
