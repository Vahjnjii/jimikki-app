export async function onRequestPost(context) {
  const email = context.data?.email || 'user';

  try {
    const body = await context.request.json();
    const { message, history = [], userData = {} } = body;

    if (!message || typeof message !== 'string') {
      return new Response(JSON.stringify({ error: 'No message provided' }), { status: 400 });
    }

    // ── Pull ALL data ──
    const holders      = (userData.holders      || []).filter(h => !h.deleted);
    const transactions = (userData.transactions || []).filter(t => !t.deleted);
    const expBuckets   = (userData.expBuckets   || []).filter(b => !b.deleted);
    const incBuckets   = (userData.incBuckets   || []).filter(b => !b.deleted);

    const fmtINR = n => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // ── Totals ──
    const totalWealth   = holders.reduce((s, h) => s + (h.balance || 0), 0);
    const allIncome     = transactions.filter(t => t.type === 'income');
    const allSpending   = transactions.filter(t => t.type === 'spending');
    const allSwaps      = transactions.filter(t => t.type === 'swap');
    const totalIncome   = allIncome.reduce((s, t) => s + t.amount, 0);
    const totalSpending = allSpending.reduce((s, t) => s + t.amount, 0);

    // ── Spending by category ──
    const spendByCat = {};
    allSpending.forEach(t => {
      const name = expBuckets.find(b => b.id === t.bucketId)?.name || t.bucketId || 'Other';
      if (!spendByCat[name]) spendByCat[name] = { total: 0, count: 0, txns: [] };
      spendByCat[name].total += t.amount;
      spendByCat[name].count += 1;
      spendByCat[name].txns.push(`${t.date}|₹${t.amount}${t.note ? '|' + t.note : ''}`);
    });

    // ── Income by source ──
    const incBySrc = {};
    allIncome.forEach(t => {
      const name = incBuckets.find(b => b.id === t.bucketId)?.name || t.bucketId || 'Other';
      if (!incBySrc[name]) incBySrc[name] = { total: 0, count: 0 };
      incBySrc[name].total += t.amount;
      incBySrc[name].count += 1;
    });

    // ── Monthly breakdown (all years) ──
    const monthlyData = {};
    transactions.filter(t => t.type !== 'swap' && t.date).forEach(t => {
      const mo = t.date.slice(0, 7);
      if (!monthlyData[mo]) monthlyData[mo] = { income: 0, spending: 0, txnCount: 0 };
      if (t.type === 'income')   { monthlyData[mo].income   += t.amount; monthlyData[mo].txnCount++; }
      if (t.type === 'spending') { monthlyData[mo].spending += t.amount; monthlyData[mo].txnCount++; }
    });

    // ── Yearly breakdown ──
    const yearlyData = {};
    Object.entries(monthlyData).forEach(([mo, d]) => {
      const yr = mo.slice(0, 4);
      if (!yearlyData[yr]) yearlyData[yr] = { income: 0, spending: 0 };
      yearlyData[yr].income   += d.income;
      yearlyData[yr].spending += d.spending;
    });

    // ── Per-holder breakdown ──
    const holderStats = {};
    holders.forEach(h => {
      const hTxns = transactions.filter(t => t.holderId === h.id && t.type !== 'swap');
      holderStats[h.name] = {
        balance: h.balance,
        income:   hTxns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0),
        spending: hTxns.filter(t => t.type === 'spending').reduce((s, t) => s + t.amount, 0),
        txnCount: hTxns.length
      };
    });

    // ── Biggest transactions ──
    const top5Spending = [...allSpending].sort((a, b) => b.amount - a.amount).slice(0, 5);
    const top5Income   = [...allIncome].sort((a, b) => b.amount - a.amount).slice(0, 5);

    // ── Date range ──
    const sortedDates = transactions.filter(t => t.date).map(t => t.date).sort();
    const firstDate = sortedDates[0] || 'N/A';
    const lastDate  = sortedDates[sortedDates.length - 1] || 'N/A';

    // ── ALL transactions formatted (full history) ──
    const allTxnsFormatted = [...transactions]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(t => {
        const holder = holders.find(h => h.id === t.holderId)?.name || '?';
        if (t.type === 'swap') {
          const fromH = holders.find(h => h.id === t.fromHolderId)?.name || holder;
          const toH   = holders.find(h => h.id === t.toHolderId)?.name || '?';
          return `${t.date} | TRANSFER | ₹${t.amount} | From:${fromH} → To:${toH} | ${t.note || ''}`;
        }
        const bucket = (t.type === 'spending' ? expBuckets : incBuckets).find(b => b.id === t.bucketId)?.name || '?';
        return `${t.date} | ${t.type.toUpperCase()} | ₹${t.amount} | ${bucket} | ${holder} | ${t.note || ''}`;
      });

    // ── Build the system prompt with ALL data ──
    const systemPrompt = `You are Jimikki AI — an expert personal finance analyst with access to the user's COMPLETE financial history.

Your job: analyze deeply, think step by step, show your calculations, compare across time periods, spot trends, find patterns, and give genuinely insightful answers. Never give vague short answers. Always use the actual numbers from the data.

Use Indian Rupee (₹) formatting. Be warm but precise. When doing comparisons or calculations, show the math.

════════════════════════════════════
COMPLETE FINANCIAL DATA FOR: ${email}
════════════════════════════════════

── ACCOUNTS / WALLETS ──
${holders.length
  ? holders.map(h => `• ${h.name}: ${fmtINR(h.balance)}${h.isPrimary ? ' [Primary]' : ''}`).join('\n')
  : '• No accounts added yet'}

── OVERALL SUMMARY ──
• Total Current Wealth: ${fmtINR(totalWealth)}
• Total Income (all time): ${fmtINR(totalIncome)}
• Total Spending (all time): ${fmtINR(totalSpending)}
• Net Savings (all time): ${fmtINR(totalIncome - totalSpending)}
• Total Transactions: ${transactions.length} (${allIncome.length} income, ${allSpending.length} spending, ${allSwaps.length} transfers)
• Data Range: ${firstDate} to ${lastDate}

── PER-ACCOUNT BREAKDOWN ──
${Object.entries(holderStats).map(([name, s]) =>
  `• ${name}: Balance ${fmtINR(s.balance)} | Income ${fmtINR(s.income)} | Spending ${fmtINR(s.spending)} | ${s.txnCount} txns`
).join('\n') || '• None'}

── SPENDING BY CATEGORY (all time) ──
${Object.keys(spendByCat).length
  ? Object.entries(spendByCat)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([k, v]) => `• ${k}: ${fmtINR(v.total)} across ${v.count} transactions (avg ${fmtINR(v.total / v.count)})`)
      .join('\n')
  : '• No spending data'}

── INCOME BY SOURCE (all time) ──
${Object.keys(incBySrc).length
  ? Object.entries(incBySrc)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([k, v]) => `• ${k}: ${fmtINR(v.total)} across ${v.count} transactions`)
      .join('\n')
  : '• No income data'}

── TOP 5 LARGEST SPENDING ──
${top5Spending.map(t => {
  const cat = expBuckets.find(b => b.id === t.bucketId)?.name || '?';
  const holder = holders.find(h => h.id === t.holderId)?.name || '?';
  return `• ${t.date} | ₹${t.amount} | ${cat} | ${holder}${t.note ? ' | ' + t.note : ''}`;
}).join('\n') || '• None'}

── TOP 5 LARGEST INCOME ──
${top5Income.map(t => {
  const src = incBuckets.find(b => b.id === t.bucketId)?.name || '?';
  const holder = holders.find(h => h.id === t.holderId)?.name || '?';
  return `• ${t.date} | ₹${t.amount} | ${src} | ${holder}${t.note ? ' | ' + t.note : ''}`;
}).join('\n') || '• None'}

── MONTHLY BREAKDOWN (all months) ──
${Object.keys(monthlyData).length
  ? Object.entries(monthlyData).sort().map(([mo, d]) =>
      `• ${mo}: IN ${fmtINR(d.income)} | OUT ${fmtINR(d.spending)} | NET ${fmtINR(d.income - d.spending)} | ${d.txnCount} txns`
    ).join('\n')
  : '• No monthly data'}

── YEARLY BREAKDOWN ──
${Object.keys(yearlyData).length
  ? Object.entries(yearlyData).sort().map(([yr, d]) =>
      `• ${yr}: IN ${fmtINR(d.income)} | OUT ${fmtINR(d.spending)} | NET ${fmtINR(d.income - d.spending)}`
    ).join('\n')
  : '• No yearly data'}

── ALL TRANSACTIONS (complete history, newest first) ──
${allTxnsFormatted.length ? allTxnsFormatted.join('\n') : '• No transactions yet'}

── EXPENSE CATEGORIES ──
${expBuckets.map(b => b.name).join(', ') || 'None'}

── INCOME SOURCES ──
${incBuckets.map(b => b.name).join(', ') || 'None'}
════════════════════════════════════

Think deeply before answering. Show calculations. Compare time periods when relevant. Identify trends and patterns. Give specific, data-backed answers.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message }
    ];

    let reply = '';

    // ── METHOD 1: Workers AI binding ──
    if (context.env?.AI) {
      try {
        // Use DeepSeek R1 — the deep thinking/reasoning model
        const res = await context.env.AI.run('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', {
          messages,
          max_tokens: 2048
        });
        reply = res.response || res?.choices?.[0]?.message?.content || '';
        // Strip <think>...</think> tags from output, keep only the final answer
        reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      } catch(e) {
        // Fallback to Llama if DeepSeek fails
        const res2 = await context.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages,
          max_tokens: 1500,
          temperature: 0.2
        });
        reply = res2.response || res2?.choices?.[0]?.message?.content || '';
      }
    }

    // ── METHOD 2: REST API fallback ──
    else if (context.env?.CF_ACCOUNT_ID && context.env?.CF_API_TOKEN) {
      try {
        const res = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${context.env.CF_ACCOUNT_ID}/ai/run/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${context.env.CF_API_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ messages, max_tokens: 2048 })
          }
        );
        const data = await res.json();
        reply = data?.result?.response || data?.result?.choices?.[0]?.message?.content || '';
        reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      } catch(e) {
        // Fallback to Llama 70B
        const res2 = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${context.env.CF_ACCOUNT_ID}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${context.env.CF_API_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ messages, max_tokens: 1500 })
          }
        );
        const data2 = await res2.json();
        reply = data2?.result?.response || data2?.result?.choices?.[0]?.message?.content || '';
      }
    }

    else {
      return new Response(JSON.stringify({
        reply: '⚙️ AI not configured yet.\n\nTo enable (pick one):\n\n✅ Option A — Cloudflare Dashboard → Pages → Your Project → Settings → Functions → Add AI Binding → Variable name: AI\n\n✅ Option B — Add environment variables:\n• CF_ACCOUNT_ID = your account ID\n• CF_API_TOKEN = your API token (with Workers AI permission)\n\nThen redeploy.'
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ reply: reply || 'No response generated.' }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error('Chat error:', e);
    return new Response(JSON.stringify({ reply: '❌ Error: ' + e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
