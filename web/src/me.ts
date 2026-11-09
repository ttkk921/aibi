/** The signed-in user (GET /api/auth/me). The API enforces the same permissions. */
export type Role = 'viewer' | 'analyst' | 'admin'

export interface Me {
  id: number
  username: string
  display_name: string
  role: Role
  role_label: string
  permissions: {
    tables: boolean
    import: boolean
    sql: boolean
    ai_sql: boolean
    users: boolean
  }
}

export const ROLE_OPTIONS: { value: Role; label: string; description: string }[] = [
  { value: 'viewer', label: '只读', description: '看报表、用 AI 问数（只查报表）、改自己的密码' },
  { value: 'analyst', label: '分析员', description: '另外可以浏览数据表、导入数据、用 SQL 查询，AI 问数可执行 SQL' },
  { value: 'admin', label: '管理员', description: '另外可以管理用户' },
]
