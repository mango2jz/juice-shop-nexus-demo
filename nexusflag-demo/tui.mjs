// Tiny zero-dependency terminal helpers for dashboard.mjs. Everything except enter()/restore() is a pure
// string function. All glyphs are single-width BMP characters; the ascii set is for legacy consoles.

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g
const ANSI_AT = /^\x1b\[[0-9;?]*[A-Za-z]/
const RESET = '\x1b[0m'

export const GLYPHS = {
  unicode: { h: '─', v: '│', tl: '┌', tr: '┐', bl: '└', br: '┘', lt: '├', rt: '┤', full: '█', empty: '░', mark: '│', spark: '▁▂▃▄▅▆▇█', dot: '·', up: '▲' },
  ascii: { h: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+', lt: '+', rt: '+', full: '#', empty: '.', mark: '|', spark: '_.,:-=+#', dot: '-', up: '^' }
}
export const glyphs = (ascii) => (ascii ? GLYPHS.ascii : GLYPHS.unicode)

export const stripAnsi = (s) => s.replace(ANSI_RE, '')
export const visibleLen = (s) => stripAnsi(s).length

/** Truncate or pad to exactly `w` visible columns, keeping colour codes intact. */
export function fit (s, w) {
  let out = ''
  let n = 0
  let hasAnsi = false
  for (let i = 0; i < s.length;) {
    if (s[i] === '\x1b') {
      const m = ANSI_AT.exec(s.slice(i))
      if (m) {
        out += m[0]
        hasAnsi = true
        i += m[0].length
        continue
      }
    }
    if (n >= w) break
    out += s[i]
    n++
    i++
  }
  return (hasAnsi ? out + RESET : out) + ' '.repeat(Math.max(0, w - n))
}

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

/** Horizontal bar of width w filled to `frac`; optional marker at `markFrac` when that cell is empty. */
export function bar (frac, w, g = GLYPHS.unicode, markFrac) {
  if (w <= 0) return ''
  const filled = Math.round(clamp01(frac) * w)
  const cells = Array.from({ length: w }, (_, i) => (i < filled ? g.full : g.empty))
  if (markFrac !== undefined) {
    const m = Math.min(w - 1, Math.round(clamp01(markFrac) * w))
    if (m >= filled) cells[m] = g.mark
  }
  return cells.join('')
}

/** Sparkline of the last `w` values on 8 levels scaled to `max` (default: largest value). Left-padded with spaces. */
export function spark (values, w, g = GLYPHS.unicode, max) {
  if (w <= 0) return ''
  const v = values.slice(-w)
  const top = max ?? Math.max(0, ...v)
  const levels = g.spark.length
  const line = v.map((x) => {
    if (!(top > 0) || !(x > 0)) return g.spark[0]
    return g.spark[Math.min(levels - 1, Math.round(clamp01(x / top) * (levels - 1)))]
  }).join('')
  return ' '.repeat(w - v.length) + line
}

const SGR = { red: 31, green: 32, yellow: 33, cyan: 36, bold: 1, dim: 2, inverse: 7 }

/** Returns color(name, text). Names may be combined with '+', e.g. 'inverse+red'. */
export function makeColor (enabled) {
  return (name, s) => {
    if (!enabled || !name) return s
    const codes = name.split('+').map((n) => SGR[n]).filter(Boolean)
    return codes.length ? `\x1b[${codes.join(';')}m${s}${RESET}` : s
  }
}

export const colorEnabled = ({ noColorFlag = false, env = process.env } = {}) =>
  !noColorFlag && !('NO_COLOR' in env && env.NO_COLOR !== '') && env.TERM !== 'dumb'

let active = null

/** Switch to the alternate screen, hide the cursor, raw keyboard input. */
export function enter (out = process.stdout, input = process.stdin) {
  if (active) return
  active = { out, input }
  out.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J')
  if (input.isTTY) input.setRawMode(true)
}

/** Undo enter(). Safe to call any number of times, including from an 'exit' handler. */
export function restore () {
  if (!active) return
  const { out, input } = active
  active = null
  try { if (input.isTTY && input.isRaw) input.setRawMode(false) } catch { /* stdin already closed */ }
  out.write(`${RESET}\x1b[?25h\x1b[?1049l`)
}

export const isActive = () => active !== null
