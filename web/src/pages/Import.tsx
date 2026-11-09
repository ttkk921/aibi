import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd'
import { InboxOutlined } from '@ant-design/icons'
import { api, upload } from '../api'
import type { TableInfo } from './Tables'
import type { Group } from '../appInfo'

interface UploadResult {
  token: string
  filename: string
  header: string[]
  suggested_table: string | null
}

interface Preview {
  table: string
  table_label: string
  date_col: string | null
  modes: string[]
  mapping: { header: string; column: string | null; label: string | null; type: string | null }[]
  missing: { column: string; label: string }[]
  row_count: number
  skipped_blank: number
  dates: { date: string; rows: number }[]
  existing: { total: number; same_dates: number }
  errors: { row: number; column: string; value: string; message: string }[]
  error_count: number
  warnings: string[]
  sample: { columns: string[]; labels: string[]; rows: unknown[][] }
}

interface HistoryRow {
  id: number
  created_at: string
  table_name: string
  filename: string
  mode: string
  status: string
  deleted: number | null
  inserted: number | null
  dates: string[]
  message: string | null
  username: string | null
}

const MODE_LABEL: Record<string, string> = {
  replace_dates: '按日期覆盖',
  append: '追加',
  replace_all: '全量覆盖',
  row_insert: '页面新增',
  row_update: '页面修改',
  row_delete: '页面删除',
}

const STATUS_TAG: Record<string, JSX.Element> = {
  ok: <Tag color="green">成功</Tag>,
  rejected: <Tag color="orange">被拒绝</Tag>,
  failed: <Tag color="red">失败</Tag>,
}

const n = (v: number) => v.toLocaleString()

interface ImportResult {
  deleted: number
  inserted: number
  dates: string[]
  /** Derived columns recomputed, by 「表「列」」: in this table, or in tables that read this one. */
  derived?: Record<string, number>
  summaries?: Record<string, number>
}

export default function ImportPage({ groups }: { groups: Group[] }) {
  const { modal, message } = App.useApp()
  const [params] = useSearchParams()
  const [tables, setTables] = useState<TableInfo[]>([])
  const [uploaded, setUploaded] = useState<UploadResult>()
  const [table, setTable] = useState<string | undefined>(params.get('table') ?? undefined)
  const [preview, setPreview] = useState<Preview>()
  const [mode, setMode] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<ImportResult>()
  const [history, setHistory] = useState<HistoryRow[]>([])

  const loadHistory = useCallback(() => {
    api<HistoryRow[]>('/api/import/history').then(setHistory).catch(() => undefined)
  }, [])

  useEffect(() => {
    api<TableInfo[]>('/api/tables').then(setTables).catch((e) => setError(e.message))
    loadHistory()
  }, [loadHistory])

  const runPreview = useCallback(async (token: string, t: string) => {
    setBusy('正在解析文件并检查数据…')
    setError(undefined)
    setPreview(undefined)
    try {
      const p = await api<Preview>('/api/import/preview', { token, table: t })
      setPreview(p)
      setMode(p.modes[0])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(undefined)
    }
  }, [])

  const onFile = async (file: File) => {
    setBusy('正在上传…')
    setError(undefined)
    setPreview(undefined)
    setResult(undefined)
    try {
      const u = await upload<UploadResult>('/api/import/upload', file)
      setUploaded(u)
      const t = u.suggested_table ?? table
      setTable(t)
      if (t) await runPreview(u.token, t)
      else setBusy(undefined)
      if (!u.suggested_table) message.warning('没能根据表头判断是哪张表，请手动选择')
    } catch (e) {
      setError((e as Error).message)
      setBusy(undefined)
    }
  }

  const onTableChange = (t: string) => {
    setTable(t)
    if (uploaded) runPreview(uploaded.token, t)
  }

  const willDelete = useMemo(() => {
    if (!preview || !mode) return 0
    if (mode === 'replace_dates') return preview.existing.same_dates
    if (mode === 'replace_all') return preview.existing.total
    return 0
  }, [preview, mode])

  const doCommit = () => {
    if (!preview || !uploaded || !mode) return
    const shrink = willDelete > preview.row_count * 2
    modal.confirm({
      title: '确认写入数据库？',
      okText: '确认导入',
      okButtonProps: { danger: willDelete > 0 },
      content: (
        <div>
          <p>
            目标表：<b>{preview.table_label}</b>（{preview.table}）
          </p>
          <p>
            方式：<b>{MODE_LABEL[mode]}</b>
          </p>
          {willDelete > 0 && (
            <p>
              将先删除 <b>{n(willDelete)}</b> 行现有数据
            </p>
          )}
          <p>
            写入 <b>{n(preview.row_count)}</b> 行
          </p>
          {shrink && (
            <Alert
              type="warning"
              showIcon
              message={`删除的行数是写入行数的 ${Math.round(willDelete / Math.max(preview.row_count, 1))} 倍，请确认这不是一份样例文件`}
            />
          )}
        </div>
      ),
      onOk: async () => {
        setBusy('正在写入数据库…')
        try {
          const r = await api<ImportResult>('/api/import/commit', {
            token: uploaded.token,
            table: preview.table,
            mode,
          })
          setResult(r)
          setPreview(undefined)
          setUploaded(undefined)
          message.success('导入完成')
        } catch (e) {
          setError((e as Error).message)
        } finally {
          setBusy(undefined)
          loadHistory()
        }
      },
    })
  }

  return (
    <div className="page">
      <div className="page-title">
        <h2>数据导入</h2>
        <Typography.Text type="secondary">
          上传 Excel（.xlsx / .xls）或 CSV，按表头自动匹配字段，预览确认后再写入
        </Typography.Text>
      </div>

      <Card style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Upload.Dragger accept=".xlsx,.xls,.csv" showUploadList={false} beforeUpload={(f) => {
              onFile(f)
              return false
            }} disabled={!!busy}>
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">点击或拖拽文件到这里</p>
            <p className="ant-upload-hint">支持 .xlsx、.xls（含系统导出的网页格式 .xls）和 .csv；只读取第一个工作表，第一行非空行作为表头</p>
          </Upload.Dragger>
          {uploaded && (
            <Space wrap>
              <Typography.Text>
                文件：<b>{uploaded.filename}</b>
              </Typography.Text>
              <Typography.Text>导入到：</Typography.Text>
              <Select
                style={{ width: 360 }}
                value={table}
                onChange={onTableChange}
                placeholder="选择目标表"
                options={groups
                  .map((g) => ({
                    label: g.title,
                    options: tables
                      .filter((t) => t.group === g.id && !t.derived_from)
                      .map((t) => ({ value: t.name, label: `${t.label}（${t.name}）` })),
                  }))
                  .filter((g) => g.options.length)}
              />
            </Space>
          )}
        </Space>
      </Card>

      {busy && (
        <Card style={{ marginBottom: 16 }}>
          <Spin /> <Typography.Text style={{ marginLeft: 8 }}>{busy}</Typography.Text>
        </Card>
      )}
      {error && <Alert type="error" message={error} showIcon closable style={{ marginBottom: 16 }} />}
      {result && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
          message={`导入完成：删除 ${n(result.deleted)} 行，写入 ${n(result.inserted)} 行${Object.entries(result.derived ?? {})
            .map(([col, rows]) => `；${col} 已计算 ${n(rows)} 行`)
            .join('')}${Object.entries(result.summaries ?? {})
            .map(([t, rows]) => `；汇总表 ${t} 已重算 ${n(rows)} 行`)
            .join('')}`}
          description={result.dates.length ? `涉及日期：${result.dates.join('、')}` : undefined}
        />
      )}

      {preview && !busy && (
        <Card
          title={`预览：${preview.table_label}`}
          style={{ marginBottom: 16 }}
          extra={
            <Button type="primary" onClick={doCommit} disabled={preview.error_count > 0 || preview.row_count === 0}>
              确认导入
            </Button>
          }
        >
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            <Descriptions size="small" bordered column={{ xs: 1, md: 2 }}>
              <Descriptions.Item label="有效数据行">{n(preview.row_count)}</Descriptions.Item>
              <Descriptions.Item label="跳过的空行">{n(preview.skipped_blank)}</Descriptions.Item>
              <Descriptions.Item label="文件中的日期">
                {preview.date_col
                  ? preview.dates.map((d) => (
                      <Tag key={d.date}>
                        {d.date} · {n(d.rows)} 行
                      </Tag>
                    ))
                  : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="表中现有数据">
                共 {n(preview.existing.total)} 行
                {preview.date_col && `，其中这些日期 ${n(preview.existing.same_dates)} 行`}
              </Descriptions.Item>
            </Descriptions>

            <div>
              <Typography.Text strong>导入方式：</Typography.Text>
              <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} style={{ marginTop: 8 }}>
                <Space direction="vertical">
                  {preview.modes.map((m) => (
                    <Radio key={m} value={m}>
                      {m === 'replace_dates' &&
                        `按日期覆盖：先删除这些日期的 ${n(preview.existing.same_dates)} 行，再写入 ${n(preview.row_count)} 行（推荐，可重复导入）`}
                      {m === 'replace_all' &&
                        `全量覆盖：先删除整张表的 ${n(preview.existing.total)} 行，再写入 ${n(preview.row_count)} 行（推荐，维表）`}
                      {m === 'append' && `追加：直接写入 ${n(preview.row_count)} 行（重复导入会产生重复数据）`}
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
            </div>

            {preview.error_count > 0 && (
              <Alert
                type="error"
                showIcon
                message={`发现 ${n(preview.error_count)} 处数据错误，修正后才能导入`}
                description={
                  <Table
                    size="small"
                    rowKey={(r) => `${r.row}-${r.column}`}
                    pagination={false}
                    dataSource={preview.errors}
                    columns={[
                      { title: 'Excel 行号', dataIndex: 'row', width: 100 },
                      { title: '列', dataIndex: 'column' },
                      { title: '值', dataIndex: 'value' },
                      { title: '问题', dataIndex: 'message' },
                    ]}
                  />
                }
              />
            )}
            {preview.warnings.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="需要注意"
                description={
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {preview.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                }
              />
            )}

            <div>
              <Typography.Title level={5}>字段匹配</Typography.Title>
              <Table
                size="small"
                rowKey="header"
                pagination={false}
                dataSource={preview.mapping}
                scroll={{ x: 'max-content' }}
                columns={[
                  { title: '文件表头', dataIndex: 'header' },
                  {
                    title: '写入字段',
                    dataIndex: 'column',
                    render: (c: string | null, r) =>
                      c ? (
                        <span>
                          <span className="mono">{c}</span>
                          {r.label !== r.header && <Typography.Text type="secondary">（{r.label}）</Typography.Text>}
                        </span>
                      ) : (
                        <Tag color="orange">忽略</Tag>
                      ),
                  },
                  { title: '类型', dataIndex: 'type', render: (t) => <span className="mono">{t}</span> },
                ]}
              />
            </div>

            <div>
              <Typography.Title level={5}>转换后的前 {preview.sample.rows.length} 行</Typography.Title>
              <Table
                size="small"
                bordered
                pagination={false}
                rowKey={(_, i) => String(i)}
                scroll={{ x: 'max-content' }}
                dataSource={preview.sample.rows.map((r) => Object.fromEntries(r.map((v, j) => [j, v])))}
                columns={preview.sample.columns.map((c, j) => ({
                  title: (
                    <div className="col-title">
                      {preview.sample.labels[j]}
                      <small>{c}</small>
                    </div>
                  ),
                  dataIndex: String(j),
                  render: (v: unknown) =>
                    v === null || v === undefined ? <span className="null-cell">NULL</span> : String(v),
                }))}
              />
            </div>
          </Space>
        </Card>
      )}

      <Card title="导入记录" size="small">
        <Table
          size="small"
          rowKey="id"
          dataSource={history}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 'max-content' }}
          columns={[
            { title: '时间', dataIndex: 'created_at', width: 170 },
            {
              title: '表',
              dataIndex: 'table_name',
              render: (t: string) => tables.find((x) => x.name === t)?.label ?? t,
            },
            { title: '操作人', dataIndex: 'username', render: (u: string | null) => u ?? '—' },
            { title: '文件', dataIndex: 'filename' },
            { title: '方式', dataIndex: 'mode', render: (m: string) => MODE_LABEL[m] ?? m },
            { title: '结果', dataIndex: 'status', render: (s: string) => STATUS_TAG[s] ?? s },
            { title: '删除', dataIndex: 'deleted', align: 'right', render: (v) => (v == null ? '' : n(v)) },
            { title: '写入', dataIndex: 'inserted', align: 'right', render: (v) => (v == null ? '' : n(v)) },
            { title: '日期', dataIndex: 'dates', render: (d: string[]) => d.join('、') },
            { title: '说明', dataIndex: 'message' },
          ]}
        />
      </Card>
    </div>
  )
}
