/**
 * One AI 问数 answer as the user saw it: text, query results (collapsible tables with their SQL), charts and
 * SQL confirmations. Built from the /api/chat events, so the drawer and the history page show the same thing.
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, App, Button, Space, Table, Tag, Typography } from 'antd'
import {
  CheckOutlined,
  CloseOutlined,
  CodeOutlined,
  CopyOutlined,
  DownOutlined,
  DownloadOutlined,
  LoadingOutlined,
  RightOutlined,
  StopOutlined,
  TableOutlined,
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
// Chinese answers put ** right next to full-width punctuation (「**达成率（48%）**的」), which
// plain CommonMark leaves as literal asterisks.
import remarkCjkFriendly from 'remark-cjk-friendly'
import { formatValue, type Fmt } from '../format'
import { exportXlsx } from '../xlsx'
import type { ChartResult } from './ChatChart'

// ECharts only loads once the AI draws its first chart.
const ChatChart = lazy(() => import('./ChatChart'))

interface ResultColumn {
  name: string
  format: Fmt | 'raw'
}

export interface ToolResult {
  kind: 'report' | 'sql' | 'error' | 'cancelled'
  result_id?: string
  title?: string
  error?: string
  sql?: string
  report_title?: string
  dates?: string[]
  group_by?: string[]
  columns?: ResultColumn[]
  rows?: unknown[][]
  row_count?: number
  truncated?: boolean
  total?: Record<string, unknown> | null
}

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; title: string; sql?: string | null; running: boolean; result?: ToolResult | ChartResult }
  | { kind: 'confirm'; id: string; title: string; sql: string; state: 'waiting' | 'approved' | 'cancelled' }

export interface Turn {
  role: 'user' | 'assistant'
  text?: string
  context?: string
  blocks: Block[]
  status?: string
  error?: string
  done?: boolean
  stopped?: boolean
}

function cellText(v: unknown, format: ResultColumn['format']): string {
  if (v === null || v === undefined) return '—'
  if (format === 'raw') return typeof v === 'number' ? v.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) : String(v)
  return formatValue(v, format)
}

function ResultTable({ result }: { result: ToolResult }) {
  const cols = result.columns ?? []
  const rows = result.rows ?? []
  const data = rows.map((r, i) => Object.fromEntries([['__key', i], ...cols.map((c, j) => [c.name, r[j]])]))
  const numeric = (c: ResultColumn) => c.format !== 'text' && rows.some((r) => typeof r[cols.indexOf(c)] === 'number')
  return (
    <Table
      size="small"
      bordered
      rowKey="__key"
      dataSource={data}
      pagination={rows.length > 20 ? { pageSize: 20, size: 'small', showSizeChanger: false } : false}
      scroll={{ x: 'max-content' }}
      columns={cols.map((c) => ({
        title: c.name,
        dataIndex: c.name,
        key: c.name,
        align: numeric(c) ? ('right' as const) : ('left' as const),
        render: (v: unknown) => cellText(v, c.format),
      }))}
      summary={() =>
        result.total ? (
          <Table.Summary.Row>
            {cols.map((c, i) => (
              <Table.Summary.Cell key={c.name} index={i} align={numeric(c) ? 'right' : 'left'}>
                <b>{i === 0 ? '合计' : result.total![c.name] == null ? '' : cellText(result.total![c.name], c.format)}</b>
              </Table.Summary.Cell>
            ))}
          </Table.Summary.Row>
        ) : null
      }
    />
  )
}

function ToolBlock({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  const r = block.result as ToolResult | undefined
  const ok = r && (r.kind === 'report' || r.kind === 'sql')
  const [open, setOpen] = useState(false)
  const { message } = App.useApp()
  const navigate = useNavigate()
  const sql = r?.sql ?? block.sql ?? undefined

  useEffect(() => {
    // Small results open by themselves; big ones stay one click away.
    if (ok && (r.row_count ?? 0) <= 15) setOpen(true)
  }, [ok, r])

  const meta = r?.kind === 'report'
    ? [r.result_id, r.report_title, r.dates?.join('、'), r.group_by?.length ? `按${r.group_by.join('、')}` : '明细', `${r.row_count} 行`]
    : r?.kind === 'sql'
      ? [r.result_id, 'SQL', `${r.row_count} 行${r.truncated ? '（已截断）' : ''}`]
      : []

  return (
    <div className="chat-tool">
      <div className="chat-tool-head" onClick={() => ok && setOpen((o) => !o)}>
        {block.running ? <LoadingOutlined /> : ok ? (open ? <DownOutlined /> : <RightOutlined />) : r?.kind === 'cancelled' ? <StopOutlined /> : <CloseOutlined />}
        {r?.kind === 'sql' || block.sql ? <CodeOutlined /> : <TableOutlined />}
        <span className="chat-tool-title">{block.title}</span>
        {ok && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{meta.filter(Boolean).join(' · ')}</Typography.Text>}
        {block.running && <Typography.Text type="secondary" style={{ fontSize: 12 }}>查询中…</Typography.Text>}
        {r?.kind === 'cancelled' && <Typography.Text type="secondary" style={{ fontSize: 12 }}>已取消，未执行</Typography.Text>}
      </div>
      {r?.kind === 'error' && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
          出错：{r.error}（AI 会根据错误自动调整）
        </Typography.Text>
      )}
      {open && ok && (
        <div className="chat-tool-body">
          {sql && <pre className="chat-sql mono">{sql}</pre>}
          <ResultTable result={r} />
          <Space size={4} style={{ marginTop: 6 }} wrap>
            <Button
              size="small"
              icon={<DownloadOutlined />}
              onClick={() => {
                const cols = r.columns ?? []
                exportXlsx(`${block.title}.xlsx`, [
                  {
                    title: block.title,
                    cols,
                    rows: (r.rows ?? []).map((row, i) => ({ __key: i, ...Object.fromEntries(cols.map((c, j) => [c.name, row[j]])) })),
                    totals: r.total,
                  },
                ]).catch((e) => message.error(`导出失败：${(e as Error).message}`))
              }}
            >
              导出 Excel
            </Button>
            {sql && (
              <>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => navigator.clipboard?.writeText(sql).then(() => message.success('SQL 已复制'))}
                >
                  复制 SQL
                </Button>
                <Button size="small" icon={<CodeOutlined />} onClick={() => navigate('/sql', { state: { sql } })}>
                  在 SQL 查询页打开
                </Button>
              </>
            )}
          </Space>
        </div>
      )}
    </div>
  )
}

function ConfirmBlock({
  block,
  onAnswer,
  disabled,
}: {
  block: Extract<Block, { kind: 'confirm' }>
  /** absent on the history page: the buttons are not shown */
  onAnswer?: (approve: boolean) => void
  disabled: boolean
}) {
  return (
    <div className="chat-confirm">
      <div style={{ marginBottom: 6 }}>
        <b>AI 想执行这条 SQL：</b>
        {block.title}
      </div>
      <pre className="chat-sql mono">{block.sql}</pre>
      {block.state === 'waiting' && !onAnswer ? (
        <Tag>没有回复</Tag>
      ) : block.state === 'waiting' && onAnswer ? (
        <Space>
          <Button type="primary" size="small" icon={<CheckOutlined />} disabled={disabled} onClick={() => onAnswer(true)}>
            执行
          </Button>
          <Button size="small" icon={<CloseOutlined />} disabled={disabled} onClick={() => onAnswer(false)}>
            取消
          </Button>
        </Space>
      ) : (
        <Tag color={block.state === 'approved' ? 'green' : 'default'}>{block.state === 'approved' ? '已执行' : '已取消'}</Tag>
      )}
    </div>
  )
}

/** The assistant turn after one /api/chat event (other than `conversation`). */
export function applyEvent(t: Turn, ev: Record<string, unknown>): Turn {
  const blocks = [...t.blocks]
  const last = blocks[blocks.length - 1]
  switch (ev.type as string) {
    case 'status':
      return { ...t, status: ev.text as string }
    case 'text':
      if (last?.kind === 'text') blocks[blocks.length - 1] = { ...last, text: last.text + (ev.delta as string) }
      else blocks.push({ kind: 'text', text: ev.delta as string })
      return { ...t, blocks, status: undefined }
    case 'tool_start': {
      const i = blocks.findIndex((b) => b.kind === 'confirm' && b.id === ev.id)
      if (i >= 0) blocks[i] = { ...(blocks[i] as Extract<Block, { kind: 'confirm' }>), state: 'approved' }
      blocks.push({ kind: 'tool', id: ev.id as string, title: ev.title as string, sql: ev.sql as string | null, running: true })
      return { ...t, blocks, status: undefined }
    }
    case 'tool_result': {
      const result = ev.result as ToolResult
      const i = blocks.findIndex((b) => b.kind === 'tool' && b.id === ev.id)
      if (i >= 0) blocks[i] = { ...(blocks[i] as Extract<Block, { kind: 'tool' }>), running: false, result }
      else {
        const c = blocks.findIndex((b) => b.kind === 'confirm' && b.id === ev.id)
        if (c >= 0) blocks[c] = { ...(blocks[c] as Extract<Block, { kind: 'confirm' }>), state: 'cancelled' }
        else blocks.push({ kind: 'tool', id: ev.id as string, title: result.title ?? '查询', running: false, result })
      }
      return { ...t, blocks }
    }
    case 'confirm':
      blocks.push({ kind: 'confirm', id: ev.id as string, title: ev.title as string, sql: ev.sql as string, state: 'waiting' })
      return { ...t, blocks, status: undefined }
    case 'error':
      return { ...t, error: ev.message as string, status: undefined }
    case 'done':
      return { ...t, done: true, status: undefined }
    default:
      return t
  }
}

export function AssistantTurn({
  turn,
  onAnswer,
  busy = false,
}: {
  turn: Turn
  onAnswer?: (approve: boolean) => void
  busy?: boolean
}) {
  return (
    <div className="chat-assistant">
      {turn.blocks.map((b, j) =>
        b.kind === 'text' ? (
          <div key={j} className="chat-md">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{b.text}</ReactMarkdown>
          </div>
        ) : b.kind === 'tool' && b.result?.kind === 'chart' ? (
          <Suspense key={b.id} fallback={<LoadingOutlined />}>
            <ChatChart chart={b.result as ChartResult} />
          </Suspense>
        ) : b.kind === 'tool' ? (
          <ToolBlock key={b.id} block={b} />
        ) : (
          <ConfirmBlock key={b.id} block={b} onAnswer={onAnswer} disabled={busy} />
        ),
      )}
      {turn.status && !turn.done && (
        <Typography.Text type="secondary">
          <LoadingOutlined /> {turn.status}
        </Typography.Text>
      )}
      {turn.stopped && <Typography.Text type="secondary">（已停止）</Typography.Text>}
      {turn.error && <Alert type="error" showIcon message={turn.error} style={{ marginTop: 8 }} />}
    </div>
  )
}
