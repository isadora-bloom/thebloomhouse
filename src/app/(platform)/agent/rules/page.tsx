'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  ScrollText,
  Plus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  ShieldCheck,
  ShieldOff,
  Ban,
  CheckCircle2,
  Sparkles,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  X,
  Zap,
  Search,
  Tag,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AIConfig {
  ai_name: string
  ai_emoji: string | null
}

interface Rule {
  id: string
  venue_id: string
  preference_type: string
  content: string
  score: number // 1 = active, 0 = inactive
  sample_count: number
  created_at: string
}

interface BannedPhrase {
  id: string
  content: string
  created_at: string
}

interface ApprovedPhrase {
  id: string
  content: string
  created_at: string
}

type RuleKind = 'always' | 'never' | 'when_then'
type RuleCategory =
  | 'greeting'
  | 'closing'
  | 'tone'
  | 'content'
  | 'pricing'
  | 'availability'
  | 'follow_up'
  | 'escalation'
  | 'general'

// TODO: Replace with venue from auth context
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Preset rules for quick-add
// ---------------------------------------------------------------------------

interface PresetRule {
  text: string
  kind: RuleKind
  category: RuleCategory
}

const PRESET_RULES: PresetRule[] = [
  { text: 'Never discuss pricing in the first email', kind: 'never', category: 'pricing' },
  { text: 'Always mention the tour booking link', kind: 'always', category: 'content' },
  { text: 'Never use the word "unfortunately"', kind: 'never', category: 'tone' },
  { text: "Always use the couple's first names", kind: 'always', category: 'greeting' },
  { text: 'Never promise specific dates without checking availability', kind: 'never', category: 'availability' },
  { text: 'Always mention 2-3 venue highlights naturally in the response', kind: 'always', category: 'content' },
  { text: 'Keep follow-up emails under 3 paragraphs', kind: 'always', category: 'follow_up' },
  { text: 'Never send more than 2 follow-up emails', kind: 'never', category: 'follow_up' },
  { text: 'Always end with a clear next step', kind: 'always', category: 'closing' },
  { text: 'Never use ALL CAPS for emphasis', kind: 'never', category: 'tone' },
  { text: 'Always acknowledge something specific the couple mentioned', kind: 'always', category: 'greeting' },
  { text: 'Never share vendor contact info without owner approval', kind: 'never', category: 'escalation' },
  { text: 'When a couple mentions a tight budget, focus on value over price', kind: 'when_then', category: 'pricing' },
  { text: 'When asked about capacity, mention both indoor and outdoor options', kind: 'when_then', category: 'availability' },
  { text: 'When a couple seems unsure, offer a no-pressure tour', kind: 'when_then', category: 'escalation' },
  { text: 'Always include seasonal language matching the wedding date', kind: 'always', category: 'tone' },
]

// ---------------------------------------------------------------------------
// Common banned phrases for quick-add
// ---------------------------------------------------------------------------

const COMMON_BANNED_PHRASES = [
  'circle back',
  'touch base',
  'per my last email',
  'at your earliest convenience',
  'please don\'t hesitate',
  'I hope this email finds you well',
  'moving forward',
  'synergy',
  'loop you in',
  'ping me',
  'unfortunately',
  'we can\'t',
  'we require',
  'as per policy',
  'to be honest',
  'no worries',
  'just following up',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kindBadge(content: string): { label: string; bg: string; text: string } {
  const lower = content.toLowerCase()
  if (lower.startsWith('never') || lower.startsWith('don\'t') || lower.startsWith('do not'))
    return { label: 'NEVER', bg: 'bg-red-50', text: 'text-red-700' }
  if (lower.startsWith('always'))
    return { label: 'ALWAYS', bg: 'bg-emerald-50', text: 'text-emerald-700' }
  if (lower.startsWith('when'))
    return { label: 'WHEN...', bg: 'bg-amber-50', text: 'text-amber-700' }
  if (lower.startsWith('keep'))
    return { label: 'DO', bg: 'bg-blue-50', text: 'text-blue-700' }
  return { label: 'RULE', bg: 'bg-sage-50', text: 'text-sage-700' }
}

function categoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    greeting: 'Greeting',
    closing: 'Closing',
    tone: 'Tone',
    content: 'Content',
    pricing: 'Pricing',
    availability: 'Availability',
    follow_up: 'Follow-up',
    escalation: 'Escalation',
    general: 'General',
  }
  return labels[cat] || cat
}

function categoryColor(cat: string): string {
  const colors: Record<string, string> = {
    greeting: 'bg-rose-50 text-rose-700',
    closing: 'bg-purple-50 text-purple-700',
    tone: 'bg-amber-50 text-amber-700',
    content: 'bg-blue-50 text-blue-700',
    pricing: 'bg-emerald-50 text-emerald-700',
    availability: 'bg-teal-50 text-teal-700',
    follow_up: 'bg-orange-50 text-orange-700',
    escalation: 'bg-red-50 text-red-700',
    general: 'bg-sage-50 text-sage-700',
  }
  return colors[cat] || 'bg-sage-50 text-sage-700'
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function RuleCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="flex items-center gap-2">
          <div className="h-5 w-16 bg-sage-100 rounded-full" />
          <div className="h-5 w-20 bg-sage-100 rounded-full" />
        </div>
        <div className="h-4 w-full bg-sage-50 rounded" />
        <div className="h-4 w-3/4 bg-sage-50 rounded" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function RulesEditorPage() {
  const supabase = createClient()

  // State
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Rules
  const [rules, setRules] = useState<Rule[]>([])
  const [showAddRule, setShowAddRule] = useState(false)
  const [newRuleKind, setNewRuleKind] = useState<RuleKind>('always')
  const [newRuleCategory, setNewRuleCategory] = useState<RuleCategory>('general')
  const [newRuleText, setNewRuleText] = useState('')
  const [addingRule, setAddingRule] = useState(false)

  // Banned phrases
  const [bannedPhrases, setBannedPhrases] = useState<BannedPhrase[]>([])
  const [newBannedPhrase, setNewBannedPhrase] = useState('')
  const [addingBanned, setAddingBanned] = useState(false)

  // Approved phrases
  const [approvedPhrases, setApprovedPhrases] = useState<ApprovedPhrase[]>([])
  const [newApprovedPhrase, setNewApprovedPhrase] = useState('')
  const [addingApproved, setAddingApproved] = useState(false)

  // Preset filter
  const [presetSearch, setPresetSearch] = useState('')
  const [showPresets, setShowPresets] = useState(false)
  const [showBannedPresets, setShowBannedPresets] = useState(false)

  // Filter
  const [filterCategory, setFilterCategory] = useState<string>('all')

  // ---------- Load data ----------
  const loadData = useCallback(async () => {
    try {
      setLoading(true)

      const [aiRes, rulesRes, bannedRes, approvedRes] = await Promise.all([
        supabase
          .from('venue_ai_config')
          .select('ai_name, ai_emoji')
          .eq('venue_id', VENUE_ID)
          .single(),
        supabase
          .from('voice_preferences')
          .select('*')
          .eq('venue_id', VENUE_ID)
          .eq('preference_type', 'rule')
          .order('created_at', { ascending: false }),
        supabase
          .from('voice_preferences')
          .select('id, content, created_at')
          .eq('venue_id', VENUE_ID)
          .eq('preference_type', 'banned_phrase')
          .order('created_at', { ascending: false }),
        supabase
          .from('voice_preferences')
          .select('id, content, created_at')
          .eq('venue_id', VENUE_ID)
          .eq('preference_type', 'approved_phrase')
          .order('created_at', { ascending: false }),
      ])

      if (aiRes.data) setAiConfig(aiRes.data as AIConfig)
      if (rulesRes.data) setRules(rulesRes.data as Rule[])
      if (bannedRes.data) setBannedPhrases(bannedRes.data as BannedPhrase[])
      if (approvedRes.data) setApprovedPhrases(approvedRes.data as ApprovedPhrase[])

      setError(null)
    } catch (err) {
      console.error('Failed to load rules data:', err)
      setError('Failed to load rules')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // ---------- Add rule ----------
  const handleAddRule = async () => {
    if (!newRuleText.trim()) return
    setAddingRule(true)
    setError(null)

    try {
      // Build rule text with prefix based on kind
      let ruleText = newRuleText.trim()
      // Encode the category in the content using a prefix pattern: [category] text
      const contentWithCategory = `[${newRuleCategory}] ${ruleText}`

      const { data, error: insertError } = await supabase
        .from('voice_preferences')
        .insert({
          venue_id: VENUE_ID,
          preference_type: 'rule',
          content: contentWithCategory,
          score: 1, // active
          sample_count: 1,
        })
        .select()
        .single()

      if (insertError) throw insertError

      if (data) {
        setRules((prev) => [data as Rule, ...prev])
      }

      setNewRuleText('')
      setShowAddRule(false)
    } catch (err) {
      console.error('Failed to add rule:', err)
      setError('Failed to add rule. It may already exist.')
    } finally {
      setAddingRule(false)
    }
  }

  // ---------- Add preset rule ----------
  const handleAddPreset = async (preset: PresetRule) => {
    setError(null)
    try {
      const contentWithCategory = `[${preset.category}] ${preset.text}`

      // Check if already exists
      const exists = rules.some(
        (r) => r.content.toLowerCase() === contentWithCategory.toLowerCase()
      )
      if (exists) {
        setError('This rule already exists')
        return
      }

      const { data, error: insertError } = await supabase
        .from('voice_preferences')
        .insert({
          venue_id: VENUE_ID,
          preference_type: 'rule',
          content: contentWithCategory,
          score: 1,
          sample_count: 1,
        })
        .select()
        .single()

      if (insertError) throw insertError

      if (data) {
        setRules((prev) => [data as Rule, ...prev])
      }
    } catch (err) {
      console.error('Failed to add preset rule:', err)
      setError('Failed to add rule. It may already exist.')
    }
  }

  // ---------- Toggle rule active/inactive ----------
  const handleToggleRule = async (rule: Rule) => {
    try {
      const newScore = rule.score === 1 ? 0 : 1
      const { error: updateError } = await supabase
        .from('voice_preferences')
        .update({ score: newScore })
        .eq('id', rule.id)

      if (updateError) throw updateError

      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, score: newScore } : r))
      )
    } catch (err) {
      console.error('Failed to toggle rule:', err)
      setError('Failed to update rule')
    }
  }

  // ---------- Delete rule ----------
  const handleDeleteRule = async (id: string) => {
    try {
      const { error: deleteError } = await supabase
        .from('voice_preferences')
        .delete()
        .eq('id', id)

      if (deleteError) throw deleteError
      setRules((prev) => prev.filter((r) => r.id !== id))
    } catch (err) {
      console.error('Failed to delete rule:', err)
      setError('Failed to delete rule')
    }
  }

  // ---------- Add banned phrase ----------
  const handleAddBannedPhrase = async (phrase?: string) => {
    const text = (phrase ?? newBannedPhrase).trim()
    if (!text) return
    setAddingBanned(true)
    setError(null)

    try {
      // Check if exists
      const exists = bannedPhrases.some(
        (bp) => bp.content.toLowerCase() === text.toLowerCase()
      )
      if (exists) {
        setError(`"${text}" is already banned`)
        setAddingBanned(false)
        return
      }

      const { data, error: insertError } = await supabase
        .from('voice_preferences')
        .insert({
          venue_id: VENUE_ID,
          preference_type: 'banned_phrase',
          content: text,
          score: 0,
          sample_count: 1,
        })
        .select('id, content, created_at')
        .single()

      if (insertError) throw insertError

      if (data) {
        setBannedPhrases((prev) => [data as BannedPhrase, ...prev])
      }
      setNewBannedPhrase('')
    } catch (err) {
      console.error('Failed to add banned phrase:', err)
      setError('Failed to add banned phrase. It may already exist.')
    } finally {
      setAddingBanned(false)
    }
  }

  // ---------- Delete banned phrase ----------
  const handleDeleteBannedPhrase = async (id: string) => {
    try {
      const { error: deleteError } = await supabase
        .from('voice_preferences')
        .delete()
        .eq('id', id)

      if (deleteError) throw deleteError
      setBannedPhrases((prev) => prev.filter((bp) => bp.id !== id))
    } catch (err) {
      console.error('Failed to delete banned phrase:', err)
      setError('Failed to delete banned phrase')
    }
  }

  // ---------- Add approved phrase ----------
  const handleAddApprovedPhrase = async () => {
    if (!newApprovedPhrase.trim()) return
    setAddingApproved(true)
    setError(null)

    try {
      const text = newApprovedPhrase.trim()
      const exists = approvedPhrases.some(
        (ap) => ap.content.toLowerCase() === text.toLowerCase()
      )
      if (exists) {
        setError(`"${text}" is already in approved phrases`)
        setAddingApproved(false)
        return
      }

      const { data, error: insertError } = await supabase
        .from('voice_preferences')
        .insert({
          venue_id: VENUE_ID,
          preference_type: 'approved_phrase',
          content: text,
          score: 0,
          sample_count: 1,
        })
        .select('id, content, created_at')
        .single()

      if (insertError) throw insertError

      if (data) {
        setApprovedPhrases((prev) => [data as ApprovedPhrase, ...prev])
      }
      setNewApprovedPhrase('')
    } catch (err) {
      console.error('Failed to add approved phrase:', err)
      setError('Failed to add approved phrase. It may already exist.')
    } finally {
      setAddingApproved(false)
    }
  }

  // ---------- Delete approved phrase ----------
  const handleDeleteApprovedPhrase = async (id: string) => {
    try {
      const { error: deleteError } = await supabase
        .from('voice_preferences')
        .delete()
        .eq('id', id)

      if (deleteError) throw deleteError
      setApprovedPhrases((prev) => prev.filter((ap) => ap.id !== id))
    } catch (err) {
      console.error('Failed to delete approved phrase:', err)
      setError('Failed to delete approved phrase')
    }
  }

  // ---------- Parse rule content ----------
  const parseRule = (content: string) => {
    const match = content.match(/^\[(\w+)\]\s*(.*)$/)
    if (match) {
      return { category: match[1], text: match[2] }
    }
    return { category: 'general', text: content }
  }

  // ---------- Filtered rules ----------
  const filteredRules = filterCategory === 'all'
    ? rules
    : rules.filter((r) => parseRule(r.content).category === filterCategory)

  const activeRules = rules.filter((r) => r.score === 1).length
  const inactiveRules = rules.filter((r) => r.score === 0).length

  // Categories present in rules
  const rulesCategories = [...new Set(rules.map((r) => parseRule(r.content).category))]

  // Filtered presets (exclude already-added)
  const existingRuleTexts = new Set(rules.map((r) => r.content.toLowerCase()))
  const filteredPresets = PRESET_RULES.filter((p) => {
    const fullText = `[${p.category}] ${p.text}`.toLowerCase()
    if (existingRuleTexts.has(fullText)) return false
    if (presetSearch) {
      return p.text.toLowerCase().includes(presetSearch.toLowerCase()) ||
        p.category.includes(presetSearch.toLowerCase())
    }
    return true
  })

  // Banned phrases not yet added
  const existingBannedTexts = new Set(bannedPhrases.map((bp) => bp.content.toLowerCase()))
  const availableBannedPresets = COMMON_BANNED_PHRASES.filter(
    (p) => !existingBannedTexts.has(p.toLowerCase())
  )

  const aiName = aiConfig?.ai_name || 'Sage'

  return (
    <div className="space-y-8">
      {/* ---------------------------------------------------------------- */}
      {/* Header                                                          */}
      {/* ---------------------------------------------------------------- */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Rules for {aiName}
        </h1>
        <p className="text-sage-600 max-w-2xl">
          Set clear boundaries for what {aiName} should always do, never do,
          and how to handle specific situations. These rules are checked every time
          {aiName} writes an email.
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Error banner                                                     */}
      {/* ---------------------------------------------------------------- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Stats row                                                        */}
      {/* ---------------------------------------------------------------- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <ScrollText className="w-4 h-4 text-sage-500" />
            <span className="text-xs font-medium text-sage-500">Total Rules</span>
          </div>
          <p className="text-2xl font-bold text-sage-900">{rules.length}</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
            <span className="text-xs font-medium text-sage-500">Active</span>
          </div>
          <p className="text-2xl font-bold text-sage-900">{activeRules}</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <Ban className="w-4 h-4 text-red-500" />
            <span className="text-xs font-medium text-sage-500">Banned Phrases</span>
          </div>
          <p className="text-2xl font-bold text-sage-900">{bannedPhrases.length}</p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle2 className="w-4 h-4 text-blue-500" />
            <span className="text-xs font-medium text-sage-500">Approved Phrases</span>
          </div>
          <p className="text-2xl font-bold text-sage-900">{approvedPhrases.length}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* ============================================================ */}
        {/* LEFT: Rules list + Add form                                  */}
        {/* ============================================================ */}
        <div className="lg:col-span-2 space-y-6">
          {/* ---- Add New Rule ---- */}
          <div className="bg-surface border border-border rounded-xl shadow-sm">
            <div className="px-6 pt-6 pb-4 border-b border-border">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-sage-100 rounded-lg flex items-center justify-center">
                    <Plus className="w-5 h-5 text-sage-600" />
                  </div>
                  <div>
                    <h2 className="font-heading text-lg font-semibold text-sage-900">
                      Add New Rule
                    </h2>
                    <p className="text-sm text-sage-500">
                      Tell {aiName} exactly how to behave
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowAddRule(!showAddRule)}
                  className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
                >
                  {showAddRule ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                </button>
              </div>
            </div>

            {showAddRule && (
              <div className="p-6 space-y-4">
                {/* Rule kind selector */}
                <div>
                  <label className="text-sm font-medium text-sage-700 mb-2 block">Rule type</label>
                  <div className="flex items-center gap-2">
                    {([
                      { value: 'always' as RuleKind, label: 'Always do', bg: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
                      { value: 'never' as RuleKind, label: 'Never do', bg: 'bg-red-50 text-red-700 border-red-200' },
                      { value: 'when_then' as RuleKind, label: 'When...then...', bg: 'bg-amber-50 text-amber-700 border-amber-200' },
                    ]).map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => {
                          setNewRuleKind(opt.value)
                          // Pre-fill prefix
                          if (opt.value === 'always' && !newRuleText.startsWith('Always')) {
                            setNewRuleText('Always ')
                          } else if (opt.value === 'never' && !newRuleText.startsWith('Never')) {
                            setNewRuleText('Never ')
                          } else if (opt.value === 'when_then' && !newRuleText.startsWith('When')) {
                            setNewRuleText('When ')
                          }
                        }}
                        className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                          newRuleKind === opt.value
                            ? opt.bg
                            : 'border-sage-200 text-sage-600 hover:bg-sage-50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Category */}
                <div>
                  <label className="text-sm font-medium text-sage-700 mb-2 block">Category</label>
                  <div className="flex items-center gap-2 flex-wrap">
                    {([
                      'greeting', 'closing', 'tone', 'content',
                      'pricing', 'availability', 'follow_up', 'escalation', 'general',
                    ] as RuleCategory[]).map((cat) => (
                      <button
                        key={cat}
                        onClick={() => setNewRuleCategory(cat)}
                        className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors ${
                          newRuleCategory === cat
                            ? categoryColor(cat)
                            : 'bg-sage-50 text-sage-500 hover:bg-sage-100'
                        }`}
                      >
                        {categoryLabel(cat)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Rule text */}
                <div>
                  <label className="text-sm font-medium text-sage-700 mb-2 block">Rule</label>
                  <textarea
                    value={newRuleText}
                    onChange={(e) => setNewRuleText(e.target.value)}
                    placeholder={
                      newRuleKind === 'always'
                        ? 'Always mention the tour booking link in the first response'
                        : newRuleKind === 'never'
                          ? 'Never discuss pricing without owner approval'
                          : 'When a couple mentions a tight budget, focus on value and flexibility'
                    }
                    rows={2}
                    className="w-full px-3 py-2.5 border border-sage-200 rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-none bg-warm-white"
                  />
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleAddRule}
                    disabled={!newRuleText.trim() || addingRule}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-sage-500 hover:bg-sage-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-4 h-4" />
                    {addingRule ? 'Adding...' : 'Add Rule'}
                  </button>
                  <button
                    onClick={() => {
                      setShowAddRule(false)
                      setNewRuleText('')
                    }}
                    className="px-4 py-2.5 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* ---- Active Rules ---- */}
          <div className="bg-surface border border-border rounded-xl shadow-sm">
            <div className="px-6 pt-6 pb-4 border-b border-border">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-emerald-50 rounded-lg flex items-center justify-center">
                    <ShieldCheck className="w-5 h-5 text-emerald-600" />
                  </div>
                  <div>
                    <h2 className="font-heading text-lg font-semibold text-sage-900">
                      Active Rules ({filteredRules.length})
                    </h2>
                    <p className="text-sm text-sage-500">
                      {aiName} follows these every time it writes an email
                    </p>
                  </div>
                </div>
                {!showAddRule && (
                  <button
                    onClick={() => setShowAddRule(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-sage-600 border border-sage-300 rounded-lg hover:bg-sage-50 transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add
                  </button>
                )}
              </div>

              {/* Category filter */}
              {rulesCategories.length > 1 && (
                <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                  <button
                    onClick={() => setFilterCategory('all')}
                    className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors ${
                      filterCategory === 'all'
                        ? 'bg-sage-200 text-sage-800'
                        : 'text-sage-500 hover:bg-sage-100'
                    }`}
                  >
                    All
                  </button>
                  {rulesCategories.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setFilterCategory(cat)}
                      className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors ${
                        filterCategory === cat
                          ? categoryColor(cat)
                          : 'text-sage-500 hover:bg-sage-100'
                      }`}
                    >
                      {categoryLabel(cat)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="divide-y divide-border">
              {loading ? (
                <div className="p-6 space-y-4">
                  <RuleCardSkeleton />
                  <RuleCardSkeleton />
                  <RuleCardSkeleton />
                </div>
              ) : filteredRules.length === 0 ? (
                <div className="p-12 text-center">
                  <ScrollText className="w-10 h-10 text-sage-300 mx-auto mb-3" />
                  <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
                    No rules yet
                  </h3>
                  <p className="text-sm text-sage-600 max-w-md mx-auto mb-4">
                    Start by adding custom rules above, or use the preset rules on the right
                    to quickly set up common guidelines.
                  </p>
                  <button
                    onClick={() => setShowAddRule(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-sage-500 hover:bg-sage-600 text-white rounded-lg transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Add Your First Rule
                  </button>
                </div>
              ) : (
                filteredRules.map((rule) => {
                  const { category, text } = parseRule(rule.content)
                  const badge = kindBadge(text)
                  const isActive = rule.score === 1

                  return (
                    <div
                      key={rule.id}
                      className={`px-6 py-4 transition-colors ${
                        !isActive ? 'opacity-50 bg-sage-50/50' : ''
                      }`}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          {/* Badges */}
                          <div className="flex items-center gap-2 mb-2">
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ${badge.bg} ${badge.text}`}
                            >
                              {badge.label}
                            </span>
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${categoryColor(category)}`}
                            >
                              {categoryLabel(category)}
                            </span>
                            {!isActive && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-sage-100 text-sage-500">
                                Inactive
                              </span>
                            )}
                          </div>

                          {/* Rule text */}
                          <p className="text-sm text-sage-800 leading-relaxed">{text}</p>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            onClick={() => handleToggleRule(rule)}
                            className={`p-1.5 rounded-lg transition-colors ${
                              isActive
                                ? 'text-emerald-500 hover:bg-emerald-50'
                                : 'text-sage-400 hover:bg-sage-100'
                            }`}
                            title={isActive ? 'Deactivate rule' : 'Activate rule'}
                          >
                            {isActive ? (
                              <ToggleRight className="w-5 h-5" />
                            ) : (
                              <ToggleLeft className="w-5 h-5" />
                            )}
                          </button>
                          <button
                            onClick={() => handleDeleteRule(rule.id)}
                            className="p-1.5 rounded-lg text-sage-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                            title="Delete rule"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* ---- Banned Phrases ---- */}
          <div className="bg-surface border border-border rounded-xl shadow-sm">
            <div className="px-6 pt-6 pb-4 border-b border-border">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center">
                    <Ban className="w-5 h-5 text-red-500" />
                  </div>
                  <div>
                    <h2 className="font-heading text-lg font-semibold text-sage-900">
                      Banned Phrases ({bannedPhrases.length})
                    </h2>
                    <p className="text-sm text-sage-500">
                      {aiName} will never use these words or phrases
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowBannedPresets(!showBannedPresets)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-sage-600 border border-sage-300 rounded-lg hover:bg-sage-50 transition-colors"
                >
                  <Zap className="w-3.5 h-3.5" />
                  Quick Add
                </button>
              </div>
            </div>

            <div className="p-6 space-y-4">
              {/* Add new banned phrase */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newBannedPhrase}
                  onChange={(e) => setNewBannedPhrase(e.target.value)}
                  placeholder="Type a phrase to ban..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddBannedPhrase()
                  }}
                  className="flex-1 px-3 py-2 border border-sage-200 rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 bg-warm-white"
                />
                <button
                  onClick={() => handleAddBannedPhrase()}
                  disabled={!newBannedPhrase.trim() || addingBanned}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Ban className="w-3.5 h-3.5" />
                  Ban
                </button>
              </div>

              {/* Quick-add common banned phrases */}
              {showBannedPresets && availableBannedPresets.length > 0 && (
                <div className="bg-red-50/50 border border-red-100 rounded-lg p-4">
                  <p className="text-xs font-medium text-red-700 mb-3">
                    Common wedding industry cliches — click to ban:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {availableBannedPresets.map((phrase) => (
                      <button
                        key={phrase}
                        onClick={() => handleAddBannedPhrase(phrase)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-full hover:bg-red-50 transition-colors"
                      >
                        <Plus className="w-3 h-3" />
                        {phrase}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Current banned phrases */}
              {bannedPhrases.length === 0 ? (
                <p className="text-sm text-sage-400 text-center py-4">
                  No banned phrases yet. Add phrases that feel off-brand.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {bannedPhrases.map((bp) => (
                    <span
                      key={bp.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-red-50 text-red-700 border border-red-200 rounded-full group"
                    >
                      <Ban className="w-3 h-3" />
                      &ldquo;{bp.content}&rdquo;
                      <button
                        onClick={() => handleDeleteBannedPhrase(bp.id)}
                        className="ml-0.5 p-0.5 rounded-full text-red-400 hover:text-red-600 hover:bg-red-100 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ---- Approved Phrases ---- */}
          <div className="bg-surface border border-border rounded-xl shadow-sm">
            <div className="px-6 pt-6 pb-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center">
                  <CheckCircle2 className="w-5 h-5 text-blue-500" />
                </div>
                <div>
                  <h2 className="font-heading text-lg font-semibold text-sage-900">
                    Approved Phrases ({approvedPhrases.length})
                  </h2>
                  <p className="text-sm text-sage-500">
                    Phrases you love — {aiName} will weave these in naturally
                  </p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-4">
              {/* Add new approved phrase */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newApprovedPhrase}
                  onChange={(e) => setNewApprovedPhrase(e.target.value)}
                  placeholder="Add a phrase you want Sage to use..."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddApprovedPhrase()
                  }}
                  className="flex-1 px-3 py-2 border border-sage-200 rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 bg-warm-white"
                />
                <button
                  onClick={handleAddApprovedPhrase}
                  disabled={!newApprovedPhrase.trim() || addingApproved}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Add
                </button>
              </div>

              {/* Current approved phrases */}
              {approvedPhrases.length === 0 ? (
                <p className="text-sm text-sage-400 text-center py-4">
                  No approved phrases yet. Add signature phrases that define your voice.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {approvedPhrases.map((ap) => (
                    <span
                      key={ap.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded-full group"
                    >
                      <CheckCircle2 className="w-3 h-3" />
                      &ldquo;{ap.content}&rdquo;
                      <button
                        onClick={() => handleDeleteApprovedPhrase(ap.id)}
                        className="ml-0.5 p-0.5 rounded-full text-blue-400 hover:text-blue-600 hover:bg-blue-100 transition-colors opacity-0 group-hover:opacity-100"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* RIGHT: Preset rules + info                                   */}
        {/* ============================================================ */}
        <div className="space-y-6">
          {/* ---- Preset Rules Quick Add ---- */}
          <div className="bg-surface border border-border rounded-xl shadow-sm">
            <div className="px-6 pt-6 pb-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-amber-50 rounded-lg flex items-center justify-center">
                  <Zap className="w-5 h-5 text-amber-600" />
                </div>
                <div>
                  <h2 className="font-heading text-lg font-semibold text-sage-900">
                    Preset Rules
                  </h2>
                  <p className="text-sm text-sage-500">
                    One-click add common rules
                  </p>
                </div>
              </div>
              {/* Search */}
              <div className="relative mt-3">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sage-400" />
                <input
                  type="text"
                  value={presetSearch}
                  onChange={(e) => setPresetSearch(e.target.value)}
                  placeholder="Filter presets..."
                  className="w-full pl-9 pr-3 py-1.5 border border-sage-200 rounded-lg text-xs text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 bg-warm-white"
                />
              </div>
            </div>

            <div className="divide-y divide-border max-h-[500px] overflow-y-auto">
              {filteredPresets.length === 0 ? (
                <div className="p-6 text-center">
                  <Sparkles className="w-6 h-6 text-sage-300 mx-auto mb-2" />
                  <p className="text-xs text-sage-500">
                    {rules.length > 0
                      ? 'All preset rules have been added!'
                      : 'No matching presets found'}
                  </p>
                </div>
              ) : (
                filteredPresets.map((preset, i) => {
                  const badge = kindBadge(preset.text)

                  return (
                    <div key={i} className="px-6 py-3 hover:bg-sage-50/50 transition-colors">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-1">
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold ${badge.bg} ${badge.text}`}
                            >
                              {badge.label}
                            </span>
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium ${categoryColor(preset.category)}`}
                            >
                              {categoryLabel(preset.category)}
                            </span>
                          </div>
                          <p className="text-xs text-sage-700 leading-relaxed">
                            {preset.text}
                          </p>
                        </div>
                        <button
                          onClick={() => handleAddPreset(preset)}
                          className="shrink-0 p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-100 transition-colors"
                          title="Add this rule"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* ---- Universal Rules (read-only info) ---- */}
          <div className="bg-gradient-to-br from-sage-50 to-teal-50 border border-sage-200 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <ShieldCheck className="w-4 h-4 text-sage-600" />
              <h3 className="font-heading text-sm font-semibold text-sage-800">
                Built-in Safety Rules
              </h3>
            </div>
            <p className="text-xs text-sage-600 mb-3">
              These universal rules are always active and cannot be overridden:
            </p>
            <ul className="space-y-2">
              {[
                'AI transparency — always honest about being AI',
                'Anti-hallucination — never fabricates facts',
                'Safety escalation — flags emergencies and upset couples',
                'Positive framing — reframes negatives positively',
                'Alan Berg methodology — short, mobile-friendly, CTA-focused',
                'Banned phrases — industry cliches automatically avoided',
              ].map((rule, i) => (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle2 className="w-3.5 h-3.5 text-sage-500 mt-0.5 shrink-0" />
                  <span className="text-xs text-sage-600">{rule}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* ---- How Rules Work ---- */}
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <h3 className="font-heading text-sm font-semibold text-sage-800 mb-3">
              How Rules Work
            </h3>
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <Tag className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-medium text-sage-800">ALWAYS rules</p>
                  <p className="text-xs text-sage-500">
                    {aiName} must include this in every relevant email
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Tag className="w-3.5 h-3.5 text-red-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-medium text-sage-800">NEVER rules</p>
                  <p className="text-xs text-sage-500">
                    Hard boundaries {aiName} will not cross
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Tag className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-medium text-sage-800">WHEN...THEN rules</p>
                  <p className="text-xs text-sage-500">
                    Conditional logic for specific situations
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Tag className="w-3.5 h-3.5 text-sage-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-medium text-sage-800">Toggling</p>
                  <p className="text-xs text-sage-500">
                    Deactivate rules without deleting them — test how {aiName} performs
                    with different configurations
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
