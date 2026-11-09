/**
 * Column widths for data tables: wide enough for the longest value, and wide enough
 * that the header fits on at most two lines (no one-character-per-line headers).
 */

const CELL_PADDING = 18 // small table: 8px each side + border
const SLACK = 6 // font rendering differs slightly from canvas measurement
const SORTER_ICON = 22
const FILTER_ICON = 24
const MIN_WIDTH = 64
const MAX_WIDTH = 320

let ctx: CanvasRenderingContext2D | null = null
let fontFamily = ''

function measure(text: string, bold = false, size = 14): number {
  if (!ctx) {
    ctx = document.createElement('canvas').getContext('2d')
    fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif'
  }
  if (!ctx) return text.length * size
  ctx.font = `${bold ? 600 : 400} ${size}px ${fontFamily}`
  return ctx.measureText(text).width
}

/** Narrowest width at which the title wraps onto at most two lines. */
function twoLineWidth(title: string): number {
  const chars = Array.from(title)
  let best = measure(title, true)
  for (let k = 1; k < chars.length; k++) {
    const w = Math.max(measure(chars.slice(0, k).join(''), true), measure(chars.slice(k).join(''), true))
    best = Math.min(best, w)
  }
  return best
}

export function fitColumnWidth(
  title: string,
  values: string[],
  // subtitle: a small (11px) line under the title, e.g. the column's database name
  opts: { sorter?: boolean; filter?: boolean; boldValues?: string[]; subtitle?: string } = {},
): number {
  const content = Math.max(0, ...values.map((v) => measure(v)), ...(opts.boldValues ?? []).map((v) => measure(v, true)))
  const icons = (opts.sorter ? SORTER_ICON : 0) + (opts.filter ? FILTER_ICON : 0)
  const header = Math.max(twoLineWidth(title), opts.subtitle ? measure(opts.subtitle, false, 11) : 0)
  // The header area loses the icon space; the body does not.
  const width = Math.max(content + CELL_PADDING, header + CELL_PADDING + icons) + SLACK
  return Math.ceil(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)))
}
