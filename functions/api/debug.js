export async function onRequestGet(context) {
  const results = {};

  try {
    const rawKey = context.env.GOOGLE_SERVICE_KEY || '';
    const email = context.env.GOOGLE_SERVICE_EMAIL || '';
    const folderId = context.env.GOOGLE_DRIVE_FOLDER_ID || '';

    // ── Get Token ──
    const pemKey = rawKey.replace(/\\n/g, '\n');
    const pemContents = pemKey
      .replace('-----BEGIN PRIVATE KEY-----', '')
      .replace('-----END PRIVATE KEY-----', '')
      .replace(/\s/g, '');

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
      scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets',
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
    const token = tokenData.access_token;
    results.token = token ? 'OK ✅' : 'FAILED';

    // ── Step 1: Create sheet with NO parents (uses service acct drive) ──
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'Jimikki Debug Test — delete me',
        mimeType: 'application/vnd.google-apps.spreadsheet'
        // NO parents — creates in service account root
      })
    });
    const createData = await createRes.json();

    if (!createData.id) {
      results.create = 'FAILED ❌ ' + JSON.stringify(createData.error);
      return new Response(JSON.stringify(results, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    results.create = 'SUCCESS ✅ id=' + createData.id;
    const fileId = createData.id;

    // ── Step 2: Move into YOUR shared folder ──
    const moveRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${folderId}&removeParents=root&fields=id,parents`,
      {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }
    );
    const moveData = await moveRes.json();
    results.move_to_your_folder = moveRes.ok
      ? 'SUCCESS ✅ parents=' + JSON.stringify(moveData.parents)
      : 'FAILED ❌ ' + JSON.stringify(moveData.error);

    // ── Step 3: Write data to sheet ──
    const writeRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/A1?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [['✅ Jimikki Sheet Working!', 'Hello from service account']] })
      }
    );
    const writeData = await writeRes.json();
    results.write = writeRes.ok ? 'SUCCESS ✅' : 'FAILED ❌ ' + JSON.stringify(writeData.error);

    results.sheet_url = 'https://docs.google.com/spreadsheets/d/' + fileId;

  } catch (e) {
    results.exception = e.message;
  }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}
