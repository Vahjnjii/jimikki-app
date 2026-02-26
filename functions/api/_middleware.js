async function getEmail(request, env) {
  try {
    if (!env.SESSION_SECRET) return null;
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(/jimikki_session=([^;]+)/);
    if (!match) return null;
    const val = decodeURIComponent(match[1]);
    const dot = val.lastIndexOf('.');
    if (dot === -1) return null;
    const data = val.slice(0, dot);
    const sigB64 = val.slice(dot + 1);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.SESSION_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify(
      'HMAC', key, sigBytes, new TextEncoder().encode(data)
    );
    if (!valid) return null;
    const json = JSON.parse(atob(data));
    if (!json.email || Date.now() > json.exp) return null;
    return json.email;
  } catch (e) {
    return null;
  }
}

export async function onRequest(context) {
  try {
    const url = new URL(context.request.url);
    // Let auth routes through without session check
    if (url.pathname.startsWith('/api/auth/')) return context.next();
    const email = await getEmail(context.request, context.env);
    if (!email) {
      return new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    context.data.email = email;
    return context.next();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'middleware_error', msg: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
