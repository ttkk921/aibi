/**
 * Charts of the selected day above a report's tables (package `charts` / summary table `chart`):
 * a horizontal bar chart per metric, two per row, every panel listing the groups in the same order.
 *   rates (达成率): a 100% line; bars at or above it are blue, bars below it red.
 *   amounts with both signs (缺口, 差距): positive (still behind) keeps the accent, negative goes gray.
 * Loaded on demand (ECharts is large), see Report.tsx and SummaryReport.tsx.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Card, Col, Row, Typography } from 'antd'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, MarkLineComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import { compareValues, formatValue, type Fmt } from '../format'

echarts.use([BarChart, GridComponent, MarkLineComponent, TooltipComponent, CanvasRenderer])

export interface ChartDef {
  title: string
  metrics: { col: string; label: string }[]
  by: string[]
}

/** One bar of every panel: a group's name and its summarized values. */
export interface ChartGroup {
  name: string
  values: Record<string, unknown>
}

// Reference palette (light mode): categorical slot 1, below-target red, de-emphasis gray, chrome.
const ACCENT = '#2a78d6'
const BAD = '#d93f3f'
const MUTED = '#c3c2b7'
const REF = '#8a8984'
const GRID = '#e8e7e3'
const TEXT_2 = '#52514e'

// Below this panel width (a phone) the value axis gets fewer ticks.
const NARROW = 400
const ROW = 26
// Rates far above target (a 门店 with a tiny 序时目标) would squash every other bar: the axis stops here.
const RATE_CAP = 3

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export const short = (v: number, fmt: Fmt) => {
  if (fmt === 'pct') return `${Math.round(v * 100)}%`
  if (fmt !== 'amount') return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)}亿`
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}万`
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

function panelOption(names: string[], values: unknown[], label: string, fmt: Fmt, narrow: boolean): EChartsCoreOption {
  const nums = values.filter(isNum)
  const rate = fmt === 'pct'
  const lo = Math.min(0, ...nums)
  const hi = rate ? Math.max(1, ...nums.map((v) => Math.min(v, RATE_CAP))) : Math.max(0, ...nums)
  // leave room for the value written past each bar end
  const pad = (hi - lo || 1) * (narrow ? 0.32 : 0.22)
  const signed = lo < 0
  const color = (v: number) => (rate ? (v >= 1 ? ACCENT : BAD) : !signed || v > 0 ? ACCENT : MUTED)
  return {
    animation: false,
    textStyle: { fontFamily: 'inherit', color: TEXT_2 },
    grid: { left: 4, right: 20, top: 4, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(0,0,0,0.04)' } },
      formatter: (ps: { dataIndex: number }[]) =>
        `<b>${names[ps[0].dataIndex]}</b><br/>${label}　<b>${formatValue(values[ps[0].dataIndex], fmt)}</b>`,
    },
    xAxis: {
      type: 'value',
      min: signed ? lo - pad : 0,
      max: hi > 0 ? hi + pad : 0,
      splitNumber: narrow ? 2 : 4,
      axisLabel: { color: TEXT_2, formatter: (v: number) => short(v, fmt), hideOverlap: true, showMinLabel: !signed, showMaxLabel: false },
      splitLine: { lineStyle: { color: GRID } },
    },
    yAxis: {
      type: 'category',
      data: names,
      inverse: true, // first group at the top
      axisLine: { onZero: false, show: false },
      axisTick: { show: false },
      axisLabel: { color: TEXT_2, interval: 0, width: narrow ? 100 : 120, overflow: 'truncate' },
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 16,
        data: values.map((v) =>
          isNum(v)
            ? {
                value: rate ? Math.min(v, RATE_CAP) : v,
                itemStyle: { color: color(v), borderRadius: v >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4] },
                label: {
                  show: true,
                  position: v >= 0 ? 'right' : 'left',
                  color: TEXT_2,
                  // a rate beyond the axis ends at RATE_CAP and says so
                  formatter: short(v, fmt) + (rate && v > RATE_CAP ? ' ›' : ''),
                },
              }
            : null,
        ),
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: REF, width: 1, type: 'solid' },
          data: rate ? [{ xAxis: 1 }] : signed ? [{ xAxis: 0 }] : [],
        },
      },
    ],
  }
}

function Panel({ names, values, label, fmt }: { names: string[]; values: unknown[]; label: string; fmt: Fmt }) {
  const ref = useRef<HTMLDivElement>(null)
  const instance = useRef<echarts.ECharts | null>(null)
  const [narrow, setNarrow] = useState(false)
  const option = useMemo(() => panelOption(names, values, label, fmt, narrow), [names, values, label, fmt, narrow])

  useEffect(() => {
    const c = echarts.init(ref.current!)
    instance.current = c
    const ro = new ResizeObserver(([entry]) => {
      setNarrow(entry.contentRect.width < NARROW)
      c.resize()
    })
    ro.observe(ref.current!)
    return () => {
      ro.disconnect()
      c.dispose()
      instance.current = null
    }
  }, [])

  useEffect(() => {
    instance.current?.setOption(option, true)
  }, [option])

  return <div ref={ref} style={{ width: '100%', height: Math.max(120, names.length * ROW + 32) }} />
}

export default function DayChart({ chart, groups, formats }: { chart: ChartDef; groups: ChartGroup[]; formats: Map<string, Fmt> }) {
  // the same order in every panel: by the first metric, largest first
  const first = chart.metrics[0].col
  const ordered = useMemo(() => [...groups].sort((a, b) => compareValues(b.values[first], a.values[first])), [groups, first])
  const names = useMemo(() => ordered.map((g) => g.name), [ordered])
  const panels = useMemo(
    () => chart.metrics.map((m) => ({ ...m, fmt: formats.get(m.col) ?? 'amount', values: ordered.map((g) => g.values[m.col]) })),
    [chart, ordered, formats],
  )
  const rateCut = panels.some((p) => p.fmt === 'pct' && p.values.some((v) => isNum(v) && v > RATE_CAP))

  return (
    <Card size="small" title={chart.title} style={{ marginBottom: 16 }}>
      <Row gutter={[24, 16]}>
        {panels.map((p) => (
          <Col key={p.col} xs={24} lg={12}>
            <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>
              {p.label}
            </Typography.Text>
            <Panel names={names} values={p.values} label={p.label} fmt={p.fmt} />
          </Col>
        ))}
      </Row>
      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 8 }}>
        各图都按「{chart.metrics[0].label}」从大到小排列。达成率：竖线是 100%，蓝色是达到的，红色是没达到的；缺口：蓝色是还差的金额，灰色是已超出的；空白表示没有目标。
        {rateCut && `达成率超过 ${RATE_CAP * 100}% 的条画到 ${RATE_CAP * 100}% 为止（标 ›），数字是实际值。`}
      </Typography.Text>
    </Card>
  )
}
