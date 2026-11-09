/**
 * Excel export of report tables, formatted like the page: values rounded as shown and stored as numbers
 * with the page's display format (#,##0.00, 0.00%), merged cells, 小计 / 合计 rows, highlighted rows and the
 * page's red / green. One sheet per table. ExcelJS is large: it loads with the first export.
 */
import { saveBlob } from './api'
import { isAttainColumn, isCheckColumn, isFlagColumn, type Fmt } from './format'
import { isSubtotal, type Row } from './reportTable'

export interface SheetTable {
  title: string
  cols: { name: string; format: Fmt | 'raw' }[]
  rows: Row[]
  /** the 合计 row, when the page shows one */
  totals?: Record<string, unknown> | null
  /** leading dimension columns, frozen as on the page */
  dims?: number
  /** column widths on the page (px) */
  widths?: unknown[]
  /** columns shown as merged cells: neighbouring rows with the same values in all of them (as mergeCells) */
  merge?: string[]
  /** 小计 rows (pivot tables): the label spans this many leading columns */
  subtotalSpan?: number
  highlighted?: Set<Row['__key']>
}

const GREEN = 'FF389E0D'
const RED = 'FFCF1322'
const HEADER_FILL = 'FFFAFAFA'
const SUBTOTAL_FILL = 'FFFAFAFA'
const HIGHLIGHT_FILL = 'FFE6F4FF'
const BORDER = { style: 'thin' as const, color: { argb: 'FFD9D9D9' } }

/** The value stored in the cell (rounded as the page shows it) and its number format. */
function cellValue(v: unknown, format: Fmt | 'raw', name: string): { value: string | number | null; numFmt?: string } {
  if (v === null || v === undefined) return { value: null }
  if (typeof v !== 'number') return { value: String(v) }
  if (format === 'pct' || isCheckColumn(name)) return { value: Number(`${(v * 100).toFixed(2)}e-2`), numFmt: '0.00%' }
  if (format === 'amount') return { value: Number(v.toFixed(2)), numFmt: '#,##0.00' }
  if (format === 'count' || format === 'raw') {
    const value = Number(v.toFixed(format === 'raw' ? 4 : 2))
    // 「#,##0.##」 would show a whole number as 「5.」
    return { value, numFmt: Number.isInteger(value) ? '#,##0' : format === 'raw' ? '#,##0.####' : '#,##0.##' }
  }
  return { value: v }
}

/** The page's red / green for 达成率, 是否超过… and 核对 columns. */
function color(v: unknown, name: string): string | undefined {
  if (v === null || v === undefined) return undefined
  if (isCheckColumn(name)) return v === '一致' ? GREEN : RED
  if (isAttainColumn(name) && typeof v === 'number') return v >= 1 ? GREEN : RED
  if (isFlagColumn(name)) return v === '是' ? GREEN : v === '否' ? RED : undefined
  return undefined
}

const isNumericCol = (c: SheetTable['cols'][number], rows: Row[]) =>
  c.format !== 'text' || rows.some((r) => typeof r[c.name] === 'number')

/** Width in Excel units (≈ one digit) for a column without a page width: CJK characters count double. */
function estimateWidth(texts: string[]): number {
  const len = (s: string) => Array.from(s).reduce((n, ch) => n + (/[⺀-￿]/.test(ch) ? 2 : 1.1), 0)
  return Math.min(45, Math.max(8, ...texts.map((s) => len(s) + 2)))
}

function sheetName(title: string, used: Set<string>): string {
  const base = (title.replace(/[\\/?*[\]:]/g, '_').trim() || 'Sheet').slice(0, 31)
  let name = base
  for (let i = 2; used.has(name); i++) name = `${base.slice(0, 31 - String(i).length - 2)}（${i}）`
  used.add(name)
  return name
}

/** Save `tables` as an .xlsx file, one sheet each; `note` (e.g. the date) follows each sheet's title. */
export async function exportXlsx(fileName: string, tables: SheetTable[], note = '') {
  const mod = await import('exceljs')
  const ExcelJS = (mod as unknown as { default?: typeof mod }).default ?? mod
  const wb = new ExcelJS.Workbook()
  const used = new Set<string>()
  for (const t of tables) {
    const ws = wb.addWorksheet(sheetName(t.title, used), {
      views: [{ state: 'frozen', xSplit: t.dims ?? 0, ySplit: 2 }],
    })
    const numeric = t.cols.map((c) => isNumericCol(c, t.rows))
    ws.columns = t.cols.map((c, j) => {
      const px = t.widths?.[j]
      const width =
        typeof px === 'number'
          ? Math.max(6, Math.round(px / 7))
          : // the header wraps onto two lines
            estimateWidth([c.name.slice(0, Math.ceil(c.name.length / 2)), ...t.rows.map((r) => String(r[c.name] ?? ''))])
      return { width }
    })

    const title = ws.addRow([note ? `${t.title}（${note}）` : t.title])
    title.font = { bold: true, size: 12 }
    title.height = 22

    const header = ws.addRow(t.cols.map((c) => c.name))
    header.height = 32
    header.eachCell((cell, j) => {
      cell.font = { bold: true }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
      cell.alignment = { wrapText: true, vertical: 'middle', horizontal: numeric[j - 1] ? 'right' : 'left' }
    })

    const mergeIdx = (t.merge ?? []).map((m) => t.cols.findIndex((c) => c.name === m)).filter((j) => j >= 0)
    const span = t.subtotalSpan ?? 0
    const addRow = (r: Record<string, unknown>, kind: 'row' | 'subtotal' | 'total', highlight: boolean) => {
      const labelSpan = kind === 'total' ? 1 : kind === 'subtotal' ? span : 0
      const cells = t.cols.map((c, j) =>
        j < labelSpan ? { value: j === 0 ? (kind === 'total' ? '合计' : '小计') : null } : cellValue(r[c.name], c.format, c.name),
      )
      const row = ws.addRow(cells.map((c) => c.value))
      t.cols.forEach((c, j) => {
        const cell = row.getCell(j + 1)
        if (cells[j].numFmt) cell.numFmt = cells[j].numFmt!
        const fg = j < labelSpan ? undefined : color(r[c.name], c.name)
        const plainMerged = highlight && mergeIdx.includes(j)
        const bold = kind !== 'row' || (highlight && !plainMerged) || !!fg
        if (bold || fg) cell.font = { bold, ...(fg ? { color: { argb: fg } } : {}) }
        if (kind === 'subtotal' || kind === 'total' || (highlight && !plainMerged)) {
          const argb = highlight && kind === 'row' ? HIGHLIGHT_FILL : SUBTOTAL_FILL
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }
        }
        if (numeric[j] && j >= labelSpan) cell.alignment = { horizontal: 'right' }
      })
      if (labelSpan > 1) ws.mergeCells(row.number, 1, row.number, labelSpan)
    }
    t.rows.forEach((r) =>
      addRow(r, isSubtotal(r) ? 'subtotal' : 'row', !!t.highlighted?.has(r.__key) && !isSubtotal(r)),
    )
    if (t.totals && t.rows.length) addRow(t.totals, 'total', false)

    // merged cells: runs of neighbouring rows (not 小计) with the same values in all merge columns
    if (mergeIdx.length) {
      const key = (r: Row) => JSON.stringify(mergeIdx.map((j) => r[t.cols[j].name] ?? null))
      for (let i = 0, k; i < t.rows.length; i = k) {
        for (k = i + 1; k < t.rows.length && !isSubtotal(t.rows[i]) && !isSubtotal(t.rows[k]) && key(t.rows[k]) === key(t.rows[i]); k++);
        if (k - i > 1)
          for (const j of mergeIdx) {
            ws.mergeCells(i + 3, j + 1, k + 2, j + 1)
            ws.getCell(i + 3, j + 1).alignment = { vertical: 'middle' }
          }
      }
    }

    // grid lines like the page's bordered tables (title row excluded)
    for (let i = 2; i <= ws.rowCount; i++)
      for (let j = 1; j <= t.cols.length; j++)
        ws.getCell(i, j).border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER }
  }
  const buf = await wb.xlsx.writeBuffer()
  saveBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName)
}
