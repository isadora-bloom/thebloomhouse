'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Clock,
  Plus,
  X,
  MapPin,
  Edit2,
  Trash2,
  ChevronDown,
  ChevronUp,
  Lightbulb,
  GripVertical,
  AlertCircle,
  Copy,
  Users,
  Sparkles,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TimelineItem {
  id: string
  time: string | null
  end_time: string | null
  duration_minutes: number | null
  title: string
  description: string | null
  location: string | null
  category: string | null
  section: string | null
  sort_order: number | null
  is_concurrent: boolean
  tip: string | null
  is_custom: boolean
}

interface TimelineFormData {
  time: string
  duration_minutes: string
  title: string
  description: string
  location: string
  category: string
  section: string
  is_concurrent: boolean
}

// ---------------------------------------------------------------------------
// Timeline Section Definitions
// ---------------------------------------------------------------------------

interface EventTemplate {
  title: string
  category: string
  defaultDuration: number
  tip: string
  concurrent?: boolean
  durationByGuestCount?: (count: number) => number
}

interface TimelineSection {
  id: string
  label: string
  icon: string
  color: string
  events: EventTemplate[]
}

const TIMELINE_SECTIONS: TimelineSection[] = [
  {
    id: 'preparation',
    label: 'Preparation',
    icon: '💄',
    color: '#EC4899',
    events: [
      { title: 'Hair & Makeup Begin', category: 'Getting Ready', defaultDuration: 180, tip: 'Start 3-4 hours before the ceremony. Hair and makeup artists typically need 45-60 min per person.' },
      { title: 'Hair & Makeup Done', category: 'Getting Ready', defaultDuration: 0, tip: 'Build in a 30-minute buffer after the last person finishes — things always run long.' },
      { title: 'Buffer Time', category: 'Getting Ready', defaultDuration: 30, tip: 'Use this time to eat something, hydrate, and take a breath. You will thank yourself later.' },
      { title: 'Getting Dressed', category: 'Getting Ready', defaultDuration: 30, tip: 'This is a great photo moment. Keep the room tidy and well-lit for the photographer.' },
      { title: 'Detail Photos', category: 'Photos', defaultDuration: 20, tip: 'Rings, shoes, invitations, flowers, perfume — have them laid out and ready for the photographer.', concurrent: true },
    ],
  },
  {
    id: 'first_look',
    label: 'First Look',
    icon: '👀',
    color: '#F97316',
    events: [
      { title: 'First Look with Parent/Family', category: 'First Look', defaultDuration: 15, tip: 'An emotional private moment. Keep it intimate — just the photographer and the people involved.' },
      { title: 'First Look with Partner', category: 'First Look', defaultDuration: 15, tip: 'Choose a private, photogenic spot. The photographer will position you for the best reveal.' },
      { title: 'Private Vow Reading', category: 'First Look', defaultDuration: 10, tip: 'Optional but beautiful. Read personal vows privately before the ceremony for a more intimate moment.' },
    ],
  },
  {
    id: 'photo_sessions',
    label: 'Photo Sessions',
    icon: '📸',
    color: '#3B82F6',
    events: [
      { title: 'Couple Portraits', category: 'Photos', defaultDuration: 30, tip: 'Best lighting is 1-2 hours before sunset. Trust your photographer to find the best spots.' },
      { title: 'Wedding Party Photos', category: 'Photos', defaultDuration: 20, tip: 'Have your party gathered and ready. The more organized, the faster this goes.' },
      { title: 'Family Formals', category: 'Photos', defaultDuration: 30, tip: 'Create a shot list in advance. Designate someone to wrangle family members — it saves enormous time.' },
    ],
  },
  {
    id: 'pre_ceremony',
    label: 'Pre-Ceremony',
    icon: '🚐',
    color: '#8B5CF6',
    events: [
      { title: 'Travel to Ceremony', category: 'Logistics', defaultDuration: 15, tip: 'Account for traffic and allow extra time. Better to arrive early than rush.' },
      { title: 'Last Shuttle / Guest Arrival', category: 'Logistics', defaultDuration: 30, tip: 'Ensure all guests have arrived before starting. Have ushers ready to seat people.' },
    ],
  },
  {
    id: 'ceremony',
    label: 'Ceremony',
    icon: '💒',
    color: '#8B5CF6',
    events: [
      { title: 'Guests Arrive & Are Seated', category: 'Ceremony', defaultDuration: 30, tip: 'Play background music as guests are seated. Ushers should guide people to their seats.' },
      { title: 'Prelude Music Begins', category: 'Ceremony', defaultDuration: 15, tip: 'Sets the mood. Choose 3-4 songs that reflect your style as a couple.' },
      { title: 'Ceremony Begins', category: 'Ceremony', defaultDuration: 25, tip: 'Most ceremonies last 20-30 minutes. Discuss timing with your officiant beforehand.' },
      { title: 'Group Photo', category: 'Photos', defaultDuration: 10, tip: 'Right after the ceremony while everyone is still gathered. Quick and efficient — one or two shots.' },
    ],
  },
  {
    id: 'cocktail_hour',
    label: 'Cocktail Hour',
    icon: '🥂',
    color: '#F59E0B',
    events: [
      { title: 'Cocktail Hour Begins', category: 'Cocktail Hour', defaultDuration: 60, tip: 'This is the transition. Guests mingle, enjoy drinks and appetizers while the space turns over.' },
      { title: 'Remaining Couple/Party Photos', category: 'Photos', defaultDuration: 30, tip: 'Use this time for any remaining photos. Try to keep it under 30 minutes so you can enjoy cocktail hour too.', concurrent: true },
      { title: 'Couple Break', category: 'Cocktail Hour', defaultDuration: 15, tip: 'Steal 10-15 minutes to eat, drink, and enjoy the moment together. You deserve it.', concurrent: true },
    ],
  },
  {
    id: 'reception_intro',
    label: 'Reception Intro',
    icon: '🎉',
    color: '#10B981',
    events: [
      { title: 'Doors Open', category: 'Reception', defaultDuration: 10, tip: 'Guests find their seats. Have a seating chart displayed prominently at the entrance.' },
      { title: 'Wedding Party Introductions', category: 'Reception', defaultDuration: 10, tip: 'Keep it fun and high-energy. Coordinate with your DJ or MC on pronunciation of names.' },
      { title: 'Couple Entrance', category: 'Reception', defaultDuration: 5, tip: 'Your grand entrance! Pick a song that gets you hyped.' },
      { title: 'Welcome Toast', category: 'Speeches', defaultDuration: 5, tip: 'Brief and warm. Thank everyone for being there. Can be from the couple or a host.' },
    ],
  },
  {
    id: 'formalities',
    label: 'Formalities',
    icon: '🎵',
    color: '#6366F1',
    events: [
      { title: 'First Dance', category: 'Dancing', defaultDuration: 5, tip: 'Practice at least a few times! Even if you are not choreographing, knowing the song length helps.' },
      { title: 'Parent Dances', category: 'Dancing', defaultDuration: 8, tip: 'One or two songs. Can be combined (both parents dance simultaneously) to save time.' },
      { title: 'Toasts & Speeches', category: 'Speeches', defaultDuration: 20, tip: 'Limit to 2-3 speakers, 3-5 minutes each. Brief speakers early so they do not go long.' },
      { title: 'Cake Cutting', category: 'Reception', defaultDuration: 10, tip: 'Quick and sweet. The photographer needs just a few minutes. Dessert can be served later.' },
    ],
  },
  {
    id: 'dinner',
    label: 'Dinner',
    icon: '🍽️',
    color: '#14B8A6',
    events: [
      {
        title: 'Dinner Service',
        category: 'Dinner',
        defaultDuration: 60,
        tip: 'Buffet: 45-60 min. Plated: 60-75 min. Multi-course: 90-120 min. Duration depends on guest count and service style.',
        durationByGuestCount: (count: number) => {
          if (count <= 50) return 45
          if (count <= 100) return 60
          if (count <= 150) return 75
          return 90
        },
      },
    ],
  },
  {
    id: 'end_events',
    label: 'End Events',
    icon: '🌟',
    color: '#EF4444',
    events: [
      { title: 'Open Dancing', category: 'Dancing', defaultDuration: 120, tip: 'The party! Let your DJ or band read the room. Keep the energy up.' },
      { title: 'Last Dance', category: 'Dancing', defaultDuration: 5, tip: 'A special slow song to close the night. Some couples invite everyone to the floor.' },
      { title: 'Send-Off', category: 'Reception', defaultDuration: 15, tip: 'Sparklers, bubbles, confetti, or a simple walk-out. Have everything prepped and distributed.' },
    ],
  },
]

const ALL_CATEGORIES = [
  'Getting Ready', 'First Look', 'Photos', 'Logistics', 'Ceremony',
  'Cocktail Hour', 'Reception', 'Speeches', 'Dancing', 'Dinner', 'Other',
]

const CATEGORY_COLORS: Record<string, string> = {
  'Getting Ready': '#EC4899',
  'First Look': '#F97316',
  Photos: '#3B82F6',
  Logistics: '#8B5CF6',
  Ceremony: '#8B5CF6',
  'Cocktail Hour': '#F59E0B',
  Reception: '#10B981',
  Speeches: '#6366F1',
  Dancing: '#EF4444',
  Dinner: '#14B8A6',
  Other: '#6B7280',
}

const DINNER_STYLES = [
  { value: 'buffet', label: 'Buffet', baseDuration: 45 },
  { value: 'plated', label: 'Plated', baseDuration: 60 },
  { value: 'multi_course', label: 'Multi-Course', baseDuration: 90 },
  { value: 'stations', label: 'Food Stations', baseDuration: 50 },
  { value: 'family_style', label: 'Family Style', baseDuration: 60 },
]

const EMPTY_FORM: TimelineFormData = {
  time: '',
  duration_minutes: '',
  title: '',
  description: '',
  location: '',
  category: '',
  section: '',
  is_concurrent: false,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(timeStr: string | null): string {
  if (!timeStr) return 'TBD'
  const [hours, minutes] = timeStr.split(':').map(Number)
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const displayHours = hours % 12 || 12
  return `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`
}

function formatDuration(mins: number | null): string {
  if (!mins) return ''
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number)
  const totalMins = h * 60 + m + minutes
  const newH = Math.floor(totalMins / 60) % 24
  const newM = totalMins % 60
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`
}

function timeDiffMinutes(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  return (eh * 60 + em) - (sh * 60 + sm)
}

// ---------------------------------------------------------------------------
// Timeline Page
// ---------------------------------------------------------------------------

export default function TimelinePage() {
  const [items, setItems] = useState<TimelineItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<TimelineFormData>(EMPTY_FORM)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(TIMELINE_SECTIONS.map(s => s.id)))
  const [showTemplatePanel, setShowTemplatePanel] = useState(false)
  const [guestCount, setGuestCount] = useState(100)
  const [ceremonyTime, setCeremonyTime] = useState('16:00')
  const [dinnerStyle, setDinnerStyle] = useState('plated')
  const [showTips, setShowTips] = useState(true)
  const [insertAfterIndex, setInsertAfterIndex] = useState<number | null>(null)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchItems = useCallback(async () => {
    const { data, error } = await supabase
      .from('timeline')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('sort_order', { ascending: true })
      .order('time', { ascending: true, nullsFirst: false })

    if (!error && data) {
      setItems(data as TimelineItem[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  // ---- Computed timeline stats ----
  const timelineStats = useMemo(() => {
    if (items.length === 0) return null
    const withTime = items.filter(i => i.time)
    if (withTime.length === 0) return null

    const times = withTime.map(i => i.time!).sort()
    const startTime = times[0]
    const lastItem = withTime.sort((a, b) => (a.time! > b.time! ? 1 : -1))[withTime.length - 1]
    const endTime = lastItem.duration_minutes
      ? addMinutes(lastItem.time!, lastItem.duration_minutes)
      : lastItem.time!

    const totalMinutes = timeDiffMinutes(startTime, endTime)

    return {
      startTime,
      endTime,
      totalMinutes,
      eventCount: items.length,
      concurrentCount: items.filter(i => i.is_concurrent).length,
    }
  }, [items])

  // ---- Section grouping ----
  const itemsBySection = useMemo(() => {
    const grouped: Record<string, TimelineItem[]> = {}
    const uncategorized: TimelineItem[] = []

    items.forEach(item => {
      const section = item.section || item.category || ''
      const matchedSection = TIMELINE_SECTIONS.find(s =>
        s.events.some(e => e.category === item.category) ||
        s.id === item.section
      )
      if (matchedSection) {
        if (!grouped[matchedSection.id]) grouped[matchedSection.id] = []
        grouped[matchedSection.id].push(item)
      } else {
        uncategorized.push(item)
      }
    })

    return { grouped, uncategorized }
  }, [items])

  // ---- Toggle section ----
  function toggleSection(sectionId: string) {
    setExpandedSections(prev => {
      const next = new Set(prev)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  // ---- Modal helpers ----
  function openAdd(section?: string) {
    setForm({ ...EMPTY_FORM, section: section || '' })
    setEditingId(null)
    setShowModal(true)
  }

  function openEdit(item: TimelineItem) {
    setForm({
      time: item.time || '',
      duration_minutes: item.duration_minutes?.toString() || '',
      title: item.title,
      description: item.description || '',
      location: item.location || '',
      category: item.category || '',
      section: item.section || '',
      is_concurrent: item.is_concurrent || false,
    })
    setEditingId(item.id)
    setShowModal(true)
  }

  function openInsertAfter(index: number) {
    setInsertAfterIndex(index)
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.title.trim()) return

    const sortOrder = insertAfterIndex !== null
      ? (items[insertAfterIndex]?.sort_order || 0) + 1
      : items.length

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      time: form.time || null,
      duration_minutes: form.duration_minutes ? parseInt(form.duration_minutes) : null,
      title: form.title.trim(),
      description: form.description.trim() || null,
      location: form.location.trim() || null,
      category: form.category || null,
      section: form.section || null,
      sort_order: sortOrder,
      is_concurrent: form.is_concurrent,
      is_custom: true,
    }

    if (editingId) {
      await supabase.from('timeline').update(payload).eq('id', editingId)
    } else {
      await supabase.from('timeline').insert(payload)
    }

    setShowModal(false)
    setEditingId(null)
    setInsertAfterIndex(null)
    fetchItems()
  }

  async function handleDelete(id: string) {
    if (!confirm('Remove this timeline item?')) return
    await supabase.from('timeline').delete().eq('id', id)
    fetchItems()
  }

  async function handleDuplicate(item: TimelineItem) {
    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      time: item.time,
      duration_minutes: item.duration_minutes,
      title: `${item.title} (Copy)`,
      description: item.description,
      location: item.location,
      category: item.category,
      section: item.section,
      sort_order: (item.sort_order || 0) + 1,
      is_concurrent: item.is_concurrent,
      is_custom: true,
    }
    await supabase.from('timeline').insert(payload)
    fetchItems()
  }

  // ---- Generate from template ----
  async function generateFromTemplate() {
    if (items.length > 0 && !confirm('This will add template events to your existing timeline. Continue?')) return

    let currentTime = ceremonyTime
    let sortOrder = items.length

    // Work backwards from ceremony for prep, first look, photos
    const preCeremonyOffset = 240 // 4 hours before ceremony for prep start
    const [ch, cm] = ceremonyTime.split(':').map(Number)
    let prepStart = (ch * 60 + cm) - preCeremonyOffset
    if (prepStart < 0) prepStart = 0
    let runningTime = `${String(Math.floor(prepStart / 60)).padStart(2, '0')}:${String(prepStart % 60).padStart(2, '0')}`

    const eventsToInsert: Array<{
      venue_id: string
      wedding_id: string
      time: string
      duration_minutes: number
      title: string
      description: string | null
      location: string | null
      category: string
      section: string
      sort_order: number
      is_concurrent: boolean
      tip: string | null
      is_custom: boolean
    }> = []

    for (const section of TIMELINE_SECTIONS) {
      for (const event of section.events) {
        let duration = event.defaultDuration
        if (event.durationByGuestCount) {
          duration = event.durationByGuestCount(guestCount)
        }
        if (section.id === 'dinner') {
          const style = DINNER_STYLES.find(s => s.value === dinnerStyle)
          if (style) {
            duration = style.baseDuration
            if (guestCount > 100) duration += 15
            if (guestCount > 150) duration += 15
          }
        }

        // Use ceremony time for ceremony section
        if (section.id === 'ceremony' && event.title === 'Ceremony Begins') {
          runningTime = ceremonyTime
        }

        eventsToInsert.push({
          venue_id: VENUE_ID,
          wedding_id: WEDDING_ID,
          time: event.concurrent ? runningTime : runningTime,
          duration_minutes: duration,
          title: event.title,
          description: null,
          location: null,
          category: event.category,
          section: section.id,
          sort_order: sortOrder++,
          is_concurrent: event.concurrent || false,
          tip: event.tip,
          is_custom: false,
        })

        if (!event.concurrent && duration > 0) {
          runningTime = addMinutes(runningTime, duration)
        }
      }
    }

    await supabase.from('timeline').insert(eventsToInsert)
    setShowTemplatePanel(false)
    fetchItems()
  }

  // ---- Running time display ----
  function getRunningTime(index: number): string | null {
    const item = items[index]
    if (!item?.time || !item?.duration_minutes) return null
    return addMinutes(item.time, item.duration_minutes)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Your Timeline
          </h1>
          <p className="text-gray-500 text-sm">Plan your day, moment by moment.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowTips(!showTips)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors',
              showTips ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
            )}
          >
            <Lightbulb className="w-3.5 h-3.5" />
            Tips
          </button>
          <button
            onClick={() => setShowTemplatePanel(!showTemplatePanel)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            Generate
          </button>
          <button
            onClick={() => openAdd()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add Event
          </button>
        </div>
      </div>

      {/* Timeline Stats Bar */}
      {timelineStats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-lg font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {formatTime(timelineStats.startTime)}
            </p>
            <p className="text-xs text-gray-500 font-medium">Start</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-lg font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {formatTime(timelineStats.endTime)}
            </p>
            <p className="text-xs text-gray-500 font-medium">End</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-lg font-bold tabular-nums" style={{ color: 'var(--couple-secondary, var(--couple-primary))' }}>
              {formatDuration(timelineStats.totalMinutes)}
            </p>
            <p className="text-xs text-gray-500 font-medium">Total Duration</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-lg font-bold tabular-nums" style={{ color: 'var(--couple-accent, var(--couple-primary))' }}>
              {timelineStats.eventCount}
            </p>
            <p className="text-xs text-gray-500 font-medium">Events</p>
          </div>
        </div>
      )}

      {/* Generate from Template Panel */}
      {showTemplatePanel && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                Generate Timeline
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                We will create a complete timeline based on your details. You can customize everything after.
              </p>
            </div>
            <button onClick={() => setShowTemplatePanel(false)} className="text-gray-400 hover:text-gray-600">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                <Clock className="w-3.5 h-3.5 inline mr-1" />
                Ceremony Time
              </label>
              <input
                type="time"
                value={ceremonyTime}
                onChange={(e) => setCeremonyTime(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                <Users className="w-3.5 h-3.5 inline mr-1" />
                Guest Count
              </label>
              <input
                type="number"
                value={guestCount}
                onChange={(e) => setGuestCount(parseInt(e.target.value) || 100)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                min={1}
                placeholder="100"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Dinner Style</label>
              <select
                value={dinnerStyle}
                onChange={(e) => setDinnerStyle(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              >
                {DINNER_STYLES.map(s => (
                  <option key={s.value} value={s.value}>{s.label} (~{s.baseDuration} min)</option>
                ))}
              </select>
            </div>
          </div>

          {/* Section toggles */}
          <div>
            <p className="text-sm font-medium text-gray-700 mb-2">Include these sections:</p>
            <div className="flex flex-wrap gap-2">
              {TIMELINE_SECTIONS.map(section => (
                <label
                  key={section.id}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border cursor-pointer transition-colors hover:bg-gray-50"
                  style={{ borderColor: section.color + '40', color: section.color }}
                >
                  <input
                    type="checkbox"
                    defaultChecked
                    className="w-3 h-3 rounded"
                    style={{ accentColor: section.color }}
                  />
                  <span>{section.icon}</span>
                  {section.label}
                </label>
              ))}
            </div>
          </div>

          <div className="flex justify-end">
            <button
              onClick={generateFromTemplate}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Sparkles className="w-4 h-4" />
              Generate Timeline
            </button>
          </div>
        </div>
      )}

      {/* Timeline Content */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="animate-pulse flex gap-4">
              <div className="w-20 h-5 bg-gray-200 rounded" />
              <div className="flex-1 h-20 bg-gray-100 rounded-xl" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Clock className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No timeline items yet
          </h3>
          <p className="text-gray-500 text-sm mb-6 max-w-md mx-auto">
            Start with our smart template generator or add events manually. The template builds a full day
            based on your ceremony time, guest count, and dinner style.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => setShowTemplatePanel(true)}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Sparkles className="w-4 h-4" />
              Generate from Template
            </button>
            <button
              onClick={() => openAdd()}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
            >
              <Plus className="w-4 h-4" />
              Add Manually
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Section-based view */}
          {TIMELINE_SECTIONS.map(section => {
            const sectionItems = itemsBySection.grouped[section.id]
            if (!sectionItems || sectionItems.length === 0) return null

            const isExpanded = expandedSections.has(section.id)
            const sectionDuration = sectionItems.reduce((sum, item) =>
              sum + (item.is_concurrent ? 0 : (item.duration_minutes || 0)), 0
            )

            return (
              <div key={section.id} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                {/* Section header */}
                <button
                  onClick={() => toggleSection(section.id)}
                  className="w-full flex items-center justify-between px-5 py-4 hover:bg-gray-50/50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-lg">{section.icon}</span>
                    <div className="text-left">
                      <h3 className="font-semibold text-gray-800 text-sm">{section.label}</h3>
                      <p className="text-xs text-gray-400">
                        {sectionItems.length} event{sectionItems.length !== 1 ? 's' : ''}
                        {sectionDuration > 0 && ` · ${formatDuration(sectionDuration)}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: section.color }}
                    />
                    {isExpanded ? (
                      <ChevronUp className="w-4 h-4 text-gray-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-gray-400" />
                    )}
                  </div>
                </button>

                {/* Section events */}
                {isExpanded && (
                  <div className="border-t border-gray-50">
                    {sectionItems.map((item, idx) => {
                      const globalIdx = items.indexOf(item)

                      return (
                        <div key={item.id}>
                          <div
                            className={cn(
                              'flex gap-4 px-5 py-3 group hover:bg-gray-50/50 transition-colors',
                              item.is_concurrent && 'bg-blue-50/30'
                            )}
                          >
                            {/* Time column */}
                            <div className="w-20 shrink-0 text-right pt-0.5">
                              <span
                                className="text-sm font-semibold tabular-nums"
                                style={{ color: section.color }}
                              >
                                {formatTime(item.time)}
                              </span>
                              {item.duration_minutes && item.duration_minutes > 0 && (
                                <p className="text-[10px] text-gray-400 mt-0.5">
                                  {formatDuration(item.duration_minutes)}
                                </p>
                              )}
                            </div>

                            {/* Dot + line */}
                            <div className="relative flex flex-col items-center shrink-0 pt-1.5">
                              <div
                                className={cn(
                                  'w-2.5 h-2.5 rounded-full border-2 bg-white z-10',
                                  item.is_concurrent && 'border-dashed'
                                )}
                                style={{ borderColor: section.color }}
                              />
                              {idx < sectionItems.length - 1 && (
                                <div
                                  className="w-0.5 flex-1 mt-1"
                                  style={{ backgroundColor: section.color + '25' }}
                                />
                              )}
                            </div>

                            {/* Content */}
                            <div className="flex-1 min-w-0 pb-2">
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-0.5">
                                    <h4 className="font-medium text-gray-800 text-sm">{item.title}</h4>
                                    {item.is_concurrent && (
                                      <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-blue-100 text-blue-600">
                                        CONCURRENT
                                      </span>
                                    )}
                                    {item.is_custom && (
                                      <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-gray-100 text-gray-500">
                                        CUSTOM
                                      </span>
                                    )}
                                  </div>

                                  {item.description && (
                                    <p className="text-xs text-gray-500 mb-1">{item.description}</p>
                                  )}

                                  <div className="flex items-center gap-3 text-[11px] text-gray-400">
                                    {item.location && (
                                      <span className="flex items-center gap-1">
                                        <MapPin className="w-3 h-3" />
                                        {item.location}
                                      </span>
                                    )}
                                    {item.time && item.duration_minutes && (
                                      <span className="flex items-center gap-1">
                                        <Clock className="w-3 h-3" />
                                        {formatTime(item.time)} - {formatTime(addMinutes(item.time, item.duration_minutes))}
                                      </span>
                                    )}
                                  </div>

                                  {/* Tip */}
                                  {showTips && item.tip && (
                                    <div className="mt-2 flex items-start gap-1.5 px-2.5 py-2 rounded-lg bg-amber-50 border border-amber-100">
                                      <Lightbulb className="w-3 h-3 text-amber-500 mt-0.5 shrink-0" />
                                      <p className="text-[11px] text-amber-700 leading-relaxed">{item.tip}</p>
                                    </div>
                                  )}
                                </div>

                                {/* Actions */}
                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                  <button
                                    onClick={() => openEdit(item)}
                                    className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                                    title="Edit"
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleDuplicate(item)}
                                    className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                                    title="Duplicate"
                                  >
                                    <Copy className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    onClick={() => handleDelete(item.id)}
                                    className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                                    title="Remove"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Insert between */}
                          <div className="relative px-5 -my-1 z-10 opacity-0 hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => openInsertAfter(globalIdx)}
                              className="w-full flex items-center justify-center gap-1 py-0.5 text-[10px] text-gray-400 hover:text-gray-600"
                            >
                              <Plus className="w-3 h-3" />
                              Insert event here
                            </button>
                          </div>
                        </div>
                      )
                    })}

                    {/* Add to section */}
                    <div className="px-5 py-3 border-t border-gray-50">
                      <button
                        onClick={() => openAdd(section.id)}
                        className="inline-flex items-center gap-1.5 text-xs font-medium transition-colors hover:opacity-80"
                        style={{ color: section.color }}
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add to {section.label}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}

          {/* Uncategorized items */}
          {itemsBySection.uncategorized.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-5 py-4">
                <h3 className="font-semibold text-gray-800 text-sm">Other Events</h3>
              </div>
              <div className="border-t border-gray-50">
                {itemsBySection.uncategorized.map((item, idx) => (
                  <div
                    key={item.id}
                    className="flex gap-4 px-5 py-3 group hover:bg-gray-50/50 transition-colors"
                  >
                    <div className="w-20 shrink-0 text-right pt-0.5">
                      <span className="text-sm font-semibold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
                        {formatTime(item.time)}
                      </span>
                      {item.duration_minutes && (
                        <p className="text-[10px] text-gray-400 mt-0.5">{formatDuration(item.duration_minutes)}</p>
                      )}
                    </div>
                    <div className="relative flex flex-col items-center shrink-0 pt-1.5">
                      <div
                        className="w-2.5 h-2.5 rounded-full border-2 bg-white z-10"
                        style={{ borderColor: CATEGORY_COLORS[item.category || ''] || 'var(--couple-primary)' }}
                      />
                      {idx < itemsBySection.uncategorized.length - 1 && (
                        <div className="w-0.5 flex-1 mt-1 bg-gray-100" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h4 className="font-medium text-gray-800 text-sm">{item.title}</h4>
                          {item.description && <p className="text-xs text-gray-500 mt-0.5">{item.description}</p>}
                          {item.location && (
                            <span className="text-[11px] text-gray-400 flex items-center gap-1 mt-1">
                              <MapPin className="w-3 h-3" />{item.location}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={() => openEdit(item)} className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100">
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => handleDelete(item.id)} className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* End of day summary */}
          {timelineStats && (
            <div
              className="rounded-xl p-5 text-center"
              style={{ backgroundColor: 'color-mix(in srgb, var(--couple-primary) 8%, white)' }}
            >
              <p className="text-sm font-medium" style={{ color: 'var(--couple-primary)' }}>
                Your day runs from{' '}
                <span className="font-bold">{formatTime(timelineStats.startTime)}</span>
                {' '}to{' '}
                <span className="font-bold">{formatTime(timelineStats.endTime)}</span>
                {' '}({formatDuration(timelineStats.totalMinutes)})
              </p>
              {timelineStats.concurrentCount > 0 && (
                <p className="text-xs text-gray-500 mt-1">
                  {timelineStats.concurrentCount} concurrent event{timelineStats.concurrentCount !== 1 ? 's' : ''} running in parallel
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => { setShowModal(false); setInsertAfterIndex(null) }} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {editingId ? 'Edit Event' : insertAfterIndex !== null ? 'Insert Event' : 'Add Event'}
              </h2>
              <button onClick={() => { setShowModal(false); setInsertAfterIndex(null) }} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Title */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Event Name</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Couple Portraits"
                />
              </div>

              {/* Time + Duration */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Start Time</label>
                  <input
                    type="time"
                    value={form.time}
                    onChange={(e) => setForm({ ...form, time: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Duration (minutes)</label>
                  <input
                    type="number"
                    value={form.duration_minutes}
                    onChange={(e) => setForm({ ...form, duration_minutes: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="30"
                    min={0}
                  />
                  {form.time && form.duration_minutes && parseInt(form.duration_minutes) > 0 && (
                    <p className="text-[10px] text-gray-400 mt-1">
                      Ends at {formatTime(addMinutes(form.time, parseInt(form.duration_minutes)))}
                    </p>
                  )}
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Details (optional)</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Any notes about this event..."
                />
              </div>

              {/* Location + Category row */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <MapPin className="w-3.5 h-3.5 inline mr-1" />
                    Location
                  </label>
                  <input
                    type="text"
                    value={form.location}
                    onChange={(e) => setForm({ ...form, location: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="e.g., Garden"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  >
                    <option value="">Select category...</option>
                    {ALL_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Section assignment */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Timeline Section</label>
                <select
                  value={form.section}
                  onChange={(e) => setForm({ ...form, section: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                >
                  <option value="">Auto-assign by category</option>
                  {TIMELINE_SECTIONS.map(s => (
                    <option key={s.id} value={s.id}>{s.icon} {s.label}</option>
                  ))}
                </select>
              </div>

              {/* Concurrent toggle */}
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_concurrent}
                  onChange={(e) => setForm({ ...form, is_concurrent: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300"
                  style={{ accentColor: 'var(--couple-primary)' }}
                />
                <span>Concurrent event</span>
                <span className="text-[10px] text-gray-400 font-normal">(happens at the same time as previous event)</span>
              </label>
            </div>

            {/* Quick-add templates */}
            {!editingId && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-2">Quick add from templates:</p>
                <div className="flex flex-wrap gap-1.5">
                  {TIMELINE_SECTIONS.flatMap(s => s.events).slice(0, 8).map((evt, i) => (
                    <button
                      key={i}
                      onClick={() => setForm({
                        ...form,
                        title: evt.title,
                        category: evt.category,
                        duration_minutes: evt.defaultDuration.toString(),
                        is_concurrent: evt.concurrent || false,
                      })}
                      className="px-2 py-1 rounded text-[10px] font-medium bg-gray-50 text-gray-600 hover:bg-gray-100 transition-colors"
                    >
                      {evt.title}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => { setShowModal(false); setInsertAfterIndex(null) }}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!form.title.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Event'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
