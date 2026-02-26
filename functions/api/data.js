import { syncToSheets } from './sheets-sync.js';

export async function onRequestGet(context) {
  const email = context.data.email;
  try {
    const row = await context.env.DB.prepare(
      'SELECT data FROM user_data WHERE email = ?'
    ).bind(email).first();

    // Also get their sheet URL if exists
    let sheetUrl = null;
    try {
      const sheetRow = await context.env.DB.prepare(
        'SELECT sheet_id FROM user_sheets WHERE email = ?'
      ).bind(email).first();
      if (sheetRow) sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetRow.sheet_id}`;
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

    // Sync to Google Sheets (non-blocking — don't fail if sheets errors)
    const sheetResult = await syncToSheets(context.env, email, userData, context.env.DB);

    return new Response(JSON.stringify({
      ok: true,
      sheetUrl: sheetResult?.url || null
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch {
    return new Response('Server error', { status: 500 });
  }
}
