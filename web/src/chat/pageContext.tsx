/**
 * What the user is looking at, sent along with each AI 问数 question so "这里" / "当前"
 * resolve to the visible report, date and filters. Pages publish it with usePageContext.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export interface PageContext {
  page: string
  report?: string
  view?: 'day' | 'trend'
  date?: string
  month?: string
  filters?: Record<string, (string | null)[]>
  fields?: string[]
  table?: string
}

interface Store {
  context: PageContext | undefined
  setContext: (ctx: PageContext | undefined) => void
}

const Ctx = createContext<Store>({ context: undefined, setContext: () => {} })

export function PageContextProvider({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<PageContext>()
  const value = useMemo(() => ({ context, setContext }), [context])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export const useCurrentPageContext = () => useContext(Ctx).context

/** Publish this page's context while it is mounted. */
export function usePageContext(ctx: PageContext | undefined) {
  const { setContext } = useContext(Ctx)
  const key = JSON.stringify(ctx ?? null)
  useEffect(() => {
    setContext(ctx)
    return () => setContext(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key is the serialized ctx
  }, [key, setContext])
}

/** One-line summary shown above the input box. */
export function describeContext(ctx: PageContext): string {
  const parts = [ctx.page]
  if (ctx.view === 'trend' && ctx.month) parts.push(`${ctx.month} 月度趋势`)
  else if (ctx.date) parts.push(ctx.date)
  if (ctx.table) parts.push(ctx.table)
  for (const [k, vs] of Object.entries(ctx.filters ?? {})) {
    if (vs.length) parts.push(`${k}=${vs.map((v) => v ?? '（空）').join('、')}`)
  }
  return parts.join(' · ')
}
