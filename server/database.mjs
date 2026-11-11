import { createClient } from '@libsql/client/web';

// Only this server module reads credentials. The web driver uses HTTPS for
// libsql: URLs and does not bundle a native SQLite module into the function.
export function createTursoClient(env = process.env) {
  const url = env.TURSO_DATABASE_URL;
  const authToken = env.TURSO_AUTH_TOKEN;
  if (typeof url !== 'string' || !url || typeof authToken !== 'string' || !authToken) {
    throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required.');
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('The Turso database URL is invalid.'); }
  if (!['libsql:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('The Turso database URL must use TLS and separate authentication.');
  }
  return createClient({ url, authToken, intMode: 'bigint' });
}

function boundValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  throw new TypeError('Unsupported database parameter. Use strings for exact monetary values.');
}

function resultValue(value) {
  // Keep existing D1 number semantics for timestamps/counts, but never round a
  // 64-bit integer or return a bigint that breaks JSON serialization.
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
  return value;
}

function d1Result(result) {
  return {
    success: true,
    results: result.rows.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, resultValue(row[index])]))),
    meta: { changes: result.rowsAffected, last_row_id: result.lastInsertRowid === undefined ? null : resultValue(result.lastInsertRowid) },
  };
}

/** The D1 subset used by backend.mjs and session.mjs, backed by real libSQL. */
export function createD1Database(client) {
  if (!client || typeof client.execute !== 'function' || typeof client.batch !== 'function') throw new TypeError('A libSQL client is required.');
  const statements = new WeakMap();
  const prepare = (sql, args = []) => {
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('A SQL statement is required.');
    const execute = async () => d1Result(await client.execute({ sql, args }));
    const statement = Object.freeze({
      bind: (...values) => prepare(sql, values.map(boundValue)),
      async first(column) {
        const result = await execute();
        const row = result.results[0];
        if (!row) return null;
        if (column === undefined) return row;
        if (typeof column !== 'string' || !Object.hasOwn(row, column)) throw new Error('The requested database column does not exist.');
        return row[column];
      },
      all: execute,
      run: execute,
    });
    statements.set(statement, { sql, args });
    return statement;
  };
  return Object.freeze({
    prepare: (sql) => prepare(sql),
    async batch(batch) {
      if (!Array.isArray(batch)) throw new TypeError('Database batch requires prepared statements.');
      const queries = batch.map((statement) => {
        const query = statements.get(statement);
        if (!query) throw new TypeError('Every batch statement must belong to this database.');
        return query;
      });
      if (!queries.length) return [];
      // libSQL batch wraps all statements in BEGIN IMMEDIATE/COMMIT and rolls
      // back the entire batch on failure. Never replace this with Promise.all.
      return (await client.batch(queries, 'write')).map(d1Result);
    },
    close: () => client.close(),
  });
}

export function createDatabase(env = process.env) {
  return createD1Database(createTursoClient(env));
}
