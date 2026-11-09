/** 用户管理 (admins): create users, change roles, disable, reset passwords, delete. */
import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Card, Form, Input, Modal, Popconfirm, Radio, Space, Table, Tag, Typography } from 'antd'
import { KeyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { api, apiSend as send } from '../api'
import { ROLE_OPTIONS, type Me, type Role } from '../me'

interface UserRow {
  id: number
  username: string
  display_name: string
  role: Role
  role_label: string
  active: boolean
  created_at: string
  last_login: string | null
}

const ROLE_COLOR: Record<Role, string> = { viewer: 'default', analyst: 'blue', admin: 'gold' }

function RoleField() {
  return (
    <Form.Item name="role" label="角色" rules={[{ required: true }]}>
      <Radio.Group>
        <Space direction="vertical">
          {ROLE_OPTIONS.map((r) => (
            <Radio key={r.value} value={r.value}>
              <b>{r.label}</b>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                {r.description}
              </Typography.Text>
            </Radio>
          ))}
        </Space>
      </Radio.Group>
    </Form.Item>
  )
}

export default function UsersPage({ me }: { me: Me }) {
  const [rows, setRows] = useState<UserRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [editing, setEditing] = useState<UserRow | 'new'>()
  const [resetting, setResetting] = useState<UserRow>()
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()
  const [resetForm] = Form.useForm()
  const { message, modal } = App.useApp()

  const load = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      setRows(await api<UserRow[]>('/api/users'))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const showPassword = (title: string, password: string) =>
    modal.success({
      title,
      content: (
        <div>
          <p>系统生成的密码只显示这一次，请转告对方，并提醒登录后在右上角「修改密码」改掉：</p>
          <Typography.Paragraph copyable={{ text: password }} code style={{ fontSize: 16 }}>
            {password}
          </Typography.Paragraph>
        </div>
      ),
    })

  const openEdit = (row: UserRow | 'new') => {
    setEditing(row)
    form.resetFields()
    form.setFieldsValue(row === 'new' ? { role: 'viewer' } : { display_name: row.display_name, role: row.role })
  }

  const save = async () => {
    const v = await form.validateFields()
    setSaving(true)
    try {
      if (editing === 'new') {
        const r = await send<{ generated_password: string | null }>('/api/users', 'POST', {
          username: v.username,
          display_name: v.display_name ?? '',
          role: v.role,
          password: v.password || null,
        })
        message.success(`已创建 ${v.username}`)
        if (r.generated_password) showPassword(`${v.username} 的初始密码`, r.generated_password)
      } else if (editing) {
        await send(`/api/users/${editing.id}`, 'PATCH', { display_name: v.display_name ?? '', role: v.role })
        message.success('已保存')
      }
      setEditing(undefined)
      load()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    const v = await resetForm.validateFields()
    setSaving(true)
    try {
      const r = await send<{ generated_password: string | null }>(`/api/users/${resetting!.id}/password`, 'POST', {
        password: v.password || null,
      })
      message.success(`已重置 ${resetting!.username} 的密码，他之前的登录已失效`)
      if (r.generated_password) showPassword(`${resetting!.username} 的新密码`, r.generated_password)
      setResetting(undefined)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      message.success(ok)
      load()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <div className="page">
      <div className="page-title">
        <h2>用户管理</h2>
        <Typography.Text type="secondary">管理员可以添加用户、分配角色、停用账号和重置密码</Typography.Text>
      </div>
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
      <Card
        size="small"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit('new')}>
              添加用户
            </Button>
          </Space>
        }
        title={`共 ${rows.length} 个用户`}
      >
        <Table<UserRow>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: '用户名',
              dataIndex: 'username',
              render: (u: string, r) => (
                <Space size={4}>
                  {u}
                  {r.id === me.id && <Tag>我</Tag>}
                </Space>
              ),
            },
            { title: '姓名', dataIndex: 'display_name' },
            { title: '角色', dataIndex: 'role', render: (role: Role, r) => <Tag color={ROLE_COLOR[role]}>{r.role_label}</Tag> },
            {
              title: '状态',
              dataIndex: 'active',
              render: (a: boolean) => (a ? <Tag color="green">启用</Tag> : <Tag color="red">已停用</Tag>),
            },
            { title: '最近登录', dataIndex: 'last_login', render: (t: string | null) => (t ? t.replace('T', ' ') : '—') },
            { title: '创建时间', dataIndex: 'created_at', render: (t: string) => t.replace('T', ' ') },
            {
              title: '操作',
              key: 'ops',
              render: (_, r) => (
                <Space size={4} wrap>
                  <Button size="small" onClick={() => openEdit(r)}>
                    编辑
                  </Button>
                  <Button
                    size="small"
                    icon={<KeyOutlined />}
                    onClick={() => {
                      resetForm.resetFields()
                      setResetting(r)
                    }}
                  >
                    重置密码
                  </Button>
                  {r.id !== me.id && (
                    <Button
                      size="small"
                      onClick={() => act(() => send(`/api/users/${r.id}`, 'PATCH', { active: !r.active }), r.active ? '已停用，他的登录已失效' : '已启用')}
                    >
                      {r.active ? '停用' : '启用'}
                    </Button>
                  )}
                  {r.id !== me.id && (
                    <Popconfirm
                      title={`删除用户 ${r.username}？`}
                      description="删除后不能恢复；只是暂时不让他用，可以选「停用」。"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => act(() => send(`/api/users/${r.id}`, 'DELETE'), '已删除')}
                    >
                      <Button size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title={editing === 'new' ? '添加用户' : `编辑 ${editing ? (editing as UserRow).username : ''}`}
        open={editing !== undefined}
        onCancel={() => setEditing(undefined)}
        onOk={save}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        width={560}
      >
        <Form form={form} layout="vertical" requiredMark={false} style={{ marginTop: 16 }}>
          {editing === 'new' && (
            <Form.Item
              name="username"
              label="用户名（登录用）"
              rules={[
                { required: true, message: '请输入用户名' },
                { pattern: /^[\w.@\-一-龥]{2,32}$/, message: '2-32 位，字母、数字、中文和 _ . @ -' },
              ]}
            >
              <Input autoComplete="off" />
            </Form.Item>
          )}
          <Form.Item name="display_name" label="姓名（显示用，可不填）">
            <Input autoComplete="off" />
          </Form.Item>
          {editing !== 'new' && editing && (editing as UserRow).id === me.id ? (
            <Alert type="info" showIcon message="不能修改自己的角色" style={{ marginBottom: 16 }} />
          ) : (
            <RoleField />
          )}
          {editing === 'new' && (
            <Form.Item
              name="password"
              label="初始密码"
              extra="不填则由系统生成一个随机密码，保存后显示一次"
              rules={[{ min: 8, message: '至少 8 位' }]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        title={`重置 ${resetting?.username ?? ''} 的密码`}
        open={!!resetting}
        onCancel={() => setResetting(undefined)}
        onOk={reset}
        confirmLoading={saving}
        okText="重置"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={resetForm} layout="vertical" requiredMark={false} style={{ marginTop: 16 }}>
          <Form.Item
            name="password"
            label="新密码"
            extra="不填则由系统生成一个随机密码。重置后他已有的登录全部失效。"
            rules={[{ min: 8, message: '至少 8 位' }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
