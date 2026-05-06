'use client'

/**
 * PostOnboardingChecklist — shows the coordinator the integrations they
 * still need to wire up after the in-app onboarding wizard finishes.
 *
 * Onboarding sets `venue_config.onboarding_completed = true` and bounces
 * the coordinator to `/?onboarding=complete`. From there the dashboard
 * renders this card with up to five recommended next steps:
 *
 *   1. Connect Calendly       — `venue_config.calendly_link` + tokens
 *   2. Import HoneyBook CSV   — count of weddings where crm_source='honeybook'
 *   3. Train Sage's voice     — count of draft_feedback rows (approved/edited)
 *   4. Invite teammates       — user_profiles count for this venue
 *   5. Add a signature/footer — no schema column for this yet, always shown
 *
 * Each item is hidden once it's complete. If all five are complete the card
 * unmounts entirely.
 *
 * Visibility rules:
 *   - Only renders at venue scope (the per-venue checks don't make sense
 *     across a portfolio).
 *   - Hidden if dismissed within the last 7 days for this venue
 *     (localStorage key `bloom_post_onboarding_dismissed_<venueId>`).
 *   - Hidden if every item is complete.
 *
 * The data fetch happens client-side because the dashboard itself is a
 * Client Component — wrapping a Server Component sub-tree just to fetch
 * counts would mean splitting the page. Counts are head-only so the
 * payload stays small.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  Calendar, Database, Mic, Users, PenLine, X, Sparkles,
} from 'lucide-react'

interface Step {
  id: 'calendly' | 'honeybook' | 'voice' | 'team' | 'signature'
  label: string
  description: string
  href: string
  icon: typeof Calendar
  done: boolean
}

const DISMISS_KEY_PREFIX = 'bloom_post_onboarding_dismissed_'
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function isDismissed(venueId: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY_PREFIX + venueId)
    if (!raw) return false
    const ts = Number(raw)
    if (!Number.isFinite(ts)) return false
    return Date.now() - ts < DISMISS_TTL_MS
  } catch {
    return false
  }
}

function setDismissed(venueId: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DISMISS_KEY_PREFIX + venueId, String(Date.now()))
  } catch {
    // localStorage might be disabled — ignore, the user just won't have
    // their dismiss persisted across reloads. Worst case they dismiss
    // again next time.
  }
}

interface Props {
  venueId: string
}

export function PostOnboardingChecklist({ venueId }: Props) {
  const searchParams = useSearchParams()
  const justCompleted = searchParams?.get('onboarding') === 'complete'

  const [dismissed, setDismissedState] = useState(false)
  const [loading, setLoading] = useState(true)
  const [steps, setSteps] = useState<Step[]>([])

  // Hydrate dismissed state from localStorage. Done after mount to keep
  // SSR and CSR markup identical (avoid hydration mismatches).
  useEffect(() => {
    setDismissedState(isDismissed(venueId))
  }, [venueId])

  useEffect(() => {
    let cancelled = false

    async function load() {
      const supabase = createClient()

      // Calendly — read the link + tokens column on venue_config. There
      // is no calendly_connections table; the integration is stored
      // inline. "Connected" = either a non-empty calendly_link OR an
      // access_token in calendly_tokens.
      let calendlyDone = false
      try {
        const { data } = await supabase
          .from('venue_config')
          .select('calendly_link, calendly_tokens')
          .eq('venue_id', venueId)
          .maybeSingle()
        const link = (data?.calendly_link as string | null) ?? ''
        const tokens = (data?.calendly_tokens as { access_token?: string } | null) ?? null
        calendlyDone = !!(link.trim() || tokens?.access_token?.trim())
      } catch {
        calendlyDone = false
      }

      // HoneyBook — any wedding tagged with crm_source='honeybook' counts
      // as "they've imported at least once."
      let honeyBookDone = false
      try {
        const { count } = await supabase
          .from('weddings')
          .select('id', { count: 'exact', head: true })
          .eq('venue_id', venueId)
          .eq('crm_source', 'honeybook')
        honeyBookDone = (count ?? 0) > 0
      } catch {
        honeyBookDone = false
      }

      // Voice training — Phase 8 threshold is 5. We count approved + edited
      // feedback rows; both teach Sage. Rejections don't (they remove
      // patterns, not add them).
      let voiceDone = false
      try {
        const { count } = await supabase
          .from('draft_feedback')
          .select('id', { count: 'exact', head: true })
          .eq('venue_id', venueId)
          .in('action', ['approved', 'edited'])
        voiceDone = (count ?? 0) >= 5
      } catch {
        voiceDone = false
      }

      // Team — count user_profiles attached to this venue. Owner is one,
      // so "team invited" means at least 2.
      let teamDone = false
      try {
        const { count } = await supabase
          .from('user_profiles')
          .select('id', { count: 'exact', head: true })
          .eq('venue_id', venueId)
        teamDone = (count ?? 0) >= 2
      } catch {
        teamDone = false
      }

      // Signature/footer — no dedicated column on venue_config yet.
      // We can't tell whether the coordinator has set a custom sign-off,
      // so we show the link as a recommendation. Coordinator can dismiss
      // the whole card if they don't care.
      const signatureDone = false

      const next: Step[] = [
        {
          id: 'calendly',
          label: 'Connect Calendly',
          description: 'Auto-log tour bookings as they happen',
          href: '/settings',
          icon: Calendar,
          done: calendlyDone,
        },
        {
          id: 'honeybook',
          label: 'Import historical data from HoneyBook',
          description: 'Bring booked weddings + lost deals into Bloom',
          href: '/onboarding/crm-import',
          icon: Database,
          done: honeyBookDone,
        },
        {
          id: 'voice',
          label: "Train Sage's voice",
          description: 'Approve or edit 5 drafts so Sage learns your tone',
          href: '/agent/learning',
          icon: Mic,
          done: voiceDone,
        },
        {
          id: 'team',
          label: 'Invite your team',
          description: 'Add co-coordinators so they see drafts and inquiries',
          href: '/settings/team',
          icon: Users,
          done: teamDone,
        },
        {
          id: 'signature',
          label: 'Add a signature / footer',
          description: 'Set the sign-off Sage uses on outgoing replies',
          href: '/agent/settings',
          icon: PenLine,
          done: signatureDone,
        },
      ]

      if (!cancelled) {
        setSteps(next)
        setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [venueId])

  if (dismissed) return null
  if (loading) return null

  const remaining = steps.filter((s) => !s.done)
  if (remaining.length === 0) return null

  function onDismiss() {
    setDismissed(venueId)
    setDismissedState(true)
  }

  // Just-completed gets a slightly warmer headline; the long-tail nudge
  // (some integrations missing on a return visit) gets the calmer copy.
  const headline = justCompleted
    ? "You're set up — here's what to do next"
    : 'Recommended next steps'
  const subhead = justCompleted
    ? `Finish wiring up the ${remaining.length === 1 ? 'last integration' : `${remaining.length} integrations`} Sage needs to work properly.`
    : 'Finish setting up the integrations Sage needs to work properly.'

  return (
    <div className="rounded-xl border border-gold-200 bg-gold-50/40 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-gold-100 rounded-lg shrink-0">
            <Sparkles className="w-4 h-4 text-gold-600" />
          </div>
          <div>
            <h3 className="font-heading text-base font-semibold text-sage-900">
              {headline}
            </h3>
            <p className="text-xs text-sage-700 mt-0.5">{subhead}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-sage-600 hover:text-sage-900 flex items-center gap-1 px-2 py-1 rounded-md hover:bg-gold-100 transition-colors shrink-0"
          title="Hide for 7 days"
        >
          <X className="w-3 h-3" />
          <span>Hide for now</span>
        </button>
      </div>

      <ul className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {remaining.map((step) => (
          <li key={step.id}>
            <Link
              href={step.href}
              className="flex items-center gap-3 py-2.5 px-3 rounded-md bg-surface border border-gold-200 hover:border-gold-300 hover:bg-gold-50 transition group"
            >
              <div className="bg-gold-50 p-1.5 rounded-md shrink-0 group-hover:bg-gold-100 transition-colors">
                <step.icon className="w-4 h-4 text-gold-600" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-sage-900 truncate">{step.label}</div>
                <div className="text-xs text-sage-600 truncate">{step.description}</div>
              </div>
              <span className="text-gold-600 group-hover:translate-x-0.5 transition-transform" aria-hidden>
                →
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
