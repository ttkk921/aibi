/** Add or change one row of an editable table (package.yaml `editable`); the server cleans and checks the values. */
import { useEffect, useState } from 'react'
import { App, AutoComplete, Form, Input, Modal, Typography } from 'antd'
import { api, apiSend } from '../api'
import { NUMERIC_TYPES } from '../format'

export interface EditColumn {
  name: string
  type: string
  column_type: string
  label: string
}

export interface EditableInfo {
  keys: string[]
  required: string[]
}

// Filled by the database, never edited.
const SYSTEM_COLS = new Set(['id', 'created_at'])

const TEXT_TYPES = new Set(['varchar', 'char', 'text'])

/** Existing values of a text column, so names are picked rather than retyped (and typos avoided). */
function ValueInput({
  table,
  column,
  placeholder,
  value,
  onChange,
}: {
  table: string
  column: string
  placeholder?: string
  // filled in by Form.Item
  value?: string
  onChange?: (v: string) => void
}) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>()
  return (
    <AutoComplete
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      allowClear
      options={options}
      filterOption={(input, o) => String(o?.value ?? '').includes(input)}
      onFocus={() => {
        if (options) return
        api<{ value: unknown; count: number }[]>(`/api/tables/${table}/distinct?column=${encodeURIComponent(column)}&limit=500`)
          .then((vs) => setOptions(vs.filter((v) => v.value !== null).map((v) => ({ value: String(v.value), label: String(v.value) }))))
          .catch(() => setOptions([]))
      }}
    />
  )
}

export default function RowEditor({
  table,
  columns,
  editable,
  dateCol,
  row,
  defaultDate,
  onClose,
  onSaved,
}: {
  table: string
  columns: EditColumn[]
  editable: EditableInfo
  dateCol: string | null
  /** undefined: closed; 'new': add a row; else the row to change */
  row: Record<string, unknown> | 'new' | undefined
  defaultDate?: string
  onClose: () => void
  onSaved: () => void
}) {
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const { message } = App.useApp()
  const fields = columns.filter((c) => !SYSTEM_COLS.has(c.name))

  useEffect(() => {
    if (!row) return
    form.resetFields()
    const init: Record<string, string> = {}
    for (const c of fields) {
      const v = row === 'new' ? (c.name === dateCol ? defaultDate : undefined) : row[c.name]
      if (v !== null && v !== undefined) init[c.name] = String(v)
    }
    form.setFieldsValue(init)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row])

  const save = async () => {
    const v = await form.validateFields()
    const values = Object.fromEntries(fields.map((c) => [c.name, v[c.name] === '' ? null : (v[c.name] ?? null)]))
    setSaving(true)
    try {
      const r =
        row === 'new'
          ? await apiSend<{ message: string }>(`/api/tables/${table}/rows`, 'POST', { values })
          : await apiSend<{ message: string }>(`/api/tables/${table}/rows/${(row as Record<string, unknown>).id}`, 'PUT', { values })
      message.success(r.message, 4)
      onSaved()
    } catch (e) {
      message.error((e as Error).message, 6)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={row === 'new' ? '新增一行' : `修改（id=${row ? (row as Record<string, unknown>).id : ''}）`}
      open={row !== undefined}
      onCancel={onClose}
      onOk={save}
      confirmLoading={saving}
      okText="保存"
      cancelText="取消"
      destroyOnClose
      width={560}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
        {fields.map((c) => {
          const required = editable.required.includes(c.name)
          const numeric = NUMERIC_TYPES.has(c.type)
          const isDate = c.type === 'date' || c.name === dateCol
          const scale = /^decimal\(\d+,(\d+)\)/.exec(c.column_type)?.[1]
          const hint = isDate
            ? '格式 YYYY-MM-DD'
            : numeric && scale && Number(scale) >= 4
              ? '比例填小数，例如 15% 填 0.15'
              : undefined
          return (
            <Form.Item
              key={c.name}
              name={c.name}
              label={
                <span>
                  {c.label}
                  <Typography.Text type="secondary" className="mono" style={{ fontSize: 12, marginLeft: 6 }}>
                    {c.name}
                  </Typography.Text>
                  {editable.keys.includes(c.name) && (
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
                      · 唯一键
                    </Typography.Text>
                  )}
                </span>
              }
              required={required}
              rules={required ? [{ required: true, whitespace: true, message: `请填写${c.label}` }] : []}
              extra={hint}
            >
              {TEXT_TYPES.has(c.type) && !isDate ? (
                <ValueInput table={table} column={c.name} placeholder={required ? undefined : '可以留空'} />
              ) : (
                <Input
                  className={numeric || isDate ? 'mono' : undefined}
                  inputMode={numeric ? 'decimal' : undefined}
                  placeholder={isDate ? 'YYYY-MM-DD' : required ? undefined : '可以留空'}
                  allowClear
                />
              )}
            </Form.Item>
          )
        })}
      </Form>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
        保存时按导入的规则清洗（例如品类名称统一），唯一键和已有的行重复时不会保存。修改记在「数据导入」页的导入记录里。
      </Typography.Paragraph>
    </Modal>
  )
}
