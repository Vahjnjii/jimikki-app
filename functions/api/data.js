export async function onRequestGet(context) {
  const email = context.request.headers.get('Cf-Access-Authenticated-User-Email');
  if (!email) return new Response('Unauthorized', { status: 401 });

  try {
    const row = await context.env.DB.prepare(
      'SELECT data FROM user_data WHERE email = ?'
    ).bind(email).first();

    if (!row) {
      return new Response(JSON.stringify({
        email,
        holders: [],
        transactions: [],
        expBuckets: null,
        incBuckets: null
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    const data = JSON.parse(row.data);
    return new Response(JSON.stringify({ email, ...data }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response('Server error', { status: 500 });
  }
}

export async function onRequestPost(context) {
  const email = context.request.headers.get('Cf-Access-Authenticated-User-Email');
  if (!email) return new Response('Unauthorized', { status: 401 });

  try {
    const body = await context.request.text();
    JSON.parse(body); // validate JSON before saving

    await context.env.DB.prepare(
      'INSERT OR REPLACE INTO user_data (email, data, updated_at) VALUES (?, ?, datetime("now"))'
    ).bind(email, body).run();

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response('Server error', { status: 500 });
  }
}
