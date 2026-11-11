import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { DATABASE_SCHEMA_SQL, encodeBase58 } from '../backend.mjs';
import { AUTH_SCHEMA_SQL, handleSessionApi } from './session.mjs';

const ORIGIN = 'https://rate-radar.test';
const b64 = (value) => Buffer.from(value).toString('base64');
const sha256 = async (value) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  sqlite.exec(DATABASE_SCHEMA_SQL + AUTH_SCHEMA_SQL);
  const prepare = (sql) => {
    let values = [];
    return {
      bind(...items) { values = items; return this; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
    };
  };
  return {
    sqlite, prepare,
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}
async function wallet() {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const address = encodeBase58(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  return { address, sign: async (message) => b64(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(message))) };
}
function fixture(t, overrides = {}) {
  const DB = database();
  t.after(() => DB.sqlite.close());
  const env = { DB, HELIUS_API_KEY: 'provider-secret', RECEIPT_ENCRYPTION_KEY: b64(crypto.getRandomValues(new Uint8Array(32))), RINGS_NETWORK: 'devnet', RINGS_USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', ...overrides };
  function browser(clientAddress = '192.0.2.1') {
    const jar = new Map();
    const cookieHeader = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
    const api = async (path, { method = 'GET', body, headers = {}, origin = ORIGIN, urlOrigin = ORIGIN } = {}) => {
      const requestHeaders = new Headers({ ...(cookieHeader() ? { Cookie: cookieHeader() } : {}), ...(method !== 'GET' && origin ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers });
      const request = new Request(`${urlOrigin}${path}`, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const response = await handleSessionApi(request, env, { clientAddress });
      for (const item of response.headers.getSetCookie()) {
        const pair = item.split(';')[0];
        const index = pair.indexOf('=');
        const name = pair.slice(0, index), value = pair.slice(index + 1);
        if (item.includes('Max-Age=0')) jar.delete(name); else jar.set(name, value);
      }
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    const start = async (owner) => {
      const result = await api('/api/wallet/challenge', { method: 'POST', body: { wallet: owner.address } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    };
    const login = async (owner) => {
      const challenge = await start(owner);
      const result = await api('/api/wallet/verify', { method: 'POST', body: { challengeId: challenge.challengeId, signature: await owner.sign(challenge.message) } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result;
    };
    return { api, jar, cookieHeader, start, login };
  }
  return { DB, env, browser };
}

test('auth migration matches the exported schema and keeps expired challenge cleanup compatible', async (t) => {
  assert.equal((await readFile(new URL('./auth-schema.sql', import.meta.url), 'utf8')).trim(), AUTH_SCHEMA_SQL.trim());
  const f = fixture(t); const user = f.browser(); const owner = await wallet();
  const pending = await user.start(owner);
  f.DB.sqlite.prepare('DELETE FROM challenges WHERE id=?').run(pending.challengeId);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_login_challenges').get().count, 0);
});

test('forged host identity headers never authenticate an anonymous request', async (t) => {
  const f = fixture(t); const user = f.browser();
  const headers = { 'oai-authenticated-user-id': 'attacker', 'oai-authenticated-user-email': 'victim@example.test' };
  const config = await user.api('/api/config', { headers });
  assert.equal(config.status, 200);
  assert.equal(config.body.authMode, 'wallet-session');
  assert.equal(config.body.walletLoginEnabled, true);
  assert.equal(config.body.authenticated, false);
  assert.equal(config.body.wallet, null);
  assert.equal(config.body.sessionExpiresAt, null);
  assert.equal((await user.api('/api/deals', { headers })).status, 401);
  assert(!JSON.stringify(config.body).includes(f.env.HELIUS_API_KEY));
});

test('only a real wallet signature issues a secure opaque session; raw session and browser tokens are never stored', async (t) => {
  const f = fixture(t); const user = f.browser(); const owner = await wallet(); const stranger = await wallet();
  const pending = await user.start(owner);
  assert.match(pending.message, /Action: Sign in to Rate Radar with this wallet/);
  assert.match(pending.message, /URI: https:\/\/rate-radar.test/);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get().count, 0);
  const nonce = user.jar.get('__Host-rr_login');
  assert.equal(f.DB.sqlite.prepare('SELECT browser_nonce_hash FROM auth_login_challenges WHERE challenge_id=?').get(pending.challengeId).browser_nonce_hash, await sha256(nonce));
  const invalid = await user.api('/api/wallet/verify', { method: 'POST', body: { challengeId: pending.challengeId, signature: await stranger.sign(pending.message) } });
  assert.equal(invalid.status, 401);
  assert.equal(user.jar.has('__Host-rr_session'), false);
  const result = await user.api('/api/wallet/verify', { method: 'POST', body: { challengeId: pending.challengeId, signature: await owner.sign(pending.message) } });
  assert.equal(result.status, 200);
  assert.equal(result.body.authenticated, true);
  const sessionCookie = result.headers.getSetCookie().find((value) => value.startsWith('__Host-rr_session='));
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/', 'Max-Age=604800']) assert(sessionCookie.includes(flag));
  assert(!sessionCookie.includes('Domain='));
  assert.equal(user.jar.has('__Host-rr_login'), false);
  const token = user.jar.get('__Host-rr_session');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert(!JSON.stringify(result.body).includes(token));
  const stored = f.DB.sqlite.prepare('SELECT * FROM auth_sessions').get();
  assert.equal(stored.token_hash, await sha256(token));
  assert.equal(stored.expires_at - stored.created_at, 7 * 24 * 60 * 60 * 1000);
  assert(!JSON.stringify(stored).includes(token));
  const config = await user.api('/api/config', { headers: { 'oai-authenticated-user-id': 'forged-user' } });
  assert.equal(config.body.wallet, owner.address);
  assert.equal(config.body.authenticated, true);
  assert.equal(config.body.identity, stored.identity_id);
});

test('login signatures cannot be transferred to another browser or origin, or replayed', async (t) => {
  const f = fixture(t); const one = f.browser(); const two = f.browser('192.0.2.2'); const owner = await wallet();
  const pending = await one.start(owner);
  const body = { challengeId: pending.challengeId, signature: await owner.sign(pending.message) };
  assert.equal((await two.api('/api/wallet/verify', { method: 'POST', body })).status, 403);
  await two.start(owner);
  assert.equal((await two.api('/api/wallet/verify', { method: 'POST', body })).status, 403);
  assert.equal((await one.api('/api/wallet/verify', { method: 'POST', body, origin: 'https://attacker.test' })).status, 403);
  const originalCookies = one.cookieHeader();
  assert.equal((await one.api('/api/wallet/verify', { method: 'POST', body })).status, 200);
  assert.equal((await one.api('/api/wallet/verify', { method: 'POST', body, headers: { Cookie: originalCookies } })).status, 403);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get().count, 1);
});

test('concurrent verification of one signature creates at most one session', async (t) => {
  const f = fixture(t); const user = f.browser(); const owner = await wallet();
  const pending = await user.start(owner);
  const body = { challengeId: pending.challengeId, signature: await owner.sign(pending.message) };
  const cookies = user.cookieHeader();
  const results = await Promise.all([user.api('/api/wallet/verify', { method: 'POST', body, headers: { Cookie: cookies } }), user.api('/api/wallet/verify', { method: 'POST', body, headers: { Cookie: cookies } })]);
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get().count, 1);
});

test('login reuses wallet ownership across devices and migrated identities; logout revokes only the current session', async (t) => {
  const f = fixture(t); const one = f.browser(); const two = f.browser('192.0.2.2'); const owner = await wallet();
  f.DB.sqlite.prepare('INSERT INTO wallet_links(identity_id,wallet,linked_at) VALUES(?,?,?)').run('migrated-sites-owner', owner.address, new Date().toISOString());
  await one.login(owner); await two.login(owner);
  assert.equal((await one.api('/api/config')).body.identity, 'migrated-sites-owner');
  assert.equal((await two.api('/api/config')).body.identity, 'migrated-sites-owner');
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM wallet_links').get().count, 1);
  const revoked = one.cookieHeader();
  const logout = await one.api('/api/session/logout', { method: 'POST', body: {} });
  assert.equal(logout.body.loggedOut, true);
  assert(logout.headers.getSetCookie().every((value) => value.includes('Max-Age=0')));
  assert.equal((await one.api('/api/config', { headers: { Cookie: revoked } })).body.authenticated, false);
  assert.equal((await one.api('/api/deals', { headers: { Cookie: revoked } })).status, 401);
  assert.equal((await two.api('/api/config')).body.authenticated, true);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM wallet_links').get().count, 1);
  assert.equal((await one.api('/api/session/logout', { method: 'POST', body: {} })).status, 200);
});

test('sessions expire, duplicate cookies fail closed, and successful re-login rotates the existing token', async (t) => {
  const f = fixture(t); const user = f.browser(); const owner = await wallet();
  await user.login(owner);
  const old = user.jar.get('__Host-rr_session');
  assert.equal((await user.api('/api/config', { headers: { Cookie: `__Host-rr_session=${old}; __Host-rr_session=${old}` } })).body.authenticated, false);
  await user.login(owner);
  assert.notEqual(user.jar.get('__Host-rr_session'), old);
  assert.equal((await user.api('/api/config', { headers: { Cookie: `__Host-rr_session=${old}` } })).body.authenticated, false);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get().count, 1);
  f.DB.sqlite.prepare('UPDATE auth_sessions SET expires_at=?').run(Date.now() - 1);
  assert.equal((await user.api('/api/config')).body.authenticated, false);
  assert.equal((await user.api('/api/deals')).status, 401);
});

test('challenge expiry, origin checks, body limits, and method restrictions run before authentication', async (t) => {
  const f = fixture(t); const user = f.browser(); const owner = await wallet();
  for (const path of ['/api/wallet/challenge', '/api/wallet/verify', '/api/session/logout']) {
    assert.equal((await user.api(path)).status, 405);
    assert.equal((await user.api(path, { method: 'POST', body: {}, origin: null })).status, 403);
    assert.equal((await user.api(path, { method: 'POST', body: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  }
  assert.equal((await user.api('/api/wallet/challenge', { method: 'POST', body: { wallet: owner.address, padding: 'x'.repeat(5000) } })).status, 413);
  const pending = await user.start(owner);
  f.DB.sqlite.prepare('UPDATE auth_login_challenges SET expires_at=0 WHERE challenge_id=?').run(pending.challengeId);
  assert.equal((await user.api('/api/wallet/verify', { method: 'POST', body: { challengeId: pending.challengeId, signature: await owner.sign(pending.message) } })).status, 403);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get().count, 0);
});

test('durable login limits use the trusted host address, not forged forwarded headers', async (t) => {
  const f = fixture(t); const user = f.browser('192.0.2.123');
  for (let index = 0; index < 30; index++) {
    const result = await user.api('/api/wallet/challenge', { method: 'POST', body: { wallet: encodeBase58(crypto.getRandomValues(new Uint8Array(32))) }, headers: { 'X-Forwarded-For': `198.51.100.${index}` } });
    assert.equal(result.status, 200);
  }
  const rejected = await user.api('/api/wallet/challenge', { method: 'POST', body: { wallet: encodeBase58(crypto.getRandomValues(new Uint8Array(32))) }, headers: { 'X-Forwarded-For': '203.0.113.1' } });
  assert.equal(rejected.status, 429);
  const rows = f.DB.sqlite.prepare('SELECT * FROM auth_rate_limits').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 31);
  assert(!rows[0].bucket.includes('192.0.2.123'));
});

test('HTTPS and configured origins are enforced; local insecure cookies require an explicit loopback flag', async (t) => {
  const f = fixture(t); const user = f.browser();
  assert.equal((await user.api('/api/config', { urlOrigin: 'http://rate-radar.test' })).status, 503);
  assert.equal((await user.api('/api/config', { urlOrigin: 'http://localhost:3000' })).status, 503);
  f.env.AUTH_ALLOW_INSECURE_LOCALHOST = 'true';
  assert.equal((await user.api('/api/config', { urlOrigin: 'http://localhost:3000' })).status, 200);
  const owner = await wallet();
  const challenge = await user.api('/api/wallet/challenge', { method: 'POST', body: { wallet: owner.address }, urlOrigin: 'http://localhost:3000', origin: 'http://localhost:3000' });
  assert.equal(challenge.status, 200);
  assert(challenge.headers.getSetCookie()[0].startsWith('rr_dev_login='));
  assert(!challenge.headers.getSetCookie()[0].includes('; Secure'));
  assert.equal((await user.api('/api/config', { urlOrigin: 'http://public.example.test' })).status, 503);
  f.env.AUTH_ALLOWED_ORIGINS = ORIGIN;
  assert.equal((await user.api('/api/config', { urlOrigin: 'https://attacker.test' })).status, 403);
  assert.equal((await user.api('/api/config')).status, 200);
});

test('missing database or trusted client address disables login without authenticating config', async (t) => {
  const f = fixture(t); const owner = await wallet(); const noAddress = f.browser(null);
  assert.equal((await noAddress.api('/api/wallet/challenge', { method: 'POST', body: { wallet: owner.address } })).status, 503);
  f.env.DB = undefined;
  const config = await noAddress.api('/api/config');
  assert.equal(config.body.authenticated, false);
  assert.equal(config.body.walletLoginEnabled, false);
  assert.equal((await noAddress.api('/api/wallet/challenge', { method: 'POST', body: { wallet: owner.address } })).status, 503);
});

test('wallet sessions authorize party access while agreement approval still requires a fresh signature', async (t) => {
  const f = fixture(t); const brand = await wallet(); const creator = await wallet(); const payer = f.browser(); const payee = f.browser('192.0.2.2');
  await payer.login(brand); await payee.login(creator);
  const created = await payer.api('/api/deals', { method: 'POST', body: { title: 'Vercel sponsorship', brandWallet: brand.address, creatorWallet: creator.address, amount: '12', category: 'X post', usage: 'Organic only', deadline: '2027-01-01', notes: '' } });
  assert.equal(created.status, 201);
  const deal = created.body.deal;
  assert.equal((await payee.api(`/api/deals/${deal.id}`)).status, 200);
  for (const [browser, owner] of [[payer, brand], [payee, creator]]) {
    const challenge = await browser.api(`/api/deals/${deal.id}/approval-challenge`, { method: 'POST', body: {} });
    assert.equal(challenge.status, 200);
    assert.equal((await browser.api(`/api/deals/${deal.id}/approve`, { method: 'POST', body: { challengeId: challenge.body.challengeId, signature: '' } })).status, 401);
    const approved = await browser.api(`/api/deals/${deal.id}/approve`, { method: 'POST', body: { challengeId: challenge.body.challengeId, signature: await owner.sign(challenge.body.message) } });
    assert.equal(approved.status, 200);
  }
  assert.equal((await payer.api(`/api/deals/${deal.id}`)).body.deal.status, 'ready');
});
