import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client/sqlite3';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { exportSnapshot, restoreSnapshot } from './backup-vercel.mjs';
import { DATABASE_SCHEMA_SQL } from '../backend.mjs';
import { AUTH_SCHEMA_SQL } from '../server/session.mjs';

async function source(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rate-radar-backup-test-'));
  const client = createClient({ url: `file:${join(directory, 'source.sqlite')}`, intMode: 'bigint' });
  t.after(async () => { client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.executeMultiple(DATABASE_SCHEMA_SQL + AUTH_SCHEMA_SQL);
  await client.execute({ sql: 'INSERT INTO wallet_links VALUES(?,?,?)', args: ['owner', 'wallet', '2026-11-11'] });
  await client.execute({ sql: 'INSERT INTO deals(id,owner_identity,brand_wallet,creator_wallet,terms_json,terms_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', args: ['deal', 'owner', 'wallet', 'creator', '{"amountAtomic":"50000"}', 'terms-hash', '2026-11-11', '2026-11-11'] });
  await client.execute({ sql: 'INSERT INTO payment_intents(id,deal_id,identity_id,idempotency_key,snapshot_json,status,tx_signature,disclosure_ciphertext,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', args: ['intent', 'deal', 'owner', 'unique-key', '{"network":"devnet"}', 'pending', 'retained-transaction-signature', 'iv.encrypted-pending-payment', '2026-11-11', '2026-11-11'] });
  await client.executeMultiple('CREATE TABLE binary_fixture(id INTEGER PRIMARY KEY AUTOINCREMENT, exact_integer INTEGER, payload BLOB);');
  await client.execute({ sql: 'INSERT INTO binary_fixture(exact_integer,payload) VALUES(?,?)', args: [9223372036854775807n, new Uint8Array([0, 1, 254, 255])] });
  await client.execute('INSERT INTO binary_fixture(exact_integer) VALUES(2)');
  await client.execute('DELETE FROM binary_fixture WHERE id=2');
  return { directory, client };
}

test('read-only consistent export restores real app schema, pending ciphertext, exact integers, blobs, and sequence state', async (t) => {
  const f = await source(t);
  const statements = [];
  const client = { async transaction(mode) {
    assert.equal(mode, 'read');
    const tx = await f.client.transaction(mode);
    return { execute: async (sql) => { assert.match(sql, /^(SELECT|PRAGMA)\b/); statements.push(sql); return tx.execute(sql); }, commit: () => tx.commit(), rollback: () => tx.rollback(), close: () => tx.close() };
  } };
  const snapshot = await exportSnapshot(client);
  assert(statements.length > 1);
  assert(!JSON.stringify(snapshot).includes('TURSO_AUTH_TOKEN'));
  const destination = join(f.directory, 'restored.sqlite');
  const checked = await restoreSnapshot(JSON.parse(JSON.stringify(snapshot)), destination);
  assert.equal(checked.foreignKeys, 'ok');
  assert.equal(checked.integrity, 'ok');
  assert.equal(checked.rows, 4);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  const restored = new DatabaseSync(destination);
  try {
    const pending = restored.prepare('SELECT status,tx_signature,disclosure_ciphertext FROM payment_intents').get();
    assert.equal(pending.status, 'pending');
    assert.equal(pending.tx_signature, 'retained-transaction-signature');
    assert.equal(pending.disclosure_ciphertext, 'iv.encrypted-pending-payment');
    const exact = restored.prepare('SELECT exact_integer,payload FROM binary_fixture'); exact.setReadBigInts(true);
    const row = exact.get();
    assert.equal(row.exact_integer, 9223372036854775807n);
    assert.deepEqual([...row.payload], [0, 1, 254, 255]);
    assert.equal(restored.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('binary_fixture').seq, 2);
  } finally { restored.close(); }
});

test('restore refuses an existing file and rejects checksum corruption before creating a file', async (t) => {
  const f = await source(t); const snapshot = await exportSnapshot(f.client);
  const destination = join(f.directory, 'existing.sqlite');
  await writeFile(destination, 'do not replace', { mode: 0o600 });
  await assert.rejects(restoreSnapshot(snapshot, destination), { code: 'EEXIST' });
  assert.equal(await readFile(destination, 'utf8'), 'do not replace');
  snapshot.payload.createdAt = 'altered';
  const invalid = join(f.directory, 'invalid.sqlite');
  await assert.rejects(restoreSnapshot(snapshot, invalid), /checksum/);
  await assert.rejects(stat(invalid), { code: 'ENOENT' });
});

test('foreign-key violations fail validation and discard only the newly created local restore', async (t) => {
  const f = await source(t); const snapshot = await exportSnapshot(f.client);
  snapshot.payload.tables.find((table) => table.name === 'deals').rows = [];
  snapshot.sha256 = createHash('sha256').update(JSON.stringify(snapshot.payload)).digest('hex');
  const destination = join(f.directory, 'invalid-foreign-key.sqlite');
  await assert.rejects(restoreSnapshot(snapshot, destination), /foreign-key/);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
  assert.equal((await f.client.execute('SELECT COUNT(*) AS count FROM payment_intents')).rows[0].count, 1n);
});
