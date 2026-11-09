import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { usePageContext } from '../chat/pageContext'
import { Alert, App, Button, Card, Input, Popconfirm, Select, Space, Table, Typography } from 'antd'
import type { TableProps } from 'antd'
import { DeleteOutlined, DownloadOutlined, EditOutlined, PlusOutlined, SearchOutlined, UploadOutlined } from '@ant-design/icons'
import { api, apiSend, download } from '../api'
import { NUMERIC_TYPES } from '../format'
import { useStickyHeader } from '../reportTable'
import type { TableInfo } from './Tables'
import { fitColumnWidth } from '../tableLayout'
import RowEditor, { type EditableInfo } from './RowEditor'

interface ColumnMeta {
  name: string
  type: string
  column_type: string
  label: string
}

type Op = 'eq' | 'ne' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'null' | 'notnull'

interface Condition {
  key: number
  column?: string
  op: Op
  value?: string
}

interface QueryResult {
  columns: string[]
  rows: unknown[][]
  total: number
}

const OPS: { value: Op; label: string; noValue?: boolean }[] = [
  { value: 'eq', label: '等于' },
  { value: 'ne', label: '不等于' },
  { value: 'contains', label: '包含' },
  { value: 'gt', label: '大于' },
  { value: 'gte', label: '大于等于' },
  { value: 'lt', label: '小于' },
  { value: 'lte', label: '小于等于' },
  { value: 'null', label: '为空', noValue: true },
  { value: 'notnull', label: '不为空', noValue: true },
]

let condKey = 0

export default function TableBrowsePage() {
  const { name = '' } = useParams()
  usePageContext({ page: '数据表浏览', table: name })
  const navigate = useNavigate()
  const sticky = useStickyHeader()
  const [meta, setMeta] = useState<{ label: string; date_col: string | null; editable: EditableInfo | null; columns: ColumnMeta[] }>()
  const [dates, setDates] = useState<{ date: string; rows: number }[]>([])
  const [date, setDate] = useState<string>()
  const [conditions, setConditions] = useState<Condition[]>([])
  const [applied, setApplied] = useState<{ date?: string; conditions: Condition[] }>({ conditions: [] })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [sort, setSort] = useState<{ by?: string; desc: boolean }>({ desc: false })
  const [data, setData] = useState<QueryResult>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<Record<string, unknown> | 'new'>()
  const { message } = App.useApp()

  useEffect(() => {
    setMeta(undefined)
    setData(undefined)
    setConditions([])
    setPage(1)
    setSort({ desc: false })
    api<{ label: string; date_col: string | null; editable: EditableInfo | null; columns: ColumnMeta[] }>(`/api/tables/${name}/columns`)
      .then(setMeta)
      .catch((e) => setError(e.message))
    api<TableInfo[]>('/api/tables').then((ts) => {
      const t = ts.find((x) => x.name === name)
      const ds = t?.by_date ?? []
      setDates(ds)
      const first = ds[0]?.date
      setDate(first)
      setApplied({ date: first, conditions: [] })
    })
  }, [name])

  const body = useMemo(
    () => ({
      date: applied.date,
      conditions: applied.conditions
        .filter((c) => c.column)
        .map((c) => ({ column: c.column, op: c.op, value: c.value ?? null })),
      sort_by: sort.by,
      sort_desc: sort.desc,
      page,
      page_size: pageSize,
    }),
    [applied, sort, page, pageSize],
  )

  const load = useCallback(async () => {
    if (!meta) return
    setLoading(true)
    setError(undefined)
    try {
      setData(await api<QueryResult>(`/api/tables/${name}/query`, body))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [name, meta, body])

  useEffect(() => {
    load()
  }, [load])

  const colMeta = useMemo(() => new Map(meta?.columns.map((c) => [c.name, c]) ?? []), [meta])

  const columns: TableProps<Record<string, unknown>>['columns'] = useMemo(
    () =>
      (data?.columns ?? []).map((c, j) => {
        const m = colMeta.get(c)
        const numeric = m ? NUMERIC_TYPES.has(m.type) : false
        const label = m?.label ?? c
        // The sticky header is a separate table sized from the body, so widths must allow for the titles too.
        const values = (data?.rows ?? []).map((r) => (r[j] === null || r[j] === undefined ? 'NULL' : String(r[j])))
        const width = fitColumnWidth(label, values, { sorter: true, subtitle: c })
        return {
          title: (
            <div className="col-title">
              <div className="th-2line">{label}</div>
              <small>{c}</small>
            </div>
          ),
          dataIndex: c,
          key: c,
          align: numeric ? 'right' : 'left',
          sorter: true,
          sortOrder: sort.by === c ? (sort.desc ? 'descend' : 'ascend') : null,
          ellipsis: m?.type === 'text',
          width: m?.type === 'text' ? Math.min(width, 240) : width,
          render: (v: unknown) =>
            v === null || v === undefined ? <span className="null-cell">NULL</span> : String(v),
        }
      }),
    [data, colMeta, sort],
  )

  // After an edit: the rows, and the per-date counts (a new row may start a new month).
  const reload = useCallback(() => {
    load()
    api<TableInfo[]>('/api/tables').then((ts) => setDates(ts.find((x) => x.name === name)?.by_date ?? []))
  }, [load, name])

  const remove = async (row: Record<string, unknown>) => {
    try {
      const r = await apiSend<{ message: string }>(`/api/tables/${name}/rows/${row.id}`, 'DELETE')
      message.success(r.message, 4)
      reload()
    } catch (e) {
      message.error((e as Error).message, 6)
    }
  }

  const tableColumns: TableProps<Record<string, unknown>>['columns'] = useMemo(
    () =>
      meta?.editable && columns
        ? [
            ...columns,
            {
              title: '操作',
              key: '__ops',
              fixed: 'right',
              width: 128,
              render: (_: unknown, r: Record<string, unknown>) => (
                <Space size={4}>
                  <Button size="small" icon={<EditOutlined />} onClick={() => setEditing(r)}>
                    改
                  </Button>
                  <Popconfirm
                    title="删除这一行？"
                    description="删除后不能恢复，删掉的内容会记在导入记录里。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => remove(r)}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      删
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]
        : columns,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, meta, name],
  )

  const rows = useMemo(
    () =>
      (data?.rows ?? []).map((r, i) => {
        const o: Record<string, unknown> = { __key: i }
        data!.columns.forEach((c, j) => (o[c] = r[j]))
        return o
      }),
    [data],
  )

  const search = () => {
    setPage(1)
    setApplied({ date, conditions })
  }

  const updateCond = (key: number, patch: Partial<Condition>) =>
    setConditions((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)))

  return (
    <div className="page">
      <div className="page-title">
        <h2>{meta?.label ?? name}</h2>
        <Typography.Text type="secondary" className="mono">
          {name}
        </Typography.Text>
        <Button size="small" icon={<UploadOutlined />} onClick={() => navigate(`/import?table=${name}`)}>
          导入数据
        </Button>
        {meta?.editable && (
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            新增一行
          </Button>
        )}
      </div>

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            {meta?.date_col && (
              <>
                <Typography.Text>{meta.date_col}</Typography.Text>
                <Select
                  style={{ width: 220 }}
                  value={date ?? '__all'}
                  onChange={(v) => setDate(v === '__all' ? undefined : v)}
                  options={[
                    { value: '__all', label: '全部日期' },
                    ...dates.map((d) => ({ value: d.date, label: `${d.date}（${d.rows.toLocaleString()} 行）` })),
                  ]}
                />
              </>
            )}
            <Button icon={<PlusOutlined />} onClick={() => setConditions((cs) => [...cs, { key: ++condKey, op: 'eq' }])}>
              添加条件
            </Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={search}>
              查询
            </Button>
            <Button
              icon={<DownloadOutlined />}
              onClick={() =>
                download(`/api/tables/${name}/export`, { ...body, page: 1 }, `${name}.csv`).catch((e) =>
                  setError(e.message),
                )
              }
            >
              导出 CSV
            </Button>
          </Space>
          {conditions.map((c) => {
            const op = OPS.find((o) => o.value === c.op)
            return (
              <Space key={c.key} wrap>
                <Select
                  showSearch
                  placeholder="字段"
                  style={{ width: 240 }}
                  value={c.column}
                  onChange={(v) => updateCond(c.key, { column: v })}
                  optionFilterProp="label"
                  options={meta?.columns.map((m) => ({ value: m.name, label: `${m.label}（${m.name}）` }))}
                />
                <Select style={{ width: 110 }} value={c.op} onChange={(v) => updateCond(c.key, { op: v })} options={OPS} />
                {!op?.noValue && (
                  <Input
                    style={{ width: 220 }}
                    placeholder="值"
                    value={c.value}
                    onChange={(e) => updateCond(c.key, { value: e.target.value })}
                    onPressEnter={search}
                  />
                )}
                <Button
                  icon={<DeleteOutlined />}
                  onClick={() => setConditions((cs) => cs.filter((x) => x.key !== c.key))}
                />
              </Space>
            )
          })}
        </Space>
      </Card>

      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      <Table
        className="browse-table"
        size="small"
        bordered
        rowKey="__key"
        loading={loading}
        columns={tableColumns}
        dataSource={rows}
        scroll={{ x: 'max-content' }}
        sticky={sticky}
        pagination={{
          current: page,
          pageSize,
          total: data?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100, 200, 500],
          showTotal: (t) => `共 ${t.toLocaleString()} 行`,
        }}
        onChange={(p, _f, s) => {
          setPage(p.current ?? 1)
          setPageSize(p.pageSize ?? 50)
          const sorter = Array.isArray(s) ? s[0] : s
          setSort(
            sorter?.order ? { by: String(sorter.columnKey), desc: sorter.order === 'descend' } : { desc: false },
          )
        }}
      />

      {meta?.editable && (
        <RowEditor
          table={name}
          columns={meta.columns}
          editable={meta.editable}
          dateCol={meta.date_col}
          row={editing}
          defaultDate={applied.date ?? dates[0]?.date}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined)
            reload()
          }}
        />
      )}
    </div>
  )
}
