'use client'

/**
 * Action chip displayed above the journey ribbon.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §6 Don't skip #3
 *   "I will skip the top-line action chip because 'it can come later.'
 *    It can't. Without action affordance, the ribbon is decoration."
 *
 * The chip surfaces the single most useful next action based on:
 *   - lifecycle_state (booked, resolved, channel_scoped, ghost, agent)
 *   - days since the latest inbound progression event
 *   - wedding_date proximity (anniversary affordance)
 *
 * This is a derivation, not a database column. State changes daily
 * as the ribbon ages; we render fresh per page load.
 */

import {
  ArrowRight,
  Calendar,
  Heart,
  Mail,
  RefreshCw,
  Send,
  Sparkles,
} from 'lucide-react'

interface ActionChipInputs {
  lifecycle_state: string | null
  last_progression_at: string | null
  wedding_date: string | null
}

interface ActionChip {
  label: string
  detail: string | null
  tone: 'go' | 'consider' | 'reflect' | 'quiet'
  Icon: typeof ArrowRight
}

function daysBetween(later: number, earlier: number): number {
  return Math.floor((later - earlier) / 86_400_000)
}

export function deriveActionChip(input: ActionChipInputs): ActionChip {
  const now = Date.now()
  const lastProg = input.last_progression_at
    ? Date.parse(input.last_progression_at)
    : null
  const wedding = input.wedding_date ? Date.parse(input.wedding_date) : null
  const sinceLast = lastProg !== null ? daysBetween(now, lastProg) : null
  const daysToWedding = wedding !== null ? daysBetween(wedding, now) : null

  // Anniversary affordance overrides everything when within 30 days.
  if (wedding !== null) {
    const daysSinceWedding = daysBetween(now, wedding)
    if (daysSinceWedding >= 335 && daysSinceWedding <= 395) {
      return {
        label: 'Anniversary touchpoint',
        detail: 'Wedding anniversary within 30 days. Send something.',
        tone: 'go',
        Icon: Heart,
      }
    }
  }

  if (input.lifecycle_state === 'booked') {
    if (daysToWedding !== null && daysToWedding > 0 && daysToWedding <= 60) {
      return {
        label: 'Pre-wedding checkin',
        detail: `Wedding in ${daysToWedding} days. Final-details email.`,
        tone: 'go',
        Icon: Calendar,
      }
    }
    return {
      label: 'Booked',
      detail: 'Live booking. No action needed.',
      tone: 'quiet',
      Icon: Sparkles,
    }
  }

  if (input.lifecycle_state === 'ghost') {
    return {
      label: 'Refer to alumni',
      detail: 'Past decay. Re-engage at anniversary or referral.',
      tone: 'reflect',
      Icon: Heart,
    }
  }

  if (input.lifecycle_state === 'agent') {
    return {
      label: 'Agent — group reply',
      detail: 'Planner / parent representing multiple couples.',
      tone: 'consider',
      Icon: Send,
    }
  }

  // Active live person: gate on inbound recency
  if (sinceLast === null) {
    return {
      label: 'Offer tour',
      detail: 'Fresh contact, no inbound recorded yet.',
      tone: 'go',
      Icon: Calendar,
    }
  }

  if (sinceLast <= 3) {
    return {
      label: 'Reply now',
      detail: `Last inbound ${sinceLast === 0 ? 'today' : `${sinceLast}d ago`}. Reply window.`,
      tone: 'go',
      Icon: Mail,
    }
  }

  if (sinceLast <= 14) {
    return {
      label: 'Send pricing or tour',
      detail: `Last inbound ${sinceLast}d ago. Move them forward.`,
      tone: 'go',
      Icon: Send,
    }
  }

  if (sinceLast <= 45) {
    return {
      label: 'Re-engage',
      detail: `${sinceLast}d quiet. Soft touchpoint before they cool.`,
      tone: 'consider',
      Icon: RefreshCw,
    }
  }

  if (sinceLast <= 120) {
    return {
      label: 'Cooling — last touch',
      detail: `${sinceLast}d quiet. One more reach before Ghost.`,
      tone: 'reflect',
      Icon: ArrowRight,
    }
  }

  return {
    label: 'Past — recover only on signal',
    detail: `${sinceLast}d quiet. Decay imminent.`,
    tone: 'reflect',
    Icon: ArrowRight,
  }
}

function toneClass(tone: ActionChip['tone']): string {
  switch (tone) {
    case 'go':
      return 'border-emerald-300 bg-emerald-50 text-emerald-900'
    case 'consider':
      return 'border-amber-300 bg-amber-50 text-amber-900'
    case 'reflect':
      return 'border-stone-300 bg-stone-50 text-stone-700'
    case 'quiet':
      return 'border-sky-200 bg-sky-50 text-sky-800'
  }
}

export function JourneyActionChip({ input }: { input: ActionChipInputs }) {
  const chip = deriveActionChip(input)
  const Icon = chip.Icon
  return (
    <div
      className={`flex items-start gap-2 rounded-md border px-3 py-2 ${toneClass(chip.tone)}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="text-sm">
        <div className="font-medium">{chip.label}</div>
        {chip.detail && <div className="text-xs opacity-80">{chip.detail}</div>}
      </div>
    </div>
  )
}
