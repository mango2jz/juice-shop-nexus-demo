#!/usr/bin/env node
// Checkout load generator for the Juice Shop demo. Prints one status line per second and announces the
// containment time (first 5xx -> the shop starts answering with X-Checkout-Version v1 again).
import readline from 'node:readline'
import {parseArgs} from './common.mjs'

const HELP = `Usage: node traffic.mjs [options]
  --shop <url>        Juice Shop base URL            (default http://127.0.0.1:3100)
  --users <n>         accounts shopper01@demo.local.. (default 20)
  --rps <n>           checkouts per second overall    (default 5)
  --bad-ratio <0..1>  share sent with deliveryMethodId "999" (default 0.10)
  --duration <sec>    0 = until Ctrl+C                (default 120)
  --seed <n>          RNG seed for the bad/good choice (default 1)
  --dry-run           print the effective settings and exit
While running, type a number (e.g. 0.3) + Enter to change the bad ratio ("ship the bug").`

const a = parseArgs(process.argv.slice(2))
if (a.help || a.h) {
    console.log(HELP)
    process.exit(0)
}
const cfg = {
    shop: String(a.shop ?? 'http://127.0.0.1:3100').replace(/\/$/, ''),
    users: Number(a.users ?? 20), rps: Number(a.rps ?? 5), bad: Number(a['bad-ratio'] ?? 0.10),
    duration: Number(a.duration ?? 120), seed: Number(a.seed ?? 1),
}
for (const [k, v] of Object.entries(cfg)) {
    if (k !== 'shop' && !Number.isFinite(v)) {
        console.error(`invalid --${k}`)
        process.exit(2)
    }
}
if (cfg.users < 1 || cfg.rps <= 0 || cfg.bad < 0 || cfg.bad > 1) {
    console.error('need users>=1, rps>0, 0<=bad-ratio<=1')
    process.exit(2)
}
if (a['dry-run']) {
    console.log('DRY RUN', JSON.stringify(cfg))
    process.exit(0)
}

function mulberry32(seed) {
    let s = seed >>> 0
    return () => {
        s = (s + 0x6D2B79F5) >>> 0
        let t = s
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const rand = mulberry32(cfg.seed)
const PASSWORD = 'Demo-shopper-pw-1!'
// Orange Juice and neighbours: no limitPerUser, no small fixed quantity (config/default.yml); stock is topped up by the demo.
const PRODUCTS = [2, 3, 4, 5, 6]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function http(method, path, {token, body} = {}) {
    const headers = {accept: 'application/json'}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetch(cfg.shop + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
    })
    let json
    try {
        json = await res.json()
    } catch { /* not json */
    }
    return {status: res.status, version: res.headers.get('x-checkout-version'), json}
}

class Shopper {
    constructor(i) {
        this.email = `shopper${String(i).padStart(2, '0')}@demo.local`
        this.busy = false
        this.hasItem = false
    }

    async login() {
        let r = await http('POST', '/rest/user/login', {body: {email: this.email, password: PASSWORD}})
        if (r.status !== 200) {
            await http('POST', '/api/Users', {
                body: {
                    email: this.email,
                    password: PASSWORD,
                    passwordRepeat: PASSWORD,
                    securityQuestion: {id: 1},
                    securityAnswer: 'a'
                }
            })
            r = await http('POST', '/rest/user/login', {body: {email: this.email, password: PASSWORD}})
        }
        if (r.status !== 200) throw new Error(`login ${this.email} -> ${r.status}`)
        this.token = r.json.authentication.token
        this.bid = r.json.authentication.bid
        this.hasItem = false
    }

    async ensureItem() {
        if (this.hasItem) return true
        for (const p of PRODUCTS) {
            const r = await http('POST', '/api/BasketItems', {
                token: this.token,
                body: {BasketId: String(this.bid), ProductId: p, quantity: 1}
            })
            if (r.status === 200) {
                this.hasItem = true
                return true
            }
            if (r.status === 401) {
                await this.login()
            }
        }
        return false
    }
}

const stats = {total: 0, ok: 0, e5xx: 0, e4xx: 0, net: 0, v1: 0, v2: 0}
const recent = [] // { t, err } for the rolling 30 s error rate (network errors excluded)
let firstErrAt = null, lastVersion = null, seenV2 = false
const t0 = Date.now()
const elapsed = () => ((Date.now() - t0) / 1000)
let bad = cfg.bad

async function checkout(u) {
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
            r = await http('POST', `/rest/basket/${u.bid}/checkout`, {
                token: u.token,
                body: {orderDetails: {deliveryMethodId}}
            })
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
            if (r.status === 401) {
                await u.login().catch(() => {
                })
            }
        }
        recent.push({t: Date.now(), err: is5xx})
        if (is5xx && firstErrAt === null) firstErrAt = Date.now()
        if (r.version === 'v2') seenV2 = true
        if (r.version === 'v1' && lastVersion === 'v2' && seenV2 && firstErrAt !== null) {
            const secs = ((Date.now() - firstErrAt) / 1000).toFixed(1)
            console.log(`\n##### CONTAINED: checkout flipped v2 -> v1 ${secs}s after the first 5xx (elapsed ${elapsed().toFixed(1)}s) #####\n`)
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

console.log(`traffic: ${JSON.stringify(cfg)}  (type a ratio + Enter to change bad-ratio)`)
const users = Array.from({length: cfg.users}, (_, i) => new Shopper(i + 1))
let ready = 0
await Promise.all(users.map((u) => u.login().then(() => {
    ready++
}).catch((e) => console.error(`setup: ${e.message}`))))
const live = users.filter((u) => u.token)
if (!live.length) {
    console.error(`no shopper could log in at ${cfg.shop}. Is the shop running?`)
    process.exit(1)
}
console.log(`${ready}/${users.length} shoppers ready; starting`)

if (process.stdin.isTTY || process.stdin.readable) {
    const rl = readline.createInterface({input: process.stdin})
    rl.on('line', (line) => {
        let v = Number(line.trim())
        if (!line.trim() || !Number.isFinite(v)) return
        if (v > 1 && v <= 100) v /= 100
        if (v < 0 || v > 1) {
            console.log('ignored: ratio must be 0..1')
            return
        }
        bad = v
        console.log(`>>> bad ratio now ${bad}`)
    })
    rl.on('error', () => {
    })
}

let stop = false

function summary() {
    console.log(`\nDONE after ${elapsed().toFixed(0)}s: requests=${stats.total} 2xx=${stats.ok} 4xx=${stats.e4xx} 5xx=${stats.e5xx} net-errors=${stats.net} v1=${stats.v1} v2=${stats.v2}`)
}

process.on('SIGINT', () => {
    stop = true
})

const ticker = setInterval(() => {
    const now = Date.now()
    while (recent.length && now - recent[0].t > 30000) recent.shift()
    const rate = recent.length ? (recent.filter((x) => x.err).length / recent.length) : 0
    console.log(`t=${elapsed().toFixed(0).padStart(4)}s req=${stats.total} 2xx=${stats.ok} 5xx=${stats.e5xx} net=${stats.net} err30s=${(rate * 100).toFixed(1)}% v1/v2=${stats.v1}/${stats.v2} bad=${bad}`)
}, 1000)

let cursor = 0
const interval = 1000 / cfg.rps
let next = Date.now()
while (!stop && (cfg.duration === 0 || elapsed() < cfg.duration)) {
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
clearInterval(ticker);
await sleep(500);
summary();
process.exit(0);
