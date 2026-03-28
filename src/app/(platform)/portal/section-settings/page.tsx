'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import {
  Settings,
  Eye,
  EyeOff,
  Shield,
  Save,
  Loader2,
  CheckCircle,
  LayoutDashboard,
  Rocket,
  MessageCircle,
  Heart,
  Clock,
  DollarSign,
  Users,
  Armchair,
  CheckSquare,
  Store,
  BookOpen,
  Sparkles,
  Car,
  DoorOpen,
  UtensilsCrossed,
  Flower2,
  HardHat,
  Wine,
  ShieldAlert,
  HeartHandshake,
  Lightbulb,
  Camera,
  FileText,
  Package,
  Bed,
  Globe,
  ClipboardCheck,
  MessagesSquare,
  ImagePlus,
  Download,
  CalendarPlus,
  UsersRound,
  GripVertical,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SectionConfig {
  id: string
  venue_id: string
  section_key: string
  label: string
  description: string | null
  visibility: 'admin_only' | 'both' | 'off'
  sort_order: number
  icon: string | null
  created_at: string
  updated_at: string
}

type Visibility = 'both' | 'admin_only' | 'off'

// ---------------------------------------------------------------------------
// Icon map — resolve lucide icon name to component
// ---------------------------------------------------------------------------

const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  LayoutDashboard,
  Rocket,
  MessageCircle,
  Heart,
  Clock,
  DollarSign,
  Users,
  Armchair,
  CheckSquare,
  Store,
  BookOpen,
  UsersRound,
  Sparkles,
  Car,
  DoorOpen,
  UtensilsCrossed,
  Flower2,
  HardHat,
  Wine,
  ShieldAlert,
  HeartHandshake,
  Lightbulb,
  Camera,
  FileText,
  Package,
  Bed,
  Globe,
  ClipboardCheck,
  MessagesSquare,
  ImagePlus,
  Download,
  CalendarPlus,
}

// ---------------------------------------------------------------------------
// Category grouping for display
// ---------------------------------------------------------------------------

const sectionCategories: Record<string, string[]> = {
  'Getting Started': ['dashboard', 'getting-started', 'chat', 'wedding-details'],
  'Planning': ['timeline', 'budget', 'guests', 'seating', 'checklist', 'vendors'],
  'Day-of Details': ['ceremony', 'party', 'beauty', 'transportation', 'rooms', 'rehearsal'],
  'Venue & Decor': ['decor', 'staffing', 'bar', 'allergies', 'guest-care', 'venue-inventory'],
  'Inspiration & Media': ['inspo', 'photos', 'worksheets', 'couple-photo'],
  'Communication': ['messages', 'resources', 'stays', 'website', 'final-review', 'booking'],
}

function getCategoryForSection(key: string): string {
  for (const [cat, keys] of Object.entries(sectionCategories)) {
    if (keys.includes(key)) return cat
  }
  return 'Other'
}

// ---------------------------------------------------------------------------
// Visibility Toggle Component
// ---------------------------------------------------------------------------

function VisibilityToggle({
  value,
  onChange,
}: {
  value: Visibility
  onChange: (v: Visibility) => void
}) {
  const options: { key: Visibility; label: string; color: string; bgColor: string }[] = [
    { key: 'both', label: 'Both', color: 'text-emerald-700', bgColor: 'bg-emerald-50 border-emerald-200' },
    { key: 'admin_only', label: 'Admin Only', color: 'text-amber-700', bgColor: 'bg-amber-50 border-amber-200' },
    { key: 'off', label: 'Off', color: 'text-gray-500', bgColor: 'bg-gray-50 border-gray-200' },
  ]

  return (
    <div className="flex rounded-lg border border-sage-200 overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={cn(
            'px-3 py-1.5 text-xs font-medium transition-colors border-r last:border-r-0',
            value === opt.key
              ? `${opt.bgColor} ${opt.color}`
              : 'bg-white text-sage-400 hover:bg-sage-50'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section Card
// ---------------------------------------------------------------------------

function SectionCard({
  section,
  modified,
  onVisibilityChange,
}: {
  section: SectionConfig
  modified: boolean
  onVisibilityChange: (key: string, v: Visibility) => void
}) {
  const IconComponent = section.icon ? iconMap[section.icon] : Settings
  const isOff = section.visibility === 'off'

  return (
    <div
      className={cn(
        'bg-surface border rounded-xl p-4 transition-all',
        isOff ? 'border-gray-200 opacity-60' : 'border-border',
        modified && 'ring-2 ring-gold-300'
      )}
    >
      <div className="flex items-start gap-3">
        {/* Drag handle placeholder */}
        <div className="pt-0.5 text-sage-300 cursor-grab">
          <GripVertical className="w-4 h-4" />
        </div>

        {/* Icon */}
        <div
          className={cn(
            'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
            section.visibility === 'both'
              ? 'bg-sage-100 text-sage-600'
              : section.visibility === 'admin_only'
                ? 'bg-amber-50 text-amber-600'
                : 'bg-gray-100 text-gray-400'
          )}
        >
          {IconComponent && <IconComponent className="w-4.5 h-4.5" />}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="text-sm font-semibold text-sage-900 truncate">
              {section.label}
            </h3>
            {section.visibility === 'admin_only' && (
              <Shield className="w-3.5 h-3.5 text-amber-500 shrink-0" />
            )}
            {section.visibility === 'off' && (
              <EyeOff className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            )}
            {section.visibility === 'both' && (
              <Eye className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            )}
          </div>
          {section.description && (
            <p className="text-xs text-sage-500 line-clamp-2">{section.description}</p>
          )}
          <div className="mt-2.5">
            <VisibilityToggle
              value={section.visibility}
              onChange={(v) => onVisibilityChange(section.section_key, v)}
            />
          </div>
        </div>

        {/* Sort order */}
        <span className="text-[10px] text-sage-400 tabular-nums shrink-0">
          #{section.sort_order}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Couple Preview
// ---------------------------------------------------------------------------

function CouplePreview({ sections }: { sections: SectionConfig[] }) {
  const visibleSections = sections.filter((s) => s.visibility === 'both')

  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Eye className="w-4 h-4 text-teal-500" />
        <h3 className="text-sm font-semibold text-sage-900">
          Couple Portal Preview
        </h3>
        <span className="text-xs text-sage-500">
          ({visibleSections.length} sections visible)
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {visibleSections.map((s) => {
          const IconComponent = s.icon ? iconMap[s.icon] : Settings
          return (
            <span
              key={s.section_key}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-teal-50 text-teal-700 border border-teal-200"
            >
              {IconComponent && <IconComponent className="w-3 h-3" />}
              {s.label}
            </span>
          )
        })}
      </div>
      {visibleSections.length === 0 && (
        <p className="text-xs text-sage-400 italic">
          No sections visible to couples. They will see an empty portal.
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function SectionSettingsPage() {
  const [sections, setSections] = useState<SectionConfig[]>([])
  const [originalSections, setOriginalSections] = useState<SectionConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchSections = useCallback(async () => {
    try {
      const supabase = createClient()
      const { data, error: fetchErr } = await supabase
        .from('portal_section_config')
        .select('*')
        .order('sort_order', { ascending: true })

      if (fetchErr) throw fetchErr
      const result = (data ?? []) as SectionConfig[]
      setSections(result)
      setOriginalSections(result)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch sections:', err)
      setError('Failed to load section configuration')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSections()
  }, [fetchSections])

  const handleVisibilityChange = (sectionKey: string, visibility: Visibility) => {
    setSections((prev) =>
      prev.map((s) =>
        s.section_key === sectionKey ? { ...s, visibility } : s
      )
    )
    setSaved(false)
  }

  const modifiedKeys = new Set(
    sections
      .filter((s) => {
        const orig = originalSections.find((o) => o.section_key === s.section_key)
        return orig && orig.visibility !== s.visibility
      })
      .map((s) => s.section_key)
  )

  const hasChanges = modifiedKeys.size > 0

  const handleSave = async () => {
    if (!hasChanges) return
    setSaving(true)
    setSaved(false)

    try {
      const changedSections = sections
        .filter((s) => modifiedKeys.has(s.section_key))
        .map((s) => ({
          section_key: s.section_key,
          visibility: s.visibility,
        }))

      const res = await fetch('/api/portal/section-config?bulk=true', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sections: changedSections }),
      })

      if (!res.ok) throw new Error('Failed to save')

      setOriginalSections([...sections])
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error('Save failed:', err)
      setError('Failed to save changes')
    } finally {
      setSaving(false)
    }
  }

  // Group sections by category
  const groupedSections: Record<string, SectionConfig[]> = {}
  for (const s of sections) {
    const cat = getCategoryForSection(s.section_key)
    if (!groupedSections[cat]) groupedSections[cat] = []
    groupedSections[cat].push(s)
  }

  const categoryOrder = [
    'Getting Started',
    'Planning',
    'Day-of Details',
    'Venue & Decor',
    'Inspiration & Media',
    'Communication',
    'Other',
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Portal Sections
          </h1>
          <p className="text-sage-600">
            Control which sections couples can see in their planning portal.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="flex items-center gap-1.5 text-sm text-emerald-600">
              <CheckCircle className="w-4 h-4" />
              Saved
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              hasChanges
                ? 'bg-sage-600 text-white hover:bg-sage-700'
                : 'bg-sage-100 text-sage-400 cursor-not-allowed'
            )}
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {saving ? 'Saving...' : `Save Changes${hasChanges ? ` (${modifiedKeys.size})` : ''}`}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
          <span className="text-sage-600">Both — visible to admin and couple</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
          <span className="text-sage-600">Admin Only — hidden from couple</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-gray-400" />
          <span className="text-sage-600">Off — disabled for everyone</span>
        </span>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="bg-surface border border-border rounded-xl p-4 animate-pulse">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 bg-sage-100 rounded-lg" />
                <div className="space-y-2 flex-1">
                  <div className="h-4 w-24 bg-sage-100 rounded" />
                  <div className="h-3 w-40 bg-sage-50 rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* Couple Preview */}
          <CouplePreview sections={sections} />

          {/* Section cards grouped by category */}
          <div className="space-y-8">
            {categoryOrder.map((cat) => {
              const catSections = groupedSections[cat]
              if (!catSections || catSections.length === 0) return null
              return (
                <div key={cat}>
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-sage-500 mb-3">
                    {cat}
                  </h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {catSections.map((section) => (
                      <SectionCard
                        key={section.section_key}
                        section={section}
                        modified={modifiedKeys.has(section.section_key)}
                        onVisibilityChange={handleVisibilityChange}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
