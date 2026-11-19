#!/usr/bin/env node
// htop-style traffic dashboard. render() is a pure view: (snapshot, events, size/options) -> exactly `rows` lines
// of exactly `cols` visible columns. The runtime (args, keys, screen loop) lives below the main guard.

import { realpathSync } from 'node:fs'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { fit, visibleLen, bar, spark, glyphs, makeColor, colorEnabled, enter, restore } from './tui.mjs'
import { TRAFFIC_OPTIONS, parseTrafficArgs, createTraffic, runPlain, formatSummary, formatContained } from './traffic-engine.mjs'

export const MIN_COLS = 60
export const MIN_ROWS = 16
export const ROOMY_COLS = 100
export const ROOMY_ROWS = 30
const LEGEND = 'New pricing (v2) has a bug. NexusFlag turns it off if Fail rate (30 s) > 5%.'

const errTone = (e) => (e > 0.05 ? 'red' : e >= 0.02 ? 'yellow' : 'green')
const pct = (x) => `${(x * 100).toFixed(1)}%`
const mmss = (t) => {
  const s = Math.max(0, Math.floor(t))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function notice (cols, rows) {
  const msg = `enlarge terminal (need ${MIN_COLS}x${MIN_ROWS}, have ${cols}x${rows})`
  const mid = Math.floor(rows / 2)
  return Array.from({ length: rows }, (_, i) => {
    if (i !== mid) return ' '.repeat(cols)
    const m = msg.slice(0, cols)
    return fit(' '.repeat(Math.floor((cols - m.length) / 2)) + m, cols)
  })
}

export function render (snap, events, { cols, rows, ascii = false, color = false, shop = '', rps = 0, flash = false, badge = '' }) {
  if (cols < MIN_COLS || rows < MIN_ROWS) return notice(cols, rows)
  const g = glyphs(ascii)
  const c = makeColor(color)
  const w = cols - 2
  const hist = snap.history ?? []
  const eventsN = rows >= 30 ? 6 : rows >= 20 ? 4 : 2
  const big = rows >= 20 && w >= 78
  const tableN1 = rows - (big ? 13 : 12) - eventsN

  const row = (s) => g.v + fit(s, w) + g.v
  const rule = (l, r, left, right = '') => {
    const fill = Math.max(1, w - visibleLen(left) - visibleLen(right))
    return fit(l + left + g.h.repeat(fill) + right + r, cols)
  }

  const delta = (i, k) => hist[i][k] - (i > 0 ? hist[i - 1][k] : 0)
  const last = hist.length - 1
  const actualRps = last >= 0 ? delta(last, 'req') : 0

  const secs = String(Math.round(snap.t)).padStart(4)
  const titleBase = w < 70 ? ' NexusFlag demo ' : ` NexusFlag demo ${g.dot} traffic `
  const tShort = ` ${secs}s `
  const room = w - titleBase.length - tShort.length - 2
  const badgeTxt = badge && room >= 6 ? ` ${badge} `.slice(0, room) : ''
  const titleL = titleBase + (flash ? c('inverse+red', ' CONTAINED ') : badgeTxt ? c('bold+green', badgeTxt) : '')
  const tFull = ` elapsed ${secs}s ${g.dot} `
  const tPart = visibleLen(titleL) + tFull.length + 2 > w ? tShort : tFull
  const shopRoom = Math.max(0, w - visibleLen(titleL) - 1 - tPart.length - 1)
  const shopTxt = shop.length > shopRoom ? shop.slice(0, Math.max(0, shopRoom - 1)) + (shopRoom > 0 ? (ascii ? '~' : '…') : '') : shop
  const top = rule(g.tl, g.tr, titleL, tPart + shopTxt + ' ')
  const legend = big ? [row(c('dim', ` ${LEGEND}`))] : []

  const e = snap.err30s
  const segs = [
    [`Checkouts ${snap.req}`], [`succeeded ${snap.ok}`], [`failed ${snap.e5xx}`, snap.e5xx > 0 ? 'red' : ''],
    [`no reply ${snap.net}`], [`rate ${actualRps.toFixed(1)}/s (target ${rps}/s)`], [`rejected (4xx) ${snap.e4xx}`]
  ]
  const shown = new Set()
  let used = 1
  segs.forEach(([txt], k) => {
    const need = txt.length + (shown.size ? 2 : 0)
    if (used + need <= w) { shown.add(k); used += need }
  })
  const rowA = ' ' + segs.map(([txt, tone], k) => (shown.has(k) ? c(tone, txt) : null)).filter((x) => x !== null).join('  ')

  const eTail = `  ${c(errTone(e), pct(e).padStart(5))}  ${g.up} auto-off at 5%`
  const barW = Math.max(5, Math.min(40, w - 20 - visibleLen(eTail)))
  const rowB = ` Fail rate (30 s) [${c(errTone(e), bar(e / 0.2, barW, g, 0.05 / 0.2))}]${eTail}`

  const tot = snap.v1 + snap.v2
  const c1 = String(snap.v1)
  const c2 = String(snap.v2)
  const narrow = w < 66
  const [lOld, lNew, serving] = narrow ? ['v1', 'v2', 'serving'] : ['old (v1)', 'new (v2)', 'serving:']
  const now = `${serving} ${snap.lastVersion === 'v2' ? 'new' : snap.lastVersion === 'v1' ? 'old' : '-'}`
  const pricing = (lead) => {
    const vBarW = Math.max(3, Math.min(14, Math.floor((w - (12 + lead.length + lOld.length + lNew.length + c1.length + c2.length + now.length + 6)) / 2)))
    const text = `${lead}${lOld} ${c('dim', bar(tot ? snap.v1 / tot : 0, vBarW, g))} ${c1}   ${lNew} ${c('cyan', bar(tot ? snap.v2 / tot : 0, vBarW, g))} ${c2}   ${now}`
    return { text, vBarW }
  }
  const pShort = pricing(' Pricing  ')
  const pLong = pricing(' Pricing (checkouts)  ')
  const rowC = visibleLen(pLong.text) <= w && pLong.vBarW === pShort.vBarW ? pLong.text : pShort.text

  const users = hist.length === 0 ? 'logging in' : `${snap.usersReady}/${snap.usersTotal} logged in`
  const rowD = ` Bug trigger ${snap.bad.toFixed(2)} of requests   shoppers ${users}` + (snap.paused ? '  ' + c('inverse+yellow', ' PAUSED ') : '')

  const sparkW = Math.max(1, w - 1 - 11 - 1 - 7)
  const errSeries = hist.map((h) => h.err30s)
  const shareSeries = hist.map((h, i) => {
    const d1 = delta(i, 'v1')
    const d2 = delta(i, 'v2')
    return d1 + d2 > 0 ? d2 / (d1 + d2) : 0
  })
  const sparkRow = (label, series, max, valueText, tone) =>
    ` ${label.padEnd(11)}${c(tone, spark(series, sparkW, g, max))} ${valueText}`
  const curErr = errSeries.length ? errSeries[errSeries.length - 1] : 0
  const curShare = shareSeries.length ? shareSeries[shareSeries.length - 1] : 0
  const rowE = sparkRow('fail rate', errSeries, Math.max(0.1, ...errSeries), c(errTone(curErr), pct(curErr).padStart(7)), errTone(curErr))
  const rowF = sparkRow('new (v2) %', shareSeries, 1, c('cyan', pct(curShare).padStart(7)), 'cyan')

  const compact = w < 66
  const abbr = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n))
  const cells = (h, f) => [`${h.t.toFixed(0)}s`, f(h.req), f(h.ok), f(h.e5xx), f(h.net), pct(h.err30s), `${f(h.v1)}/${f(h.v2)}`, h.bad.toFixed(2)]
  const names = ['sec', 'checkout requests', 'succeed', 'failed', 'no reply', 'fail rate 30s', 'Old/New price', 'bug rate']
  const splitName = (n) => { const i = n.lastIndexOf(' '); return i < 0 ? ['', n] : [n.slice(0, i), n.slice(i + 1)] }
  const wrapped = names.map(splitName)
  const buildTable = (shown, avail, gapMin, force) => {
    const tries = [[false, String], [true, String], [false, abbr], [true, abbr]]
    let lay = null
    for (const [wrap, f] of tries) {
      const heads = wrap ? [wrapped.map((x) => x[0]), wrapped.map((x) => x[1])] : [names]
      const data = shown.map((h) => cells(h, f))
      const cwid = names.map((_, k) => Math.max(...heads.map((hd) => hd[k].length), ...data.map((d) => d[k].length)))
      lay = { data, cwid, heads, sum: cwid.reduce((x, y) => x + y, 0) }
      if (lay.sum + 7 * gapMin <= avail) return lay
    }
    return force ? lay : null
  }
  const shownHist = hist.slice(Math.max(0, hist.length - tableN1))
  let lead = 1
  let lay = buildTable(shownHist, w - 1, 1)
  if (!lay) { lead = 0; lay = buildTable(shownHist, w, 1, true) }
  const gapC = Math.max(1, Math.min(3, Math.floor((w - lead - lay.sum) / 7)))
  const joinC = (cs) => ' '.repeat(lead) + cs.map((v, k) => v.padStart(lay.cwid[k])).join(' '.repeat(gapC))
  const headRows = lay.heads.map((hd) => row(joinC(hd)))
  const tableN = tableN1 - (lay.heads.length - 1)
  const tableRows = []
  for (let k = 0; k < tableN; k++) {
    const i = last - k
    if (i < 0) { tableRows.push(row('')); continue }
    const d = lay.data[shownHist.length - 1 - k]
    const cs = d.map((v, j) => v.padStart(lay.cwid[j]))
    cs[5] = c(errTone(hist[i].err30s), cs[5])
    tableRows.push(row(' '.repeat(lead) + cs.join(' '.repeat(gapC))))
  }

  const evRows = []
  for (let k = 0; k < eventsN; k++) {
    const ev = events[k]
    const line = ev ? ` ${mmss(ev.t)}  ${ev.text}` : ''
    evRows.push(row(ev?.kind === 'alert' ? c('red+bold', fit(line, w)) : line))
  }

  const helpFull = ascii
    ? ' q quit - Up/Down bug trigger +/-0.05 - 0-9 set 0.x - b bug off - p pause - c clear events '
    : ` q quit ${g.dot} ↑/↓ bug trigger ±0.05 ${g.dot} 0-9 set 0.x ${g.dot} b bug off ${g.dot} p pause ${g.dot} c clear events `
  const helpMid = ` q quit ${g.dot} ${ascii ? 'Up/Down' : '↑/↓'} trigger ${g.dot} 0-9 set ${g.dot} b off ${g.dot} p pause ${g.dot} c clear `
  const helpShort = ` q quit ${g.dot} p pause ${g.dot} c clear `
  const help = [helpFull, helpMid, helpShort].find((h) => h.length <= w - 2) ?? ' q quit '

  const tableTitle = ' checkout results, one row per second, newest on top '.length <= w - 1 ? ' checkout results, one row per second, newest on top ' : ' per second, newest on top '
  const sparkLabel = ` last ${Math.min(hist.length, sparkW)} s `
  if (cols >= ROOMY_COLS && rows >= ROOMY_ROWS) {
    const cw = w - 4
    const row2 = (t) => g.v + '  ' + fit(t, cw) + '  ' + g.v
    const blank = row2('')
    const LAB = 22
    const lab = (t) => c('dim', t.padEnd(LAB))

    const cellsA = [
      `${snap.req} total`, `${snap.ok} succeeded`, c(snap.e5xx > 0 ? 'red' : '', `${snap.e5xx} failed`), `${snap.net} no reply`,
      `${actualRps.toFixed(1)}/s  (target ${rps}/s)`
    ]
    const lensA = [`${snap.req} total`, `${snap.ok} succeeded`, `${snap.e5xx} failed`, `${snap.net} no reply`, `${actualRps.toFixed(1)}/s  (target ${rps}/s)`].map((x) => x.length)
    const shownA = new Set()
    let usedA = LAB
    for (const k of [0, 1, 2, 4, 3]) {
      if (usedA + lensA[k] <= cw) { shownA.add(k); usedA += lensA[k] + 3 }
    }
    const gridA = cellsA.map((x, k) => (shownA.has(k) ? x + ' '.repeat(3) : null)).filter((x) => x !== null)
    const sA = lab('Checkouts') + gridA.join('').trimEnd()

    const pctW = 7
    const eTail2 = `${c(errTone(e), pct(e).padStart(pctW))}     ${g.up} auto-off at 5%`
    const barW2 = Math.max(5, Math.min(40, cw - LAB - 2 - visibleLen(eTail2)))
    const sB = lab('Fail rate (30 s)') + `[${c(errTone(e), bar(e / 0.2, barW2, g, 0.05 / 0.2))}]${eTail2}`

    const n1 = c1.padEnd(Math.max(6, c1.length))
    const n2 = c2.padEnd(Math.max(6, c2.length))
    const bw = Math.max(3, Math.min(14, Math.floor((cw - LAB - 40 - n1.length - n2.length) / 2)))
    const sCmain = lab('Pricing (checkouts)') + `old (v1)  ${c('dim', bar(tot ? snap.v1 / tot : 0, bw, g))}  ${n1}  new (v2)  ${c('cyan', bar(tot ? snap.v2 / tot : 0, bw, g))}  ${n2}`
    const serv = `  serving: ${snap.lastVersion === 'v2' ? 'new' : snap.lastVersion === 'v1' ? 'old' : '-'}`
    const sC = visibleLen(sCmain + serv) <= cw ? sCmain + serv : sCmain

    const sD = lab('Bug trigger') + `${snap.bad.toFixed(2)} of requests`.padEnd(24) + `shoppers ${users}` + (snap.paused ? '  ' + c('inverse+yellow', ' PAUSED ') : '')

    const sw = Math.max(1, cw - LAB - 1 - 7)
    const sparkRow2 = (label, series, max, valueText, tone) => {
      const line = spark(series, sw, g, max)
      const pad = sw - Math.min(series.length, sw)
      return lab(label) + c('dim', g.spark[0].repeat(pad)) + c(tone, line.slice(pad)) + ' ' + valueText
    }
    const sE = sparkRow2('fail rate', errSeries, Math.max(0.1, ...errSeries), c(errTone(curErr), pct(curErr).padStart(7)), errTone(curErr))
    const sF = sparkRow2('new (v2) %', shareSeries, 1, c('cyan', pct(curShare).padStart(7)), 'cyan')
    const sparkTitle = ` last ${Math.min(hist.length, sw)} s `

    const shown2 = hist.slice(Math.max(0, hist.length - 20))
    const L = buildTable(shown2, cw, 3, true)
    const gap = Math.max(1, Math.min(6, Math.floor((cw - L.sum) / 7)))
    const joinCells = (cs) => cs.map((v, k) => v.padStart(L.cwid[k])).join(' '.repeat(gap))
    const tableW = L.sum + 7 * gap
    const headR = L.heads.map((hd) => row2(joinCells(hd)))
    const thin = row2(c('dim', g.h.repeat(Math.min(tableW, cw))))

    const spacers = ['E', 'C', 'D', 'B', 'A']
    const fixed = 13 + L.heads.length
    const keep = [...spacers]
    let evN = Math.max(3, Math.min(8, events.length))
    let tN = rows - fixed - keep.length - evN
    while (tN < 3 && keep.length) { keep.shift(); tN = rows - fixed - keep.length - evN }
    while (tN < 3 && evN > 2) { evN--; tN++ }
    let extra = 0
    if (tN > 20) {
      extra = tN - 20
      tN = 20
    }
    const has = (k) => keep.includes(k)
    const dataRows = []
    for (let k = 0; k < tN; k++) {
      const i = last - k
      if (i < 0) { dataRows.push(blank); continue }
      const d = L.data[shown2.length - 1 - k]
      const cs = d.map((v, j) => v.padStart(L.cwid[j]))
      cs[5] = c(errTone(hist[i].err30s), cs[5])
      dataRows.push(row2(cs.join(' '.repeat(gap))))
    }
    const evR = []
    for (let k = 0; k < evN; k++) {
      const ev = events[k]
      if (!ev) { evR.push(blank); continue }
      evR.push(row2(ev.kind === 'alert' ? c('red+bold', `${mmss(ev.t)}   ${ev.text}`) : `${c('dim', mmss(ev.t))}   ${ev.text}`))
    }
    const footerBlanks = (has('E') ? 1 : 0) + extra
    return [
      top,
      row2(c('dim', LEGEND)),
      ...(has('A') ? [blank] : []),
      row2(sA), row2(sB), row2(sC), row2(sD),
      ...(has('B') ? [blank] : []),
      rule(g.lt, g.rt, sparkTitle),
      row2(sE),
      ...(has('C') ? [blank] : []),
      row2(sF),
      rule(g.lt, g.rt, tableTitle),
      ...headR, thin,
      ...dataRows,
      ...(has('D') ? [blank] : []),
      rule(g.lt, g.rt, ' events '),
      ...evR,
      ...Array.from({ length: footerBlanks }, () => blank),
      rule(g.bl, g.br, help)
    ].map((l) => fit(l, cols))
  }


  return [
    top,
    ...legend,
    row(rowA), row(rowB), row(rowC), row(rowD),
    rule(g.lt, g.rt, sparkLabel),
    row(rowE), row(rowF),
    rule(g.lt, g.rt, tableTitle),
    ...headRows,
    ...tableRows,
    rule(g.lt, g.rt, ' events '),
    ...evRows,
    rule(g.bl, g.br, help)
  ].map((l) => fit(l, cols))
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false } })()

const HELP = `Usage: node dashboard.mjs [options]
${TRAFFIC_OPTIONS}
  --plain             line output instead of the full-screen dashboard (also used when stdout is not a terminal)
  --ascii             ASCII box drawing for legacy consoles (also used when TERM=dumb)
  --no-color          no ANSI colours (also honours NO_COLOR)
Keys: q or Ctrl+C quit (press again to quit now), Up/Down bad-ratio +/-0.05, 0-9 bad-ratio 0.x,
      b bad-ratio 0, p pause/resume, c clear events`

const EVENTS_CAP = 50
const FLASH_MS = 3000
const FRAME_MS = 250
const FIRST_V2 = 'flag ON: demo shoppers now get new pricing (v2)'

const MUTE_TICKS = 3
const newStory = () => ({ v2: false, err: false, containments: 0, mute: 0, run: 0, resumed: false })

/** Story events from the delta between two ticks. `state` (see newStory) is mutated; state.resumed means v2 is flowing again. */
export function storyEvents (prev, cur, state) {
  const out = []
  state.resumed = false
  if (state.mute > 0) {
    state.mute--
    state.run = 0
    return out
  }
  state.run = cur.v2 > (prev?.v2 ?? 0) ? state.run + 1 : 0
  state.resumed = state.run >= 2
  if (state.resumed && !state.v2) {
    state.v2 = true
    out.push({ text: FIRST_V2, kind: 'info' })
  }
  if (!state.err && cur.e5xx > (prev?.e5xx ?? 0)) {
    state.err = true
    out.push({ text: `first failure (fail rate ${pct(cur.err30s)})`, kind: 'alert' })
  }
  const n = cur.containments?.length ?? 0
  if (n > state.containments) {
    state.containments = n
    state.v2 = false
    state.err = false
    state.run = 0
    state.resumed = false
    state.mute = MUTE_TICKS
  }
  return out
}

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

async function main () {
  const argv = process.argv.slice(2)
  const { a, cfg, error } = parseTrafficArgs(argv)
  if (a.help || a.h || argv.includes('-h')) {
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
  if (a.plain || !process.stdout.isTTY) {
    if (!a.plain) console.error('dashboard: stdout is not a terminal, using --plain output')
    return runPlain(cfg)
  }

  const out = process.stdout
  const stdin = process.stdin
  const ascii = Boolean(a.ascii) || process.env.TERM === 'dumb'
  const color = colorEnabled({ noColorFlag: Boolean(a['no-color']) })
  const shop = cfg.shop.replace(/^https?:\/\//, '')
  const engine = createTraffic(cfg)
  let events = []
  const setupErrors = []
  let flashUntil = 0
  let badge = ''
  let ready = false
  let prevTick = { v2: 0, e5xx: 0 }
  const story = newStory()
  let stopping = false
  let finished = false
  let lastSize = ''
  let timer = null

  const log = (text, kind = 'info') => {
    events.unshift({ t: engine.snapshot().t, text, kind })
    if (events.length > EVENTS_CAP) events.length = EVENTS_CAP
  }

  if ((out.columns || 80) >= MIN_COLS && !((out.columns || 80) >= ROOMY_COLS && (out.rows || 24) >= ROOMY_ROWS)) {
    log(`tip: a window of ${ROOMY_COLS}x${ROOMY_ROWS} or larger shows a roomier layout`)
  }

  function draw () {
    if (finished) return
    const cols = out.columns || 80
    const rows = out.rows || 24
    const size = `${cols}x${rows}`
    const lines = render(engine.snapshot(), events, { cols, rows, ascii, color, shop, rps: cfg.rps, flash: Date.now() < flashUntil, badge })
    let frame = size !== lastSize ? '\x1b[2J' : ''
    lastSize = size
    lines.forEach((l, i) => {
      frame += `\x1b[${i + 1};1H` + (i === lines.length - 1 ? fit(l, cols - 1) : l)
    })
    out.write(frame)
  }

  function teardown () {
    finished = true
    clearInterval(timer)
    engine.stop()
    stdin.removeAllListeners('keypress')
    restore()
    stdin.pause()
  }

  function exitAfter (code, text, err = '', stream = out) {
    if (err) process.stderr.write(err)
    const bail = setTimeout(() => process.exit(code), 1000)
    stream.write(text, () => {
      clearTimeout(bail)
      process.exit(code)
    })
  }

  function finish (code, err) {
    if (finished) return
    teardown()
    const s = engine.snapshot()
    const text = [...s.containments.map(formatContained), formatSummary(s)].join('\n') + '\n'
    exitAfter(code, text, err ? `${err?.stack ?? err}\n` : '')
  }

  function setBad (v) {
    const bad = Math.round(clamp01(v) * 100) / 100
    engine.setBadRatio(bad)
    log(`bug trigger -> ${bad.toFixed(2)}`)
    draw()
  }

  function requestStop () {
    if (stopping || !ready) return finish(0)
    stopping = true
    engine.stop()
    log('stopping')
    draw()
  }

  function onKey (str, key = {}) {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) return requestStop()
    if (key.ctrl || key.meta) return
    if (key.name === 'up') return setBad(engine.snapshot().bad + 0.05)
    if (key.name === 'down') return setBad(engine.snapshot().bad - 0.05)
    if (str && /^[0-9]$/.test(str)) return setBad(Number(str) / 10)
    if (key.name === 'b') return setBad(0)
    if (key.name === 'p') {
      if (engine.paused) engine.resume()
      else engine.pause()
      log(engine.paused ? 'paused' : 'resumed')
      return draw()
    }
    if (key.name === 'c') {
      events = []
      draw()
    }
  }

  engine.on('setup-error', ({ message }) => {
    setupErrors.push(message)
    log(`setup: ${message}`, 'alert')
  })
  engine.on('ready', ({ ready: n, total }) => {
    ready = true
    log(`${n}/${total} demo shoppers logged in; checkouts started`)
  })
  engine.on('tick', (s) => {
    for (const ev of storyEvents(prevTick, s, story)) log(ev.text, ev.kind)
    if (story.resumed) badge = ''
    prevTick = s
  })
  engine.on('contained', ({ secs }) => {
    log(`CONTAINED: back to old pricing ${secs.toFixed(1)}s after first failure`, 'alert')
    flashUntil = Date.now() + FLASH_MS
    badge = `auto-rolled back in ${secs.toFixed(1)}s`
    draw()
  })

  process.on('exit', restore)
  process.on('SIGINT', requestStop)
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => finish(0))
  if (process.platform === 'win32') process.on('SIGBREAK', () => finish(0))
  process.on('uncaughtException', (e) => finish(1, e))
  process.on('unhandledRejection', (e) => finish(1, e))

  readline.emitKeypressEvents(stdin)
  enter(out, stdin)
  stdin.on('keypress', onKey)
  stdin.resume()
  out.on('resize', draw)
  timer = setInterval(draw, FRAME_MS)
  draw()

  try {
    await engine.start()
  } catch (e) {
    if (finished) return
    teardown()
    const msg = [...setupErrors.map((m) => `setup: ${m}`), e.message].join('\n') + '\n'
    exitAfter(1, msg, '', process.stderr)
    return
  }
  finish(0)
}

if (isMain) await main()
