/**
 * A chart drawn by the AI 问数 `show_chart` tool. One value axis (the backend refuses mixed
 * units), fixed categorical colors in slot order, thin marks, hover tooltips, and a
 * 「查看数据」 table for every chart. Loaded on demand (ECharts is large).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Table, Typography } from 'antd'
import { TableOutlined } from '@ant-design/icons'
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'

echarts.use([BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

export interface ChartResult {
  kind: 'chart'
  title: string
  type: 'bar' | 'line' | 'stacked_bar' | 'pie'
  horizontal: boolean
  x: string
  series: { name: string; format: 'amount' | 'pct' | 'count' | 'number' }[]
  // Single bar series with both signs: the side the question is about keeps the accent, the other goes gray.
  emphasize?: 'positive' | 'negative' | null
  points: unknown[][]
  source: string
  note: string | null
}

// Categorical slots of the reference palette, in their validated order (light mode).
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300']
const GRID = '#e8e7e3'
const TEXT_2 = '#52514e'
const SURFACE = '#ffffff'
const MUTED = '#c3c2b7' // de-emphasis gray of the reference palette

function fmtValue(v: unknown, format: ChartResult['series'][number]['format'], short = false): string {
  if (typeof v !== 'number') return v == null ? '—' : String(v)
  switch (format) {
    case 'pct':
      return `${(v * 100).toFixed(short ? 1 : 2)}%`
    case 'amount':
      if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿`
      if (Math.abs(v) >= 1e4) return `${(v / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: short ? 0 : 2 })}万`
      return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
    default:
      return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  }
}

// Below this chart width (a phone) the value axis gets fewer ticks, so labels like 「200万」 don't run together.
const NARROW = 480

function buildOption(c: ChartResult, narrow: boolean): EChartsCoreOption {
  const format = c.series[0]?.format ?? 'number'
  const categories = c.points.map((p) => String(p[0]))
  const multi = c.series.length > 1
  const tooltipFormatter = (params: { axisValue?: string; name: string; marker: string; seriesName: string; value: unknown; percent?: number }[] | { name: string; marker: string; value: unknown; percent?: number }) => {
    if (!Array.isArray(params)) {
      return `${params.marker}${params.name}　<b>${fmtValue(params.value, format)}</b>（${params.percent?.toFixed(1)}%）`
    }
    const head = params[0]?.axisValue ?? params[0]?.name
    return [head, ...params.map((p) => `${p.marker}${p.seriesName}　<b>${fmtValue(p.value, format)}</b>`)].join('<br/>')
  }
  const base = {
    animation: false,
    color: SERIES,
    textStyle: { fontFamily: 'inherit', color: TEXT_2 },
    legend: multi || c.type === 'pie' ? { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, textStyle: { color: TEXT_2 } } : undefined,
    tooltip: { trigger: c.type === 'pie' ? 'item' : 'axis', axisPointer: { type: c.type === 'line' ? 'line' : 'shadow', shadowStyle: { color: 'rgba(0,0,0,0.04)' } }, formatter: tooltipFormatter },
  }
  if (c.type === 'pie') {
    return {
      ...base,
      series: [
        {
          type: 'pie',
          radius: ['45%', '70%'],
          top: 24,
          itemStyle: { borderColor: SURFACE, borderWidth: 2 },
          label: { color: TEXT_2, formatter: (p: { name: string; value: number; percent: number }) => `${p.name}\n${fmtValue(p.value, format, true)}（${p.percent.toFixed(1)}%）` },
          data: c.points.map((p) => ({ name: String(p[0]), value: p[1] })),
        },
      ],
    }
  }
  const valueAxis = {
    type: 'value',
    splitNumber: narrow ? 3 : 5,
    axisLabel: { color: TEXT_2, formatter: (v: number) => fmtValue(v, format, true), hideOverlap: true },
    splitLine: { lineStyle: { color: GRID, type: 'solid' } },
  }
  const categoryAxis = {
    type: 'category',
    data: categories,
    inverse: c.horizontal, // first item at the top, as in a ranking
    axisLine: { lineStyle: { color: GRID } },
    axisTick: { show: false },
    axisLabel: { color: TEXT_2, interval: c.horizontal ? 0 : 'auto', hideOverlap: true },
  }
  const stacked = c.type === 'stacked_bar'
  const radius = c.horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]
  return {
    ...base,
    grid: { left: 8, right: 24, top: multi ? 32 : 12, bottom: 8, containLabel: true },
    xAxis: c.horizontal ? valueAxis : categoryAxis,
    yAxis: c.horizontal ? categoryAxis : valueAxis,
    series: c.series.map((s, i) =>
      c.type === 'line'
        ? {
            name: s.name,
            type: 'line',
            data: c.points.map((p) => p[i + 1]),
            connectNulls: true,
            showSymbol: c.points.length <= 31,
            symbolSize: 8,
            lineStyle: { width: 2, cap: 'round', join: 'round' },
            itemStyle: { borderColor: SURFACE, borderWidth: 2 },
          }
        : {
            name: s.name,
            type: 'bar',
            stack: stacked ? 'total' : undefined,
            barMaxWidth: 24,
            data: c.points.map((p) => p[i + 1]),
            itemStyle: {
              color: c.emphasize
                ? ({ value }: { value: unknown }) =>
                    typeof value === 'number' && (c.emphasize === 'positive' ? value > 0 : value < 0) ? SERIES[0] : MUTED
                : undefined,
              // stacked segments are separated by a thin surface gap; only the outer end is rounded
              borderRadius: stacked ? (i === c.series.length - 1 ? radius : 0) : radius,
              borderColor: stacked ? SURFACE : undefined,
              borderWidth: stacked ? 1 : 0,
            },
          },
    ),
  }
}

export default function ChatChart({ chart }: { chart: ChartResult }) {
  const ref = useRef<HTMLDivElement>(null)
  const instance = useRef<echarts.ECharts | null>(null)
  const [showData, setShowData] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const option = useMemo(() => buildOption(chart, narrow), [chart, narrow])
  const height =
    chart.type === 'pie' ? 300 : chart.horizontal ? Math.min(720, Math.max(220, chart.points.length * 28 + 60)) : 300

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

  const format = chart.series[0]?.format ?? 'number'
  return (
    <div className="chat-chart">
      <div className="chat-chart-head">
        <b>{chart.title}</b>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {chart.source}
        </Typography.Text>
      </div>
      <div ref={ref} style={{ width: '100%', height }} />
      {chart.emphasize && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {chart.emphasize === 'positive' ? '蓝色为正数，灰色为负数' : '蓝色为负数，灰色为正数'}
          </Typography.Text>
        </div>
      )}
      {chart.note && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {chart.note}
        </Typography.Text>
      )}
      <div>
        <Button size="small" type="link" icon={<TableOutlined />} onClick={() => setShowData((s) => !s)} style={{ paddingLeft: 0 }}>
          {showData ? '收起数据' : '查看数据'}
        </Button>
      </div>
      {showData && (
        <Table
          size="small"
          bordered
          rowKey={(_, i) => String(i)}
          pagination={chart.points.length > 20 ? { pageSize: 20, size: 'small', showSizeChanger: false } : false}
          dataSource={chart.points.map((p) => Object.fromEntries([[chart.x, p[0]], ...chart.series.map((s, i) => [s.name, p[i + 1]])]))}
          columns={[
            { title: chart.x, dataIndex: chart.x, key: chart.x },
            ...chart.series.map((s) => ({
              title: s.name,
              dataIndex: s.name,
              key: s.name,
              align: 'right' as const,
              render: (v: unknown) => fmtValue(v, format),
            })),
          ]}
        />
      )}
    </div>
  )
}
