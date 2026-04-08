'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Clock,
  Plus,
  X,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  Save,
  Sun,
  Sunset,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Edit2,
  AlertCircle,
  Check,
  RotateCcw,
  Eye,
  EyeOff,
  StickyNote,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TimelineEvent {
  id: string
  name: string
  icon: string
  defaultDuration: number
  duration: number
  description: string
  tips?: string
  included: boolean
  time: string
  manualTime: boolean
  isTimeMarker?: boolean
  isAnchor?: boolean
  alwaysIncluded?: boolean
  canBeConcurrent?: boolean
  canChooseTiming?: boolean
  chain?: string
  notes: string
  phase: string
  // For formalities: 'before' | 'after' dinner
  formalityTiming?: 'before' | 'after'
  // For first-look conditional events
  requiresFirstLook?: boolean
  // Conditional on off-site ceremony
  requiresOffsite?: boolean
  // Duration in cocktail-hour mode (no first look)
  cocktailDuration?: number
}

type DinnerType = 'buffet' | 'plated' | 'multi_course'
type FormalitiesTiming = 'before' | 'after'

interface TimelineConfig {
  ceremonyTime: string
  receptionEndTime: string
  dinnerType: DinnerType
  doingFirstLook: boolean
  offSiteCeremony: boolean
  autoCalculate: boolean
  formalitiesTiming: FormalitiesTiming
  weddingDate: string | null
  latitude: number
}

interface CustomEvent {
  id: string
  name: string
  time: string
  duration: number
  notes: string
  phase: string
  icon: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DINNER_DURATIONS: Record<DinnerType, number> = {
  buffet: 60,
  plated: 90,
  multi_course: 120,
}

const DINNER_LABELS: Record<DinnerType, string> = {
  buffet: 'Buffet (60 min)',
  plated: 'Plated (90 min)',
  multi_course: 'Multi-Course (120 min)',
}

const PHASE_ORDER = [
  'preparation',
  'first_look',
  'photos',
  'pre_ceremony',
  'ceremony',
  'cocktail_hour',
  'reception_intro',
  'formalities_before',
  'dinner',
  'formalities_after',
  'end',
]

const PHASE_LABELS: Record<string, string> = {
  preparation: 'Preparation',
  first_look: 'First Look',
  photos: 'Photos',
  pre_ceremony: 'Pre-Ceremony',
  ceremony: 'Ceremony',
  cocktail_hour: 'Cocktail Hour',
  reception_intro: 'Reception Intro',
  formalities_before: 'Formalities (Before Dinner)',
  dinner: 'Dinner',
  formalities_after: 'Formalities (After Dinner)',
  end: 'End of Night',
}

const PHASE_ICONS: Record<string, string> = {
  preparation: '💄',
  first_look: '👀',
  photos: '📸',
  pre_ceremony: '🚐',
  ceremony: '💒',
  cocktail_hour: '🥂',
  reception_intro: '🎉',
  formalities_before: '🎵',
  dinner: '🍽️',
  formalities_after: '🎵',
  end: '🌟',
}

const PHASE_COLORS: Record<string, string> = {
  preparation: '#EC4899',
  first_look: '#F97316',
  photos: '#3B82F6',
  pre_ceremony: '#8B5CF6',
  ceremony: '#7C3AED',
  cocktail_hour: '#F59E0B',
  reception_intro: '#10B981',
  formalities_before: '#6366F1',
  dinner: '#14B8A6',
  formalities_after: '#6366F1',
  end: '#EF4444',
}

// ---------------------------------------------------------------------------
// Default Event Definitions
// ---------------------------------------------------------------------------

function buildDefaultEvents(config: TimelineConfig): TimelineEvent[] {
  const dinnerDuration = DINNER_DURATIONS[config.dinnerType]

  return [
    // ===== PREPARATION =====
    {
      id: 'prep_hmu_complete',
      name: 'Hair & Makeup Complete',
      icon: '💄',
      defaultDuration: 0,
      duration: 0,
      description: 'Everyone is camera-ready',
      tips: 'Build in 30 min buffer — things always run long. Hydrate and eat before photos start.',
      included: true,
      time: '',
      manualTime: false,
      isTimeMarker: true,
      isAnchor: true,
      alwaysIncluded: true,
      phase: 'preparation',
      notes: '',
    },
    {
      id: 'prep_buffer',
      name: 'Buffer / Lunch Break',
      icon: '🥪',
      defaultDuration: 30,
      duration: 30,
      description: 'Eat something, hydrate, take a breath',
      tips: 'You will thank yourself later. Have sandwiches or wraps — nothing messy.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'preparation',
      notes: '',
    },
    {
      id: 'prep_party_dressed',
      name: 'Bridesmaids & Groomsmen Get Dressed',
      icon: '👗',
      defaultDuration: 30,
      duration: 30,
      description: 'Wedding party gets into their outfits',
      tips: 'Have a designated room for each side. Keep it tidy for photos.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'preparation',
      notes: '',
    },
    {
      id: 'prep_bride_dressed',
      name: 'Bride Gets Dressed',
      icon: '👰',
      defaultDuration: 30,
      duration: 30,
      description: 'The dress moment — one of the best photo opportunities',
      tips: 'Keep the room bright, clean, and uncluttered. Only a few people in the room.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'preparation',
      notes: '',
    },
    {
      id: 'prep_groom_photos',
      name: 'Groom Getting Ready Photos',
      icon: '🤵',
      defaultDuration: 30,
      duration: 30,
      description: 'Groom and groomsmen candid + posed shots',
      tips: 'Ties, cufflinks, flask moments — let the photographer capture the mood.',
      included: true,
      time: '',
      manualTime: false,
      canBeConcurrent: true,
      phase: 'preparation',
      notes: '',
    },
    {
      id: 'prep_bride_photos',
      name: 'Bride Getting Ready Photos',
      icon: '📸',
      defaultDuration: 30,
      duration: 30,
      description: 'Bride getting dressed, earrings, veil, shoes',
      tips: 'The "reveal" to bridesmaids is a great candid moment. Have them face away.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'preparation',
      notes: '',
    },
    {
      id: 'prep_details',
      name: 'Details Photos',
      icon: '💍',
      defaultDuration: 20,
      duration: 20,
      description: 'Rings, shoes, invitations, flowers, perfume, jewelry',
      tips: 'Have all details laid out on a flat surface with good light. Photographer needs 15-20 min.',
      included: true,
      time: '',
      manualTime: false,
      canBeConcurrent: true,
      phase: 'preparation',
      notes: '',
    },

    // ===== FIRST LOOK (conditional) =====
    {
      id: 'fl_dad',
      name: 'First Look with Dad',
      icon: '🥲',
      defaultDuration: 10,
      duration: 10,
      description: 'An emotional private moment — just dad and the bride',
      tips: 'Keep it intimate. Only the photographer. Have tissues ready.',
      included: config.doingFirstLook,
      time: '',
      manualTime: false,
      requiresFirstLook: true,
      phase: 'first_look',
      notes: '',
    },
    {
      id: 'fl_partner',
      name: 'First Look with Partner',
      icon: '💕',
      defaultDuration: 15,
      duration: 15,
      description: 'See each other for the first time before the ceremony',
      tips: 'Choose a private, photogenic spot. Let the photographer position you for the reveal.',
      included: config.doingFirstLook,
      time: '',
      manualTime: false,
      requiresFirstLook: true,
      phase: 'first_look',
      notes: '',
    },
    {
      id: 'fl_vows',
      name: 'Private Vows',
      icon: '📝',
      defaultDuration: 15,
      duration: 15,
      description: 'Read personal vows privately before the ceremony',
      tips: 'Incredibly intimate. Many couples say this was their favorite moment of the day.',
      included: false,
      time: '',
      manualTime: false,
      requiresFirstLook: true,
      phase: 'first_look',
      notes: '',
    },

    // ===== PHOTOS =====
    {
      id: 'photo_couple',
      name: 'Couple Portraits',
      icon: '📷',
      defaultDuration: 30,
      duration: config.doingFirstLook ? 30 : 15,
      cocktailDuration: 15,
      description: 'Just the two of you — the hero shots of the day',
      tips: 'Best light is 1-2 hours before sunset. Trust your photographer on locations.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'photos',
      notes: '',
    },
    {
      id: 'photo_party',
      name: 'Wedding Party Photos',
      icon: '👯',
      defaultDuration: 30,
      duration: config.doingFirstLook ? 30 : 20,
      cocktailDuration: 20,
      description: 'Group shots with your bridesmaids, groomsmen, or mixed crew',
      tips: 'Have your party gathered and ready. The more organized, the faster this goes.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'photos',
      notes: '',
    },
    {
      id: 'photo_family_immediate',
      name: 'Immediate Family Photos',
      icon: '👨‍👩‍👧‍👦',
      defaultDuration: 30,
      duration: config.doingFirstLook ? 30 : 15,
      cocktailDuration: 15,
      description: 'Parents, siblings, grandparents — the must-have shots',
      tips: 'Create a shot list in advance. Designate a family wrangler — it saves huge time.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'photos',
      notes: '',
    },
    {
      id: 'photo_family_extended',
      name: 'Extended Family Photos',
      icon: '👥',
      defaultDuration: 20,
      duration: config.doingFirstLook ? 20 : 10,
      cocktailDuration: 10,
      description: 'Aunts, uncles, cousins — the big group shots',
      tips: 'Keep it moving. These go fastest with a clear list and someone calling names.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'photos',
      notes: '',
    },

    // ===== PRE-CEREMONY =====
    {
      id: 'precer_put_away',
      name: 'Put Bride Away',
      icon: '🚪',
      defaultDuration: 30,
      duration: 30,
      description: 'Bride hidden from guests before the ceremony',
      tips: 'Final touch-ups, veil adjusted, bouquet ready. A moment to breathe.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'pre_ceremony',
      notes: '',
    },
    {
      id: 'precer_shuttle',
      name: 'Last Shuttle Arrives',
      icon: '🚌',
      defaultDuration: 0,
      duration: 0,
      description: 'All guests have arrived on-site',
      tips: 'Coordinate with your shuttle company for exact arrival time.',
      included: true,
      time: '',
      manualTime: false,
      isTimeMarker: true,
      phase: 'pre_ceremony',
      notes: '',
    },
    {
      id: 'precer_travel',
      name: 'Travel to Ceremony',
      icon: '🚗',
      defaultDuration: 30,
      duration: 30,
      description: 'Transit time if ceremony is at a different location',
      tips: 'Account for traffic and allow extra time. Better early than stressed.',
      included: config.offSiteCeremony,
      time: '',
      manualTime: false,
      requiresOffsite: true,
      phase: 'pre_ceremony',
      notes: '',
    },

    // ===== CEREMONY =====
    {
      id: 'cer_arrival',
      name: 'Guest Arrival',
      icon: '🚶',
      defaultDuration: 30,
      duration: 30,
      description: 'Guests arrive and find their seats',
      tips: 'Play background music. Have ushers ready to seat people and hand out programs.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'ceremony',
      notes: '',
    },
    {
      id: 'cer_music',
      name: 'Ceremony Music Begins',
      icon: '🎶',
      defaultDuration: 15,
      duration: 15,
      description: 'Prelude music sets the mood before the processional',
      tips: 'Choose 3-4 songs that reflect your style. Sets the emotional tone.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'ceremony',
      notes: '',
    },
    {
      id: 'cer_ceremony',
      name: 'Ceremony',
      icon: '💒',
      defaultDuration: 25,
      duration: 25,
      description: 'The main event — processional, vows, rings, kiss',
      tips: 'Most ceremonies last 20-30 minutes. Discuss timing with your officiant.',
      included: true,
      time: '',
      manualTime: false,
      isAnchor: true,
      alwaysIncluded: true,
      phase: 'ceremony',
      notes: '',
    },
    {
      id: 'cer_group_photo',
      name: 'Big Group Photo',
      icon: '📸',
      defaultDuration: 5,
      duration: 5,
      description: 'One big photo with everyone right after the ceremony',
      tips: 'Quick and efficient — one or two shots while everyone is still gathered.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'ceremony',
      notes: '',
    },
    {
      id: 'cer_travel_back',
      name: 'Travel Back',
      icon: '🚗',
      defaultDuration: 30,
      duration: 30,
      description: 'Transit back to reception venue',
      tips: 'Use this time to decompress. Grab a snack in the car.',
      included: config.offSiteCeremony,
      time: '',
      manualTime: false,
      requiresOffsite: true,
      phase: 'ceremony',
      notes: '',
    },

    // ===== COCKTAIL HOUR =====
    {
      id: 'cock_cocktail',
      name: 'Cocktail Hour',
      icon: '🥂',
      defaultDuration: 50,
      duration: 50,
      description: 'Guests mingle, enjoy drinks and appetizers',
      tips: 'This is the transition. Space turns over, guests relax. Great for lawn games.',
      included: true,
      time: '',
      manualTime: false,
      alwaysIncluded: true,
      phase: 'cocktail_hour',
      notes: '',
    },
    {
      id: 'cock_remaining_photos',
      name: 'Remaining Photos',
      icon: '📷',
      defaultDuration: 15,
      duration: 15,
      description: 'Any remaining formal photos during cocktail hour',
      tips: 'If you did a first look, this is lighter. If not, this is your main photo block.',
      included: true,
      time: '',
      manualTime: false,
      canBeConcurrent: true,
      phase: 'cocktail_hour',
      notes: '',
    },
    {
      id: 'cock_break',
      name: 'Couple Break',
      icon: '💑',
      defaultDuration: 15,
      duration: 15,
      description: 'Steal 15 minutes to eat, drink, and breathe together',
      tips: 'You deserve this. Have your coordinator bring you a plate and a drink.',
      included: true,
      time: '',
      manualTime: false,
      canBeConcurrent: true,
      phase: 'cocktail_hour',
      notes: '',
    },
    {
      id: 'cock_sunset',
      name: 'Sunset / Golden Hour Photos',
      icon: '🌅',
      defaultDuration: 20,
      duration: 20,
      description: 'The most magical light of the day — auto-timed to sunset',
      tips: 'Golden hour is 30 min before sunset. Your photographer will know exactly when to grab you.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'cocktail_hour',
      notes: '',
    },

    // ===== RECEPTION INTRO =====
    {
      id: 'rec_doors',
      name: 'Doors Open',
      icon: '🚪',
      defaultDuration: 10,
      duration: 10,
      description: 'Guests find their seats, check the seating chart',
      tips: 'Have a clear seating chart at the entrance. Escort cards speed things up.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'reception_intro',
      notes: '',
    },
    {
      id: 'rec_entrance',
      name: 'Grand Entrance / Introductions',
      icon: '🎉',
      defaultDuration: 5,
      duration: 5,
      description: 'Wedding party and couple are introduced',
      tips: 'Pick a hype song! Coordinate pronunciation with your DJ/MC beforehand.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'reception_intro',
      notes: '',
    },
    {
      id: 'rec_welcome',
      name: 'Welcome & Blessing',
      icon: '🙏',
      defaultDuration: 5,
      duration: 5,
      description: 'Brief welcome, blessing, or toast to kick off the reception',
      tips: 'Keep it under 3 minutes. Thank everyone for being there.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'reception_intro',
      notes: '',
    },

    // ===== FORMALITIES =====
    {
      id: 'form_first_dance',
      name: 'First Dance',
      icon: '💃',
      defaultDuration: 5,
      duration: 5,
      description: 'Your first dance as a married couple',
      tips: 'Practice at least a few times! Even if not choreographed, know the song length.',
      included: true,
      time: '',
      manualTime: false,
      canChooseTiming: true,
      formalityTiming: config.formalitiesTiming,
      phase: config.formalitiesTiming === 'before' ? 'formalities_before' : 'formalities_after',
      notes: '',
    },
    {
      id: 'form_parent_dances',
      name: 'Parent Dances',
      icon: '👨‍👧',
      defaultDuration: 5,
      duration: 5,
      description: 'Mother-son and father-daughter dances',
      tips: 'Can be combined (both dances at the same time) to save time and energy.',
      included: true,
      time: '',
      manualTime: false,
      canChooseTiming: true,
      formalityTiming: config.formalitiesTiming,
      phase: config.formalitiesTiming === 'before' ? 'formalities_before' : 'formalities_after',
      notes: '',
    },
    {
      id: 'form_toasts',
      name: 'Toasts & Speeches',
      icon: '🥂',
      defaultDuration: 15,
      duration: 15,
      description: 'Best man, maid of honor, and family speeches',
      tips: 'Limit to 2-3 speakers, 3-5 minutes each. Brief them early so they do not go long.',
      included: true,
      time: '',
      manualTime: false,
      canChooseTiming: true,
      formalityTiming: config.formalitiesTiming,
      phase: config.formalitiesTiming === 'before' ? 'formalities_before' : 'formalities_after',
      notes: '',
    },
    {
      id: 'form_cake',
      name: 'Cake Cutting',
      icon: '🎂',
      defaultDuration: 10,
      duration: 10,
      description: 'The classic cake cutting moment',
      tips: 'Quick and sweet. Photographer needs just a few minutes. Dessert can be served later.',
      included: true,
      time: '',
      manualTime: false,
      canChooseTiming: true,
      formalityTiming: config.formalitiesTiming,
      phase: config.formalitiesTiming === 'before' ? 'formalities_before' : 'formalities_after',
      notes: '',
    },
    {
      id: 'form_anniversary',
      name: 'Anniversary Dance',
      icon: '💞',
      defaultDuration: 5,
      duration: 5,
      description: 'All married couples dance — last couple standing wins',
      tips: 'Fun crowd participation moment. DJ calls out years and couples sit down.',
      included: false,
      time: '',
      manualTime: false,
      canChooseTiming: true,
      formalityTiming: config.formalitiesTiming,
      phase: config.formalitiesTiming === 'before' ? 'formalities_before' : 'formalities_after',
      notes: '',
    },
    {
      id: 'form_newlywed_game',
      name: 'Newlywed Game',
      icon: '🎮',
      defaultDuration: 5,
      duration: 5,
      description: 'Fun Q&A game for the couple — guests love it',
      tips: 'Prepare 5-7 questions in advance. Keep it light and funny.',
      included: false,
      time: '',
      manualTime: false,
      canChooseTiming: true,
      formalityTiming: config.formalitiesTiming,
      phase: config.formalitiesTiming === 'before' ? 'formalities_before' : 'formalities_after',
      notes: '',
    },
    {
      id: 'form_bouquet',
      name: 'Bouquet Toss',
      icon: '💐',
      defaultDuration: 5,
      duration: 5,
      description: 'The classic bouquet toss to unmarried guests',
      tips: 'Have DJ announce it so people gather. Some couples skip this — totally fine.',
      included: false,
      time: '',
      manualTime: false,
      canChooseTiming: true,
      formalityTiming: config.formalitiesTiming,
      phase: config.formalitiesTiming === 'before' ? 'formalities_before' : 'formalities_after',
      notes: '',
    },
    {
      id: 'form_garter',
      name: 'Garter Toss',
      icon: '🎯',
      defaultDuration: 5,
      duration: 5,
      description: 'Traditional garter toss',
      tips: 'Increasingly optional — skip if it does not feel like you. No pressure.',
      included: false,
      time: '',
      manualTime: false,
      canChooseTiming: true,
      formalityTiming: config.formalitiesTiming,
      phase: config.formalitiesTiming === 'before' ? 'formalities_before' : 'formalities_after',
      notes: '',
    },

    // ===== DINNER =====
    {
      id: 'dinner_service',
      name: 'Dinner Service',
      icon: '🍽️',
      defaultDuration: dinnerDuration,
      duration: dinnerDuration,
      description: `${DINNER_LABELS[config.dinnerType]}`,
      tips: 'Duration depends on service style and guest count. Buffet is fastest, multi-course is longest.',
      included: true,
      time: '',
      manualTime: false,
      alwaysIncluded: true,
      phase: 'dinner',
      notes: '',
    },

    // ===== END =====
    {
      id: 'end_dancing',
      name: 'Open Dancing Begins',
      icon: '🕺',
      defaultDuration: 0,
      duration: 0,
      description: 'The dance floor opens — let the party begin',
      tips: 'Let your DJ read the room. Request a few must-play songs in advance.',
      included: true,
      time: '',
      manualTime: false,
      isTimeMarker: true,
      phase: 'end',
      notes: '',
    },
    {
      id: 'end_last_dance',
      name: 'Last Dance',
      icon: '🎵',
      defaultDuration: 5,
      duration: 5,
      description: 'A special slow song to close the night',
      tips: 'Some couples invite everyone to the floor. Others keep it private first.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'end',
      notes: '',
    },
    {
      id: 'end_private_last',
      name: 'Private Last Dance',
      icon: '💕',
      defaultDuration: 5,
      duration: 5,
      description: 'Just the two of you on an empty dance floor',
      tips: 'After guests line up for the exit, steal one more song alone. Magical.',
      included: false,
      time: '',
      manualTime: false,
      phase: 'end',
      notes: '',
    },
    {
      id: 'end_exit',
      name: 'Grand Exit / Send-Off',
      icon: '✨',
      defaultDuration: 10,
      duration: 10,
      description: 'Sparklers, bubbles, confetti, or a simple walk-out',
      tips: 'Have everything prepped and distributed before the last dance. Coordinate with your team.',
      included: true,
      time: '',
      manualTime: false,
      phase: 'end',
      notes: '',
    },
  ]
}

// ---------------------------------------------------------------------------
// Sunset Calculation
// ---------------------------------------------------------------------------

function calculateSunset(dateStr: string | null, latitude: number): string | null {
  if (!dateStr) return null

  const date = new Date(dateStr)
  const year = date.getFullYear()
  const month = date.getMonth()
  const day = date.getDate()

  // Day of year
  const start = new Date(year, 0, 0)
  const diff = date.getTime() - start.getTime()
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24))

  // Solar declination (degrees)
  const declination = 23.45 * Math.sin((2 * Math.PI / 365) * (dayOfYear - 81))
  const decRad = declination * (Math.PI / 180)
  const latRad = latitude * (Math.PI / 180)

  // Hour angle at sunset
  const cosHourAngle = -(Math.sin(latRad) * Math.sin(decRad)) / (Math.cos(latRad) * Math.cos(decRad))

  // Check for polar day/night
  if (cosHourAngle > 1 || cosHourAngle < -1) return null

  const hourAngle = Math.acos(cosHourAngle) * (180 / Math.PI)

  // Solar noon in hours (approximate — 12:00 local standard)
  // Equation of time correction (simplified)
  const B = (2 * Math.PI / 365) * (dayOfYear - 81)
  const eqOfTime = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B) // in minutes

  // Sunset time in hours (local standard time, no timezone offset for simplicity)
  const solarNoon = 12 - eqOfTime / 60
  const sunsetHours = solarNoon + hourAngle / 15

  // DST handling (US rules: 2nd Sunday March - 1st Sunday November)
  let isDST = false
  if (month > 2 && month < 10) {
    isDST = true
  } else if (month === 2) {
    // March: DST starts 2nd Sunday
    const firstDay = new Date(year, 2, 1).getDay()
    const secondSunday = firstDay === 0 ? 8 : (14 - firstDay + 1)
    if (day >= secondSunday) isDST = true
  } else if (month === 10) {
    // November: DST ends 1st Sunday
    const firstDay = new Date(year, 10, 1).getDay()
    const firstSunday = firstDay === 0 ? 1 : (7 - firstDay + 1)
    if (day < firstSunday) isDST = true
  }

  let adjustedHours = sunsetHours + (isDST ? 1 : 0)

  // Clamp to 24h
  if (adjustedHours >= 24) adjustedHours -= 24
  if (adjustedHours < 0) adjustedHours += 24

  const h = Math.floor(adjustedHours)
  const m = Math.round((adjustedHours - h) * 60)

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Time Helpers
// ---------------------------------------------------------------------------

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  let totalMins = h * 60 + m + minutes
  if (totalMins < 0) totalMins += 24 * 60
  const newH = Math.floor(totalMins / 60) % 24
  const newM = totalMins % 60
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`
}

function subtractMinutes(time: string, minutes: number): string {
  return addMinutes(time, -minutes)
}

function formatTime12(timeStr: string): string {
  if (!timeStr) return 'TBD'
  const [hours, minutes] = timeStr.split(':').map(Number)
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`
}

function formatDuration(mins: number): string {
  if (mins === 0) return 'marker'
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function minutesToTime(mins: number): string {
  let m = mins
  if (m < 0) m += 24 * 60
  const h = Math.floor(m / 60) % 24
  const min = m % 60
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Auto-Calculation Engine
// ---------------------------------------------------------------------------

function autoCalculateTimes(
  events: TimelineEvent[],
  config: TimelineConfig,
  sunsetTime: string | null,
): TimelineEvent[] {
  const updated = events.map(e => ({ ...e }))

  // Find ceremony event
  const ceremonyIdx = updated.findIndex(e => e.id === 'cer_ceremony')
  if (ceremonyIdx === -1) return updated

  // Set ceremony time
  if (!updated[ceremonyIdx].manualTime) {
    updated[ceremonyIdx].time = config.ceremonyTime
  }

  // ================================================================
  // WORK BACKWARDS from ceremony for prep phases
  // ================================================================

  // Gather all events BEFORE ceremony (included, sequential) in reverse
  const preCeremonyPhases = ['preparation', 'first_look', 'photos', 'pre_ceremony', 'ceremony']
  const preCeremonyEvents = updated.filter(
    e => preCeremonyPhases.includes(e.phase) && e.included && e.id !== 'cer_ceremony'
  )

  // Ceremony-phase events before the ceremony itself
  const ceremonyPhaseEvents = ['cer_arrival', 'cer_music']
  const postCeremonyPhaseEvents = ['cer_group_photo', 'cer_travel_back']

  // Calculate backward from ceremony time
  let backwardTime = timeToMinutes(config.ceremonyTime)

  // Guest arrival and music are before ceremony
  const musicEvent = updated.find(e => e.id === 'cer_music')
  const arrivalEvent = updated.find(e => e.id === 'cer_arrival')

  if (musicEvent && musicEvent.included && !musicEvent.manualTime) {
    backwardTime -= musicEvent.duration
    musicEvent.time = minutesToTime(backwardTime)
  }
  if (arrivalEvent && arrivalEvent.included && !arrivalEvent.manualTime) {
    backwardTime -= arrivalEvent.duration
    arrivalEvent.time = minutesToTime(backwardTime)
  }

  // Pre-ceremony events (travel, shuttle, put away)
  const preCerOrder = ['precer_travel', 'precer_shuttle', 'precer_put_away']
  for (const eid of preCerOrder) {
    const ev = updated.find(e => e.id === eid)
    if (ev && ev.included && !ev.manualTime) {
      backwardTime -= ev.duration
      ev.time = minutesToTime(backwardTime)
    }
  }

  // Photos (before ceremony if first-look, or they happen during cocktail if no first-look)
  if (config.doingFirstLook) {
    const photoOrder = ['photo_family_extended', 'photo_family_immediate', 'photo_party', 'photo_couple']
    for (const eid of photoOrder) {
      const ev = updated.find(e => e.id === eid)
      if (ev && ev.included && !ev.manualTime) {
        backwardTime -= ev.duration
        ev.time = minutesToTime(backwardTime)
      }
    }
  }

  // First look events
  if (config.doingFirstLook) {
    const flOrder = ['fl_vows', 'fl_partner', 'fl_dad']
    for (const eid of flOrder) {
      const ev = updated.find(e => e.id === eid)
      if (ev && ev.included && !ev.manualTime) {
        backwardTime -= ev.duration
        ev.time = minutesToTime(backwardTime)
      }
    }
  }

  // Preparation events (work backwards)
  const prepOrder = [
    'prep_details', 'prep_bride_photos', 'prep_groom_photos',
    'prep_bride_dressed', 'prep_party_dressed', 'prep_buffer', 'prep_hmu_complete',
  ]
  for (const eid of prepOrder) {
    const ev = updated.find(e => e.id === eid)
    if (ev && ev.included && !ev.manualTime) {
      if (ev.canBeConcurrent) {
        // Concurrent events share the time slot of the previous sequential event
        // Just set time to current backward time without subtracting
        ev.time = minutesToTime(backwardTime)
      } else {
        backwardTime -= ev.duration
        ev.time = minutesToTime(backwardTime)
      }
    }
  }

  // ================================================================
  // WORK FORWARDS from ceremony for post-ceremony events
  // ================================================================

  let forwardTime = timeToMinutes(config.ceremonyTime)
  // Add ceremony duration
  const ceremony = updated.find(e => e.id === 'cer_ceremony')
  if (ceremony) forwardTime += ceremony.duration

  // Post-ceremony events in ceremony phase
  for (const eid of postCeremonyPhaseEvents) {
    const ev = updated.find(e => e.id === eid)
    if (ev && ev.included && !ev.manualTime) {
      ev.time = minutesToTime(forwardTime)
      forwardTime += ev.duration
    }
  }

  // Cocktail hour
  const cocktailOrder = ['cock_cocktail', 'cock_remaining_photos', 'cock_break', 'cock_sunset']
  for (const eid of cocktailOrder) {
    const ev = updated.find(e => e.id === eid)
    if (ev && ev.included && !ev.manualTime) {
      if (eid === 'cock_sunset' && sunsetTime) {
        // Schedule sunset photos 20 min before sunset
        const sunsetMins = timeToMinutes(sunsetTime)
        ev.time = minutesToTime(sunsetMins - 20)
      } else if (ev.canBeConcurrent) {
        // Concurrent with cocktail hour — same start time as cocktail
        const cocktail = updated.find(e => e.id === 'cock_cocktail')
        if (cocktail && cocktail.time) {
          ev.time = cocktail.time
        }
      } else {
        ev.time = minutesToTime(forwardTime)
        forwardTime += ev.duration
      }
    }
  }

  // If no first look, photos happen during cocktail hour
  if (!config.doingFirstLook) {
    const cocktailStart = updated.find(e => e.id === 'cock_cocktail')
    if (cocktailStart && cocktailStart.time) {
      let photoTime = timeToMinutes(cocktailStart.time)
      const photoOrder = ['photo_couple', 'photo_party', 'photo_family_immediate', 'photo_family_extended']
      for (const eid of photoOrder) {
        const ev = updated.find(e => e.id === eid)
        if (ev && ev.included && !ev.manualTime) {
          ev.time = minutesToTime(photoTime)
          ev.phase = 'cocktail_hour'
          photoTime += (ev.cocktailDuration || ev.duration)
        }
      }
    }
  }

  // Reception intro
  const introOrder = ['rec_doors', 'rec_entrance', 'rec_welcome']
  for (const eid of introOrder) {
    const ev = updated.find(e => e.id === eid)
    if (ev && ev.included && !ev.manualTime) {
      ev.time = minutesToTime(forwardTime)
      forwardTime += ev.duration
    }
  }

  // Formalities BEFORE dinner
  const formalitiesOrder = [
    'form_first_dance', 'form_parent_dances', 'form_toasts', 'form_cake',
    'form_anniversary', 'form_newlywed_game', 'form_bouquet', 'form_garter',
  ]
  const beforeDinnerFormalities = formalitiesOrder.filter(eid => {
    const ev = updated.find(e => e.id === eid)
    return ev && ev.included && ev.formalityTiming === 'before'
  })
  for (const eid of beforeDinnerFormalities) {
    const ev = updated.find(e => e.id === eid)
    if (ev && !ev.manualTime) {
      ev.time = minutesToTime(forwardTime)
      ev.phase = 'formalities_before'
      forwardTime += ev.duration
    }
  }

  // Dinner
  const dinner = updated.find(e => e.id === 'dinner_service')
  if (dinner && dinner.included && !dinner.manualTime) {
    dinner.time = minutesToTime(forwardTime)
    forwardTime += dinner.duration
  }

  // Formalities AFTER dinner
  const afterDinnerFormalities = formalitiesOrder.filter(eid => {
    const ev = updated.find(e => e.id === eid)
    return ev && ev.included && ev.formalityTiming === 'after'
  })
  for (const eid of afterDinnerFormalities) {
    const ev = updated.find(e => e.id === eid)
    if (ev && !ev.manualTime) {
      ev.time = minutesToTime(forwardTime)
      ev.phase = 'formalities_after'
      forwardTime += ev.duration
    }
  }

  // End events
  // Calculate open dancing duration to fill until reception end
  const receptionEndMins = timeToMinutes(config.receptionEndTime)
  const endEventsOrder = ['end_dancing', 'end_last_dance', 'end_private_last', 'end_exit']
  const endEventsDuration = endEventsOrder.reduce((sum, eid) => {
    const ev = updated.find(e => e.id === eid && e.included && eid !== 'end_dancing')
    return sum + (ev ? ev.duration : 0)
  }, 0)

  for (const eid of endEventsOrder) {
    const ev = updated.find(e => e.id === eid)
    if (ev && ev.included && !ev.manualTime) {
      if (eid === 'end_dancing') {
        ev.time = minutesToTime(forwardTime)
        // Open dancing goes until last dance
        forwardTime = receptionEndMins - endEventsDuration
      } else {
        ev.time = minutesToTime(forwardTime)
        forwardTime += ev.duration
      }
    }
  }

  return updated
}

// ---------------------------------------------------------------------------
// Timeline Page Component
// ---------------------------------------------------------------------------

export default function TimelinePage() {
  // ---- Config state ----
  const [config, setConfig] = useState<TimelineConfig>({
    ceremonyTime: '16:00',
    receptionEndTime: '22:00',
    dinnerType: 'plated',
    doingFirstLook: true,
    offSiteCeremony: false,
    autoCalculate: true,
    formalitiesTiming: 'before',
    weddingDate: null,
    latitude: 38.4,
  })

  // ---- Event state ----
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [customEvents, setCustomEvents] = useState<CustomEvent[]>([])
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set(PHASE_ORDER))
  const [showTips, setShowTips] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [showSummary, setShowSummary] = useState(false)
  const [showCustomModal, setShowCustomModal] = useState(false)
  const [customForm, setCustomForm] = useState<CustomEvent>({
    id: '',
    name: '',
    time: '',
    duration: 15,
    notes: '',
    phase: 'reception_intro',
    icon: '🎯',
  })
  const [notesOpen, setNotesOpen] = useState<Set<string>>(new Set())

  const saveBarRef = useRef<HTMLDivElement>(null)
  const supabase = createClient()

  // ---- Sunset calculation ----
  const sunsetTime = useMemo(() => {
    return calculateSunset(config.weddingDate, config.latitude)
  }, [config.weddingDate, config.latitude])

  // ---- Fetch saved data ----
  const fetchData = useCallback(async () => {
    const [timelineRes, weddingRes] = await Promise.all([
      supabase
        .from('timeline')
        .select('*')
        .eq('wedding_id', WEDDING_ID)
        .maybeSingle(),
      supabase
        .from('weddings')
        .select('wedding_date')
        .eq('id', WEDDING_ID)
        .maybeSingle(),
    ])

    let weddingDate: string | null = null
    if (!weddingRes.error && weddingRes.data) {
      weddingDate = weddingRes.data.wedding_date
    }

    if (!timelineRes.error && timelineRes.data && timelineRes.data.config_json) {
      // Restore saved state
      const saved = timelineRes.data.config_json as {
        config?: TimelineConfig
        events?: TimelineEvent[]
        customEvents?: CustomEvent[]
      }
      if (saved.config) {
        setConfig({ ...saved.config, weddingDate })
      }
      if (saved.events) {
        setEvents(saved.events)
      }
      if (saved.customEvents) {
        setCustomEvents(saved.customEvents)
      }
    } else {
      // Initialize with defaults
      const initConfig = { ...config, weddingDate }
      setConfig(initConfig)
      const defaults = buildDefaultEvents(initConfig)
      if (initConfig.autoCalculate) {
        const sunset = calculateSunset(weddingDate, initConfig.latitude)
        setEvents(autoCalculateTimes(defaults, initConfig, sunset))
      } else {
        setEvents(defaults)
      }
    }

    setLoading(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Recalculate when config changes ----
  useEffect(() => {
    if (loading) return
    if (!config.autoCalculate) return

    setEvents(prev => {
      // Update events based on config changes
      const refreshed = prev.map(e => {
        const copy = { ...e }

        // Update first-look conditional events
        if (copy.requiresFirstLook) {
          copy.included = config.doingFirstLook && copy.included
        }

        // Update off-site conditional events
        if (copy.requiresOffsite) {
          copy.included = config.offSiteCeremony
        }

        // Update dinner duration
        if (copy.id === 'dinner_service') {
          copy.duration = DINNER_DURATIONS[config.dinnerType]
          copy.description = DINNER_LABELS[config.dinnerType]
        }

        // Update photo durations based on first-look mode
        if (copy.cocktailDuration !== undefined) {
          copy.duration = config.doingFirstLook ? copy.defaultDuration : copy.cocktailDuration
        }

        // Update formality phases
        if (copy.canChooseTiming) {
          const timing = copy.formalityTiming || config.formalitiesTiming
          copy.phase = timing === 'before' ? 'formalities_before' : 'formalities_after'
        }

        return copy
      })

      return autoCalculateTimes(refreshed, config, sunsetTime)
    })
    setDirty(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.ceremonyTime, config.receptionEndTime, config.dinnerType, config.doingFirstLook, config.offSiteCeremony, config.formalitiesTiming, config.autoCalculate, sunsetTime])

  // ---- Event handlers ----
  function updateConfig<K extends keyof TimelineConfig>(key: K, value: TimelineConfig[K]) {
    setConfig(prev => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  function toggleEvent(eventId: string) {
    setEvents(prev => {
      const updated = prev.map(e => {
        if (e.id !== eventId) return e
        if (e.alwaysIncluded) return e
        return { ...e, included: !e.included }
      })
      if (config.autoCalculate) {
        return autoCalculateTimes(updated, config, sunsetTime)
      }
      return updated
    })
    setDirty(true)
  }

  function updateEventDuration(eventId: string, duration: number) {
    setEvents(prev => {
      const updated = prev.map(e =>
        e.id === eventId ? { ...e, duration: Math.max(0, duration) } : e
      )
      if (config.autoCalculate) {
        return autoCalculateTimes(updated, config, sunsetTime)
      }
      return updated
    })
    setDirty(true)
  }

  function updateEventTime(eventId: string, time: string) {
    setEvents(prev =>
      prev.map(e =>
        e.id === eventId ? { ...e, time, manualTime: true } : e
      )
    )
    setDirty(true)
  }

  function clearManualTime(eventId: string) {
    setEvents(prev => {
      const updated = prev.map(e =>
        e.id === eventId ? { ...e, manualTime: false } : e
      )
      if (config.autoCalculate) {
        return autoCalculateTimes(updated, config, sunsetTime)
      }
      return updated
    })
    setDirty(true)
  }

  function updateEventNotes(eventId: string, notes: string) {
    setEvents(prev =>
      prev.map(e => e.id === eventId ? { ...e, notes } : e)
    )
    setDirty(true)
  }

  function toggleFormalityTiming(eventId: string) {
    setEvents(prev => {
      const updated: TimelineEvent[] = prev.map(e => {
        if (e.id !== eventId) return e
        const newTiming: 'before' | 'after' = e.formalityTiming === 'before' ? 'after' : 'before'
        return {
          ...e,
          formalityTiming: newTiming,
          phase: newTiming === 'before' ? 'formalities_before' : 'formalities_after',
        }
      })
      if (config.autoCalculate) {
        return autoCalculateTimes(updated, config, sunsetTime)
      }
      return updated
    })
    setDirty(true)
  }

  function togglePhase(phase: string) {
    setExpandedPhases(prev => {
      const next = new Set(prev)
      if (next.has(phase)) next.delete(phase)
      else next.add(phase)
      return next
    })
  }

  function toggleNotes(eventId: string) {
    setNotesOpen(prev => {
      const next = new Set(prev)
      if (next.has(eventId)) next.delete(eventId)
      else next.add(eventId)
      return next
    })
  }

  // ---- Custom events ----
  function addCustomEvent() {
    if (!customForm.name.trim()) return
    const newEvent: CustomEvent = {
      ...customForm,
      id: `custom_${Date.now()}`,
    }
    setCustomEvents(prev => [...prev, newEvent])
    setShowCustomModal(false)
    setCustomForm({
      id: '',
      name: '',
      time: '',
      duration: 15,
      notes: '',
      phase: 'reception_intro',
      icon: '🎯',
    })
    setDirty(true)
  }

  function removeCustomEvent(id: string) {
    setCustomEvents(prev => prev.filter(e => e.id !== id))
    setDirty(true)
  }

  // ---- Save ----
  async function handleSave() {
    setSaving(true)
    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      config_json: {
        config,
        events,
        customEvents,
      },
    }

    const { error } = await supabase
      .from('timeline')
      .upsert(payload, { onConflict: 'wedding_id' })

    if (!error) {
      setDirty(false)
    }
    setSaving(false)
  }

  // ---- Reset to defaults ----
  function resetToDefaults() {
    if (!confirm('Reset all timeline events to defaults? Your customizations will be lost.')) return
    const defaults = buildDefaultEvents(config)
    if (config.autoCalculate) {
      setEvents(autoCalculateTimes(defaults, config, sunsetTime))
    } else {
      setEvents(defaults)
    }
    setCustomEvents([])
    setDirty(true)
  }

  // ---- Computed: group events by phase ----
  const eventsByPhase = useMemo(() => {
    const grouped: Record<string, TimelineEvent[]> = {}
    for (const phase of PHASE_ORDER) {
      grouped[phase] = events.filter(e => e.phase === phase)
    }
    return grouped
  }, [events])

  // ---- Computed: summary stats ----
  const stats = useMemo(() => {
    const included = events.filter(e => e.included)
    const withTime = included.filter(e => e.time)
    if (withTime.length === 0) return null

    const times = withTime.map(e => timeToMinutes(e.time)).sort((a, b) => a - b)
    const startTime = minutesToTime(times[0])

    // Find the actual end — last event time + its duration
    let latestEnd = 0
    for (const e of withTime) {
      const end = timeToMinutes(e.time) + e.duration
      if (end > latestEnd) latestEnd = end
    }
    const endTime = minutesToTime(latestEnd)
    const totalMinutes = latestEnd - times[0]

    return {
      startTime,
      endTime,
      totalMinutes,
      eventCount: included.length,
      concurrentCount: included.filter(e => e.canBeConcurrent).length,
    }
  }, [events])

  // ---- Computed: phases that have events ----
  const activePhases = useMemo(() => {
    return PHASE_ORDER.filter(phase => {
      const phaseEvents = eventsByPhase[phase] || []
      // Show phase if it has included events, or if it has events that could be included
      return phaseEvents.length > 0
    })
  }, [eventsByPhase])

  // ---- Loading ----
  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-10 bg-gray-100 rounded-lg w-64 animate-pulse" />
        <div className="h-32 bg-gray-100 rounded-xl animate-pulse" />
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-20 bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 pb-24">
      {/* ================================================================ */}
      {/* HEADER */}
      {/* ================================================================ */}
      <div>
        <h1
          className="text-3xl font-bold mb-1"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary, #7D8471)' }}
        >
          Your Wedding Timeline
        </h1>
        <p className="text-gray-500 text-sm">
          Map out the flow of your day, from getting ready to the grand exit.
          {sunsetTime && (
            <span className="ml-2 inline-flex items-center gap-1 text-amber-600">
              <Sunset className="w-3.5 h-3.5" />
              Sunset at {formatTime12(sunsetTime)}
            </span>
          )}
        </p>
      </div>

      {/* ================================================================ */}
      {/* CONFIGURATION PANEL */}
      {/* ================================================================ */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <div
          className="px-5 py-3 border-b"
          style={{
            borderColor: 'color-mix(in srgb, var(--couple-primary, #7D8471) 15%, transparent)',
            backgroundColor: 'color-mix(in srgb, var(--couple-primary, #7D8471) 4%, transparent)',
          }}
        >
          <h2
            className="font-semibold text-sm flex items-center gap-2"
            style={{ color: 'var(--couple-primary, #7D8471)' }}
          >
            <Clock className="w-4 h-4" />
            Timeline Settings
          </h2>
        </div>

        <div className="p-5 space-y-4">
          {/* Row 1: Times */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Ceremony Time</label>
              <input
                type="time"
                value={config.ceremonyTime}
                onChange={e => updateConfig('ceremonyTime', e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-opacity-50"
                style={{ '--tw-ring-color': 'var(--couple-primary, #7D8471)' } as React.CSSProperties}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Reception Ends</label>
              <input
                type="time"
                value={config.receptionEndTime}
                onChange={e => updateConfig('receptionEndTime', e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-opacity-50"
                style={{ '--tw-ring-color': 'var(--couple-primary, #7D8471)' } as React.CSSProperties}
              />
            </div>
            <div className="col-span-2 sm:col-span-2">
              <label className="block text-xs font-medium text-gray-500 mb-1">Dinner Style</label>
              <select
                value={config.dinnerType}
                onChange={e => updateConfig('dinnerType', e.target.value as DinnerType)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-opacity-50 bg-white"
                style={{ '--tw-ring-color': 'var(--couple-primary, #7D8471)' } as React.CSSProperties}
              >
                {(Object.keys(DINNER_LABELS) as DinnerType[]).map(key => (
                  <option key={key} value={key}>{DINNER_LABELS[key]}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Row 2: Toggles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* First Look */}
            <button
              onClick={() => updateConfig('doingFirstLook', !config.doingFirstLook)}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors',
                config.doingFirstLook
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-gray-200 bg-white text-gray-500'
              )}
            >
              {config.doingFirstLook ? (
                <ToggleRight className="w-4 h-4 text-emerald-600" />
              ) : (
                <ToggleLeft className="w-4 h-4" />
              )}
              <span className="truncate">First Look</span>
            </button>

            {/* Off-site Ceremony */}
            <button
              onClick={() => updateConfig('offSiteCeremony', !config.offSiteCeremony)}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors',
                config.offSiteCeremony
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-gray-200 bg-white text-gray-500'
              )}
            >
              {config.offSiteCeremony ? (
                <ToggleRight className="w-4 h-4 text-emerald-600" />
              ) : (
                <ToggleLeft className="w-4 h-4" />
              )}
              <span className="truncate">Off-site Ceremony</span>
            </button>

            {/* Auto-Calculate */}
            <button
              onClick={() => updateConfig('autoCalculate', !config.autoCalculate)}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors',
                config.autoCalculate
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-gray-200 bg-white text-gray-500'
              )}
            >
              {config.autoCalculate ? (
                <ToggleRight className="w-4 h-4 text-emerald-600" />
              ) : (
                <ToggleLeft className="w-4 h-4" />
              )}
              <span className="truncate">Auto-Calculate</span>
            </button>

            {/* Formalities Timing */}
            <button
              onClick={() => updateConfig('formalitiesTiming', config.formalitiesTiming === 'before' ? 'after' : 'before')}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 bg-white text-gray-600 text-sm transition-colors hover:bg-gray-50"
            >
              <span className="truncate">
                Formalities: {config.formalitiesTiming === 'before' ? 'Before Dinner' : 'After Dinner'}
              </span>
            </button>
          </div>

          {/* Info bar */}
          {config.autoCalculate && (
            <div className="flex items-start gap-2 px-3 py-2 bg-blue-50 rounded-lg text-xs text-blue-700">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                Auto-calculate is on. Times cascade from your ceremony time. Override any event by setting its time manually.
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ================================================================ */}
      {/* STATS BAR */}
      {/* ================================================================ */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-3 text-center">
            <div className="text-lg font-bold text-gray-800">{formatTime12(stats.startTime)}</div>
            <div className="text-[11px] text-gray-400 uppercase tracking-wide">Day Starts</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-3 text-center">
            <div className="text-lg font-bold text-gray-800">{formatTime12(stats.endTime)}</div>
            <div className="text-[11px] text-gray-400 uppercase tracking-wide">Day Ends</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-3 text-center">
            <div className="text-lg font-bold text-gray-800">{formatDuration(stats.totalMinutes)}</div>
            <div className="text-[11px] text-gray-400 uppercase tracking-wide">Total Duration</div>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-3 text-center">
            <div className="text-lg font-bold text-gray-800">{stats.eventCount}</div>
            <div className="text-[11px] text-gray-400 uppercase tracking-wide">Events</div>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* TOOLBAR */}
      {/* ================================================================ */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTips(!showTips)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              showTips ? 'bg-amber-50 text-amber-700 border border-amber-200' : 'bg-gray-50 text-gray-500 border border-gray-200'
            )}
          >
            <Lightbulb className="w-3.5 h-3.5" />
            {showTips ? 'Hide Tips' : 'Show Tips'}
          </button>
          <button
            onClick={() => setShowSummary(!showSummary)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              showSummary ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-gray-50 text-gray-500 border border-gray-200'
            )}
          >
            {showSummary ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {showSummary ? 'Hide Summary' : 'Full Summary'}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCustomModal(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Custom Event
          </button>
          <button
            onClick={resetToDefaults}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-50 text-gray-500 border border-gray-200 hover:bg-gray-100 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>
        </div>
      </div>

      {/* ================================================================ */}
      {/* FULL SUMMARY VIEW */}
      {/* ================================================================ */}
      {showSummary && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100">
            <h2 className="font-semibold text-sm text-gray-800">Full Timeline Summary</h2>
          </div>
          <div className="divide-y divide-gray-50">
            {events
              .filter(e => e.included && e.time)
              .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time))
              .map(event => (
                <div key={event.id} className="px-5 py-2.5 flex items-center gap-3">
                  <span className="text-xs font-mono text-gray-400 w-16 shrink-0">
                    {formatTime12(event.time)}
                  </span>
                  <span className="text-sm">{event.icon}</span>
                  <span className="text-sm text-gray-700 flex-1">{event.name}</span>
                  {event.duration > 0 && (
                    <span className="text-xs text-gray-400">{formatDuration(event.duration)}</span>
                  )}
                  {event.canBeConcurrent && (
                    <span className="text-[10px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded">concurrent</span>
                  )}
                </div>
              ))}
            {/* Custom events in summary */}
            {customEvents.map(ce => (
              <div key={ce.id} className="px-5 py-2.5 flex items-center gap-3">
                <span className="text-xs font-mono text-gray-400 w-16 shrink-0">
                  {ce.time ? formatTime12(ce.time) : 'TBD'}
                </span>
                <span className="text-sm">{ce.icon}</span>
                <span className="text-sm text-gray-700 flex-1">{ce.name}</span>
                {ce.duration > 0 && (
                  <span className="text-xs text-gray-400">{formatDuration(ce.duration)}</span>
                )}
                <span className="text-[10px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded">custom</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* EVENT PHASES */}
      {/* ================================================================ */}
      <div className="space-y-4">
        {activePhases.map(phase => {
          const phaseEvents = eventsByPhase[phase] || []
          const phaseCustom = customEvents.filter(ce => ce.phase === phase)
          const isExpanded = expandedPhases.has(phase)
          const includedCount = phaseEvents.filter(e => e.included).length
          const totalCount = phaseEvents.length
          const phaseColor = PHASE_COLORS[phase] || '#6B7280'

          // Skip first_look phase entirely if not doing first look
          if (phase === 'first_look' && !config.doingFirstLook) return null
          // Skip empty formalities phases
          if (phase === 'formalities_before' && phaseEvents.filter(e => e.included).length === 0 && phaseCustom.length === 0) return null
          if (phase === 'formalities_after' && phaseEvents.filter(e => e.included).length === 0 && phaseCustom.length === 0) return null

          return (
            <div
              key={phase}
              className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden"
            >
              {/* Phase Header */}
              <button
                onClick={() => togglePhase(phase)}
                className="w-full px-5 py-3.5 flex items-center gap-3 hover:bg-gray-50/50 transition-colors"
              >
                <span
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0"
                  style={{ backgroundColor: `${phaseColor}15` }}
                >
                  {PHASE_ICONS[phase]}
                </span>
                <div className="flex-1 text-left min-w-0">
                  <span className="font-semibold text-sm text-gray-800">
                    {PHASE_LABELS[phase]}
                  </span>
                  <span className="ml-2 text-xs text-gray-400">
                    {includedCount}/{totalCount} events
                  </span>
                </div>
                {/* Phase time range */}
                {(() => {
                  const includedWithTime = phaseEvents.filter(e => e.included && e.time)
                  if (includedWithTime.length === 0) return null
                  const times = includedWithTime.map(e => timeToMinutes(e.time)).sort((a, b) => a - b)
                  const lastEvent = includedWithTime.sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time))[includedWithTime.length - 1]
                  const endMins = timeToMinutes(lastEvent.time) + lastEvent.duration
                  return (
                    <span className="text-xs text-gray-400 tabular-nums shrink-0">
                      {formatTime12(minutesToTime(times[0]))} - {formatTime12(minutesToTime(endMins))}
                    </span>
                  )
                })()}
                {isExpanded ? (
                  <ChevronUp className="w-4 h-4 text-gray-400 shrink-0" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />
                )}
              </button>

              {/* Phase Events */}
              {isExpanded && (
                <div className="border-t border-gray-50">
                  {phaseEvents.map(event => {
                    const isNotesOpen = notesOpen.has(event.id)

                    return (
                      <div
                        key={event.id}
                        className={cn(
                          'border-b border-gray-50 last:border-b-0 transition-colors',
                          !event.included && 'opacity-50'
                        )}
                      >
                        <div className="px-5 py-3 flex items-start gap-3">
                          {/* Include/Exclude Checkbox */}
                          <button
                            onClick={() => toggleEvent(event.id)}
                            className="mt-0.5 shrink-0"
                            disabled={event.alwaysIncluded}
                          >
                            {event.included ? (
                              <div
                                className="w-5 h-5 rounded flex items-center justify-center"
                                style={{ backgroundColor: phaseColor }}
                              >
                                <Check className="w-3 h-3 text-white" />
                              </div>
                            ) : (
                              <div className="w-5 h-5 rounded border-2 border-gray-300" />
                            )}
                          </button>

                          {/* Icon */}
                          <span className="text-base mt-0.5 shrink-0">{event.icon}</span>

                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={cn(
                                'text-sm font-medium',
                                event.included ? 'text-gray-800' : 'text-gray-400'
                              )}>
                                {event.name}
                              </span>
                              {event.canBeConcurrent && (
                                <span className="text-[10px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded font-medium">
                                  concurrent
                                </span>
                              )}
                              {event.isAnchor && (
                                <span className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded font-medium">
                                  anchor
                                </span>
                              )}
                              {event.manualTime && (
                                <button
                                  onClick={() => clearManualTime(event.id)}
                                  className="text-[10px] bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded font-medium hover:bg-amber-100"
                                  title="Click to reset to auto-calculated time"
                                >
                                  manual
                                </button>
                              )}
                            </div>
                            <p className="text-xs text-gray-400 mt-0.5">{event.description}</p>

                            {/* Tip */}
                            {showTips && event.tips && event.included && (
                              <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 rounded-md px-2.5 py-1.5">
                                <Lightbulb className="w-3 h-3 mt-0.5 shrink-0" />
                                <span>{event.tips}</span>
                              </div>
                            )}

                            {/* Formality timing toggle */}
                            {event.canChooseTiming && event.included && (
                              <button
                                onClick={() => toggleFormalityTiming(event.id)}
                                className="mt-2 text-[11px] px-2 py-1 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors"
                              >
                                {event.formalityTiming === 'before' ? 'Move after dinner' : 'Move before dinner'}
                              </button>
                            )}

                            {/* Notes */}
                            {isNotesOpen && (
                              <textarea
                                value={event.notes}
                                onChange={e => updateEventNotes(event.id, e.target.value)}
                                placeholder="Add notes for this event..."
                                className="mt-2 w-full px-3 py-2 border border-gray-200 rounded-lg text-xs resize-none focus:outline-none focus:ring-1"
                                style={{ '--tw-ring-color': 'var(--couple-primary, #7D8471)' } as React.CSSProperties}
                                rows={2}
                              />
                            )}
                          </div>

                          {/* Right side: time + duration */}
                          <div className="flex items-center gap-2 shrink-0">
                            {/* Time input */}
                            {event.included && (
                              <input
                                type="time"
                                value={event.time}
                                onChange={e => updateEventTime(event.id, e.target.value)}
                                className="px-2 py-1 border border-gray-200 rounded text-xs w-[90px] focus:outline-none focus:ring-1"
                                style={{ '--tw-ring-color': 'var(--couple-primary, #7D8471)' } as React.CSSProperties}
                              />
                            )}

                            {/* Duration */}
                            {event.included && !event.isTimeMarker && (
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  value={event.duration}
                                  onChange={e => updateEventDuration(event.id, parseInt(e.target.value) || 0)}
                                  className="px-2 py-1 border border-gray-200 rounded text-xs w-14 text-center focus:outline-none focus:ring-1"
                                  style={{ '--tw-ring-color': 'var(--couple-primary, #7D8471)' } as React.CSSProperties}
                                  min={0}
                                  step={5}
                                />
                                <span className="text-[10px] text-gray-400">min</span>
                              </div>
                            )}

                            {/* Notes toggle */}
                            <button
                              onClick={() => toggleNotes(event.id)}
                              className={cn(
                                'p-1 rounded hover:bg-gray-100 transition-colors',
                                isNotesOpen ? 'text-gray-700' : 'text-gray-300'
                              )}
                            >
                              <StickyNote className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}

                  {/* Custom events in this phase */}
                  {phaseCustom.map(ce => (
                    <div
                      key={ce.id}
                      className="px-5 py-3 flex items-center gap-3 border-b border-gray-50 last:border-b-0 bg-amber-50/30"
                    >
                      <div className="w-5 h-5 rounded bg-amber-100 flex items-center justify-center shrink-0">
                        <span className="text-[10px]">C</span>
                      </div>
                      <span className="text-base shrink-0">{ce.icon}</span>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-gray-800">{ce.name}</span>
                        {ce.notes && <p className="text-xs text-gray-400 mt-0.5">{ce.notes}</p>}
                      </div>
                      <span className="text-xs text-gray-400 tabular-nums">
                        {ce.time ? formatTime12(ce.time) : 'TBD'}
                      </span>
                      {ce.duration > 0 && (
                        <span className="text-xs text-gray-400">{formatDuration(ce.duration)}</span>
                      )}
                      <button
                        onClick={() => removeCustomEvent(ce.id)}
                        className="p-1 rounded text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ================================================================ */}
      {/* CUSTOM EVENT MODAL */}
      {/* ================================================================ */}
      {showCustomModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="font-semibold text-gray-800">Add Custom Event</h2>
              <button
                onClick={() => setShowCustomModal(false)}
                className="p-1 rounded-lg hover:bg-gray-100"
              >
                <X className="w-4 h-4 text-gray-400" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Event Name</label>
                <input
                  type="text"
                  value={customForm.name}
                  onChange={e => setCustomForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="e.g., Sparkler Send-Off"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': 'var(--couple-primary, #7D8471)' } as React.CSSProperties}
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Time</label>
                  <input
                    type="time"
                    value={customForm.time}
                    onChange={e => setCustomForm(prev => ({ ...prev, time: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2"
                    style={{ '--tw-ring-color': 'var(--couple-primary, #7D8471)' } as React.CSSProperties}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Duration (min)</label>
                  <input
                    type="number"
                    value={customForm.duration}
                    onChange={e => setCustomForm(prev => ({ ...prev, duration: parseInt(e.target.value) || 0 }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2"
                    style={{ '--tw-ring-color': 'var(--couple-primary, #7D8471)' } as React.CSSProperties}
                    min={0}
                    step={5}
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Section</label>
                <select
                  value={customForm.phase}
                  onChange={e => setCustomForm(prev => ({ ...prev, phase: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 bg-white"
                  style={{ '--tw-ring-color': 'var(--couple-primary, #7D8471)' } as React.CSSProperties}
                >
                  {PHASE_ORDER.map(p => (
                    <option key={p} value={p}>{PHASE_LABELS[p]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Icon (emoji)</label>
                <input
                  type="text"
                  value={customForm.icon}
                  onChange={e => setCustomForm(prev => ({ ...prev, icon: e.target.value }))}
                  className="w-20 px-3 py-2 border border-gray-200 rounded-lg text-sm text-center focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': 'var(--couple-primary, #7D8471)' } as React.CSSProperties}
                  maxLength={4}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
                <textarea
                  value={customForm.notes}
                  onChange={e => setCustomForm(prev => ({ ...prev, notes: e.target.value }))}
                  placeholder="Any details about this event..."
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': 'var(--couple-primary, #7D8471)' } as React.CSSProperties}
                  rows={2}
                />
              </div>
            </div>
            <div className="px-5 py-4 border-t border-gray-100 flex justify-end gap-3">
              <button
                onClick={() => setShowCustomModal(false)}
                className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={addCustomEvent}
                disabled={!customForm.name.trim()}
                className="px-4 py-2 rounded-lg text-sm text-white font-medium disabled:opacity-40 transition-opacity"
                style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
              >
                Add Event
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* STICKY SAVE BAR */}
      {/* ================================================================ */}
      {dirty && (
        <div
          ref={saveBarRef}
          className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-gray-200 shadow-lg px-4 py-3"
        >
          <div className="max-w-3xl mx-auto flex items-center justify-between">
            <span className="text-sm text-gray-500">
              You have unsaved changes
            </span>
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  setDirty(false)
                  fetchData()
                }}
                className="px-4 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 transition-colors"
              >
                Discard
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm text-white font-medium disabled:opacity-60 transition-opacity"
                style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
              >
                <Save className="w-4 h-4" />
                {saving ? 'Saving...' : 'Save Timeline'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
