#!/usr/bin/env node
// Starts Juice Shop (node build/app) with the NEXUSFLAG_* variables from .env.demo.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs, readEnvFile, SHOP_DIR, mask } from './common.mjs';

const a = parseArgs(process.argv.slice(2));
if (a.help || a.h) {
  console.log('Usage: node start-shop.mjs [--port 3100] [--sdk <path to NexusFlag/packages/sdk-node>] [--dry-run]\nLoads nexusflag-demo/.env.demo (NEXUSFLAG_* keys only), sets HOST=127.0.0.1, runs `node build/app` in the shop root. Ctrl+C stops it.\nSDK path: --sdk, else NEXUSFLAG_SDK_PATH (shell or .env.demo), else ../NexusFlag/packages/sdk-node next to this repo.');
  process.exit(0);
}
const demo = readEnvFile();
if (!demo) { console.error('.env.demo not found: run `node provision.mjs` first (the shop would start WITHOUT NexusFlag).'); process.exit(2); }
const shopEnv = Object.fromEntries(Object.entries(demo).filter(([k]) => k.startsWith('NEXUSFLAG_')));
// The SDK is not an npm dependency of the shop: it is loaded from a NexusFlag checkout at runtime.
const sdkPath = resolve(SHOP_DIR, a.sdk ?? process.env.NEXUSFLAG_SDK_PATH ?? shopEnv.NEXUSFLAG_SDK_PATH ?? '../NexusFlag/packages/sdk-node');
if (!existsSync(join(sdkPath, 'dist', 'index.js'))) {
  console.error(`NexusFlag SDK not built at ${sdkPath}/dist/index.js.\nRun \`pnpm sdk:build\` in the NexusFlag repo, or point --sdk / NEXUSFLAG_SDK_PATH at its packages/sdk-node.`);
  process.exit(2);
}
const built = existsSync(join(SHOP_DIR, 'build', 'app.js'));
const env = { ...process.env, ...shopEnv, NEXUSFLAG_SDK_PATH: sdkPath, PORT: String(a.port ?? process.env.PORT ?? 3100), HOST: '127.0.0.1' };
if (a['dry-run']) {
  console.log(`DRY RUN: cwd=${SHOP_DIR} cmd=node build/app PORT=${env.PORT} HOST=${env.HOST} SDK=${sdkPath} build/app.js exists=${built}`);
  console.log('env:', Object.entries(shopEnv).map(([k, v]) => `${k}=${k.includes('KEY') ? mask(v) : v}`).join(' '));
  process.exit(0);
}
if (!built) {
  console.error(`Shop not built (${join(SHOP_DIR, 'build', 'app.js')} missing). Run \`npm install\` in the shop root first.`);
  process.exit(2);
}
const orderJs = join(SHOP_DIR, 'build', 'routes', 'order.js');
if (!existsSync(orderJs) || !readFileSync(orderJs, 'utf8').includes('new-delivery-pricing')) {
  console.error('Shop build predates the NexusFlag patch (build/routes/order.js has no flag check). Run `npm run build:server` in the shop root.');
  process.exit(2);
}
const child = spawn(process.execPath, ['build/app'], { cwd: SHOP_DIR, env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { child.kill(sig); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
child.on('error', (e) => { console.error(`failed to start shop: ${e.message}`); process.exit(1); });
