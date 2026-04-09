'use client'

// Feature: configurable via venue_config.feature_flags
// Table: guest_care_notes (single JSONB row per wedding)

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import {
  Heart,
  Save,
  Check,
  Info,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
// ---------------------------------------------------------------------------
// Section definitions
// ---------------------------------------------------------------------------

interface SectionDef {
  key: string
  icon: string
  question: string
  placeholder: string
  alwaysOpen?: boolean
  category: 'accessibility' | 'health' | 'logistics' | 'interpersonal'
}

const SECTIONS: SectionDef[] = [
  {
    key: 'children',
    icon: '\u{1F476}',
    question: 'Will children be attending your wedding?',
    placeholder: 'How many, roughly what ages? Are they your own children, guests\' kids, or both? Any high chairs or a dedicated kids\' table needed?',
    category: 'logistics',
  },
  {
    key: 'mobility',
    icon: '\u267F',
    question: 'Do any guests use a wheelchair, walker, or cane \u2014 or have difficulty with stairs or uneven ground?',
    placeholder: 'Tell us who and anything we should prepare: reserved accessible parking, seating near paths, avoiding steps, etc.',
    category: 'accessibility',
  },
  {
    key: 'vision_hearing',
    icon: '\u{1F441}',
    question: 'Do any guests have vision or hearing impairments?',
    placeholder: 'Anything we should know to help them feel comfortable and fully included in the day?',
    category: 'accessibility',
  },
  {
    key: 'sensory',
    icon: '\u{1F33F}',
    question: 'Do any guests have sensory sensitivities \u2014 things like loud music, bright lights, or busy environments that can feel overwhelming?',
    placeholder: 'We can arrange a quiet space to step away to, give you a heads-up before loud moments like the send-off, or adjust how we manage certain areas. Just tell us what would help.',
    category: 'accessibility',
  },
  {
    key: 'dietary',
    icon: '\u{1F37D}',
    question: 'Any dietary restrictions or food allergies among your guests?',
    placeholder: 'Even if your caterer already knows, we like to have this too \u2014 especially severe allergies (nuts, shellfish, etc.) and whether anyone carries an EpiPen.',
    category: 'health',
  },
  {
    key: 'sobriety',
    icon: '\u{1F964}',
    question: 'Do you have guests who are sober or would prefer not to be offered alcohol?',
    placeholder: 'We can handle bar service discreetly, arrange a non-alcoholic area, or simply make sure staff know not to offer certain guests drinks. No explanation needed \u2014 just let us know.',
    category: 'health',
  },
  {
    key: 'elderly',
    icon: '\u{1F90D}',
    question: 'Any elderly or frail guests who might appreciate a little extra looking after?',
    placeholder: 'Grandparents, anyone who might tire easily and need a comfortable place to rest, or someone you\'d like us to quietly check in on throughout the day?',
    category: 'health',
  },
  {
    key: 'medical',
    icon: '\u{1F3E5}',
    question: 'Does anyone have a medical condition our staff should know about in case of an emergency?',
    placeholder: 'Severe allergies with an EpiPen, epilepsy, heart conditions, diabetes \u2014 anything that helps us be prepared. This stays with us.',
    category: 'health',
  },
  {
    key: 'service_animals',
    icon: '\u{1F415}',
    question: 'Will any guests be accompanied by a service animal?',
    placeholder: 'Just let us know so we can make sure the space is set up and ready.',
    category: 'logistics',
  },
  {
    key: 'pet_allergies',
    icon: '\u{1F43E}',
    question: 'Do any overnight guests have pet allergies?',
    placeholder: 'We\'re a pet-friendly venue and dogs are often present. If any guests staying on-site have pet allergies, let us know so we can do our best to prepare the rooms and flag it for the couple bringing their dog.',
    category: 'logistics',
  },
  {
    key: 'family_dynamics',
    icon: '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
    question: 'Any family dynamics we should quietly be aware of?',
    placeholder: 'Divorced parents who need to be on opposite sides of the room, estranged relatives, anyone who might need a little extra care or a gentle eye kept on the situation?',
    category: 'interpersonal',
  },
  {
    key: 'other',
    icon: '\u{1F4AC}',
    question: 'Anything else we should know about your guests?',
    placeholder: 'Anything at all that would help us take the very best care of the people you love most.',
    alwaysOpen: true,
    category: 'interpersonal',
  },
]

// Category metadata for summary cards
const CATEGORY_META: Record<string, { label: string; color: string; bgColor: string; borderColor: string }> = {
  accessibility: { label: 'Accessibility', color: '#3B82F6', bgColor: '#EFF6FF', borderColor: '#BFDBFE' },
  health: { label: 'Health & Safety', color: '#EF4444', bgColor: '#FEF2F2', borderColor: '#FECACA' },
  logistics: { label: 'Logistics', color: '#F59E0B', bgColor: '#FFFBEB', borderColor: '#FDE68A' },
  interpersonal: { label: 'Interpersonal', color: '#8B5CF6', bgColor: '#F5F3FF', borderColor: '#DDD6FE' },
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SectionValue {
  has: boolean | null
  notes: string
}

type GuestCareFormData = Record<string, SectionValue>

function buildDefault(): GuestCareFormData {
  const d: GuestCareFormData = {}
  SECTIONS.forEach((s) => {
    d[s.key] = { has: null, notes: '' }
  })
  return d
}

function mergeWithDefaults(saved: Record<string, Partial<SectionValue>> | null): GuestCareFormData {
  const base = buildDefault()
  if (!saved) return base
  SECTIONS.forEach((s) => {
    if (saved[s.key]) {
      base[s.key] = {
        has: saved[s.key].has ?? null,
        notes: saved[s.key].notes ?? '',
      }
    }
  })
  return base
}

// ---------------------------------------------------------------------------
// Yes/No Button component
// ---------------------------------------------------------------------------

function YesNoButtons({
  value,
  onChange,
}: {
  value: boolean | null
  onChange: (val: boolean | null) => void
}) {
  const isYes = value === true
  const isNo = value === false

  return (
    <div className="flex gap-2 mb-3">
      {/* Yes button */}
      <button
        onClick={() => onChange(isYes ? null : true)}
        className={cn(
          'px-5 py-1.5 rounded-full text-sm font-medium border transition-all',
          isYes
            ? 'text-white border-transparent shadow-sm'
            : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300 hover:text-gray-500'
        )}
        style={isYes ? { backgroundColor: 'var(--couple-primary)' } : undefined}
      >
        Yes
      </button>

      {/* No button */}
      <button
        onClick={() => onChange(isNo ? null : false)}
        className={cn(
          'px-5 py-1.5 rounded-full text-sm font-medium border transition-all',
          isNo
            ? 'bg-gray-200 text-gray-600 border-gray-300 shadow-sm'
            : 'bg-white text-gray-400 border-gray-200 hover:border-gray-300 hover:text-gray-500'
        )}
      >
        No
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section Row component
// ---------------------------------------------------------------------------

function SectionRow({
  section,
  value,
  onSetHas,
  onSetNotes,
}: {
  section: SectionDef
  value: SectionValue
  onSetHas: (val: boolean | null) => void
  onSetNotes: (val: string) => void
}) {
  const isYes = value?.has === true
  const showTextarea = section.alwaysOpen || isYes
  const catMeta = CATEGORY_META[section.category]

  return (
    <div className="px-5 py-4">
      <div className="flex items-start gap-3">
        {/* Icon */}
        <span className="text-lg mt-0.5 shrink-0 select-none">{section.icon}</span>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Category tag */}
          <div className="flex items-center gap-2 mb-1.5">
            <span
              className="px-2 py-0.5 rounded text-[10px] font-medium"
              style={{
                backgroundColor: catMeta.bgColor,
                color: catMeta.color,
              }}
            >
              {catMeta.label}
            </span>
          </div>

          {/* Question */}
          <p className="text-sm font-medium text-gray-700 leading-snug mb-2.5">
            {section.question}
          </p>

          {/* Yes / No toggle buttons */}
          {!section.alwaysOpen && (
            <YesNoButtons value={value?.has ?? null} onChange={onSetHas} />
          )}

          {/* Conditional textarea */}
          {showTextarea && (
            <textarea
              value={value?.notes || ''}
              onChange={(e) => onSetNotes(e.target.value)}
              placeholder={section.placeholder}
              rows={3}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 text-gray-700 placeholder:text-gray-300 focus:outline-none focus:ring-2 focus:border-transparent resize-none"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            />
          )}

          {/* "No" confirmation */}
          {value?.has === false && (
            <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
              <Check className="w-3 h-3" /> Noted — no concerns here
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function GuestCareNotesPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [formData, setFormData] = useState<GuestCareFormData>(buildDefault())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)

  const supabase = createClient()

  // Load existing data — each section is stored as a row in guest_care_notes
  // with care_type = section key, guest_name = JSON {has}, note = text notes
  const loadData = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('guest_care_notes')
        .select('id, care_type, guest_name, note, created_at')
        .eq('wedding_id', weddingId)

      if (data && data.length > 0) {
        const saved: Record<string, Partial<SectionValue>> = {}
        let latestAt: string | null = null
        for (const row of data) {
          const key = row.care_type as string
          let has: boolean | null = null
          try {
            const parsed = JSON.parse(row.guest_name as string)
            has = parsed.has ?? null
          } catch {
            // guest_name might not be JSON — treat as null
          }
          saved[key] = { has, notes: (row.note as string) || '' }
          if (row.created_at && (!latestAt || row.created_at > latestAt)) {
            latestAt = row.created_at as string
          }
        }
        setFormData(mergeWithDefaults(saved))
        if (latestAt) setSavedAt(latestAt)
      }
    } catch (err) {
      console.error('Failed to load guest care notes:', err)
    } finally {
      setLoading(false)
    }
  }, [supabase])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Section value setters
  const setHas = (key: string, val: boolean | null) => {
    setFormData((prev) => ({
      ...prev,
      [key]: { ...prev[key], has: val },
    }))
    setDirty(true)
    setSaved(false)
  }

  const setNotes = (key: string, val: string) => {
    setFormData((prev) => ({
      ...prev,
      [key]: { ...prev[key], notes: val },
    }))
    setDirty(true)
    setSaved(false)
  }

  // Save — upsert one row per section into guest_care_notes
  const handleSave = async () => {
    setSaving(true)
    try {
      const rows = SECTIONS.map((s) => ({
        venue_id: venueId,
        wedding_id: weddingId,
        care_type: s.key,
        guest_name: JSON.stringify({ has: formData[s.key]?.has ?? null }),
        note: formData[s.key]?.notes || '',
      }))

      // Delete existing rows for this wedding and re-insert
      await supabase
        .from('guest_care_notes')
        .delete()
        .eq('wedding_id', weddingId)

      await supabase
        .from('guest_care_notes')
        .insert(rows)

      setSavedAt(new Date().toISOString())
      setDirty(false)
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error('Failed to save guest care notes:', err)
    }
    setSaving(false)
  }

  // Count filled sections
  const filledCount = useMemo(() => {
    return SECTIONS.filter((s) => {
      const val = formData[s.key]
      return val?.has === true || (s.alwaysOpen && val?.notes?.trim())
    }).length
  }, [formData])

  // Count answered (yes or no)
  const answeredCount = useMemo(() => {
    return SECTIONS.filter((s) => {
      const val = formData[s.key]
      return val?.has !== null && val?.has !== undefined
    }).length
  }, [formData])

  // Unanswered count (excludes alwaysOpen)
  const unansweredCount = useMemo(() => {
    return SECTIONS.filter((s) => {
      if (s.alwaysOpen) return false
      const val = formData[s.key]
      return val?.has === null || val?.has === undefined
    }).length
  }, [formData])

  // Category summaries
  const categorySummary = useMemo(() => {
    const cats: Record<string, { total: number; flagged: number }> = {}
    SECTIONS.forEach((s) => {
      if (!cats[s.category]) cats[s.category] = { total: 0, flagged: 0 }
      cats[s.category].total++
      if (formData[s.key]?.has === true) cats[s.category].flagged++
    })
    return cats
  }, [formData])

  if (contextLoading || !weddingId || !venueId || loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 bg-gray-100 rounded-xl" />
          ))}
        </div>
        <div className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-20 bg-gray-100 rounded-xl" />
          ))}
        </div>
      </div>
    )
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
            Guest Care Notes
          </h1>
          <p className="text-gray-500 text-sm">
            Help us take care of your people. The more you share, the better we can prepare for your day.
          </p>
        </div>
        <div className="flex items-center gap-3 self-start">
          {filledCount > 0 && (
            <span
              className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium border"
              style={{
                backgroundColor: 'color-mix(in srgb, var(--couple-primary) 8%, white)',
                borderColor: 'color-mix(in srgb, var(--couple-primary) 20%, white)',
                color: 'var(--couple-primary)',
              }}
            >
              {filledCount} {filledCount === 1 ? 'section' : 'sections'} flagged
            </span>
          )}
          {unansweredCount > 0 && (
            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">
              {unansweredCount} unanswered
            </span>
          )}
        </div>
      </div>

      {/* Category summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {Object.entries(CATEGORY_META).map(([catKey, meta]) => {
          const summary = categorySummary[catKey] || { total: 0, flagged: 0 }
          return (
            <div
              key={catKey}
              className="rounded-xl p-3 border text-center"
              style={{ backgroundColor: meta.bgColor, borderColor: meta.borderColor }}
            >
              <p
                className="text-lg font-bold tabular-nums"
                style={{ color: meta.color }}
              >
                {summary.flagged}
                <span className="text-xs font-normal text-gray-400">/{summary.total}</span>
              </p>
              <p className="text-[10px] font-medium" style={{ color: meta.color }}>
                {meta.label}
              </p>
            </div>
          )
        })}
      </div>

      {/* Privacy notice */}
      <div className="flex items-start gap-3 p-4 bg-gray-50 border border-gray-200 rounded-xl">
        <ShieldCheck className="w-5 h-5 text-gray-400 mt-0.5 shrink-0" />
        <div>
          <p className="text-xs text-gray-500">
            <strong className="text-gray-600">Private and confidential.</strong> This information is only shared with your
            venue coordinator and day-of staff. It helps us prepare quietly and care for your guests without drawing attention
            to anyone's needs.
          </p>
        </div>
      </div>

      {/* Sections */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden divide-y divide-gray-50">
        {SECTIONS.map((section) => {
          const val = formData[section.key]
          return (
            <SectionRow
              key={section.key}
              section={section}
              value={val}
              onSetHas={(v) => setHas(section.key, v)}
              onSetNotes={(v) => setNotes(section.key, v)}
            />
          )
        })}
      </div>

      {/* Save footer */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 py-4 flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <p className="text-xs text-gray-400">
            {savedAt
              ? `Last saved ${new Date(savedAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}`
              : 'Not saved yet'}
          </p>
          {dirty && (
            <p className="text-xs text-amber-500 font-medium">Unsaved changes</p>
          )}
        </div>
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className={cn(
            'inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-all',
            saved ? 'bg-emerald-500' : 'hover:opacity-90 disabled:opacity-40'
          )}
          style={!saved ? { backgroundColor: 'var(--couple-primary)' } : undefined}
        >
          {saved ? (
            <>
              <Check className="w-4 h-4" />
              Saved!
            </>
          ) : saving ? (
            'Saving...'
          ) : (
            <>
              <Save className="w-4 h-4" />
              Save Notes
            </>
          )}
        </button>
      </div>
    </div>
  )
}
