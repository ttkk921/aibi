import { useState } from 'react'
import { App, Form, Input, Modal } from 'antd'
import { api } from './api'

interface Values {
  old_password: string
  new_password: string
  confirm: string
}

/** Change the login password; other devices are signed out, this one stays signed in. */
export default function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<Values>()
  const [saving, setSaving] = useState(false)
  const { message } = App.useApp()

  const submit = async () => {
    const v = await form.validateFields()
    setSaving(true)
    try {
      await api('/api/auth/password', { old_password: v.old_password, new_password: v.new_password })
      message.success('密码已修改，其他设备上的登录已失效')
      form.resetFields()
      onClose()
    } catch (e) {
      form.setFields([{ name: 'old_password', errors: [(e as Error).message] }])
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="修改密码"
      open={open}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={submit}
      onCancel={() => {
        form.resetFields()
        onClose()
      }}
      destroyOnClose
    >
      <Form form={form} layout="vertical" requiredMark={false} style={{ marginTop: 16 }}>
        <Form.Item name="old_password" label="当前密码" rules={[{ required: true, message: '请输入当前密码' }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item
          name="new_password"
          label="新密码"
          rules={[
            { required: true, message: '请输入新密码' },
            { min: 8, message: '至少 8 位' },
          ]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          name="confirm"
          label="再输一次新密码"
          dependencies={['new_password']}
          rules={[
            { required: true, message: '请再输一次' },
            ({ getFieldValue }) => ({
              validator: (_, value) =>
                !value || value === getFieldValue('new_password') ? Promise.resolve() : Promise.reject(new Error('两次输入不一致')),
            }),
          ]}
        >
          <Input.Password autoComplete="new-password" onPressEnter={submit} />
        </Form.Item>
      </Form>
    </Modal>
  )
}
