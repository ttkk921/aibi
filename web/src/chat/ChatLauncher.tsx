/** The 「AI 问数」 button on every page; the drawer (and its markdown renderer) loads on first open. */
import { lazy, Suspense, useState } from 'react'
import { useCurrentPageContext } from './pageContext'

const ChatDrawer = lazy(() => import('./ChatDrawer'))

/** Sparkles: one large four-point star and two small ones, the usual mark for AI features. */
function SparklesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden>
      <path d="M10 2.5c.4 3.9 2.6 6.1 6.5 6.5-3.9.4-6.1 2.6-6.5 6.5-.4-3.9-2.6-6.1-6.5-6.5 3.9-.4 6.1-2.6 6.5-6.5Z" />
      <path className="chat-launcher-spark" d="M18 13c.2 2 1.3 3.1 3.3 3.3-2 .2-3.1 1.3-3.3 3.3-.2-2-1.3-3.1-3.3-3.3 2-.2 3.1-1.3 3.3-3.3Z" />
      <path className="chat-launcher-spark chat-launcher-spark-2" d="M5.5 15.5c.15 1.4.9 2.15 2.3 2.3-1.4.15-2.15.9-2.3 2.3-.15-1.4-.9-2.15-2.3-2.3 1.4-.15 2.15-.9 2.3-2.3Z" />
    </svg>
  )
}

export default function ChatLauncher({
  fallbackPage,
  examples,
  canSql,
}: {
  fallbackPage?: string
  examples: Record<string, string[]>
  canSql: boolean
}) {
  const [open, setOpen] = useState(false)
  // Stays mounted after the first open so the conversation survives closing the drawer.
  const [loaded, setLoaded] = useState(false)
  // Pages with filters publish details; the others are known by name only.
  const pageContext = useCurrentPageContext() ?? (fallbackPage ? { page: fallbackPage } : undefined)

  return (
    <>
      {!open && (
        <button
          type="button"
          className="chat-launcher"
          aria-label="打开 AI 问数"
          onClick={() => {
            setLoaded(true)
            setOpen(true)
          }}
        >
          <span className="chat-launcher-icon">
            <SparklesIcon />
          </span>
          <span className="chat-launcher-text">AI 问数</span>
        </button>
      )}
      {loaded && (
        <Suspense fallback={null}>
          <ChatDrawer open={open} onClose={() => setOpen(false)} pageContext={pageContext} examples={examples} canSql={canSql} />
        </Suspense>
      )}
    </>
  )
}
