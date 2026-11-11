import { ipAddress } from '@vercel/functions';
import { createDatabase } from '../server/database.mjs';
import { handleSessionApi } from '../server/session.mjs';
import { reconcilePendingPayments } from '../backend.mjs';
import { getNetworkConfig } from '../rings-networks.mjs';
import { databaseEnvironment } from '../server/runtime-config.mjs';

let database;

export async function handleCronRequest(request, env, dependencies = {}) {
  const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
  if (typeof env.CRON_SECRET !== 'string' || env.CRON_SECRET.length < 32) return reply({ error: { code: 'CRON_NOT_CONFIGURED', message: 'Background reconciliation is not configured.' } }, 503);
  const digest = async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [actual, expected] = await Promise.all([digest(request.headers.get('authorization') || ''), digest(`Bearer ${env.CRON_SECRET}`)]);
  let different = 0;
  for (let index = 0; index < actual.length; index++) different |= actual[index] ^ expected[index];
  if (different) return reply({ error: { code: 'UNAUTHORIZED', message: 'This job requires server authentication.' } }, 401);
  if (request.method !== 'GET') return reply({ error: { code: 'METHOD_NOT_ALLOWED', message: 'This job requires GET.' } }, 405);
  if (!env.DB || !env.HELIUS_API_KEY || !env.RECEIPT_ENCRYPTION_KEY || !env.RINGS_USDC_MINT) return reply({ error: { code: 'RECONCILIATION_NOT_CONFIGURED', message: 'Payment reconciliation is not configured.' } }, 503);
  const chain = getNetworkConfig(env.RINGS_NETWORK || 'devnet');
  if (chain.usdcMint !== env.RINGS_USDC_MINT) return reply({ error: { code: 'INVALID_ASSET_CONFIGURATION', message: 'The configured payment asset does not match the network.' } }, 503);
  const bucket = `reconciliation-lease:${chain.network}`;
  const owner = crypto.getRandomValues(new Uint32Array(1))[0];
  const timestamp = Date.now();
  const lease = await env.DB.prepare('INSERT INTO rate_limits(bucket,count,expires_at) VALUES(?,?,?) ON CONFLICT(bucket) DO UPDATE SET count=excluded.count,expires_at=excluded.expires_at WHERE rate_limits.expires_at<? RETURNING count').bind(bucket, owner, timestamp + 150000, timestamp).first();
  if (!lease) return reply({ checked: 0, skipped: 'already_running' });
  try {
    // One payment per minute bounds worst-case provider timeouts within this function.
    // User-triggered reconciliation remains available; saved bytes are always reused.
    return reply(await reconcilePendingPayments(env, { ...dependencies, limit: 1 }));
  } finally {
    await env.DB.prepare('DELETE FROM rate_limits WHERE bucket=? AND count=?').bind(bucket, owner).run();
  }
}

export default {
  async fetch(request) {
    try {
      const selectedDatabase = databaseEnvironment(process.env);
      const configured = Boolean(selectedDatabase.TURSO_DATABASE_URL && selectedDatabase.TURSO_AUTH_TOKEN);
      if (configured) database ??= createDatabase(selectedDatabase);
      const env = { ...process.env, DB: configured ? database : undefined };
      const response = new URL(request.url).pathname.replace(/\/$/, '') === '/api/cron/reconcile'
        ? await handleCronRequest(request, env)
        : await handleSessionApi(request, env, {
        // Vercel supplies this header at its trusted edge. It is not an identity.
        clientAddress: ipAddress(request),
      });
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'private, no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      // Never log request bodies, wallet disclosures, database URLs or credentials.
      console.error('Rate Radar API failed', { errorType: error?.name || 'Error' });
      return Response.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'The workspace is temporarily unavailable. Please try again.' } }, {
        status: 503, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }
  },
};
