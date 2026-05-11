'use client'

/**
 * Wave 9 — data integrity remediation admin page.
 *
 * Operator surface for the four detector invariants that have a
 * remediation path:
 *   - wedding_has_people
 *   - direction_from_venue_own
 *   - inquiry_date_drift
 *   - touchpoint_source_consistency
 *
 * Each card surfaces:
 *   - Current live count (from /api/admin/integrity/check, full scan)
 *   - Meaning + fix strategy
 *   - Sample violations (first ~10)
 *   - "Dry-run" button (preview the fix; no writes)
 *   - "Apply" button (run the fix; writes + audit row)
 *   - Last 3 remediation runs from integrity_remediations
 *
 * Reads via the browser supabase client (RLS-scoped) and the admin
 * endpoints (which dual-auth and venue-scope).
 */

import { useEffect, useMemo, useState } from 'react'
import {
  ShieldCheck,
  AlertCircle,
  Loader2,
  PlayCircle,
  Wand2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  History,
  Database,
} from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'

interface InvariantResult {
  id: string
  name: string
  meaning: string
  count: number
  sample: Record<string, unknown>[]
}

interface RemediationRun {
  id: string
  venue_id: string
  invariant_id: string
  mode: 'dry_run' | 'apply'
  violations_detected: number
  violations_fixed: number
  violations_skipped: number
  skip_reasons: Record<string, number> | null
  fix_strategy: string | null
  sample_before: Record<string, unknown>[] | null
  sample_after: Record<string, unknown>[] | null
  started_at: string
  completed_at: string | null
  operator_id: string | null
  errors: Array<{ stage: string; message: string; ref?: string }> | null
}

interface RemediationRunResultWire {
  invariantId: string
  mode: 'dry_run' | 'apply'
  result: {
    invariantId: string
    mode: 'dry_run' | 'apply'
    violationsDetected: number
    violationsFixed: number
    violationsSkipped: number
    skipReasons: Record<string, number>
    fixStrategy: string
    sampleBefore: Record<string, unknown>[]
    sampleAfter: Record<string, unknown>[]
    errors: Array<{ stage: string; message: string; ref?: string }>
  }
  auditId: string | null
}

const SUPPORTED = [
  'wedding_has_people',
  'direction_from_venue_own',
  'inquiry_date_drift',
  'touchpoint_source_consistency',
] as const
type SupportedId = typeof SUPPORTED[number]

export default function IntegrityAdminPage() {
  const venueId = useVenueId()

  const [invariants, setInvariants] = useState<InvariantResult[]>([])
  const [runs, setRuns] = useState<RemediationRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyInvariant, setBusyInvariant] = useState<string | null>(null)
  const [busyMode, setBusyMode] = useState<'dry_run' | 'apply' | null>(null)
  const [lastCheckAt, setLastCheckAt] = useState<string | null>(null)
  const [lastRunFeedback, setLastRunFeedback] = useState<Record<string, string>>({})

  const reload = useMemo(
    () => async () => {
      if (!venueId) return
      setLoading(true)
      setError(null)
      try {
        const [checkRes, runsRes] = await Promise.all([
          fetch(`/api/admin/integrity/check?venueId=${encodeURIComponent(venueId)}`),
          fetch(`/api/admin/integrity/remediations?venueId=${encodeURIComponent(venueId)}&limit=50`),
        ])
        if (!checkRes.ok) {
          const j = (await checkRes.json().catch(() => ({}))) as { error?: string }
          throw new Error(j.error ?? `check failed (${checkRes.status})`)
        }
        const checkJson = (await checkRes.json()) as {
          ok: boolean
          invariants: InvariantResult[]
          ranAt: string
        }
        setInvariants(checkJson.invariants ?? [])
        setLastCheckAt(checkJson.ranAt)

        if (runsRes.ok) {
          const runsJson = (await runsRes.json()) as { rows: RemediationRun[] }
          setRuns(runsJson.rows ?? [])
        } else {
          setRuns([])
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load integrity state')
      } finally {
        setLoading(false)
      }
    },
    [venueId],
  )

  useEffect(() => {
    void reload()
  }, [reload])

  const runRemediation = async (invariantId: SupportedId, mode: 'dry_run' | 'apply') => {
    if (!venueId) return
    setBusyInvariant(invariantId)
    setBusyMode(mode)
    try {
      const res = await fetch('/api/admin/integrity/remediate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          venueId,
          invariantId,
          mode,
          // Force=true skips the implicit dry-run-first guardrail. The
          // operator chose mode explicitly via the button they clicked.
          force: mode === 'apply',
        }),
      })
      const json = (await res.json()) as { ok: boolean; runs?: RemediationRunResultWire[]; error?: string }
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `remediation failed (${res.status})`)
      }
      const last = json.runs?.[json.runs.length - 1]
      if (last) {
        const r = last.result
        setLastRunFeedback((prev) => ({
          ...prev,
          [invariantId]:
            `${mode === 'apply' ? 'Applied' : 'Dry-run'}: ` +
            `${r.violationsDetected} detected · ${r.violationsFixed} ${mode === 'apply' ? 'fixed' : 'would fix'} · ${r.violationsSkipped} skipped`,
        }))
      }
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remediation failed')
    } finally {
      setBusyInvariant(null)
      setBusyMode(null)
    }
  }

  const supportedInvariants = invariants.filter((i) => (SUPPORTED as readonly string[]).includes(i.id))
  const unsupportedInvariants = invariants.filter((i) => !(SUPPORTED as readonly string[]).includes(i.id))
  const totals = useMemo(
    () => ({
      total: invariants.reduce((acc, i) => acc + i.count, 0),
      withRemediation: supportedInvariants.reduce((acc, i) => acc + i.count, 0),
      withoutRemediation: unsupportedInvariants.reduce((acc, i) => acc + i.count, 0),
    }),
    [invariants, supportedInvariants, unsupportedInvariants],
  )

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <header>
        <h1 className="text-2xl font-serif text-sage-900 flex items-center gap-3">
          <ShieldCheck className="w-6 h-6 text-sage-700" />
          Data integrity remediation
        </h1>
        <p className="text-sage-600 mt-2 text-sm max-w-2xl">
          Each invariant below is detected by the live data-integrity sweep. The
          four with remediation can be fixed structurally with one click —
          idempotent, audited. Apply runs write; dry-runs preview without
          touching data.
        </p>
        {lastCheckAt && (
          <p className="text-sage-500 text-xs mt-2">
            Last full check: {new Date(lastCheckAt).toLocaleString()}
          </p>
        )}
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Stat label="Total violations" value={totals.total} tone={totals.total > 0 ? 'warn' : 'ok'} />
        <Stat label="With remediation" value={totals.withRemediation} />
        <Stat label="Detector-only" value={totals.withoutRemediation} />
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-600 mt-0.5" />
          <div className="text-sm text-rose-800">{error}</div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() => void reload()}
          disabled={loading}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded border border-sage-300 hover:bg-sage-50 disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Run full integrity check
        </button>
      </div>

      {loading && supportedInvariants.length === 0 && (
        <div className="text-sage-600 text-sm flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading invariant state…
        </div>
      )}

      <section className="space-y-4">
        <h2 className="text-lg font-serif text-sage-800 flex items-center gap-2">
          <Wand2 className="w-5 h-5 text-sage-700" />
          Remediable invariants
        </h2>
        {supportedInvariants.length === 0 && !loading && (
          <div className="text-sm text-sage-500 italic">
            All four remediable invariants currently clean. Nothing to do.
          </div>
        )}
        <div className="space-y-4">
          {supportedInvariants.map((inv) => {
            const myRuns = runs.filter((r) => r.invariant_id === inv.id).slice(0, 3)
            const feedback = lastRunFeedback[inv.id]
            return (
              <InvariantCard
                key={inv.id}
                invariant={inv}
                runs={myRuns}
                feedback={feedback}
                busy={busyInvariant === inv.id}
                busyMode={busyInvariant === inv.id ? busyMode : null}
                onRun={(mode) => void runRemediation(inv.id as SupportedId, mode)}
              />
            )
          })}
        </div>
      </section>

      {unsupportedInvariants.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-serif text-sage-800 flex items-center gap-2">
            <Database className="w-5 h-5 text-sage-700" />
            Detector-only invariants
          </h2>
          <p className="text-sage-500 text-xs">
            These invariants surface anomalies but don't yet have a structural
            remediation path. Coordinator review required.
          </p>
          <ul className="divide-y divide-border bg-surface rounded-lg border border-border">
            {unsupportedInvariants.map((inv) => (
              <li key={inv.id} className="p-4 flex items-start gap-3">
                <div
                  className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${
                    inv.count === 0 ? 'bg-emerald-400' : 'bg-amber-500'
                  }`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sage-900 font-medium text-sm">
                    {inv.name}{' '}
                    <span className="text-sage-500 font-normal">({inv.count})</span>
                  </div>
                  <div className="text-sage-600 text-xs mt-1">{inv.meaning}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function InvariantCard({
  invariant,
  runs,
  feedback,
  busy,
  busyMode,
  onRun,
}: {
  invariant: InvariantResult
  runs: RemediationRun[]
  feedback?: string
  busy: boolean
  busyMode: 'dry_run' | 'apply' | null
  onRun: (mode: 'dry_run' | 'apply') => void
}) {
  const [expanded, setExpanded] = useState(false)
  const tone = invariant.count === 0 ? 'ok' : 'warn'
  return (
    <div
      className={`rounded-lg border p-4 space-y-3 ${
        tone === 'ok' ? 'border-emerald-200 bg-emerald-50/30' : 'border-amber-200 bg-amber-50/30'
      }`}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-serif text-sage-900 text-base">{invariant.name}</h3>
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                tone === 'ok' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
              }`}
            >
              {invariant.count} {invariant.count === 1 ? 'violation' : 'violations'}
            </span>
          </div>
          <p className="text-sage-600 text-xs mt-1">{invariant.meaning}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onRun('dry_run')}
            disabled={busy || invariant.count === 0}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-sage-300 hover:bg-sage-50 disabled:opacity-50"
            title="Preview the fix without writing"
          >
            {busy && busyMode === 'dry_run' ? <Loader2 className="w-3 h-3 animate-spin" /> : <PlayCircle className="w-3 h-3" />}
            Dry-run
          </button>
          <button
            onClick={() => onRun('apply')}
            disabled={busy || invariant.count === 0}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-sage-700 text-white hover:bg-sage-800 disabled:opacity-50"
            title="Apply the fix (writes + audit row)"
          >
            {busy && busyMode === 'apply' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wand2 className="w-3 h-3" />}
            Apply
          </button>
        </div>
      </div>

      {feedback && (
        <div className="text-xs text-sage-700 bg-sage-50 rounded px-2 py-1 inline-block">
          {feedback}
        </div>
      )}

      {invariant.sample.length > 0 && (
        <div>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="text-xs text-sage-600 hover:underline"
          >
            {expanded ? 'Hide' : 'Show'} sample violations ({invariant.sample.length})
          </button>
          {expanded && (
            <pre className="text-[10px] mt-2 bg-white border border-border rounded p-2 overflow-x-auto max-h-64 text-sage-700">
              {JSON.stringify(invariant.sample, null, 2)}
            </pre>
          )}
        </div>
      )}

      {runs.length > 0 && (
        <div className="border-t border-border pt-3">
          <div className="text-xs font-medium text-sage-700 flex items-center gap-1 mb-2">
            <History className="w-3 h-3" />
            Recent runs
          </div>
          <ul className="space-y-1.5">
            {runs.map((run) => (
              <li
                key={run.id}
                className="text-xs text-sage-700 flex items-center gap-2 flex-wrap"
              >
                <span
                  className={`px-1.5 py-0.5 rounded ${
                    run.mode === 'apply'
                      ? 'bg-sage-100 text-sage-800'
                      : 'bg-stone-100 text-stone-700'
                  }`}
                >
                  {run.mode}
                </span>
                <span>
                  {run.violations_detected} detected, {run.violations_fixed} fixed,{' '}
                  {run.violations_skipped} skipped
                </span>
                <span className="text-sage-500">·</span>
                <span className="text-sage-500">
                  {new Date(run.started_at).toLocaleString()}
                </span>
                {run.operator_id ? (
                  <span className="text-sage-500">· operator</span>
                ) : (
                  <span className="text-sage-500">· cron</span>
                )}
                {run.errors && run.errors.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-rose-700">
                    <XCircle className="w-3 h-3" /> {run.errors.length} error
                    {run.errors.length === 1 ? '' : 's'}
                  </span>
                )}
                {run.errors && run.errors.length === 0 && (
                  <span className="inline-flex items-center gap-1 text-emerald-700">
                    <CheckCircle2 className="w-3 h-3" />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: number
  tone?: 'default' | 'warn' | 'ok'
}) {
  const palette =
    tone === 'warn'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : tone === 'ok'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
      : 'border-border bg-surface text-sage-900'
  return (
    <div className={`rounded-lg border p-3 ${palette}`}>
      <div className="text-2xl font-serif">{value}</div>
      <div className="text-xs mt-1 opacity-80">{label}</div>
    </div>
  )
}
