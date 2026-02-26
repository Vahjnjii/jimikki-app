export async function onRequestGet(context) {
  const results = {};

  try {
    const rawKey = context.env.GOOGLE_SERVICE_KEY || '';
    const email = context.env.GOOGLE_SERVICE_EMAIL || '';

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
      scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file',
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
    results.token = token ? 'OK' : 'FAILED';

    // ── Test 1: Drive API basic test ──
    const driveRes = await fetch(
      'https://www.googleapis.com/drive/v3/files?pageSize=1',
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const driveData = await driveRes.json();
    results.drive_api = driveRes.ok
      ? 'SUCCESS ✅'
      : 'FAILED ❌ code=' + driveData.error?.code + ' msg=' + driveData.error?.message;

    // ── Test 2: Check folder access ──
    const folderId = context.env.GOOGLE_DRIVE_FOLDER_ID;
    const folderRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,permissions`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const folderData = await folderRes.json();
    results.folder_access = folderRes.ok
      ? 'SUCCESS ✅ name=' + folderData.name
      : 'FAILED ❌ code=' + folderData.error?.code + ' msg=' + folderData.error?.message;

    // ── Test 3: Create sheet ──
    const sheetRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        properties: { title: 'Jimikki Debug Test' }
      })
    });
    const sheetData = await sheetRes.json();
    if (sheetData.spreadsheetId) {
      results.sheet_create = 'SUCCESS ✅ id=' + sheetData.spreadsheetId;

      // Test 4: Move to folder
      const moveRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${sheetData.spreadsheetId}?addParents=${folderId}&removeParents=root&fields=id,parents`,
        {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        }
      );
      const moveData = await moveRes.json();
      results.folder_move = moveRes.ok
        ? 'SUCCESS ✅'
        : 'FAILED ❌ code=' + moveData.error?.code + ' msg=' + moveData.error?.message;
    } else {
      results.sheet_create = 'FAILED ❌ code=' + sheetData.error?.code + ' msg=' + sheetData.error?.message + ' status=' + sheetData.error?.status;
    }

  } catch (e) {
    results.exception = e.message;
  }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}
