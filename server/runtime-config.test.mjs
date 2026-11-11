import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseEnvironment } from './runtime-config.mjs';

test('each network selects only its own database credentials', () => {
  const env = { TURSO_DATABASE_URL: 'libsql://dev.example', TURSO_AUTH_TOKEN: 'dev', MAINNET_TURSO_DATABASE_URL: 'libsql://main.example', MAINNET_TURSO_AUTH_TOKEN: 'main' };
  assert.deepEqual(databaseEnvironment(env), { TURSO_DATABASE_URL: env.TURSO_DATABASE_URL, TURSO_AUTH_TOKEN: 'dev' });
  assert.deepEqual(databaseEnvironment({ ...env, RINGS_NETWORK: 'mainnet-beta' }), { TURSO_DATABASE_URL: env.MAINNET_TURSO_DATABASE_URL, TURSO_AUTH_TOKEN: 'main' });
  assert.deepEqual(databaseEnvironment({ TURSO_DATABASE_URL: env.TURSO_DATABASE_URL, TURSO_AUTH_TOKEN: 'dev', RINGS_NETWORK: 'mainnet-beta' }), { TURSO_DATABASE_URL: undefined, TURSO_AUTH_TOKEN: undefined });
});

test('mainnet refuses a reused devnet database even through the HTTPS alias', () => {
  for (const main of ['libsql://same.example', 'https://same.example/']) assert.throws(() => databaseEnvironment({ RINGS_NETWORK: 'mainnet-beta', TURSO_DATABASE_URL: 'libsql://same.example', MAINNET_TURSO_DATABASE_URL: main }), /separate database/);
  assert.throws(() => databaseEnvironment({ RINGS_NETWORK: 'testnet' }));
});
