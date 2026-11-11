export function wranglerConfig({ built = false, local = false } = {}) {
  return {
    name: 'rate-radar',
    main: built ? 'index.js' : 'dist/server/index.js',
    compatibility_date: '2026-05-15',
    compatibility_flags: ['nodejs_compat'],
    no_bundle: true,
    rules: [{ type: 'CompiledWasm', globs: ['**/*.wasm'], fallthrough: true }],
    assets: { directory: built ? '../client' : 'dist/client', binding: 'ASSETS', run_worker_first: ['/api/*'] },
    d1_databases: [{ binding: 'DB', database_name: 'rate-radar', database_id: '00000000-0000-4000-8000-000000000000', migrations_dir: built ? '../../drizzle' : 'drizzle' }],
    vars: { RINGS_NETWORK: 'devnet', RINGS_USDC_MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', ...(local ? { LOCAL_DEV_AUTH: 'true' } : {}) },
    observability: { enabled: false }
  };
}
