import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createClient } from '@libsql/client/sqlite3';
import { createD1Database, createTursoClient } from './database.mjs';
import { applyMigrations, readMigrationSources } from '../scripts/migrate-vercel.mjs';
import { encodeBase58 } from '../backend.mjs';
import { handleSessionApi } from './session.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rate-radar-db-'));
  const client = createClient({ url: `file:${join(directory, 'test.db')}`, intMode: 'bigint' });
  t.after(async () => { client.close(); await rm(directory, { recursive: true, force: true }); });
  const DB = createD1Database(client);
  await client.execute('CREATE TABLE money (id TEXT PRIMARY KEY, amount TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, note TEXT)');
  return { DB, client };
}

const migration = (name, sql) => ({ name, sql, sha256: createHash('sha256').update(sql).digest('hex') });

test('prepared statements preserve exact money and bound parameters without shared mutation', async (t) => {
  const { DB } = await fixture(t);
  const insert = DB.prepare('INSERT INTO money(id,amount,note) VALUES(?,?,?)');
  const amount = '18446744073709551615';
  const maliciousText = "'); DROP TABLE money; --";
  const first = insert.bind('one', amount, maliciousText);
  const second = insert.bind('two', '0.000001', null);
  const results = await DB.batch([first, second]);
  assert.deepEqual(results.map((result) => result.meta.changes), [1, 1]);
  assert.equal(results[0].success, true);
  assert.deepEqual(await DB.prepare('SELECT * FROM money WHERE id=?').bind('one').first(), { id: 'one', amount, version: 1, note: maliciousText });
  assert.equal(await DB.prepare('SELECT amount FROM money WHERE id=?').bind('two').first('amount'), '0.000001');
  assert.equal(await DB.prepare('SELECT * FROM money WHERE id=?').bind('absent').first(), null);
  await assert.rejects(DB.prepare('SELECT amount FROM money').first('absent'), /column/);
  const all = await DB.prepare('SELECT id FROM money ORDER BY id').all();
  assert.deepEqual(all.results, [{ id: 'one' }, { id: 'two' }]);
  assert.equal(all.meta.changes, 0);
  assert.doesNotThrow(() => JSON.stringify(results));
});

test('run reports changes for successful and lost optimistic updates', async (t) => {
  const { DB } = await fixture(t);
  await DB.prepare('INSERT INTO money(id,amount) VALUES(?,?)').bind('one', '1000000').run();
  const update = DB.prepare('UPDATE money SET version=version+1 WHERE id=? AND version=?');
  assert.equal((await update.bind('one', 1).run()).meta.changes, 1);
  assert.equal((await update.bind('one', 1).run()).meta.changes, 0);
  const returning = await DB.prepare('UPDATE money SET version=version+1 WHERE id=? RETURNING version').bind('one').first();
  assert.deepEqual(returning, { version: 3 });
});

test('a failed batch rolls back preceding writes and prevents following writes', async (t) => {
  const { DB } = await fixture(t);
  await DB.prepare('INSERT INTO money(id,amount) VALUES(?,?)').bind('existing', '3000000').run();
  await assert.rejects(DB.batch([
    DB.prepare('UPDATE money SET amount=? WHERE id=?').bind('999', 'existing'),
    DB.prepare('INSERT INTO money(id,amount) VALUES(?,?)').bind('existing', '4000000'),
    DB.prepare('INSERT INTO money(id,amount) VALUES(?,?)').bind('new', '5000000'),
  ]));
  assert.deepEqual((await DB.prepare('SELECT id,amount FROM money').all()).results, [{ id: 'existing', amount: '3000000' }]);
});

test('batch reads see earlier writes and rejects statements from another adapter', async (t) => {
  const { DB, client } = await fixture(t);
  const results = await DB.batch([
    DB.prepare('INSERT INTO money(id,amount) VALUES(?,?)').bind('one', '123456'),
    DB.prepare('SELECT amount FROM money WHERE id=?').bind('one'),
  ]);
  assert.deepEqual(results[1].results, [{ amount: '123456' }]);
  await assert.rejects(DB.batch([createD1Database(client).prepare('DELETE FROM money')]), /belong/);
  assert.deepEqual(await DB.batch([]), []);
});

test('64-bit integers remain exact and unsafe numeric input is rejected', async (t) => {
  const { DB } = await fixture(t);
  assert.equal(await DB.prepare('SELECT ? AS exact').bind(9223372036854775807n).first('exact'), '9223372036854775807');
  assert.equal(await DB.prepare('SELECT ? AS value').bind(true).first('value'), 1);
  for (const bad of [undefined, {}, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => DB.prepare('SELECT ?').bind(bad), /parameter/);
  }
});

test('production client requires credentials and uses HTTPS transport without native SQLite', () => {
  assert.throws(() => createTursoClient({}), /required/);
  for (const url of ['http://db.test', 'file:local.db', 'libsql://db.test?tls=0', 'https://user:password@db.test']) {
    assert.throws(() => createTursoClient({ TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 'test' }), /TLS/);
  }
  const client = createTursoClient({ TURSO_DATABASE_URL: 'libsql://db.test', TURSO_AUTH_TOKEN: 'test' });
  assert.equal(client.protocol, 'http');
  client.close();
});

test('real Drizzle and auth schemas migrate once and retain existing records on rerun', async (t) => {
  const { DB, client } = await fixture(t);
  const migrations = await readMigrationSources();
  assert.equal((await applyMigrations(client, migrations)).applied.length, migrations.length);
  await DB.prepare('INSERT INTO wallet_links(identity_id,wallet,linked_at) VALUES(?,?,?)').bind('identity', 'wallet', 'today').run();
  await DB.prepare('INSERT INTO auth_sessions(token_hash,identity_id,wallet,created_at,expires_at) VALUES(?,?,?,?,?)').bind('token-hash', 'identity', 'wallet', 1, 2).run();
  assert.deepEqual(await applyMigrations(client, migrations), { applied: [], unchanged: migrations.length });
  assert.deepEqual(await DB.prepare('SELECT identity_id,wallet FROM auth_sessions').first(), { identity_id: 'identity', wallet: 'wallet' });
  const changed = migrations.map((item, index) => index ? item : migration(item.name, `${item.sql}\n-- changed`));
  await assert.rejects(applyMigrations(client, changed), /changed/);
  assert.equal(await DB.prepare('SELECT COUNT(*) AS count FROM auth_sessions').first('count'), 1);
});

test('migration failure rolls back both schema and ledger, then can be corrected safely', async (t) => {
  const { DB, client } = await fixture(t);
  const one = migration('one.sql', 'CREATE TABLE added(id TEXT PRIMARY KEY); INSERT INTO added(id) VALUES (\'kept\');');
  const broken = migration('two.sql', 'CREATE TABLE half_applied(id TEXT); INSERT INTO missing_table VALUES(1);');
  await assert.rejects(applyMigrations(client, [one, broken]));
  const tables = await DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  assert.deepEqual(tables.results, [{ name: 'money' }]);
  const fixed = migration('two.sql', 'CREATE TABLE half_applied(id TEXT);');
  assert.deepEqual((await applyMigrations(client, [one, fixed])).applied, ['one.sql', 'two.sql']);
  assert.equal(await DB.prepare('SELECT id FROM added').first('id'), 'kept');
  await assert.rejects(applyMigrations(client, [one]), /missing/);
});

test('migration refuses an untracked existing schema instead of resetting it', async (t) => {
  const { DB, client } = await fixture(t);
  await DB.prepare('INSERT INTO money(id,amount) VALUES(?,?)').bind('keep', '123').run();
  await assert.rejects(applyMigrations(client, [migration('one.sql', 'CREATE TABLE money(id TEXT);')]));
  assert.equal(await DB.prepare('SELECT amount FROM money').first('amount'), '123');
  assert.equal(await DB.prepare("SELECT name FROM sqlite_master WHERE name='_rate_radar_migrations'").first(), null);
});

test('real libSQL adapter completes signed wallet login and durably revokes logout', async (t) => {
  const { DB, client } = await fixture(t);
  await applyMigrations(client, await readMigrationSources());
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const wallet = encodeBase58(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  const origin = 'https://rate-radar.test';
  const env = { DB, RINGS_NETWORK: 'devnet', AUTH_ALLOWED_ORIGINS: origin };
  const jar = new Map();
  const call = async (path, body) => {
    const response = await handleSessionApi(new Request(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env, { clientAddress: '192.0.2.1' });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const split = pair.indexOf('=');
      const name = pair.slice(0, split);
      if (cookie.includes('Max-Age=0')) jar.delete(name); else jar.set(name, pair.slice(split + 1));
    }
    assert.equal(response.status, 200);
    return response.json();
  };
  const challenge = await call('/api/wallet/challenge', { wallet });
  const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(challenge.message))).toString('base64');
  const verified = await call('/api/wallet/verify', { challengeId: challenge.challengeId, signature });
  assert.equal(verified.authenticated, true);
  const config = await call('/api/config');
  assert.equal(config.authenticated, true);
  assert.equal(config.wallet, wallet);
  const savedToken = jar.get('__Host-rr_session');
  assert.equal(await DB.prepare('SELECT COUNT(*) AS count FROM auth_sessions').first('count'), 1);
  await call('/api/session/logout', {});
  assert.equal(await DB.prepare('SELECT COUNT(*) AS count FROM auth_sessions').first('count'), 0);
  jar.set('__Host-rr_session', savedToken);
  assert.equal((await call('/api/config')).authenticated, false);
});
