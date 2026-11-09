import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Alert, App, Button, Card, Checkbox, Col, Collapse, Grid, Row, Segmented, Select, Space, Spin, Statistic, Table, Typography } from 'antd'
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import { api } from '../api'
import {
  attainClass,
  compareValues,
  computeTotals,
  formatValue,
  isAttainColumn,
  type BenchmarkDef,
  type Fmt,
  type RatioDef,
} from '../format'
import {
  buildColumns,
  isSubtotal,
  mergeCells,
  pivotColumns,
  pivotRows,
  SummaryRow,
  useStickyHeader,
  type Col as ReportCol,
  type PivotDef,
  type Row as ReportRow,
} from '../reportTable'
import { exportXlsx, type SheetTable } from '../xlsx'
import type { TrendDef } from './TrendView'
import type { ChartDef, ChartGroup } from './DayChart'
import type { GapChartDef } from './GapChart'
import { usePageContext } from '../chat/pageContext'

// ECharts is large: only load it when the 月度趋势 view is opened.
const TrendView = lazy(() => import('./TrendView'))
const DayChart = lazy(() => import('./DayChart'))
const GapChart = lazy(() => import('./GapChart'))

interface ReportMeta {
  id: string
  title: string
  description: string
  sql: string
  dates: string[]
  dims: string[]
  ratios: Record<string, RatioDef>
  kpis: string[]
  group_by: string | null
  // Dimension counted in the grouped table (e.g. 品类 → 「品类数」); null = no such column
  stage_dim: string | null
  default_filters: Record<string, (string | null)[]>
  // single-select filters: each option keeps the rows matching its filter (none: all); the first is the default
  choices: { title: string; options: { label: string; filter: Record<string, (string | null)[]> }[] }[]
  hidden: string[]
  pivots: PivotDef[]
  column_groups: string[]
  base_group: string
  benchmarks: BenchmarkDef[]
  trend: TrendDef | null
  charts: ChartDef[]
  // Instead of the detail table: titled tables, each with its own columns (label: the header shown).
  tables: {
    title: string
    columns: { col: string; label: string }[]
    chart: GapChartDef | null
    filter: Record<string, (string | null)[]> // only rows with these values, e.g. 门店: [东区-繁华店]
    totals: boolean
    highlight: Record<string, (string | null)[]> // rows shown emphasized, e.g. 门店: [东区-繁华店]
    merge: string[] // columns shown as merged cells (each within the ones before it); no header sorting then
  }[]
}

interface ReportData {
  columns: ReportCol[]
  rows: unknown[][]
  elapsed_ms: number
}

const NULL_KEY = '__null'
const valueKey = (v: unknown) => (v === null || v === undefined ? NULL_KEY : String(v))

export default function ReportPage() {
  const { id = '' } = useParams()
  const [meta, setMeta] = useState<ReportMeta>()
  const [date, setDate] = useState<string>()
  const [view, setView] = useState<'day' | 'trend'>('day')
  const [month, setMonth] = useState<string>()
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [chosen, setChosen] = useState<Record<string, string>>({}) // choice title → option label
  const [groupsOn, setGroupsOn] = useState<string[]>([])
  const [data, setData] = useState<ReportData>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  // On narrow screens frozen dimension columns would cover the whole viewport.
  const freezeDims = !!Grid.useBreakpoint().md
  const narrow = !freezeDims
  const sticky = useStickyHeader()
  const { message } = App.useApp()

  useEffect(() => {
    setMeta(undefined)
    setData(undefined)
    setError(undefined)
    api<ReportMeta>(`/api/reports/${id}`)
      .then((m) => {
        setMeta(m)
        setDate(m.dates[0])
        setView('day')
        setMonth(m.dates[0]?.slice(0, 7))
        setSelected(Object.fromEntries(Object.entries(m.default_filters).map(([d, vs]) => [d, vs.map(valueKey)])))
        setChosen(Object.fromEntries(m.choices.map((c) => [c.title, c.options[0].label])))
        setGroupsOn(m.column_groups.length ? [m.base_group, ...m.column_groups] : [])
      })
      .catch((e) => setError(e.message))
  }, [id])

  const load = useCallback(async () => {
    if (!meta || !date) return
    setLoading(true)
    setError(undefined)
    try {
      setData(await api<ReportData>(`/api/reports/${id}/data?date=${encodeURIComponent(date)}`))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [id, meta, date])

  useEffect(() => {
    load()
  }, [load])

  const rows: ReportRow[] = useMemo(
    () =>
      (data?.rows ?? []).map((r, i) => {
        const o: ReportRow = { __key: i }
        data!.columns.forEach((c, j) => (o[c.name] = r[j]))
        return o
      }),
    [data],
  )

  // Dimension filters (multi-select). Options cascade: each list only offers values
  // that exist given the selections in the other dimensions.
  const filterDims = useMemo(() => (meta?.dims ?? []).filter((d) => d !== '日期'), [meta])
  // the chosen options' row filters, always applied (they also narrow the dimension options)
  const choiceFilters = useMemo(
    () =>
      (meta?.choices ?? []).flatMap((c) =>
        Object.entries(c.options.find((o) => o.label === chosen[c.title])?.filter ?? {}).map(
          ([col, vs]) => [col, vs.map(valueKey)] as const,
        ),
      ),
    [meta, chosen],
  )
  const matches = useCallback(
    (r: ReportRow, skip?: string) =>
      choiceFilters.every(([col, vs]) => vs.includes(valueKey(r[col]))) &&
      filterDims.every((d) => d === skip || !selected[d]?.length || selected[d].includes(valueKey(r[d]))),
    [filterDims, selected, choiceFilters],
  )
  const visibleRows = useMemo(() => rows.filter((r) => matches(r)), [rows, matches])
  const filterOptions = useMemo(
    () =>
      Object.fromEntries(
        filterDims.map((d) => {
          const values = Array.from(new Set(rows.filter((r) => matches(r, d)).map((r) => r[d]))).sort(compareValues)
          return [d, values.map((v) => ({ value: valueKey(v), label: v === null || v === undefined ? '（空）' : String(v) }))]
        }),
      ),
    [filterDims, rows, matches],
  )
  const anyFilter = filterDims.some((d) => selected[d]?.length)
  const anyRowFilter = anyFilter || choiceFilters.length > 0

  usePageContext(
    meta
      ? {
          page: meta.title,
          report: meta.id,
          view: meta.trend ? view : undefined,
          date: view === 'day' ? date : undefined,
          month: view === 'trend' ? month : undefined,
          filters: Object.fromEntries([
            ...Object.entries(selected)
              .filter(([, vs]) => vs?.length)
              .map(([d, vs]) => [d, vs.map((v) => (v === NULL_KEY ? null : v))]),
            ...Object.entries(chosen).map(([title, label]) => [title, [label]]),
          ]),
          fields: meta.column_groups.length ? groupsOn : undefined,
        }
      : undefined,
  )

  const months = useMemo(() => Array.from(new Set((meta?.dates ?? []).map((d) => d.slice(0, 7)))), [meta])
  const monthDates = useMemo(
    () => (meta?.dates ?? []).filter((d) => month && d.startsWith(month)).sort(),
    [meta, month],
  )

  const totals = useMemo(
    () => (data && meta ? computeTotals(visibleRows, data.columns, meta.ratios, meta.benchmarks) : {}),
    [data, meta, visibleRows],
  )
  const formats = useMemo(() => new Map(data?.columns.map((c) => [c.name, c.format]) ?? []), [data])
  // Hidden columns, and columns of a switched-off group (全量 / A类 / B类), stay in the data
  // (KPI cards, sorting) but are not shown or exported. Dimensions are always shown.
  const isShown = useCallback(
    (name: string) => {
      if (!meta) return false
      if (meta.dims.includes(name)) return true
      if (meta.hidden.includes(name)) return false
      if (!meta.column_groups.length) return true
      return groupsOn.includes(meta.column_groups.find((g) => name.startsWith(g)) ?? meta.base_group)
    },
    [meta, groupsOn],
  )
  const shownCols = useMemo(() => (data?.columns ?? []).filter((c) => isShown(c.name)), [data, isShown])

  const columns = useMemo(
    () => (meta ? buildColumns(shownCols, rows, totals, { dims: meta.dims, freezeDims }) : []),
    [shownCols, meta, rows, totals, freezeDims],
  )

  // Columns that can be summed or recomputed for a group of rows.
  const metricCols = useMemo(
    () =>
      data && meta
        ? data.columns.filter(
            (c) =>
              !meta.dims.includes(c.name) &&
              (meta.ratios[c.name] ||
                c.format === 'amount' ||
                c.format === 'count' ||
                meta.benchmarks.some((b) => b.avg === c.name || b.flag === c.name)),
          )
        : [],
    [data, meta],
  )

  // ---- grouped statistics (e.g. by 品类大类) ----
  const grouped = useMemo(() => {
    const groupBy = meta?.group_by
    if (!data || !meta || !groupBy) return null
    const stage = meta.stage_dim
    // the counted column (e.g. 品类数) needs the package to name a dimension and the report to return it
    const hasStage = !!stage && data.columns.some((c) => c.name === stage)
    const stageCountCol = `${stage}数`
    const cols: ReportCol[] = [
      { name: groupBy, format: 'text' },
      ...(hasStage ? [{ name: stageCountCol, format: 'count' as Fmt }] : []),
      ...metricCols.filter((c) => isShown(c.name)),
    ]
    const buckets = new Map<string, ReportRow[]>()
    for (const r of visibleRows) {
      const key = String(r[groupBy] ?? '')
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key)!.push(r)
    }
    // how many distinct values of the stage dimension the group covers
    const stageCount = (rs: ReportRow[]) => new Set(rs.map((r) => valueKey(r[stage as string]))).size
    const sortKey = meta.kpis[0]
    const groupRows: ReportRow[] = Array.from(buckets.entries())
      .map(([key, rs]) => ({
        __key: key,
        [groupBy]: rs[0][groupBy],
        [stageCountCol]: stageCount(rs),
        ...computeTotals(rs, metricCols, meta.ratios, meta.benchmarks),
      }))
      .sort((a, b) => compareValues(b[sortKey], a[sortKey]))
    const groupTotals = { ...computeTotals(visibleRows, metricCols, meta.ratios, meta.benchmarks), [stageCountCol]: stageCount(visibleRows) }
    return {
      groupBy,
      cols,
      rows: groupRows,
      totals: groupTotals,
      columns: buildColumns(cols, groupRows, groupTotals, { dims: [groupBy], freezeDims }),
    }
  }, [data, meta, metricCols, isShown, visibleRows, freezeDims])

  // ---- pivot tables (e.g. by 品类, by 大区, and both ways with 小计) ----
  const pivots = useMemo(() => {
    if (!data || !meta) return []
    const shownMetrics = metricCols.filter((c) => isShown(c.name))
    return meta.pivots.map((p) => {
      const cols: ReportCol[] = [
        ...p.keys.map((k) => ({ name: k, format: 'text' as Fmt })),
        ...shownMetrics.filter((c) => !p.hide.includes(c.name)),
      ]
      const prows = pivotRows(p, visibleRows, metricCols, meta.ratios, meta.benchmarks, meta.kpis[0])
      return { pivot: p, cols, rows: prows, columns: pivotColumns(p, cols, prows, totals, freezeDims) }
    })
  }, [data, meta, metricCols, isShown, visibleRows, totals, freezeDims])

  // ---- charts of the day: groups by the first `by` dimension that still varies under the filters ----
  const charts = useMemo(() => {
    if (!data || !meta) return []
    return meta.charts.map((c) => {
      const key = c.by.find((k) => new Set(visibleRows.map((r) => r[k] ?? null)).size > 1) ?? c.by[0]
      const buckets = new Map<string, ReportRow[]>()
      for (const r of visibleRows) {
        const name = r[key] === null || r[key] === undefined ? '（空）' : String(r[key])
        if (!buckets.has(name)) buckets.set(name, [])
        buckets.get(name)!.push(r)
      }
      const groups: ChartGroup[] = Array.from(buckets.entries()).map(([name, rs]) => ({
        name,
        values: computeTotals(rs, metricCols, meta.ratios),
      }))
      return { chart: { ...c, title: `${c.title}（按${key}）` }, groups }
    })
  }, [data, meta, visibleRows, metricCols])

  // ---- split tables (e.g. 全量排名 / A类排名): own columns, renamed; rows without any of their values left out ----
  const splitTables = useMemo(() => {
    if (!data || !meta) return []
    const have = new Set(data.columns.map((c) => c.name))
    return meta.tables.map((t) => {
      const picked = t.columns.filter((c) => have.has(c.col))
      const cols: ReportCol[] = picked.map((c) => ({ name: c.label, format: formats.get(c.col) ?? 'text' }))
      const values = picked.filter((c) => !meta.dims.includes(c.col))
      const has = (r: ReportRow, want: Record<string, (string | null)[]>) =>
        Object.entries(want).every(([col, vs]) => vs.map(valueKey).includes(valueKey(r[col])))
      const source = visibleRows.filter(
        (r) => has(r, t.filter) && values.some((c) => r[c.col] !== null && r[c.col] !== undefined),
      )
      const highlighted = new Set(
        Object.keys(t.highlight).length ? source.filter((r) => has(r, t.highlight)).map((r) => r.__key) : [],
      )
      const trows: ReportRow[] = source.map((r) => ({ __key: r.__key, ...Object.fromEntries(picked.map((c) => [c.label, r[c.col]])) }))
      const ttotals = computeTotals(trows, cols, meta.ratios)
      // only the dimensions at the start are frozen (a frozen column after an unfrozen one breaks the layout)
      const lead = picked.slice(0, Math.max(0, picked.findIndex((c) => !meta.dims.includes(c.col)))).map((c) => c.label)
      const labelOf = new Map(picked.map((c) => [c.col, c.label]))
      const merge = t.merge.filter((m) => labelOf.has(m)).map((m) => labelOf.get(m)!)
      const columns = buildColumns(cols, trows, ttotals, { dims: lead, freezeDims, sortable: !merge.length })
      return {
        title: t.title,
        chart: t.chart,
        showTotals: t.totals,
        highlighted,
        source,
        cols,
        rows: trows,
        totals: ttotals,
        lead: lead.length,
        merge,
        columns: mergeCells(columns, trows, merge),
      }
    })
  }, [data, meta, formats, visibleRows, freezeDims])
  // Excel sheets of the tables as the page shows them: column widths, frozen dimensions, merged cells, 小计 / 合计 rows.
  const widths = (columns: { width?: unknown }[]) => columns.map((c) => c.width)
  const leadDims = (cols: ReportCol[]) => {
    const i = cols.findIndex((c) => !meta?.dims.includes(c.name))
    return i < 0 ? cols.length : i
  }
  const pivotSheet = (p: (typeof pivots)[number]): SheetTable => ({
    title: p.pivot.title,
    cols: p.cols,
    rows: p.rows,
    totals,
    dims: p.pivot.keys.length,
    widths: widths(p.columns),
    merge: p.pivot.keys.slice(0, p.pivot.merge),
    subtotalSpan: p.pivot.merge ? p.pivot.keys.length : 0,
  })
  const splitSheet = (t: (typeof splitTables)[number]): SheetTable => ({
    title: t.title,
    cols: t.cols,
    rows: t.rows,
    totals: t.showTotals ? t.totals : null,
    dims: t.lead,
    widths: widths(t.columns),
    merge: t.merge,
    highlighted: t.highlighted,
  })
  const detailSheet = (): SheetTable => ({
    title: meta?.pivots.length ? '明细' : (meta?.title ?? id),
    cols: shownCols,
    rows: visibleRows,
    totals,
    dims: leadDims(shownCols),
    widths: widths(columns),
  })
  const groupedSheet = (g: NonNullable<typeof grouped>): SheetTable => ({
    title: `按${g.groupBy}统计`,
    cols: g.cols,
    rows: g.rows,
    totals: g.totals,
    dims: 1,
    widths: widths(g.columns),
  })
  const save = (name: string, sheets: SheetTable[]) =>
    exportXlsx(`${name}_${date}.xlsx`, sheets, date).catch((e) => message.error(`导出失败：${(e as Error).message}`))
  // The page's 导出 Excel exports every table the page shows, one sheet each, in page order.
  const exportPage = () => {
    if (!data || !meta) return
    save(meta.title, [
      ...pivots.map(pivotSheet),
      ...splitTables.map(splitSheet),
      ...(meta.tables.length ? [] : [detailSheet()]),
      ...(grouped && grouped.rows.length ? [groupedSheet(grouped)] : []),
    ])
  }
  // a chart row is named by its dimensions, e.g. 「1手 · 东北」
  const rowName = useCallback(
    (r: Record<string, unknown>) => filterDims.map((d) => r[d] ?? '（空）').join(' · '),
    [filterDims],
  )

  const detailTable = (
    <Table<ReportRow>
      className="report-table"
      size="small"
      bordered
      rowKey="__key"
      loading={loading}
      columns={columns}
      dataSource={visibleRows}
      pagination={false}
      tableLayout="fixed"
      // A scroll box inside the scrolling page is awkward on a phone: there the header sticks instead.
      scroll={narrow ? { x: 'max-content' } : { x: 'max-content', y: 'calc(100vh - 320px)' }}
      sticky={narrow ? sticky : undefined}
      summary={() => (data && visibleRows.length > 0 ? <SummaryRow cols={shownCols} totals={totals} label="合计" /> : null)}
    />
  )

  return (
    <div className="page">
      <div className="page-title">
        <h2>{meta?.title ?? '报表'}</h2>
        <Typography.Text type="secondary">{meta?.description}</Typography.Text>
      </div>

      <Card size="small" style={{ marginBottom: 16 }}>
        <div className="filter-bar">
          {meta?.trend && (
            <Segmented
              value={view}
              onChange={(v) => setView(v as 'day' | 'trend')}
              options={[
                { value: 'day', label: '当日' },
                { value: 'trend', label: '月度趋势' },
              ]}
            />
          )}
          {view === 'day' ? (
            <Space size={6} className="filter-item">
              <Typography.Text>日期</Typography.Text>
              <Select
                style={{ width: 140 }}
                value={date}
                onChange={setDate}
                options={(meta?.dates ?? []).map((d) => ({ value: d, label: d }))}
              />
            </Space>
          ) : (
            <Space size={6} className="filter-item">
              <Typography.Text>月份</Typography.Text>
              <Select
                style={{ width: 120 }}
                value={month}
                onChange={setMonth}
                options={months.map((m) => ({ value: m, label: m }))}
              />
            </Space>
          )}
          {meta?.choices.map((c) => (
            <Space key={c.title} size={6} className="filter-item">
              <Typography.Text>{c.title}</Typography.Text>
              <Select
                style={{ minWidth: 140 }}
                value={chosen[c.title]}
                onChange={(v: string) => setChosen((s) => ({ ...s, [c.title]: v }))}
                options={c.options.map((o) => ({ value: o.label, label: o.label }))}
              />
            </Space>
          ))}
          {filterDims.map((d) => (
            <Space key={d} size={6} className="filter-item">
              <Typography.Text>{d}</Typography.Text>
              <Select
                mode="multiple"
                allowClear
                showSearch
                maxTagCount="responsive"
                style={{ minWidth: 160 }}
                placeholder="全部"
                value={selected[d] ?? []}
                onChange={(v: string[]) => setSelected((s) => ({ ...s, [d]: v }))}
                options={filterOptions[d] ?? []}
                optionFilterProp="label"
              />
            </Space>
          ))}
          {anyFilter && <Button onClick={() => setSelected({})}>清空筛选</Button>}
          {meta && meta.column_groups.length > 0 && (
            <Space size={6} className="filter-item">
              <Typography.Text>字段</Typography.Text>
              <Checkbox.Group
                options={[meta.base_group, ...meta.column_groups]}
                value={groupsOn}
                // keep at least one group, otherwise only the dimension columns would remain
                onChange={(v) => v.length && setGroupsOn(v as string[])}
              />
            </Space>
          )}
        </div>
      </Card>

      {view === 'trend' && meta?.trend && month ? (
        <Suspense fallback={<Spin style={{ display: 'block', margin: '48px auto' }} />}>
          <TrendView
            reportId={id}
            month={month}
            dates={monthDates}
            trend={meta.trend}
            ratios={meta.ratios}
            filter={matches}
          />
        </Suspense>
      ) : (
      <>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
          <Button
            icon={<DownloadOutlined />}
            disabled={!data}
            onClick={exportPage}
          >
            导出 Excel
          </Button>
          {data && (
            <Typography.Text type="secondary">
              {anyRowFilter ? `${visibleRows.length} / ${rows.length}` : rows.length} 行 · 查询耗时{' '}
              {(data.elapsed_ms / 1000).toFixed(1)}s
            </Typography.Text>
          )}
        </Space>
      </Card>

      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      {data && meta && meta.kpis.length > 0 && rows.length > 0 && (
        <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
          {meta.kpis.map((k) => {
            const v = totals[k] ?? null
            return (
              <Col key={k} xs={12} md={8} xl={{ span: 24 / Math.min(meta.kpis.length, 6), flex: 'auto' }}>
                <Card size="small" className="kpi-card">
                  <Statistic
                    title={k}
                    value={v === null ? '—' : formatValue(v, formats.get(k) ?? 'amount')}
                    className={isAttainColumn(k) ? attainClass(v) : undefined}
                  />
                </Card>
              </Col>
            )
          })}
        </Row>
      )}

      {charts.length > 0 && visibleRows.length > 0 && (
        <Suspense fallback={null}>
          {charts.map((c) => (
            <DayChart key={c.chart.title} chart={c.chart} groups={c.groups} formats={formats} />
          ))}
        </Suspense>
      )}

      {pivots.map((p) => (
        <Card
          key={p.pivot.title}
          size="small"
          title={p.pivot.title}
          style={{ marginBottom: 16 }}
          extra={
            <Button
              size="small"
              icon={<DownloadOutlined />}
              disabled={!p.rows.length}
              onClick={() => save(`${meta?.title ?? id}_${p.pivot.title}`, [pivotSheet(p)])}
            >
              导出 Excel
            </Button>
          }
        >
          <Table<ReportRow>
            className="report-table"
            size="small"
            bordered
            rowKey="__key"
            loading={loading}
            columns={p.columns}
            dataSource={p.rows}
            rowClassName={(r) => (isSubtotal(r) ? 'subtotal-row' : '')}
            pagination={false}
            tableLayout="fixed"
            scroll={{ x: 'max-content' }}
            sticky={sticky}
            summary={() => (p.rows.length > 0 ? <SummaryRow cols={p.cols} totals={totals} label="合计" /> : null)}
          />
        </Card>
      ))}

      {splitTables.map((t) => (
        <Card
          key={t.title}
          size="small"
          title={t.title}
          style={{ marginBottom: 16 }}
          extra={
            <Button
              size="small"
              icon={<DownloadOutlined />}
              disabled={!t.rows.length}
              onClick={() => save(`${meta?.title ?? id}_${t.title}`, [splitSheet(t)])}
            >
              导出 Excel
            </Button>
          }
        >
          {t.chart && t.source.length > 0 && (
            <Suspense fallback={null}>
              <GapChart chart={t.chart} rows={t.source} label={rowName} />
            </Suspense>
          )}
          <Table<ReportRow>
            className="report-table"
            size="small"
            bordered
            rowKey="__key"
            loading={loading}
            columns={t.columns}
            dataSource={t.rows}
            rowClassName={(r) => (t.highlighted.has(r.__key) ? 'highlight-row' : '')}
            pagination={false}
            tableLayout="fixed"
            scroll={{ x: 'max-content' }}
            sticky={sticky}
            summary={() => (t.showTotals && t.rows.length > 0 ? <SummaryRow cols={t.cols} totals={t.totals} label="合计" /> : null)}
          />
        </Card>
      ))}

      {meta && meta.tables.length > 0 ? null : meta && meta.pivots.length > 0 ? (
        <Collapse
          items={[
            {
              key: 'detail',
              label: `明细（${meta.dims.filter((d) => d !== '日期').join(' × ')}，${visibleRows.length} 行）`,
              children: detailTable,
            },
          ]}
        />
      ) : (
        detailTable
      )}

      {grouped && grouped.rows.length > 0 && (
        <Card
          size="small"
          title={`按${grouped.groupBy}统计`}
          extra={
            <Space size={8}>
              <Typography.Text type="secondary">随上方筛选变化</Typography.Text>
              <Button
                size="small"
                icon={<DownloadOutlined />}
                onClick={() => save(`${meta?.title ?? id}_按${grouped.groupBy}统计`, [groupedSheet(grouped)])}
              >
                导出 Excel
              </Button>
            </Space>
          }
          style={{ marginTop: 16 }}
        >
          <Table<ReportRow>
            className="report-table"
            size="small"
            bordered
            rowKey="__key"
            columns={grouped.columns}
            dataSource={grouped.rows}
            pagination={false}
            tableLayout="fixed"
            scroll={{ x: 'max-content' }}
            sticky={sticky}
            summary={() => <SummaryRow cols={grouped.cols} totals={grouped.totals} label="合计" />}
          />
        </Card>
      )}
      </>
      )}

      {meta && (
        <Collapse
          style={{ marginTop: 16 }}
          items={[
            {
              key: 'sql',
              label: 'SQL 原文（与 agents.md 一致）',
              children: <pre className="sql-source mono">{meta.sql}</pre>,
            },
          ]}
        />
      )}
    </div>
  )
}
