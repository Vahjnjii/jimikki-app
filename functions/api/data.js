

export async function onRequestGet(context) {
  const email = context.data.email;
  try {
    const row = await context.env.DB.prepare(
      'SELECT data FROM user_data WHERE email = ?'
    ).bind(email).first();

    let sheetUrl = null, syncStatus = null, lastSyncedAt = null, lastAttemptAt = null, lastError = null;
    try {
      const sr = await context.env.DB.prepare(
        'SELECT sheet_url, sync_status, last_synced_at, last_attempt_at, last_error FROM user_sheets WHERE email = ?'
      ).bind(email).first();
      if (sr) {
        sheetUrl = sr.sheet_url;
        syncStatus = sr.sync_status;
        lastSyncedAt = sr.last_synced_at;
        lastAttemptAt = sr.last_attempt_at;
        lastError = sr.last_error;
      }
    } catch {}

    if (!row) return new Response(JSON.stringify({
      email, holders: [], transactions: [], expBuckets: null, incBuckets: null,
      sheetUrl, syncStatus, lastSyncedAt, lastAttemptAt, lastError
    }), { headers: { 'Content-Type': 'application/json' } });

    return new Response(JSON.stringify({
      email, ...JSON.parse(row.data), sheetUrl, syncStatus, lastSyncedAt, lastAttemptAt, lastError
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

    // Ensure user_sheets table exists with correct schema
    await context.env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS user_sheets (
        email TEXT PRIMARY KEY,
        sheet_url TEXT,
        sync_status TEXT,
        last_synced_at TEXT,
        last_attempt_at TEXT,
        last_error TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `).run();

    // Migrate older tables that predate these columns
    for (const col of ['sync_status TEXT', 'last_synced_at TEXT', 'last_attempt_at TEXT', 'last_error TEXT']) {
      try { await context.env.DB.prepare(`ALTER TABLE user_sheets ADD COLUMN ${col}`).run(); } catch {}
    }

    let prevSheetUrl = null, prevSyncedAt = null;
    try {
      const prev = await context.env.DB.prepare(
        'SELECT sheet_url, last_synced_at FROM user_sheets WHERE email = ?'
      ).bind(email).first();
      if (prev) { prevSheetUrl = prev.sheet_url; prevSyncedAt = prev.last_synced_at; }
    } catch {}

    // Sync to Google Sheets via Apps Script
    let sheetUrl = prevSheetUrl;
    let syncStatus = 'error';
    let lastError = null;
    const nowIso = new Date().toISOString();
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
          syncStatus = 'success';
        } else {
          lastError = (result && result.error) || 'Sync script returned an error';
        }
      } catch (e) {
        lastError = e.message || 'Network error reaching sync script';
      }
    } else {
      lastError = 'GOOGLE_SCRIPT_URL not configured';
    }

    const lastSyncedAt = syncStatus === 'success' ? nowIso : prevSyncedAt;

    await context.env.DB.prepare(
      `INSERT INTO user_sheets (email, sheet_url, sync_status, last_synced_at, last_attempt_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(email) DO UPDATE SET
         sheet_url=excluded.sheet_url,
         sync_status=excluded.sync_status,
         last_synced_at=excluded.last_synced_at,
         last_attempt_at=excluded.last_attempt_at,
         last_error=excluded.last_error,
         updated_at=datetime('now')`
    ).bind(email, sheetUrl, syncStatus, lastSyncedAt, nowIso, lastError).run();

    return new Response(JSON.stringify({
      ok: syncStatus === 'success', sheetUrl, syncStatus, lastSyncedAt, lastAttemptAt: nowIso, lastError
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
