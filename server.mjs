import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { wranglerConfig } from './scripts/runtime-config.mjs';

// Wrangler loads .env.local beside this generated config. Never copy secrets into build output.
await writeFile('wrangler.local.json', JSON.stringify(wranglerConfig({local:true}), null, 2)+'\n');
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js','dev','--config','wrangler.local.json','--local','--ip','127.0.0.1','--port',process.env.PORT || '4173','--persist-to','.wrangler/state','--inspector-port','0'], { stdio: 'inherit' });
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code??1));
