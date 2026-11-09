/** Branding, menu and AI examples of this deployment (from the business package, GET /api/app). */
export interface ReportEntry {
  id: string
  title: string
  type: 'sql' | 'summary'
  group: string
}

/** A section of the menu and of the 数据表 page (e.g. one client's reports and tables). */
export interface Group {
  id: string
  title: string
}

export interface AppInfo {
  title: string
  subtitle: string
  package: string
  groups: Group[]
  reports: ReportEntry[]
  chat_examples: Record<string, string[]>
}
