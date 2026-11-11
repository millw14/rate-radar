import { ipAddress } from '@vercel/functions';
import { createDatabase } from '../server/database.mjs';
import { handleSessionApi } from '../server/session.mjs';

let database;

export default {
  async fetch(request) {
    try {
      if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) database ??= createDatabase(process.env);
      const response = await handleSessionApi(request, { ...process.env, DB: database }, {
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
