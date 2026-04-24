'use client'

import Link from 'next/link'
import { MODE_SAGE } from '@/components/shell/nav-config'

/**
 * Sage's Brain landing — index page for mode 'sage'. Lists every rail
 * item with a one-line blurb so a coordinator landing here can pick
 * where to go without scanning the sidebar. Phase 2B deliverable: no
 * configuration UI lives on this page; clicking a rail item navigates
 * to the existing URL (identity / voice / knowledge / etc.). Phase 3
 * may consolidate those pages; for now they stay where they are.
 */
export default function SageBrainIndex() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-heading text-3xl font-bold text-sage-900">Sage&apos;s Brain</h1>
        <p className="text-sage-600 max-w-2xl">
          Everything that shapes how Sage talks, what Sage knows, and how Sage behaves on inquiries
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
              <h2 className="font-heading text-base font-semibold text-sage-900">{s.title}</h2>
              {s.subtitle && <p className="text-sm text-sage-500 mt-1">{s.subtitle}</p>}
              <p className="text-xs text-sage-400 mt-3">{s.items.length} {s.items.length === 1 ? 'page' : 'pages'}</p>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
