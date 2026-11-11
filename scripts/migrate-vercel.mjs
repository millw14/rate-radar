import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { createTursoClient } from '../server/database.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = '_rate_radar_migrations';
class MigrationError extends Error {}

export async function readMigrationSources(root = ROOT) {
  const directory = resolve(root, 'drizzle');
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  if (!names.length) throw new MigrationError('No Drizzle migrations were found.');
  const files = [...names.map((name) => `drizzle/${name}`), 'server/auth-schema.sql'];
  return Promise.all(files.map(async (name) => {
    const sql = await readFile(resolve(root, name), 'utf8');
    if (!sql.trim()) throw new MigrationError(`Migration ${name} is empty.`);
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  }));
}

/** Applied schema and its checksum ledger commit together; any failure rolls back. */
export async function applyMigrations(client, migrations) {
  const names = new Set(migrations.map((migration) => migration.name));
  if (names.size !== migrations.length) throw new MigrationError('Duplicate migration names.');
  const transaction = await client.transaction('write');
  try {
    await transaction.execute(`CREATE TABLE IF NOT EXISTS ${LEDGER} (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    const applied = await transaction.execute(`SELECT name,sha256 FROM ${LEDGER}`);
    const hashes = new Map(applied.rows.map((row) => [row.name, row.sha256]));
    for (const name of hashes.keys()) if (!names.has(name)) throw new MigrationError('The database contains a migration missing from this checkout.');
    for (const migration of migrations) {
      if (hashes.has(migration.name) && hashes.get(migration.name) !== migration.sha256) {
        throw new MigrationError(`Applied migration ${migration.name} changed. Add a new migration instead.`);
      }
    }
    const added = [];
    for (const migration of migrations) {
      if (hashes.has(migration.name)) continue;
      // executeMultiple runs on this transaction's connection. Drizzle's
      // statement-breakpoint comments need no SQL splitting or rewriting.
      await transaction.executeMultiple(migration.sql);
      await transaction.execute({ sql: `INSERT INTO ${LEDGER}(name,sha256,applied_at) VALUES(?,?,?)`, args: [migration.name, migration.sha256, new Date().toISOString()] });
      added.push(migration.name);
    }
    const violations = await transaction.execute('PRAGMA foreign_key_check');
    if (violations.rows.length) throw new MigrationError('Foreign-key validation failed; no migrations were applied.');
    await transaction.commit();
    return { applied: added, unchanged: migrations.length - added.length };
  } catch (error) {
    try { await transaction.rollback(); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally {
    transaction.close();
  }
}

async function ignoredEnvironment(path) {
  const file = await realpath(resolve(ROOT, path));
  const local = relative(ROOT, file);
  if (local.startsWith('..') || isAbsolute(local)) throw new MigrationError('The environment file must be inside this checkout and ignored by Git.');
  try { execFileSync('git', ['check-ignore', '--quiet', '--', local], { cwd: ROOT, stdio: 'ignore' }); }
  catch { throw new MigrationError('The environment file must be ignored by Git.'); }
  // Parse only the explicitly selected file: unrelated shell credentials must
  // not silently override the database chosen for this migration.
  return parseEnv(await readFile(file, 'utf8'));
}

async function main(args) {
  if (args.length !== 2 || args[0] !== '--env-file' || !args[1]) throw new MigrationError('Usage: node scripts/migrate-vercel.mjs --env-file .env.vercel.production');
  const env = await ignoredEnvironment(args[1]);
  const migrations = await readMigrationSources();
  const client = createTursoClient(env);
  try {
    const result = await applyMigrations(client, migrations);
    console.log(`Database migrations complete: ${result.applied.length} applied, ${result.unchanged} unchanged.`);
    for (const name of result.applied) console.log(`Applied ${name}`);
  } finally {
    client.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    // Provider exceptions can include credentials or connection URLs. Never log
    // their messages/stacks, SQL parameters, or environment contents.
    console.error(error instanceof MigrationError ? error.message : 'Database migration failed. No reset was performed. Check credentials, connectivity, and schema compatibility.');
    process.exitCode = 1;
  }
}
