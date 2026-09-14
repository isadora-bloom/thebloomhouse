'use client'

/**
 * Lead scoring — every couple still in play, hottest first.
 *
 * W62 (wave 9). This page used to open with `supabase.from('weddings')`
 * in the browser, join `people` for the names and fetch `wedding_heat`
 * for a temperature. The `legacy-read-ok` tag on that query said the
 * spine's six lifecycle states could not express the thirteen-stage
 * pipeline and that W37 owned the mapping. W37 shipped it, so the tag is
 * gone and so is the query.
 *
 * Everything on this page now comes from two canonical calls:
 *   - /api/intel/canonical/lead-board  (couples, touchpoints,
 *     progression events, fragments) via `useLeadBoard`, with the stage
 *     derived by `deriveOperatorStage` and the heat by `buildHeatWhy`;
 *   - /api/intel/canonical/daily-list  behind the TriageRail, unchanged.
 *
 * Nothing here decides what a number means. The filters, the sort, the
 * distribution and the stage all run through the pure adapter at
 * `src/lib/intel/adapters/lead-board-view.ts`, which /agent/pipeline runs
 * too, so the two pages cannot disagree about one couple.
 */

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useScope } from '@/lib/hooks/use-scope'
import { VenueChip } from '@/components/intel/venue-chip'
import { HeatBadge } from '@/components/intel/heat-badge'
import { RiskFlagChip, useBatchRiskFlags } from '@/components/intel/risk-flag-chip'
import {
  AutoContextChipRender,
  useBatchAutoContextChips,
} from '@/components/intel/auto-context-chip'
import { SoloPill, useBatchPartnerCounts } from '@/components/intel/solo-pill'
import { EssentialsSlider } from '@/components/shell/essentials-slider'
import { LifecyclePill } from '@/components/shared/lifecycle-pill'
import { TriageRail, useCanonicalDaily } from '../../intel/_canonical/triage-rail'
import { useLeadBoard } from '../../intel/_canonical/lead-board-data'
import {
  HEAT_BUCKETS,
  fillMissingActivity,
  filterLeadCards,
  heatBucketTier,
  heatDistribution,
  selectLeadList,
  sortLeadCards,
  type LeadCard,
  type LeadSortField,
  type SortDirection,
} from '@/lib/intel/adapters/lead-board-view'
import { styleForTier } from '@/lib/heat/tier-colors'
import { heatLabel, type HeatBucket } from '@/lib/services/identity/heat-score'
import { formatBloomNumber } from '@/lib/bloom-number/format'
import { formatSourceLabel } from '@/lib/utils/format-source-label'
import {
  Flame,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
  Search,
  Upload,
} from 'lucide-react'
import type { ImportWarning } from '@/lib/intel/readers/lead-board'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BucketFilter = HeatBucket | 'all'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The filter row. Four buckets, from `heatBucket()` on the spine — not
 *  the legacy view's five tiers, which were a different scale. */
const BUCKET_FILTERS: { key: BucketFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  ...HEAT_BUCKETS.map((b) => ({ key: b as BucketFilter, label: heatLabel(b) })),
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '---'
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// T5-Rixey-UU Bug E: source pill colours stay per-source for visual
// scanability, but the LABEL always comes from formatSourceLabel() so
// we never leak a raw channel name ('the_knot', 'weddingwire') into the
// table cell. The value itself is now the channel the couple first
// arrived on, from the touchpoint ribbon, rather than the hand-set
// `weddings.source` column that nobody reliably filled in.
function sourceBadge(source: string | null): { bg: string; text: string; label: string } {
  const label = formatSourceLabel(source)
  switch (source) {
    case 'the_knot':
    case 'knot':
      return { bg: 'bg-rose-50', text: 'text-rose-700', label }
    case 'wedding_wire':
    case 'weddingwire':
      return { bg: 'bg-purple-50', text: 'text-purple-700', label }
    case 'google':
    case 'google_business':
    case 'google_ads':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label }
    case 'instagram':
      return { bg: 'bg-pink-50', text: 'text-pink-700', label }
    case 'pinterest':
      return { bg: 'bg-rose-50', text: 'text-rose-700', label }
    case 'facebook':
      return { bg: 'bg-indigo-50', text: 'text-indigo-700', label }
    case 'referral':
    case 'word_of_mouth':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', label }
    case 'website':
    case 'web_form':
    case 'web':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label }
    case 'venue_calculator':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label }
    case 'here_comes_the_guide':
      return { bg: 'bg-violet-50', text: 'text-violet-700', label }
    case 'walk_in':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label }
    case 'direct':
      return { bg: 'bg-slate-50', text: 'text-slate-700', label }
    case 'gmail':
    case 'calendly':
    case 'acuity':
    case 'honeybook':
    case 'dubsado':
      return { bg: 'bg-cyan-50', text: 'text-cyan-700', label }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label }
  }
}

// T5-Rixey-UU Bug G: rows whose import warnings include an unresolved
// couple_name issue get a 'needs review' chip.
function hasCoupleNameWarning(warnings: ImportWarning[] | null | undefined): boolean {
  if (!warnings || !Array.isArray(warnings)) return false
  return warnings.some(
    (w) => w?.field === 'couple_name' && typeof w.issue === 'string' && w.issue.length > 0
  )
}

// ---------------------------------------------------------------------------
// Confidence flag chip (T5-γ.1)
// ---------------------------------------------------------------------------

function confidenceFlagBadge(flag: string): { bg: string; text: string; label: string; title: string } | null {
  switch (flag) {
    case 'imported_high':
      return {
        bg: 'bg-blue-50',
        text: 'text-blue-700',
        label: 'CRM',
        title: 'Imported with full identity from a CRM export.',
      }
    case 'imported_medium':
      return {
        bg: 'bg-blue-50',
        text: 'text-blue-700',
        label: 'CRM',
        title: 'Imported with partial identity from a CRM export.',
      }
    case 'imported_low':
      return {
        bg: 'bg-amber-50',
        text: 'text-amber-700',
        label: 'Imported',
        title: 'Reconstructed from your Gmail history. Some fields are best-guesses rather than live-confirmed.',
      }
    case 'manual':
      return {
        bg: 'bg-sage-50',
        text: 'text-sage-700',
        label: 'Manual',
        title: 'Coordinator hand-entry. Not pipeline-ingested.',
      }
    default:
      return null
  }
}

function ConfidenceFlagChip({ flag }: { flag: string }) {
  const meta = confidenceFlagBadge(flag)
  if (!meta) return null
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${meta.bg} ${meta.text}`}
      title={meta.title}
    >
      {meta.label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function TableSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="divide-y divide-border">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="p-4">
            <div className="animate-pulse flex items-center gap-4">
              <div className="h-4 w-40 bg-sage-100 rounded" />
              <div className="h-4 w-16 bg-sage-100 rounded-full" />
              <div className="h-4 w-12 bg-sage-100 rounded" />
              <div className="h-4 w-20 bg-sage-100 rounded-full" />
              <div className="h-4 w-24 bg-sage-50 rounded" />
              <div className="h-4 w-10 bg-sage-50 rounded" />
              <div className="h-4 w-20 bg-sage-50 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function BarSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse">
        <div className="h-4 w-40 bg-sage-100 rounded mb-4" />
        <div className="h-8 w-full bg-sage-100 rounded-full" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Heat Distribution Bar
// ---------------------------------------------------------------------------

function HeatDistributionBar({ cards }: { cards: LeadCard[] }) {
  const counts = useMemo(() => heatDistribution(cards), [cards])
  const total = cards.length || 1

  const segments = [
    ...HEAT_BUCKETS.map((b) => ({
      key: b as string,
      color: styleForTier(heatBucketTier(b)).color,
      count: counts[b],
    })),
    // Unknown is its own segment. Folding it into the coldest bucket is
    // how a failed read used to read as a confident wall of cold leads.
    { key: 'unknown', color: '#D1D5DB', count: counts.unknown },
  ].filter((s) => s.count > 0)

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <h2 className="font-heading text-base font-semibold text-sage-900 mb-4">
        Heat Distribution
      </h2>

      <div className="h-8 rounded-full overflow-hidden flex bg-sage-100">
        {segments.map((seg) => (
          <div
            key={seg.key}
            className="h-full flex items-center justify-center transition-all"
            style={{
              width: `${(seg.count / total) * 100}%`,
              backgroundColor: seg.color,
              minWidth: seg.count > 0 ? '24px' : '0',
            }}
          >
            {seg.count > 0 && (
              <span className="text-xs font-bold text-white drop-shadow-sm">
                {seg.count}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-4 mt-3 flex-wrap">
        {HEAT_BUCKETS.map((b) => (
          <div key={b} className="flex items-center gap-1.5">
            <span
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: styleForTier(heatBucketTier(b)).color }}
            />
            <span className="text-xs text-sage-600">
              {heatLabel(b)}{' '}
              <span className="font-medium text-sage-800">({counts[b]})</span>
            </span>
          </div>
        ))}
        {counts.unknown > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: '#D1D5DB' }} />
            <span className="text-xs text-sage-600">
              Unknown{' '}
              <span className="font-medium text-sage-800">({counts.unknown})</span>
            </span>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-sage-500">
        Interest is the time-decayed sum of every real signal from a couple, on a
        fortnightly half-life. Four levels, from the same rule the rest of the app uses.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sortable Table Header
// ---------------------------------------------------------------------------

function SortHeader({
  label,
  field,
  currentField,
  currentDir,
  onSort,
}: {
  label: string
  field: LeadSortField
  currentField: LeadSortField
  currentDir: SortDirection
  onSort: (field: LeadSortField) => void
}) {
  const isActive = field === currentField

  return (
    <button
      onClick={() => onSort(field)}
      className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-sage-500 hover:text-sage-700 transition-colors"
    >
      {label}
      {isActive ? (
        currentDir === 'desc' ? (
          <ArrowDown className="w-3 h-3" />
        ) : (
          <ArrowUp className="w-3 h-3" />
        )
      ) : (
        <ArrowUpDown className="w-3 h-3 opacity-40" />
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function LeadsPage() {
  const router = useRouter()
  const scope = useScope()
  const showVenueChip = scope.level !== 'venue'
  const [bucketFilter, setBucketFilter] = useState<BucketFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortField, setSortField] = useState<LeadSortField>('heat')
  const [sortDir, setSortDir] = useState<SortDirection>('desc')

  const {
    cards,
    loading,
    error,
    heatAvailable,
    unattachedFragments,
    truncated,
    warnings,
    reload,
  } = useLeadBoard()

  // The daily-list call the TriageRail already makes. Used here only as
  // the fallback for last-activity when the ribbon read is degraded.
  const { lastActivityByWedding } = useCanonicalDaily()

  // ---- The list: couples still in play ----
  const leadCards = useMemo(
    () => fillMissingActivity(selectLeadList(cards), lastActivityByWedding),
    [cards, lastActivityByWedding],
  )

  const handleSort = (field: LeadSortField) => {
    if (field === sortField) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  const visibleCards = useMemo(() => {
    const filtered = filterLeadCards(leadCards, {
      bucket: bucketFilter === 'all' ? null : bucketFilter,
      query: searchQuery,
    })
    return sortLeadCards(filtered, sortField, sortDir)
  }, [leadCards, bucketFilter, searchQuery, sortField, sortDir])

  const bucketCounts = useMemo(() => heatDistribution(leadCards), [leadCards])

  // ---- Batched chips ----
  // These three hooks are wedding-keyed. A couple minted from a fragment
  // has no wedding to key on, so it is left out rather than fetched under
  // a made-up id.
  const allWeddingIds = useMemo(
    () => leadCards.map((c) => c.weddingId).filter((id): id is string => Boolean(id)),
    [leadCards],
  )
  const riskFlags = useBatchRiskFlags(allWeddingIds, { venueId: scope.venueId ?? null })
  const autoContextChips = useBatchAutoContextChips(allWeddingIds, {
    venueId: scope.venueId ?? null,
  })
  const partnerCounts = useBatchPartnerCounts(allWeddingIds, {
    venueId: scope.venueId ?? null,
  })

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Lead Scoring
          </h1>
          <p className="text-sage-600">
            Every couple still in play, ranked by how much real interest they have
            shown. Click a row for their full history.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {/* W42: a coordinator back from the weekend with a Knot or
              HoneyBook export had no way in from this page. */}
          <Link
            href="/admin/imports/upload"
            className="inline-flex items-center gap-1.5 text-sm text-sage-600 hover:text-sage-900"
          >
            <Upload className="w-4 h-4" aria-hidden />
            Import a file
          </Link>
          <EssentialsSlider surface="/agent/leads" />
        </div>
      </div>

      {/* ---- Error ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">
            We could not load your leads. Nothing below is a count of anything.{' '}
            <span className="text-red-600">{error}</span>
          </p>
          <button
            onClick={reload}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Heat unavailable (W17 banner) ----
           The touchpoint ribbon failed to load for this batch. Interest
           is unknown, not zero, and every "unknown" row below is a lead
           whose real interest we could not read, not a cold one. */}
      {!heatAvailable && !loading && !error && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
          <p className="text-sm text-amber-800">
            We could not read the signal history for this list, so interest levels below
            are unknown rather than zero.
          </p>
          <button
            onClick={reload}
            className="ml-auto text-sm font-medium text-amber-700 hover:text-amber-900 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Partial reads ---- */}
      {!loading && !error && (truncated || warnings.length > 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          <p className="font-medium">This list is partial.</p>
          <ul className="mt-1 list-disc pl-5 space-y-0.5">
            {truncated && <li>More couples exist than one board can hold.</li>}
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- Today's list (canonical) ---- */}
      <TriageRail activeBucket="highIntent" />

      {/* ---- Heat Distribution Bar ---- */}
      {loading ? (
        <BarSkeleton />
      ) : leadCards.length > 0 ? (
        <HeatDistributionBar cards={leadCards} />
      ) : null}

      {/* ---- Filters ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1">
          {BUCKET_FILTERS.map((bucket) => {
            const style =
              bucket.key !== 'all' ? styleForTier(heatBucketTier(bucket.key)) : null
            return (
              <button
                key={bucket.key}
                onClick={() => setBucketFilter(bucket.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  bucketFilter === bucket.key
                    ? 'bg-surface text-sage-900 shadow-sm'
                    : 'text-sage-600 hover:text-sage-800'
                }`}
              >
                {style && (
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: style.color }}
                  />
                )}
                {bucket.label}
                {bucket.key !== 'all' && (
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded-full ${
                      bucketFilter === bucket.key
                        ? 'bg-sage-100 text-sage-700'
                        : 'bg-sage-100/50 text-sage-500'
                    }`}
                  >
                    {bucketCounts[bucket.key as HeatBucket] ?? 0}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div className="relative sm:ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
          <input
            type="text"
            placeholder="Search leads..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full sm:w-64 bg-warm-white"
          />
        </div>
      </div>

      {/* ---- Leads Table ---- */}
      {loading ? (
        <TableSkeleton />
      ) : visibleCards.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Flame className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            {error
              ? 'Nothing to show while the read is failing'
              : searchQuery
                ? 'No matching leads'
                : bucketFilter !== 'all'
                  ? `Nothing at ${heatLabel(bucketFilter as HeatBucket).toLowerCase()}`
                  : 'No couples in play yet'}
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            {error
              ? 'This is an empty screen because the read failed, not because you have no leads.'
              : searchQuery
                ? `No leads match "${searchQuery}".`
                : 'Interest levels are built from real signals as they arrive. Until a couple does something, there is nothing here to rank.'}
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-[640px] w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Couple
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      First seen on
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <SortHeader
                      label="Interest"
                      field="heat"
                      currentField={sortField}
                      currentDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Level
                    </span>
                  </th>
                  <th className="text-left px-4 py-3">
                    <SortHeader
                      label="Last Activity"
                      field="last_activity"
                      currentField={sortField}
                      currentDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="text-left px-4 py-3">
                    <SortHeader
                      label="Days Known"
                      field="first_seen"
                      currentField={sortField}
                      currentDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="text-left px-4 py-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">
                      Stage
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleCards.map((card) => {
                  const source = sourceBadge(card.sourceChannel)
                  const tier = card.heatBucket ? heatBucketTier(card.heatBucket) : null
                  const href = card.weddingId
                    ? `/intel/clients/${card.weddingId}`
                    : `/intel/couples/${card.coupleId}`

                  return (
                    <tr
                      key={card.coupleId}
                      onClick={() => router.push(href)}
                      className="hover:bg-sage-50/50 cursor-pointer transition-colors"
                    >
                      {/* Couple */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-sage-900 hover:text-sage-700 underline-offset-2 hover:underline">
                            {card.names}
                          </span>
                          {card.clientCode && (
                            <span className="text-xs font-mono text-sage-500">
                              {formatBloomNumber(card.clientCode, card.codeExtension)}
                            </span>
                          )}
                          {card.confidenceFlag && card.confidenceFlag !== 'live' && (
                            <ConfidenceFlagChip flag={card.confidenceFlag} />
                          )}
                          {showVenueChip && <VenueChip venueName={card.venueName} />}
                          {card.weddingId && (
                            <>
                              <RiskFlagChip summary={riskFlags[card.weddingId]} />
                              <AutoContextChipRender
                                chip={autoContextChips[card.weddingId]}
                              />
                              <SoloPill
                                partnerCount={partnerCounts[card.weddingId] ?? null}
                              />
                            </>
                          )}
                          {hasCoupleNameWarning(card.importWarnings) && (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700"
                              title="Imported couple-name couldn't be confidently parsed — needs review."
                            >
                              needs review
                            </span>
                          )}
                        </div>
                      </td>

                      {/* First seen on — the channel the first real signal
                          arrived through, not a hand-set source column. */}
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${source.bg} ${source.text}`}
                        >
                          {source.label}
                        </span>
                      </td>

                      {/* Interest. Null means the ribbon read failed for
                          this batch — say so, don't draw a confident badge
                          on a default. */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {card.heatScore === null ? (
                            <span className="text-xs text-amber-700 italic">Unknown</span>
                          ) : (
                            <HeatBadge
                              tier={tier}
                              score={card.heatScore}
                              variant="pill"
                              title={card.heatWhy ?? undefined}
                            />
                          )}
                        </div>
                      </td>

                      {/* Level */}
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          {card.heatScore === null ? (
                            <span className="text-xs text-amber-700 italic">Unknown</span>
                          ) : (
                            <>
                              <HeatBadge tier={tier} score={card.heatScore} variant="dot" />
                              <span className="text-sm text-sage-700">
                                {card.heatLabel}
                              </span>
                            </>
                          )}
                        </div>
                      </td>

                      {/* Last Activity — newest touchpoint on the couple's
                          ribbon. '---' means nothing has been recorded,
                          which is a fact rather than a layout problem. */}
                      <td className="px-4 py-3">
                        <span className="text-sm text-sage-600">
                          {formatDate(card.lastActivityAt)}
                        </span>
                      </td>

                      {/* Days Known — since the first signal of any kind. */}
                      <td className="px-4 py-3">
                        <span className="text-sm text-sage-600 tabular-nums">
                          {card.daysSinceFirstSeen === null
                            ? '---'
                            : `${card.daysSinceFirstSeen}d`}
                        </span>
                      </td>

                      {/* Stage — the one pill. */}
                      <td className="px-4 py-3">
                        <LifecyclePill stage={card.stage} size="sm" showDisagreement />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---- What is not on this list ----
           Fragments are signals that never attached to anybody. Saying
           the number out loud is the difference between "these are your
           leads" and "these are the leads we could identify". */}
      {!loading && !error && unattachedFragments !== null && unattachedFragments > 0 && (
        <p className="text-xs text-sage-500">
          {unattachedFragments} signal{unattachedFragments === 1 ? '' : 's'} could not be
          matched to anyone and are not counted above.
        </p>
      )}
    </div>
  )
}
