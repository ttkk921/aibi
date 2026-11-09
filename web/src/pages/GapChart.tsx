/**
 * A split table's gap chart (package `tables[].chart`): one horizontal bar per row, on a single amount axis.
 * The bar is the row's `value` (e.g. 销售额), then the distance to the one ahead, then on to the one after
 * that (gaps are measured from the end of the value, so each segment is the increase over the previous gap).
 * Loaded on demand (ECharts is large), see Report.tsx.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Typography } from 'antd'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'
import { formatValue } from '../format'
import { short } from './DayChart'

echarts.use([BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer])

export interface GapChartDef {
  value: { col: string; label: string }
  gaps: { col: string; label: string; name: string | null }[]
}

// Reference palette (light mode): categorical slots 1-3 in order (validated together), chrome.
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a']
const SURFACE = '#ffffff'
const GRID = '#e8e7e3'
const TEXT_2 = '#52514e'
const ROW = 26
// Below this chart width (a phone) the row names get less room.
const NARROW = 400

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export default function GapChart({ chart, rows, label }: { chart: GapChartDef; rows: Record<string, unknown>[]; label: (r: Record<string, unknown>) => string }) {
  const ref = useRef<HTMLDivElement>(null)
  const instance = useRef<echarts.ECharts | null>(null)
  const [narrow, setNarrow] = useState(false)

  const option = useMemo((): EChartsCoreOption => {
    const names = rows.map(label)
    // per row: [value, gap 1, gap 2 - gap 1, ...]; a missing gap (already first) ends the bar there
    const segments = rows.map((r) => {
      const out: (number | null)[] = [num(r[chart.value.col])]
      let prev = 0
      for (const g of chart.gaps) {
        const v = num(r[g.col])
        out.push(v === null || out[out.length - 1] === null ? null : Math.max(v - prev, 0))
        if (v !== null) prev = v
      }
      return out
    })
    const series = [chart.value.label, ...chart.gaps.map((g) => g.label)].map((name, k) => ({
      name,
      type: 'bar',
      stack: 'bar',
      barMaxWidth: 16,
      itemStyle: { color: SERIES[k] }, // the legend takes the series color
      data: segments.map((seg) => {
        const v = seg[k]
        if (v === null || v === undefined) return null
        // round the free end of the bar only: the last segment that is drawn
        const last = seg.slice(k + 1).every((x) => !x)
        return {
          value: v,
          itemStyle: { color: SERIES[k], borderColor: SURFACE, borderWidth: k ? 1 : 0, borderRadius: last ? [0, 4, 4, 0] : 0 },
        }
      }),
    }))
    return {
      animation: false,
      textStyle: { fontFamily: 'inherit', color: TEXT_2 },
      legend: { top: 0, left: 0, icon: 'roundRect', itemWidth: 12, itemHeight: 8, textStyle: { color: TEXT_2 } },
      grid: { left: 4, right: 24, top: 32, bottom: 4, containLabel: true },
      tooltip: {
        trigger: 'axis',
        confine: true,
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(0,0,0,0.04)' } },
        formatter: (ps: { dataIndex: number }[]) => {
          const r = rows[ps[0].dataIndex]
          const lines = [`<b>${names[ps[0].dataIndex]}</b>`, `${chart.value.label}　<b>${formatValue(r[chart.value.col], 'amount')}</b>`]
          for (const g of chart.gaps) {
            if (num(r[g.col]) === null) continue
            const who = g.name && r[g.name] != null ? `（${r[g.name]}）` : ''
            lines.push(`${g.label}${who}　<b>${formatValue(r[g.col], 'amount')}</b>`)
          }
          return lines.join('<br/>')
        },
      },
      xAxis: {
        type: 'value',
        axisLabel: { color: TEXT_2, formatter: (v: number) => short(v, 'amount'), hideOverlap: true },
        splitLine: { lineStyle: { color: GRID } },
      },
      yAxis: {
        type: 'category',
        data: names,
        inverse: true, // first row at the top, as in the table
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: TEXT_2, interval: 0, width: narrow ? 84 : 140, overflow: 'truncate' },
      },
      series,
    }
  }, [chart, rows, label, narrow])

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

  return (
    <div style={{ marginBottom: 12 }}>
      <div ref={ref} style={{ width: '100%', height: Math.max(140, rows.length * ROW + 48) }} />
      <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
        每根条：{chart.value.label}，接着是{chart.gaps.map((g) => g.label).join('、')}还需补上的金额（同一金额轴）；已是第一的只有{chart.value.label}。悬停看金额和明细。
      </Typography.Text>
    </div>
  )
}
