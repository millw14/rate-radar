import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTursoClient } from '../server/database.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ROWS = 100000;
const MAX_BYTES = 50 * 1024 * 1024;
class BackupError extends Error {}
const identifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const checksum = (value) => createHash('sha256').update(value).digest('hex');
function encode(value) {
  if (value === null) return { type: 'null' };
  if (typeof value === 'bigint') return { type: 'integer', value: String(value) };
  if (typeof value === 'string') return { type: 'text', value };
  if (typeof value === 'number' && Number.isFinite(value)) return { type: 'real', value };
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return { type: 'blob', value: Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).toString('base64') };
  throw new BackupError('The source contains an unsupported SQLite value.');
}
function decode(cell) {
  if (cell?.type === 'null') return null;
  if (cell?.type === 'integer' && typeof cell.value === 'string' && /^-?\d+$/.test(cell.value)) return BigInt(cell.value);
  if (cell?.type === 'text' && typeof cell.value === 'string') return cell.value;
  if (cell?.type === 'real' && typeof cell.value === 'number' && Number.isFinite(cell.value)) return cell.value;
  if (cell?.type === 'blob' && typeof cell.value === 'string') {
    const bytes = Buffer.from(cell.value, 'base64');
    if (bytes.toString('base64') === cell.value) return bytes;
  }
  throw new BackupError('The backup contains an invalid SQLite value.');
}

/** One read-only snapshot: this function never sends remote writes or resets. */
export async function exportSnapshot(client) {
  const transaction = await client.transaction('read');
  try {
    const schemaResult = await transaction.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND substr(name,1,7)<>'sqlite_' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name");
    const schema = schemaResult.rows.map((row) => ({ type: row.type, name: row.name, table: row.tbl_name, sql: row.sql }));
    if (schema.length > 1000 || schema.some((entry) => !['table', 'index', 'view', 'trigger'].includes(entry.type) || !/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\b/i.test(entry.sql))) throw new BackupError('The source schema requires a provider-native backup.');
    const tables = [];
    let bytes = Buffer.byteLength(JSON.stringify(schema));
    for (const entry of schema.filter((item) => item.type === 'table')) {
      const info = await transaction.execute(`PRAGMA table_xinfo(${identifier(entry.name)})`);
      const columns = info.rows.filter((column) => Number(column.hidden) === 0).map((column) => column.name);
      if (!columns.length) throw new BackupError('The source contains a table without restorable columns.');
      const values = await transaction.execute(`SELECT ${columns.map(identifier).join(',')} FROM ${identifier(entry.name)} LIMIT ${MAX_ROWS + 1}`);
      if (values.rows.length > MAX_ROWS) throw new BackupError('The source exceeds the bounded backup row limit; use a provider-native backup.');
      const table = { name: entry.name, columns, rows: values.rows.map((row) => columns.map((_column, index) => encode(row[index]))) };
      bytes += Buffer.byteLength(JSON.stringify(table));
      if (bytes > MAX_BYTES) throw new BackupError('The source exceeds the 50 MiB backup limit; use a provider-native backup.');
      tables.push(table);
    }
    const sequenceExists = await transaction.execute("SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'");
    const sequences = sequenceExists.rows.length ? (await transaction.execute('SELECT name,seq FROM sqlite_sequence')).rows.map((row) => ({ name: row.name, seq: String(row.seq) })) : [];
    await transaction.commit();
    const payload = { createdAt: new Date().toISOString(), schema, tables, sequences };
    return { format: 'rate-radar-sqlite-snapshot', version: 1, sha256: checksum(JSON.stringify(payload)), payload };
  } catch (error) {
    try { await transaction.rollback(); } catch { /* No remote writes were made. */ }
    throw error;
  } finally { transaction.close(); }
}

/** Restore only into a newly created local file; an existing file is never touched. */
export async function restoreSnapshot(snapshot, destination) {
  if (snapshot?.format !== 'rate-radar-sqlite-snapshot' || snapshot.version !== 1 || checksum(JSON.stringify(snapshot.payload)) !== snapshot.sha256) throw new BackupError('The backup format or checksum is invalid.');
  const { schema, tables, sequences } = snapshot.payload;
  if (!Array.isArray(schema) || !Array.isArray(tables) || !Array.isArray(sequences) || schema.some((entry) => !['table', 'index', 'view', 'trigger'].includes(entry.type) || !/^CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\b/i.test(entry.sql))) throw new BackupError('The backup schema is invalid.');
  const created = await open(destination, 'wx', 0o600);
  await created.close();
  let db;
  try {
    db = new DatabaseSync(destination, { enableForeignKeyConstraints: false, allowExtension: false });
    db.exec('PRAGMA journal_mode=DELETE; BEGIN;');
    for (const entry of schema.filter((item) => item.type === 'table')) db.prepare(entry.sql).run();
    const counts = [];
    const names = new Set();
    for (const table of tables) {
      if (names.has(table.name) || !schema.some((entry) => entry.type === 'table' && entry.name === table.name) || !table.columns.length || !Array.isArray(table.rows)) throw new BackupError('The backup tables are inconsistent.');
      names.add(table.name);
      const statement = db.prepare(`INSERT INTO ${identifier(table.name)} (${table.columns.map(identifier).join(',')}) VALUES (${table.columns.map(() => '?').join(',')})`);
      for (const row of table.rows) {
        if (!Array.isArray(row) || row.length !== table.columns.length) throw new BackupError('The backup contains an invalid row.');
        statement.run(...row.map(decode));
      }
      const count = db.prepare(`SELECT COUNT(*) AS count FROM ${identifier(table.name)}`).get().count;
      if (count !== table.rows.length) throw new BackupError('The restored row counts do not match.');
      counts.push({ table: table.name, rows: count });
    }
    if (names.size !== schema.filter((entry) => entry.type === 'table').length) throw new BackupError('The backup is missing table data.');
    if (sequences.length) {
      db.prepare('DELETE FROM sqlite_sequence').run();
      const statement = db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)');
      for (const sequence of sequences) statement.run(sequence.name, BigInt(sequence.seq));
    }
    // Create triggers only after restoring rows so imported rows cannot trigger side effects.
    for (const entry of schema.filter((item) => item.type !== 'table')) db.prepare(entry.sql).run();
    db.exec('COMMIT; PRAGMA foreign_keys=ON;');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new BackupError('The restored database failed foreign-key validation.');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new BackupError('The restored database failed integrity validation.');
    db.close(); db = undefined;
    const file = await open(destination, 'r');
    try { await file.sync(); } finally { await file.close(); }
    return { tables: counts.length, rows: counts.reduce((sum, table) => sum + table.rows, 0), counts, foreignKeys: 'ok', integrity: 'ok' };
  } catch (error) {
    try { db?.close(); } catch {}
    await rm(destination, { force: true });
    throw error;
  }
}

async function ignoredPath(input, exists) {
  const path = resolve(ROOT, input);
  const inside = (value) => { const name = relative(ROOT, value); return name && !name.startsWith('..') && !isAbsolute(name); };
  if (!inside(path)) throw new BackupError('Backup and environment paths must be inside this checkout and ignored by Git.');
  const ensureIgnored = (value) => {
    try { execFileSync('git', ['check-ignore', '--quiet', '--', relative(ROOT, value)], { cwd: ROOT, stdio: 'ignore' }); }
    catch { throw new BackupError('Backup and environment paths must be ignored by Git.'); }
  };
  ensureIgnored(path);
  if (exists) {
    const actual = await realpath(path);
    if (!inside(actual)) throw new BackupError('The selected file resolves outside this checkout.');
    ensureIgnored(actual);
    return actual;
  }
  let ancestor = dirname(path);
  while (true) {
    try { if (!inside(await realpath(ancestor)) && ancestor !== ROOT) throw new BackupError('The backup directory resolves outside this checkout.'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const actual = resolve(await realpath(dirname(path)), basename(path));
  if (!inside(actual)) throw new BackupError('The backup directory resolves outside this checkout.');
  ensureIgnored(actual);
  return actual;
}

async function main(args) {
  if (args.length !== 6 || args[0] !== '--env-file' || args[2] !== '--output' || args[4] !== '--restore-check') throw new BackupError('Usage: node scripts/backup-vercel.mjs --env-file .env.vercel.local --output backups/snapshot.json --restore-check backups/restore.sqlite');
  process.umask(0o077);
  const environment = await ignoredPath(args[1], true);
  const output = await ignoredPath(args[3], false);
  const restore = await ignoredPath(args[5], false);
  if (output === restore || output === environment || restore === environment) throw new BackupError('Choose three distinct paths.');
  const env = parseEnv(await readFile(environment, 'utf8'));
  const client = createTursoClient(env); // Only the explicitly chosen file selects the source database.
  let snapshot;
  try { snapshot = await exportSnapshot(client); } finally { client.close(); }
  const text = JSON.stringify(snapshot);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new BackupError('The snapshot exceeds the 50 MiB backup limit.');
  const file = await open(output, 'wx', 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(output), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  const result = await restoreSnapshot(JSON.parse(await readFile(output, 'utf8')), restore);
  console.log(`Backup validated: ${result.tables} tables, ${result.rows} rows; foreign keys and integrity checks passed.`);
  console.log(`Snapshot: ${relative(ROOT, output)}; local restore: ${relative(ROOT, restore)}; SHA-256: ${snapshot.sha256}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    // Provider errors may contain SQL values, credentials or URLs. Never print them.
    console.error(error instanceof BackupError ? error.message : 'Backup or local restore validation failed. No remote reset or write was performed. Inspect credentials and local artifact paths privately.');
    process.exitCode = 1;
  }
}
