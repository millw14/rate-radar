// Cloudflare accepts precompiled WASM modules, not runtime compilation of bytes.
// The implementation and binary are the unmodified official SDK dependency.
import { WasmFactory as OfficialFactory } from '@lightprotocol/hasher.rs/slim';
import wasm from 'rate-radar:hasher-wasm';
export const WasmFactory = {
  loadHasher: () => OfficialFactory.loadHasher({ wasm, simd: false }),
  resetModule: () => OfficialFactory.resetModule(),
};
