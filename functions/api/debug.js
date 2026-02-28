export async function onRequestGet(context) {
  const results = {};

  // Check if GOOGLE_SCRIPT_URL exists
  results.has_script_url = !!context.env.GOOGLE_SCRIPT_URL;
  results.script_url_preview = context.env.GOOGLE_SCRIPT_URL
    ? context.env.GOOGLE_SCRIPT_URL.slice(0, 60) + '...'
    : 'MISSING ❌';

  // Try calling the script with test data
  if (context.env.GOOGLE_SCRIPT_URL) {
    try {
      const res = await fetch(context.env.GOOGLE_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@gmail.com',
          holders: [{ id: 'h1', name: 'Test Wallet', balance: 5000, isPrimary: true, deleted: false }],
          transactions: [
            { id: 't1', type: 'income', amount: 10000, note: 'Test Salary', incBucketId: 'i1', holderId: 'h1', date: '2026-02-28', deleted: false },
            { id: 't2', type: 'spending', amount: 2000, note: 'Test Food', bucketId: 'b1', holderId: 'h1', date: '2026-02-28', deleted: false }
          ],
          expBuckets: [
            { id: 'b1', name: 'Food & Dining', color: '#F97316', deleted: false },
            { id: 'b2', name: 'Shopping', color: '#A855F7', deleted: false }
          ],
          incBuckets: [
            { id: 'i1', name: 'Salary', color: '#10B981', deleted: false },
            { id: 'i2', name: 'Freelance', color: '#6366F1', deleted: false }
          ]
        })
      });

      const text = await res.text();
      results.script_response_status = res.status;
      results.script_response = text.slice(0, 500);

      try {
        const json = JSON.parse(text);
        results.script_ok = json.ok;
        results.sheet_url = json.url || null;
        results.script_error = json.error || null;
      } catch {
        results.parse_error = 'Response is not JSON';
      }

    } catch (e) {
      results.fetch_error = e.message;
    }
  }

  // Check DB table
  try {
    const row = await context.env.DB.prepare('SELECT COUNT(*) as c FROM user_sheets').first();
    results.user_sheets_table = 'EXISTS ✅ rows=' + row.c;
  } catch (e) {
    results.user_sheets_table = 'MISSING ❌ ' + e.message;
  }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { 'Content-Type': 'application/json' }
  });
}
