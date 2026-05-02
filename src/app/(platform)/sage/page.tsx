'use client'

import Link from 'next/link'
import { MODE_SAGE } from '@/components/shell/nav-config'
import { useAiName } from '@/lib/hooks/use-ai-name'

/**
 * AI brain landing — index page for the venue's AI configuration mode.
 * Lists every rail item with a one-line blurb so a coordinator landing
 * here can pick where to go without scanning the sidebar. Phase 2B
 * deliverable: no configuration UI lives on this page; clicking a rail
 * item navigates to the existing URL (identity / voice / knowledge /
 * etc.). White-label: every "Sage" string substitutes the venue's
 * configured ai_name (T5-β.2).
 */
export default function SageBrainIndex() {
  const aiName = useAiName()
  const brand = (text: string) => text.replace(/\bSage\b/g, aiName)
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-heading text-3xl font-bold text-sage-900">{aiName}&apos;s Brain</h1>
        <p className="text-sage-600 max-w-2xl">
          Everything that shapes how {aiName} talks, what {aiName} knows, and how {aiName} behaves on inquiries
          and in the couple portal. Configuration lives here; daily work is in the other modes.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {MODE_SAGE.sections.map((s) => {
          const first = s.items[0]
          if (!first) return null
          return (
            <Link
              key={s.title}
              href={first.href}
              className="block rounded-xl border border-border bg-surface p-5 hover:border-sage-400 hover:shadow-sm transition-all"
            >
              <h2 className="font-heading text-base font-semibold text-sage-900">{brand(s.title)}</h2>
              {s.subtitle && <p className="text-sm text-sage-500 mt-1">{brand(s.subtitle)}</p>}
              <p className="text-xs text-sage-400 mt-3">{s.items.length} {s.items.length === 1 ? 'page' : 'pages'}</p>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
