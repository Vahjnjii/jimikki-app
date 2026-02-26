// Temporary debug file — DELETE after fixing the issue
// Visit: https://jimikki-app.pages.dev/api/debug to see what's wrong

export async function onRequestGet(context) {
  const results = {};

  // ── Test 1: Check env variables exist ──
  results.env = {
    hasServiceEmail: !!context.env.GOOGLE_SERVICE_EMAIL,
    hasServiceKey: !!context.env.GOOGLE_SERVICE_KEY,
    hasFolderId: !!context.env.GOOGLE_DRIVE_FOLDER_ID,
    serviceEmail: context.env.GOOGLE_SERVICE_EMAIL || 'MISSING',
    keyLength: context.env.GOOGLE_SERVICE_KEY?.length || 0,
    keyStart: context.env.GOOGLE_SERVICE_KEY?.slice(0, 40) || 'MISSING',
  };

  // ── Test 2: Check DB table exists ──
  try {
    await context.env.DB.prepare(
      'SELECT COUNT(*) as c FROM user_sheets'
    ).first();
    results.db_table = 'EXISTS ✅';
  } catch (e) {
    results.db_table = 'MISSING ❌ — ' + e.message;
    // Try to create it
    try {
      await context.env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS user_sheets (
          email TEXT PRIMARY KEY,
          sheet_id TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `).run();
      results.db_table_created = 'CREATED NOW ✅';
    } catch (e2) {
      results.db_table_created = 'FAILED: ' + e2.message;
    }
  }

  // ── Test 3: Try to get Google access token ──
  try {
    const rawKey = context.env.GOOGLE_SERVICE_KEY || '';
    const email = context.env.GOOGLE_SERVICE_EMAIL || '';

    if (!rawKey || !email) {
      results.token = 'SKIPPED — missing env vars';
    } else {
      // Clean key
      const pemKey = rawKey.replace(/\\n/g, '\n');
      const pemContents = pemKey
        .replace('-----BEGIN PRIVATE KEY-----', '')
        .replace('-----END PRIVATE KEY-----', '')
        .replace(/\s/g, '');

      results.key_cleaned_length = pemContents.length;
      results.key_looks_valid = pemContents.length > 100;

      const binaryKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
      const cryptoKey = await crypto.subtle.importKey(
        'pkcs8', binaryKey,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['sign']
      );

      const now = Math.floor(Date.now() / 1000);
      const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const payload = btoa(JSON.stringify({
        iss: email,
        scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
      }));

      const sigInput = `${header}.${payload}`;
      const sigBuf = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5', cryptoKey,
        new TextEncoder().encode(sigInput)
      );
      const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

      const jwt = `${sigInput}.${sig}`;

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt
        })
      });

      const tokenData = await tokenRes.json();

      if (tokenData.access_token) {
        results.token = 'SUCCESS ✅ — Got access token';
        results.token_type = tokenData.token_type;

        // ── Test 4: Try creating a test sheet ──
        try {
          const sheetRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${tokenData.access_token}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              properties: { title: 'Jimikki — DEBUG TEST (delete me)' },
              sheets: [{ properties: { title: 'Test', sheetId: 0 } }]
            })
          });
          const sheetData = await sheetRes.json();
          if (sheetData.spreadsheetId) {
            results.sheet_create = 'SUCCESS ✅ — Sheet ID: ' + sheetData.spreadsheetId;

            // Try moving to folder
            if (context.env.GOOGLE_DRIVE_FOLDER_ID) {
              const moveRes = await fetch(
                `https://www.googleapis.com/drive/v3/files/${sheetData.spreadsheetId}?addParents=${context.env.GOOGLE_DRIVE_FOLDER_ID}&removeParents=root`,
                { method: 'PATCH', headers: { 'Authorization': `Bearer ${tokenData.access_token}` } }
              );
              results.folder_move = moveRes.ok ? 'SUCCESS ✅' : 'FAILED ❌ status ' + moveRes.status;
            }
          } else {
            results.sheet_create = 'FAILED ❌ — ' + JSON.stringify(sheetData);
          }
        } catch (e) {
          results.sheet_create = 'ERROR ❌ — ' + e.message;
        }

      } else {
        results.token = 'FAILED ❌ — ' + JSON.stringify(tokenData);
      }
    }
  } catch (e) {
    results.token = 'ERROR ❌ — ' + e.message;
    results.token_stack = e.stack?.slice(0, 300);
  }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}
