/**
 * Summary report (package `type: summary`): tables summarized from another report's rows by a
 * dimension. Columns are sums, ratios (sum/sum over rows where both columns have values) or
 * differences (likewise), so a 达成率 leaves out rows without a target — the same rule as the
 * 合计 rows everywhere else. `{day}` in a column name becomes the selected date's day.
 */
import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Card, Grid, Select, Space, Table, Typography } from 'antd'
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '../api'
import { compareValues, type Fmt } from '../format'
import { buildColumns, SummaryRow, useStickyHeader, type Col, type Row } from '../reportTable'
import { usePageContext } from '../chat/pageContext'
import { exportXlsx, type SheetTable } from '../xlsx'
import type { ChartDef } from './DayChart'

// ECharts is large: loaded with the first chart.
const DayChart = lazy(() => import('./DayChart'))

interface SummaryColumnDef {
  name: string
  sum: string | null
  ratio: [string, string] | null
  diff: [string, string] | null
  format: Fmt
}

interface SummaryTableDef {
  title: string
  group_by: string
  filter: Record<string, (string | null)[]>
  sort: string | null
  hide_empty: string | null
  columns: SummaryColumnDef[]
  chart: ChartDef | null
}

interface SummaryMeta {
  id: string
  title: string
  description: string
  note: string
  source: string
  dates: string[]
  tables: SummaryTableDef[]
}

interface SourceData {
  columns: { name: string }[]
  rows: unknown[][]
  elapsed_ms: number
}

const isNum = (v: unknown): v is number => typeof v === 'number'

function sumWhere(rows: Row[], col: string, where: (r: Row) => boolean = () => true): number | null {
  let s = 0
  let any = false
  for (const r of rows) {
    const v = r[col]
    if (isNum(v) && where(r)) {
      s += v
      any = true
    }
  }
  return any ? s : null
}

function columnValue(c: SummaryColumnDef, rows: Row[]): number | null {
  if (c.sum) return sumWhere(rows, c.sum)
  const [a, b] = (c.ratio ?? c.diff)!
  const both = (r: Row) => isNum(r[a]) && isNum(r[b])
  const x = sumWhere(rows, a, both)
  const y = sumWhere(rows, b, both)
  if (c.ratio) return x === null || !y ? null : x / y
  return x === null || y === null ? null : x - y
}

const label = (name: string, day: string) => name.split('{day}').join(day)
const valueKey = (v: unknown) => (v === null || v === undefined ? null : String(v))

export default function SummaryReportPage({ id }: { id: string }) {
  const [meta, setMeta] = useState<SummaryMeta>()
  const [date, setDate] = useState<string>()
  const [data, setData] = useState<SourceData>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const freezeDims = !!Grid.useBreakpoint().md
  const sticky = useStickyHeader()
  const { message } = App.useApp()

  useEffect(() => {
    setMeta(undefined)
    setData(undefined)
    setError(undefined)
    api<SummaryMeta>(`/api/reports/${id}`)
      .then((m) => {
        setMeta(m)
        setDate(m.dates[0])
      })
      .catch((e) => setError(e.message))
  }, [id])

  usePageContext(meta ? { page: `${meta.title}（${meta.description}）`, report: meta.source, date } : undefined)

  const load = useCallback(async () => {
    if (!meta || !date) return
    setLoading(true)
    setError(undefined)
    try {
      setData(await api<SourceData>(`/api/reports/${meta.source}/data?date=${encodeURIComponent(date)}`))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [meta, date])

  useEffect(() => {
    load()
  }, [load])

  const rows: Row[] = useMemo(
    () =>
      (data?.rows ?? []).map((r, i) => {
        const o: Row = { __key: i }
        data!.columns.forEach((c, j) => (o[c.name] = r[j]))
        return o
      }),
    [data],
  )

  const day = date ? String(Number(date.slice(8))) : ''

  const tables = useMemo(
    () =>
      (meta?.tables ?? []).map((t) => {
        const cols: Col[] = [
          { name: t.group_by, format: 'text' },
          ...t.columns.map((c) => ({ name: label(c.name, day), format: c.format })),
        ]
        const source = rows.filter((r) =>
          Object.entries(t.filter).every(([dim, values]) => values.includes(valueKey(r[dim]))),
        )
        const summarize = (rs: Row[]) =>
          Object.fromEntries(t.columns.map((c) => [label(c.name, day), columnValue(c, rs)]))
        const groups = new Map<string, Row[]>()
        for (const r of source) {
          const key = String(r[t.group_by] ?? '')
          if (!groups.has(key)) groups.set(key, [])
          groups.get(key)!.push(r)
        }
        let out: Row[] = Array.from(groups.entries()).map(([key, rs]) => ({
          __key: key,
          [t.group_by]: rs[0][t.group_by],
          ...summarize(rs),
        }))
        if (t.hide_empty) out = out.filter((r) => !!r[label(t.hide_empty!, day)])
        if (t.sort) {
          const desc = t.sort.startsWith('-')
          const col = label(t.sort.replace(/^-/, ''), day)
          out.sort((a, b) => (desc ? compareValues(b[col], a[col]) : compareValues(a[col], b[col])))
        }
        const totals = summarize(source)
        const formats = new Map(cols.map((c) => [c.name, c.format]))
        const chartGroups = out.map((r) => ({ name: String(r[t.group_by] ?? '（空）'), values: r }))
        return { def: t, cols, rows: out, totals, formats, chartGroups, columns: buildColumns(cols, out, totals, { dims: [t.group_by], freezeDims }) }
      }),
    [meta, rows, day, freezeDims],
  )

  const sheet = (t: (typeof tables)[number]): SheetTable => ({
    title: t.def.title,
    cols: t.cols,
    rows: t.rows,
    totals: t.totals,
    dims: 1,
    widths: t.columns.map((c) => c.width),
  })
  const save = (name: string, sheets: SheetTable[]) =>
    exportXlsx(`${name}_${date}.xlsx`, sheets, date).catch((e) => message.error(`导出失败：${(e as Error).message}`))

  return (
    <div className="page">
      <div className="page-title">
        <h2>{meta?.title ?? '报表'}</h2>
        <Typography.Text type="secondary">{meta?.description}</Typography.Text>
      </div>

      <Card size="small" style={{ marginBottom: 16 }}>
        <div className="filter-bar">
          <Space size={6} className="filter-item">
            <Typography.Text>日期</Typography.Text>
            <Select
              style={{ width: 140 }}
              value={date}
              onChange={setDate}
              options={(meta?.dates ?? []).map((d) => ({ value: d, label: d }))}
            />
          </Space>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
          <Button
            icon={<DownloadOutlined />}
            disabled={!data || !tables.some((t) => t.rows.length)}
            onClick={() => meta && save(meta.title, tables.filter((t) => t.rows.length).map(sheet))}
          >
            导出 Excel
          </Button>
          {data && <Typography.Text type="secondary">查询耗时 {(data.elapsed_ms / 1000).toFixed(1)}s</Typography.Text>}
        </div>
      </Card>

      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      {tables.map((t) => (
        <Fragment key={t.def.title}>
          {t.def.chart && t.rows.length > 0 && (
            <Suspense fallback={null}>
              <DayChart chart={t.def.chart} groups={t.chartGroups} formats={t.formats} />
            </Suspense>
          )}
          <Card
            size="small"
            title={t.def.title}
            style={{ marginBottom: 16 }}
            extra={
              <Button
                size="small"
                icon={<DownloadOutlined />}
                disabled={!t.rows.length}
                onClick={() => save(t.def.title, [sheet(t)])}
              >
                导出 Excel
              </Button>
            }
          >
            <Table<Row>
              className="report-table"
              size="small"
              bordered
              rowKey="__key"
              loading={loading}
              columns={t.columns}
              dataSource={t.rows}
              pagination={false}
              tableLayout="fixed"
              scroll={{ x: 'max-content' }}
              sticky={sticky}
              summary={() => (t.rows.length > 0 ? <SummaryRow cols={t.cols} totals={t.totals} label="合计" /> : null)}
            />
          </Card>
        </Fragment>
      ))}

      {meta?.note && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          {meta.note}
        </Typography.Paragraph>
      )}
    </div>
  )
}
