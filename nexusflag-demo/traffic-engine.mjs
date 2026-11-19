// Checkout load engine shared by traffic.mjs (line output) and dashboard.mjs (full-screen table).
// It never prints: callers subscribe to its events and read snapshot().
import { EventEmitter } from 'node:events'
import readline from 'node:readline'
import { parseArgs } from './common.mjs'

export const TRAFFIC_OPTIONS = `  --shop <url>        Juice Shop base URL            (default http://127.0.0.1:3100)
  --users <n>         accounts shopper01@demo.local.. (default 20)
  --rps <n>           checkouts per second overall    (default 5)
  --bad-ratio <0..1>  share sent with deliveryMethodId "999" (default 0.10)
  --duration <sec>    0 = until Ctrl+C                (default 120)
  --seed <n>          RNG seed for the bad/good choice (default 1)
  --dry-run           print the effective settings and exit`

/** Returns { a, cfg } or { a, error } for invalid options. */
export function parseTrafficArgs (argv) {
  const a = parseArgs(argv)
  const cfg = {
    shop: String(a.shop ?? 'http://127.0.0.1:3100').replace(/\/$/, ''),
    users: Number(a.users ?? 20),
    rps: Number(a.rps ?? 5),
    bad: Number(a['bad-ratio'] ?? 0.10),
    duration: Number(a.duration ?? 120),
    seed: Number(a.seed ?? 1)
  }
  for (const [k, v] of Object.entries(cfg)) {
    if (k !== 'shop' && !Number.isFinite(v)) return { a, error: `invalid --${k}` }
  }
  if (cfg.users < 1 || cfg.rps <= 0 || cfg.bad < 0 || cfg.bad > 1) {
    return { a, error: 'need users>=1, rps>0, 0<=bad-ratio<=1' }
  }
  return { a, cfg }
}

export const formatStatusLine = (s) =>
  `t=${s.t.toFixed(0).padStart(4)}s req=${s.req} 2xx=${s.ok} 5xx=${s.e5xx} net=${s.net} err30s=${(s.err30s * 100).toFixed(1)}% v1/v2=${s.v1}/${s.v2} bad=${s.bad}`

export const formatSummary = (s) =>
  `DONE after ${s.t.toFixed(0)}s: requests=${s.req} 2xx=${s.ok} 4xx=${s.e4xx} 5xx=${s.e5xx} net-errors=${s.net} v1=${s.v1} v2=${s.v2}`

export const formatContained = ({ secs, elapsed }) =>
  `##### CONTAINED: checkout flipped v2 -> v1 ${secs.toFixed(1)}s after the first 5xx (elapsed ${elapsed.toFixed(1)}s) #####`

function mulberry32 (seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PASSWORD = 'Demo-shopper-pw-1!'
// Orange Juice and neighbours: no limitPerUser, no small fixed quantity (config/default.yml); stock is topped up by the demo.
const PRODUCTS = [2, 3, 4, 5, 6]
const HISTORY_LIMIT = 120
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Events: ready {ready,total} · setup-error {message} · contained {secs,elapsed} · tick (snapshot) · done (snapshot).
 * start() resolves with the final snapshot, or rejects when no shopper could log in.
 */
export function createTraffic (cfg) {
  const events = new EventEmitter()
  const rand = mulberry32(cfg.seed)

  async function http (method, path, { token, body } = {}) {
    const headers = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetch(cfg.shop + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    })
    let json
    try { json = await res.json() } catch { /* not json */ }
    return { status: res.status, version: res.headers.get('x-checkout-version'), json }
  }

  class Shopper {
    constructor (i) {
      this.email = `shopper${String(i).padStart(2, '0')}@demo.local`
      this.busy = false
      this.hasItem = false
    }

    async login () {
      let r = await http('POST', '/rest/user/login', { body: { email: this.email, password: PASSWORD } })
      if (r.status !== 200) {
        await http('POST', '/api/Users', {
          body: { email: this.email, password: PASSWORD, passwordRepeat: PASSWORD, securityQuestion: { id: 1 }, securityAnswer: 'a' }
        })
        r = await http('POST', '/rest/user/login', { body: { email: this.email, password: PASSWORD } })
      }
      if (r.status !== 200) throw new Error(`login ${this.email} -> ${r.status}`)
      this.token = r.json.authentication.token
      this.bid = r.json.authentication.bid
      this.hasItem = false
    }

    async ensureItem () {
      if (this.hasItem) return true
      for (const p of PRODUCTS) {
        const r = await http('POST', '/api/BasketItems', {
          token: this.token,
          body: { BasketId: String(this.bid), ProductId: p, quantity: 1 }
        })
        if (r.status === 200) {
          this.hasItem = true
          return true
        }
        if (r.status === 401) await this.login()
      }
      return false
    }
  }

  const stats = { total: 0, ok: 0, e5xx: 0, e4xx: 0, net: 0, v1: 0, v2: 0 }
  const recent = [] // { t, err } for the rolling 30 s error rate (network errors excluded)
  const history = []
  const containments = []
  let firstErrAt = null
  let lastVersion = null
  let seenV2 = false
  let t0 = Date.now()
  let bad = cfg.bad
  let err30s = 0
  let usersReady = 0
  let stopped = false
  let paused = false
  const elapsed = () => (Date.now() - t0) / 1000

  async function checkout (u) {
    u.busy = true
    try {
      if (!(await u.ensureItem())) {
        stats.net++
        return
      }
      const badReq = rand() < bad
      const deliveryMethodId = badReq ? '999' : String(1 + Math.floor(rand() * 3))
      let r
      try {
        r = await http('POST', `/rest/basket/${u.bid}/checkout`, { token: u.token, body: { orderDetails: { deliveryMethodId } } })
      } catch {
        stats.net++
        return
      }
      stats.total++
      if (r.version === 'v1') stats.v1++
      else if (r.version === 'v2') stats.v2++
      const is5xx = r.status >= 500
      if (r.status >= 200 && r.status < 300) {
        stats.ok++
        u.hasItem = false
      } else if (is5xx) {
        stats.e5xx++
      } else {
        stats.e4xx++
        if (r.status === 401) await u.login().catch(() => {})
      }
      recent.push({ t: Date.now(), err: is5xx })
      if (is5xx && firstErrAt === null) firstErrAt = Date.now()
      if (r.version === 'v2') seenV2 = true
      if (r.version === 'v1' && lastVersion === 'v2' && seenV2 && firstErrAt !== null) {
        const c = { secs: (Date.now() - firstErrAt) / 1000, elapsed: elapsed() }
        containments.push(c)
        events.emit('contained', c)
        firstErrAt = null
        seenV2 = false
      }
      if (r.version) lastVersion = r.version
    } catch {
      stats.net++
    } finally {
      u.busy = false
    }
  }

  function snapshot () {
    return {
      t: elapsed(),
      req: stats.total,
      ok: stats.ok,
      e4xx: stats.e4xx,
      e5xx: stats.e5xx,
      net: stats.net,
      err30s,
      v1: stats.v1,
      v2: stats.v2,
      bad,
      paused,
      usersReady,
      usersTotal: cfg.users,
      lastVersion,
      containments: containments.slice(),
      history: history.slice()
    }
  }

  function tick () {
    const now = Date.now()
    while (recent.length && now - recent[0].t > 30000) recent.shift()
    err30s = recent.length ? (recent.filter((x) => x.err).length / recent.length) : 0
    const s = snapshot()
    history.push({ t: s.t, req: s.req, ok: s.ok, e5xx: s.e5xx, net: s.net, err30s: s.err30s, v1: s.v1, v2: s.v2, bad: s.bad })
    if (history.length > HISTORY_LIMIT) history.shift()
    s.history = history.slice()
    events.emit('tick', s)
  }

  async function start () {
    t0 = Date.now()
    const users = Array.from({ length: cfg.users }, (_, i) => new Shopper(i + 1))
    await Promise.all(users.map((u) => u.login()
      .then(() => { usersReady++ })
      .catch((e) => events.emit('setup-error', { message: e.message }))))
    const live = users.filter((u) => u.token)
    if (!live.length) throw new Error(`no shopper could log in at ${cfg.shop}. Is the shop running?`)
    events.emit('ready', { ready: usersReady, total: users.length })

    const ticker = setInterval(tick, 1000)
    let cursor = 0
    const interval = 1000 / cfg.rps
    let next = Date.now()
    while (!stopped && (cfg.duration === 0 || elapsed() < cfg.duration)) {
      if (paused) {
        await sleep(Math.min(interval, 100))
        next = Date.now()
        continue
      }
      next += interval
      for (let i = 0; i < live.length; i++) {
        const u = live[(cursor + i) % live.length]
        if (!u.busy) {
          cursor = (cursor + i + 1) % live.length
          void checkout(u)
          break
        }
      }
      const wait = next - Date.now()
      if (wait > 0) await sleep(wait)
      else if (wait < -2000) next = Date.now()
    }
    clearInterval(ticker)
    await sleep(500)
    const final = snapshot()
    events.emit('done', final)
    return final
  }

  return {
    start,
    stop () { stopped = true },
    pause () { paused = true },
    resume () { paused = false },
    get paused () { return paused },
    setBadRatio (v) { bad = v },
    snapshot,
    on (name, fn) { events.on(name, fn); return this }
  }
}

/** The original traffic.mjs behaviour: one status line per second, ratio typed on stdin. */
export async function runPlain (cfg) {
  const engine = createTraffic(cfg)
  engine.on('setup-error', ({ message }) => console.error(`setup: ${message}`))
  engine.on('ready', ({ ready, total }) => console.log(`${ready}/${total} shoppers ready; starting`))
  engine.on('contained', (c) => console.log(`\n${formatContained(c)}\n`))
  engine.on('tick', (s) => console.log(formatStatusLine(s)))

  console.log(`traffic: ${JSON.stringify(cfg)}  (type a ratio + Enter to change bad-ratio)`)
  engine.on('ready', () => {
    if (!(process.stdin.isTTY || process.stdin.readable)) return
    const rl = readline.createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      let v = Number(line.trim())
      if (!line.trim() || !Number.isFinite(v)) return
      if (v > 1 && v <= 100) v /= 100
      if (v < 0 || v > 1) {
        console.log('ignored: ratio must be 0..1')
        return
      }
      engine.setBadRatio(v)
      console.log(`>>> bad ratio now ${v}`)
    })
    rl.on('error', () => {})
  })
  process.on('SIGINT', () => engine.stop())

  let final
  try {
    final = await engine.start()
  } catch (e) {
    process.stderr.write(e.message + '\n', () => process.exit(1))
    return
  }
  process.stdout.write(`\n${formatSummary(final)}\n`, () => process.exit(0))
}
