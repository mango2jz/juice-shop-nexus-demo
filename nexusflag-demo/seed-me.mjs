#!/usr/bin/env node
// Re-creates your test shopper after a Juice Shop restart. Juice Shop drops every table on start
// (server.ts: sequelize.sync({ force: true })), so accounts, addresses and cards do not survive.
// Run this once after each start. It is idempotent: an existing account, address or card is kept.
//
// Juice Shop is deliberately vulnerable. Use made-up details only, never a real password or card.
import { parseArgs } from './common.mjs'

const HELP = `Usage: node seed-me.mjs [options]
  --shop <url>        Juice Shop base URL           (default http://127.0.0.1:3100)
  --email <addr>      account to (re)create         (default me@demo.local)
  --password <pw>     account password              (default $SEED_PASSWORD, else the demo shopper password)
  --name <text>       name on address and card      (default Demo Tester)
Emails ending in @demo.local get the new delivery pricing (flag rule demo EQ true); use another domain for stock pricing.`

const a = parseArgs(process.argv.slice(2))
if (a.help || a.h) { console.log(HELP); process.exit(0) }

const SHOP = String(a.shop ?? 'http://127.0.0.1:3100').replace(/\/$/, '')
const EMAIL = String(a.email ?? 'me@demo.local')
const PASSWORD = String(a.password ?? process.env.SEED_PASSWORD ?? 'Demo-shopper-pw-1!')
const NAME = String(a.name ?? 'Demo Tester')

// Fake test data that passes the Juice Shop model validators (models/address.ts, models/card.ts).
const ADDRESS = { fullName: NAME, mobileNum: 9876543210, zipCode: '70000', streetAddress: '1 Demo Street', city: 'Ho Chi Minh City', state: 'HCM', country: 'Vietnam' }
const CARD = { fullName: NAME, cardNum: 4111111111111111, expMonth: 12, expYear: 2099 }

async function http (method, path, { token, body } = {}) {
  const headers = { accept: 'application/json' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(SHOP + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  let json
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

async function login () {
  return http('POST', '/rest/user/login', { body: { email: EMAIL, password: PASSWORD } })
}

try {
  let r = await login()
  let created = false
  if (r.status !== 200) {
    const reg = await http('POST', '/api/Users', { body: { email: EMAIL, password: PASSWORD, passwordRepeat: PASSWORD, securityQuestion: { id: 1 }, securityAnswer: 'demo' } })
    if (reg.status !== 201 && reg.status !== 200) throw new Error(`register ${EMAIL} -> ${reg.status} ${JSON.stringify(reg.json?.message ?? reg.json?.errors ?? '')}`)
    created = true
    r = await login()
  }
  if (r.status !== 200) throw new Error(`login ${EMAIL} -> ${r.status} (wrong --password for an existing account?)`)
  const token = r.json.authentication.token
  console.log(`account  ${EMAIL}: ${created ? 'created' : 'already there'}`)

  const addrs = await http('GET', '/api/Addresss', { token })
  if ((addrs.json?.data ?? []).some((x) => x.streetAddress === ADDRESS.streetAddress)) {
    console.log('address  already there')
  } else {
    const add = await http('POST', '/api/Addresss', { token, body: ADDRESS })
    if (add.status !== 201 && add.status !== 200) throw new Error(`add address -> ${add.status}`)
    console.log(`address  added: ${ADDRESS.streetAddress}, ${ADDRESS.city}`)
  }

  const cards = await http('GET', '/api/Cards', { token })
  if ((cards.json?.data ?? []).some((x) => String(x.cardNum).endsWith(String(CARD.cardNum).slice(-4)))) {
    console.log('card     already there')
  } else {
    const add = await http('POST', '/api/Cards', { token, body: CARD })
    if (add.status !== 201 && add.status !== 200) throw new Error(`add card -> ${add.status}`)
    console.log(`card     added: test card ending ${String(CARD.cardNum).slice(-4)}, exp ${CARD.expMonth}/${CARD.expYear}`)
  }
  console.log(`done. Log in at ${SHOP} as ${EMAIL}.`)
} catch (e) {
  console.error(`seed failed: ${e.cause?.code === 'ECONNREFUSED' ? `shop not reachable at ${SHOP}. Is it running?` : e.message}`)
  process.exit(1)
}
