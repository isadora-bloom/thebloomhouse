'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Check,
  ChevronRight,
  Camera,
  MessageCircle,
  Users,
  Sparkles,
  CheckSquare,
  ArrowRight,
  PartyPopper,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OnboardingProgress {
  id: string
  wedding_id: string
  couple_photo_uploaded: boolean
  first_message_sent: boolean
  vendor_added: boolean
  inspo_uploaded: boolean
  checklist_item_completed: boolean
  updated_at: string | null
}

interface WeddingInfo {
  wedding_date: string | null
  partner1_name: string | null
  partner2_name: string | null
}

interface ActionCard {
  id: keyof Pick<OnboardingProgress, 'couple_photo_uploaded' | 'first_message_sent' | 'vendor_added' | 'inspo_uploaded' | 'checklist_item_completed'>
  emoji: string
  title: string
  description: string
  actionLabel: string
  path: string
  icon: typeof Camera
}

// ---------------------------------------------------------------------------
// Action Card Definitions
// ---------------------------------------------------------------------------

const ACTION_CARDS: ActionCard[] = [
  {
    id: 'couple_photo_uploaded',
    emoji: '📸',
    title: 'Upload a photo of you two',
    description: 'Add a photo so your vendors and venue team can put faces to names. It makes everything feel more personal.',
    actionLabel: 'Add your photo',
    path: 'couple-photo',
    icon: Camera,
  },
  {
    id: 'first_message_sent',
    emoji: '💬',
    title: 'Say hi to Sage',
    description: 'Your AI planning assistant is ready and waiting. Ask anything about your venue, your timeline, or just say hello.',
    actionLabel: 'Start chatting',
    path: 'chat',
    icon: MessageCircle,
  },
  {
    id: 'vendor_added',
    emoji: '👥',
    title: 'Add your first vendor',
    description: 'Start tracking your photographer, florist, DJ, or anyone else helping make your day happen.',
    actionLabel: 'Add a vendor',
    path: 'vendors',
    icon: Users,
  },
  {
    id: 'inspo_uploaded',
    emoji: '✨',
    title: 'Share some inspiration',
    description: 'Upload photos of your vision — colors, flowers, tablescapes, vibes. Help your team see what you are dreaming of.',
    actionLabel: 'Upload inspo',
    path: 'inspo',
    icon: Sparkles,
  },
  {
    id: 'checklist_item_completed',
    emoji: '✅',
    title: 'Check off a task',
    description: 'Your checklist is pre-loaded with everything you need. Start knocking things out, one at a time.',
    actionLabel: 'View checklist',
    path: 'checklist',
    icon: CheckSquare,
  },
]

// ---------------------------------------------------------------------------
// Time-Bucket Nudge Content
// ---------------------------------------------------------------------------

interface NudgeBucket {
  minWeeks: number
  maxWeeks: number | null
  title: string
  emoji: string
  description: string
  tips: string[]
}

const NUDGE_BUCKETS: NudgeBucket[] = [
  {
    minWeeks: 52,
    maxWeeks: null,
    title: 'Dream & Book Essentials',
    emoji: '🌙',
    description: 'You have wonderful time ahead of you. Focus on the big pieces first.',
    tips: [
      'Book your photographer early — the best ones fill up 12-18 months out',
      'Lock in your caterer and start thinking about the menu direction',
      'Start a guest list draft, even if it changes ten times',
      'Chat with Sage about your venue — she knows every corner of this place',
    ],
  },
  {
    minWeeks: 26,
    maxWeeks: 51,
    title: 'Lock In Your Vendors',
    emoji: '🔒',
    description: 'This is the sweet spot for getting everything booked and confirmed.',
    tips: [
      'Upload your vendor contracts so everything is in one place',
      'Book your DJ or band, florist, and officiant if you have not yet',
      'Start thinking about your ceremony flow and timeline',
      'Send save-the-dates if you have not already',
    ],
  },
  {
    minWeeks: 13,
    maxWeeks: 25,
    title: 'Get Into the Details',
    emoji: '🎨',
    description: 'The fun part — making all the little decisions that bring your vision to life.',
    tips: [
      'Build your day-of timeline so everyone knows the flow',
      'Start your table layout and think about seating groups',
      'Finalize your menu, bar selections, and any dietary notes',
      'Schedule hair and makeup trials',
    ],
  },
  {
    minWeeks: 4,
    maxWeeks: 12,
    title: 'Final Prep',
    emoji: '🚀',
    description: 'Everything is coming together. Time to confirm, finalize, and breathe.',
    tips: [
      'Confirm all vendor arrival times and day-of contacts',
      'Schedule your final walkthrough with your coordinator',
      'Finalize your guest count and submit to your caterer',
      'Create a packing list for the wedding day',
    ],
  },
  {
    minWeeks: 0,
    maxWeeks: 3,
    title: 'Home Stretch',
    emoji: '🎉',
    description: 'You have done the work. Trust your plan, lean on your people, and enjoy every moment.',
    tips: [
      'Send final confirmations to all vendors',
      'Pack your bags for the day — do not forget the rings and the license',
      'Delegate day-of questions to your coordinator or point person',
      'Take a deep breath. You are so ready for this.',
    ],
  },
]

// ---------------------------------------------------------------------------
// Progress Ring Component
// ---------------------------------------------------------------------------

function ProgressRing({ completed, total }: { completed: number; total: number }) {
  const size = 120
  const strokeWidth = 8
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const progress = total > 0 ? completed / total : 0
  const offset = circumference - progress * circumference

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width={size} height={size} className="-rotate-90">
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="#E5E7EB"
          strokeWidth={strokeWidth}
          fill="none"
        />
        {/* Progress circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="var(--couple-primary, #7D8471)"
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="text-3xl font-bold"
          style={{ color: 'var(--couple-primary, #7D8471)' }}
        >
          {completed}
        </span>
        <span className="text-xs text-gray-400">of {total}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Getting Started Page
// ---------------------------------------------------------------------------

export default function GettingStartedPage() {
  const [progress, setProgress] = useState<OnboardingProgress | null>(null)
  const [wedding, setWedding] = useState<WeddingInfo | null>(null)
  const [loading, setLoading] = useState(true)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchData = useCallback(async () => {
    const [progressRes, weddingRes] = await Promise.all([
      supabase
        .from('onboarding_progress')
        .select('*')
        .eq('wedding_id', WEDDING_ID)
        .maybeSingle(),
      supabase
        .from('weddings')
        .select('wedding_date, people!people_wedding_id_fkey(first_name, last_name, role)')
        .eq('id', WEDDING_ID)
        .maybeSingle(),
    ])

    if (!progressRes.error && progressRes.data) {
      setProgress(progressRes.data as OnboardingProgress)
    }
    if (!weddingRes.error && weddingRes.data) {
      const wd = weddingRes.data as {
        wedding_date: string | null
        people: { first_name: string; last_name: string; role: string }[]
      }
      const partner1 = wd.people?.find((p) => p.role === 'partner1')
      const partner2 = wd.people?.find((p) => p.role === 'partner2')
      setWedding({
        wedding_date: wd.wedding_date,
        partner1_name: partner1 ? partner1.first_name : null,
        partner2_name: partner2 ? partner2.first_name : null,
      })
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Completion tracking ----
  const completedSteps = useMemo(() => {
    if (!progress) return new Set<string>()
    const done = new Set<string>()
    if (progress.couple_photo_uploaded) done.add('couple_photo_uploaded')
    if (progress.first_message_sent) done.add('first_message_sent')
    if (progress.vendor_added) done.add('vendor_added')
    if (progress.inspo_uploaded) done.add('inspo_uploaded')
    if (progress.checklist_item_completed) done.add('checklist_item_completed')
    return done
  }, [progress])

  const completedCount = completedSteps.size
  const totalSteps = ACTION_CARDS.length
  const allComplete = completedCount === totalSteps

  // ---- Weeks until wedding ----
  const weeksUntilWedding = useMemo(() => {
    if (!wedding?.wedding_date) return null
    return Math.max(
      0,
      Math.ceil(
        (new Date(wedding.wedding_date).getTime() - Date.now()) / (7 * 24 * 60 * 60 * 1000)
      )
    )
  }, [wedding])

  // ---- Get the right nudge bucket ----
  const currentNudge = useMemo(() => {
    if (weeksUntilWedding === null) return NUDGE_BUCKETS[0] // default to "Dream"
    for (let i = NUDGE_BUCKETS.length - 1; i >= 0; i--) {
      if (weeksUntilWedding >= NUDGE_BUCKETS[i].minWeeks) {
        return NUDGE_BUCKETS[i]
      }
    }
    return NUDGE_BUCKETS[NUDGE_BUCKETS.length - 1]
  }, [weeksUntilWedding])

  // ---- Greeting ----
  const greeting = useMemo(() => {
    if (wedding?.partner1_name && wedding?.partner2_name) {
      return `Welcome, ${wedding.partner1_name} & ${wedding.partner2_name}`
    }
    return 'Welcome to your wedding portal'
  }, [wedding])

  // ---- Build couple slug for links (simplified) ----
  const coupleSlug = 'demo' // TODO: get from router params

  // ---- Loading ----
  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-10 bg-gray-100 rounded-lg w-64 animate-pulse" />
        <div className="flex justify-center py-8">
          <div className="w-[120px] h-[120px] bg-gray-100 rounded-full animate-pulse" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-40 bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* ------------------------------------------------------------------ */}
      {/* Header */}
      {/* ------------------------------------------------------------------ */}
      <div className="text-center">
        <h1
          className="text-3xl font-bold mb-2"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary, #7D8471)' }}
        >
          {greeting}
        </h1>
        <p className="text-gray-500 text-sm max-w-md mx-auto">
          {weeksUntilWedding !== null
            ? `${weeksUntilWedding} weeks until your big day. Let\u2019s make them count.`
            : 'Your planning journey starts right here. Take it one step at a time.'}
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Progress Ring */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-col items-center gap-2">
        <ProgressRing completed={completedCount} total={totalSteps} />
        <p className="text-sm text-gray-500">
          {completedCount === 0
            ? 'Let\u2019s get you started'
            : completedCount < totalSteps
              ? `${completedCount} of ${totalSteps} steps complete \u2014 nice work!`
              : 'All steps complete \u2014 you\u2019re on your way!'}
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* All Complete Celebration */}
      {/* ------------------------------------------------------------------ */}
      {allComplete && (
        <div
          className="bg-white rounded-xl border-2 shadow-md p-6 text-center"
          style={{ borderColor: 'var(--couple-primary, #7D8471)' }}
        >
          <div className="flex justify-center mb-3">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center"
              style={{ backgroundColor: 'color-mix(in srgb, var(--couple-primary, #7D8471) 12%, transparent)' }}
            >
              <PartyPopper className="w-7 h-7" style={{ color: 'var(--couple-primary, #7D8471)' }} />
            </div>
          </div>
          <h2
            className="text-xl font-bold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary, #7D8471)' }}
          >
            You are off to an amazing start!
          </h2>
          <p className="text-gray-500 text-sm mb-4 max-w-sm mx-auto">
            You have completed all five getting-started steps. Your portal is ready for the real planning to begin.
          </p>
          <a
            href={`/couple/${coupleSlug}/checklist`}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-white text-sm font-medium transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
          >
            Explore your full portal
            <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Action Cards */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid gap-4 sm:grid-cols-2">
        {ACTION_CARDS.map((card) => {
          const done = completedSteps.has(card.id)
          const CardIcon = card.icon

          return (
            <div
              key={card.id}
              className={cn(
                'relative bg-white rounded-xl border shadow-sm overflow-hidden transition-all duration-200 hover:shadow-md group',
                done ? 'border-emerald-200' : 'border-gray-100'
              )}
            >
              {/* Completed indicator */}
              {done && (
                <div className="absolute top-3 right-3 z-10">
                  <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center shadow-sm">
                    <Check className="w-3.5 h-3.5 text-white" />
                  </div>
                </div>
              )}

              <div className="p-5">
                {/* Emoji + Title */}
                <div className="flex items-start gap-3 mb-3">
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-xl"
                    style={{
                      backgroundColor: done
                        ? '#ECFDF5'
                        : 'color-mix(in srgb, var(--couple-primary, #7D8471) 10%, transparent)',
                    }}
                  >
                    {card.emoji}
                  </div>
                  <div className="min-w-0">
                    <h3 className={cn(
                      'font-semibold text-[15px] leading-tight',
                      done ? 'text-emerald-700' : 'text-gray-800'
                    )}>
                      {card.title}
                    </h3>
                  </div>
                </div>

                {/* Description */}
                <p className="text-sm text-gray-500 leading-relaxed mb-4">
                  {card.description}
                </p>

                {/* Action Button */}
                <a
                  href={`/couple/${coupleSlug}/${card.path}`}
                  className={cn(
                    'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all',
                    done
                      ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                      : 'text-white hover:opacity-90'
                  )}
                  style={!done ? { backgroundColor: 'var(--couple-primary, #7D8471)' } : undefined}
                >
                  <CardIcon className="w-4 h-4" />
                  {done ? 'Done! View again' : card.actionLabel}
                  <ChevronRight className="w-3.5 h-3.5 opacity-60" />
                </a>
              </div>
            </div>
          )
        })}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Time-Bucket Nudge Section */}
      {/* ------------------------------------------------------------------ */}
      {currentNudge && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {/* Nudge Header */}
          <div
            className="px-5 py-4 border-b"
            style={{
              borderColor: 'color-mix(in srgb, var(--couple-primary, #7D8471) 15%, transparent)',
              backgroundColor: 'color-mix(in srgb, var(--couple-primary, #7D8471) 4%, transparent)',
            }}
          >
            <div className="flex items-center gap-3">
              <span className="text-2xl">{currentNudge.emoji}</span>
              <div>
                <h2
                  className="font-semibold text-base"
                  style={{ color: 'var(--couple-primary, #7D8471)' }}
                >
                  {currentNudge.title}
                </h2>
                <p className="text-sm text-gray-500">{currentNudge.description}</p>
              </div>
            </div>
          </div>

          {/* Tips */}
          <div className="p-5">
            <ul className="space-y-3">
              {currentNudge.tips.map((tip, i) => (
                <li key={i} className="flex items-start gap-3">
                  <div
                    className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                    style={{ backgroundColor: 'color-mix(in srgb, var(--couple-primary, #7D8471) 12%, transparent)' }}
                  >
                    <span
                      className="text-[10px] font-bold"
                      style={{ color: 'var(--couple-primary, #7D8471)' }}
                    >
                      {i + 1}
                    </span>
                  </div>
                  <span className="text-sm text-gray-600 leading-relaxed">{tip}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Weeks indicator */}
          {weeksUntilWedding !== null && (
            <div
              className="px-5 py-3 border-t text-center"
              style={{
                borderColor: 'color-mix(in srgb, var(--couple-primary, #7D8471) 10%, transparent)',
                backgroundColor: 'color-mix(in srgb, var(--couple-primary, #7D8471) 2%, transparent)',
              }}
            >
              <span className="text-xs text-gray-400">
                Based on your wedding date &mdash; {weeksUntilWedding} {weeksUntilWedding === 1 ? 'week' : 'weeks'} to go
              </span>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Bottom CTA */}
      {/* ------------------------------------------------------------------ */}
      <div className="text-center pb-4">
        <p className="text-sm text-gray-400 mb-3">
          Questions? Your venue coordinator and Sage are always here to help.
        </p>
        <a
          href={`/couple/${coupleSlug}/chat`}
          className="inline-flex items-center gap-2 text-sm font-medium hover:underline"
          style={{ color: 'var(--couple-primary, #7D8471)' }}
        >
          <MessageCircle className="w-4 h-4" />
          Chat with Sage
        </a>
      </div>
    </div>
  )
}
