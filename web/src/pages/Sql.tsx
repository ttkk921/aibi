import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Alert, Button, Card, Input, Select, Space, Table, Typography } from 'antd'
import { CaretRightOutlined, DownloadOutlined } from '@ant-design/icons'
import { api } from '../api'
import { compareValues, exportCsv } from '../format'

interface SqlResult {
  columns: string[]
  rows: unknown[][]
  truncated: boolean
  max_rows: number
  elapsed_ms: number
}

const EXAMPLE = `-- 只读：仅允许 SELECT / WITH / SHOW / DESC / EXPLAIN，结果最多 2000 行
select *
from bi_sales_detail
limit 100`

interface TableInfo {
  name: string
  label?: string
}

export default function SqlPage() {
  // 「在 SQL 查询页打开」 from AI 问数 hands the statement over in navigation state.
  const handed = (useLocation().state as { sql?: string } | null)?.sql
  const [sql, setSql] = useState(handed ?? EXAMPLE)
  useEffect(() => {
    if (handed) setSql(handed)
  }, [handed])
  const [result, setResult] = useState<SqlResult>()
  // Table list comes from the business package, never hardcoded here.
  const [tables, setTables] = useState<TableInfo[]>([])
  useEffect(() => {
    api<TableInfo[]>('/api/tables')
      .then(setTables)
      .catch(() => setTables([]))
  }, [])
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)

  const run = async () => {
    setLoading(true)
    setError(undefined)
    try {
      setResult(await api<SqlResult>('/api/sql', { sql }))
    } catch (e) {
      setError((e as Error).message)
      setResult(undefined)
    } finally {
      setLoading(false)
    }
  }

  const rows = useMemo(
    () =>
      (result?.rows ?? []).map((r, i) => {
        const o: Record<string, unknown> = { __key: i }
        r.forEach((v, j) => (o[String(j)] = v))
        return o
      }),
    [result],
  )

  return (
    <div className="page">
      <div className="page-title">
        <h2>SQL 查询</h2>
        <Typography.Text type="secondary">只读，直接查询 bi_data</Typography.Text>
      </div>
      <Card size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input.TextArea
            className="mono"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            autoSize={{ minRows: 8, maxRows: 24 }}
            spellCheck={false}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                run()
              }
            }}
          />
          <Space wrap>
            <Button type="primary" icon={<CaretRightOutlined />} loading={loading} onClick={run}>
              执行（Ctrl+Enter）
            </Button>
            <Select
              placeholder="快速查看某张表"
              style={{ width: 300 }}
              value={null}
              onChange={(t: string) => setSql(`select *\nfrom ${t}\nlimit 100`)}
              options={tables.map((t) => ({
                value: t.name,
                label: t.label ? `${t.name}（${t.label}）` : t.name,
              }))}
            />
            {result && (
              <>
                <Typography.Text type="secondary">
                  {result.rows.length} 行 · {(result.elapsed_ms / 1000).toFixed(1)}s
                </Typography.Text>
                <Button
                  icon={<DownloadOutlined />}
                  onClick={() => exportCsv('query.csv', result.columns, result.rows)}
                >
                  导出 CSV
                </Button>
              </>
            )}
          </Space>
        </Space>
      </Card>
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
      {result?.truncated && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`结果超过 ${result.max_rows} 行，只显示前 ${result.max_rows} 行`}
        />
      )}
      {result && (
        <Table
          size="small"
          bordered
          rowKey="__key"
          dataSource={rows}
          scroll={{ x: 'max-content' }}
          pagination={{ pageSize: 100, showSizeChanger: true, showTotal: (t) => `共 ${t} 行` }}
          columns={result.columns.map((c, j) => ({
            title: c,
            dataIndex: String(j),
            key: String(j),
            sorter: (a: Record<string, unknown>, b: Record<string, unknown>) =>
              compareValues(a[String(j)], b[String(j)]),
            render: (v: unknown) =>
              v === null || v === undefined ? <span className="null-cell">NULL</span> : String(v),
          }))}
        />
      )}
    </div>
  )
}
