#!/usr/bin/env node
// Provisions everything the Juice Shop demo needs in NexusFlag and writes .env.demo.
// Mirrors apps/simulator/src/provision/provision.ts (same REST sequence and body shapes).
import { parseArgs, Core, CoreError, writeEnvFile, mask, ENV_FILE } from './common.mjs';

const HELP = `Usage: node provision.mjs [options]
  --core <url>          Core API base URL                (default http://127.0.0.1:3001)
  --origin <url>        Must equal Core DASHBOARD_ORIGIN (default http://localhost:3000)
  --stream <url>        Streaming URL given to the shop  (default http://127.0.0.1:4000)
  --email <email>       Admin account                    (default demo-admin@nexusflag.local)
  --password <pw>       Admin password, >= 15 chars      (default demo-admin-password-1)
  --workspace <slug>    Workspace slug                   (default juice-shop-demo)
  --min-samples <n>     Policy confidence gate           (default 30)
  --cooldown <sec>      Policy cooldown                  (default 60)
  --fresh               Suffix the workspace slug with a unique id (a pristine workspace/flag/policy,
                        or when the slug is taken by another account)
  --dry-run             Print the plan, make no requests
Re-running is safe: workspace, project, environment, flag and policy are looked up first.
A NEW API key is issued on every run (the secret is shown only once).`;

const a = parseArgs(process.argv.slice(2));
if (a.help || a.h) { console.log(HELP); process.exit(0); }

const cfg = {
  core: a.core ?? 'http://127.0.0.1:3001',
  origin: a.origin ?? 'http://localhost:3000',
  stream: a.stream ?? 'http://127.0.0.1:4000',
  email: a.email ?? 'demo-admin@nexusflag.local',
  password: a.password ?? 'demo-admin-password-1',
  slug: a.workspace ?? 'juice-shop-demo',
  minSamples: Number(a['min-samples'] ?? 30),
  cooldown: Number(a.cooldown ?? 60),
  flagKey: 'new-delivery-pricing', // must match the key in routes/order.ts
  projectName: 'Juice Shop',
  envName: 'development',
};
if (a.fresh) cfg.slug = `${cfg.slug}-${Date.now().toString(36)}`;
if (cfg.password.length < 15) { console.error('password must be at least 15 characters'); process.exit(2); }
if (!Number.isInteger(cfg.minSamples) || cfg.minSamples < 1 || !Number.isInteger(cfg.cooldown) || cfg.cooldown < 0) {
  console.error('invalid --min-samples / --cooldown'); process.exit(2);
}

const ruleBody = { description: 'Demo users (@demo.local)', conditions: { all: [{ attribute: 'demo', operator: 'EQ', value: true }] }, serve: { value: true } };
const policyBody = {
  schemaVersion: 1, metric: 'error_rate',
  trigger: { operator: 'GT', threshold: 0.05, unit: 'ratio' },   // ratio: 0.05 == 5 %
  recovery: { operator: 'LT', threshold: 0.02, unit: 'ratio' },  // informational only, never re-enables
  windowSeconds: 30, minSamples: cfg.minSamples, cooldownSeconds: cfg.cooldown, notify: [], escalationEnabled: false,
};

if (a['dry-run']) {
  console.log('DRY RUN - would use:', JSON.stringify({ ...cfg, password: '***' }, null, 2));
  console.log('flag rule:', JSON.stringify(ruleBody));
  console.log('policy   :', JSON.stringify(policyBody));
  console.log('output   :', ENV_FILE);
  process.exit(0);
}

const step = (s) => console.log(`[provision] ${s}`);
const items = (r) => r?.items ?? [];

try {
  const core = new Core({ core: cfg.core, origin: cfg.origin, email: cfg.email, password: cfg.password });
  step(`signing in as ${cfg.email}`);
  await core.authenticate(step);

  let ws = items(await core.get('/workspaces?schemaVersion=1&limit=100')).find((w) => w.slug === cfg.slug);
  if (ws) step(`workspace exists: ${ws.workspaceId}`);
  else { ws = await core.post('/workspaces', { schemaVersion: 1, name: 'Juice Shop Demo', slug: cfg.slug }); step(`POST /workspaces -> ${ws.workspaceId}`); }
  const workspaceId = String(ws.workspaceId);

  const projBase = `/workspaces/${workspaceId}/projects`;
  let proj = items(await core.get(`${projBase}?schemaVersion=1&limit=100`)).find((p) => p.name === cfg.projectName);
  if (proj) step(`project exists: ${proj.projectId}`);
  else { proj = await core.post(projBase, { schemaVersion: 1, name: cfg.projectName }); step(`POST ${projBase} -> ${proj.projectId}`); }
  const projectId = String(proj.projectId);

  const envBase = `${projBase}/${projectId}/environments`;
  let env = items(await core.get(`${envBase}?schemaVersion=1&limit=100`)).find((e) => e.name === cfg.envName);
  if (env) step(`environment exists: ${env.environmentId}`);
  else { env = await core.post(envBase, { schemaVersion: 1, name: cfg.envName }); step(`POST ${envBase} -> ${env.environmentId}`); }
  const environmentId = String(env.environmentId);

  const flagBase = `${envBase}/${environmentId}/flags`;
  let flag = items(await core.get(`${flagBase}?schemaVersion=1&limit=100`)).find((f) => f.flagKey === cfg.flagKey);
  if (flag) step(`flag ${cfg.flagKey} exists: ${flag.flagId} (left as is; use --fresh for a pristine one)`);
  else {
    flag = await core.post(flagBase, {
      schemaVersion: 1, flagKey: cfg.flagKey, valueType: 'BOOLEAN', enabled: false, defaultValue: false,
      description: 'New delivery pricing: free delivery for orders of 50 or more (Juice Shop demo)', rules: [ruleBody],
    });
    step(`POST ${flagBase} -> ${flag.flagId} (OFF, rule: demo EQ true -> true)`);
  }
  const flagId = String(flag.flagId);

  const polBase = `${flagBase}/${flagId}/policies`;
  let policy = items(await core.get(`${polBase}?schemaVersion=1&limit=100`)).find((p) => p.metric === 'error_rate');
  if (policy) step(`policy exists: ${policy.policyId} (mode ${policy.mode})`);
  else { policy = await core.post(polBase, policyBody); step(`POST ${polBase} -> ${policy.policyId} (born ADVISORY)`); }
  const policyId = String(policy.policyId);
  if (policy.mode !== 'AUTONOMOUS') {
    const detail = await core.get(`${polBase}/${policyId}`);
    const promoted = await core.post(`${polBase}/${policyId}/promote`, { schemaVersion: 1, expectedRevision: detail.revision ?? policy.revision ?? 1 });
    step(`POST .../promote -> mode ${promoted?.mode ?? 'AUTONOMOUS'}`);
  }

  const issued = await core.post(`${envBase}/${environmentId}/api-keys`, { schemaVersion: 1, label: `juice-shop-${new Date().toISOString().slice(0, 19)}` });
  if (!issued?.secret) throw new Error(`api-key response had no secret: ${JSON.stringify(issued)}`);
  step(`POST .../api-keys -> key ${mask(issued.secret)} (full value only in .env.demo)`);

  writeEnvFile({
    NEXUSFLAG_API_KEY: issued.secret,
    NEXUSFLAG_BASE_URL: cfg.core,
    NEXUSFLAG_STREAM_URL: cfg.stream,
    NEXUSFLAG_FLAG_KEY: cfg.flagKey,
    DEMO_CORE_URL: cfg.core, DEMO_ORIGIN: cfg.origin,
    DEMO_ADMIN_EMAIL: cfg.email, DEMO_ADMIN_PASSWORD: cfg.password,
    DEMO_WORKSPACE_ID: workspaceId, DEMO_PROJECT_ID: projectId, DEMO_ENVIRONMENT_ID: environmentId,
    DEMO_FLAG_ID: flagId, DEMO_POLICY_ID: policyId,
  });
  step(`wrote ${ENV_FILE}`);
  console.log(`\nDone. Dashboard login: ${cfg.email} (workspace slug ${cfg.slug}). Next: node start-shop.mjs`);
} catch (e) {
  console.error(`[provision] FAILED: ${e.message}`);
  if (e instanceof CoreError && e.status === 409) console.error('[provision] 409 conflict: the slug/name is probably owned by another account; retry with --fresh');
  process.exit(1);
}
