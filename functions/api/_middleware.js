async function getEmail(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/jimikki_session=([^;]+)/);
  if (!match) return null;
  const parts = match[1].split('.');
  if (parts.length !== 2) return null;
  const [data, sigB64] = parts;
  try {
    const key = await crypto.subtle.importKey('raw',
      new TextEncoder().encode(env.SESSION_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) return null;
    const { email, exp } = JSON.parse(atob(data));
    if (Date.now() > exp) return null;
    return email;
  } catch { return null; }
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.pathname.startsWith('/api/auth/')) return context.next();
  const email = await getEmail(context.request, context.env);
  if (!email) return new Response(JSON.stringify({ error: 'unauthenticated' }), {
    status: 401, headers: { 'Content-Type': 'application/json' }
  });
  context.data.email = email;
  return context.next();
}
