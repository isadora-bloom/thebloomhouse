'use client'

/**
 * Pipeline — where every couple stands, as a board.
 *
 * W62 (wave 9). The board used to be a `supabase.from('weddings')` query
 * grouped by `weddings.status`, with its own seven column labels, its own
 * heat fetch from `wedding_heat`, and a drag that wrote `status` straight
 * from the browser. The `legacy-read-ok` tag on that query said the
 * spine's six lifecycle states could not express the thirteen-stage
 * pipeline and that W37 owned the mapping. W37 shipped it.
 *
 * So the columns are now the thirteen operator stages from
 * `client-terms`, the same words the pill uses, and a card's column is
 * derived by `deriveOperatorStage` from the couple's record and the
 * thirteen-stage machine together. The rows come from
 * /api/intel/canonical/lead-board; the triage counts and the lifecycle
 * strip come from getDailyList + getVenueOverview, unchanged.
 *
 * Dragging a card asserts a stage. That write now goes through
 * /api/agent/pipeline/stage, which records an audited transition and sets
 * the machine stage as well as the legacy status, so a move sticks
 * instead of springing back on the next load.
 */

import { useState, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useScope } from '@/lib/hooks/use-scope'
import { VenueChip } from '@/components/intel/venue-chip'
import { HeatBadge } from '@/components/intel/heat-badge'
import { RiskFlagChip, useBatchRiskFlags, type RiskSummary } from '@/components/intel/risk-flag-chip'
import { formatBloomNumber } from '@/lib/bloom-number/format'
import { formatSourceLabel } from '@/lib/utils/format-source-label'
import { LifecyclePill } from '@/components/shared/lifecycle-pill'
import type { OperatorStage } from '@/lib/services/lifecycle/vocabulary'
import { TriageRail, LifecycleStrip, useCanonicalDaily } from '../../intel/_canonical/triage-rail'
import { useLeadBoard } from '../../intel/_canonical/lead-board-data'
import {
  BOARD_STAGES,
  buildBoardColumns,
  fillMissingActivity,
  heatBucketTier,
  isBoardStage,
  isDroppableStage,
  type BoardColumn,
  type LeadCard,
} from '@/lib/intel/adapters/lead-board-view'
import {
  DndContext,
  DragOverlay,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useDroppable } from '@dnd-kit/core'
import {
  Users,
  Calendar,
  Clock,
  AlertTriangle,
  RefreshCw,
  GripVertical,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// T5-Rixey-UU Bug E: labels always come from formatSourceLabel() so a raw
// channel name never reaches a card. The value is the channel the couple
// first arrived on, from the touchpoint ribbon.
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

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '---'
  // timeZone: 'UTC' — wedding_date is a date column without timezone;
  // local-tz rendering shifts the displayed day back in ET.
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function ColumnSkeleton() {
  return (
    <div className="min-w-[280px] flex-shrink-0">
      <div className="bg-sage-50 rounded-xl p-3">
        <div className="animate-pulse mb-3">
          <div className="h-5 w-28 bg-sage-100 rounded" />
        </div>
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="bg-surface border border-border rounded-lg p-3 shadow-sm"
            >
              <div className="animate-pulse space-y-2">
                <div className="h-4 w-32 bg-sage-100 rounded" />
                <div className="h-3 w-20 bg-sage-100 rounded-full" />
                <div className="flex gap-3">
                  <div className="h-3 w-16 bg-sage-50 rounded" />
                  <div className="h-3 w-12 bg-sage-50 rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pipeline Card (static — used for both sortable wrapper and overlay)
// ---------------------------------------------------------------------------

function PipelineCardContent({
  card,
  onNameClick,
  showVenueChip,
  risk,
}: {
  card: LeadCard
  onNameClick?: () => void
  showVenueChip?: boolean
  risk?: RiskSummary | null
}) {
  const source = sourceBadge(card.sourceChannel)
  const tier = card.heatBucket ? heatBucketTier(card.heatBucket) : null

  return (
    <>
      {showVenueChip && card.venueName && (
        <div className="mb-1.5">
          <VenueChip venueName={card.venueName} />
        </div>
      )}

      {/* Couple name + heat dot + risk chip */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <GripVertical className="w-3.5 h-3.5 text-sage-300 shrink-0" />
          <h4
            className="text-sm font-medium text-sage-900 truncate hover:text-teal-600 hover:underline cursor-pointer transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              onNameClick?.()
            }}
          >
            {card.names}
          </h4>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <RiskFlagChip summary={risk} />
          {card.heatScore === null ? (
            <span className="text-[10px] text-amber-700 italic">?</span>
          ) : (
            <HeatBadge
              tier={tier}
              score={card.heatScore}
              variant="dot"
              title={card.heatWhy ?? undefined}
            />
          )}
        </div>
      </div>

      {/* Where the couple stands, in the one vocabulary (W37). The column
          already says it, so this pill earns its place when the record and
          the pipeline disagree — the dot marks exactly that. */}
      <div className="mb-2">
        <LifecyclePill stage={card.stage} size="sm" showDisagreement />
      </div>

      {/* Source badge + client code */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${source.bg} ${source.text}`}
        >
          {source.label}
        </span>
        {card.clientCode && (
          <span className="text-xs font-mono text-sage-500">
            {formatBloomNumber(card.clientCode, card.codeExtension)}
          </span>
        )}
        {card.guestCountEstimate && (
          <span className="inline-flex items-center gap-1 text-[10px] text-sage-500">
            <Users className="w-3 h-3" />
            {card.guestCountEstimate}
          </span>
        )}
      </div>

      {/* Date + days in stage. "Days in stage" is the time since the stage
          itself last moved, not since the row was last written — a bulk
          import used to reset every card to "0 days in stage". */}
      <div className="flex items-center justify-between text-[11px] text-sage-400">
        <span className="flex items-center gap-1">
          <Calendar className="w-3 h-3" />
          {formatDate(card.weddingDate)}
        </span>
        {card.daysInStage !== null && (
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {card.daysInStage}d in stage
          </span>
        )}
      </div>

      {/* Last real activity, from the couple's touchpoint ribbon. Hidden
          rather than shown as '---' when nothing is recorded yet — that is
          a data-maturity fact, not a card-layout one. */}
      {card.lastActivityAt && (
        <div className="mt-1 text-[10px] text-sage-400">
          Active {formatDate(card.lastActivityAt)}
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Sortable Card (draggable)
// ---------------------------------------------------------------------------

function SortableCard({
  card,
  showVenueChip,
  risk,
}: {
  card: LeadCard
  showVenueChip: boolean
  risk?: RiskSummary | null
}) {
  const cardRouter = useRouter()
  const href = card.weddingId
    ? `/intel/clients/${card.weddingId}`
    : `/intel/couples/${card.coupleId}`
  // A couple with no mirrored wedding has nothing for the stage write to
  // address, so it is not draggable. Better an immovable card than one
  // that appears to move and does not.
  const movable = Boolean(card.weddingId)
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.coupleId, data: { type: 'card', card }, disabled: !movable })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      title={movable ? undefined : 'This couple has no wedding record yet, so its stage cannot be set by hand.'}
      className={`bg-surface border border-border rounded-lg p-3 shadow-sm hover:shadow-md transition-shadow ${
        movable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
      }`}
    >
      <PipelineCardContent
        card={card}
        onNameClick={() => cardRouter.push(href)}
        showVenueChip={showVenueChip}
        risk={risk}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Droppable Column
// ---------------------------------------------------------------------------

function DroppableColumn({
  column,
  showVenueChip,
  riskFlags,
}: {
  column: BoardColumn
  showVenueChip: boolean
  riskFlags: Record<string, RiskSummary | null>
}) {
  const isQuiet = column.key === 'gone_quiet' || column.key === 'cancelled'
  const isWon =
    column.key === 'booked' || column.key === 'planning' || column.key === 'this_week'
  const { setNodeRef, isOver } = useDroppable({ id: column.key, disabled: !column.droppable })

  return (
    <div className="min-w-[280px] flex-shrink-0">
      <div
        ref={setNodeRef}
        className={`rounded-xl p-3 h-full transition-colors ${
          isOver && column.droppable
            ? 'bg-sage-100 ring-2 ring-sage-300'
            : isQuiet
              ? 'bg-red-50/50'
              : isWon
                ? 'bg-emerald-50 ring-1 ring-emerald-200'
                : 'bg-sage-50'
        }`}
      >
        {/* Column header */}
        <div className="flex items-center justify-between mb-3 px-1">
          <h3
            className={`text-sm font-semibold ${
              isQuiet ? 'text-red-700' : isWon ? 'text-emerald-800' : 'text-sage-800'
            }`}
          >
            {column.label}
          </h3>
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              isQuiet
                ? 'bg-red-100 text-red-600'
                : isWon
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'bg-sage-100 text-sage-600'
            }`}
          >
            {column.cards.length}
          </span>
        </div>

        {/* Cards */}
        <SortableContext
          items={column.cards.map((c) => c.coupleId)}
          strategy={verticalListSortingStrategy}
        >
          <div className="space-y-2 min-h-[60px]">
            {column.cards.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-xs text-sage-400">
                  {!column.droppable
                    ? 'Set by the record'
                    : isOver
                      ? 'Drop here'
                      : 'Nobody here'}
                </p>
              </div>
            ) : (
              column.cards.map((card) => (
                <SortableCard
                  key={card.coupleId}
                  card={card}
                  showVenueChip={showVenueChip}
                  risk={card.weddingId ? riskFlags[card.weddingId] : null}
                />
              ))
            )}
          </div>
        </SortableContext>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function PipelinePage() {
  const scope = useScope()
  const showVenueChip = scope.level !== 'venue'
  const [activeCard, setActiveCard] = useState<LeadCard | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  /** Stage the operator has just asserted, before the board reloads. Keyed
   *  by couple id. Cleared by the reload that follows the write. */
  const [pendingMoves, setPendingMoves] = useState<Record<string, OperatorStage>>({})

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
  const { lastActivityByWedding } = useCanonicalDaily()

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  )

  const boardCards = useMemo(() => {
    const filled = fillMissingActivity(cards, lastActivityByWedding)
    if (Object.keys(pendingMoves).length === 0) return filled
    // An optimistic move shows the asserted stage while the write is in
    // flight. `because` says out loud that this is the operator's word,
    // not the record's, so the card never claims evidence it lacks.
    return filled.map((c) => {
      const pending = pendingMoves[c.coupleId]
      if (!pending) return c
      return {
        ...c,
        stage: {
          ...c.stage,
          stage: pending,
          label: c.stage.label,
          because: 'You just moved this card. Saving, then re-reading the record.',
        },
      }
    })
  }, [cards, lastActivityByWedding, pendingMoves])

  const columns = useMemo(() => buildBoardColumns(boardCards), [boardCards])
  const totalLeads = boardCards.length

  // ---- Risk flags batch fetch (T5-ζ.2) ----
  const allWeddingIds = useMemo(
    () => boardCards.map((c) => c.weddingId).filter((id): id is string => Boolean(id)),
    [boardCards],
  )
  const riskFlags = useBatchRiskFlags(allWeddingIds, { venueId: scope.venueId ?? null })

  // ---- DnD handlers ----

  function handleDragStart(event: DragStartEvent) {
    const { active } = event
    const card = active.data?.current?.card as LeadCard | undefined
    if (card) setActiveCard(card)
  }

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveCard(null)
      const { active, over } = event
      if (!over) return

      const coupleId = active.id as string
      const card = boardCards.find((c) => c.coupleId === coupleId)
      if (!card || !card.weddingId) return

      // over.id is either a column key or another card's id.
      let target: OperatorStage | null = null
      if (typeof over.id === 'string' && isBoardStage(over.id)) {
        target = over.id
      } else {
        const host = columns.find((col) => col.cards.some((c) => c.coupleId === over.id))
        target = host?.key ?? null
      }
      if (!target || target === card.stage.stage) return
      if (!isDroppableStage(target)) {
        setMoveError(
          'That column is decided by the record, not by hand. Merge or reclassify the couple instead.',
        )
        return
      }

      setMoveError(null)
      setPendingMoves((prev) => ({ ...prev, [coupleId]: target }))

      try {
        const res = await fetch('/api/agent/pipeline/stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            weddingId: card.weddingId,
            venueId: card.venueId,
            stage: target,
          }),
        })
        const body = (await res.json()) as { ok?: boolean; error?: string }
        if (!res.ok || !body.ok) {
          throw new Error(body.error ?? `HTTP ${res.status}`)
        }
        if (target === 'booked') {
          fetch('/api/tracking', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'booking_closed' }),
          }).catch((trackErr) => console.warn('Booking tracking failed:', trackErr))
        }
      } catch (err) {
        setMoveError(
          `We could not save that move: ${err instanceof Error ? err.message : String(err)}`,
        )
      } finally {
        // Either way the board re-reads. A failed write must not leave the
        // card sitting somewhere nothing on file agrees with.
        setPendingMoves((prev) => {
          const next = { ...prev }
          delete next[coupleId]
          return next
        })
        reload()
      }
    },
    [boardCards, columns, reload],
  )

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Pipeline
          </h1>
          <p className="text-sage-600">
            Where every couple stands, in one set of words. A card sits in the column
            its record and your pipeline together put it in. Drag one to say otherwise,
            and click a name for the full history.
          </p>
        </div>
        <button
          onClick={reload}
          className="flex items-center gap-2 px-4 py-2.5 text-sage-700 border border-sage-300 text-sm font-medium rounded-lg hover:bg-sage-50 transition-colors shrink-0"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {/* ---- Today's list (canonical) ---- */}
      <TriageRail activeBucket="needsReply" />
      <LifecycleStrip />

      {/* ---- Heat unavailable (W17 banner) ---- */}
      {!heatAvailable && !loading && !error && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
          <p className="text-sm text-amber-800">
            We could not read the signal history, so cards are shown without an interest
            level rather than as cold.
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
          <p className="font-medium">This board is partial.</p>
          <ul className="mt-1 list-disc pl-5 space-y-0.5">
            {truncated && <li>More couples exist than one board can hold.</li>}
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- A move failed ---- */}
      {moveError && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
          <p className="text-sm text-amber-800">{moveError}</p>
          <button
            onClick={() => setMoveError(null)}
            className="ml-auto text-sm font-medium text-amber-700 hover:text-amber-900 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ---- Error ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">
            We could not load the board. The empty columns below are a failed read, not
            an empty pipeline. <span className="text-red-600">{error}</span>
          </p>
          <button
            onClick={reload}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Kanban Board ---- */}
      {loading ? (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {BOARD_STAGES.map((stage) => (
            <ColumnSkeleton key={stage} />
          ))}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4 overflow-x-auto pb-4 -mx-6 lg:-mx-8 px-6 lg:px-8">
            {columns.map((column) => (
              <DroppableColumn
                key={column.key}
                column={column}
                showVenueChip={showVenueChip}
                riskFlags={riskFlags}
              />
            ))}
          </div>

          {/* Drag overlay — a floating copy of the card */}
          <DragOverlay>
            {activeCard ? (
              <div className="bg-surface border-2 border-sage-400 rounded-lg p-3 shadow-lg w-[280px] rotate-2">
                <PipelineCardContent
                  card={activeCard}
                  showVenueChip={showVenueChip}
                  risk={activeCard.weddingId ? riskFlags[activeCard.weddingId] : null}
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {/* ---- Summary row ---- */}
      {!loading && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            {columns
              .filter((col) => col.cards.length > 0)
              .map((col) => (
                <div
                  key={col.key}
                  className="bg-surface border border-border rounded-xl p-4 shadow-sm text-center"
                >
                  <p className="text-2xl font-bold text-sage-900">{col.cards.length}</p>
                  <p className="text-xs text-sage-500 mt-0.5">{col.label}</p>
                </div>
              ))}
          </div>
          <p className="text-xs text-sage-500">
            {totalLeads} couple{totalLeads === 1 ? '' : 's'} on the board.
            {unattachedFragments !== null && unattachedFragments > 0
              ? ` ${unattachedFragments} signal${unattachedFragments === 1 ? '' : 's'} could not be matched to anyone and are not on it.`
              : ''}
          </p>
        </>
      )}
    </div>
  )
}
