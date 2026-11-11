import { handleApi } from './backend.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // A hosted Sites deployment supplies identity at its authenticated edge.
    // Local identity emulation is opt-in, loopback-only, and never a built-in fallback.
    if (env.LOCAL_DEV_AUTH === 'true' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      const headers = new Headers(request.headers);
      for (const key of [...headers.keys()]) if (key.startsWith('oai-authenticated-user-')) headers.delete(key);
      headers.set('oai-authenticated-user-id', 'rate-radar-local');
      headers.set('oai-authenticated-user-email', 'local@rate-radar.invalid');
      request = new Request(request, { headers });
    }
    let response;
    if (url.pathname.startsWith('/api/')) {
      response = await handleApi(request, env);
    } else {
      response = await env.ASSETS.fetch(request);
    }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (url.pathname.startsWith('/api/')) headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};
