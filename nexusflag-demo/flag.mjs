#!/usr/bin/env node
// node flag.mjs on|off|status|reenable  - drives the new-delivery-pricing flag through Core (needs .env.demo).
import { parseArgs, coreFromEnvFile, CoreError } from './common.mjs';

const a = parseArgs(process.argv.slice(2));
const cmd = a._[0];
const HELP = `Usage: node flag.mjs <on|off|status|reenable> [--core url] [--origin url] [--dry-run]
  on        enable the flag (the release moment; demo users start getting the new delivery pricing)
  off       disable the flag by hand
  status    print enabled/seq/policy mode/active incident
  reenable  human re-enable after an AutoPilot containment:
            POST /workspaces/:ws/incidents/:id/re-enable (audited, UC-31).
            Refused with 409 COOLDOWN_ACTIVE until the policy cooldown has passed.`;
if (a.help || a.h || !['on', 'off', 'status', 'reenable'].includes(cmd)) { console.log(HELP); process.exit(a.help || a.h ? 0 : 2); }
if (a['dry-run']) { console.log(`DRY RUN: would run "${cmd}" using .env.demo`); process.exit(0); }

const { env, core } = coreFromEnvFile(a);
const ws = env.DEMO_WORKSPACE_ID;
const base = `/workspaces/${ws}/projects/${env.DEMO_PROJECT_ID}/environments/${env.DEMO_ENVIRONMENT_ID}/flags/${env.DEMO_FLAG_ID}`;

async function show() {
  const d = await core.get(base);
  const pols = await core.get(`${base}/policies?schemaVersion=1&limit=100`);
  console.log(JSON.stringify({
    flagKey: d.flagKey, enabled: d.current?.enabled, seq: d.current?.seq, activeIncidentId: d.activeIncidentId ?? null,
    policies: (pols.items ?? []).map((p) => ({ metric: p.metric, mode: p.mode, revision: p.revision })),
  }, null, 2));
}
async function toggle(enabled) {
  const d = await core.get(base);
  if (d.current?.enabled === enabled) { console.log(`flag already ${enabled ? 'ON' : 'OFF'} (seq ${d.current.seq})`); return; }
  const r = await core.post(`${base}/toggle`, { schemaVersion: 1, expectedSeq: d.current.seq, enabled });
  console.log(`flag ${enabled ? 'ON' : 'OFF'} at ${new Date().toISOString()} (seq ${r?.current?.seq ?? '?'})`);
}

try {
  if (cmd === 'status') await show();
  else if (cmd === 'on') await toggle(true);
  else if (cmd === 'off') await toggle(false);
  else {
    const d = await core.get(base);
    let incidentId = d.activeIncidentId;
    if (!incidentId) {
      const l = await core.get(`/workspaces/${ws}/incidents?schemaVersion=1&limit=50&status=CONTAINED&flagId=${env.DEMO_FLAG_ID}`);
      incidentId = l.items?.[0]?.incidentId;
    }
    if (!incidentId) {
      console.log('no contained incident found; falling back to a plain toggle on');
      await toggle(true);
    } else {
      const r = await core.post(`/workspaces/${ws}/incidents/${incidentId}/re-enable`, { schemaVersion: 1 });
      console.log(`incident ${incidentId} re-enabled by a human; status ${r?.status ?? '?'}`);
    }
  }
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  if (e instanceof CoreError && e.status === 409) console.error('409: if COOLDOWN_ACTIVE, wait for reEnableAvailableAt (policy cooldown) and retry.');
  process.exit(1);
}
