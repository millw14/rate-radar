import { getNetworkConfig } from '../rings-networks.mjs';

// Production funds never share the devnet wallet/deal/session database.
// Missing mainnet credentials stay missing; there is deliberately no fallback.
export function databaseEnvironment(env) {
  const { network } = getNetworkConfig(env.RINGS_NETWORK || 'devnet');
  const prefix = network === 'mainnet-beta' ? 'MAINNET_' : '';
  const url = env[`${prefix}TURSO_DATABASE_URL`];
  const token = env[`${prefix}TURSO_AUTH_TOKEN`];
  if (network === 'mainnet-beta' && url && env.TURSO_DATABASE_URL) {
    const canonical = (value) => { const parsed = new URL(value); return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/$/, '')}`; };
    if (canonical(url) === canonical(env.TURSO_DATABASE_URL)) throw new Error('Mainnet requires a separate database from devnet.');
  }
  return { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: token };
}
