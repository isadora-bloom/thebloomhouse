'use client'

/**
 * Wave 8 — per-signal status card.
 *
 * Anchor: bloom-wave4-identity-reconstruction.md, bloom-constitution.md
 *
 * Renders one external-signal's health pill + record count + last refresh
 * + (when config_missing) the list of fields the operator needs to fill,
 * with a deep-link to /settings/venue-info.
 */

import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  PauseCircle,
  ExternalLink,
  RefreshCw,
} from 'lucide-react'
import Link from 'next/link'

interface SignalHealthForCard {
  signal_name: string
  status: 'ready' | 'config_missing' | 'data_stale' | 'error' | 'disabled'
  missing_config_fields: string[]
  last_refresh_at: string | null
  record_count: number
  last_error: string | null
  last_checked_at: string
  display_label: string
  display_description: string
}

interface Props {
  signal: SignalHealthForCard
  onRefresh?: (signalName: string) => void
  refreshing?: boolean
}

const STATUS_STYLES: Record<
  SignalHealthForCard['status'],
  { label: string; pillClass: string; iconColor: string; Icon: typeof CheckCircle2 }
> = {
  ready: {
    label: 'Ready',
    pillClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    iconColor: 'text-emerald-600',
    Icon: CheckCircle2,
  },
  config_missing: {
    label: 'Config missing',
    pillClass: 'bg-amber-50 text-amber-700 border-amber-200',
    iconColor: 'text-amber-600',
    Icon: AlertTriangle,
  },
  data_stale: {
    label: 'Stale',
    pillClass: 'bg-blue-50 text-blue-700 border-blue-200',
    iconColor: 'text-blue-600',
    Icon: Clock,
  },
  error: {
    label: 'Error',
    pillClass: 'bg-red-50 text-red-700 border-red-200',
    iconColor: 'text-red-600',
    Icon: XCircle,
  },
  disabled: {
    label: 'Disabled',
    pillClass: 'bg-sage-50 text-sage-600 border-sage-200',
    iconColor: 'text-sage-500',
    Icon: PauseCircle,
  },
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 'unknown'
  const diff = Date.now() - ms
  const days = diff / 86_400_000
  if (days < 0) return 'in the future'
  if (days < 1) {
    const hours = diff / 3_600_000
    if (hours < 1) return 'just now'
    return `${Math.round(hours)}h ago`
  }
  if (days < 30) return `${Math.round(days)}d ago`
  if (days < 365) return `${Math.round(days / 30)}mo ago`
  return `${Math.round(days / 365)}y ago`
}

export function ExternalSignalStatusCard({ signal, onRefresh, refreshing }: Props) {
  const styles = STATUS_STYLES[signal.status]
  const Icon = styles.Icon

  return (
    <div className="rounded-xl border border-sage-100 bg-white p-5 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <Icon className={`w-4 h-4 ${styles.iconColor}`} />
            <h3 className="font-medium text-sage-900">{signal.display_label}</h3>
          </div>
          <p className="text-xs text-sage-600 leading-relaxed">
            {signal.display_description}
          </p>
        </div>
        <span
          className={`px-2.5 py-1 rounded-full text-xs font-medium border whitespace-nowrap ${styles.pillClass}`}
        >
          {styles.label}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-sage-500">Records</div>
          <div className="text-sage-900 font-medium">
            {signal.record_count.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="text-sage-500">Last refresh</div>
          <div className="text-sage-900 font-medium">
            {formatRelative(signal.last_refresh_at)}
          </div>
        </div>
      </div>

      {signal.status === 'config_missing' && signal.missing_config_fields.length > 0 && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs">
          <div className="text-amber-800 font-medium mb-1">Missing fields:</div>
          <ul className="text-amber-700 space-y-0.5 list-disc list-inside">
            {signal.missing_config_fields.map((f) => (
              <li key={f}>
                <code className="bg-amber-100 px-1 py-0.5 rounded text-[11px]">{f}</code>
              </li>
            ))}
          </ul>
          <Link
            href="/settings/venue-info"
            className="inline-flex items-center gap-1 mt-2 text-amber-800 hover:text-amber-900 underline"
          >
            Fix in venue settings
            <ExternalLink className="w-3 h-3" />
          </Link>
        </div>
      )}

      {signal.last_error && (
        <details className="text-xs">
          <summary className="cursor-pointer text-red-700 hover:text-red-900">
            Error details
          </summary>
          <pre className="mt-2 rounded bg-red-50 border border-red-200 p-2 text-red-800 whitespace-pre-wrap break-words">
            {signal.last_error}
          </pre>
        </details>
      )}

      {onRefresh && signal.status !== 'disabled' && (
        <button
          type="button"
          onClick={() => onRefresh(signal.signal_name)}
          disabled={refreshing}
          className="inline-flex items-center justify-center gap-1.5 self-end text-xs text-sage-600 hover:text-sage-900 disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      )}
    </div>
  )
}
