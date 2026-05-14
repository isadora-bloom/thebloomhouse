import { cn } from '@/lib/utils'

/**
 * Shared primitive for "not enough data yet" states. Replaces ad-hoc
 * "n < 10" pills and free-text "need 30 days" strings.
 *
 * Two visual variants:
 *   - 'pill'   : a compact inline chip ("4 of 10 couples"). For lists.
 *   - 'card'   : a full block with progress bar + unlock copy. For dashboards.
 *
 * Always tell the operator three things:
 *   1. where they are (current)
 *   2. where they need to be (threshold)
 *   3. what unlocks (unlocks copy)
 *
 * Per anti-guilt framing: never frame as a failure. Frame as a count-up.
 */
interface DataMaturityProps {
  current: number
  threshold: number
  unit: string
  unlocks?: string
  variant?: 'pill' | 'card'
  className?: string
}

export function DataMaturity({
  current,
  threshold,
  unit,
  unlocks,
  variant = 'card',
  className,
}: DataMaturityProps) {
  const pct = Math.min(100, Math.round((current / threshold) * 100))
  const remaining = Math.max(0, threshold - current)
  const ready = current >= threshold

  if (variant === 'pill') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
          ready
            ? 'border-sage-200 bg-sage-50 text-sage-700'
            : 'border-amber-200 bg-amber-50 text-amber-800',
          className
        )}
        title={unlocks ? `Unlocks: ${unlocks}` : undefined}
      >
        {current} of {threshold} {unit}
        {!ready && remaining > 0 ? ` · ${remaining} more` : null}
      </span>
    )
  }

  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-warm-white p-4',
        className
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-sage-900">
          {current} of {threshold} {unit}
        </p>
        <p className="text-xs text-sage-500">
          {ready ? 'Ready' : `${remaining} more needed`}
        </p>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sage-100">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            ready ? 'bg-sage-500' : 'bg-amber-400'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {unlocks ? (
        <p className="mt-2 text-xs text-sage-600">
          {ready ? 'Now available: ' : 'Unlocks: '}
          <span className="text-sage-700">{unlocks}</span>
        </p>
      ) : null}
    </div>
  )
}
