/**
 * Discovery / Point zero / Known couple — the Wave 3 handle-identity
 * view. Shared by the couple page and the standalone journey page so
 * the two routes never draw this differently.
 *
 * Anchor: HANDLE-IDENTITY-SPEC.md §3 — "the ribbon reads: first seen (as
 * what, where), discovery touchpoints, point zero, then the
 * known-couple history." Everything here comes from
 * `buildJourneyPhases` (src/lib/intel/adapters/journey-phases.ts), which
 * itself only regroups what `getCoupleJourney` already returned.
 * Nothing is re-derived in this file — it renders the view-model.
 */

import { ExternalLink } from 'lucide-react'
import { approxGapPhrase, type CoupleJourney } from '@/lib/intel/canonical'
import {
  buildJourneyPhases,
  type PhaseTouchpoint,
} from '@/lib/intel/adapters/journey-phases'
import { humanActionLabel } from '@/lib/services/identity/action-labels'
import { safeHref } from '@/lib/utils/safe-url'

const DAY_MS = 86_400_000

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Wave 4 (W31): the earliest touchpoint's date can be a false-precision
 * claim — a social capture's "3w" relative age back-derives an
 * exact-looking ISO instant nobody actually observed. When its
 * precision says 'week' or 'month', show "about 3 weeks before point
 * zero" (or "ago" when point zero has not happened yet) instead of a
 * date. Every other touchpoint keeps its exact date.
 */
function touchpointDateLabel(t: PhaseTouchpoint, pointZeroAt: string | null): string {
  if (t.isFirstSeen && (t.occurredAtPrecision === 'week' || t.occurredAtPrecision === 'month')) {
    const reference = pointZeroAt ?? new Date().toISOString()
    const days = Math.floor((Date.parse(reference) - Date.parse(t.occurredAt)) / DAY_MS)
    const phrase = approxGapPhrase(days, t.occurredAtPrecision)
    if (phrase) return pointZeroAt ? `${phrase} before point zero` : `${phrase} ago`
  }
  return dayLabel(t.occurredAt)
}

function PhaseColumn({
  label,
  touchpoints,
  accent,
  emptyCopy,
  pointZeroAt,
}: {
  label: string
  touchpoints: PhaseTouchpoint[]
  accent: 'stone' | 'amber' | 'emerald'
  emptyCopy: string
  pointZeroAt: string | null
}) {
  const dot =
    accent === 'amber'
      ? 'bg-amber-500'
      : accent === 'emerald'
        ? 'bg-emerald-500'
        : 'bg-stone-400'
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-1.5">
        <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-600">
          {label}
        </h3>
        <span className="text-xs text-stone-400">({touchpoints.length})</span>
      </div>
      {touchpoints.length === 0 ? (
        <p className="text-xs text-stone-400">{emptyCopy}</p>
      ) : (
        <ul className="space-y-1">
          {touchpoints.map((t) => (
            <li key={t.id} className="flex flex-wrap items-baseline gap-1.5 text-xs">
              <span className="shrink-0 text-stone-400">{touchpointDateLabel(t, pointZeroAt)}</span>
              <span className="text-stone-700">{humanActionLabel(t.channel, t.actionType)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Everything the section needs off `getCoupleJourney`'s return — narrow
 *  on purpose so a caller can pass the hook's `journey` straight in. */
type JourneyForPhases = Pick<CoupleJourney, 'ribbon' | 'pointZeroAt' | 'discovery' | 'handles'>

export function JourneyPhasesSection({ journey }: { journey: JourneyForPhases | null }) {
  if (!journey) return null
  const phases = buildJourneyPhases(journey)

  return (
    <div className="mb-6 rounded-lg border border-stone-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-700">
            How they found us
          </h2>
          <p className="mt-1 text-sm text-stone-700">{phases.discoverySummary}</p>
          {phases.discoveryGapPhrase && (
            <p className="mt-0.5 text-xs font-medium text-emerald-700">
              {phases.discoveryGapPhrase}
            </p>
          )}
        </div>
        {phases.chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {phases.chips.map((chip) =>
              chip.url ? (
                <a
                  key={chip.platform}
                  href={safeHref(chip.url)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-xs text-violet-800 hover:border-violet-300 hover:bg-violet-100"
                >
                  @{chip.handle}
                  <span className="text-violet-500">· {chip.platform}</span>
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              ) : (
                <span
                  key={chip.platform}
                  className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-xs text-violet-800"
                >
                  @{chip.handle} · {chip.platform}
                </span>
              ),
            )}
          </div>
        )}
      </div>

      <div className="grid gap-4 border-t border-stone-100 pt-3 sm:grid-cols-3">
        <PhaseColumn
          label={phases.labels.discovery}
          touchpoints={phases.discovery}
          accent="stone"
          emptyCopy="Nothing before point zero."
          pointZeroAt={journey.pointZeroAt}
        />
        <PhaseColumn
          label={phases.labels.pointZero}
          touchpoints={phases.pointZero ? [phases.pointZero] : []}
          accent="amber"
          emptyCopy="Not reached yet."
          pointZeroAt={journey.pointZeroAt}
        />
        <PhaseColumn
          label={phases.labels.knownCouple}
          touchpoints={phases.knownCouple}
          accent="emerald"
          emptyCopy="Nothing since point zero."
          pointZeroAt={journey.pointZeroAt}
        />
      </div>
    </div>
  )
}
