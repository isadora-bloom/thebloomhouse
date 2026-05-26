/**
 * /system/consolidation-status — operator-trust surface for the
 * Phase 1 consolidation rollout.
 *
 * Anchor: PHASE-1-BATCH-2.md §7 "Operator-facing additions" item 2.
 * Pressure-test client-lens finding: during the 2-3 week phase A→B→C
 * window every weird number on /intel looks like a real bug; this
 * page is the artefact-vs-regression discriminator.
 *
 * INTENTIONALLY SERVER-RENDERED + STATIC. The content is the rollout
 * state as of the commit listed at the top — it does not poll a DB
 * or recompute "are we done yet" live, because what we'd query
 * (count of cascade routes per channel) is not the question the
 * operator is asking. The question is "what landed and what didn't,
 * per my last conversation with Ismar/Claude" — that question is
 * answered by the prose. When the prose drifts from reality, the
 * prose needs editing, not the query.
 *
 * Maintenance burden: this page + CHANGELOG.md are a snapshot. When
 * a new batch/phase ships, BOTH need an entry. Treat as a release
 * note, not a dashboard. See CHANGELOG.md header comment.
 *
 * Multi-venue safety: nothing here is venue-scoped. The state of
 * the consolidation is the same for every venue on the deploy. Any
 * venue-specific commentary lives in CHANGELOG.md, not on this page.
 */

import Link from 'next/link'
import { CheckCircle2, Clock, AlertTriangle, GitBranch, FileText } from 'lucide-react'

// ---------------------------------------------------------------------------
// Snapshot data — edit this block (and CHANGELOG.md) when a new phase ships.
// ---------------------------------------------------------------------------

const SNAPSHOT_AS_OF = '2026-05-26'

// Captured at edit time. Resist the urge to wire this to a build env
// var — the value is meaningful as the commit the prose below was
// reviewed against, not as the actual deployed HEAD. (Production runs
// from `master`; this snapshot reflects the `consolidation` branch.)
const SNAPSHOT_GIT_COMMIT = '7d68f37'
const SNAPSHOT_GIT_BRANCH = 'consolidation'
const SNAPSHOT_DEPLOY_REALITY =
  'Production currently runs from `master`. Batch 1 + Batch 2 (20+ commits) sit on the `consolidation` branch unmerged. The status below reflects the branch, not what end-users see today.'

type ChannelState = 'shipped' | 'deferred' | 'pending' | 'na'

interface ChannelRow {
  channel: string
  state: ChannelState
  sites: string
  detail: string
}

const CHANNELS: ChannelRow[] = [
  {
    channel: 'Gmail (email pipeline)',
    state: 'shipped',
    sites: 'Batch 1 — M1, M2, M3, M4, M5, M6, M7, M8, M9, M10',
    detail:
      'All 9 enumerated MIGRATE sites + the M10 autonomous-send writer (discovered during pressure-test) are dual-writing through the cascade. M1/M8 verified via consistency audit. Partner2 dedup (Liam Hunt class) closed by P2 + migration 367 unique index.',
  },
  {
    channel: 'HoneyBook CSV import',
    state: 'shipped',
    sites: 'Batch 2 phase A — H1, H2, H3 (H4 deferred)',
    detail:
      'Partner1, partner2, and per-row interactions now route through mintPerson/linkSignalBatch. H4 (booked-data-recovery merged_into_id UPDATE) deferred until mergeWeddings itself routes through the cascade — sequencing H4 ahead of that compounds the hand-list-drift footgun.',
  },
  {
    channel: 'Calendly webhook',
    state: 'shipped',
    sites: 'Batch 2 phase B — C3, C11, C12 (C1 stays as event entity)',
    detail:
      'tour_booked already routed (C3) — promoted to load-bearing via the calendly-to-signal builder. tour_cancelled (C11) + tour_attended (C12) chokepoint violations CLOSED — direct touchpoints.upsert replaced with linkSignal / linkSignalBatch. C1 (tours table insert) stays as the operator-UI event mirror per plan §1.4.',
  },
  {
    channel: 'Twilio SMS webhook',
    state: 'shipped',
    sites: 'Batch 2 phase C — T2',
    detail:
      'Inbound SMS dual-writes via sms-to-signal.ts. T6 (mintWedding path) exempted per Batch-1 §5 — mintWedding is already the chokepoint.',
  },
  {
    channel: 'OpenPhone (SMS + voice + voicemail)',
    state: 'shipped',
    sites: 'Batch 2 phase C — O4, O7',
    detail:
      'Primary interactions (O4) + the body-extracted-email follow-up signal (O7) dual-write through the cascade. O6 (mintWedding) exempted per Batch-1 §5.',
  },
  {
    channel: 'Zoom meetings',
    state: 'shipped',
    sites: 'Batch 2 phase C — Z5, Z6',
    detail:
      'Transcript writes + per-extracted-identifier follow-up signals routed through zoom-to-signal.ts. Channel renamed `meeting` → `zoom` (Pbatch2-5) to avoid Tracer-filter collision.',
  },
  {
    channel: 'Cross-channel referrals',
    state: 'shipped',
    sites: 'Batch 2 — I1',
    detail:
      'intel/referrals/resolve.ts attribution_events writer routes through linkSignal({action_type: "referral_self_report"}).',
  },
]

interface OperatorAction {
  text: string
  detail?: string
}

const OPERATOR_ACTIONS: OperatorAction[] = [
  {
    text: 'Apply migration 366 to consolidation branch `ciwqxwohczzthvzqqgjx`.',
    detail:
      'Branch is missing the CHECK extension that admits `couple_minted`. Re-paste mig 366 SQL via branch dashboard.',
  },
  {
    text: 'Apply migration 367 (partner2 unique index) + migration 368 (event_type CHECK) to whichever DBs the M9/M4/M5 code lands on.',
    detail:
      '15 partner-role dup groups already resolved on prod 2026-05-26; 367 should now apply clean. 368 fail-safe verified — misordered deploy degrades to "no progression row" not a crash.',
  },
  {
    text: 'Apply migration 372 (`progression_event_batch2_channels`) — 6 net-new event_types for honeybook / sms / phone / voicemail / zoom.',
    detail: 'Operator applies via branch / prod dashboard.',
  },
  {
    text: 'Run `/api/agent/reprocess-form-relays` against historical `interactions WHERE from_email="weddingvendors@zola.com" AND direction="inbound"`.',
    detail:
      'Splits ~306 ghost-person interactions onto per-prospect couples. Recovers the ~73 lost-leads-in-12-days surfaced by the deep pressure-test.',
  },
  {
    text: 'Run `scripts/backfill-autosend-interactions.ts --apply` against prod when desired.',
    detail:
      'Dry-run on the branch found 0 rows (autosend flush hasn\'t fired since the May-14 wipe). Pre-existing bug fixed in C3 of pressure-test 2 — historical autonomous sends are otherwise invisible to follow-up-sequences / signal-inference / voice-dna.',
  },
  {
    text: 'Renumber operator\'s uncommitted `372_section_finalisations_unique.sql` → 374+ to resolve collision with `372_progression_event_batch2_channels.sql`.',
  },
  {
    text: 'Review JC Matos / Jancarlo Matos cross-role merge from the dup-resolution (group 4 of `a5777ff`).',
    detail:
      'Likely the same human as partner1 Jancarlo Matos; was merged into partner2 Stephanie Lopez to satisfy the index. Applied on both branch and prod.',
  },
  {
    text: 'Re-run the battery against whichever DB the migrations landed on.',
    detail:
      '`run-battery.ts` reads `.env.local` → prod. Any post-366/367/368/372 battery run must point at the DB the migrations were applied to or it measures the wrong substrate.',
  },
]

interface OpenGap {
  title: string
  body: string
  severity: 'critical' | 'high' | 'medium'
}

const OPEN_GAPS: OpenGap[] = [
  {
    title: 'Lifecycle helper schema mismatch (pre-existing)',
    severity: 'critical',
    body:
      '`recordSmsLifecycleSignal` (state-machine.ts:985) + `recordZoomLifecycleSignal` (:1052) write `kind`/`direction`/`evidence`/`occurred_at`, but `wedding_lifecycle_events` per mig 246 wants `signal`/`status_from`/`status_to`/`reason`/`detected_by`. 100% silent 4xx since the helpers were written. Pbatch2-8\'s uniform lifecycle dispatch is hollow on the audit-row axis until this is fixed. Operator-visible: zero `sms_received` / `zoom_meeting_transcript_received` rows in `wedding_lifecycle_events`. Batch 2 amplified the surface but did not introduce the defect.',
  },
  {
    title: '`source_wedding_id` bridge backfill',
    severity: 'critical',
    body:
      '47% of `status="booked"` weddings on prod have NO corresponding `couples` row via the `source_wedding_id` bridge. 100% of `status="completed"` (65 rows) and `"contracted"` (2 rows) are missing too. `mirrorCoupleFromWedding` needs a status-transition hook + a sweeper. Until fixed, any cohort metric keyed on couples will undercount booked.',
  },
  {
    title: '5 Batch-2 verification scripts unwritten',
    severity: 'high',
    body:
      'Per the Batch-2 done-definition: `verify-calendly-binding.ts`, `verify-honeybook-attribution.ts`, `verify-sms-binding.ts`, `verify-zoom-binding.ts`, `verify-c11-c12-cutover.ts` — none written. The dual-write site-flips are typecheck + guards + logic-trace verified but the M1/M8-style consistency-audit gate is not met. Done-definition unmet.',
  },
  {
    title: 'Cohort divergence on "booked couples"',
    severity: 'high',
    body:
      'Branch 26 vs prod 86 vs weddings 66/67. The May-21 numbers-disease is alive — `couples.lifecycle_state` is unreliable as a metric source until the consolidation finishes (Phase 3 reader migration) AND the source_wedding_id backfill above lands.',
  },
  {
    title: 'action_type vocabulary leak in operator surfaces',
    severity: 'medium',
    body:
      '`JourneyRibbon.tsx:130`, `intel/couples/[id]:148`, `identity-review-queue-tab.tsx:177` render raw enum strings (e.g. `inbound_human_request`, `tour_cancelled`) as tooltips. Cosmetic but breaks the operator-vocabulary boundary the CI guard `check:operator-vocab` is supposed to keep clean.',
  },
  {
    title: 'Tier-4 confabulations (Q17/Q20/Q21) NOT moved by Batch 2',
    severity: 'medium',
    body:
      'These battery items don\'t move until Phase 3.2 / 3.3 (reader migration). Q33 cross-surface contradiction lands at end of Phase 3. Listed here so the operator does not expect Tier-4 to improve from Batch 2 alone.',
  },
  {
    title: 'No deploy to prod yet',
    severity: 'high',
    body:
      'Batch 1 + Batch 2 (20+ commits) remain on `consolidation`; `master` runs prod. All "shipped" language above is repo-true but production-dormant. The cohort numbers on /intel today reflect master, not the cascade. This is the single biggest reason this page can mislead — re-read the banner at the top.',
  },
]

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function StateIcon({ state }: { state: ChannelState }) {
  switch (state) {
    case 'shipped':
      return <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" aria-label="Shipped on branch" />
    case 'deferred':
      return <Clock className="h-4 w-4 text-amber-600 shrink-0" aria-label="Deferred" />
    case 'pending':
      return <Clock className="h-4 w-4 text-sage-500 shrink-0" aria-label="Pending" />
    case 'na':
      return <span className="text-sage-400 text-sm shrink-0" aria-label="Not applicable">—</span>
  }
}

function stateLabel(state: ChannelState): string {
  switch (state) {
    case 'shipped':
      return 'Shipped on branch'
    case 'deferred':
      return 'Deferred'
    case 'pending':
      return 'Pending'
    case 'na':
      return 'N/A'
  }
}

function severityChip(sev: OpenGap['severity']) {
  switch (sev) {
    case 'critical':
      return { bg: 'bg-rose-100', text: 'text-rose-700', label: 'Critical' }
    case 'high':
      return { bg: 'bg-amber-100', text: 'text-amber-700', label: 'High' }
    case 'medium':
      return { bg: 'bg-sage-100', text: 'text-sage-700', label: 'Medium' }
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export const dynamic = 'force-static'

export default function ConsolidationStatusPage() {
  return (
    <div className="space-y-8 max-w-4xl">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-2">
          Bloom consolidation status
        </h1>
        <p className="text-sage-600">
          As of <strong>{SNAPSHOT_AS_OF}</strong> · branch <code className="text-xs bg-sage-100 px-1.5 py-0.5 rounded">{SNAPSHOT_GIT_BRANCH}</code>{' '}
          @ <code className="text-xs bg-sage-100 px-1.5 py-0.5 rounded">{SNAPSHOT_GIT_COMMIT}</code>
        </p>
      </div>

      {/* Deploy-reality banner — the single most important caveat. */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" aria-hidden />
        <div className="flex-1 text-sm text-amber-900">
          <p className="font-medium mb-1">These changes are not in production yet.</p>
          <p>{SNAPSHOT_DEPLOY_REALITY}</p>
        </div>
      </div>

      {/* Section 1: channels migrated */}
      <section>
        <h2 className="font-heading text-xl font-semibold text-sage-900 mb-3 flex items-center gap-2">
          <GitBranch className="h-5 w-5 text-sage-500" />
          Channels migrated
        </h2>
        <p className="text-sm text-sage-600 mb-4">
          Each channel below dual-writes through the identity cascade (couples / touchpoints) alongside the legacy
          interactions / people / weddings writes. Legacy stays as source of truth until Phase 4.
        </p>
        <div className="bg-surface border border-border rounded-xl shadow-sm divide-y divide-border">
          {CHANNELS.map((row) => (
            <div key={row.channel} className="p-4 flex items-start gap-3">
              <StateIcon state={row.state} />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <h3 className="text-sm font-semibold text-sage-900">{row.channel}</h3>
                  <span className="text-xs text-sage-500 shrink-0">{stateLabel(row.state)}</span>
                </div>
                <p className="text-xs text-sage-500 mb-1">{row.sites}</p>
                <p className="text-sm text-sage-700">{row.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Section 2: what changes for you */}
      <section>
        <h2 className="font-heading text-xl font-semibold text-sage-900 mb-3">
          What changes for you
        </h2>
        <div className="bg-surface border border-border rounded-xl shadow-sm p-5 space-y-3 text-sm text-sage-800">
          <p>
            <strong>Tier-4 confabulations don&apos;t move.</strong> Battery items Q17, Q20, Q21 are not improved by
            Batch 2. They land in Phase 3.2 / 3.3 (reader migration). If those answers still hedge poorly, it is not a
            regression — it is unfinished work.
          </p>
          <p>
            <strong>Cohort numbers on /intel may wobble.</strong> During the 2-3 week phase A → B → C window,
            channels migrate at different times. Expect transient delta between the same metric viewed at different
            framings. The numbers will reconverge once Phase 3 readers move to the spine.
          </p>
          <p>
            <strong>Tour-cancelled and tour-attended Calendly signals get rewired.</strong> Watch the cohort funnel
            for the first 48 hours after the Calendly cutover. The verify-c11-c12-cutover script is supposed to alert
            if the cancellation rate diverges &gt; 30% from the prior 14-day baseline — script not yet written, so do
            this spot-check manually.
          </p>
          <p>
            <strong>HoneyBook re-imports deduplicate going forward.</strong> Liam-Hunt-class partner2 duplicates from
            recurring CSV uploads are closed by construction (P2 enrich-or-skip + migration 367 unique index). Historical
            duplicate-partner-two rows are NOT cleaned by this — that is Phase 2&apos;s wipe-and-reimport.
          </p>
          <p>
            <strong>Zola subdomain bug fix.</strong> The ~73 lost-leads-in-12-days surfaced by the deep pressure-test
            are recoverable via the <code className="text-xs bg-sage-100 px-1 py-0.5 rounded">/api/agent/reprocess-form-relays</code>{' '}
            endpoint (operator action below).
          </p>
        </div>
      </section>

      {/* Section 3: operator actions */}
      <section>
        <h2 className="font-heading text-xl font-semibold text-sage-900 mb-3">
          Operator carry-forwards / actions needed
        </h2>
        <p className="text-sm text-sage-600 mb-4">
          Pulled from the most recent Batch 1 + Batch 2 commits&apos; &ldquo;operator carry-forwards&rdquo; blocks.
          Each is a one-off action that needs Isadora&apos;s hand on the credential wall (DDL via dashboard, or
          running a script with prod env).
        </p>
        <div className="bg-surface border border-border rounded-xl shadow-sm divide-y divide-border">
          {OPERATOR_ACTIONS.map((action, i) => (
            <div key={i} className="p-4 flex items-start gap-3">
              <span
                className="mt-1 h-4 w-4 rounded border border-sage-300 shrink-0"
                aria-label="Unchecked"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-sage-900">{action.text}</p>
                {action.detail && (
                  <p className="text-xs text-sage-600 mt-1">{action.detail}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Section 4: known open gaps */}
      <section>
        <h2 className="font-heading text-xl font-semibold text-sage-900 mb-3">
          Known open gaps
        </h2>
        <p className="text-sm text-sage-600 mb-4">
          Things shipped but not finished, or pre-existing defects the consolidation surfaced. Read these BEFORE
          assuming a weird number is a fresh bug.
        </p>
        <div className="space-y-3">
          {OPEN_GAPS.map((gap, i) => {
            const sev = severityChip(gap.severity)
            return (
              <div
                key={i}
                className="bg-surface border border-border rounded-xl shadow-sm p-4"
              >
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <h3 className="text-sm font-semibold text-sage-900">{gap.title}</h3>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold shrink-0 ${sev.bg} ${sev.text}`}
                  >
                    {sev.label}
                  </span>
                </div>
                <p className="text-sm text-sage-700">{gap.body}</p>
              </div>
            )
          })}
        </div>
      </section>

      {/* Footer pointer to CHANGELOG */}
      <section className="border-t border-border pt-6">
        <div className="flex items-start gap-3 text-sm text-sage-600">
          <FileText className="h-4 w-4 mt-0.5 shrink-0 text-sage-400" aria-hidden />
          <div>
            <p>
              The same content (channels, what-changes, actions) is mirrored in{' '}
              <code className="text-xs bg-sage-100 px-1 py-0.5 rounded">CHANGELOG.md</code> at the repo root, so it is
              greppable from the engineering side. When a new phase ships, BOTH need a new entry — treat this page as a
              release note, not a live dashboard.
            </p>
            <p className="mt-2">
              See also:{' '}
              <Link href="/admin/identity-telemetry" className="text-sage-700 underline hover:text-sage-900">
                identity telemetry
              </Link>{' '}
              ·{' '}
              <Link href="/admin/identity" className="text-sage-700 underline hover:text-sage-900">
                identity review queue
              </Link>{' '}
              ·{' '}
              <Link href="/super-admin/observability" className="text-sage-700 underline hover:text-sage-900">
                cron + meter observability
              </Link>
              .
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
