'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Sparkles,
  Check,
  Circle,
  ChevronRight,
  Heart,
  Calendar,
  Lock,
  Paintbrush,
  PartyPopper,
  Rocket,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

interface OnboardingRecord {
  id: string
  step: string
  completed: boolean
  completed_at: string | null
}

interface WeddingInfo {
  wedding_date: string | null
}

interface StepDef {
  id: string
  label: string
  description: string
  link?: string
}

interface PhaseDef {
  id: string
  title: string
  subtitle: string
  icon: typeof Sparkles
  minWeeks: number
  maxWeeks: number | null
  steps: StepDef[]
}

const PHASES: PhaseDef[] = [
  {
    id: 'dream',
    title: 'Dream & Discover',
    subtitle: '12+ months out',
    icon: Heart,
    minWeeks: 52,
    maxWeeks: null,
    steps: [
      { id: 'dream_priorities', label: 'Set your priorities', description: 'Work through the wedding worksheets together', link: '/worksheets' },
      { id: 'dream_inventory', label: 'Explore venue inventory', description: 'See what your venue offers for your day', link: '/venue-inventory' },
      { id: 'dream_guests', label: 'Start your guest list', description: 'Begin adding the people you want there', link: '/guests' },
      { id: 'dream_party', label: 'Think about your wedding party', description: 'Who stands beside you?', link: '/party' },
      { id: 'dream_inspo', label: 'Gather inspiration', description: 'Save photos and ideas you love', link: '/inspo' },
    ],
  },
  {
    id: 'lock',
    title: 'Lock It In',
    subtitle: '6-12 months out',
    icon: Lock,
    minWeeks: 26,
    maxWeeks: 52,
    steps: [
      { id: 'lock_vendors', label: 'Book your vendors', description: 'Photographer, florist, DJ, caterer, officiant', link: '/vendors' },
      { id: 'lock_guestlist', label: 'Finalize guest list', description: 'Confirm your headcount and collect addresses', link: '/guests' },
      { id: 'lock_timeline', label: 'Draft your timeline', description: 'Map out the flow of your day', link: '/timeline' },
      { id: 'lock_website', label: 'Set up your wedding website', description: 'Share details with your guests', link: '/website' },
      { id: 'lock_budget', label: 'Lock in your budget', description: 'Know where the money goes', link: '/budget' },
    ],
  },
  {
    id: 'details',
    title: 'Details',
    subtitle: '3-6 months out',
    icon: Paintbrush,
    minWeeks: 12,
    maxWeeks: 26,
    steps: [
      { id: 'details_seating', label: 'Plan seating', description: 'Arrange tables and assign seats', link: '/seating' },
      { id: 'details_decor', label: 'Finalize decor', description: 'Table settings, flowers, lighting', link: '/venue-inventory' },
      { id: 'details_beauty', label: 'Schedule hair and makeup', description: 'Book trials and day-of appointments' },
      { id: 'details_menu', label: 'Finalize the menu', description: 'Catering selections, dietary notes, bar planning' },
      { id: 'details_allergies', label: 'Log allergies', description: 'Track guest allergies for your caterer', link: '/allergies' },
      { id: 'details_stays', label: 'Share lodging info', description: 'Review nearby stays for your guests', link: '/stays' },
    ],
  },
  {
    id: 'prep',
    title: 'Final Prep',
    subtitle: '4-8 weeks out',
    icon: Rocket,
    minWeeks: 4,
    maxWeeks: 12,
    steps: [
      { id: 'prep_confirm', label: 'Confirm all vendors', description: 'Double-check contracts and timelines', link: '/vendors' },
      { id: 'prep_walkthrough', label: 'Schedule final walkthrough', description: 'Walk through the day with your coordinator' },
      { id: 'prep_invites', label: 'Send invitations', description: 'Mail or send invites, track RSVPs', link: '/guests' },
      { id: 'prep_care', label: 'Add guest care notes', description: 'Mobility needs, VIPs, family situations', link: '/guest-care' },
      { id: 'prep_review', label: 'Start final review', description: 'Begin signing off on each section', link: '/final-review' },
    ],
  },
  {
    id: 'week',
    title: 'Almost There!',
    subtitle: 'Wedding week',
    icon: PartyPopper,
    minWeeks: 0,
    maxWeeks: 4,
    steps: [
      { id: 'week_rehearsal', label: 'Rehearsal', description: 'Run through the ceremony and dinner' },
      { id: 'week_checklist', label: 'Last-minute checks', description: 'Rings, license, outfit, emergency kit', link: '/checklist' },
      { id: 'week_relax', label: 'Take a breath', description: 'You did the work. Now enjoy it.' },
    ],
  },
]

// ---------------------------------------------------------------------------
// Getting Started Page
// ---------------------------------------------------------------------------

export default function GettingStartedPage() {
  const [progress, setProgress] = useState<OnboardingRecord[]>([])
  const [wedding, setWedding] = useState<WeddingInfo | null>(null)
  const [loading, setLoading] = useState(true)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchData = useCallback(async () => {
    const [progressRes, weddingRes] = await Promise.all([
      supabase
        .from('onboarding_progress')
        .select('*')
        .eq('wedding_id', WEDDING_ID),
      supabase
        .from('weddings')
        .select('wedding_date')
        .eq('id', WEDDING_ID)
        .single(),
    ])

    if (!progressRes.error && progressRes.data) {
      setProgress(progressRes.data as OnboardingRecord[])
    }
    if (!weddingRes.error && weddingRes.data) {
      setWedding(weddingRes.data as WeddingInfo)
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Computed ----
  const weeksUntilWedding = wedding?.wedding_date
    ? Math.max(0, Math.ceil(
        (new Date(wedding.wedding_date).getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000)
      ))
    : null

  // Determine which phase the couple is in
  function getCurrentPhaseId(): string {
    if (weeksUntilWedding === null) return 'dream' // default if no date
    for (let i = PHASES.length - 1; i >= 0; i--) {
      const phase = PHASES[i]
      if (weeksUntilWedding >= phase.minWeeks) return phase.id
    }
    return PHASES[PHASES.length - 1].id
  }

  const currentPhaseId = getCurrentPhaseId()

  function isStepComplete(stepId: string): boolean {
    return progress.some((p) => p.step === stepId && p.completed)
  }

  async function toggleStep(stepId: string) {
    const existing = progress.find((p) => p.step === stepId)

    if (existing) {
      const newCompleted = !existing.completed
      await supabase
        .from('onboarding_progress')
        .update({
          completed: newCompleted,
          completed_at: newCompleted ? new Date().toISOString() : null,
        })
        .eq('id', existing.id)
    } else {
      await supabase.from('onboarding_progress').insert({
        venue_id: VENUE_ID,
        wedding_id: WEDDING_ID,
        step: stepId,
        completed: true,
        completed_at: new Date().toISOString(),
      })
    }

    fetchData()
  }

  // All steps across all phases
  const allSteps = PHASES.flatMap((p) => p.steps)
  const completedCount = allSteps.filter((s) => isStepComplete(s.id)).length
  const totalSteps = allSteps.length
  const overallPct = totalSteps > 0 ? Math.round((completedCount / totalSteps) * 100) : 0

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-10 bg-gray-100 rounded-lg w-64 animate-pulse" />
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-gray-100 rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1
          className="text-3xl font-bold mb-1"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          Getting Started
        </h1>
        <p className="text-gray-500 text-sm">
          {weeksUntilWedding !== null
            ? `${weeksUntilWedding} weeks until your wedding day.`
            : 'Your personalized planning roadmap.'}
          {' '}Take it one step at a time.
        </p>
      </div>

      {/* Overall Progress */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700">
            {completedCount} of {totalSteps} steps completed
          </span>
          <span className="text-sm font-medium" style={{ color: 'var(--couple-primary)' }}>
            {overallPct}%
          </span>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-2">
          <div
            className="h-2 rounded-full transition-all duration-500"
            style={{ width: `${overallPct}%`, backgroundColor: 'var(--couple-primary)' }}
          />
        </div>
      </div>

      {/* Phases */}
      <div className="space-y-4">
        {PHASES.map((phase) => {
          const PhaseIcon = phase.icon
          const isCurrent = phase.id === currentPhaseId
          const phaseStepsDone = phase.steps.filter((s) => isStepComplete(s.id)).length
          const phaseComplete = phaseStepsDone === phase.steps.length

          return (
            <div
              key={phase.id}
              className={cn(
                'bg-white rounded-xl border shadow-sm overflow-hidden transition-shadow',
                isCurrent ? 'border-2 shadow-md' : 'border-gray-100',
              )}
              style={isCurrent ? { borderColor: 'var(--couple-primary)' } : undefined}
            >
              {/* Phase Header */}
              <div className="px-5 py-4 flex items-center gap-3">
                <div
                  className={cn(
                    'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                    phaseComplete ? 'bg-emerald-100' : ''
                  )}
                  style={!phaseComplete ? {
                    backgroundColor: 'color-mix(in srgb, var(--couple-primary) 10%, transparent)',
                  } : undefined}
                >
                  {phaseComplete ? (
                    <Check className="w-5 h-5 text-emerald-600" />
                  ) : (
                    <PhaseIcon
                      className="w-5 h-5"
                      style={{ color: 'var(--couple-primary)' }}
                    />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="font-semibold text-gray-800">{phase.title}</h2>
                    {isCurrent && (
                      <span
                        className="px-2 py-0.5 rounded-full text-[10px] font-bold text-white uppercase tracking-wide"
                        style={{ backgroundColor: 'var(--couple-primary)' }}
                      >
                        You are here
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">{phase.subtitle}</p>
                </div>
                <span className="text-xs text-gray-400 tabular-nums shrink-0">
                  {phaseStepsDone}/{phase.steps.length}
                </span>
              </div>

              {/* Steps */}
              <div className="border-t border-gray-50">
                {phase.steps.map((step) => {
                  const done = isStepComplete(step.id)

                  return (
                    <div
                      key={step.id}
                      className="flex items-center gap-3 px-5 py-3 border-b border-gray-50 last:border-b-0 hover:bg-gray-50/50 transition-colors"
                    >
                      <button
                        onClick={() => toggleStep(step.id)}
                        className="shrink-0"
                      >
                        {done ? (
                          <div
                            className="w-5 h-5 rounded-full flex items-center justify-center"
                            style={{ backgroundColor: 'var(--couple-primary)' }}
                          >
                            <Check className="w-3 h-3 text-white" />
                          </div>
                        ) : (
                          <Circle className="w-5 h-5 text-gray-300" />
                        )}
                      </button>

                      <div className="flex-1 min-w-0">
                        <span className={cn(
                          'text-sm',
                          done ? 'text-gray-400 line-through' : 'text-gray-800 font-medium'
                        )}>
                          {step.label}
                        </span>
                        <p className="text-xs text-gray-400">{step.description}</p>
                      </div>

                      {step.link && (
                        <a
                          href={step.link}
                          className="p-1.5 rounded-md text-gray-300 hover:text-gray-500 shrink-0"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </a>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
