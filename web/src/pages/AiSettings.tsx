/**
 * AI 设置 (admins), in three steps: 1. the providers (OpenAI-compatible endpoints + key + models),
 * 2. the model AI 问数 uses, 3. the prompt (role and answer style). Saved changes apply to the next question.
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Card, Collapse, Form, Input, Modal, Popconfirm, Radio, Select, Space, Spin, Table, Tabs, Tag, Typography } from 'antd'
import { PlusOutlined, RollbackOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons'
import { api, apiSend } from '../api'

interface Provider {
  id: string
  name: string
  base_url: string
  models: string[]
  api_key: string | null // masked
}

interface Changed {
  at: string
  by: string | null
}

interface AiState {
  providers: Provider[]
  selected: { provider: string | null; model: string }
  providers_changed: Changed | null
  model_changed: Changed | null
}

interface StyleState {
  style: string
  default: string
  customized: boolean
  updated_at: string | null
  updated_by: string | null
  platform_rules: string
}

// What the deployment's Command Code models are like, measured on 2026-10-19.
const MODEL_NOTES: Record<string, string> = {
  'deepseek/deepseek-v4.1-flash': '标准版；速度波动大，一个分析问题有时要 1-3 分钟',
  'deepseek/deepseek-v4.1-flash-fast': '快速版；输出稳定在约 130 字/秒，通常十几秒出结果（额度消耗以 Command Code 为准）',
  'deepseek/deepseek-v4-pro': '更强的推理，适合复杂分析；更慢、额度消耗更多',
}

const changedTag = (c: Changed | null) => c && <Tag color="blue">{c.by} 于 {c.at.replace('T', ' ')} 修改</Tag>

function ProvidersTab({ ai, setAi }: { ai: AiState; setAi: (s: AiState) => void }) {
  const [editing, setEditing] = useState<Provider | 'new'>()
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm()
  const { message } = App.useApp()

  const act = async (fn: () => Promise<AiState>, ok: string) => {
    try {
      setAi(await fn())
      message.success(ok)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const openEdit = (p: Provider | 'new') => {
    setEditing(p)
    form.resetFields()
    form.setFieldsValue(p === 'new' ? { models: [] } : { name: p.name, base_url: p.base_url, models: p.models })
  }

  const save = async () => {
    const v = await form.validateFields()
    setSaving(true)
    try {
      const id = editing === 'new' ? 'new' : editing!.id
      setAi(await apiSend<AiState>(`/api/settings/ai/providers/${id}`, 'PUT', { ...v, api_key: v.api_key ?? '' }))
      message.success('已测试并保存')
      setEditing(undefined)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Card
        size="small"
        title={
          <Space wrap>
            共 {ai.providers.length} 个 provider
            {ai.providers_changed ? changedTag(ai.providers_changed) : <Tag>使用 .env 的配置</Tag>}
          </Space>
        }
        extra={
          <Space wrap>
            <Popconfirm
              title="恢复成 .env 的配置？"
              description="页面上添加、修改的 provider 和选择的模型都会被清除。"
              okText="恢复"
              cancelText="取消"
              disabled={!ai.providers_changed && !ai.model_changed}
              onConfirm={() => act(() => apiSend<AiState>('/api/settings/ai', 'DELETE'), '已恢复 .env 的配置')}
            >
              <Button icon={<RollbackOutlined />} disabled={!ai.providers_changed && !ai.model_changed}>
                恢复 .env 配置
              </Button>
            </Popconfirm>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEdit('new')}>
              添加 provider
            </Button>
          </Space>
        }
      >
        <Table<Provider>
          size="small"
          rowKey="id"
          dataSource={ai.providers}
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              render: (n: string, p) => (
                <Space size={4}>
                  {n}
                  {p.id === ai.selected.provider && <Tag color="green">在用</Tag>}
                </Space>
              ),
            },
            { title: '接口地址', dataIndex: 'base_url', render: (u: string) => <span className="mono">{u}</span> },
            {
              title: 'Key',
              dataIndex: 'api_key',
              render: (k: string | null) => (k ? <span className="mono">{k}</span> : <Tag color="red">未配置</Tag>),
            },
            {
              title: '模型',
              dataIndex: 'models',
              render: (ms: string[]) => (
                <div style={{ maxWidth: 300, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {ms.map((m) => (
                    <Tag key={m} className="mono" style={{ marginInlineEnd: 0 }}>
                      {m}
                    </Tag>
                  ))}
                </div>
              ),
            },
            {
              title: '操作',
              key: 'ops',
              render: (_, p) => (
                <Space size={4}>
                  <Button size="small" onClick={() => openEdit(p)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title={`删除 provider ${p.name}？`}
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    disabled={p.id === ai.selected.provider}
                    onConfirm={() => act(() => apiSend<AiState>(`/api/settings/ai/providers/${p.id}`, 'DELETE'), '已删除')}
                  >
                    <Button size="small" danger disabled={p.id === ai.selected.provider} title={p.id === ai.selected.provider ? '正在用，先在「选择模型」换成别的' : undefined}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
          provider 是兼容 OpenAI 接口（/chat/completions）的模型服务。保存前会用其中一个模型发一次很小的请求，key、地址或模型名不对时不会保存。
          页面上保存过之后以页面为准，重新部署不会覆盖；.env 只提供初始配置。
        </Typography.Paragraph>
      </Card>

      <Modal
        title={editing === 'new' ? '添加 provider' : `编辑 ${editing ? (editing as Provider).name : ''}`}
        open={editing !== undefined}
        onCancel={() => setEditing(undefined)}
        onOk={save}
        confirmLoading={saving}
        okText="测试并保存"
        cancelText="取消"
        destroyOnClose
        width={600}
      >
        <Form form={form} layout="vertical" requiredMark={false} style={{ marginTop: 16 }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true, message: '请填写名称' }]}>
            <Input placeholder="例如 Command Code" maxLength={40} />
          </Form.Item>
          <Form.Item
            name="base_url"
            label="接口地址"
            rules={[{ required: true, pattern: /^https?:\/\/\S+$/, message: '以 http:// 或 https:// 开头' }]}
          >
            <Input className="mono" placeholder="https://api.commandcode.ai/provider/v1" />
          </Form.Item>
          <Form.Item
            name="api_key"
            label="API key"
            rules={editing === 'new' ? [{ required: true, whitespace: true, message: '请填写 key' }] : []}
            extra={editing !== 'new' && editing?.api_key ? `留空则保持当前的 key（${editing.api_key}）` : undefined}
          >
            <Input.Password className="mono" placeholder={editing === 'new' ? '粘贴 key' : '留空则不改'} autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="models"
            label="模型"
            rules={[{ required: true, type: 'array', min: 1, message: '至少填一个模型' }]}
            extra="输入模型名后按回车，可以填多个；保存时用第一个测试"
          >
            <Select mode="tags" className="mono" placeholder="deepseek/deepseek-v4.1-flash" tokenSeparators={[',', ' ']} open={false} suffixIcon={null} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}

function ModelTab({ ai, setAi }: { ai: AiState; setAi: (s: AiState) => void }) {
  const [saving, setSaving] = useState(false)
  const { message } = App.useApp()
  const value = ai.selected.provider ? `${ai.selected.provider}\n${ai.selected.model}` : undefined

  return (
    <Card size="small" title={<Space wrap>AI 问数使用的模型{changedTag(ai.model_changed)}</Space>}>
      {!value && <Alert type="warning" showIcon message="还没有可用的模型，先在「管理 Provider」里添加" style={{ marginBottom: 12 }} />}
      <Radio.Group
        value={value}
        disabled={saving}
        onChange={async (e) => {
          const [provider, model] = (e.target.value as string).split('\n')
          setSaving(true)
          try {
            setAi(await apiSend<AiState>('/api/settings/ai/model', 'PUT', { provider, model }))
            message.success('已切换，下一个问题开始生效')
          } catch (err) {
            message.error((err as Error).message)
          } finally {
            setSaving(false)
          }
        }}
      >
        <Space direction="vertical" size={16}>
          {ai.providers.map((p) => (
            <div key={p.id}>
              <Typography.Text strong>{p.name}</Typography.Text>
              <Space direction="vertical" style={{ display: 'flex', marginTop: 6, paddingLeft: 12 }}>
                {p.models.map((m) => (
                  <Radio key={m} value={`${p.id}\n${m}`}>
                    <span className="mono">{m}</span>
                    {MODEL_NOTES[m] && (
                      <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                        {MODEL_NOTES[m]}
                      </Typography.Text>
                    )}
                  </Radio>
                ))}
              </Space>
            </div>
          ))}
        </Space>
      </Radio.Group>
      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
        {saving ? '正在测试这个模型…' : '切换前会先测试一次，模型不可用（没有权限、额度用完）时不会切换。'}
      </Typography.Paragraph>
    </Card>
  )
}

function PromptTab() {
  const [state, setState] = useState<StyleState>()
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const { message } = App.useApp()

  const apply = useCallback((s: StyleState) => {
    setState(s)
    setDraft(s.style)
  }, [])

  useEffect(() => {
    api<StyleState>('/api/settings/chat-style').then(apply).catch((e) => setError(e.message))
  }, [apply])

  const run = async (fn: () => Promise<StyleState>, ok: string) => {
    setSaving(true)
    try {
      apply(await fn())
      message.success(ok)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (error) return <Alert type="error" message={error} showIcon />
  if (!state) return <Spin />
  const dirty = draft !== state.style

  return (
    <>
      <Card
        size="small"
        style={{ marginBottom: 16 }}
        title={
          <Space wrap>
            角色和回答风格
            {state.customized ? (
              <Tag color="blue">
                已自定义 · {state.updated_by} 于 {state.updated_at?.replace('T', ' ')}
              </Tag>
            ) : (
              <Tag>使用业务包的默认风格</Tag>
            )}
            {dirty && <Tag color="orange">有未保存的修改</Tag>}
          </Space>
        }
        extra={
          <Space wrap>
            <Button icon={<UndoOutlined />} disabled={!dirty || saving} onClick={() => setDraft(state.style)}>
              撤销修改
            </Button>
            <Popconfirm
              title="恢复成业务包的默认风格？"
              description="页面上保存过的风格会被清除。"
              okText="恢复默认"
              cancelText="取消"
              disabled={!state.customized}
              onConfirm={() => run(() => apiSend<StyleState>('/api/settings/chat-style', 'DELETE'), '已恢复默认风格')}
            >
              <Button icon={<RollbackOutlined />} disabled={!state.customized || saving}>
                恢复默认
              </Button>
            </Popconfirm>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={saving}
              disabled={!dirty || !draft.trim()}
              onClick={() => run(() => apiSend<StyleState>('/api/settings/chat-style', 'PUT', { style: draft }), '已保存，下一个问题开始生效')}
            >
              保存
            </Button>
          </Space>
        }
      >
        <Input.TextArea
          className="mono"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoSize={{ minRows: 18, maxRows: 40 }}
          maxLength={10000}
          showCount
          style={{ fontSize: 13 }}
        />
      </Card>

      <Card size="small" title="怎么写" style={{ marginBottom: 16 }}>
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          用自然语言写给 AI 看，Markdown 格式即可。建议包含：
        </Typography.Paragraph>
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
          <li>
            <b>角色</b>：例如「你是 AI 数据分析师」，语气偏正式还是口语。
          </li>
          <li>
            <b>回答结构</b>：例如分「结论 / 分析 / 建议」三段，每段写多少。
          </li>
          <li>
            <b>格式</b>：金额单位、小数位、最多列几行数据、要不要表格。
          </li>
          <li>
            <b>例外</b>：什么情况下不用套结构，例如简单查一个数时直接回答。
          </li>
        </ul>
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
          不用写工具怎么用（下面的平台规则会自动加上），也不用写指标口径（在业务包的 knowledge.md 里）。改完可以点右下角「问数」，开一个新对话试一下效果。
        </Typography.Paragraph>
      </Card>

      <Collapse
        items={[
          {
            key: 'rules',
            label: '平台固定的工具规则（只读，会自动加在风格后面）',
            children: <pre className="sql-source mono">{state.platform_rules}</pre>,
          },
        ]}
      />
    </>
  )
}

export default function AiSettingsPage() {
  const [ai, setAi] = useState<AiState>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    api<AiState>('/api/settings/ai').then(setAi).catch((e) => setError(e.message))
  }, [])

  return (
    <div className="page">
      <div className="page-title">
        <h2>AI 设置</h2>
        <Typography.Text type="secondary">AI 问数用的模型服务、模型和提示词，保存后从下一个问题开始生效</Typography.Text>
      </div>
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
      {!ai && !error && <Spin />}
      {ai && (
        <Tabs
          items={[
            { key: 'providers', label: '1. 管理 Provider', children: <ProvidersTab ai={ai} setAi={setAi} /> },
            { key: 'model', label: '2. 选择模型', children: <ModelTab ai={ai} setAi={setAi} /> },
            { key: 'prompt', label: '3. 提示词', children: <PromptTab /> },
          ]}
        />
      )}
    </div>
  )
}
