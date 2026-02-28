export async function onRequestPost(context) {
  const email = context.data.email;

  try {
    const body = await context.request.json();
    const { message, history = [], userData = {} } = body;

    if (!message || typeof message !== 'string') {
      return new Response(JSON.stringify({ error: 'No message provided' }), { status: 400 });
    }

    // Build a rich financial context from the user's actual data
    const holders = (userData.holders || []).filter(h => !h.deleted);
    const transactions = (userData.transactions || []).filter(t => !t.deleted);
    const expBuckets = (userData.expBuckets || []).filter(b => !b.deleted);
    const incBuckets = (userData.incBuckets || []).filter(b => !b.deleted);

    const totalWealth = holders.reduce((s, h) => s + (h.balance || 0), 0);
    const totalIncome = transactions.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const totalSpending = transactions.filter(t => t.type === 'spending').reduce((s, t) => s + t.amount, 0);
    const netSavings = totalIncome - totalSpending;

    // Spending by category
    const spendByCat = {};
    transactions.filter(t => t.type === 'spending').forEach(t => {
      const bucket = expBuckets.find(b => b.id === t.bucketId);
      const name = bucket ? bucket.name : t.bucketId || 'Other';
      spendByCat[name] = (spendByCat[name] || 0) + t.amount;
    });

    // Income by source
    const incBySrc = {};
    transactions.filter(t => t.type === 'income').forEach(t => {
      const bucket = incBuckets.find(b => b.id === t.bucketId);
      const name = bucket ? bucket.name : t.bucketId || 'Other';
      incBySrc[name] = (incBySrc[name] || 0) + t.amount;
    });

    // Recent 10 transactions
    const recentTxns = [...transactions]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10)
      .map(t => {
        const holder = holders.find(h => h.id === t.holderId);
        const bucket = t.type === 'spending'
          ? expBuckets.find(b => b.id === t.bucketId)
          : incBuckets.find(b => b.id === t.bucketId);
        return `${t.date} | ${t.type.toUpperCase()} | ₹${t.amount} | ${bucket ? bucket.name : ''} | ${holder ? holder.name : ''} | ${t.note || ''}`;
      });

    // Monthly breakdown for current year
    const now = new Date();
    const monthlyData = {};
    transactions.filter(t => t.date && t.date.startsWith(String(now.getFullYear()))).forEach(t => {
      const mo = t.date.slice(0, 7);
      if (!monthlyData[mo]) monthlyData[mo] = { income: 0, spending: 0 };
      if (t.type === 'income') monthlyData[mo].income += t.amount;
      if (t.type === 'spending') monthlyData[mo].spending += t.amount;
    });

    const fmtINR = n => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const systemPrompt = `You are Jimikki AI, a smart and friendly personal finance assistant built into the Jimikki finance app.
You have FULL access to this user's real financial data. Always give accurate, data-driven answers.
Be concise, warm, and use Indian Rupee (₹) formatting. Use bullet points for comparisons and lists.

=== USER FINANCIAL SUMMARY ===
User: ${email}

MONEY HOLDERS (Accounts/Wallets):
${holders.length > 0
  ? holders.map(h => `• ${h.name}: ${fmtINR(h.balance)}${h.isPrimary ? ' (Primary)' : ''}`).join('\n')
  : '• No holders added yet'}

TOTAL WEALTH: ${fmtINR(totalWealth)}

OVERALL STATS (All Time):
• Total Income: ${fmtINR(totalIncome)}
• Total Spending: ${fmtINR(totalSpending)}
• Net Savings: ${fmtINR(netSavings)}
• Total Transactions: ${transactions.length}

SPENDING BY CATEGORY:
${Object.keys(spendByCat).length > 0
  ? Object.entries(spendByCat).sort((a,b) => b[1]-a[1]).map(([k, v]) => `• ${k}: ${fmtINR(v)}`).join('\n')
  : '• No spending data'}

INCOME BY SOURCE:
${Object.keys(incBySrc).length > 0
  ? Object.entries(incBySrc).sort((a,b) => b[1]-a[1]).map(([k, v]) => `• ${k}: ${fmtINR(v)}`).join('\n')
  : '• No income data'}

MONTHLY BREAKDOWN (${now.getFullYear()}):
${Object.keys(monthlyData).length > 0
  ? Object.entries(monthlyData).sort().map(([mo, d]) => `• ${mo}: IN ${fmtINR(d.income)} | OUT ${fmtINR(d.spending)} | NET ${fmtINR(d.income - d.spending)}`).join('\n')
  : '• No data for this year'}

RECENT 10 TRANSACTIONS:
${recentTxns.length > 0 ? recentTxns.join('\n') : '• No transactions yet'}

EXPENSE CATEGORIES: ${expBuckets.map(b => b.name).join(', ') || 'None'}
INCOME SOURCES: ${incBuckets.map(b => b.name).join(', ') || 'None'}
===

Answer questions using ONLY the data above. If data is not available, say so clearly.
For calculations, show the working. Keep replies short and useful. Never make up numbers.`;

    // Build conversation history for context
    const messages = [
      ...history.slice(-6).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message }
    ];

    // Call Cloudflare Workers AI — completely free, built-in
    const response = await context.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      max_tokens: 800,
      temperature: 0.3
    });

    const reply = response.response || response?.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';

    return new Response(JSON.stringify({ reply }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error('Chat error:', e);
    return new Response(JSON.stringify({ error: 'AI unavailable: ' + e.message }), { status: 500 });
  }
}
