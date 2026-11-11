import { getNetworkConfig } from './rings-networks.mjs';

// Public signed wire only: no wallet keys, derivation signatures, or viewing keys.
export function createWithdrawalStore(storage, { owner, network }) {
  getNetworkConfig(network);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner || '')) throw new Error('A verified wallet is required for withdrawal recovery.');
  const key = `rate-radar:withdrawal:v1:${network}:${owner}`;
  function read() {
    let raw;
    try { raw = storage.getItem(key); } catch { throw new Error('Enable browser storage before withdrawing. It keeps your signed withdrawal recoverable.'); }
    if (!raw) return null;
    let record;
    try { record = JSON.parse(raw); } catch { throw new Error('The saved withdrawal record is unreadable. Review your wallet history before withdrawing again.'); }
    if (record.owner !== owner || record.recipient !== owner || record.network !== network || !/^[1-9]\d*$/.test(record.amountAtomic || '') || !/^\d+$/.test(record.lastValidBlockHeight || '') || typeof record.txSignature !== 'string' || typeof record.signedTransaction !== 'string') throw new Error('The saved withdrawal record is invalid. Review your wallet history before withdrawing again.');
    return record;
  }
  return {
    read,
    checkAvailable() {
      const probe = `${key}:check`;
      try { storage.setItem(probe, '1'); if (storage.getItem(probe) !== '1') throw new Error(); storage.removeItem(probe); }
      catch { throw new Error('Enable browser storage before withdrawing. Nothing has been sent.'); }
    },
    save(prepared) {
      const existing = read();
      if (existing && existing.txSignature !== prepared.txSignature) throw new Error('Check the saved withdrawal before creating another one. Nothing new was sent.');
      if (prepared.owner !== owner || prepared.recipient !== owner || prepared.network !== network) throw new Error('The withdrawal wallet or network changed. Nothing was sent.');
      const record = Object.fromEntries(['network','owner','recipient','mint','amountAtomic','txSignature','signedTransaction','lastValidBlockHeight'].map(field => [field, prepared[field]]));
      try { storage.setItem(key, JSON.stringify(record)); if (read()?.txSignature !== record.txSignature) throw new Error(); }
      catch { throw new Error('The signed withdrawal could not be saved. Nothing has been sent. Enable browser storage and retry.'); }
      return record;
    },
    settle(record, result) {
      if (!result.finalized || !['confirmed','failed','expired'].includes(result.status) || result.signature !== record.txSignature) throw new Error('A withdrawal can only be cleared after finalized chain evidence.');
      if (read()?.txSignature !== record.txSignature) throw new Error('The saved withdrawal changed. Refresh before continuing.');
      storage.removeItem(key);
      if (read()) throw new Error('The settled withdrawal could not be cleared. Refresh before continuing.');
    },
  };
}
