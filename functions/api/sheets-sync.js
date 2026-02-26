// ─── Google Sheets Sync for Jimikki ───────────────────────────────────────
// Handles: create sheet per user, share with user, full beautiful rebuild

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive'
];

// ── JWT + Access Token ────────────────────────────────────────────────────
async function getAccessToken(env) {
  const email = env.GOOGLE_SERVICE_EMAIL;
  const rawKey = env.GOOGLE_SERVICE_KEY;

  // Clean up the private key
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
    scope: SCOPES.join(' '),
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

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  const data = await res.json();
  if (!data.access_token) throw new Error('Failed to get access token: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Create new Sheet ──────────────────────────────────────────────────────
async function createSheet(token, userName, folderId) {
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      properties: { title: `Jimikki — ${userName}` },
      sheets: [{ properties: { title: 'Finance', sheetId: 0 } }]
    })
  });
  const data = await res.json();
  if (!data.spreadsheetId) throw new Error('Sheet creation failed: ' + JSON.stringify(data));

  // Move to folder
  if (folderId) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${data.spreadsheetId}?addParents=${folderId}&removeParents=root`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}` }
    });
  }

  return data.spreadsheetId;
}

// ── Share sheet with user ─────────────────────────────────────────────────
async function shareSheet(token, sheetId, email) {
  await fetch(`https://www.googleapis.com/drive/v3/files/${sheetId}/permissions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      role: 'reader',
      type: 'user',
      emailAddress: email
    })
  });
}

// ── Build the full beautiful sheet ───────────────────────────────────────
async function rebuildSheet(token, sheetId, userData) {
  const { holders = [], transactions = [], expBuckets = [], incBuckets = [], email = '' } = userData;

  const actH = holders.filter(h => !h.deleted);
  const actT = transactions.filter(t => !t.deleted).sort((a, b) => b.date.localeCompare(a.date));

  const totalWealth = actH.reduce((s, h) => s + h.balance, 0);
  const income = actT.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const spending = actT.filter(t => t.type === 'spending').reduce((s, t) => s + t.amount, 0);
  const net = Math.max(0, income - spending);

  const fmt = n => `₹${(+n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const now = new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

  // Build rows array
  const rows = [];

  // ── HEADER ──
  rows.push(['JIMIKKI — PERSONAL FINANCE TRACKER', '', '', '', '', '', '']);
  rows.push([`Account: ${email}`, '', '', '', `Last Updated: ${now}`, '', '']);
  rows.push(['', '', '', '', '', '', '']);

  // ── SUMMARY ──
  rows.push(['💰 TOTAL WEALTH', '📈 INCOME', '📉 SPENDING', '💚 NET SAVINGS', '', '', '']);
  rows.push([fmt(totalWealth), fmt(income), fmt(spending), fmt(net), '', '', '']);
  rows.push(['', '', '', '', '', '', '']);

  // ── HOLDINGS ──
  rows.push(['💳 HOLDINGS', '', '', '', '', '', '']);
  rows.push(['Holder Name', 'Balance', 'Primary', '', '', '', '']);
  actH.forEach(h => {
    rows.push([h.name, fmt(h.balance), h.isPrimary ? '⭐ Yes' : 'No', '', '', '', '']);
  });
  if (actH.length === 0) rows.push(['No holders added yet', '', '', '', '', '', '']);
  rows.push(['', '', '', '', '', '', '']);

  // ── SPENDING BY CATEGORY ──
  const actExpB = expBuckets.filter(b => !b.deleted);
  rows.push(['📊 SPENDING BY CATEGORY', '', '', '', '', '', '']);
  rows.push(['Category', 'Total Spent', '% of Total', '', '', '', '']);
  actExpB.forEach(b => {
    const total = actT.filter(t => t.type === 'spending' && t.bucketId === b.id).reduce((s, t) => s + t.amount, 0);
    if (total > 0) {
      const pct = spending > 0 ? ((total / spending) * 100).toFixed(1) + '%' : '0%';
      rows.push([b.name, fmt(total), pct, '', '', '', '']);
    }
  });
  rows.push(['', '', '', '', '', '', '']);

  // ── INCOME BY SOURCE ──
  const actIncB = incBuckets.filter(b => !b.deleted);
  rows.push(['💰 INCOME BY SOURCE', '', '', '', '', '', '']);
  rows.push(['Source', 'Total Received', '% of Total', '', '', '', '']);
  actIncB.forEach(b => {
    const total = actT.filter(t => t.type === 'income' && t.incBucketId === b.id).reduce((s, t) => s + t.amount, 0);
    if (total > 0) {
      const pct = income > 0 ? ((total / income) * 100).toFixed(1) + '%' : '0%';
      rows.push([b.name, fmt(total), pct, '', '', '', '']);
    }
  });
  rows.push(['', '', '', '', '', '', '']);

  // ── MONTHLY SUMMARY ──
  rows.push(['📅 MONTHLY SUMMARY (Last 12 Months)', '', '', '', '', '', '']);
  rows.push(['Month', 'Income', 'Spending', 'Net Savings', '', '', '']);
  const monthsData = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en', { month: 'long', year: 'numeric' });
    const moTxns = actT.filter(t => t.date.slice(0, 7) === ym);
    const moInc = moTxns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
    const moSpd = moTxns.filter(t => t.type === 'spending').reduce((s, t) => s + t.amount, 0);
    const moNet = Math.max(0, moInc - moSpd);
    monthsData.push([label, fmt(moInc), fmt(moSpd), fmt(moNet), '', '', '']);
  }
  monthsData.forEach(r => rows.push(r));
  rows.push(['', '', '', '', '', '', '']);

  // ── ALL TRANSACTIONS ──
  rows.push(['📋 ALL TRANSACTIONS', '', '', '', '', '', '']);
  rows.push(['Date', 'Type', 'Category / Source', 'Note', 'Amount', 'Holder', 'To Holder']);
  if (actT.length === 0) {
    rows.push(['No transactions yet', '', '', '', '', '', '']);
  } else {
    actT.forEach(t => {
      const type = t.type === 'income' ? '⬇️ Income' : t.type === 'spending' ? '⬆️ Spending' : '↔️ Transfer';
      const cat = t.type === 'income'
        ? (incBuckets.find(b => b.id === t.incBucketId)?.name || '')
        : t.type === 'spending'
          ? (expBuckets.find(b => b.id === t.bucketId)?.name || '')
          : 'Transfer';
      const holder = holders.find(h => h.id === t.holderId)?.name || '';
      const toHolder = t.toHolderId ? (holders.find(h => h.id === t.toHolderId)?.name || '') : '';
      const amtStr = t.type === 'income' ? `+${fmt(t.amount)}` : t.type === 'spending' ? `-${fmt(t.amount)}` : fmt(t.amount);
      rows.push([t.date, type, cat, t.note || '', amtStr, holder, toHolder]);
    });
  }

  // ── CLEAR + WRITE DATA ──
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Finance!A1:G1000:clear`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }
  );

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Finance!A1?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows })
    }
  );

  // ── FORMATTING ──
  const txnStartRow = rows.findIndex(r => r[0] === '📋 ALL TRANSACTIONS') + 2; // header row of txns

  const requests = [
    // Sheet tab color
    {
      updateSheetProperties: {
        properties: { sheetId: 0, tabColor: { red: 0.31, green: 0.27, blue: 0.9 } },
        fields: 'tabColor'
      }
    },
    // Main title — row 1
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.31, green: 0.27, blue: 0.9 },
            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 16, bold: true },
            horizontalAlignment: 'CENTER'
          }
        },
        fields: 'userEnteredFormat'
      }
    },
    // Subtitle row 2
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: 1, endRowIndex: 2 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.93, green: 0.93, blue: 0.98 },
            textFormat: { fontSize: 9, italic: true, foregroundColor: { red: 0.39, green: 0.39, blue: 0.55 } }
          }
        },
        fields: 'userEnteredFormat'
      }
    },
    // Summary labels row 4
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 4 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.93, green: 0.93, blue: 0.98 },
            textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 0.31, green: 0.27, blue: 0.9 } },
            horizontalAlignment: 'CENTER'
          }
        },
        fields: 'userEnteredFormat'
      }
    },
    // Summary values row 5
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: 4, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 4 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.31, green: 0.27, blue: 0.9 },
            textFormat: { bold: true, fontSize: 13, foregroundColor: { red: 1, green: 1, blue: 1 } },
            horizontalAlignment: 'CENTER'
          }
        },
        fields: 'userEnteredFormat'
      }
    },
    // Freeze top 2 rows
    {
      updateSheetProperties: {
        properties: { sheetId: 0, gridProperties: { frozenRowCount: 2 } },
        fields: 'gridProperties.frozenRowCount'
      }
    },
    // Column widths
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 160 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 160 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 }, properties: { pixelSize: 200 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 5, endIndex: 6 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 6, endIndex: 7 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } },
  ];

  // Section headers styling (dark purple bg)
  const sectionHeaderRows = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) =>
      r[0] && typeof r[0] === 'string' && (
        r[0].startsWith('💳') || r[0].startsWith('📊') ||
        r[0].startsWith('💰 INCOME') || r[0].startsWith('📅') || r[0].startsWith('📋')
      )
    );

  sectionHeaderRows.forEach(({ i }) => {
    requests.push({
      repeatCell: {
        range: { sheetId: 0, startRowIndex: i, endRowIndex: i + 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.18, green: 0.16, blue: 0.35 },
            textFormat: { bold: true, fontSize: 11, foregroundColor: { red: 1, green: 1, blue: 1 } }
          }
        },
        fields: 'userEnteredFormat'
      }
    });
  });

  // Table header rows (row after section headers)
  const tableHeaderRows = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) =>
      r[0] && (r[0] === 'Holder Name' || r[0] === 'Category' || r[0] === 'Source' ||
        r[0] === 'Month' || r[0] === 'Date')
    );

  tableHeaderRows.forEach(({ i }) => {
    requests.push({
      repeatCell: {
        range: { sheetId: 0, startRowIndex: i, endRowIndex: i + 1 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.93, green: 0.93, blue: 0.98 },
            textFormat: { bold: true, fontSize: 9, foregroundColor: { red: 0.31, green: 0.27, blue: 0.9 } }
          }
        },
        fields: 'userEnteredFormat'
      }
    });
  });

  // Color transaction rows
  if (txnStartRow > 0) {
    actT.forEach((t, idx) => {
      const rowIdx = txnStartRow + idx;
      let bg;
      if (t.type === 'income') bg = { red: 0.88, green: 0.98, blue: 0.91 };
      else if (t.type === 'spending') bg = { red: 1, green: 0.93, blue: 0.93 };
      else bg = { red: 0.9, green: 0.95, blue: 1 };

      requests.push({
        repeatCell: {
          range: { sheetId: 0, startRowIndex: rowIdx, endRowIndex: rowIdx + 1 },
          cell: { userEnteredFormat: { backgroundColor: bg } },
          fields: 'userEnteredFormat'
        }
      });
    });
  }

  // Merge title row A1:G1
  requests.push({
    mergeCells: {
      range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 7 },
      mergeType: 'MERGE_ALL'
    }
  });

  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests })
  });
}

// ── Main export ───────────────────────────────────────────────────────────
export async function syncToSheets(env, email, userData, db) {
  try {
    const token = await getAccessToken(env);

    // Check if sheet already exists for this user
    let sheetId = null;
    try {
      const row = await db.prepare('SELECT sheet_id FROM user_sheets WHERE email = ?').bind(email).first();
      if (row) sheetId = row.sheet_id;
    } catch {
      // table might not exist yet — create it
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS user_sheets (
          email TEXT PRIMARY KEY,
          sheet_id TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `).run();
    }

    // Create sheet if first time
    if (!sheetId) {
      const userName = email.split('@')[0];
      sheetId = await createSheet(token, userName, env.GOOGLE_DRIVE_FOLDER_ID);
      await shareSheet(token, sheetId, email);
      await db.prepare('INSERT OR REPLACE INTO user_sheets (email, sheet_id) VALUES (?, ?)').bind(email, sheetId).run();
    }

    // Rebuild the sheet with latest data
    await rebuildSheet(token, sheetId, { ...userData, email });

    return { sheetId, url: `https://docs.google.com/spreadsheets/d/${sheetId}` };
  } catch (err) {
    console.error('Sheets sync error:', err);
    return null;
  }
}
