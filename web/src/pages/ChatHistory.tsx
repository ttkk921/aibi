/** 问数记录 (admins): every AI 问数 question with its answer, shown the way the user saw it. */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, DatePicker, Drawer, Grid, Input, Select, Space, Spin, Table, Tag, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import type { Dayjs } from 'dayjs'
import { api } from '../api'
import { applyEvent, AssistantTurn, type Turn } from '../chat/Transcript'

interface LogRow {
  id: number
  created_at: string
  username: string
  display_name: string
  conversation_id: string
  question: string
  context: string | null
  model: string | null
  status: string
  answer: string
  error: string | null
  tool_count: number
  seconds: number
  prompt_tokens: number
  completion_tokens: number
}

interface LogTurn extends LogRow {
  events: Record<string, unknown>[]
}

const STATUS_TAG: Record<string, JSX.Element> = {
  ok: <Tag color="green">已回答</Tag>,
  error: <Tag color="red">出错</Tag>,
  stopped: <Tag>已停止</Tag>,
  waiting: <Tag color="orange">SQL 未确认</Tag>,
  running: <Tag color="blue">回答中</Tag>,
}

const PAGE_SIZE = 30

const time = (s: string) => s.replace('T', ' ')

/** The answer of a history row, rebuilt from its events like the drawer builds it live. */
function answerOf(t: LogTurn): Turn {
  let turn: Turn = { role: 'assistant', blocks: [] }
  for (const ev of t.events) turn = applyEvent(turn, ev)
  return { ...turn, done: true, stopped: t.status === 'stopped' }
}

function Conversation({ logId, onClose }: { logId: number | undefined; onClose: () => void }) {
  const [turns, setTurns] = useState<LogTurn[]>()
  const [error, setError] = useState<string>()
  const narrow = !Grid.useBreakpoint().md

  useEffect(() => {
    if (logId === undefined) return
    setTurns(undefined)
    setError(undefined)
    api<{ turns: LogTurn[] }>(`/api/chat/history/${logId}`)
      .then((r) => setTurns(r.turns))
      .catch((e) => setError((e as Error).message))
  }, [logId])

  useEffect(() => {
    // the question clicked in the list, when the conversation has several
    if (turns) document.getElementById(`chat-log-${logId}`)?.scrollIntoView({ block: 'start' })
  }, [turns, logId])

  const first = turns?.[0]
  return (
    <Drawer
      title={first ? `${first.display_name} 的对话（${turns!.length} 个问题）` : '对话'}
      width={narrow ? '100%' : 820}
      open={logId !== undefined}
      onClose={onClose}
      styles={{ body: { padding: 0 } }}
    >
      {error && <Alert type="error" showIcon message={error} style={{ margin: 16 }} />}
      {!turns && !error && <Spin style={{ display: 'block', margin: 40 }} />}
      <div className="chat-list">
        {turns?.map((t) => (
          <div key={t.id} id={`chat-log-${t.id}`} className={t.id === logId ? 'chat-log-turn chat-log-current' : 'chat-log-turn'}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {time(t.created_at)} · {t.model ?? '—'} · {t.seconds} 秒 · {(t.prompt_tokens + t.completion_tokens).toLocaleString()} tokens
            </Typography.Text>
            <div className="chat-user">
              <div className="chat-user-bubble">{t.question}</div>
              {t.context && <div className="chat-user-context">{t.context}</div>}
            </div>
            <AssistantTurn turn={answerOf(t)} />
            {t.status === 'waiting' && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                AI 写的 SQL 在等用户确认，用户没有回复。
              </Typography.Text>
            )}
          </div>
        ))}
      </div>
    </Drawer>
  )
}

export default function ChatHistoryPage() {
  const [rows, setRows] = useState<LogRow[]>([])
  const [total, setTotal] = useState(0)
  const [users, setUsers] = useState<{ username: string; display_name: string }[]>([])
  const [user, setUser] = useState<string>()
  const [q, setQ] = useState('')
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<number>()

  const load = useCallback(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE) })
    if (user) params.set('user', user)
    if (q.trim()) params.set('q', q.trim())
    if (range?.[0]) params.set('date_from', range[0].format('YYYY-MM-DD'))
    if (range?.[1]) params.set('date_to', range[1].format('YYYY-MM-DD'))
    setLoading(true)
    setError(undefined)
    api<{ total: number; items: LogRow[]; users: { username: string; display_name: string }[] }>(`/api/chat/history?${params}`)
      .then((r) => {
        setRows(r.items)
        setTotal(r.total)
        setUsers(r.users)
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
    // q is applied on search / Enter, not on every keystroke
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, user, range])

  useEffect(load, [load])

  const search = () => (page === 1 ? load() : setPage(1))

  return (
    <div className="page">
      <div className="page-title">
        <h2>问数记录</h2>
        <Typography.Text type="secondary">每个人在 AI 问数里问的问题和得到的回答，点一行查看整段对话</Typography.Text>
      </div>
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
      <Card
        size="small"
        title={
          <Space wrap>
            <Select
              allowClear
              placeholder="全部用户"
              style={{ width: 160 }}
              value={user}
              onChange={(v) => {
                setUser(v)
                setPage(1)
              }}
              options={users.map((u) => ({ value: u.username, label: u.display_name }))}
            />
            <DatePicker.RangePicker
              value={range}
              onChange={(v) => {
                setRange(v)
                setPage(1)
              }}
            />
            <Input.Search
              allowClear
              placeholder="搜索问题或回答"
              style={{ width: 220 }}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onSearch={search}
            />
          </Space>
        }
        extra={
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
        }
      >
        <Table<LogRow>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          scroll={{ x: 'max-content' }}
          onRow={(r) => ({ onClick: () => setOpen(r.id), style: { cursor: 'pointer' } })}
          pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false, showTotal: (n) => `共 ${n} 条` }}
          columns={[
            { title: '时间', dataIndex: 'created_at', render: (s: string) => <span style={{ whiteSpace: 'nowrap' }}>{time(s)}</span> },
            { title: '用户', dataIndex: 'display_name', width: 100 },
            {
              title: '问题',
              dataIndex: 'question',
              render: (v: string, r) => (
                <div style={{ maxWidth: 420, whiteSpace: 'normal' }}>
                  {v}
                  {r.context && (
                    <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                      {r.context}
                    </Typography.Text>
                  )}
                </div>
              ),
            },
            {
              title: '回答',
              dataIndex: 'answer',
              render: (v: string, r) => {
                // a preview: markdown marks dropped
                const text = (r.status === 'error' ? r.error : v.replace(/[*#`>|]/g, '').replace(/\s+/g, ' ').trim()) || '—'
                return (
                  <Typography.Text type="secondary" style={{ display: 'block', maxWidth: 360, whiteSpace: 'normal', fontSize: 12 }}>
                    {text.length > 80 ? `${text.slice(0, 80)}…` : text}
                  </Typography.Text>
                )
              },
            },
            { title: '状态', dataIndex: 'status', width: 100, render: (s: string) => STATUS_TAG[s] ?? <Tag>{s}</Tag> },
            { title: '查询', dataIndex: 'tool_count', width: 60, align: 'right' },
            { title: '耗时', dataIndex: 'seconds', width: 70, align: 'right', render: (s: number) => `${s} 秒` },
          ]}
        />
      </Card>
      <Conversation logId={open} onClose={() => setOpen(undefined)} />
    </div>
  )
}
