import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { wranglerConfig } from './runtime-config.mjs';
await writeFile('wrangler.local.json', JSON.stringify(wranglerConfig({local:true}), null, 2)+'\n');
const run=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','DB','--local','--config','wrangler.local.json','--persist-to','.wrangler/state'],{stdio:'inherit'});
process.exitCode=run.status??1;
