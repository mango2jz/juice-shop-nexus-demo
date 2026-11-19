#!/usr/bin/env node
// Checkout load generator for the Juice Shop demo. Prints one status line per second and announces the
// containment time (first 5xx -> the shop starts answering with X-Checkout-Version v1 again).
// For a full-screen live table of the same numbers, use dashboard.mjs.
import { TRAFFIC_OPTIONS, parseTrafficArgs, runPlain } from './traffic-engine.mjs'

const HELP = `Usage: node traffic.mjs [options]
${TRAFFIC_OPTIONS}
While running, type a number (e.g. 0.3) + Enter to change the bad ratio ("ship the bug").`

const { a, cfg, error } = parseTrafficArgs(process.argv.slice(2))
if (a.help || a.h) {
  console.log(HELP)
  process.exit(0)
}
if (error) {
  console.error(error)
  process.exit(2)
}
if (a['dry-run']) {
  console.log('DRY RUN', JSON.stringify(cfg))
  process.exit(0)
}

await runPlain(cfg)
