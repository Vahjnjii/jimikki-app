// ─────────────────────────────────────────────────────────────────────────────
// Jimikki AI Chat — chat.js
// Reads COMPLETE user data DIRECTLY from D1 database (not from frontend).
// Uses @cf/qwen/qwq-32b — best reasoning model on Cloudflare Workers AI.
// ─────────────────────────────────────────────────────────────────────────────

export async function onRequestPost(context) {
  // Email is set by _middleware.js from the authenticated session cookie
  const email = context.data?.email;
  if (!email) {
    return new Response(JSON.stringify({ reply: '🔒 Not authenticated.' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await context.request.json();
    const { message, history = [] } = body;

    if (!message || typeof message !== 'string') {
      return new Response(JSON.stringify({ reply: 'No message provided.' }), { status: 400 });
    }

    // ─────────────────────────────────────────────────────
    // STEP 1: Read EVERYTHING directly from D1 database
    // This is the source of truth — 100% complete, always fresh
    // ─────────────────────────────────────────────────────
    let userData = null;
    try {
      const row = await context.env.DB.prepare(
        'SELECT data FROM user_data WHERE email = ?'
      ).bind(email).first();
      if (row && row.data) {
        userData = JSON.parse(row.data);
      }
    } catch (dbErr) {
      console.error('DB read error:', dbErr);
    }

    // If no data in DB yet, return helpful message
    if (!userData) {
      return new Response(JSON.stringify({
        reply: `I don't have any financial data for your account yet (${email}). Please add some transactions in the app first, then I'll be able to analyze everything for you!`
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // ─────────────────────────────────────────────────────
    // STEP 2: Parse ALL data — every single field
    // ─────────────────────────────────────────────────────
    const holders      = (userData.holders      || []).filter(h => !h.deleted);
    const allTxns      = (userData.transactions || []).filter(t => !t.deleted);
    const expBuckets   = (userData.expBuckets   || []).filter(b => !b.deleted);
    const incBuckets   = (userData.incBuckets   || []).filter(b => !b.deleted);
    const deletedTxns  = (userData.transactions || []).filter(t => t.deleted);

    const fmtINR = n => `₹${Number(n || 0).toLocaleString('en-IN', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    })}`;

    // ── Core totals ──
    const incomeTxns   = allTxns.filter(t => t.type === 'income');
    const spendTxns    = allTxns.filter(t => t.type === 'spending');
    const transferTxns = allTxns.filter(t => t.type === 'swap');
    const totalIncome   = incomeTxns.reduce((s, t)  => s + (t.amount || 0), 0);
    const totalSpending = spendTxns.reduce((s, t)   => s + (t.amount || 0), 0);
    const totalWealth   = holders.reduce((s, h)      => s + (h.balance || 0), 0);
    const netSavings    = totalIncome - totalSpending;
    const savingsRate   = totalIncome > 0 ? ((netSavings / totalIncome) * 100).toFixed(1) : '0.0';

    // ── Date range ──
    const datesArr = allTxns.filter(t => t.date).map(t => t.date).sort();
    const firstDate = datesArr[0] || 'N/A';
    const lastDate  = datesArr[datesArr.length - 1] || 'N/A';

    // ── Per-account stats ──
    const holderStats = holders.map(h => {
      const hTxns = allTxns.filter(t => t.holderId === h.id);
      const inc  = hTxns.filter(t => t.type === 'income').reduce((s,t) => s + t.amount, 0);
      const spd  = hTxns.filter(t => t.type === 'spending').reduce((s,t) => s + t.amount, 0);
      const xfIn = transferTxns.filter(t => t.toHolderId === h.id).reduce((s,t) => s + t.amount, 0);
      const xfOut= transferTxns.filter(t => t.fromHolderId === h.id).reduce((s,t) => s + t.amount, 0);
      return {
        name: h.name,
        balance: h.balance,
        isPrimary: h.isPrimary,
        incomeTotal: inc,
        spendingTotal: spd,
        transfersIn: xfIn,
        transfersOut: xfOut,
        txnCount: hTxns.length
      };
    });

    // ── Spending by category — deep detail ──
    const spendByCat = {};
    spendTxns.forEach(t => {
      const name = expBuckets.find(b => b.id === t.bucketId)?.name || 'Other';
      if (!spendByCat[name]) spendByCat[name] = { total: 0, count: 0, avg: 0, txns: [] };
      spendByCat[name].total += t.amount;
      spendByCat[name].count += 1;
      spendByCat[name].txns.push({ date: t.date, amount: t.amount, note: t.note || '', holder: holders.find(h=>h.id===t.holderId)?.name||'' });
    });
    Object.values(spendByCat).forEach(c => { c.avg = c.count > 0 ? c.total / c.count : 0; });

    // ── Income by source ──
    const incBySrc = {};
    incomeTxns.forEach(t => {
      const name = incBuckets.find(b => b.id === t.bucketId)?.name || 'Other';
      if (!incBySrc[name]) incBySrc[name] = { total: 0, count: 0, txns: [] };
      incBySrc[name].total += t.amount;
      incBySrc[name].count += 1;
      incBySrc[name].txns.push({ date: t.date, amount: t.amount, note: t.note || '' });
    });

    // ── Monthly breakdown (ALL months) ──
    const monthly = {};
    allTxns.filter(t => t.date && t.type !== 'swap').forEach(t => {
      const mo = t.date.slice(0, 7); // YYYY-MM
      if (!monthly[mo]) monthly[mo] = { income: 0, spending: 0, txnCount: 0, net: 0 };
      if (t.type === 'income')   monthly[mo].income   += t.amount;
      if (t.type === 'spending') monthly[mo].spending += t.amount;
      monthly[mo].txnCount++;
    });
    Object.values(monthly).forEach(m => { m.net = m.income - m.spending; });

    // ── Yearly breakdown ──
    const yearly = {};
    Object.entries(monthly).forEach(([mo, d]) => {
      const yr = mo.slice(0, 4);
      if (!yearly[yr]) yearly[yr] = { income: 0, spending: 0, net: 0, months: 0 };
      yearly[yr].income   += d.income;
      yearly[yr].spending += d.spending;
      yearly[yr].net      += d.net;
      yearly[yr].months   += 1;
    });

    // ── Weekly spending (last 12 weeks) ──
    const weekly = {};
    const now = new Date();
    spendTxns.forEach(t => {
      if (!t.date) return;
      const d = new Date(t.date);
      const diffWeeks = Math.floor((now - d) / (7 * 24 * 60 * 60 * 1000));
      if (diffWeeks < 12) {
        const wk = `W-${diffWeeks}`;
        weekly[wk] = (weekly[wk] || 0) + t.amount;
      }
    });

    // ── Averages ──
    const moCount = Object.keys(monthly).length;
    const avgMonthlyIncome   = moCount > 0 ? totalIncome   / moCount : 0;
    const avgMonthlySpending = moCount > 0 ? totalSpending / moCount : 0;

    // ── Top transactions ──
    const top10Spend  = [...spendTxns].sort((a,b) => b.amount - a.amount).slice(0, 10);
    const top10Income = [...incomeTxns].sort((a,b) => b.amount - a.amount).slice(0, 10);

    // ── Biggest single day ──
    const dailySpend = {};
    spendTxns.forEach(t => { dailySpend[t.date] = (dailySpend[t.date] || 0) + t.amount; });
    const highestSpendDay = Object.entries(dailySpend).sort((a,b) => b[1]-a[1])[0];

    // ── ALL transactions formatted (newest first, 100% complete) ──
    const allTxnsFormatted = [...allTxns]
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map(t => {
        const holder = holders.find(h => h.id === t.holderId)?.name || 'Unknown';
        if (t.type === 'swap') {
          const fromH = holders.find(h => h.id === (t.fromHolderId || t.holderId))?.name || holder;
          const toH   = holders.find(h => h.id === t.toHolderId)?.name || '?';
          return `[${t.date}] TRANSFER ₹${t.amount} | ${fromH} → ${toH}${t.note ? ' | Note: ' + t.note : ''}`;
        }
        const bucket = (t.type === 'spending' ? expBuckets : incBuckets)
          .find(b => b.id === t.bucketId)?.name || 'Uncategorized';
        return `[${t.date}] ${t.type.toUpperCase()} ₹${t.amount} | Category: ${bucket} | Account: ${holder}${t.note ? ' | Note: ' + t.note : ''}`;
      });

    // ─────────────────────────────────────────────────────
    // STEP 3: Build the most comprehensive system prompt
    // ─────────────────────────────────────────────────────
    const systemPrompt = `You are Jimikki AI, an expert personal finance analyst. You have been given the COMPLETE, 100% accurate financial database of the user ${email}, read directly from the database. Every single transaction they have ever made is listed below.

YOUR JOB:
- Answer questions with pinpoint accuracy using the exact data below
- Think deeply and step-by-step before answering
- Show your calculations clearly (e.g., "₹5,000 + ₹3,200 = ₹8,200")
- Find patterns, trends, and anomalies
- If asked about a specific date, look it up in the complete transaction list
- If asked "what happened on [date]", find every transaction on that date
- Compare time periods when relevant
- Give specific, data-backed answers — never guess or make up numbers
- Use Indian Rupee (₹) format throughout
- Be warm, smart, and genuinely helpful

════════════════════════════════════════════════════════════
COMPLETE FINANCIAL DATABASE — ${email}
Data covers: ${firstDate} to ${lastDate}
════════════════════════════════════════════════════════════

━━━ ACCOUNTS / WALLETS ━━━
${holderStats.length > 0
  ? holderStats.map(h =>
      `• ${h.name}${h.isPrimary ? ' [PRIMARY]' : ''}
   Current Balance: ${fmtINR(h.balance)}
   Total Income Received: ${fmtINR(h.incomeTotal)}
   Total Spending: ${fmtINR(h.spendingTotal)}
   Transfers In: ${fmtINR(h.transfersIn)} | Transfers Out: ${fmtINR(h.transfersOut)}
   Transactions: ${h.txnCount}`
    ).join('\n')
  : '• No accounts added yet'}

━━━ OVERALL FINANCIAL SUMMARY ━━━
• Total Current Wealth: ${fmtINR(totalWealth)}
• All-Time Income: ${fmtINR(totalIncome)}
• All-Time Spending: ${fmtINR(totalSpending)}
• Net Savings (all time): ${fmtINR(netSavings)}
• Savings Rate: ${savingsRate}%
• Total Transactions: ${allTxns.length} (${incomeTxns.length} income, ${spendTxns.length} spending, ${transferTxns.length} transfers)
• Deleted/Archived Transactions: ${deletedTxns.length}
• Avg Monthly Income: ${fmtINR(avgMonthlyIncome)}
• Avg Monthly Spending: ${fmtINR(avgMonthlySpending)}
• Highest Single-Day Spending: ${highestSpendDay ? `${highestSpendDay[0]} — ${fmtINR(highestSpendDay[1])}` : 'N/A'}

━━━ SPENDING BY CATEGORY (complete breakdown) ━━━
${Object.keys(spendByCat).length > 0
  ? Object.entries(spendByCat)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, d]) =>
        `• ${name}: ${fmtINR(d.total)} total | ${d.count} transactions | Avg ${fmtINR(d.avg)} each`
      ).join('\n')
  : '• No spending data'}

━━━ INCOME BY SOURCE (complete breakdown) ━━━
${Object.keys(incBySrc).length > 0
  ? Object.entries(incBySrc)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, d]) =>
        `• ${name}: ${fmtINR(d.total)} total | ${d.count} transactions`
      ).join('\n')
  : '• No income data'}

━━━ YEAR-BY-YEAR BREAKDOWN ━━━
${Object.keys(yearly).length > 0
  ? Object.entries(yearly).sort().map(([yr, d]) =>
      `• ${yr}: Income ${fmtINR(d.income)} | Spending ${fmtINR(d.spending)} | Net ${fmtINR(d.net)} | ${d.months} active months`
    ).join('\n')
  : '• No yearly data'}

━━━ MONTH-BY-MONTH BREAKDOWN (all ${moCount} months) ━━━
${Object.keys(monthly).length > 0
  ? Object.entries(monthly).sort().map(([mo, d]) =>
      `• ${mo}: IN ${fmtINR(d.income)} | OUT ${fmtINR(d.spending)} | NET ${fmtINR(d.net)} | ${d.txnCount} txns`
    ).join('\n')
  : '• No monthly data'}

━━━ TOP 10 LARGEST SPENDING TRANSACTIONS ━━━
${top10Spend.map(t => {
  const cat = expBuckets.find(b => b.id === t.bucketId)?.name || '?';
  const acc = holders.find(h => h.id === t.holderId)?.name || '?';
  return `• [${t.date}] ₹${t.amount} | ${cat} | ${acc}${t.note ? ' | ' + t.note : ''}`;
}).join('\n') || '• None'}

━━━ TOP 10 LARGEST INCOME TRANSACTIONS ━━━
${top10Income.map(t => {
  const src = incBuckets.find(b => b.id === t.bucketId)?.name || '?';
  const acc = holders.find(h => h.id === t.holderId)?.name || '?';
  return `• [${t.date}] ₹${t.amount} | ${src} | ${acc}${t.note ? ' | ' + t.note : ''}`;
}).join('\n') || '• None'}

━━━ EXPENSE CATEGORIES CONFIGURED ━━━
${expBuckets.map(b => b.name).join(', ') || 'None'}

━━━ INCOME SOURCES CONFIGURED ━━━
${incBuckets.map(b => b.name).join(', ') || 'None'}

━━━ COMPLETE TRANSACTION HISTORY (${allTxns.length} transactions, newest first) ━━━
${allTxnsFormatted.length > 0 ? allTxnsFormatted.join('\n') : '• No transactions yet'}

════════════════════════════════════════════════════════════
END OF DATABASE — You have the complete picture. Think carefully, calculate precisely, and answer accurately.
════════════════════════════════════════════════════════════`;

    // ─────────────────────────────────────────────────────
    // STEP 4: Call the best reasoning model on Cloudflare
    // Primary:  @cf/qwen/qwq-32b  (best reasoning, competitive with o1-mini)
    // Fallback: @cf/deepseek-ai/deepseek-r1-distill-qwen-32b
    // ─────────────────────────────────────────────────────
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-10).map(m => ({ role: m.role, content: String(m.content) })),
      { role: 'user', content: message }
    ];

    let reply = '';

    if (!context.env?.AI) {
      return new Response(JSON.stringify({
        reply: '⚙️ AI binding not configured.\n\nFix: Cloudflare Dashboard → Pages → Your Project → Settings → Functions → Add AI Binding → Variable name: AI\n\nThen redeploy.'
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Try QwQ-32B first (best reasoning model on Cloudflare)
    try {
      const res = await context.env.AI.run('@cf/qwen/qwq-32b', {
        messages,
        max_tokens: 2048
      });
      reply = res.response || res?.choices?.[0]?.message?.content || '';
      // Remove internal <think> reasoning tags — show only the final answer
      reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    } catch (e1) {
      console.warn('QwQ-32B failed, trying DeepSeek-R1:', e1.message);
      // Fallback: DeepSeek R1 Distill 32B
      try {
        const res2 = await context.env.AI.run('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', {
          messages,
          max_tokens: 2048
        });
        reply = res2.response || res2?.choices?.[0]?.message?.content || '';
        reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      } catch (e2) {
        console.warn('DeepSeek-R1 failed, trying Llama 3.3 70B:', e2.message);
        // Final fallback: Llama 3.3 70B
        const res3 = await context.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages,
          max_tokens: 1500,
          temperature: 0.1
        });
        reply = res3.response || res3?.choices?.[0]?.message?.content || '';
      }
    }

    return new Response(JSON.stringify({ reply: reply || 'No response generated.' }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    console.error('Chat error:', e);
    return new Response(JSON.stringify({ reply: '❌ Error: ' + e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
