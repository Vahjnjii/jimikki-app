export async function onRequestGet() {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', '491563045638-ro331pkasoe96o2jfhrd33v6l587vrf4.apps.googleusercontent.com');
  url.searchParams.set('redirect_uri', 'https://jimikki-app.pages.dev/api/auth/callback');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('prompt', 'select_account');
  return Response.redirect(url.toString(), 302);
}
