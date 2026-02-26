export async function onRequestGet(context) {
  const { searchParams } = new URL(context.request.url);
  const code = searchParams.get('code');
  if (!code) return Response.redirect('/', 302);

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: '491563045638-ro331pkasoe96o2jfhrd33v6l587vrf4.apps.googleusercontent.com',
        client_secret: context.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: 'https://jimikki-app.pages.dev/api/auth/callback',
        grant_type: 'authorization_code'
      })
    });

    const tokens = await tokenRes.json();
    if (!tokens.id_token) return Response.redirect('/?error=auth_failed', 302);

    const b64 = tokens.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { email } = JSON.parse(atob(b64));
    if (!email) return Response.redirect('/?error=no_email', 302);

    const sessionData = btoa(JSON.stringify({
      email, exp: Date.now() + 30 * 24 * 60 * 60 * 1000
    }));
    const key = await crypto.subtle.importKey('raw',
      new TextEncoder().encode(context.env.SESSION_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(sessionData));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': `jimikki_session=${sessionData}.${sigB64}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`
      }
    });
  } catch { return Response.redirect('/?error=server_error', 302); }
}
