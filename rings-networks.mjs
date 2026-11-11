// Public allowlist; never accept a caller-supplied RPC endpoint or token substitute.
// Policies: @heliuslabs/spr 0.9.0-alpha client/prover/tee/signed.js.
// USDC: https://developers.circle.com/stablecoins/usdc-contract-addresses
// Genesis hashes are full getGenesisHash values, not truncated CAIP identifiers.
const NETWORKS = Object.freeze({
  devnet: Object.freeze({
    network: 'devnet', rpcUrl: 'https://devnet.helius-rpc.com/', walletChain: 'solana:devnet',
    policyNetwork: 'devnet', policyURL: 'https://d3gbdb0egjwcw9.cloudfront.net/tee-policy/devnet.json',
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', explorerCluster: 'devnet',
  }),
  'mainnet-beta': Object.freeze({
    network: 'mainnet-beta', rpcUrl: 'https://mainnet.helius-rpc.com/', walletChain: 'solana:mainnet',
    policyNetwork: 'mainnet', policyURL: 'https://d3gbdb0egjwcw9.cloudfront.net/tee-policy/mainnet.json',
    genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', explorerCluster: null,
  }),
});

export function getNetworkConfig(network = 'devnet') {
  if (typeof network !== 'string' || !Object.hasOwn(NETWORKS, network)) throw new Error('Unsupported Solana network. Choose devnet or mainnet-beta.');
  return NETWORKS[network];
}
