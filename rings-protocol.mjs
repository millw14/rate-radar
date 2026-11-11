// Wire contract shared by the browser and verifier. No secret is persisted here.
export const RINGS_NETWORK = 'devnet';
export const SOL_MINT = '11111111111111111111111111111111';
export const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

export function amountAtomic(value) {
  const text = typeof value === 'bigint' ? value.toString() : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,19}$/.test(text)) throw new Error('Enter a positive amount in atomic units.');
  const amount = BigInt(text);
  if (amount > 18446744073709551615n) throw new Error('The amount exceeds the token limit.');
  return amount;
}

export function paymentMemo(intent) {
  if (!intent || intent.network !== RINGS_NETWORK) throw new Error('Payments are enabled on Solana devnet only.');
  for (const field of ['id', 'dealId', 'termsHash', 'memo', 'mint', 'payerWallet', 'recipientWallet']) {
    if (typeof intent[field] !== 'string' || !intent[field] || intent[field].length > 256) throw new Error(`Invalid payment intent: ${field}.`);
  }
  amountAtomic(intent.amountAtomic);
  // An exact encoding prevents a receipt being replayed against another intent.
  return new TextEncoder().encode(JSON.stringify({
    v: 1, app: 'rate-radar', intent: intent.id, deal: intent.dealId,
    terms: intent.termsHash, challenge: intent.memo,
  }));
}

export function equalBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a[i] ^ b[i];
  return different === 0;
}

export function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function fromBase64(text, length) {
  if (typeof text !== 'string' || text.length > 128 * 1024) throw new Error('Invalid base64 data.');
  const binary = atob(text);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (toBase64(bytes) !== text || (length !== undefined && bytes.length !== length)) throw new Error('Invalid base64 data.');
  return bytes;
}
