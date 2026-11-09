import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Button, Card, Col, Empty, Row, Space, Spin, Statistic, Tag, Typography } from 'antd'
import { api } from '../api'
import type { Group } from '../appInfo'

export interface TableInfo {
  name: string
  label: string
  date_col: string | null
  total: number
  by_date: { date: string; rows: number }[]
  /** Summary tables are generated from this detail table on import and cannot be imported into. */
  derived_from: string | null
  /** Rows can be added, changed and deleted on the table's page. */
  editable: { keys: string[]; required: string[] } | null
  /** Group.id: the section of this page (and of the import page's table list) it belongs to. */
  group: string
}

export default function TablesPage({ groups }: { groups: Group[] }) {
  const [tables, setTables] = useState<TableInfo[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    api<TableInfo[]>('/api/tables').then(setTables).catch((e) => setError(e.message))
  }, [])

  return (
    <div className="page">
      <div className="page-title">
        <h2>数据表</h2>
        <Typography.Text type="secondary">数据库 bi_data 中的业务表和汇总表</Typography.Text>
      </div>
      {error && <Alert type="error" message={error} showIcon />}
      {!tables && !error && <Spin />}
      {tables &&
        groups.map((g) => {
          const items = tables.filter((t) => t.group === g.id)
          return (
            <section key={g.id} style={{ marginBottom: 24 }}>
              <Typography.Title level={5} style={{ marginBottom: 12 }}>
                {g.title}
              </Typography.Title>
              {items.length ? (
                <TableCards tables={items} />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据表" />
              )}
            </section>
          )
        })}
    </div>
  )
}

function TableCards({ tables }: { tables: TableInfo[] }) {
  const navigate = useNavigate()
  return (
    <Row gutter={[16, 16]}>
      {tables.map((t) => (
        <Col key={t.name} xs={24} md={12} xl={8}>
          <Card
            title={
              <Space size={6}>
                {t.label}
                {t.derived_from && <Tag color="blue">自动汇总</Tag>}
                {t.editable && <Tag color="green">可页面编辑</Tag>}
              </Space>
            }
            extra={<Typography.Text type="secondary" className="mono">{t.name}</Typography.Text>}
            actions={[
              <Button type="link" key="view" onClick={() => navigate(`/tables/${t.name}`)}>
                查看 / 查询
              </Button>,
              t.derived_from ? (
                <Typography.Text type="secondary" key="import" style={{ fontSize: 12 }}>
                  导入明细时自动生成
                </Typography.Text>
              ) : (
                <Button type="link" key="import" onClick={() => navigate(`/import?table=${t.name}`)}>
                  导入数据
                </Button>
              ),
            ]}
          >
            <Statistic title="总行数" value={t.total} />
            <div style={{ marginTop: 12, minHeight: 48 }}>
              {t.date_col ? (
                <Space size={[4, 4]} wrap>
                  <Typography.Text type="secondary">按 {t.date_col}：</Typography.Text>
                  {t.by_date.slice(0, 6).map((d) => (
                    <Tag key={d.date}>
                      {d.date} · {d.rows.toLocaleString()}
                    </Tag>
                  ))}
                  {t.by_date.length > 6 && <Tag>…共 {t.by_date.length} 个日期</Tag>}
                </Space>
              ) : (
                <Typography.Text type="secondary">无日期字段（维表，整表导入）</Typography.Text>
              )}
            </div>
          </Card>
        </Col>
      ))}
    </Row>
  )
}
