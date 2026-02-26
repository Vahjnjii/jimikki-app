export async function onRequestGet(context) {
  try {
    const email = context.data.email;
    const row = await context.env.DB.prepare(
      'SELECT data FROM user_data WHERE email = ?'
    ).bind(email).first();
    if (!row) {
      return new Response(JSON.stringify({
        email, holders: [], transactions: [], expBuckets: null, incBuckets: null
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ email, ...JSON.parse(row.data) }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function onRequestPost(context) {
  try {
    const email = context.data.email;
    const body = await context.request.text();
    JSON.parse(body); // validate
    await context.env.DB.prepare(
      'INSERT OR REPLACE INTO user_data (email, data, updated_at) VALUES (?, ?, datetime("now"))'
    ).bind(email, body).run();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
