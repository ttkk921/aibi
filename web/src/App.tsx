import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Button, Drawer, Dropdown, Grid, Layout, Menu, Result, Spin, Tag, Typography } from 'antd'
import {
  CodeOutlined,
  DatabaseOutlined,
  HistoryOutlined,
  KeyOutlined,
  LogoutOutlined,
  MenuOutlined,
  RobotOutlined,
  TableOutlined,
  TeamOutlined,
  UploadOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { api, UNAUTHORIZED_EVENT } from './api'
import LoginPage from './pages/Login'
import TablesPage from './pages/Tables'
import TableBrowsePage from './pages/TableBrowse'
import ImportPage from './pages/Import'
import ReportPage from './pages/Report'
import SummaryReportPage from './pages/SummaryReport'
import SqlPage from './pages/Sql'
import UsersPage from './pages/Users'
import AiSettingsPage from './pages/AiSettings'
import type { Me } from './me'
import type { AppInfo, ReportEntry } from './appInfo'
import ChangePasswordModal from './ChangePassword'
import ChatLauncher from './chat/ChatLauncher'
import { PageContextProvider } from './chat/pageContext'

// Admins only, and it brings the markdown renderer of the chat: loaded when opened.
const ChatHistoryPage = lazy(() => import('./pages/ChatHistory'))

const { Header, Sider, Content } = Layout

/** A report page: SQL reports and summary reports have different pages. */
function ReportRoute({ reports }: { reports: ReportEntry[] }) {
  const { id = '' } = useParams()
  const entry = reports.find((r) => r.id === id)
  if (!entry) return <Result status="404" title="没有这个报表" />
  return entry.type === 'summary' ? <SummaryReportPage key={id} id={id} /> : <ReportPage />
}

export default function App() {
  const [user, setUser] = useState<Me | null | undefined>(undefined)
  const [info, setInfo] = useState<AppInfo>()
  const [changingPassword, setChangingPassword] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // Phones and narrow tablets: the menu moves into a drawer and the account actions into a dropdown.
  const narrow = !Grid.useBreakpoint().lg
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => {
    api<Me>('/api/auth/me')
      .then(setUser)
      .catch(() => setUser(null))
    const onUnauthorized = () => setUser(null)
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  useEffect(() => {
    if (!user) return
    api<AppInfo>('/api/app')
      .then((i) => {
        setInfo(i)
        document.title = i.title
      })
      .catch(() => setInfo(undefined))
  }, [user])

  const logout = useCallback(async () => {
    await api('/api/auth/logout', {}).catch(() => undefined)
    setUser(null)
  }, [])

  if (user === undefined || (user && !info)) {
    return <Spin fullscreen />
  }
  if (user === null) {
    return <LoginPage onLogin={setUser} />
  }

  const can = user.permissions
  const selected = location.pathname.startsWith('/tables')
    ? '/tables'
    : location.pathname
  const pageName =
    ({ '/tables': '数据表', '/import': '数据导入', '/sql': 'SQL 查询', '/users': '用户管理', '/settings/ai': 'AI 设置', '/chat-history': '问数记录' } as Record<string, string>)[selected] ??
    info!.reports.find((r) => `/reports/${r.id}` === selected)?.title
  // Viewers have no data pages; they land on the first report.
  const home = can.tables ? '/tables' : info!.reports.length ? `/reports/${info!.reports[0].id}` : '/'

  const roleTag = (
    <Tag color={user.role === 'admin' ? 'gold' : user.role === 'analyst' ? 'blue' : 'default'} style={{ marginInlineEnd: 0 }}>
      {user.role_label}
    </Tag>
  )
  const menu = (
    <Menu
      mode="inline"
      selectedKeys={[selected]}
      defaultOpenKeys={info!.groups.map((g) => `group:${g.id}`)}
      style={{ borderInlineEnd: 'none' }}
      onClick={(e) => {
        navigate(e.key)
        setMenuOpen(false)
      }}
      items={[
        can.tables && { key: '/tables', icon: <DatabaseOutlined />, label: '数据表' },
        can.import && { key: '/import', icon: <UploadOutlined />, label: '数据导入' },
        ...info!.groups.map((g) => {
          const reports = info!.reports.filter((r) => r.group === g.id)
          return {
            key: `group:${g.id}`,
            icon: <TableOutlined />,
            label: g.title,
            children: reports.length
              ? reports.map((r) => ({ key: `/reports/${r.id}`, label: r.title }))
              : [{ key: `group:${g.id}:empty`, label: '暂无报表', disabled: true }],
          }
        }),
        can.sql && { key: '/sql', icon: <CodeOutlined />, label: 'SQL 查询' },
        can.users && { key: '/users', icon: <TeamOutlined />, label: '用户管理' },
        can.users && { key: '/settings/ai', icon: <RobotOutlined />, label: 'AI 设置' },
        can.users && { key: '/chat-history', icon: <HistoryOutlined />, label: '问数记录' },
      ].filter((x) => !!x)}
    />
  )

  return (
    <PageContextProvider>
      <Layout style={{ minHeight: '100vh' }}>
        {!narrow && (
          <Sider width={232} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
            <div style={{ padding: '18px 20px', fontWeight: 600, fontSize: 16 }}>{info!.title}</div>
            {menu}
          </Sider>
        )}
        {narrow && (
          <Drawer
            placement="left"
            width={264}
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            title={info!.title}
            closable={false}
            styles={{ body: { padding: 0 } }}
          >
            {menu}
          </Drawer>
        )}
        <Layout>
          <Header className={narrow ? 'app-header app-header-narrow' : 'app-header'}>
            {narrow ? (
              <>
                <Button type="text" icon={<MenuOutlined />} aria-label="菜单" onClick={() => setMenuOpen(true)} />
                <div className="app-header-title">{info!.title}</div>
                <Dropdown
                  trigger={['click']}
                  placement="bottomRight"
                  menu={{
                    items: [
                      {
                        key: 'me',
                        disabled: true,
                        label: (
                          <span style={{ color: 'rgba(0,0,0,0.88)' }}>
                            {user.display_name} {roleTag}
                          </span>
                        ),
                      },
                      { type: 'divider' },
                      { key: 'password', icon: <KeyOutlined />, label: '修改密码' },
                      { key: 'logout', icon: <LogoutOutlined />, label: '退出' },
                    ],
                    onClick: (e) => (e.key === 'password' ? setChangingPassword(true) : e.key === 'logout' && logout()),
                  }}
                >
                  <Button type="text" icon={<UserOutlined />} aria-label="账号" />
                </Dropdown>
              </>
            ) : (
              <>
                <Typography.Text type="secondary">{user.display_name}</Typography.Text>
                {roleTag}
                <Button size="small" icon={<KeyOutlined />} onClick={() => setChangingPassword(true)}>
                  修改密码
                </Button>
                <Button size="small" icon={<LogoutOutlined />} onClick={logout}>
                  退出
                </Button>
              </>
            )}
            <ChangePasswordModal open={changingPassword} onClose={() => setChangingPassword(false)} />
          </Header>
          <Content>
            <Routes>
              <Route path="/" element={<Navigate to={home} replace />} />
              {can.tables && <Route path="/tables" element={<TablesPage groups={info!.groups} />} />}
              {can.tables && <Route path="/tables/:name" element={<TableBrowsePage />} />}
              {can.import && <Route path="/import" element={<ImportPage groups={info!.groups} />} />}
              <Route path="/reports/:id" element={<ReportRoute reports={info!.reports} />} />
              {can.sql && <Route path="/sql" element={<SqlPage />} />}
              {can.users && <Route path="/users" element={<UsersPage me={user} />} />}
              {can.users && <Route path="/settings/ai" element={<AiSettingsPage />} />}
              {can.users && (
                <Route
                  path="/chat-history"
                  element={
                    <Suspense fallback={<Spin />}>
                      <ChatHistoryPage />
                    </Suspense>
                  }
                />
              )}
              {can.users && <Route path="/settings/chat" element={<Navigate to="/settings/ai" replace />} />}
              <Route path="*" element={<Navigate to={home} replace />} />
            </Routes>
          </Content>
        </Layout>
      </Layout>
      <ChatLauncher fallbackPage={pageName} examples={info!.chat_examples} canSql={can.ai_sql} />
    </PageContextProvider>
  )
}
