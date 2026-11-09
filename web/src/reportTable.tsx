/** Rendering shared by the report pages: value cells, fitted columns and the 合计 row. */
import { Grid, Table } from 'antd'
import type { TableColumnType } from 'antd'
import {
  attainClass,
  checkText,
  compareValues,
  computeTotals,
  flagClass,
  formatValue,
  isAttainColumn,
  isCheckColumn,
  isFlagColumn,
  isNumericFmt,
  type BenchmarkDef,
  type Fmt,
  type RatioDef,
} from './format'
import { fitColumnWidth } from './tableLayout'

export interface Col {
  name: string
  format: Fmt
}

export type Row = Record<string, unknown> & { __key: string | number }

// Height of the app header, which is itself stuck to the top below the lg breakpoint (App.tsx).
const APP_HEADER = 52

/** `sticky` for long tables: the header row stays at the top of the window while the page scrolls. */
export function useStickyHeader() {
  const lg = !!Grid.useBreakpoint().lg
  return { offsetHeader: lg ? 0 : APP_HEADER }
}

export function renderValue(name: string, format: Fmt, v: unknown) {
  if (v === null || v === undefined) return <span className="empty-cell">—</span>
  if (isCheckColumn(name)) return <span className={v === '一致' ? 'attain-ok' : 'attain-bad'}>{checkText(v)}</span>
  const text = formatValue(v, format)
  if (isAttainColumn(name)) return <span className={attainClass(v)}>{text}</span>
  if (isFlagColumn(name)) return <span className={flagClass(v)}>{text}</span>
  return text
}

// On narrow screens only the first dimension is frozen, and only when it leaves room for the values.
const NARROW_FREEZE_MAX = 140

/** Table columns with widths fitted to content and a header of at most two lines. */
export function buildColumns(
  cols: Col[],
  rows: Row[],
  totals: Record<string, unknown>,
  opts: { dims: string[]; freezeDims: boolean; sortable?: boolean },
): TableColumnType<Row>[] {
  return cols.map((c, i) => {
    const isDim = opts.dims.includes(c.name)
    const show = isCheckColumn(c.name) ? checkText : (v: unknown) => formatValue(v, c.format)
    const values = rows.map((r) => (r[c.name] == null ? '—' : show(r[c.name])))
    const total = totals[c.name]
    const width = fitColumnWidth(c.name, values, {
      sorter: opts.sortable !== false,
      boldValues: total == null ? [] : [formatValue(total, c.format)],
    })
    const frozen = isDim && c.name !== '日期' && (opts.freezeDims || (i === 0 && width <= NARROW_FREEZE_MAX))
    return {
      title: <div className="th-2line">{c.name}</div>,
      dataIndex: c.name,
      key: c.name,
      width,
      fixed: frozen ? ('left' as const) : undefined,
      align: isNumericFmt(c.format) ? ('right' as const) : ('left' as const),
      sorter: opts.sortable === false ? undefined : (a: Row, b: Row) => compareValues(a[c.name], b[c.name]),
      render: (v: unknown) => renderValue(c.name, c.format, v),
    }
  })
}

/**
 * Columns `names` shown as merged cells: neighbouring rows with the same values in all of them form one group
 * (e.g. 1手 · 东北), and each of these columns is one cell per group. Rows must already be in group order.
 */
export function mergeCells(columns: TableColumnType<Row>[], rows: Row[], names: string[]): TableColumnType<Row>[] {
  if (!names.length) return columns
  const key = (r: Row) => JSON.stringify(names.map((n) => r[n] ?? null))
  const span = new Map<Row['__key'], number>()
  for (let i = 0, j; i < rows.length; i = j) {
    for (j = i + 1; j < rows.length && key(rows[j]) === key(rows[i]); j++) span.set(rows[j].__key, 0)
    span.set(rows[i].__key, j - i)
  }
  return columns.map((col) =>
    names.includes(String(col.key))
      ? { ...col, onCell: (r: Row) => ({ rowSpan: span.get(r.__key), className: 'merged-cell' }) }
      : col,
  )
}

export function SummaryRow({ cols, totals, label }: { cols: Col[]; totals: Record<string, unknown>; label: string }) {
  return (
    <Table.Summary fixed>
      <Table.Summary.Row>
        {cols.map((c, i) => {
          const v = totals[c.name]
          return (
            <Table.Summary.Cell key={c.name} index={i} align={isNumericFmt(c.format) ? 'right' : 'left'}>
              {i === 0 ? <b>{label}</b> : v == null ? '' : <b>{renderValue(c.name, c.format, v)}</b>}
            </Table.Summary.Cell>
          )
        })}
      </Table.Summary.Row>
    </Table.Summary>
  )
}

export interface PivotDef {
  title: string
  keys: string[]
  /** The first `merge` keys form groups shown as merged cells, each followed by a 小计 row. */
  merge: number
  /** Report columns this table leaves out. */
  hide: string[]
}

const SUBTOTAL = '__subtotal'
const SPAN = '__span'
export const isSubtotal = (r: Row) => !!r[SUBTOTAL]

function bucket(rows: Row[], keys: string[]): Row[][] {
  const out = new Map<string, Row[]>()
  for (const r of rows) {
    const k = JSON.stringify(keys.map((key) => r[key] ?? null))
    if (!out.has(k)) out.set(k, [])
    out.get(k)!.push(r)
  }
  return Array.from(out.values())
}

/**
 * Rows of a pivot table. Every row (and every 小计) is computed from the underlying
 * report rows, so ratios are recomputed from sums exactly as in the 合计 row.
 */
export function pivotRows(
  pivot: PivotDef,
  rows: Row[],
  metricCols: Col[],
  ratios: Record<string, RatioDef>,
  benchmarks: BenchmarkDef[],
  sortKey: string,
): Row[] {
  const summarize = (rs: Row[], keys: string[], extra: Record<string, unknown> = {}): Row => ({
    __key: JSON.stringify([extra[SUBTOTAL] ?? 0, ...keys.map((k) => rs[0][k] ?? null)]),
    ...Object.fromEntries(keys.map((k) => [k, rs[0][k]])),
    ...computeTotals(rs, metricCols, ratios, benchmarks),
    ...extra,
  })
  const bySortKey = (a: Row, b: Row) => compareValues(b[sortKey], a[sortKey])
  if (!pivot.merge) return bucket(rows, pivot.keys).map((rs) => summarize(rs, pivot.keys)).sort(bySortKey)

  const groupKeys = pivot.keys.slice(0, pivot.merge)
  return bucket(rows, groupKeys)
    .map((rs) => ({ subtotal: summarize(rs, groupKeys, { [SUBTOTAL]: 1 }), rs }))
    .sort((a, b) => bySortKey(a.subtotal, b.subtotal))
    .flatMap(({ subtotal, rs }) => {
      const members = bucket(rs, pivot.keys)
        .map((m) => summarize(m, pivot.keys))
        .sort(bySortKey)
      members.forEach((m, i) => (m[SPAN] = i === 0 ? members.length : 0))
      return [...members, subtotal]
    })
}

/** Columns for a pivot table: merged group cells, and a 小计 label spanning the key columns. */
export function pivotColumns(
  pivot: PivotDef,
  cols: Col[],
  rows: Row[],
  totals: Record<string, unknown>,
  freezeDims: boolean,
): TableColumnType<Row>[] {
  const columns = buildColumns(cols, rows, totals, { dims: pivot.keys, freezeDims, sortable: !pivot.merge })
  if (!pivot.merge) return columns
  return columns.map((col, i) => {
    if (i >= pivot.keys.length) return col
    return {
      ...col,
      onCell: (r: Row) => {
        if (isSubtotal(r)) return { colSpan: i === 0 ? pivot.keys.length : 0 }
        return i < pivot.merge ? { rowSpan: r[SPAN] as number, className: 'merged-cell' } : {}
      },
      render: (v: unknown, r: Row) => (isSubtotal(r) ? <b>小计</b> : renderValue(cols[i].name, cols[i].format, v)),
    }
  })
}
