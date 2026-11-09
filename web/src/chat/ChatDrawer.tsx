/**
 * AI 问数 drawer: streams answers from /api/chat, shows each query as a collapsible result
 * table (with its SQL), and in confirm mode asks before any SQL runs. Loaded on first open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Drawer, Grid, Input, Space, Switch, Tag, Tooltip, Typography } from 'antd'
import { FullscreenExitOutlined, FullscreenOutlined, PlusOutlined, SendOutlined, StopOutlined } from '@ant-design/icons'
import { ApiError, postEventStream, UNAUTHORIZED_EVENT } from '../api'
import { describeContext, type PageContext } from './pageContext'
import { applyEvent, AssistantTurn, type Turn } from './Transcript'

const CONFIRM_KEY = 'bi.chat.confirmSql'

function readConfirmPref(): boolean {
  try {
    return localStorage.getItem(CONFIRM_KEY) === '1'
  } catch {
    return false
  }
}

/** Example questions of the business package for the current report (or its defaults). */
function suggestions(examples: Record<string, string[]>, ctx: PageContext | undefined): string[] {
  return (ctx?.report && examples[ctx.report]) || examples.default || []
}

export default function ChatDrawer({
  open,
  onClose,
  pageContext,
  examples,
  canSql,
}: {
  open: boolean
  onClose: () => void
  pageContext: PageContext | undefined
  examples: Record<string, string[]>
  canSql: boolean
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmSql, setConfirmSql] = useState(readConfirmPref)
  const [includeContext, setIncludeContext] = useState(true)
  const conversation = useRef<string>()
  const abort = useRef<AbortController>()
  const listEnd = useRef<HTMLDivElement>(null)
  const narrow = !Grid.useBreakpoint().md
  const [full, setFull] = useState(false)

  useEffect(() => {
    try {
      localStorage.setItem(CONFIRM_KEY, confirmSql ? '1' : '0')
    } catch {
      /* storage unavailable: preference lasts for this page only */
    }
  }, [confirmSql])

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: 'end' })
  }, [turns])

  const update = useCallback((fn: (t: Turn) => Turn) => {
    setTurns((ts) => (ts.length ? [...ts.slice(0, -1), fn(ts[ts.length - 1])] : ts))
  }, [])

  const onEvent = useCallback(
    (ev: Record<string, unknown>) => {
      const type = ev.type as string
      if (type === 'conversation') {
        conversation.current = ev.id as string
        return
      }
      update((t) => applyEvent(t, ev))
    },
    [update],
  )

  const run = useCallback(
    async (body: Record<string, unknown>) => {
      const controller = new AbortController()
      abort.current = controller
      setBusy(true)
      try {
        await postEventStream('/api/chat', { ...body, auto_execute: !confirmSql }, onEvent, controller.signal)
      } catch (e) {
        if (controller.signal.aborted) update((t) => ({ ...t, stopped: true, done: true, status: undefined }))
        else if (e instanceof ApiError && e.status === 409 && body.approve !== undefined) {
          conversation.current = undefined
          update((t) => ({ ...t, error: '这段对话已过期（服务重启过），请重新提问', done: true }))
        } else {
          if (e instanceof ApiError && e.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
          update((t) => ({ ...t, error: (e as Error).message, done: true, status: undefined }))
        }
      } finally {
        setBusy(false)
        abort.current = undefined
      }
    },
    [confirmSql, onEvent, update],
  )

  const send = useCallback(
    (text?: string) => {
      const question = (text ?? input).trim()
      if (!question || busy) return
      const ctx = includeContext ? pageContext : undefined
      setInput('')
      setTurns((ts) => [
        ...ts,
        { role: 'user', text: question, context: ctx ? describeContext(ctx) : undefined, blocks: [] },
        { role: 'assistant', blocks: [], status: '正在发送…' },
      ])
      run({ conversation_id: conversation.current, message: question, context: ctx })
    },
    [busy, input, pageContext, run, includeContext],
  )

  const answer = useCallback(
    (approve: boolean) => {
      update((t) => ({
        ...t,
        done: false,
        blocks: t.blocks.map((b) => (b.kind === 'confirm' && b.state === 'waiting' ? { ...b, state: approve ? 'approved' : 'cancelled' } : b)),
        status: approve ? '执行中…' : undefined,
      }))
      run({ conversation_id: conversation.current, approve })
    },
    [run, update],
  )

  const reset = () => {
    abort.current?.abort()
    conversation.current = undefined
    setTurns([])
  }

  const waiting = turns.length > 0 && turns[turns.length - 1].blocks.some((b) => b.kind === 'confirm' && b.state === 'waiting')
  const contextLine = useMemo(() => (pageContext ? describeContext(pageContext) : undefined), [pageContext])

  return (
    <Drawer
      title="AI 问数"
      placement="right"
      width={narrow || full ? '100%' : 620}
      open={open}
      onClose={onClose}
      mask={false}
      styles={{ body: { display: 'flex', flexDirection: 'column', padding: 0 } }}
      extra={
        <Space size={12}>
          {canSql && (
            <Tooltip title="打开后，AI 写好的 SQL 要你点「执行」才会运行；报表查询不受影响">
              <Space size={4}>
                <Switch size="small" checked={confirmSql} onChange={setConfirmSql} />
                <Typography.Text style={{ fontSize: 13 }}>执行前确认</Typography.Text>
              </Space>
            </Tooltip>
          )}
          <Button size="small" icon={<PlusOutlined />} onClick={reset} disabled={!turns.length}>
            新对话
          </Button>
          {!narrow && (
            <Tooltip title={full ? '退出全屏' : '全屏'}>
              <Button
                size="small"
                type="text"
                icon={full ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                onClick={() => setFull((f) => !f)}
                aria-label={full ? '退出全屏' : '全屏'}
              />
            </Tooltip>
          )}
        </Space>
      }
    >
      <div className="chat-list">
        {turns.length === 0 && (
          <div className="chat-empty">
            <Typography.Paragraph type="secondary">
              {canSql
                ? '用中文问数据，AI 会先查看板报表，报表回答不了时再写 SQL（只读）。每次查询的结果和 SQL 都可以展开查看、导出。'
                : '用中文问数据，AI 会查看板报表来回答，每次查询的结果都可以展开查看、导出。需要按人员、组别等明细统计时，请联系管理员开通分析员权限。'}
              提问和回答会保存下来，管理员可以在「问数记录」查看。
            </Typography.Paragraph>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {suggestions(examples, pageContext).map((s) => (
                <Button key={s} block style={{ textAlign: 'left', whiteSpace: 'normal', height: 'auto' }} onClick={() => send(s)}>
                  {s}
                </Button>
              ))}
            </Space>
          </div>
        )}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="chat-user">
              <div className="chat-user-bubble">{t.text}</div>
              {t.context && <div className="chat-user-context">{t.context}</div>}
            </div>
          ) : (
            <AssistantTurn key={i} turn={t} onAnswer={answer} busy={busy} />
          ),
        )}
        <div ref={listEnd} />
      </div>
      <div className="chat-input">
        {contextLine && (
          <div className="chat-context">
            <Tag
              color={includeContext ? 'blue' : 'default'}
              style={{ cursor: 'pointer', maxWidth: '100%', whiteSpace: 'normal' }}
              onClick={() => setIncludeContext((u) => !u)}
            >
              {includeContext ? '带上当前页面：' : '不带页面信息（点击带上）：'}
              {contextLine}
            </Tag>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <Input.TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={waiting ? '先确认上面的 SQL，或直接输入新问题' : '输入问题，Enter 发送，Shift+Enter 换行'}
            autoSize={{ minRows: 1, maxRows: 6 }}
            onPressEnter={(e) => {
              if (!e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          {busy ? (
            <Button danger icon={<StopOutlined />} onClick={() => abort.current?.abort()}>
              停止
            </Button>
          ) : (
            <Button type="primary" icon={<SendOutlined />} onClick={() => send()} disabled={!input.trim()}>
              发送
            </Button>
          )}
        </div>
      </div>
    </Drawer>
  )
}
