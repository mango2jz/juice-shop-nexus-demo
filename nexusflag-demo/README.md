# NexusFlag x Juice Shop demo runbook

OWASP Juice Shop is the demo "customer application". The business story:

> The shop launches **new delivery pricing: free delivery for orders of 50¤ or more**. The release is behind the
> feature flag `new-delivery-pricing`. The new code has a bug: it forgets that a chosen delivery option might not
> exist, so those checkouts fail. NexusFlag notices the failure rate, switches the feature off by itself within
> about 35 seconds, and every customer is back on the current pricing. Nobody had to redeploy.

The whole feature is one `if/else` in `routes/order.ts`, readable without knowing the rest of the project:

```ts
// ===== NexusFlag demo: feature flag "new-delivery-pricing" =====
let deliveryAmount: number
if (isFeatureOn('new-delivery-pricing', req, res)) {
  // NEW pricing: delivery is free for orders of 50¤ or more
  const chosenDelivery = await DeliveryModel.findOne({ where: { id: req.body.orderDetails?.deliveryMethodId } })
  const deliveryFee = chosenDelivery!.price // planted bug: forgets that the chosen delivery option may not exist
  deliveryAmount = totalPrice >= 50 ? 0 : deliveryFee
} else {
  // CURRENT pricing: the customer pays the price of the chosen delivery option
  deliveryAmount = security.isDeluxe(req) ? deliveryMethod.deluxePrice : deliveryMethod.price
}
```

The flag is ON only for `@demo.local` shoppers. Requests that take the NEW branch are reported to NexusFlag
(failed = HTTP 5xx). A rollback policy (`error_rate` > 5% over 30 s, AUTONOMOUS) makes AutoPilot disable the flag.
Responses carry `X-Checkout-Version: v2` (new pricing) or `v1` (current pricing) so `traffic.mjs` can show the flip.

**The 500 is a planted bug, not an attack.** `deliveryMethodId:"999"` (an option that does not exist) is just a
request the new code mishandles; the current pricing handles it fine. Nothing in this demo exploits Juice Shop's
intentional vulnerabilities.

## Layout

This fork and the NexusFlag monorepo are two separate checkouts. The shop loads the NexusFlag Node SDK at runtime
from the NexusFlag checkout; the SDK is not an npm dependency of the shop.

```
WebstormProjects/
├── NexusFlag/                 # platform: core-api, streaming, dashboard, packages/sdk-node
└── juice-shop-nexus-demo/     # this fork
    └── nexusflag-demo/        # these scripts (run them from here)
```

The default SDK location is `../NexusFlag/packages/sdk-node` relative to the shop root. If your NexusFlag checkout
lives elsewhere, pass `--sdk <path>` to `start-shop.mjs` or set `NEXUSFLAG_SDK_PATH`.

## Ports

| Service | Port |
| --- | --- |
| Dashboard | 3000 |
| Core API (embedded mode also serves streaming in-process) | 3001 |
| Streaming | 4000 |
| Juice Shop | 3100 |
| Postgres (Docker) | 5432 |

All bind to loopback. Juice Shop is deliberately vulnerable: do not expose 3100 beyond localhost.

## One-time setup

**Requirements:** Docker, Node >= 22.22.3 with npm 11 (the Angular build rejects 22.22.2; npm 10 crashes on the
frontend install), pnpm 11.

1. NexusFlag: dependencies, packages and the SDK (in `NexusFlag/`):
   ```bash
   pnpm install
   pnpm build:packages
   pnpm sdk:build
   ```
   `pnpm sdk:build` must leave `packages/sdk-node/dist/index.js`; the shop refuses to start without it.

2. Postgres and schema (in `NexusFlag/`):
   ```bash
   docker compose -f deploy/docker-compose.db.yml up -d
   DATABASE_URL=postgresql://nexusflag:nexusflag@localhost:5432/nexusflag pnpm --filter @nexusflag/core-api exec prisma migrate deploy
   ```

3. Juice Shop install and build (in `juice-shop-nexus-demo/`). Takes several minutes: `postinstall` installs and
   builds the Angular frontend, then compiles the server.
   ```bash
   npm install
   ```
   Done when `build/app.js` exists.

## Run the demo

Use one terminal per long-running process.

**Terminal 1: platform, embedded mode, AutoPilot on** (in `NexusFlag/`):
```bash
DATABASE_URL=postgresql://nexusflag:nexusflag@localhost:5432/nexusflag \
GOOGLE_AUTH_DISABLED=true \
AUTOPILOT_ENABLED=true \
pnpm dev:embedded
```
Takes 1 to 2 minutes (it builds packages first). Ready when `curl localhost:3001` and `curl localhost:4000` answer;
404 is fine because `GET /` has no route. These variables replace `apps/core-api/.env`, which is not needed.
**`AUTOPILOT_ENABLED` defaults to false; without it nothing is ever disabled.**

**Terminal 2: dashboard** (in `NexusFlag/`, optional for the CLI loop, needed to show the incident):
```bash
pnpm --filter @nexusflag/dashboard dev
```

**Terminal 3: provision, then the shop** (in `juice-shop-nexus-demo/nexusflag-demo/`):
```bash
node provision.mjs
node start-shop.mjs
```
`provision.mjs` creates (or reuses) the admin account, workspace `juice-shop-demo`, project, environment, flag
`new-delivery-pricing` (OFF), the rollback policy promoted to AUTONOMOUS, and a new API key. It writes `.env.demo`.
Provision once per database; re-running issues a new key, so restart the shop afterwards.

The shop log must say `client ready (bootstrapped, seq N, transport streaming)`.
`client NOT bootstrapped` means it serves v1 fallbacks: the platform is down or the key is wrong.
Always start the shop with `start-shop.mjs`. Plain `npm start` has no API key and runs as stock Juice Shop.

**Terminal 4: the scenario** (in `juice-shop-nexus-demo/nexusflag-demo/`):
```bash
node traffic.mjs --duration 30        # baseline: flag OFF, current pricing (v1), the "999" requests succeed
node flag.mjs on                      # release the new delivery pricing
node traffic.mjs --bad-ratio 0.10     # ~10% of new-pricing checkouts now fail, above the 5% trigger
```
Within about 35 s of the first 5xx (30 s window + 5 s hop) the traffic line prints `##### CONTAINED ... #####`
and the version split flips back to v1. The NexusFlag web dashboard (http://localhost:3000) shows the incident.

Alternative: start `traffic.mjs --bad-ratio 0 --duration 0`, then type `0.3` + Enter to "ship the bug" live.

**Live dashboard (recommended for presenting):** run the same load as a full-screen table instead of scrolling lines:
```bash
node dashboard.mjs --duration 0          # same options as traffic.mjs
```
It shows totals, the 30 s error rate against the 5% trigger, the v1/v2 split, sparklines, one row per second with the
same numbers as the `traffic.mjs` status line, and an events pane (CONTAINED, bad-ratio changes).
Keys: `q` quit (Ctrl+C twice forces), `↑`/`↓` bad ratio ±0.05, `0`-`9` bad ratio 0.0-0.9, `b` bad ratio 0, `p` pause,
`c` clear events. Needs at least 60x16. `--ascii` for consoles without box-drawing glyphs (old Windows `cmd.exe`
fonts), `--no-color` or `NO_COLOR=1` for monochrome, `--plain` (or piping the output) prints the classic lines.
Runs on macOS and Windows (Windows Terminal / PowerShell 7 recommended).

**Recover** (human action, audited, UC-31):
```bash
node flag.mjs status      # flag state, policy mode, active incident
node flag.mjs reenable    # 409 COOLDOWN_ACTIVE until the cooldown (default 60 s after containment) has passed
```
After the cooldown the incident becomes RESOLVED and the flag is ON again.

## Seeing it in the dashboard

Open http://localhost:3000 and sign in as `demo-admin@nexusflag.local` (password `demo-admin-password-1` unless you
passed `--password`; it is also in `.env.demo`). Select workspace `juice-shop-demo`. The flag, its policy, the
incident and the AutoPilot config version appear there. The shop only shows up as a connected SDK instance while
`start-shop.mjs` is running with the current key.

The dashboard and the scripts must target the same Core (same `DATABASE_URL`), and `--origin` (default
`http://localhost:3000`) must equal Core's `DASHBOARD_ORIGIN`.

## Browser variant

Log in at http://127.0.0.1:3100 as a `shopperNN@demo.local` user (`traffic.mjs` registers them, password
`Demo-shopper-pw-1!`) and paste `console-snippet.js` into the devtools console.

## Stop everything

```bash
lsof -ti tcp:3000,3001,4000,3100 -sTCP:LISTEN | xargs kill
docker compose -f deploy/docker-compose.db.yml stop       # in NexusFlag/
```
Windows: `Get-NetTCPConnection -LocalPort 3100 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`
(same for 3000/3001/4000).

## Script reference

| Script | Purpose | Key options |
| --- | --- | --- |
| `provision.mjs` | Create workspace/project/env/flag/policy, issue API key, write `.env.demo` | `--core`, `--origin`, `--stream`, `--email`, `--password`, `--workspace`, `--min-samples` (30), `--cooldown` (60), `--fresh`, `--dry-run` |
| `start-shop.mjs` | Run `node build/app` on 3100 with the `NEXUSFLAG_*` keys from `.env.demo` | `--port`, `--sdk`, `--dry-run` |
| `traffic.mjs` | Checkout load; reports version split and containment time | `--shop`, `--users` (20), `--rps` (5), `--bad-ratio` (0.10), `--duration` (120, 0 = forever), `--seed` |
| `dashboard.mjs` | Full-screen live view of the same checkout load (htop-style table, keys to change bad ratio) | traffic.mjs options plus `--plain`, `--ascii`, `--no-color` |
| `flag.mjs` | `on`, `off`, `status`, `reenable` | `--core`, `--origin`, `--dry-run` |

Every script prints its full help with `--help`.

Self-tests for the dashboard and load engine (no network, uses a stub shop): `node --test nexusflag-demo/test/` from the shop root.

## Measured (real run, embedded mode, defaults, `--bad-ratio 0.12`)

- Containment: 27.8 s and 26.0 s after the first 5xx (target <= 35 s). After the flip the same bad requests return 200 on `v1`.
- Evidence in Core: incident `CONTAINED` (actor AutoPilot, error rate ~0.127, Wilson low 0.08), config_version cause `AUTOPILOT`, audit row actor `AUTOPILOT`.
- Below threshold: `--bad-ratio 0.03` for 65 s gave 2.8% overall, max 4.0% per 30 s, and the flag stayed ON.

These numbers come from the earlier in-monorepo version, which switched the whole checkout instead of the delivery
block. The flag, policy, traffic and failure pattern are the same; re-measure before quoting them.

## Facts worth knowing

- `error_rate` threshold is a **fraction** (unit `ratio`, 0..1): 5% is `0.05`.
- Policies are born ADVISORY; `provision.mjs` promotes via the Admin-only `/promote` call.
- `--fresh` creates a new workspace (new slug) with its own flag and policy. Use it when the DB holds other data or
  the slug belongs to another account.
- Flag state lives in Postgres. The shop's own SQLite DB is recreated on every shop start (`traffic.mjs` re-registers users).
- `.env.demo` holds the API key and admin password and is gitignored (`nexusflag-demo/.gitignore`). Never commit it.
  The shop process only receives the `NEXUSFLAG_*` keys.

## What is patched in Juice Shop

| File | Change |
| --- | --- |
| `lib/nexusflag.ts` | New. SDK loader, `isFeatureOn(flagKey, req, res)` (evaluate for the signed-in shopper, tag the response, report the outcome when ON), stock top-up. The only file that knows the SDK. |
| `routes/order.ts` | The delivery-price block wrapped in the `new-delivery-pricing` flag (shown above). Everything else in checkout is stock. |
| `server.ts` | Lines marked `// NexusFlag demo:`: SDK init before listen, loopback bind (`HOST`), SDK close on shutdown. The checkout route is stock. |
| `nexusflag-demo/` | New. These scripts and this runbook. |

`routes/order.ts` is untouched. Without `NEXUSFLAG_API_KEY` or a loadable SDK the shop behaves like stock Juice Shop.

## Troubleshooting

- **`NexusFlag SDK not built at ...`**: run `pnpm sdk:build` in NexusFlag, or point `--sdk` at its `packages/sdk-node`.
- **`Shop not built`**: run `npm install` in the shop root and wait for `build/app.js`.
- **Nothing is ever disabled**: `AUTOPILOT_ENABLED` is not true in the Core process (check its startup log).
- **Incident appears but flag stays on**: policy still ADVISORY (`node flag.mjs status`; re-run provision), or below
  `minSamples` (default 30 in the 30 s window: raise `--rps`/`--users`, or provision with a lower `--min-samples`).
- **Workspace autonomy suspended** (circuit breaker, other flags breaching): reset it from the dashboard.
- **Shop shows only `v1` after `flag on`**: shop started without `.env.demo` (log says `NEXUSFLAG_API_KEY not set`),
  old API key after re-provisioning, user is not `@demo.local`, or Core/streaming unreachable (restart the shop).
- **Dashboard shows nothing**: wrong workspace selected, signed in as another user, or the dashboard points at a
  different Core/DB than the one you provisioned.
- **provision: 403/Origin errors**: `--origin` must equal Core's `DASHBOARD_ORIGIN`. **409**: use `--fresh`.
- **traffic: "no shopper could log in"**: shop not running on the `--shop` URL.
