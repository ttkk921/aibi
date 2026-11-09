import { saveBlob } from './api'

export type Fmt = 'pct' | 'amount' | 'count' | 'text'

const amountFmt = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const countFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })

export function formatValue(v: unknown, fmt: Fmt = 'text'): string {
  if (v === null || v === undefined) return ''
  if (typeof v !== 'number') return String(v)
  switch (fmt) {
    case 'pct':
      return `${(v * 100).toFixed(2)}%`
    case 'amount':
      return amountFmt.format(v)
    case 'count':
      return countFmt.format(v)
    default:
      return String(v)
  }
}

export const isNumericFmt = (f: Fmt) => f !== 'text'

/** Database column types that should be right-aligned and summed. */
export const NUMERIC_TYPES = new Set(['int', 'bigint', 'smallint', 'tinyint', 'mediumint', 'decimal', 'float', 'double'])

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** Numbers (including numeric text such as 排名 "22") sort numerically and before text; empty values first. */
export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  const na = asNumber(a)
  const nb = asNumber(b)
  if (na !== null && nb !== null) return na - nb
  if (na !== null) return -1
  if (nb !== null) return 1
  return String(a).localeCompare(String(b), 'zh-CN')
}

export interface RatioDef {
  num: string
  den: string
  minus_one: boolean
}

/** A reference rate and the 是/否 flag comparing `rate` with it (e.g. 大区平均达成率). */
export interface BenchmarkDef {
  avg: string
  flag: string
  rate: string
}

/**
 * Totals for a set of report rows: amounts and counts are summed; rate columns with a
 * ratio definition are recomputed as sum(num) / sum(den) over rows where both are present.
 */
export function computeTotals(
  rows: Record<string, unknown>[],
  columns: { name: string; format: Fmt }[],
  ratios: Record<string, RatioDef>,
  benchmarks: BenchmarkDef[] = [],
): Record<string, number | string | null> {
  const out: Record<string, number | string | null> = {}
  const sum = (col: string, where?: (r: Record<string, unknown>) => boolean) => {
    let s = 0
    let any = false
    for (const r of rows) {
      const v = r[col]
      if (typeof v === 'number' && (!where || where(r))) {
        s += v
        any = true
      }
    }
    return any ? s : null
  }
  for (const c of columns) {
    const ratio = ratios[c.name]
    if (ratio) {
      const both = (r: Record<string, unknown>) => typeof r[ratio.num] === 'number' && typeof r[ratio.den] === 'number'
      const n = sum(ratio.num, both)
      const d = sum(ratio.den, both)
      out[c.name] = n === null || !d ? null : n / d - (ratio.minus_one ? 1 : 0)
    } else if (c.format === 'amount' || c.format === 'count') {
      out[c.name] = sum(c.name)
    } else {
      out[c.name] = null
    }
  }
  // A reference rate only applies when the rows share it (one 大区 × 品类); the flag
  // compares the recomputed rate of these rows with it.
  for (const b of benchmarks) {
    const values = new Set(rows.map((r) => r[b.avg]).filter((v): v is number => typeof v === 'number'))
    const avg = values.size === 1 ? [...values][0] : null
    const rate = out[b.rate] ?? computeTotals(rows, [{ name: b.rate, format: 'pct' }], ratios)[b.rate]
    out[b.avg] = avg
    out[b.flag] = avg === null || typeof rate !== 'number' ? null : rate > avg ? '是' : '否'
  }
  return out
}

/** 是否超过… columns: 是 is good, 否 is behind. */
export const isFlagColumn = (name: string) => name.includes('是否超过')
export const flagClass = (v: unknown) => (v === '是' ? 'attain-ok' : v === '否' ? 'attain-bad' : undefined)

/**
 * 核对 columns (e.g. 序时达成率核对): 「一致」 when the rate is within 0.01% of the source checked against,
 * otherwise that source's rate, shown to 4 decimals (as a percentage, 2).
 */
export const isCheckColumn = (name: string) => name.endsWith('核对')

export function checkText(v: unknown): string {
  const n = asNumber(v)
  return v === '一致' || n === null ? String(v) : `${(n * 100).toFixed(2)}%`
}

/** 达成率 columns: ≥100% is on track, below is behind. */
export const isAttainColumn = (name: string) => name.endsWith('达成率')

export function attainClass(v: unknown): string | undefined {
  if (typeof v !== 'number') return undefined
  return v >= 1 ? 'attain-ok' : 'attain-bad'
}

export function exportCsv(name: string, header: string[], rows: unknown[][]) {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return ''
    // Excel / WPS read text like 「1/6」 (a 排名) as a date; ="1/6" keeps it as text
    const s = typeof v === 'string' && /^\d+\s*[/-]\s*\d+$/.test(v) ? `="${v}"` : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const text = '﻿' + [header, ...rows].map((r) => r.map(esc).join(',')).join('\n')
  saveBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), name)
}
