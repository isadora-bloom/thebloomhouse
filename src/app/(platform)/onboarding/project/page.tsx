'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import {
  Calendar,
  CheckCircle2,
  Circle,
  AlertTriangle,
  Play,
  Pause,
  RefreshCw,
  Rocket,
  ChevronRight,
  Sparkles,
} from 'lucide-react'
import { PROJECT_PLAN, TOTAL_DAYS, type DayStep, detectDay1Completion } from '@/lib/services/onboarding-project'
import { BackfillChecklist } from '@/components/onboarding/backfill-checklist'

// ---------------------------------------------------------------------------
// 5-day onboarding project flow (T2-A / Playbook Part 18).
//
// Sits beside the existing 15-min wizard at /onboarding. Both are
// supported per coordinator approval — the wizard is for friend-of-
// Isadora venues; this is the enterprise / paid-plan flow.
//
// The page is the orchestration surface — it shows the plan + state
// + lets coordinators mark steps complete + advance days. Actual
// work (OAuth, backfill, voice DNA seeding) happens in the linked
// surfaces (/agent/* / /portal/*); this page is the project tracker.
// ---------------------------------------------------------------------------

interface ProjectState {
  id: string
  venue_id: string
  status: 'in_progress' | 'paused' | 'go_live_pending' | 'live' | 'archived'
  started_at: string
  target_go_live: string | null
  completed_at: string | null
  current_day: number
  current_step_key: string | null
  day_1_completed_at: string | null
  day_2_completed_at: string | null
  day_3_completed_at: string | null
  day_4_completed_at: string | null
  day_5_completed_at: string | null
  readiness_state: Record<string, unknown>
  readiness_passed_at: string | null
  readiness_failures: unknown[]
  coordinator_notes: Record<string, Record<string, { completed_at: string; note?: string }>>
}

function statusLabel(s: ProjectState['status']): string {
  switch (s) {
    case 'in_progress':     return 'In progress'
    case 'paused':          return 'Paused'
    case 'go_live_pending': return 'Awaiting Go Live'
    case 'live':            return 'Live'
    case 'archived':        return 'Archived'
  }
}

function statusColor(s: ProjectState['status']): string {
  switch (s) {
    case 'in_progress':     return 'bg-sage-100 text-sage-700'
    case 'paused':          return 'bg-amber-100 text-amber-700'
    case 'go_live_pending': return 'bg-blue-100 text-blue-700'
    case 'live':            return 'bg-emerald-100 text-emerald-700'
    case 'archived':        return 'bg-sage-50 text-sage-500'
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function OnboardingProjectPage() {
  const venueId = useVenueId()
  const supabase = createClient()
  const [project, setProject] = useState<ProjectState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * T5-followup-Z: Day-1 sub-steps auto-detect from underlying DB
   * state (Gmail connection, Sage identity, forbidden topics, tone
   * sliders). Refreshed on each fetchProject so coordinators see
   * green checks without revisiting the project page after each
   * sub-action.
   */
  const [day1AutoDone, setDay1AutoDone] = useState<Set<string>>(new Set())

  const fetchProject = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    try {
      const { data, error: fetchErr } = await supabase
        .from('onboarding_projects')
        .select('*')
        .eq('venue_id', venueId)
        .in('status', ['in_progress', 'paused', 'go_live_pending', 'live'])
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (fetchErr) throw fetchErr
      setProject((data as ProjectState | null) ?? null)
      setError(null)

      // T5-followup-Z: refresh Day-1 auto-detected completion state.
      // Errors swallowed inside detectDay1Completion so a partial
      // failure never blocks the page from rendering.
      try {
        const detected = await detectDay1Completion(supabase, venueId)
        setDay1AutoDone(detected)
      } catch { setDay1AutoDone(new Set()) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load project'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [venueId, supabase])

  useEffect(() => { fetchProject() }, [fetchProject])

  async function handleStart() {
    if (!venueId || busy) return
    setBusy(true)
    try {
      await supabase.from('onboarding_projects').insert({
        venue_id: venueId,
        status: 'in_progress',
        current_day: 1,
      })
      await fetchProject()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start project'
      setError(msg)
    } finally { setBusy(false) }
  }

  async function handleStepComplete(day: number, step: DayStep, note?: string) {
    if (!project || busy) return
    setBusy(true)
    try {
      const notes = { ...(project.coordinator_notes ?? {}) }
      const dayKey = `day_${day}`
      if (!notes[dayKey]) notes[dayKey] = {}
      notes[dayKey][step.key] = { completed_at: new Date().toISOString(), note: note?.trim() || undefined }
      await supabase
        .from('onboarding_projects')
        .update({ current_step_key: step.key, coordinator_notes: notes })
        .eq('id', project.id)
      await fetchProject()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to record step'
      setError(msg)
    } finally { setBusy(false) }
  }

  /**
   * T5-θ.3: Run the voice-DNA extraction on the venue's coordinator-
   * written Gmail backfill. The route returns counts; we surface them
   * in the step note so the coordinator sees what was captured. The
   * step is marked done only on rowsWritten > 0 — partial failures
   * (LLM all-batches-failed, no samples) leave the step open so the
   * coordinator can retry.
   */
  async function handleVoiceDnaExtract(day: number, step: DayStep) {
    if (!project || busy) return
    // First-run path leaves overwrite=false so the API can return 409
    // if a prior import exists; the 409-handler below prompts the
    // coordinator and retries with overwrite=true. Re-running an
    // already-completed step explicitly opts in to overwrite.
    const stepHasRun = Boolean(stepCompletion.get(`day_${day}.${step.key}`))
    if (stepHasRun && !window.confirm('Voice DNA has already been extracted for this venue. Re-running will OVERWRITE the previous extraction. Continue?')) {
      return
    }
    const overwrite = stepHasRun
    setBusy(true)
    try {
      const res = await fetch('/api/onboarding/voice-dna-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overwrite }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 409 && body.error === 'already_imported') {
          if (window.confirm('Voice DNA has already been extracted. Re-run and OVERWRITE the previous extraction?')) {
            const retry = await fetch('/api/onboarding/voice-dna-extract', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ overwrite: true }),
            })
            const retryBody = await retry.json().catch(() => ({}))
            if (!retry.ok) throw new Error(retryBody.message ?? retryBody.error ?? `HTTP ${retry.status}`)
            await applyVoiceDnaSuccess(day, step, retryBody)
            return
          }
          return
        }
        if (res.status === 429) {
          throw new Error(`${body.message ?? 'Cost ceiling reached'}${body.resume_at ? ` (auto-resumes ${new Date(body.resume_at).toLocaleString()})` : ''}`)
        }
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`)
      }
      await applyVoiceDnaSuccess(day, step, body)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Voice DNA extraction failed'
      setError(msg)
    } finally { setBusy(false) }
  }

  async function applyVoiceDnaSuccess(day: number, step: DayStep, body: Record<string, unknown>) {
    const sampled = (body.sampled_count as number | undefined) ?? 0
    const rowsWritten = (body.rows_written as number | undefined) ?? 0
    const phrases = (body.phrases_extracted as number | undefined) ?? 0
    const greetings = (body.greeting_patterns as number | undefined) ?? 0
    const signoffs = (body.signoff_patterns as number | undefined) ?? 0

    if (rowsWritten <= 0) {
      // Per spec: step is marked done only when rowsWritten > 0.
      setError(
        `Sampled ${sampled} emails but no voice anchors were written. ` +
        `Try again, or check that your outbound emails contain enough variety.`
      )
      return
    }

    const note =
      `Sampled ${sampled} coordinator-written emails; extracted ${phrases} phrases ` +
      `+ ${greetings} greeting / ${signoffs} signoff patterns; ` +
      `wrote ${rowsWritten} rows to voice_preferences/phrase_usage/review_language.`

    await handleStepComplete(day, step, note)
  }

  async function handleAdvanceDay() {
    if (!project || busy) return
    setBusy(true)
    try {
      const cur = project.current_day
      if (cur >= TOTAL_DAYS) {
        await supabase
          .from('onboarding_projects')
          .update({ status: 'go_live_pending', day_5_completed_at: new Date().toISOString() })
          .eq('id', project.id)
      } else {
        const dayCol = `day_${cur}_completed_at`
        await supabase
          .from('onboarding_projects')
          .update({ current_day: cur + 1, [dayCol]: new Date().toISOString(), current_step_key: null })
          .eq('id', project.id)
      }
      await fetchProject()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to advance'
      setError(msg)
    } finally { setBusy(false) }
  }

  async function handlePauseToggle() {
    if (!project || busy) return
    setBusy(true)
    try {
      const next = project.status === 'paused' ? 'in_progress' : 'paused'
      await supabase.from('onboarding_projects').update({ status: next }).eq('id', project.id)
      await fetchProject()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to toggle pause'
      setError(msg)
    } finally { setBusy(false) }
  }

  async function handleGoLive() {
    if (!project || busy) return
    if (!project.readiness_passed_at) {
      setError('Run the readiness gate first — Day 5 step 2.')
      return
    }
    setBusy(true)
    try {
      // Routes through /api/onboarding/project/activate so the
      // server-side activateLive() gate runs (readiness check +
      // paid-venue backfill score >= 80). Pre-fix this called a
      // direct supabase.update which bypassed both gates entirely.
      const res = await fetch('/api/onboarding/project/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        const score = body.backfill_score ?? null
        const missing = (body.missing_categories ?? []) as string[]
        const detail = score !== null
          ? ` Backfill score ${score}/100${missing.length ? '. Required not yet complete: ' + missing.join(', ') : ''}.`
          : ''
        throw new Error((body.error ?? `HTTP ${res.status}`) + detail)
      }
      await fetchProject()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to Go Live'
      setError(msg)
    } finally { setBusy(false) }
  }

  const stepCompletion = useMemo(() => {
    if (!project) return new Map<string, { completed_at: string; note?: string; auto?: boolean }>()
    const out = new Map<string, { completed_at: string; note?: string; auto?: boolean }>()
    for (const [dayKey, dayNotes] of Object.entries(project.coordinator_notes ?? {})) {
      for (const [stepKey, entry] of Object.entries(dayNotes ?? {})) {
        out.set(`${dayKey}.${stepKey}`, entry)
      }
    }
    // T5-followup-Z: layer auto-detected Day-1 completions on top.
    // Coordinator-clicked completions take precedence (they may have
    // notes); auto-detected completions only fill in steps the
    // coordinator hasn't manually marked.
    for (const stepKey of day1AutoDone) {
      const mapKey = `day_1.${stepKey}`
      if (!out.has(mapKey)) {
        out.set(mapKey, {
          completed_at: new Date().toISOString(),
          note: 'auto-detected from venue state',
          auto: true,
        })
      }
    }
    return out
  }, [project, day1AutoDone])

  if (loading) return <div className="p-8"><p className="text-sage-500 text-sm">Loading…</p></div>

  if (!project) {
    return (
      <div className="p-8 max-w-3xl space-y-4">
        <header>
          <h1 className="font-heading text-2xl font-semibold text-sage-900">5-day onboarding project</h1>
          <p className="text-sm text-sage-600 mt-2 max-w-2xl">
            The structured first-week project for enterprise venues. Five days
            of focused setup — Gmail backfill, marketing channels, pricing
            history, CRM ingestion, voice DNA, knowledge base — that produces
            real intelligence by end of week instead of the friend-of-Isadora
            15-min path.
          </p>
        </header>
        <div className="rounded-lg border border-sage-200 bg-white p-6 space-y-3">
          <h2 className="font-medium text-sage-900">Start a new project</h2>
          <p className="text-sm text-sage-600">
            Kicks off Day 1. You can pause and resume at any point. The
            existing 15-min wizard at <a className="underline" href="/onboarding">/onboarding</a> stays
            available for friend-of-Isadora venues.
          </p>
          <button
            onClick={handleStart}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-4 py-2"
          >
            <Play className="w-4 h-4" />
            {busy ? 'Starting…' : 'Start project'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h1 className="font-heading text-2xl font-semibold text-sage-900">5-day onboarding project</h1>
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusColor(project.status)}`}>
              {statusLabel(project.status)}
            </span>
            <span className="text-xs text-sage-500">Day {project.current_day} of {TOTAL_DAYS}</span>
          </div>
        </div>
        <p className="text-sm text-sage-600">
          Started {formatDate(project.started_at)}{project.target_go_live ? ` · Target Go Live ${formatDate(project.target_go_live)}` : ''}
        </p>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <DayProgressBar project={project} />

      {project.status !== 'live' && (
        <div className="flex items-center gap-2">
          <button
            onClick={handlePauseToggle}
            disabled={busy}
            className="inline-flex items-center gap-1 text-xs rounded border border-sage-200 px-2 py-1 text-sage-700 hover:bg-sage-50"
          >
            {project.status === 'paused' ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
            {project.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button
            onClick={fetchProject}
            disabled={busy}
            className="inline-flex items-center gap-1 text-xs rounded border border-sage-200 px-2 py-1 text-sage-700 hover:bg-sage-50"
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
        </div>
      )}

      <div className="space-y-4">
        {PROJECT_PLAN.map((dp) => {
          const dayCompletedKey = `day_${dp.day}_completed_at` as keyof ProjectState
          const dayDone = Boolean(project[dayCompletedKey])
          const isCurrent = project.current_day === dp.day && !dayDone
          return (
            <DayCard
              key={dp.day}
              day={dp}
              isCurrent={isCurrent}
              isComplete={dayDone}
              stepCompletion={stepCompletion}
              onCompleteStep={(step) => handleStepComplete(dp.day, step)}
              onVoiceDnaExtract={(step) => handleVoiceDnaExtract(dp.day, step)}
              advanceDay={handleAdvanceDay}
              busy={busy}
              status={project.status}
            />
          )
        })}
      </div>

      {/* Backfill checklist — visible from Day 4 onward (when there's
         enough state to evaluate) and through go_live_pending. Paid
         venues need >= 80% to Go Live; activateLive enforces it
         server-side. ARCH-18.2 / 18.3-C / 18.3-D / LIMB-16.3. */}
      {(project.status === 'in_progress' || project.status === 'go_live_pending') && project.current_day >= 4 && (
        <BackfillChecklist venueId={project.venue_id} />
      )}

      {project.status === 'go_live_pending' && (
        <div className="rounded-lg border-2 border-sage-300 bg-sage-50 p-6 space-y-3">
          <h2 className="font-heading text-xl font-semibold text-sage-900 flex items-center gap-2">
            <Rocket className="w-5 h-5" />
            Go Live
          </h2>
          {project.readiness_passed_at ? (
            <>
              <p className="text-sm text-sage-700">
                Readiness gate passed on {formatDate(project.readiness_passed_at)}.
                You&apos;re cleared to flip the venue live — auto-send + drafts + intel surfaces all activate.
              </p>
              <button
                onClick={handleGoLive}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-4 py-2"
              >
                <Rocket className="w-4 h-4" />
                {busy ? 'Activating…' : 'Activate live'}
              </button>
            </>
          ) : (
            <p className="text-sm text-amber-700">
              Run the readiness gate (Day 5 step 2) before activating. The gate
              evaluates minimum data-volume thresholds across Internal Context,
              Forensic Record, and Voice DNA.
            </p>
          )}
        </div>
      )}

      {project.status === 'live' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <CheckCircle2 className="w-4 h-4 inline mr-2" />
          Project went live on {formatDate(project.completed_at)}. Auto-send, drafts, and intel are active.
        </div>
      )}
    </div>
  )
}

interface DayProgressBarProps { project: ProjectState }

function DayProgressBar({ project }: DayProgressBarProps) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: TOTAL_DAYS }, (_, i) => {
        const day = i + 1
        const completedKey = `day_${day}_completed_at` as keyof ProjectState
        const done = Boolean(project[completedKey])
        const current = project.current_day === day && !done
        return (
          <div key={day} className="flex-1">
            <div className={`h-1.5 rounded ${done ? 'bg-sage-600' : current ? 'bg-sage-300' : 'bg-sage-100'}`} />
            <p className={`text-[10px] mt-1 ${done ? 'text-sage-700' : current ? 'text-sage-700 font-medium' : 'text-sage-400'}`}>
              Day {day}
            </p>
          </div>
        )
      })}
    </div>
  )
}

interface DayCardProps {
  day: typeof PROJECT_PLAN[number]
  isCurrent: boolean
  isComplete: boolean
  stepCompletion: Map<string, { completed_at: string; note?: string; auto?: boolean }>
  onCompleteStep: (step: DayStep) => void
  /** T5-θ.3: inline action for the Day-4 voice_dna_extract step. */
  onVoiceDnaExtract: (step: DayStep) => void
  advanceDay: () => void
  busy: boolean
  status: ProjectState['status']
}

function DayCard({ day, isCurrent, isComplete, stepCompletion, onCompleteStep, onVoiceDnaExtract, advanceDay, busy, status }: DayCardProps) {
  const allStepsDone = day.steps.every((s) => stepCompletion.has(`day_${day.day}.${s.key}`))
  return (
    <section className={`rounded-lg border p-4 ${isCurrent ? 'border-sage-400 bg-sage-50/40' : isComplete ? 'border-sage-200 bg-white' : 'border-sage-100 bg-white opacity-70'}`}>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div className="flex items-center gap-2">
          <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold ${isComplete ? 'bg-sage-600 text-white' : isCurrent ? 'bg-sage-700 text-white' : 'bg-sage-100 text-sage-500'}`}>
            {isComplete ? <CheckCircle2 className="w-4 h-4" /> : day.day}
          </div>
          <div>
            <h2 className="font-medium text-sage-900">{day.title}</h2>
            <p className="text-xs text-sage-500">{day.subtitle}</p>
          </div>
        </div>
        {isCurrent && allStepsDone && status === 'in_progress' && (
          <button
            onClick={advanceDay}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5"
          >
            {day.day === TOTAL_DAYS ? 'Finish project' : 'Advance to next day'}
            <ChevronRight className="w-3 h-3" />
          </button>
        )}
      </div>
      <ul className="space-y-2">
        {day.steps.map((s) => {
          const completion = stepCompletion.get(`day_${day.day}.${s.key}`)
          const stepDone = Boolean(completion)
          return (
            <li key={s.key} className="flex items-start gap-3 rounded border border-sage-100 bg-white p-3">
              <div className="pt-0.5">
                {stepDone ? (
                  <CheckCircle2 className="w-4 h-4 text-sage-600" />
                ) : (
                  <Circle className="w-4 h-4 text-sage-300" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-sage-900">{s.label}</p>
                <p className="text-xs text-sage-500 mt-0.5">{s.description}</p>
                {completion && (
                  <p className="text-[10px] text-sage-400 mt-1">
                    Completed {new Date(completion.completed_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    {completion.note ? ` · ${completion.note}` : ''}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 flex-wrap justify-end">
                {/* 2026-05-01 (review pass 4): each step links to the
                    actual work surface so coordinators don't have to
                    memorise where each piece lives. Mark-done is the
                    confirmation step until the T2-A follow-up
                    automation auto-detects completion (OAuth connected,
                    backfill finished, etc.). */}
                {s.linkHref && !stepDone && isCurrent && (
                  <a
                    href={s.linkHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded border border-sage-200 hover:bg-sage-50 text-xs text-sage-700 px-2 py-1"
                  >
                    {s.linkLabel ?? 'Open surface'} ↗
                  </a>
                )}
                {/* T5-θ.3: Day-4 voice DNA extraction is run in-page —
                    the LLM extraction service does the work + writes
                    voice anchors. Step is marked done by the success
                    handler only if rows_written > 0. */}
                {!stepDone && isCurrent && status === 'in_progress' && s.actionKey === 'voice_dna_extract' && (
                  <button
                    onClick={() => onVoiceDnaExtract(s)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-xs font-medium px-2 py-1"
                  >
                    <Sparkles className="w-3 h-3" />
                    {busy ? 'Running…' : 'Run voice DNA extraction from Gmail backfill'}
                  </button>
                )}
                {!stepDone && isCurrent && status === 'in_progress' && s.actionKey !== 'voice_dna_extract' && (
                  <button
                    onClick={() => onCompleteStep(s)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded border border-sage-200 hover:bg-sage-50 text-xs text-sage-700 px-2 py-1"
                  >
                    Mark done
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
