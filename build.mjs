import { mkdir, copyFile, cp, rm, writeFile, access } from 'node:fs/promises';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { wranglerConfig } from './scripts/runtime-config.mjs';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/client', { recursive: true });
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await Promise.all(['index.html', 'styles.css'].map(file => copyFile(file, `dist/client/${file}`)));
await cp('assets', 'dist/client/assets', { recursive: true });
await build({
  entryPoints: ['app.mjs'], outdir: 'dist/client', bundle: true, splitting: true,
  format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  outExtension: { '.js': '.mjs' }, chunkNames: 'assets/[name]-[hash]',
  loader: { '.wasm': 'file' }, assetNames: 'assets/[name]-[hash]',
  define: { 'process.env.NODE_ENV': '"production"' },
});
if (process.env.VERCEL !== '1') {
await build({
  entryPoints: ['worker.mjs'], outfile: 'dist/server/index.js', bundle: true,
  format: 'esm', platform: 'node', target: 'es2022', minify: false,
  conditions: ['workerd','worker','browser'], external: ['node:*','cloudflare:*'],
  plugins: [{ name: 'worker-hasher', setup(builder) {
    builder.onResolve({ filter: /^@lightprotocol\/hasher\.rs$/ }, () => ({ path: resolve('scripts/hasher-worker.mjs') }));
    builder.onResolve({ filter: /^rate-radar:hasher-wasm$/ }, () => ({ path: './hasher.wasm', external: true }));
  }}],
});
await copyFile('node_modules/@lightprotocol/hasher.rs/dist/light_wasm_hasher_bg.wasm', 'dist/server/hasher.wasm');
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
try { await access('drizzle'); await cp('drizzle', 'dist/.openai/drizzle', { recursive: true }); } catch {}
await writeFile('dist/server/wrangler.json', JSON.stringify(wranglerConfig({built:true}), null, 2)+'\n');
}
console.log(process.env.VERCEL === '1' ? 'Rate Radar built → dist/client + Vercel API source' : 'Rate Radar built → dist/client + dist/server (Rings + D1)');
