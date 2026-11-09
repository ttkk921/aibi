import { useEffect, useState } from 'react'
import { Alert, Button, Card, Form, Input } from 'antd'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { api } from '../api'
import type { Me } from '../me'

export default function LoginPage({ onLogin }: { onLogin: (user: Me) => void }) {
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [title, setTitle] = useState('')

  useEffect(() => {
    api<{ title: string }>('/api/app/public')
      .then((i) => {
        setTitle(i.title)
        document.title = i.title
      })
      .catch(() => undefined)
  }, [])

  const submit = async (values: { username: string; password: string }) => {
    setLoading(true)
    setError(undefined)
    try {
      onLogin(await api<Me>('/api/auth/login', values))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <Card title={`${title || 'BI 看板'} 登录`} style={{ width: '100%', maxWidth: 360 }}>
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        <Form onFinish={submit} autoComplete="on">
          <Form.Item name="username" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  )
}
