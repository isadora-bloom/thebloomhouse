/**
 * Settings → Integrations  (Stream 8)
 *
 * Single hub surface for every external connector — Gmail, OpenPhone,
 * Twilio, Zoom, Calendly, Omi/Plaud, plus the CRM importers and a row
 * of "coming soon" providers for each category. Each card shows
 * per-venue connection status fetched in parallel via the adapter
 * registry; the Configure / Connect button routes to that adapter's
 * deepConfigHref.
 *
 * The hub replaces the previous /settings/multi-channel page (which
 * mixed Twilio + Zoom into one surface). Twilio now has its own thin
 * deep-config page at /settings/integrations/twilio; Zoom continues
 * to live at /settings/zoom (canonical OAuth flow).
 */

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import {
  INTEGRATION_ADAPTERS,
  CATEGORY_ORDER,
  CATEGORY_LABELS,
  CATEGORY_BLURBS,
} from '@/lib/services/integrations'
import type {
  IntegrationAdapter,
  IntegrationStatus,
  IntegrationCategory,
} from '@/lib/services/integrations/types'
import {
  Mail,
  Phone,
  MessageSquareText,
  Video,
  Calendar,
  Cpu,
  Database,
  Link2,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
} from 'lucide-react'

export const dynamic = 'force-dynamic'

function iconFor(name?: string) {
  switch (name) {
    case 'Mail':
      return Mail
    case 'Phone':
      return Phone
    case 'MessageSquareText':
      return MessageSquareText
    case 'Video':
      return Video
    case 'Calendar':
      return Calendar
    case 'Cpu':
      return Cpu
    case 'Database':
      return Database
    default:
      return Link2
  }
}

function formatRelative(iso: string | null): string | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const diffMs = Date.now() - t
  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

interface ResolvedAdapter {
  adapter: IntegrationAdapter
  status: IntegrationStatus
}

export default async function IntegrationsHubPage() {
  const auth = await getPlatformAuth()
  if (!auth) redirect('/login?redirect=/settings/integrations')

  const supabase = createServiceClient()
  // Fan out every adapter's status check in parallel so the page
  // doesn't serially block on slow ones. Individual failures fall back
  // to a default-disconnected status so one broken table doesn't
  // collapse the whole hub.
  const resolved: ResolvedAdapter[] = await Promise.all(
    INTEGRATION_ADAPTERS.map(async (adapter) => {
      try {
        const status = await adapter.getStatus(supabase, auth.venueId)
        return { adapter, status }
      } catch {
        return {
          adapter,
          status: {
            connected: false,
            lastSyncAt: null,
            statusLine: adapter.ready ? 'Status check failed' : 'Coming soon',
            errorLine: null,
          },
        }
      }
    }),
  )

  const byCategory = new Map<IntegrationCategory, ResolvedAdapter[]>()
  for (const r of resolved) {
    const arr = byCategory.get(r.adapter.category) ?? []
    arr.push(r)
    byCategory.set(r.adapter.category, arr)
  }

  const renderedCategories = CATEGORY_ORDER.filter((c) => (byCategory.get(c)?.length ?? 0) > 0)

  return (
    <div className="max-w-5xl space-y-10">
      <header className="flex items-start gap-3">
        <Link2 className="w-6 h-6 text-sage-600 mt-1" />
        <div>
          <h1 className="text-2xl font-serif text-sage-900">Integrations</h1>
          <p className="text-sm text-sage-600 mt-1 max-w-2xl">
            Everywhere your couples and vendors reach you, connected to
            Sage&apos;s forensic record. Pick the provider you already use;
            ask for the one you wish was on this list.
          </p>
        </div>
      </header>

      {renderedCategories.map((category) => {
        const items = byCategory.get(category)!
        return (
          <section key={category} className="space-y-3">
            <div>
              <h2 className="text-lg font-serif text-sage-900">{CATEGORY_LABELS[category]}</h2>
              <p className="text-xs text-sage-500 mt-0.5">{CATEGORY_BLURBS[category]}</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {items.map(({ adapter, status }) => (
                <IntegrationCard key={adapter.name} adapter={adapter} status={status} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function IntegrationCard({ adapter, status }: { adapter: IntegrationAdapter; status: IntegrationStatus }) {
  const Icon = iconFor(adapter.iconName)
  const lastSync = formatRelative(status.lastSyncAt)
  const statusLine = status.statusLine ?? (adapter.ready ? 'Not connected' : 'Coming soon')
  const showConfigure = adapter.ready && adapter.deepConfigHref
  const configureLabel = status.connected ? 'Configure' : adapter.category === 'crm' ? 'Import' : 'Connect'

  return (
    <div
      className={
        'border rounded-lg p-4 flex flex-col gap-3 bg-warm-white transition-colors ' +
        (status.connected ? 'border-sage-300' : adapter.ready ? 'border-border' : 'border-dashed border-border')
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className={
              'shrink-0 w-9 h-9 rounded-md flex items-center justify-center ' +
              (status.connected ? 'bg-sage-100 text-sage-700' : 'bg-sage-50 text-sage-500')
            }
          >
            <Icon className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-medium text-sage-900 truncate">{adapter.label}</h3>
              {adapter.badge === 'recommended' && (
                <span className="text-[10px] uppercase tracking-wide bg-sage-100 text-sage-700 px-1.5 py-0.5 rounded">
                  Recommended
                </span>
              )}
              {adapter.badge === 'beta' && (
                <span className="text-[10px] uppercase tracking-wide bg-gold-100 text-gold-700 px-1.5 py-0.5 rounded">
                  Beta
                </span>
              )}
              {!adapter.ready && (
                <span className="text-[10px] uppercase tracking-wide bg-sage-50 text-sage-500 px-1.5 py-0.5 rounded">
                  Coming soon
                </span>
              )}
            </div>
            <p className="text-xs text-sage-600 mt-1 line-clamp-2">{adapter.description}</p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 min-w-0">
          {status.connected ? (
            <CheckCircle2 className="w-4 h-4 text-sage-600 shrink-0" />
          ) : status.errorLine ? (
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          ) : null}
          <span className="text-xs text-sage-700 truncate">
            {status.errorLine ?? statusLine}
            {lastSync && status.connected ? ` · ${lastSync}` : ''}
          </span>
        </div>
        {showConfigure ? (
          <Link
            href={adapter.deepConfigHref!}
            className="inline-flex items-center gap-1 text-xs font-medium text-sage-700 hover:text-sage-900 shrink-0"
          >
            {configureLabel}
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        ) : (
          <span className="text-xs text-sage-400 shrink-0">—</span>
        )}
      </div>
    </div>
  )
}
