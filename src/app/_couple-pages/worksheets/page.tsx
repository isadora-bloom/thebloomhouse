'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import {
  ClipboardList,
  Check,
  ChevronDown,
  ChevronUp,
  Save,
  BookOpen,
  Sparkles,
  DollarSign,
  Brain,
  ListOrdered,
  Heart,
  MessageSquare,
  XCircle,
  Send,
  AlertTriangle,
  ThumbsUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

type SectionKey = 'priorities' | 'story' | 'feelings' | 'splurge' | 'skip' | 'memories' | 'values' | 'alignment' | 'happily_skipping'

interface WorksheetRecord {
  id: string
  section: SectionKey
  content: Record<string, unknown>
  updated_at: string
}

interface SectionConfig {
  key: SectionKey
  title: string
  description: string
  icon: typeof ClipboardList
}

const SECTIONS: SectionConfig[] = [
  { key: 'priorities', title: 'Priorities', description: 'Rank what matters most to you', icon: ListOrdered },
  { key: 'values', title: 'Values Statement', description: 'Define what your wedding is really about', icon: Heart },
  { key: 'story', title: 'Our Story', description: 'How you met, your proposal, your journey', icon: BookOpen },
  { key: 'feelings', title: 'Our Vibe', description: 'What feelings do you want on your day?', icon: Sparkles },
  { key: 'splurge', title: 'Splurge vs Skip', description: 'Where to invest and where to save', icon: DollarSign },
  { key: 'happily_skipping', title: "Happily Skipping", description: 'Traditions you are choosing to skip', icon: XCircle },
  { key: 'alignment', title: 'Alignment Check', description: 'See where you and your partner agree', icon: MessageSquare },
  { key: 'memories', title: 'Memories & Notes', description: 'Personal reminders and reflections', icon: Brain },
]

const PRIORITY_CATEGORIES = [
  'Venue',
  'Food & Drink',
  'Photography',
  'Music & Entertainment',
  'Flowers & Decor',
  'Attire',
  'Guest Experience',
  'Guest Count',
  'Formality',
  'Cultural Elements',
]

const VIBE_OPTIONS = [
  'Intimate',
  'Grand',
  'Casual',
  'Formal',
  'Rustic',
  'Modern',
  'Classic',
  'Bohemian',
  'Cultural',
  'Minimal',
]

const HAPPILY_SKIPPING_OPTIONS = [
  'Favors',
  'Programs',
  'Formal Exit',
  'Guest Book',
  'Bouquet Toss',
  'Garter Toss',
  'Cake Cutting',
  'Flower Girl',
  'Ring Bearer',
  'Receiving Line',
  'Unity Ceremony',
  'Dollar Dance',
]

interface ValuesData {
  about_1: string
  about_2: string
  guests_feel: string
  splurge_on: string
  splurge_because: string
  skip_what: string
  skip_because: string
  remember: string
}

const EMPTY_VALUES: ValuesData = {
  about_1: '',
  about_2: '',
  guests_feel: '',
  splurge_on: '',
  splurge_because: '',
  skip_what: '',
  skip_because: '',
  remember: '',
}

const SPLURGE_SKIP_ITEMS = [
  'Photography',
  'Videography',
  'Flowers',
  'Catering',
  'Cake',
  'DJ / Band',
  'Invitations',
  'Favors',
  'Transportation',
  'Lighting',
  'Photo Booth',
  'Dress / Attire',
  'Hair & Makeup',
  'Planner / Coordinator',
]

// ---------------------------------------------------------------------------
// Worksheets Page
// ---------------------------------------------------------------------------

export default function WorksheetsPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [records, setRecords] = useState<Record<SectionKey, WorksheetRecord | null>>({
    priorities: null,
    story: null,
    feelings: null,
    splurge: null,
    skip: null,
    memories: null,
    values: null,
    alignment: null,
    happily_skipping: null,
  })
  const [loading, setLoading] = useState(true)
  const [expandedSection, setExpandedSection] = useState<SectionKey | null>('priorities')
  const [savingSection, setSavingSection] = useState<SectionKey | null>(null)
  const [savedSection, setSavedSection] = useState<SectionKey | null>(null)
  const [sendingToTeam, setSendingToTeam] = useState(false)
  const [sentToTeam, setSentToTeam] = useState(false)

  // Local form state per section
  const [priorities, setPriorities] = useState<string[]>([...PRIORITY_CATEGORIES])
  const [storyData, setStoryData] = useState({ how_we_met: '', proposal: '', our_story: '' })
  const [vibeSelections, setVibeSelections] = useState<string[]>([])
  const [splurgeItems, setSplurgeItems] = useState<string[]>([])
  const [skipItems, setSkipItems] = useState<string[]>([])
  const [memories, setMemories] = useState('')
  const [valuesData, setValuesData] = useState<ValuesData>({ ...EMPTY_VALUES })
  const [happilySkipping, setHappilySkipping] = useState<string[]>([])

  // Partner priority data for alignment check (partner2 priorities stored under a different key)
  const [partner2Priorities, setPartner2Priorities] = useState<string[] | null>(null)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchWorksheets = useCallback(async () => {
    const { data, error } = await supabase
      .from('wedding_worksheets')
      .select('*')
      .eq('wedding_id', weddingId)

    if (!error && data) {
      const bySection: Record<string, WorksheetRecord> = {}
      for (const row of data as WorksheetRecord[]) {
        bySection[row.section] = row
      }

      setRecords((prev) => ({
        ...prev,
        ...bySection,
      }))

      // Hydrate local state from DB
      if (bySection.priorities?.content) {
        const c = bySection.priorities.content as { ranked?: string[] }
        if (c.ranked?.length) setPriorities(c.ranked)
      }
      if (bySection.story?.content) {
        const c = bySection.story.content as { how_we_met?: string; proposal?: string; our_story?: string }
        setStoryData({
          how_we_met: c.how_we_met || '',
          proposal: c.proposal || '',
          our_story: c.our_story || '',
        })
      }
      if (bySection.feelings?.content) {
        const c = bySection.feelings.content as { selected?: string[] }
        if (c.selected) setVibeSelections(c.selected)
      }
      if (bySection.splurge?.content) {
        const c = bySection.splurge.content as { splurge?: string[]; skip?: string[] }
        if (c.splurge) setSplurgeItems(c.splurge)
        if (c.skip) setSkipItems(c.skip)
      }
      if (bySection.memories?.content) {
        const c = bySection.memories.content as { text?: string }
        if (c.text) setMemories(c.text)
      }
      if (bySection.values?.content) {
        const c = bySection.values.content as Partial<ValuesData>
        setValuesData({ ...EMPTY_VALUES, ...c })
      }
      if (bySection.happily_skipping?.content) {
        const c = bySection.happily_skipping.content as { items?: string[] }
        if (c.items) setHappilySkipping(c.items)
      }
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchWorksheets()
  }, [fetchWorksheets])

  // ---- Save ----
  async function saveSection(section: SectionKey) {
    setSavingSection(section)

    let content: Record<string, unknown> = {}
    switch (section) {
      case 'priorities':
        content = { ranked: priorities }
        break
      case 'story':
        content = storyData
        break
      case 'feelings':
        content = { selected: vibeSelections }
        break
      case 'splurge':
        content = { splurge: splurgeItems, skip: skipItems }
        break
      case 'memories':
        content = { text: memories }
        break
      case 'values':
        content = { ...valuesData }
        break
      case 'happily_skipping':
        content = { items: happilySkipping }
        break
      case 'alignment':
        // Alignment is read-only / computed, no save needed
        return
    }

    const existing = records[section]

    if (existing) {
      await supabase
        .from('wedding_worksheets')
        .update({ content, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    } else {
      await supabase.from('wedding_worksheets').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        section,
        content,
      })
    }

    setSavingSection(null)
    setSavedSection(section)
    setTimeout(() => setSavedSection(null), 2000)
    fetchWorksheets()
  }

  // ---- Priority reorder ----
  function movePriority(index: number, direction: 'up' | 'down') {
    const newList = [...priorities]
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= newList.length) return
    ;[newList[index], newList[targetIndex]] = [newList[targetIndex], newList[index]]
    setPriorities(newList)
  }

  // ---- Toggle helpers ----
  function toggleVibe(vibe: string) {
    setVibeSelections((prev) =>
      prev.includes(vibe) ? prev.filter((v) => v !== vibe) : [...prev, vibe]
    )
  }

  function toggleSplurge(item: string) {
    setSplurgeItems((prev) =>
      prev.includes(item) ? prev.filter((i) => i !== item) : [...prev, item]
    )
    // Remove from skip if adding to splurge
    setSkipItems((prev) => prev.filter((i) => i !== item))
  }

  function toggleSkip(item: string) {
    setSkipItems((prev) =>
      prev.includes(item) ? prev.filter((i) => i !== item) : [...prev, item]
    )
    // Remove from splurge if adding to skip
    setSplurgeItems((prev) => prev.filter((i) => i !== item))
  }

  // ---- Toggle happily skipping ----
  function toggleHappilySkipping(item: string) {
    setHappilySkipping((prev) =>
      prev.includes(item) ? prev.filter((i) => i !== item) : [...prev, item]
    )
  }

  // ---- Save & Send to Team ----
  async function saveAndSendToTeam() {
    setSendingToTeam(true)
    try {
      // Save all sections first
      for (const section of SECTIONS) {
        if (section.key === 'alignment') continue
        await saveSection(section.key)
      }

      // Create admin notification
      await supabase.from('admin_notifications').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        type: 'worksheet_submitted',
        title: 'Worksheets submitted',
        body: 'The couple has submitted their wedding worksheets for review.',
      })

      setSentToTeam(true)
      setTimeout(() => setSentToTeam(false), 4000)
    } catch (err) {
      console.error('Failed to send to team:', err)
    } finally {
      setSendingToTeam(false)
    }
  }

  // ---- Alignment computation ----
  // For the alignment check, we compare partner1 and partner2 priority rankings
  // In a real implementation, each partner would have their own priorities saved under a user key.
  // For now, we use the current priorities as partner1 and check if partner2 data exists.
  const alignmentAgree: string[] = []
  const alignmentConversation: string[] = []

  if (partner2Priorities && partner2Priorities.length > 0) {
    const p1Top3 = priorities.slice(0, 3)
    const p2Top3 = partner2Priorities.slice(0, 3)

    // Items where both ranked in top 3
    for (const item of p1Top3) {
      if (p2Top3.includes(item)) alignmentAgree.push(item)
    }

    // Items where rankings differ by 5+ positions
    for (const item of PRIORITY_CATEGORIES) {
      const p1Idx = priorities.indexOf(item)
      const p2Idx = partner2Priorities.indexOf(item)
      if (p1Idx >= 0 && p2Idx >= 0 && Math.abs(p1Idx - p2Idx) >= 5) {
        alignmentConversation.push(item)
      }
    }
  }

  // ---- Progress ----
  const completedSections = SECTIONS.filter((s) => {
    const rec = records[s.key]
    if (!rec) return false
    const c = rec.content
    if (!c || Object.keys(c).length === 0) return false
    return true
  }).length

  const progressPct = Math.round((completedSections / SECTIONS.length) * 100)

  if (contextLoading || !weddingId || !venueId || loading) {
    return (
      <div className="space-y-6">
        <div className="h-10 bg-gray-100 rounded-lg w-64 animate-pulse" />
        <div className="animate-pulse space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-20 bg-gray-100 rounded-xl" />
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
          Wedding Worksheets
        </h1>
        <p className="text-gray-500 text-sm">
          Work through these together. There are no wrong answers.
        </p>
      </div>

      {/* Progress Bar */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-gray-700">
            {completedSections} of {SECTIONS.length} sections started
          </span>
          <span className="text-sm font-medium" style={{ color: 'var(--couple-primary)' }}>
            {progressPct}%
          </span>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-2">
          <div
            className="h-2 rounded-full transition-all duration-500"
            style={{ width: `${progressPct}%`, backgroundColor: 'var(--couple-primary)' }}
          />
        </div>
      </div>

      {/* Save & Send to Team */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-700">Ready to share with your coordinator?</p>
          <p className="text-xs text-gray-400">This saves all sections and notifies your venue team.</p>
        </div>
        <button
          onClick={saveAndSendToTeam}
          disabled={sendingToTeam}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 shrink-0"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          {sentToTeam ? (
            <>
              <Check className="w-4 h-4" />
              Sent to Team
            </>
          ) : sendingToTeam ? (
            'Sending...'
          ) : (
            <>
              <Send className="w-4 h-4" />
              Save &amp; Send to Team
            </>
          )}
        </button>
      </div>

      {/* Sections */}
      <div className="space-y-3">
        {SECTIONS.map((section) => {
          const isExpanded = expandedSection === section.key
          const Icon = section.icon
          const hasData = !!records[section.key]

          return (
            <div
              key={section.key}
              className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden"
            >
              {/* Section Header */}
              <button
                onClick={() => setExpandedSection(isExpanded ? null : section.key)}
                className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: 'var(--couple-primary)', opacity: 0.1 }}
                  >
                    <Icon className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-800">{section.title}</span>
                      {hasData && (
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--couple-primary)' }} />
                      )}
                    </div>
                    <p className="text-xs text-gray-500">{section.description}</p>
                  </div>
                </div>
                {isExpanded ? (
                  <ChevronUp className="w-5 h-5 text-gray-400" />
                ) : (
                  <ChevronDown className="w-5 h-5 text-gray-400" />
                )}
              </button>

              {/* Section Content */}
              {isExpanded && (
                <div className="px-5 pb-5 border-t border-gray-50">
                  <div className="pt-4 space-y-4">
                    {/* PRIORITIES */}
                    {section.key === 'priorities' && (
                      <>
                        <p className="text-sm text-gray-600">
                          Drag or use arrows to rank these from most to least important to you as a couple.
                        </p>
                        <div className="space-y-1">
                          {priorities.map((item, idx) => (
                            <div
                              key={item}
                              className="flex items-center gap-3 bg-gray-50 rounded-lg px-4 py-2.5"
                            >
                              <span className="text-sm font-bold text-gray-400 w-6 text-center tabular-nums">
                                {idx + 1}
                              </span>
                              <span className="text-sm text-gray-800 flex-1">{item}</span>
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => movePriority(idx, 'up')}
                                  disabled={idx === 0}
                                  className="p-1 rounded text-gray-400 hover:text-gray-600 disabled:opacity-30"
                                >
                                  <ChevronUp className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={() => movePriority(idx, 'down')}
                                  disabled={idx === priorities.length - 1}
                                  className="p-1 rounded text-gray-400 hover:text-gray-600 disabled:opacity-30"
                                >
                                  <ChevronDown className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {/* STORY */}
                    {section.key === 'story' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">How We Met</label>
                          <textarea
                            value={storyData.how_we_met}
                            onChange={(e) => setStoryData({ ...storyData, how_we_met: e.target.value })}
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                            rows={4}
                            placeholder="Tell the story of how you two met..."
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">The Proposal</label>
                          <textarea
                            value={storyData.proposal}
                            onChange={(e) => setStoryData({ ...storyData, proposal: e.target.value })}
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                            rows={4}
                            placeholder="How did the proposal happen?"
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Our Story</label>
                          <textarea
                            value={storyData.our_story}
                            onChange={(e) => setStoryData({ ...storyData, our_story: e.target.value })}
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                            rows={6}
                            placeholder="Anything else you want to share about your journey together..."
                          />
                        </div>
                      </>
                    )}

                    {/* VIBE */}
                    {section.key === 'feelings' && (
                      <>
                        <p className="text-sm text-gray-600">
                          Pick all the feelings that describe your ideal wedding day.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {VIBE_OPTIONS.map((vibe) => {
                            const selected = vibeSelections.includes(vibe)
                            return (
                              <button
                                key={vibe}
                                onClick={() => toggleVibe(vibe)}
                                className={cn(
                                  'px-4 py-2 rounded-full text-sm font-medium border transition-all',
                                  selected
                                    ? 'text-white border-transparent'
                                    : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                                )}
                                style={selected ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                              >
                                {selected && <Check className="w-3.5 h-3.5 inline mr-1.5" />}
                                {vibe}
                              </button>
                            )
                          })}
                        </div>
                      </>
                    )}

                    {/* SPLURGE vs SKIP */}
                    {section.key === 'splurge' && (
                      <>
                        <p className="text-sm text-gray-600">
                          For each item, decide: splurge (invest more) or skip (save here). Leave blank if unsure.
                        </p>
                        <div className="space-y-1">
                          {SPLURGE_SKIP_ITEMS.map((item) => {
                            const isSplurge = splurgeItems.includes(item)
                            const isSkip = skipItems.includes(item)

                            return (
                              <div
                                key={item}
                                className="flex items-center gap-3 bg-gray-50 rounded-lg px-4 py-2.5"
                              >
                                <span className="text-sm text-gray-800 flex-1">{item}</span>
                                <div className="flex items-center gap-2">
                                  <button
                                    onClick={() => toggleSplurge(item)}
                                    className={cn(
                                      'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                                      isSplurge
                                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                        : 'bg-white text-gray-400 border-gray-200 hover:text-emerald-600 hover:border-emerald-200'
                                    )}
                                  >
                                    Splurge
                                  </button>
                                  <button
                                    onClick={() => toggleSkip(item)}
                                    className={cn(
                                      'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                                      isSkip
                                        ? 'bg-gray-200 text-gray-700 border-gray-300'
                                        : 'bg-white text-gray-400 border-gray-200 hover:text-gray-600 hover:border-gray-300'
                                    )}
                                  >
                                    Skip
                                  </button>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </>
                    )}

                    {/* MEMORIES */}
                    {section.key === 'memories' && (
                      <>
                        <p className="text-sm text-gray-600">
                          A space for personal reminders, notes to each other, or things you want to remember about this time.
                        </p>
                        <textarea
                          value={memories}
                          onChange={(e) => setMemories(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                          style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                          rows={8}
                          placeholder="Your personal notes and memories..."
                        />
                      </>
                    )}

                    {/* VALUES STATEMENT BUILDER */}
                    {section.key === 'values' && (
                      <>
                        <p className="text-sm text-gray-600 mb-4">
                          Fill in the blanks to create your wedding values statement. This helps your team understand what matters most to you.
                        </p>
                        <div className="space-y-5">
                          <div className="text-sm text-gray-800 leading-relaxed">
                            <span>{'"'}Our wedding is about </span>
                            <input
                              type="text"
                              value={valuesData.about_1}
                              onChange={(e) => setValuesData({ ...valuesData, about_1: e.target.value })}
                              className="inline-block w-40 sm:w-48 border-b-2 border-gray-300 bg-transparent text-sm px-1 py-0.5 focus:outline-none focus:border-current mx-1"
                              style={{ borderColor: valuesData.about_1 ? 'var(--couple-primary)' : undefined, color: 'var(--couple-primary)' }}
                              placeholder="______"
                            />
                            <span> and </span>
                            <input
                              type="text"
                              value={valuesData.about_2}
                              onChange={(e) => setValuesData({ ...valuesData, about_2: e.target.value })}
                              className="inline-block w-40 sm:w-48 border-b-2 border-gray-300 bg-transparent text-sm px-1 py-0.5 focus:outline-none focus:border-current mx-1"
                              style={{ borderColor: valuesData.about_2 ? 'var(--couple-primary)' : undefined, color: 'var(--couple-primary)' }}
                              placeholder="______"
                            />
                            <span>{'"'}</span>
                          </div>

                          <div className="text-sm text-gray-800 leading-relaxed">
                            <span>{'"'}We want our guests to feel </span>
                            <input
                              type="text"
                              value={valuesData.guests_feel}
                              onChange={(e) => setValuesData({ ...valuesData, guests_feel: e.target.value })}
                              className="inline-block w-40 sm:w-56 border-b-2 border-gray-300 bg-transparent text-sm px-1 py-0.5 focus:outline-none focus:border-current mx-1"
                              style={{ borderColor: valuesData.guests_feel ? 'var(--couple-primary)' : undefined, color: 'var(--couple-primary)' }}
                              placeholder="______"
                            />
                            <span>{'"'}</span>
                          </div>

                          <div className="text-sm text-gray-800 leading-relaxed">
                            <span>{'"'}We{"\'"}re willing to splurge on </span>
                            <input
                              type="text"
                              value={valuesData.splurge_on}
                              onChange={(e) => setValuesData({ ...valuesData, splurge_on: e.target.value })}
                              className="inline-block w-36 sm:w-44 border-b-2 border-gray-300 bg-transparent text-sm px-1 py-0.5 focus:outline-none focus:border-current mx-1"
                              style={{ borderColor: valuesData.splurge_on ? 'var(--couple-primary)' : undefined, color: 'var(--couple-primary)' }}
                              placeholder="______"
                            />
                            <span> because </span>
                            <input
                              type="text"
                              value={valuesData.splurge_because}
                              onChange={(e) => setValuesData({ ...valuesData, splurge_because: e.target.value })}
                              className="inline-block w-36 sm:w-44 border-b-2 border-gray-300 bg-transparent text-sm px-1 py-0.5 focus:outline-none focus:border-current mx-1"
                              style={{ borderColor: valuesData.splurge_because ? 'var(--couple-primary)' : undefined, color: 'var(--couple-primary)' }}
                              placeholder="______"
                            />
                            <span>{'"'}</span>
                          </div>

                          <div className="text-sm text-gray-800 leading-relaxed">
                            <span>{'"'}We{"\'"}re okay skipping </span>
                            <input
                              type="text"
                              value={valuesData.skip_what}
                              onChange={(e) => setValuesData({ ...valuesData, skip_what: e.target.value })}
                              className="inline-block w-36 sm:w-44 border-b-2 border-gray-300 bg-transparent text-sm px-1 py-0.5 focus:outline-none focus:border-current mx-1"
                              style={{ borderColor: valuesData.skip_what ? 'var(--couple-primary)' : undefined, color: 'var(--couple-primary)' }}
                              placeholder="______"
                            />
                            <span> because </span>
                            <input
                              type="text"
                              value={valuesData.skip_because}
                              onChange={(e) => setValuesData({ ...valuesData, skip_because: e.target.value })}
                              className="inline-block w-36 sm:w-44 border-b-2 border-gray-300 bg-transparent text-sm px-1 py-0.5 focus:outline-none focus:border-current mx-1"
                              style={{ borderColor: valuesData.skip_because ? 'var(--couple-primary)' : undefined, color: 'var(--couple-primary)' }}
                              placeholder="______"
                            />
                            <span>{'"'}</span>
                          </div>

                          <div className="text-sm text-gray-800 leading-relaxed">
                            <span>{'"'}In 20 years, we want to remember </span>
                            <input
                              type="text"
                              value={valuesData.remember}
                              onChange={(e) => setValuesData({ ...valuesData, remember: e.target.value })}
                              className="inline-block w-48 sm:w-64 border-b-2 border-gray-300 bg-transparent text-sm px-1 py-0.5 focus:outline-none focus:border-current mx-1"
                              style={{ borderColor: valuesData.remember ? 'var(--couple-primary)' : undefined, color: 'var(--couple-primary)' }}
                              placeholder="______"
                            />
                            <span>{'"'}</span>
                          </div>
                        </div>
                      </>
                    )}

                    {/* HAPPILY SKIPPING */}
                    {section.key === 'happily_skipping' && (
                      <>
                        <p className="text-sm text-gray-600">
                          Check off traditions you are choosing to skip. No judgment here -- your day, your way.
                        </p>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {HAPPILY_SKIPPING_OPTIONS.map((item) => {
                            const isChecked = happilySkipping.includes(item)
                            return (
                              <button
                                key={item}
                                onClick={() => toggleHappilySkipping(item)}
                                className={cn(
                                  'flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium border transition-all text-left',
                                  isChecked
                                    ? 'text-white border-transparent'
                                    : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                                )}
                                style={isChecked ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                              >
                                {isChecked ? (
                                  <Check className="w-4 h-4 shrink-0" />
                                ) : (
                                  <div className="w-4 h-4 rounded border border-gray-300 shrink-0" />
                                )}
                                {item}
                              </button>
                            )
                          })}
                        </div>
                        {happilySkipping.length > 0 && (
                          <p className="text-xs text-gray-400 mt-2">
                            {happilySkipping.length} tradition{happilySkipping.length !== 1 ? 's' : ''} happily skipped
                          </p>
                        )}
                      </>
                    )}

                    {/* ALIGNMENT CHECK */}
                    {section.key === 'alignment' && (
                      <>
                        <p className="text-sm text-gray-600 mb-4">
                          This compares your priority rankings to see where you align and where you might want to talk things through.
                        </p>
                        {!partner2Priorities || partner2Priorities.length === 0 ? (
                          <div className="text-center py-8 bg-gray-50 rounded-lg">
                            <MessageSquare className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                            <p className="text-sm text-gray-500 mb-1">Both partners need to rank priorities first</p>
                            <p className="text-xs text-gray-400">
                              Once both of you have completed the Priorities section, your alignment will appear here.
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-6">
                            {/* Agreement */}
                            {alignmentAgree.length > 0 && (
                              <div>
                                <h3 className="flex items-center gap-2 text-sm font-semibold text-emerald-700 mb-2">
                                  <ThumbsUp className="w-4 h-4" />
                                  You agree on:
                                </h3>
                                <div className="space-y-1">
                                  {alignmentAgree.map((item) => (
                                    <div key={item} className="flex items-center gap-2 bg-emerald-50 rounded-lg px-4 py-2">
                                      <Check className="w-4 h-4 text-emerald-600" />
                                      <span className="text-sm text-emerald-800">{item}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Conversation needed */}
                            {alignmentConversation.length > 0 && (
                              <div>
                                <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-700 mb-2">
                                  <AlertTriangle className="w-4 h-4" />
                                  Worth a conversation:
                                </h3>
                                <div className="space-y-1">
                                  {alignmentConversation.map((item) => {
                                    const p1Rank = priorities.indexOf(item) + 1
                                    const p2Rank = (partner2Priorities?.indexOf(item) ?? -1) + 1
                                    return (
                                      <div key={item} className="flex items-center justify-between bg-amber-50 rounded-lg px-4 py-2">
                                        <span className="text-sm text-amber-800">{item}</span>
                                        <span className="text-xs text-amber-600">
                                          Partner 1: #{p1Rank} vs Partner 2: #{p2Rank}
                                        </span>
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            )}

                            {alignmentAgree.length === 0 && alignmentConversation.length === 0 && (
                              <div className="text-center py-6 bg-gray-50 rounded-lg">
                                <p className="text-sm text-gray-500">Your priorities are fairly aligned. No major differences found.</p>
                              </div>
                            )}

                            {/* Visual comparison */}
                            <div>
                              <h3 className="text-sm font-semibold text-gray-700 mb-3">Side-by-Side Rankings</h3>
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <p className="text-xs font-medium text-gray-500 mb-2">Partner 1</p>
                                  {priorities.map((item, idx) => (
                                    <div key={item} className="flex items-center gap-2 py-1">
                                      <span className="text-xs font-bold text-gray-400 w-5 text-right">{idx + 1}</span>
                                      <span className="text-xs text-gray-700">{item}</span>
                                    </div>
                                  ))}
                                </div>
                                <div>
                                  <p className="text-xs font-medium text-gray-500 mb-2">Partner 2</p>
                                  {(partner2Priorities || []).map((item, idx) => (
                                    <div key={item} className="flex items-center gap-2 py-1">
                                      <span className="text-xs font-bold text-gray-400 w-5 text-right">{idx + 1}</span>
                                      <span className="text-xs text-gray-700">{item}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {/* Save Button (hidden for alignment which is read-only) */}
                    {section.key !== 'alignment' && (
                      <div className="flex justify-end pt-2">
                        <button
                          onClick={() => saveSection(section.key)}
                          disabled={savingSection === section.key}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                          style={{ backgroundColor: 'var(--couple-primary)' }}
                        >
                          {savedSection === section.key ? (
                            <>
                              <Check className="w-4 h-4" />
                              Saved
                            </>
                          ) : savingSection === section.key ? (
                            'Saving...'
                          ) : (
                            <>
                              <Save className="w-4 h-4" />
                              Save {section.title}
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
