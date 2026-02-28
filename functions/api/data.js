export async function onRequestGet(context) {
  const email = context.data.email;
  try {
    const row = await context.env.DB.prepare(
      'SELECT data FROM user_data WHERE email = ?'
    ).bind(email).first();

    let sheetUrl = null;
    try {
      const sr = await context.env.DB.prepare(
        'SELECT sheet_url FROM user_sheets WHERE email = ?'
      ).bind(email).first();
      if (sr) sheetUrl = sr.sheet_url;
    } catch {}

    if (!row) return new Response(JSON.stringify({
      email, holders: [], transactions: [], expBuckets: null, incBuckets: null, sheetUrl
    }), { headers: { 'Content-Type': 'application/json' } });

    return new Response(JSON.stringify({
      email, ...JSON.parse(row.data), sheetUrl
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch {
    return new Response('Server error', { status: 500 });
  }
}

export async function onRequestPost(context) {
  const email = context.data.email;
  try {
    const body = await context.request.text();
    const userData = JSON.parse(body);

    // Save to D1
    await context.env.DB.prepare(
      'INSERT OR REPLACE INTO user_data (email, data, updated_at) VALUES (?, ?, datetime("now"))'
    ).bind(email, body).run();

    // Sync to Google Sheets via Apps Script
    let sheetUrl = null;
    const scriptUrl = context.env.GOOGLE_SCRIPT_URL;

    if (scriptUrl) {
      try {
        const res = await fetch(scriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, ...userData })
        });
        const result = await res.json();
        if (result.ok && result.url) {
          sheetUrl = result.url;
          await context.env.DB.prepare(
            'INSERT OR REPLACE INTO user_sheets (email, sheet_url, updated_at) VALUES (?, ?, datetime("now"))'
          ).bind(email, sheetUrl).run();
        }
      } catch {}
    }

    return new Response(JSON.stringify({ ok: true, sheetUrl }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch {
    return new Response('Server error', { status: 500 });
  }
}
