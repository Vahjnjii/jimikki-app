function b64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64 + '='.repeat((4 - b64.length % 4) % 4);
  return atob(pad);
}

function b64Encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

export async function onRequestGet(context) {
  try {
    const { searchParams } = new URL(context.request.url);
    const code = searchParams.get('code');
    if (!code) return Response.redirect('/?error=no_code', 302);

    if (!context.env.GOOGLE_CLIENT_SECRET || !context.env.SESSION_SECRET) {
      return new Response('Missing env vars: GOOGLE_CLIENT_SECRET or SESSION_SECRET', { status: 500 });
    }

    // Exchange code for tokens
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
    if (!tokens.id_token) {
      return new Response('Token error: ' + JSON.stringify(tokens), { status: 500 });
    }

    // Decode JWT payload to get email
    const payload = JSON.parse(b64urlDecode(tokens.id_token.split('.')[1]));
    const email = payload.email;
    if (!email) return Response.redirect('/?error=no_email', 302);

    // Build signed session cookie
    const sessionData = b64Encode(JSON.stringify({
      email,
      exp: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 days
    }));

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(context.env.SESSION_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sigBuf = await crypto.subtle.sign(
      'HMAC', key, new TextEncoder().encode(sessionData)
    );
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
    const cookieVal = `${sessionData}.${sigB64}`;

    return new Response(null, {
      status: 302,
      headers: {
        Location: '/',
        'Set-Cookie': `jimikki_session=${cookieVal}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`
      }
    });
  } catch (e) {
    return new Response('Callback error: ' + e.message, { status: 500 });
  }
}
