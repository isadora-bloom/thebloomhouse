'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Globe,
  Eye,
  Edit3,
  Palette,
  Calendar,
  Heart,
  Image,
  CheckCircle2,
  Sparkles,
  ChevronUp,
  ChevronDown,
  Plus,
  X,
  Trash2,
  GripVertical,
  ExternalLink,
  Copy,
  MapPin,
  Gift,
  HelpCircle,
  Car,
  Hotel,
  Users,
  Camera,
  Utensils,
  LinkIcon,
  Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ThemeName = 'classic' | 'modern' | 'garden' | 'romantic' | 'rustic'

interface WebsiteSection {
  id: string
  type: SectionType
  enabled: boolean
  sort_order: number
  data: Record<string, unknown>
}

type SectionType =
  | 'our_story'
  | 'wedding_party'
  | 'dress_code'
  | 'the_day'
  | 'transportation'
  | 'nearby_stays'
  | 'registry'
  | 'faq'
  | 'photo_gallery'
  | 'rsvp'
  | 'things_to_do'

interface WebsiteSettings {
  partner1_name: string
  partner2_name: string
  wedding_date: string
  venue_name: string
  venue_address: string
  theme: ThemeName
  accent_color: string
  url_slug: string
  is_published: boolean
  sections: WebsiteSection[]
}

interface FAQItem {
  question: string
  answer: string
}

interface RegistryLink {
  name: string
  url: string
  icon: string
}

interface ThingsToDoItem {
  name: string
  category: string
  description: string
  url: string
}

interface WeddingPartyMember {
  name: string
  role: string
  description: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECTION_META: Record<SectionType, { label: string; icon: React.ElementType; description: string }> = {
  our_story: { label: 'Our Story', icon: Heart, description: 'Share how you met and your journey together' },
  wedding_party: { label: 'Wedding Party', icon: Users, description: 'Introduce your wedding party members' },
  dress_code: { label: 'Dress Code', icon: Sparkles, description: 'Help guests know what to wear' },
  the_day: { label: 'The Day', icon: Calendar, description: 'Ceremony and reception details' },
  transportation: { label: 'Transportation', icon: Car, description: 'Shuttle and parking information' },
  nearby_stays: { label: 'Nearby Stays', icon: Hotel, description: 'Accommodation options for guests' },
  registry: { label: 'Registry', icon: Gift, description: 'Gift registry links' },
  faq: { label: 'FAQ', icon: HelpCircle, description: 'Frequently asked questions' },
  photo_gallery: { label: 'Photo Gallery', icon: Camera, description: 'Share engagement or couple photos' },
  rsvp: { label: 'RSVP', icon: CheckCircle2, description: 'Allow guests to RSVP through your website' },
  things_to_do: { label: 'Things to Do', icon: MapPin, description: 'Nearby restaurants, activities, attractions' },
}

const DEFAULT_SECTION_ORDER: SectionType[] = [
  'our_story', 'wedding_party', 'dress_code', 'the_day', 'transportation',
  'nearby_stays', 'registry', 'faq', 'photo_gallery', 'rsvp', 'things_to_do',
]

const DRESS_CODE_PRESETS = [
  { value: 'black_tie', label: 'Black Tie', description: 'Tuxedos and floor-length gowns' },
  { value: 'black_tie_optional', label: 'Black Tie Optional', description: 'Dark suits or tuxedos; formal dresses' },
  { value: 'cocktail', label: 'Cocktail', description: 'Cocktail dresses and suits or sport coats' },
  { value: 'garden', label: 'Garden Party', description: 'Flowy dresses and light-colored suits' },
  { value: 'smart_casual', label: 'Smart Casual', description: 'Dressy separates; no jeans or sneakers' },
  { value: 'casual', label: 'Casual', description: 'Come as you are! Comfort is key.' },
  { value: 'custom', label: 'Custom', description: 'Write your own dress code' },
]

const THEMES: {
  key: ThemeName
  label: string
  description: string
  previewBg: string
  accent: string
  fontFamily: string
}[] = [
  { key: 'classic', label: 'Classic', description: 'Serif fonts, cream tones, timeless elegance', previewBg: '#FAF8F5', accent: '#8B7355', fontFamily: 'serif' },
  { key: 'modern', label: 'Modern', description: 'Clean sans-serif, bold contrast, contemporary', previewBg: '#FAFAFA', accent: '#1A1A1A', fontFamily: 'sans-serif' },
  { key: 'garden', label: 'Garden', description: 'Botanical greens, organic, lush', previewBg: '#F5F9F5', accent: '#4A7C59', fontFamily: 'serif' },
  { key: 'romantic', label: 'Romantic', description: 'Script accents, blush tones, soft', previewBg: '#FDF5F3', accent: '#B8908A', fontFamily: 'serif' },
  { key: 'rustic', label: 'Rustic', description: 'Earth tones, warm textures, natural', previewBg: '#F9F6F1', accent: '#8B6F47', fontFamily: 'serif' },
]

const ACCENT_COLORS = [
  { value: '#8B7355', label: 'Warm Taupe' },
  { value: '#B8908A', label: 'Dusty Rose' },
  { value: '#7D8471', label: 'Sage Green' },
  { value: '#5D7A7A', label: 'Dusty Teal' },
  { value: '#A6894A', label: 'Warm Gold' },
  { value: '#1A1A1A', label: 'Charcoal' },
  { value: '#6B4C3B', label: 'Mocha' },
  { value: '#4A7C59', label: 'Forest' },
  { value: '#8B6F47', label: 'Copper' },
  { value: '#6B5B73', label: 'Plum' },
]

const REGISTRY_ICONS = ['gift', 'home', 'heart', 'star', 'coffee', 'plane']

const THINGS_CATEGORIES = ['Restaurant', 'Activity', 'Attraction', 'Brewery/Winery', 'Cafe', 'Shopping']

const DEFAULT_SETTINGS: WebsiteSettings = {
  partner1_name: '',
  partner2_name: '',
  wedding_date: '',
  venue_name: '',
  venue_address: '',
  theme: 'classic',
  accent_color: '#8B7355',
  url_slug: '',
  is_published: false,
  sections: DEFAULT_SECTION_ORDER.map((type, i) => ({
    id: `section-${type}`,
    type,
    enabled: ['our_story', 'the_day', 'rsvp'].includes(type),
    sort_order: i,
    data: {},
  })),
}

// ---------------------------------------------------------------------------
// Website Page
// ---------------------------------------------------------------------------

export default function WeddingWebsitePage() {
  const [settings, setSettings] = useState<WebsiteSettings>(DEFAULT_SETTINGS)
  const [activePanel, setActivePanel] = useState<'editor' | 'preview'>('editor')
  const [expandedSection, setExpandedSection] = useState<string | null>('our_story')
  const [saving, setSaving] = useState(false)
  const [copiedSlug, setCopiedSlug] = useState(false)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchSettings = useCallback(async () => {
    const { data } = await supabase
      .from('wedding_website_settings')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .single()

    if (data) {
      setSettings({
        ...DEFAULT_SETTINGS,
        ...data,
        sections: data.sections || DEFAULT_SETTINGS.sections,
      })
    }
  }, [supabase])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  // ---- Save ----
  async function saveSettings(updated?: Partial<WebsiteSettings>) {
    setSaving(true)
    const payload = { ...settings, ...updated, wedding_id: WEDDING_ID, venue_id: VENUE_ID }
    await supabase.from('wedding_website_settings').upsert(payload, { onConflict: 'wedding_id' })
    if (updated) setSettings(prev => ({ ...prev, ...updated }))
    setSaving(false)
  }

  // ---- Update helpers ----
  function update<K extends keyof WebsiteSettings>(key: K, value: WebsiteSettings[K]) {
    setSettings(prev => ({ ...prev, [key]: value }))
  }

  function updateSectionData(sectionType: SectionType, data: Record<string, unknown>) {
    setSettings(prev => ({
      ...prev,
      sections: prev.sections.map(s =>
        s.type === sectionType ? { ...s, data: { ...s.data, ...data } } : s
      ),
    }))
  }

  function toggleSectionEnabled(sectionType: SectionType) {
    setSettings(prev => ({
      ...prev,
      sections: prev.sections.map(s =>
        s.type === sectionType ? { ...s, enabled: !s.enabled } : s
      ),
    }))
  }

  function moveSectionUp(index: number) {
    if (index <= 0) return
    setSettings(prev => {
      const sections = [...prev.sections]
      ;[sections[index - 1], sections[index]] = [sections[index], sections[index - 1]]
      return { ...prev, sections: sections.map((s, i) => ({ ...s, sort_order: i })) }
    })
  }

  function moveSectionDown(index: number) {
    if (index >= settings.sections.length - 1) return
    setSettings(prev => {
      const sections = [...prev.sections]
      ;[sections[index], sections[index + 1]] = [sections[index + 1], sections[index]]
      return { ...prev, sections: sections.map((s, i) => ({ ...s, sort_order: i })) }
    })
  }

  // ---- Slug generation ----
  function generateSlug() {
    const names = [settings.partner1_name, settings.partner2_name].filter(Boolean)
    if (names.length >= 2) {
      update('url_slug', names.join('-and-').toLowerCase().replace(/[^a-z0-9-]/g, ''))
    }
  }

  function copySlug() {
    const url = `yoursite.com/${settings.url_slug}`
    navigator.clipboard.writeText(url)
    setCopiedSlug(true)
    setTimeout(() => setCopiedSlug(false), 2000)
  }

  // ---- Publish ----
  async function handlePublish() {
    const newState = !settings.is_published
    update('is_published', newState)
    await saveSettings({ is_published: newState })
  }

  // ---- Sorted sections ----
  const sortedSections = useMemo(() =>
    [...settings.sections].sort((a, b) => a.sort_order - b.sort_order),
    [settings.sections]
  )

  const enabledSections = sortedSections.filter(s => s.enabled)

  // ---- Theme config ----
  const currentTheme = THEMES.find(t => t.key === settings.theme) || THEMES[0]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Wedding Website
          </h1>
          <p className="text-gray-500 text-sm">
            Build a beautiful page to share with your guests.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => saveSettings()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          {settings.is_published && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700">
              <CheckCircle2 className="w-3 h-3" />
              Published
            </span>
          )}
          <button
            onClick={handlePublish}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: settings.is_published ? '#6B7280' : 'var(--couple-primary)' }}
          >
            <Globe className="w-4 h-4" />
            {settings.is_published ? 'Unpublish' : 'Publish'}
          </button>
        </div>
      </div>

      {/* Mobile tab toggle */}
      <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 lg:hidden">
        <button
          onClick={() => setActivePanel('editor')}
          className={cn(
            'flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors',
            activePanel === 'editor' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
          )}
        >
          <Edit3 className="w-4 h-4" />
          Editor
        </button>
        <button
          onClick={() => setActivePanel('preview')}
          className={cn(
            'flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-md transition-colors',
            activePanel === 'preview' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
          )}
        >
          <Eye className="w-4 h-4" />
          Preview
        </button>
      </div>

      {/* Main layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ---- Editor Panel ---- */}
        <div className={cn('space-y-4', activePanel !== 'editor' && 'hidden lg:block')}>
          {/* Couple Details */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Heart className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
              <h2 className="text-base font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
                Couple Details
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Partner 1</label>
                <input type="text" value={settings.partner1_name} onChange={e => update('partner1_name', e.target.value)}
                  placeholder="First name" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Partner 2</label>
                <input type="text" value={settings.partner2_name} onChange={e => update('partner2_name', e.target.value)}
                  placeholder="First name" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1"><Calendar className="w-3 h-3 inline mr-1" />Wedding Date</label>
                <input type="date" value={settings.wedding_date} onChange={e => update('wedding_date', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Venue Name</label>
                <input type="text" value={settings.venue_name} onChange={e => update('venue_name', e.target.value)}
                  placeholder="Venue name" className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} />
              </div>
            </div>
          </div>

          {/* URL Slug */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-3">
            <h2 className="text-base font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
              Website URL
            </h2>
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-400 shrink-0">yoursite.com/</span>
              <input type="text" value={settings.url_slug} onChange={e => update('url_slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="your-names" className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} />
              <button onClick={generateSlug} className="px-3 py-2 text-xs font-medium border border-gray-200 rounded-lg text-gray-500 hover:bg-gray-50">
                Auto
              </button>
              {settings.url_slug && (
                <button onClick={copySlug} className="p-2 text-gray-400 hover:text-gray-600">
                  {copiedSlug ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                </button>
              )}
            </div>
          </div>

          {/* Theme Selection */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Palette className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
              <h2 className="text-base font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>Theme</h2>
            </div>
            <div className="grid grid-cols-5 gap-2">
              {THEMES.map(theme => (
                <button
                  key={theme.key}
                  onClick={() => update('theme', theme.key)}
                  className={cn(
                    'text-left p-2.5 rounded-xl border-2 transition-all',
                    settings.theme === theme.key ? 'border-current shadow-sm' : 'border-gray-200 hover:border-gray-300'
                  )}
                  style={settings.theme === theme.key ? { borderColor: 'var(--couple-primary)' } : undefined}
                >
                  <div className="w-full h-10 rounded-md mb-1.5" style={{ backgroundColor: theme.previewBg }}>
                    <div className="w-5 h-1 rounded-full mx-auto mt-4" style={{ backgroundColor: theme.accent }} />
                  </div>
                  <p className="text-[10px] font-semibold text-gray-800">{theme.label}</p>
                </button>
              ))}
            </div>

            {/* Accent color */}
            <div className="pt-2">
              <p className="text-xs font-medium text-gray-600 mb-2">Accent Color</p>
              <div className="flex items-center gap-2 flex-wrap">
                {ACCENT_COLORS.map(c => (
                  <button
                    key={c.value}
                    onClick={() => update('accent_color', c.value)}
                    className={cn(
                      'w-8 h-8 rounded-full border-2 transition-all',
                      settings.accent_color === c.value ? 'border-gray-900 ring-2 ring-offset-2 ring-gray-300' : 'border-gray-200 hover:border-gray-400'
                    )}
                    style={{ backgroundColor: c.value }}
                    title={c.label}
                  />
                ))}
                {/* Custom color picker */}
                <label className="relative w-8 h-8 rounded-full border-2 border-dashed border-gray-300 flex items-center justify-center cursor-pointer hover:border-gray-400" title="Custom color">
                  <Plus className="w-3.5 h-3.5 text-gray-400" />
                  <input type="color" value={settings.accent_color} onChange={e => update('accent_color', e.target.value)}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                </label>
              </div>
              <p className="text-[10px] text-gray-400 mt-1">
                {ACCENT_COLORS.find(c => c.value === settings.accent_color)?.label || settings.accent_color}
              </p>
            </div>
          </div>

          {/* Section Manager */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="p-5 border-b border-gray-50">
              <h2 className="text-base font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
                Sections ({enabledSections.length} active)
              </h2>
              <p className="text-xs text-gray-400 mt-0.5">Toggle sections on/off, reorder, and configure content</p>
            </div>

            <div className="divide-y divide-gray-50">
              {sortedSections.map((section, index) => {
                const meta = SECTION_META[section.type]
                const SectionIcon = meta.icon
                const isExpanded = expandedSection === section.type

                return (
                  <div key={section.type} className={cn(!section.enabled && 'opacity-50')}>
                    {/* Section row */}
                    <div className="flex items-center gap-3 px-5 py-3">
                      <div className="flex flex-col gap-0.5">
                        <button onClick={() => moveSectionUp(index)} className="text-gray-300 hover:text-gray-500" disabled={index === 0}>
                          <ChevronUp className="w-3 h-3" />
                        </button>
                        <button onClick={() => moveSectionDown(index)} className="text-gray-300 hover:text-gray-500" disabled={index === sortedSections.length - 1}>
                          <ChevronDown className="w-3 h-3" />
                        </button>
                      </div>

                      <button
                        onClick={() => toggleSectionEnabled(section.type)}
                        className={cn(
                          'relative w-10 h-6 rounded-full transition-colors',
                          section.enabled ? '' : 'bg-gray-200'
                        )}
                        style={section.enabled ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                      >
                        <span className={cn(
                          'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform',
                          section.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
                        )} />
                      </button>

                      <SectionIcon className="w-4 h-4 text-gray-400 shrink-0" />

                      <button
                        onClick={() => setExpandedSection(isExpanded ? null : section.type)}
                        className="flex-1 text-left"
                      >
                        <p className="text-sm font-medium text-gray-700">{meta.label}</p>
                        <p className="text-[10px] text-gray-400">{meta.description}</p>
                      </button>

                      {section.enabled && (
                        <button
                          onClick={() => setExpandedSection(isExpanded ? null : section.type)}
                          className="text-gray-400 hover:text-gray-600"
                        >
                          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                      )}
                    </div>

                    {/* Section editor */}
                    {isExpanded && section.enabled && (
                      <div className="px-5 pb-4 pl-16 space-y-3">
                        {/* Our Story */}
                        {section.type === 'our_story' && (
                          <textarea
                            value={(section.data.text as string) || ''}
                            onChange={e => updateSectionData('our_story', { text: e.target.value })}
                            placeholder="Share how you met, your proposal story..."
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:border-transparent"
                            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                            rows={5}
                          />
                        )}

                        {/* Wedding Party */}
                        {section.type === 'wedding_party' && (
                          <div className="space-y-2">
                            {((section.data.members as WeddingPartyMember[]) || []).map((member, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <input type="text" value={member.name} placeholder="Name"
                                  onChange={e => {
                                    const members = [...((section.data.members as WeddingPartyMember[]) || [])]
                                    members[i] = { ...members[i], name: e.target.value }
                                    updateSectionData('wedding_party', { members })
                                  }}
                                  className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm" />
                                <input type="text" value={member.role} placeholder="Role"
                                  onChange={e => {
                                    const members = [...((section.data.members as WeddingPartyMember[]) || [])]
                                    members[i] = { ...members[i], role: e.target.value }
                                    updateSectionData('wedding_party', { members })
                                  }}
                                  className="w-32 px-3 py-1.5 border border-gray-200 rounded-lg text-sm" />
                                <button onClick={() => {
                                  const members = [...((section.data.members as WeddingPartyMember[]) || [])].filter((_, j) => j !== i)
                                  updateSectionData('wedding_party', { members })
                                }} className="text-gray-300 hover:text-red-500"><X className="w-4 h-4" /></button>
                              </div>
                            ))}
                            <button onClick={() => {
                              const members = [...((section.data.members as WeddingPartyMember[]) || []), { name: '', role: '', description: '' }]
                              updateSectionData('wedding_party', { members })
                            }} className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--couple-primary)' }}>
                              <Plus className="w-3 h-3" /> Add member
                            </button>
                          </div>
                        )}

                        {/* Dress Code */}
                        {section.type === 'dress_code' && (
                          <div className="space-y-2">
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                              {DRESS_CODE_PRESETS.map(preset => (
                                <button key={preset.value}
                                  onClick={() => updateSectionData('dress_code', { preset: preset.value, custom_text: preset.value === 'custom' ? '' : preset.description })}
                                  className={cn(
                                    'text-left p-2 rounded-lg border text-xs transition-colors',
                                    (section.data.preset as string) === preset.value ? 'border-current font-medium' : 'border-gray-200 hover:border-gray-300'
                                  )}
                                  style={(section.data.preset as string) === preset.value ? { borderColor: 'var(--couple-primary)', color: 'var(--couple-primary)' } : undefined}
                                >
                                  <p className="font-medium">{preset.label}</p>
                                  <p className="text-gray-400 text-[10px] mt-0.5">{preset.description}</p>
                                </button>
                              ))}
                            </div>
                            {(section.data.preset as string) === 'custom' && (
                              <textarea value={(section.data.custom_text as string) || ''} onChange={e => updateSectionData('dress_code', { custom_text: e.target.value })}
                                placeholder="Describe your dress code..."
                                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none" rows={2} />
                            )}
                          </div>
                        )}

                        {/* The Day */}
                        {section.type === 'the_day' && (
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Ceremony Time</label>
                              <input type="time" value={(section.data.ceremony_time as string) || ''}
                                onChange={e => updateSectionData('the_day', { ceremony_time: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-gray-600 mb-1">Reception Time</label>
                              <input type="time" value={(section.data.reception_time as string) || ''}
                                onChange={e => updateSectionData('the_day', { reception_time: e.target.value })}
                                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                            </div>
                            <div className="col-span-2">
                              <label className="block text-xs font-medium text-gray-600 mb-1">Additional Details</label>
                              <textarea value={(section.data.details as string) || ''}
                                onChange={e => updateSectionData('the_day', { details: e.target.value })}
                                placeholder="Parking info, entrance location..."
                                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none" rows={2} />
                            </div>
                          </div>
                        )}

                        {/* Transportation */}
                        {section.type === 'transportation' && (
                          <textarea value={(section.data.details as string) || ''}
                            onChange={e => updateSectionData('transportation', { details: e.target.value })}
                            placeholder="Shuttle times, parking instructions, directions..."
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none" rows={4} />
                        )}

                        {/* Nearby Stays */}
                        {section.type === 'nearby_stays' && (
                          <div className="space-y-2">
                            {((section.data.stays as Array<{ name: string; url: string; notes: string }>) || []).map((stay, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <input type="text" value={stay.name} placeholder="Hotel name"
                                  onChange={e => {
                                    const stays = [...((section.data.stays as Array<{ name: string; url: string; notes: string }>) || [])]
                                    stays[i] = { ...stays[i], name: e.target.value }
                                    updateSectionData('nearby_stays', { stays })
                                  }}
                                  className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm" />
                                <input type="url" value={stay.url} placeholder="URL"
                                  onChange={e => {
                                    const stays = [...((section.data.stays as Array<{ name: string; url: string; notes: string }>) || [])]
                                    stays[i] = { ...stays[i], url: e.target.value }
                                    updateSectionData('nearby_stays', { stays })
                                  }}
                                  className="w-32 px-3 py-1.5 border border-gray-200 rounded-lg text-sm" />
                                <button onClick={() => {
                                  const stays = [...((section.data.stays as Array<{ name: string; url: string; notes: string }>) || [])].filter((_, j) => j !== i)
                                  updateSectionData('nearby_stays', { stays })
                                }} className="text-gray-300 hover:text-red-500"><X className="w-4 h-4" /></button>
                              </div>
                            ))}
                            <button onClick={() => {
                              const stays = [...((section.data.stays as Array<{ name: string; url: string; notes: string }>) || []), { name: '', url: '', notes: '' }]
                              updateSectionData('nearby_stays', { stays })
                            }} className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--couple-primary)' }}>
                              <Plus className="w-3 h-3" /> Add accommodation
                            </button>
                          </div>
                        )}

                        {/* Registry */}
                        {section.type === 'registry' && (
                          <div className="space-y-2">
                            {((section.data.links as RegistryLink[]) || []).map((link, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <input type="text" value={link.name} placeholder="Registry name"
                                  onChange={e => {
                                    const links = [...((section.data.links as RegistryLink[]) || [])]
                                    links[i] = { ...links[i], name: e.target.value }
                                    updateSectionData('registry', { links })
                                  }}
                                  className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm" />
                                <input type="url" value={link.url} placeholder="https://..."
                                  onChange={e => {
                                    const links = [...((section.data.links as RegistryLink[]) || [])]
                                    links[i] = { ...links[i], url: e.target.value }
                                    updateSectionData('registry', { links })
                                  }}
                                  className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm" />
                                <button onClick={() => {
                                  const links = [...((section.data.links as RegistryLink[]) || [])].filter((_, j) => j !== i)
                                  updateSectionData('registry', { links })
                                }} className="text-gray-300 hover:text-red-500"><X className="w-4 h-4" /></button>
                              </div>
                            ))}
                            <button onClick={() => {
                              const links = [...((section.data.links as RegistryLink[]) || []), { name: '', url: '', icon: 'gift' }]
                              updateSectionData('registry', { links })
                            }} className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--couple-primary)' }}>
                              <Plus className="w-3 h-3" /> Add registry link
                            </button>
                          </div>
                        )}

                        {/* FAQ */}
                        {section.type === 'faq' && (
                          <div className="space-y-2">
                            {((section.data.items as FAQItem[]) || []).map((item, i) => (
                              <div key={i} className="bg-gray-50 rounded-lg p-3 space-y-2">
                                <div className="flex items-center gap-2">
                                  <input type="text" value={item.question} placeholder="Question"
                                    onChange={e => {
                                      const items = [...((section.data.items as FAQItem[]) || [])]
                                      items[i] = { ...items[i], question: e.target.value }
                                      updateSectionData('faq', { items })
                                    }}
                                    className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm" />
                                  <button onClick={() => {
                                    const items = [...((section.data.items as FAQItem[]) || [])].filter((_, j) => j !== i)
                                    updateSectionData('faq', { items })
                                  }} className="text-gray-300 hover:text-red-500"><X className="w-4 h-4" /></button>
                                </div>
                                <textarea value={item.answer} placeholder="Answer"
                                  onChange={e => {
                                    const items = [...((section.data.items as FAQItem[]) || [])]
                                    items[i] = { ...items[i], answer: e.target.value }
                                    updateSectionData('faq', { items })
                                  }}
                                  className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm resize-none" rows={2} />
                              </div>
                            ))}
                            <button onClick={() => {
                              const items = [...((section.data.items as FAQItem[]) || []), { question: '', answer: '' }]
                              updateSectionData('faq', { items })
                            }} className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--couple-primary)' }}>
                              <Plus className="w-3 h-3" /> Add Q&A
                            </button>
                          </div>
                        )}

                        {/* Photo Gallery */}
                        {section.type === 'photo_gallery' && (
                          <div className="space-y-2">
                            {((section.data.photos as string[]) || ['', '', '']).map((url, i) => (
                              <div key={i}>
                                <label className="block text-xs font-medium text-gray-600 mb-1">Photo {i + 1}</label>
                                <input type="url" value={url}
                                  onChange={e => {
                                    const photos = [...((section.data.photos as string[]) || ['', '', ''])]
                                    photos[i] = e.target.value
                                    updateSectionData('photo_gallery', { photos })
                                  }}
                                  placeholder="https://example.com/photo.jpg"
                                  className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm" />
                              </div>
                            ))}
                            <button onClick={() => {
                              const photos = [...((section.data.photos as string[]) || []), '']
                              updateSectionData('photo_gallery', { photos })
                            }} className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--couple-primary)' }}>
                              <Plus className="w-3 h-3" /> Add photo
                            </button>
                          </div>
                        )}

                        {/* RSVP */}
                        {section.type === 'rsvp' && (
                          <div>
                            <p className="text-xs text-gray-500 mb-2">
                              When enabled, guests will see an RSVP button on your website. Responses will appear in your Guest List.
                            </p>
                            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                              <input type="checkbox" checked={(section.data.deadline_enabled as boolean) || false}
                                onChange={e => updateSectionData('rsvp', { deadline_enabled: e.target.checked })}
                                className="w-4 h-4 rounded" style={{ accentColor: 'var(--couple-primary)' }} />
                              Show RSVP deadline
                            </label>
                            {(section.data.deadline_enabled as boolean) && (
                              <input type="date" value={(section.data.deadline as string) || ''}
                                onChange={e => updateSectionData('rsvp', { deadline: e.target.value })}
                                className="mt-2 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" />
                            )}
                          </div>
                        )}

                        {/* Things to Do */}
                        {section.type === 'things_to_do' && (
                          <div className="space-y-2">
                            {((section.data.items as ThingsToDoItem[]) || []).map((item, i) => (
                              <div key={i} className="bg-gray-50 rounded-lg p-3 space-y-2">
                                <div className="flex items-center gap-2">
                                  <input type="text" value={item.name} placeholder="Place name"
                                    onChange={e => {
                                      const items = [...((section.data.items as ThingsToDoItem[]) || [])]
                                      items[i] = { ...items[i], name: e.target.value }
                                      updateSectionData('things_to_do', { items })
                                    }}
                                    className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm" />
                                  <select value={item.category}
                                    onChange={e => {
                                      const items = [...((section.data.items as ThingsToDoItem[]) || [])]
                                      items[i] = { ...items[i], category: e.target.value }
                                      updateSectionData('things_to_do', { items })
                                    }}
                                    className="w-32 px-3 py-1.5 border border-gray-200 rounded-lg text-xs bg-white">
                                    <option value="">Type...</option>
                                    {THINGS_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                                  </select>
                                  <button onClick={() => {
                                    const items = [...((section.data.items as ThingsToDoItem[]) || [])].filter((_, j) => j !== i)
                                    updateSectionData('things_to_do', { items })
                                  }} className="text-gray-300 hover:text-red-500"><X className="w-4 h-4" /></button>
                                </div>
                                <input type="text" value={item.description} placeholder="Brief description"
                                  onChange={e => {
                                    const items = [...((section.data.items as ThingsToDoItem[]) || [])]
                                    items[i] = { ...items[i], description: e.target.value }
                                    updateSectionData('things_to_do', { items })
                                  }}
                                  className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm" />
                              </div>
                            ))}
                            <button onClick={() => {
                              const items = [...((section.data.items as ThingsToDoItem[]) || []), { name: '', category: '', description: '', url: '' }]
                              updateSectionData('things_to_do', { items })
                            }} className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--couple-primary)' }}>
                              <Plus className="w-3 h-3" /> Add place
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* ---- Preview Panel ---- */}
        <div className={cn(activePanel !== 'preview' && 'hidden lg:block')}>
          <div className="sticky top-24">
            <div className="flex items-center gap-2 mb-3">
              <Eye className="w-4 h-4 text-gray-400" />
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                Live Preview &mdash; {currentTheme.label}
              </span>
            </div>
            <div className="border border-gray-200 rounded-xl overflow-hidden shadow-sm max-h-[75vh] overflow-y-auto" style={{ backgroundColor: currentTheme.previewBg }}>
              <div className="p-6 space-y-6" style={{ fontFamily: currentTheme.fontFamily }}>
                {/* Hero */}
                <div className="text-center py-8">
                  <p className="text-[10px] uppercase tracking-[0.3em] mb-3" style={{ color: settings.accent_color }}>
                    Together with their families
                  </p>
                  <h1 className="text-3xl font-light mb-2" style={{ color: settings.accent_color }}>
                    {settings.partner1_name || 'Partner 1'} & {settings.partner2_name || 'Partner 2'}
                  </h1>
                  <div className="w-16 h-px mx-auto my-4" style={{ backgroundColor: settings.accent_color }} />
                  <p className="text-sm text-gray-600">
                    {settings.wedding_date
                      ? new Date(settings.wedding_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
                      : 'Date TBD'}
                  </p>
                  {settings.venue_name && <p className="text-sm text-gray-500 mt-1">{settings.venue_name}</p>}
                </div>

                {/* Enabled sections */}
                {enabledSections.map(section => {
                  const meta = SECTION_META[section.type]
                  return (
                    <div key={section.type} className="border-t pt-4" style={{ borderColor: settings.accent_color + '20' }}>
                      <h2 className="text-lg mb-2 text-center" style={{ color: settings.accent_color }}>{meta.label}</h2>

                      {section.type === 'our_story' && (
                        <p className="text-sm text-gray-600 leading-relaxed text-center max-w-sm mx-auto whitespace-pre-wrap">
                          {(section.data.text as string) || 'Your love story will appear here...'}
                        </p>
                      )}

                      {section.type === 'dress_code' && (
                        <p className="text-sm text-gray-600 text-center">
                          {(section.data.custom_text as string) || DRESS_CODE_PRESETS.find(p => p.value === (section.data.preset as string))?.description || 'Dress code details here'}
                        </p>
                      )}

                      {section.type === 'the_day' && (
                        <div className="text-center text-sm text-gray-600 space-y-1">
                          {(section.data.ceremony_time as string) && <p>Ceremony: {(section.data.ceremony_time as string)}</p>}
                          {(section.data.reception_time as string) && <p>Reception: {(section.data.reception_time as string)}</p>}
                          {(section.data.details as string) && <p className="text-xs text-gray-500 mt-2">{(section.data.details as string)}</p>}
                        </div>
                      )}

                      {section.type === 'registry' && (
                        <div className="flex flex-wrap justify-center gap-2">
                          {((section.data.links as RegistryLink[]) || []).filter(l => l.name).map((link, i) => (
                            <span key={i} className="px-3 py-1.5 rounded-full text-xs font-medium text-white" style={{ backgroundColor: settings.accent_color }}>
                              {link.name}
                            </span>
                          ))}
                          {((section.data.links as RegistryLink[]) || []).filter(l => l.name).length === 0 && (
                            <p className="text-xs text-gray-400">Registry links will appear here</p>
                          )}
                        </div>
                      )}

                      {section.type === 'faq' && (
                        <div className="space-y-2 max-w-sm mx-auto">
                          {((section.data.items as FAQItem[]) || []).filter(f => f.question).map((faq, i) => (
                            <div key={i} className="text-sm">
                              <p className="font-medium" style={{ color: settings.accent_color }}>{faq.question}</p>
                              <p className="text-gray-600 text-xs mt-0.5">{faq.answer}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      {section.type === 'rsvp' && (
                        <div className="text-center">
                          <button className="px-6 py-2 rounded-full text-white text-sm font-medium" style={{ backgroundColor: settings.accent_color }}>
                            RSVP
                          </button>
                        </div>
                      )}

                      {section.type === 'things_to_do' && (
                        <div className="space-y-2 max-w-sm mx-auto">
                          {((section.data.items as ThingsToDoItem[]) || []).filter(t => t.name).map((item, i) => (
                            <div key={i} className="flex items-center gap-2 text-sm">
                              <MapPin className="w-3 h-3 text-gray-400 shrink-0" />
                              <div>
                                <p className="font-medium text-gray-700">{item.name}</p>
                                {item.description && <p className="text-xs text-gray-500">{item.description}</p>}
                              </div>
                              {item.category && <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 ml-auto">{item.category}</span>}
                            </div>
                          ))}
                        </div>
                      )}

                      {['wedding_party', 'transportation', 'nearby_stays', 'photo_gallery'].includes(section.type) && (
                        <p className="text-xs text-gray-400 text-center">
                          {meta.description}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
            <p className="text-[10px] text-gray-400 mt-2 text-center">
              Simplified preview. The published site will be fully responsive.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
