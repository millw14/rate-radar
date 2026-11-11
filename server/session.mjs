/** Host-independent wallet sessions. Call this instead of exposing handleApi directly. */
import { decodeBase58, handleApi } from '../backend.mjs';

export const AUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS auth_login_challenges (
  challenge_id TEXT PRIMARY KEY REFERENCES challenges(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  browser_nonce_hash TEXT NOT NULL,
  origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_login_expiry_idx ON auth_login_challenges(expires_at);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES wallet_links(identity_id) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_session_expiry_idx ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_expiry_idx ON auth_rate_limits(expires_at);
`;

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_SECONDS = 5 * 60;
const MAX_LOGIN_BODY = 4096;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE_PATTERN = /^[a-f0-9-]{36}$/;
const query = (db, sql, ...values) => db.prepare(sql).bind(...values);
const first = (db, sql, ...values) => query(db, sql, ...values).first();
const run = (db, sql, ...values) => query(db, sql, ...values).run();
const changed = (result) => Number(result?.meta?.changes ?? result?.changes ?? 0);

class SessionError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new SessionError(status, code, message); };
const json = (body, status = 200, extraHeaders) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extraHeaders },
});
async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function randomToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function requestContext(request, env) {
  const url = new URL(request.url);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && env.AUTH_ALLOW_INSECURE_LOCALHOST === 'true';
  if (url.protocol !== 'https:' && !local) fail(503, 'HTTPS_REQUIRED', 'Wallet sessions require a secure HTTPS connection.');
  if (env.AUTH_ALLOWED_ORIGINS) {
    const allowed = String(env.AUTH_ALLOWED_ORIGINS).split(',').map((value) => value.trim()).filter(Boolean);
    if (!allowed.length || allowed.some((value) => { try { return new URL(value).origin !== value.replace(/\/$/, ''); } catch { return true; } })) fail(503, 'INVALID_AUTH_ORIGIN', 'The wallet sign-in origin is not configured correctly.');
    if (!allowed.some((value) => value.replace(/\/$/, '') === url.origin)) fail(403, 'ORIGIN_REJECTED', 'This origin is not authorized for wallet sign-in.');
  }
  return { origin: url.origin, local, sessionCookie: local ? 'rr_dev_session' : '__Host-rr_session', loginCookie: local ? 'rr_dev_login' : '__Host-rr_login' };
}
function requireSameOrigin(request, context) {
  if (request.headers.get('origin') !== context.origin || request.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'ORIGIN_REJECTED', 'This action must come from this Rate Radar workspace.');
}
function cookieValue(request, name) {
  const matches = (request.headers.get('cookie') || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  // Ambiguous duplicate cookies can result from cookie tossing; never choose one.
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return TOKEN_PATTERN.test(value) ? value : null;
}
function cookie(name, value, seconds, context) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${context.local ? '' : '; Secure'}`;
}
function withCookies(response, values) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  for (const value of values) headers.append('Set-Cookie', value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function internalRequest(request, identity, body) {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith('oai-')) headers.delete(name);
  // Identity may only come from a verified durable session or the private login flow.
  if (identity) headers.set('oai-authenticated-user-id', identity);
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    headers.delete('Content-Length');
    return new Request(request.url, { method: request.method, headers, body: JSON.stringify(body) });
  }
  return new Request(request, { headers });
}
async function loginBody(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) fail(415, 'CONTENT_TYPE', 'Send an application/json request.');
  if (Number(request.headers.get('content-length') || 0) > MAX_LOGIN_BODY) fail(413, 'BODY_TOO_LARGE', 'The sign-in request is too large.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'INVALID_JSON', 'Send a JSON object.');
  let length = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_LOGIN_BODY) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', 'The sign-in request is too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const value of chunks) { bytes.set(value, offset); offset += value.length; }
  let body;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'INVALID_JSON', 'Send a valid JSON object.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_JSON', 'Send a JSON object.');
  return body;
}
async function limitLogin(env, dependencies, action, context) {
  // The host adapter supplies an address from its trusted platform API. Raw forwarded
  // headers are deliberately ignored because a caller can forge them on some hosts.
  const client = dependencies.clientAddress || (context.local ? 'local-loopback' : null);
  if (typeof client !== 'string' || !client || client.length > 256) fail(503, 'CLIENT_ADDRESS_UNAVAILABLE', 'Wallet sign-in is temporarily unavailable.');
  const milliseconds = 10 * 60 * 1000;
  const window = Math.floor(Date.now() / milliseconds);
  const bucket = `wallet-login:${action}:${await digest(client)}:${window}`;
  const row = await query(env.DB, 'INSERT INTO auth_rate_limits(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count', bucket, (window + 1) * milliseconds).first();
  if (row.count > (action === 'challenge' ? 30 : 60)) fail(429, 'RATE_LIMITED', 'Too many wallet sign-in attempts. Try again later.');
  await run(env.DB, 'DELETE FROM auth_rate_limits WHERE expires_at<?', Date.now() - milliseconds);
}
async function sessionFor(request, env, context) {
  const token = cookieValue(request, context.sessionCookie);
  if (!token || !env.DB) return null;
  return first(env.DB, 'SELECT s.identity_id,s.wallet,s.expires_at FROM auth_sessions s JOIN wallet_links w ON w.identity_id=s.identity_id AND w.wallet=s.wallet WHERE s.token_hash=? AND s.expires_at>?', await digest(token), Date.now());
}
async function challenge(request, env, dependencies, context) {
  await limitLogin(env, dependencies, 'challenge', context);
  const body = await loginBody(request);
  try { if (decodeBase58(body.wallet).length !== 32) throw new Error('Invalid wallet'); }
  catch { fail(400, 'INVALID_WALLET', 'Enter a valid Solana wallet address.'); }
  // Reuse migrated wallet links as well as sessions from any other device.
  const existing = await first(env.DB, 'SELECT identity_id FROM wallet_links WHERE wallet=?', body.wallet);
  const identity = existing?.identity_id || `wallet:${await digest(body.wallet)}`;
  const response = await handleApi(internalRequest(request, identity, { wallet: body.wallet }), env, dependencies.backendDependencies);
  if (!response.ok) return response;
  const result = await response.json();
  const nonce = randomToken();
  const nonceHash = await digest(nonce);
  const timestamp = Date.now();
  const expires = Date.parse(result.expiresAt);
  if (!CHALLENGE_PATTERN.test(result.challengeId || '') || !Number.isFinite(expires) || expires <= timestamp || expires > timestamp + LOGIN_SECONDS * 1000 || typeof result.message !== 'string') fail(503, 'INVALID_LOGIN_CHALLENGE', 'Could not prepare wallet sign-in.');
  const message = result.message.replace('Action: Link this wallet to your signed-in Rate Radar account', 'Action: Sign in to Rate Radar with this wallet');
  if (message === result.message) fail(503, 'INVALID_LOGIN_CHALLENGE', 'Could not prepare wallet sign-in.');
  const stored = await env.DB.batch([
    query(env.DB, "UPDATE challenges SET message=? WHERE id=? AND identity_id=? AND purpose='wallet' AND consumed_at IS NULL", message, result.challengeId, identity),
    query(env.DB, 'INSERT INTO auth_login_challenges(challenge_id,identity_id,wallet,browser_nonce_hash,origin,expires_at,created_at) VALUES(?,?,?,?,?,?,?)', result.challengeId, identity, body.wallet, nonceHash, context.origin, expires, timestamp),
  ]);
  if (changed(stored[0]) !== 1) fail(503, 'INVALID_LOGIN_CHALLENGE', 'Could not prepare wallet sign-in.');
  return withCookies(json({ ...result, message }), [cookie(context.loginCookie, nonce, LOGIN_SECONDS, context)]);
}
async function verify(request, env, dependencies, context) {
  await limitLogin(env, dependencies, 'verify', context);
  const body = await loginBody(request);
  const nonce = cookieValue(request, context.loginCookie);
  if (!nonce || !CHALLENGE_PATTERN.test(body.challengeId || '')) fail(403, 'LOGIN_BROWSER_MISMATCH', 'Request and sign a new wallet message in this browser.');
  const nonceHash = await digest(nonce);
  const login = await first(env.DB, 'SELECT * FROM auth_login_challenges WHERE challenge_id=? AND browser_nonce_hash=? AND origin=? AND consumed_at IS NULL AND expires_at>?', body.challengeId, nonceHash, context.origin, Date.now());
  if (!login) fail(403, 'INVALID_LOGIN_CHALLENGE', 'This browser sign-in request expired or was already used. Request another.');
  const response = await handleApi(internalRequest(request, login.identity_id, { challengeId: login.challenge_id, signature: body.signature }), env, dependencies.backendDependencies);
  if (!response.ok) return response;
  const verified = await response.json();
  if (verified.wallet !== login.wallet) fail(503, 'LOGIN_VERIFICATION_FAILED', 'The verified wallet did not match this sign-in request.');
  const token = randomToken();
  const tokenHash = await digest(token);
  const timestamp = Date.now();
  const expires = timestamp + SESSION_SECONDS * 1000;
  const oldToken = cookieValue(request, context.sessionCookie);
  const statements = [
    query(env.DB, 'INSERT INTO auth_sessions(token_hash,identity_id,wallet,created_at,expires_at) SELECT ?,identity_id,wallet,?,? FROM auth_login_challenges WHERE challenge_id=? AND browser_nonce_hash=? AND consumed_at IS NULL AND expires_at>?', tokenHash, timestamp, expires, login.challenge_id, nonceHash, timestamp),
    query(env.DB, 'UPDATE auth_login_challenges SET consumed_at=? WHERE challenge_id=? AND browser_nonce_hash=? AND consumed_at IS NULL AND expires_at>?', timestamp, login.challenge_id, nonceHash, timestamp),
  ];
  if (oldToken) statements.push(query(env.DB, 'DELETE FROM auth_sessions WHERE token_hash=?', await digest(oldToken)));
  const stored = await env.DB.batch(statements);
  if (changed(stored[0]) !== 1 || changed(stored[1]) !== 1) fail(409, 'LOGIN_CHALLENGE_USED', 'This sign-in request expired or was already used. Request another.');
  await env.DB.batch([
    query(env.DB, 'DELETE FROM auth_sessions WHERE expires_at<?', timestamp),
    query(env.DB, 'DELETE FROM auth_login_challenges WHERE expires_at<?', timestamp),
  ]);
  return withCookies(json({ wallet: verified.wallet, authenticated: true, sessionExpiresAt: new Date(expires).toISOString() }), [cookie(context.sessionCookie, token, SESSION_SECONDS, context), cookie(context.loginCookie, '', 0, context)]);
}

/** dependencies.clientAddress must come from the host's trusted request/IP API. */
export async function handleSessionApi(request, env, dependencies = {}) {
  try {
    const context = requestContext(request, env);
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    const loginRoute = path === '/api/wallet/challenge' || path === '/api/wallet/verify';
    const logoutRoute = path === '/api/session/logout';
    if (loginRoute || logoutRoute) {
      if (request.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST for wallet sign-in or sign-out.' } }, 405, { Allow: 'POST' });
      requireSameOrigin(request, context);
      if (!env.DB) fail(503, 'DATABASE_NOT_CONFIGURED', 'Wallet sign-in is not configured.');
      if (path === '/api/wallet/challenge') return await challenge(request, env, dependencies, context);
      if (path === '/api/wallet/verify') return await verify(request, env, dependencies, context);
      const token = cookieValue(request, context.sessionCookie);
      if (token) await run(env.DB, 'DELETE FROM auth_sessions WHERE token_hash=?', await digest(token));
      return withCookies(json({ loggedOut: true }), [cookie(context.sessionCookie, '', 0, context), cookie(context.loginCookie, '', 0, context)]);
    }
    const session = await sessionFor(request, env, context);
    const response = await handleApi(internalRequest(request, session?.identity_id), env, dependencies.backendDependencies);
    if (path === '/api/config' && request.method === 'GET' && response.ok) {
      const config = await response.json();
      return json({ ...config, authMode: 'wallet-session', walletLoginEnabled: Boolean(env.DB), sessionExpiresAt: session ? new Date(session.expires_at).toISOString() : null });
    }
    return response;
  } catch (error) {
    if (error instanceof SessionError) return json({ error: { code: error.code, message: error.message } }, error.status);
    return json({ error: { code: 'SESSION_UNAVAILABLE', message: 'Wallet sign-in is temporarily unavailable. Please try again.' } }, 503);
  }
}
