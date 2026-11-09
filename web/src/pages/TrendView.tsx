/**
 * 月度趋势: one month of daily snapshots of a report, totalled per day.
 * The amounts are month-to-date, so 当日新增 is the difference between consecutive snapshots.
 * Loaded on demand (ECharts is large), see Report.tsx.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Card, Col, Grid, Row as AntRow, Spin, Statistic, Table, Typography } from 'antd'
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import { api } from '../api'
import { attainClass, computeTotals, formatValue, isAttainColumn, type Fmt, type RatioDef } from '../format'
import { buildColumns, renderValue, useStickyHeader, type Col as ReportCol, type Row } from '../reportTable'

echarts.use([LineChart, BarChart, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent, CanvasRenderer])

export interface TrendDef {
  recovered: string
  timeline_target: string
  full_target: string
  last_period: string
  rates: string[]
  kpis: string[]
  table: string[]
}

interface Props {
  reportId: string
  month: string // YYYY-MM
  dates: string[] // the report's dates within the month
  trend: TrendDef
  ratios: Record<string, RatioDef>
  filter: (r: Row) => boolean // the page's dimension filters
}

interface Day {
  date: string
  totals: Record<string, number | string | null>
  increment: number | null
  /** Days of recovery in `increment`: more than 1 when earlier snapshots are missing. */
  span: number
}

const INCREMENT = '当日新增'

// Categorical slots 1-3 of the reference palette (validated all-pairs, light mode);
// reference lines and chrome are neutral grays, text never wears a series color.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a']
const SERIES_LIGHT = '#86b6ef' // blue step 250: 当日新增 spanning missing days
const REF = '#8a8984'
const GRID = '#e8e7e3'
const TEXT_2 = '#52514e'

const dayOfMonth = (d: string) => Number(d.slice(8, 10))
const daysInMonth = (month: string) => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()
const wan = (v: number) => `${(v / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}万`

function EChart({ option, height }: { option: EChartsCoreOption; height: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts>()
  useEffect(() => {
    const c = echarts.init(ref.current!)
    chart.current = c
    const ro = new ResizeObserver(() => c.resize())
    ro.observe(ref.current!)
    return () => {
      ro.disconnect()
      c.dispose()
    }
  }, [])
  useEffect(() => {
    chart.current?.setOption(option, true)
  }, [option])
  return <div ref={ref} style={{ width: '100%', height }} />
}

export default function TrendView({ reportId, month, dates, trend, ratios, filter }: Props) {
  const [data, setData] = useState<{ columns: ReportCol[]; rows: unknown[][] }>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const narrow = !Grid.useBreakpoint().md
  const sticky = useStickyHeader()

  useEffect(() => {
    if (!dates.length) return
    let cancelled = false
    setLoading(true)
    setError(undefined)
    const q = dates.map((d) => `date=${encodeURIComponent(d)}`).join('&')
    api<{ columns: ReportCol[]; rows: unknown[][] }>(`/api/reports/${reportId}/data?${q}`)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [reportId, dates])

  const formats = useMemo(() => {
    const m = new Map<string, Fmt>(data?.columns.map((c) => [c.name, c.format]) ?? [])
    m.set(INCREMENT, 'amount')
    return m
  }, [data])

  const days: Day[] = useMemo(() => {
    if (!data) return []
    const byDate = new Map<string, Row[]>()
    data.rows.forEach((r, i) => {
      const o: Row = { __key: i }
      data.columns.forEach((c, j) => (o[c.name] = r[j]))
      if (!filter(o)) return
      const d = String(o['日期'])
      if (!byDate.has(d)) byDate.set(d, [])
      byDate.get(d)!.push(o)
    })
    let prev: Day | null = null
    return Array.from(byDate.keys())
      .sort()
      .map((date) => {
        const totals = computeTotals(byDate.get(date)!, data.columns, ratios)
        const cum = totals[trend.recovered]
        const prevCum = prev?.totals[trend.recovered]
        const day: Day = {
          date,
          totals,
          // The first snapshot of the month holds everything since the 1st.
          increment: typeof cum !== 'number' ? null : prev ? (typeof prevCum === 'number' ? cum - prevCum : null) : cum,
          span: prev ? dayOfMonth(date) - dayOfMonth(prev.date) : dayOfMonth(date),
        }
        prev = day
        return day
      })
  }, [data, filter, ratios, trend.recovered])

  const latest = days[days.length - 1]
  const axisDays = useMemo(
    () => Array.from({ length: daysInMonth(month) }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
    [month],
  )

  const charts = useMemo(() => {
    const byDate = new Map(days.map((d) => [d.date, d]))
    const at = (col: string) =>
      axisDays.map((d) => {
        const v = byDate.get(d)?.totals[col]
        return typeof v === 'number' ? v : null
      })
    const fmtTooltip = (fmt: Fmt) => (params: { axisValue: string; seriesName: string; value: number | null; marker: string }[]) => {
      const rows = params
        .filter((p) => p.value !== null && p.value !== undefined)
        .map((p) => `${p.marker}${p.seriesName}　<b>${formatValue(p.value, fmt)}</b>`)
      const day = byDate.get(params[0]?.axisValue)
      const note = day && day.span > 1 && fmt === 'amount' && params.some((p) => p.seriesName === INCREMENT)
        ? `<br/><span style="color:${REF}">含 ${day.span} 天的数据（${day.span === dayOfMonth(day.date) ? '月初至今' : '前面有缺失日期'}）</span>`
        : ''
      return rows.length ? `${params[0].axisValue}<br/>${rows.join('<br/>')}${note}` : `${params[0]?.axisValue}<br/>无数据`
    }
    const base = {
      animation: false,
      textStyle: { fontFamily: 'inherit', color: TEXT_2 },
      grid: { left: 8, right: narrow ? 16 : 96, top: 36, bottom: 8, containLabel: true },
      xAxis: {
        type: 'category',
        data: axisDays,
        boundaryGap: false,
        axisLine: { lineStyle: { color: GRID } },
        axisTick: { show: false },
        axisLabel: { color: TEXT_2, formatter: (d: string) => d.slice(5) },
      },
      tooltip: { trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: REF } } },
      legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 3, textStyle: { color: TEXT_2 } },
    }
    const valueAxis = (formatter: (v: number) => string, include?: number) => ({
      type: 'value',
      // keep a reference line (e.g. 100%目标) inside the plot even when the data is far below it
      max: include === undefined ? undefined : ({ max }: { max: number }) => Math.max(max, include) * 1.1,
      axisLabel: { color: TEXT_2, formatter, showMaxLabel: include === undefined },
      splitLine: { lineStyle: { color: GRID, type: 'solid' } },
    })
    const line = (name: string, data: (number | null)[], color: string, extra: object = {}) => ({
      name,
      type: 'line',
      data,
      connectNulls: true,
      showSymbol: true,
      symbolSize: 8,
      lineStyle: { width: 2, color, cap: 'round', join: 'round' },
      itemStyle: { color, borderColor: '#fff', borderWidth: 2 },
      endLabel: narrow ? undefined : { show: true, formatter: '{a}', color: TEXT_2 },
      ...extra,
    })
    const refLine = (label: string, value: number) => ({
      silent: true,
      symbol: 'none',
      lineStyle: { color: REF, width: 1, type: 'solid' },
      label: { position: 'insideEndTop', color: TEXT_2, formatter: label },
      data: [{ yAxis: value }],
    })
    const full = latest?.totals[trend.full_target]

    const cumulative: EChartsCoreOption = {
      ...base,
      xAxis: { ...base.xAxis, boundaryGap: false },
      yAxis: valueAxis(wan, typeof full === 'number' ? full : undefined),
      tooltip: { ...base.tooltip, formatter: fmtTooltip('amount') },
      series: [
        line(trend.recovered, at(trend.recovered), SERIES[0], {
          markLine: typeof full === 'number' ? refLine(`${trend.full_target} ${wan(full)}`, full) : undefined,
        }),
        line(trend.timeline_target, at(trend.timeline_target), SERIES[1]),
        line(trend.last_period, at(trend.last_period), SERIES[2]),
      ],
    }

    const increments: EChartsCoreOption = {
      ...base,
      legend: undefined,
      grid: { ...base.grid, top: 16 },
      xAxis: { ...base.xAxis, boundaryGap: true },
      yAxis: valueAxis(wan),
      tooltip: { ...base.tooltip, axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(0,0,0,0.04)' } }, formatter: fmtTooltip('amount') },
      series: [
        {
          name: INCREMENT,
          type: 'bar',
          barMaxWidth: 24,
          data: axisDays.map((d) => {
            const day = byDate.get(d)
            if (!day || day.increment === null) return null
            return {
              value: day.increment,
              itemStyle: { color: day.span > 1 ? SERIES_LIGHT : SERIES[0], borderRadius: [4, 4, 0, 0] },
            }
          }),
        },
      ],
    }

    const rates: EChartsCoreOption = {
      ...base,
      yAxis: valueAxis((v) => `${Math.round(v * 100)}%`, 1),
      tooltip: { ...base.tooltip, formatter: fmtTooltip('pct') },
      series: trend.rates.map((r, i) =>
        line(r, at(r), SERIES[i], i === 0 ? { markLine: refLine('100%', 1) } : {}),
      ),
    }
    return { cumulative, increments, rates }
  }, [days, axisDays, latest, trend, narrow])

  const tableCols: ReportCol[] = useMemo(
    () => [{ name: '日期', format: 'text' }, ...trend.table.map((name) => ({ name, format: formats.get(name) ?? 'amount' }))],
    [trend.table, formats],
  )
  const tableRows: Row[] = useMemo(
    () =>
      [...days].reverse().map((d) => ({ __key: d.date, ...d.totals, 日期: d.date, [INCREMENT]: d.increment, __span: d.span })),
    [days],
  )
  const columns = useMemo(
    () =>
      buildColumns(tableCols, tableRows, {}, { dims: ['日期'], freezeDims: !narrow }).map((c) =>
        c.key === INCREMENT
          ? {
              ...c,
              render: (v: unknown, r: Row) => (
                <>
                  {renderValue(INCREMENT, 'amount', v)}
                  {(r.__span as number) > 1 && v != null && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {' '}
                      ·{String(r.__span)}天
                    </Typography.Text>
                  )}
                </>
              ),
            }
          : c,
      ),
    [tableCols, tableRows, narrow],
  )

  if (error) return <Alert type="error" message={error} showIcon />

  return (
    <Spin spinning={loading} delay={200}>
      {/* Hold the previous render while a new month loads, no skeleton flash. */}
      <div style={{ opacity: loading && data ? 0.5 : 1 }}>
        {days.length > 0 && days.length < 3 && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={`${month} 目前只有 ${days.length} 天的数据（${days.map((d) => d.date.slice(5)).join('、')}），每天导入后趋势会逐步完整。`}
          />
        )}
        {data && days.length === 0 && <Alert type="info" showIcon message="当前筛选下没有数据" style={{ marginBottom: 16 }} />}

        {latest && (
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
            截至 {latest.date}（本月最新一天）
          </Typography.Text>
        )}
        {latest && (
          <AntRow gutter={[12, 12]} style={{ marginBottom: 16 }}>
            {trend.kpis.map((k) => {
              const v = latest.totals[k] ?? null
              return (
                <Col key={k} xs={12} md={8} xl={24 / Math.min(trend.kpis.length, 6)} flex="auto">
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
          </AntRow>
        )}

        <Card size="small" title={`${trend.recovered}走势`} style={{ marginBottom: 16 }}>
          <EChart option={charts.cumulative} height={320} />
        </Card>
        <AntRow gutter={16}>
          <Col xs={24} lg={12}>
            <Card
              size="small"
              title="每日新增"
              extra={<Typography.Text type="secondary">浅色柱：含多天的数据（月初或有缺失日期）</Typography.Text>}
              style={{ marginBottom: 16 }}
            >
              <EChart option={charts.increments} height={260} />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card size="small" title="达成率走势" style={{ marginBottom: 16 }}>
              <EChart option={charts.rates} height={260} />
            </Card>
          </Col>
        </AntRow>

        <Card size="small" title="每日数据">
          <Table<Row>
            className="report-table"
            size="small"
            bordered
            rowKey="__key"
            columns={columns}
            dataSource={tableRows}
            pagination={false}
            tableLayout="fixed"
            scroll={{ x: 'max-content' }}
            sticky={sticky}
          />
        </Card>
      </div>
    </Spin>
  )
}
