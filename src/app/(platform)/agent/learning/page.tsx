'use client'

import { useState, useEffect, useCallback } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import {
  GraduationCap,
  Upload,
  Trash2,
  ChevronDown,
  ChevronUp,
  CheckCircle,
  XCircle,
  Pencil,
  Eye,
  Sparkles,
  FileText,
  BarChart3,
  AlertTriangle,
  Plus,
  ArrowRight,
  X,
  TrendingUp,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AIConfig {
  ai_name: string
  ai_emoji: string | null
  warmth_level: number
  formality_level: number
  playfulness_level: number
  brevity_level: number
  enthusiasm_level: number
  phrase_style: string
}

interface EmailSample {
  id: string
  pattern: string
  preference_type: string
  confidence: number | null
  created_at: string
}

interface FeedbackStat {
  action: string
  count: number
}

interface VoiceDimension {
  content: string
  score: number
}

interface LearnedPattern {
  id: string
  preference_type: string
  pattern: string
  confidence: number | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Voice training A/B pairs — static content for "Which sounds more like you?"
// ---------------------------------------------------------------------------

interface ABPair {
  id: string
  scenario: string
  optionA: { text: string; dimension: string; direction: number }
  optionB: { text: string; dimension: string; direction: number }
}

const AB_PAIRS: ABPair[] = [
  {
    id: 'ab1',
    scenario: 'A couple asks about pricing for the first time.',
    optionA: {
      text: "Hi Sarah! Thanks so much for reaching out — we're so happy you found us! I'd love to share our pricing with you. Our Saturday rental starts at $8,500, which includes the full property, setup/breakdown, and our gorgeous bridal suite. Want to come see it in person? I promise it's even prettier than the photos!",
      dimension: 'warmth',
      direction: 1,
    },
    optionB: {
      text: "Hello Sarah, Thank you for your inquiry. Our venue rental for a Saturday event is $8,500. This includes exclusive property use, setup and breakdown time, and bridal suite access. I've attached our full pricing guide for your review. Please let me know if you'd like to arrange a tour.",
      dimension: 'warmth',
      direction: -1,
    },
  },
  {
    id: 'ab2',
    scenario: 'Following up with a couple who toured but hasn\'t responded in 5 days.',
    optionA: {
      text: "Hey! Just popping back in — I keep thinking about how much you two loved the ceremony garden during your tour. Any questions I can answer? No rush at all, just here whenever you're ready!",
      dimension: 'playfulness',
      direction: 1,
    },
    optionB: {
      text: "Hi there, I wanted to follow up on your tour last week. I hope you enjoyed seeing the property. Please don't hesitate to reach out if you have any remaining questions. We'd be honored to host your celebration.",
      dimension: 'playfulness',
      direction: -1,
    },
  },
  {
    id: 'ab3',
    scenario: 'Responding to a couple who asked if they can bring their own caterer.',
    optionA: {
      text: "YES! One of the best parts — you get to pick whoever you want! We're fully BYOB for food and drink, so you have total creative freedom. We have a list of caterers our couples have loved if you want recs, or bring your own — totally up to you!",
      dimension: 'enthusiasm',
      direction: 1,
    },
    optionB: {
      text: "Great question! We are a BYOB venue, which means you're welcome to select any licensed caterer. Our prep kitchen has everything they'll need. I can also share our preferred vendor list if that would be helpful.",
      dimension: 'enthusiasm',
      direction: -1,
    },
  },
  {
    id: 'ab4',
    scenario: 'A date the couple wanted is already booked.',
    optionA: {
      text: "That date is spoken for, but honestly — I think you might love these alternatives even more. We have October 18 and October 25 wide open, and the fall colors that weekend are typically at their peak. Want me to pencil one in while you think it over?",
      dimension: 'brevity',
      direction: -1,
    },
    optionB: {
      text: "That date is booked. We do have October 18 and 25 available — both gorgeous weekends. Want to hold one?",
      dimension: 'brevity',
      direction: 1,
    },
  },
  {
    id: 'ab5',
    scenario: 'A couple mentions they\'re also looking at two other venues.',
    optionA: {
      text: "That's totally smart — you should absolutely explore your options! Every venue has its own vibe, and the right one just clicks. What I can tell you is that couples who tour here almost always say the mountain views sealed the deal. Come see it for yourself and trust your gut!",
      dimension: 'formality',
      direction: -1,
    },
    optionB: {
      text: "I appreciate you sharing that. Choosing a venue is one of the biggest decisions in wedding planning, and I'd encourage you to visit each property. What sets us apart is our exclusive-use model and the panoramic mountain views — they create a truly private experience. I'd welcome the opportunity to show you in person.",
      dimension: 'formality',
      direction: 1,
    },
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

function dimensionLabel(key: string): string {
  const labels: Record<string, string> = {
    warmth: 'Warmth',
    formality: 'Formality',
    playfulness: 'Playfulness',
    brevity: 'Brevity',
    enthusiasm: 'Enthusiasm',
  }
  return labels[key] || key
}

function dimensionColor(key: string): string {
  const colors: Record<string, string> = {
    warmth: 'bg-rose-400',
    formality: 'bg-blue-400',
    playfulness: 'bg-amber-400',
    brevity: 'bg-teal-400',
    enthusiasm: 'bg-purple-400',
  }
  return colors[key] || 'bg-sage-400'
}

// ---------------------------------------------------------------------------
// Skeleton Components
// ---------------------------------------------------------------------------

function CardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="h-4 w-1/3 bg-sage-100 rounded" />
        <div className="h-3 w-full bg-sage-50 rounded" />
        <div className="h-3 w-4/5 bg-sage-50 rounded" />
      </div>
    </div>
  )
}

function StatSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="animate-pulse space-y-2">
        <div className="h-3 w-20 bg-sage-100 rounded" />
        <div className="h-7 w-12 bg-sage-100 rounded" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Email Preview Modal
// ---------------------------------------------------------------------------

function PreviewModal({
  email,
  onClose,
}: {
  email: EmailSample
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-surface rounded-2xl shadow-2xl w-full max-w-2xl border border-border max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Eye className="w-5 h-5 text-sage-600" />
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              Sample Email
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-4 overflow-y-auto">
          <p className="text-xs text-sage-400 mb-2">
            Saved {new Date(email.created_at).toLocaleDateString()}
          </p>
          <div className="bg-warm-white border border-border rounded-lg p-4">
            <p className="text-sm text-sage-800 whitespace-pre-wrap leading-relaxed">
              {email.pattern}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function EmailLearningPage() {
  const VENUE_ID = useVenueId()
  const supabase = createClient()

  // State
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Sample emails
  const [emailText, setEmailText] = useState('')
  const [bulkMode, setBulkMode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [samples, setSamples] = useState<EmailSample[]>([])
  const [expandedSample, setExpandedSample] = useState<string | null>(null)
  const [previewSample, setPreviewSample] = useState<EmailSample | null>(null)

  // Feedback stats
  const [feedbackStats, setFeedbackStats] = useState<FeedbackStat[]>([])
  const [totalFeedback, setTotalFeedback] = useState(0)

  // Voice dimensions
  const [dimensions, setDimensions] = useState<VoiceDimension[]>([])

  // Learned patterns
  const [learnedPatterns, setLearnedPatterns] = useState<LearnedPattern[]>([])

  // Learning curve data (weekly aggregation)
  const [weeklyData, setWeeklyData] = useState<{ week: string; approved: number; edited: number; rejected: number; approvalRate: number }[]>([])

  // A/B training
  const [currentABIndex, setCurrentABIndex] = useState(0)
  const [abCompleted, setAbCompleted] = useState<Set<string>>(new Set())
  const [abSaving, setAbSaving] = useState(false)

  // File upload
  const [fileUploading, setFileUploading] = useState(false)

  // ---------- Load data ----------
  const loadData = useCallback(async () => {
    try {
      setLoading(true)

      const [aiRes, samplesRes, feedbackRes, dimRes, patternsRes] = await Promise.all([
        // AI config
        supabase
          .from('venue_ai_config')
          .select('ai_name, ai_emoji, warmth_level, formality_level, playfulness_level, brevity_level, enthusiasm_level, phrase_style')
          .eq('venue_id', VENUE_ID)
          .single(),
        // Sample emails stored as learned_preferences with type 'email_sample'
        supabase
          .from('learned_preferences')
          .select('*')
          .eq('venue_id', VENUE_ID)
          .eq('preference_type', 'email_sample')
          .order('created_at', { ascending: false }),
        // Feedback stats
        supabase
          .from('draft_feedback')
          .select('action')
          .eq('venue_id', VENUE_ID),
        // Voice dimensions
        supabase
          .from('voice_preferences')
          .select('content, score')
          .eq('venue_id', VENUE_ID)
          .eq('preference_type', 'dimension'),
        // Learned patterns (not email_sample)
        supabase
          .from('learned_preferences')
          .select('*')
          .eq('venue_id', VENUE_ID)
          .neq('preference_type', 'email_sample')
          .order('created_at', { ascending: false })
          .limit(10),
      ])

      if (aiRes.data) setAiConfig(aiRes.data as AIConfig)
      if (samplesRes.data) setSamples(samplesRes.data as EmailSample[])
      if (dimRes.data) setDimensions(dimRes.data as VoiceDimension[])
      if (patternsRes.data) setLearnedPatterns(patternsRes.data as LearnedPattern[])

      // Compute feedback stats
      if (feedbackRes.data) {
        const counts: Record<string, number> = {}
        for (const row of feedbackRes.data) {
          const action = row.action as string
          counts[action] = (counts[action] || 0) + 1
        }
        const stats = Object.entries(counts).map(([action, count]) => ({ action, count }))
        setFeedbackStats(stats)
        setTotalFeedback(feedbackRes.data.length)

        // Build weekly learning curve from feedback timestamps
        const { data: feedbackWithDates } = await supabase
          .from('draft_feedback')
          .select('action, created_at')
          .eq('venue_id', VENUE_ID)
          .order('created_at', { ascending: true })

        if (feedbackWithDates && feedbackWithDates.length > 0) {
          const weekMap = new Map<string, { approved: number; edited: number; rejected: number }>()
          for (const row of feedbackWithDates) {
            const d = new Date(row.created_at as string)
            // Week key = Monday of that week
            const day = d.getDay()
            const diff = d.getDate() - day + (day === 0 ? -6 : 1)
            const monday = new Date(d)
            monday.setDate(diff)
            const weekKey = monday.toISOString().split('T')[0]
            if (!weekMap.has(weekKey)) weekMap.set(weekKey, { approved: 0, edited: 0, rejected: 0 })
            const w = weekMap.get(weekKey)!
            const action = row.action as string
            if (action === 'approved') w.approved++
            else if (action === 'edited') w.edited++
            else if (action === 'rejected') w.rejected++
          }
          const weekly = Array.from(weekMap.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([week, counts]) => {
              const total = counts.approved + counts.edited + counts.rejected
              return {
                week,
                ...counts,
                approvalRate: total > 0 ? Math.round((counts.approved / total) * 100) : 0,
              }
            })
          setWeeklyData(weekly)
        }
      }

      setError(null)
    } catch (err) {
      console.error('Failed to load learning data:', err)
      setError('Failed to load learning data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // ---------- Save sample email(s) ----------
  const handleSaveEmail = async () => {
    if (!emailText.trim()) return
    setSaving(true)
    setError(null)

    try {
      const emails = bulkMode
        ? emailText.split('---').map((e) => e.trim()).filter(Boolean)
        : [emailText.trim()]

      const inserts = emails.map((text) => ({
        venue_id: VENUE_ID,
        preference_type: 'email_sample',
        pattern: text,
        confidence: 1.0,
      }))

      const { error: insertError } = await supabase
        .from('learned_preferences')
        .insert(inserts)

      if (insertError) throw insertError

      setEmailText('')
      // Reload samples
      const { data } = await supabase
        .from('learned_preferences')
        .select('*')
        .eq('venue_id', VENUE_ID)
        .eq('preference_type', 'email_sample')
        .order('created_at', { ascending: false })
      if (data) setSamples(data as EmailSample[])
    } catch (err) {
      console.error('Failed to save email sample:', err)
      setError('Failed to save email sample')
    } finally {
      setSaving(false)
    }
  }

  // ---------- Delete sample ----------
  const handleDeleteSample = async (id: string) => {
    try {
      const { error: deleteError } = await supabase
        .from('learned_preferences')
        .delete()
        .eq('id', id)
      if (deleteError) throw deleteError
      setSamples((prev) => prev.filter((s) => s.id !== id))
    } catch (err) {
      console.error('Failed to delete sample:', err)
      setError('Failed to delete sample')
    }
  }

  // ---------- Handle file upload ----------
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setFileUploading(true)
    setError(null)

    try {
      const text = await file.text()
      // Split on common email separators
      const emails = text
        .split(/(?:^|\n)---+\n|(?:^|\n)From:|(?:^|\n)={3,}\n/)
        .map((e) => e.trim())
        .filter((e) => e.length > 20) // Skip tiny fragments

      if (emails.length === 0) {
        setError('No emails found in the file. Try pasting them directly.')
        return
      }

      // Set in the textarea for review before saving
      setEmailText(emails.join('\n---\n'))
      setBulkMode(true)
    } catch (err) {
      console.error('Failed to read file:', err)
      setError('Failed to read the file')
    } finally {
      setFileUploading(false)
      // Reset input
      e.target.value = ''
    }
  }

  // ---------- Handle A/B choice ----------
  const handleABChoice = async (pair: ABPair, choice: 'A' | 'B') => {
    setAbSaving(true)
    try {
      const option = choice === 'A' ? pair.optionA : pair.optionB

      // Upsert dimension score
      const { error: upsertError } = await supabase
        .from('voice_preferences')
        .upsert(
          {
            venue_id: VENUE_ID,
            preference_type: 'dimension',
            content: option.dimension,
            score: option.direction > 0 ? 7 : 4,
            sample_count: 1,
          },
          { onConflict: 'venue_id,preference_type,content' }
        )

      if (upsertError) throw upsertError

      setAbCompleted((prev) => new Set([...prev, pair.id]))

      // Move to next pair after a short delay
      setTimeout(() => {
        if (currentABIndex < AB_PAIRS.length - 1) {
          setCurrentABIndex((prev) => prev + 1)
        }
      }, 600)

      // Refresh dimensions
      const { data } = await supabase
        .from('voice_preferences')
        .select('content, score')
        .eq('venue_id', VENUE_ID)
        .eq('preference_type', 'dimension')
      if (data) setDimensions(data as VoiceDimension[])
    } catch (err) {
      console.error('Failed to save voice preference:', err)
      setError('Failed to save your choice')
    } finally {
      setAbSaving(false)
    }
  }

  const aiName = aiConfig?.ai_name || 'Sage'
  const aiEmoji = aiConfig?.ai_emoji || ''

  // Build voice dimension display (merge AI config defaults with trained overrides)
  const allDimensions: { key: string; label: string; score: number; source: 'trained' | 'default' }[] = (() => {
    const trained: Record<string, number> = {}
    for (const d of dimensions) {
      trained[d.content] = d.score
    }
    const keys = ['warmth', 'formality', 'playfulness', 'brevity', 'enthusiasm']
    const defaults: Record<string, number> = {
      warmth: aiConfig?.warmth_level ?? 5,
      formality: aiConfig?.formality_level ?? 5,
      playfulness: aiConfig?.playfulness_level ?? 5,
      brevity: aiConfig?.brevity_level ?? 5,
      enthusiasm: aiConfig?.enthusiasm_level ?? 5,
    }
    return keys.map((key) => ({
      key,
      label: dimensionLabel(key),
      score: trained[key] ?? defaults[key],
      source: (trained[key] !== undefined ? 'trained' : 'default') as 'trained' | 'default',
    }))
  })()

  const approvedCount = feedbackStats.find((s) => s.action === 'approved')?.count ?? 0
  const editedCount = feedbackStats.find((s) => s.action === 'edited')?.count ?? 0
  const rejectedCount = feedbackStats.find((s) => s.action === 'rejected')?.count ?? 0

  return (
    <div className="space-y-8">
      {/* ---------------------------------------------------------------- */}
      {/* Header                                                          */}
      {/* ---------------------------------------------------------------- */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Teach {aiName} Your Voice {aiEmoji}
        </h1>
        <p className="text-sage-600 max-w-2xl">
          The more {aiName} learns from your real emails, the better it writes in your voice.
          Think of this like training a new team member — share examples of emails you love,
          and {aiName} will pick up your style.
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
        {loading ? (
          <>
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
          </>
        ) : (
          <>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <FileText className="w-4 h-4 text-sage-500" />
                <span className="text-xs font-medium text-sage-500">Sample Emails</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{samples.length}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle className="w-4 h-4 text-emerald-500" />
                <span className="text-xs font-medium text-sage-500">Approved Drafts</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{approvedCount}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <Pencil className="w-4 h-4 text-amber-500" />
                <span className="text-xs font-medium text-sage-500">Edited Drafts</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{editedCount}</p>
            </div>
            <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <XCircle className="w-4 h-4 text-red-500" />
                <span className="text-xs font-medium text-sage-500">Rejected Drafts</span>
              </div>
              <p className="text-2xl font-bold text-sage-900">{rejectedCount}</p>
            </div>
          </>
        )}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Learning Curve                                                   */}
      {/* ---------------------------------------------------------------- */}
      {!loading && weeklyData.length > 0 && (
        <div className="bg-surface border border-border rounded-xl shadow-sm p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 bg-emerald-50 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <h2 className="font-heading text-lg font-semibold text-sage-900">
                Voice Match Trajectory
              </h2>
              <p className="text-xs text-sage-500">
                Approval rate over time — higher means {aiName} sounds more like you
              </p>
            </div>
            {weeklyData.length > 0 && (
              <div className="ml-auto text-right">
                <p className={`text-2xl font-bold ${
                  weeklyData[weeklyData.length - 1].approvalRate >= 90 ? 'text-emerald-600' :
                  weeklyData[weeklyData.length - 1].approvalRate >= 70 ? 'text-sage-700' : 'text-amber-600'
                }`}>
                  {weeklyData[weeklyData.length - 1].approvalRate}%
                </p>
                <p className="text-[10px] text-sage-400">current match</p>
              </div>
            )}
          </div>

          {/* Chart */}
          <div className="flex items-end gap-1 h-32 mb-2">
            {weeklyData.map((w, i) => {
              const barHeight = Math.max(8, (w.approvalRate / 100) * 120)
              const color = w.approvalRate >= 90
                ? 'bg-emerald-500'
                : w.approvalRate >= 70
                  ? 'bg-sage-400'
                  : w.approvalRate >= 50
                    ? 'bg-amber-400'
                    : 'bg-red-400'
              return (
                <div key={w.week} className="flex-1 flex flex-col items-center justify-end gap-1 group relative">
                  <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-sage-800 text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
                    {w.approvalRate}% — {w.approved}✓ {w.edited}✎ {w.rejected}✗
                  </div>
                  <div
                    className={`w-full rounded-t-sm ${color} transition-all`}
                    style={{ height: `${barHeight}px` }}
                  />
                </div>
              )
            })}
          </div>

          {/* Week labels */}
          <div className="flex gap-1">
            {weeklyData.map((w, i) => (
              <div key={w.week} className="flex-1 text-center">
                {(i === 0 || i === weeklyData.length - 1 || i === Math.floor(weeklyData.length / 2)) ? (
                  <span className="text-[10px] text-sage-400">
                    {new Date(w.week + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                ) : null}
              </div>
            ))}
          </div>

          {/* Milestone markers */}
          <div className="flex items-center gap-4 mt-4 pt-4 border-t border-sage-100">
            {[
              { label: 'Week 1', target: '~60%', desc: 'Getting to know you' },
              { label: 'Week 2', target: '~78%', desc: 'Finding your rhythm' },
              { label: 'Month 1', target: '~93%', desc: 'Sounding like you' },
              { label: 'Month 2+', target: '97%+', desc: 'Your voice, perfected' },
            ].map((m) => (
              <div key={m.label} className="flex-1 text-center">
                <p className="text-xs font-semibold text-sage-700">{m.target}</p>
                <p className="text-[10px] text-sage-500">{m.label}</p>
                <p className="text-[10px] text-sage-400">{m.desc}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* ============================================================ */}
        {/* LEFT: Sample email upload + A/B training                     */}
        {/* ============================================================ */}
        <div className="lg:col-span-2 space-y-8">
          {/* ---- Upload Sample Emails ---- */}
          <div className="bg-surface border border-border rounded-xl shadow-sm">
            <div className="px-6 pt-6 pb-4 border-b border-border">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-sage-100 rounded-lg flex items-center justify-center">
                    <Upload className="w-5 h-5 text-sage-600" />
                  </div>
                  <div>
                    <h2 className="font-heading text-lg font-semibold text-sage-900">
                      Share Your Emails
                    </h2>
                    <p className="text-sm text-sage-500">
                      Paste emails you&apos;ve written that capture your voice
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setBulkMode(!bulkMode)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                      bulkMode
                        ? 'bg-sage-100 text-sage-800'
                        : 'text-sage-500 hover:bg-sage-50'
                    }`}
                  >
                    {bulkMode ? 'Single mode' : 'Bulk mode'}
                  </button>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <textarea
                value={emailText}
                onChange={(e) => setEmailText(e.target.value)}
                placeholder={
                  bulkMode
                    ? 'Paste multiple emails separated by --- on a new line.\n\nHi Sarah! Thanks so much for reaching out...\n\n---\n\nHey there! Congrats on the engagement...\n\n---\n\nGood morning! I loved hearing about...'
                    : `Paste a sample email you've written to an inquiry or client...\n\nHi Sarah! Thanks so much for reaching out about Crestwood Farm! I'm thrilled you're considering us for your big day...`
                }
                rows={8}
                className="w-full px-4 py-3 border border-sage-200 rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-none bg-warm-white leading-relaxed"
              />

              <div className="flex items-center gap-3">
                <button
                  onClick={handleSaveEmail}
                  disabled={!emailText.trim() || saving}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-sage-500 hover:bg-sage-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="w-4 h-4" />
                  {saving
                    ? 'Saving...'
                    : bulkMode
                      ? 'Save All Examples'
                      : 'Save as Example'}
                </button>

                {/* File upload */}
                <label className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-sage-700 border border-sage-300 rounded-lg hover:bg-sage-50 transition-colors cursor-pointer">
                  <FileText className="w-4 h-4" />
                  {fileUploading ? 'Reading...' : 'Upload .txt / .eml'}
                  <input
                    type="file"
                    accept=".txt,.eml,.text"
                    className="hidden"
                    onChange={handleFileUpload}
                    disabled={fileUploading}
                  />
                </label>

                {bulkMode && emailText.includes('---') && (
                  <span className="text-xs text-sage-400">
                    {emailText.split('---').filter((e) => e.trim()).length} emails detected
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ---- Saved Email Samples ---- */}
          {!loading && samples.length > 0 && (
            <div className="bg-surface border border-border rounded-xl shadow-sm">
              <div className="px-6 pt-6 pb-4 border-b border-border">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-emerald-50 rounded-lg flex items-center justify-center">
                    <CheckCircle className="w-5 h-5 text-emerald-600" />
                  </div>
                  <div>
                    <h2 className="font-heading text-lg font-semibold text-sage-900">
                      Saved Examples ({samples.length})
                    </h2>
                    <p className="text-sm text-sage-500">
                      {aiName} uses these as reference when writing new emails
                    </p>
                  </div>
                </div>
              </div>

              <div className="divide-y divide-border">
                {samples.map((sample) => {
                  const isExpanded = expandedSample === sample.id
                  const preview = sample.pattern.slice(0, 150)
                  const hasMore = sample.pattern.length > 150

                  return (
                    <div key={sample.id} className="px-6 py-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-sage-800 leading-relaxed">
                            {isExpanded ? sample.pattern : preview}
                            {!isExpanded && hasMore && '...'}
                          </p>
                          <p className="text-xs text-sage-400 mt-2">
                            Added {timeAgo(sample.created_at)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          {hasMore && (
                            <button
                              onClick={() => setExpandedSample(isExpanded ? null : sample.id)}
                              className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
                              title={isExpanded ? 'Collapse' : 'Expand'}
                            >
                              {isExpanded ? (
                                <ChevronUp className="w-4 h-4" />
                              ) : (
                                <ChevronDown className="w-4 h-4" />
                              )}
                            </button>
                          )}
                          <button
                            onClick={() => setPreviewSample(sample)}
                            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
                            title="Full view"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteSample(sample.id)}
                            className="p-1.5 rounded-lg text-sage-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* ---- Quick Training: A/B Choices ---- */}
          <div className="bg-surface border border-border rounded-xl shadow-sm">
            <div className="px-6 pt-6 pb-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-purple-50 rounded-lg flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-purple-600" />
                </div>
                <div>
                  <h2 className="font-heading text-lg font-semibold text-sage-900">
                    Quick Training: Which Sounds More Like You?
                  </h2>
                  <p className="text-sm text-sage-500">
                    Pick the response that better matches how you&apos;d reply.
                    This helps {aiName} learn your style dimensions.
                  </p>
                </div>
              </div>
              {/* Progress dots */}
              <div className="flex items-center gap-1.5 mt-3">
                {AB_PAIRS.map((pair, i) => (
                  <div
                    key={pair.id}
                    className={`w-2 h-2 rounded-full transition-colors ${
                      abCompleted.has(pair.id)
                        ? 'bg-purple-500'
                        : i === currentABIndex
                          ? 'bg-purple-300'
                          : 'bg-sage-200'
                    }`}
                  />
                ))}
                <span className="text-xs text-sage-400 ml-2">
                  {abCompleted.size}/{AB_PAIRS.length} completed
                </span>
              </div>
            </div>

            <div className="p-6">
              {abCompleted.size === AB_PAIRS.length ? (
                <div className="text-center py-8">
                  <Sparkles className="w-10 h-10 text-purple-400 mx-auto mb-3" />
                  <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
                    All done! Great work.
                  </h3>
                  <p className="text-sm text-sage-600 max-w-md mx-auto">
                    {aiName} now has a much better sense of your voice. These preferences
                    are reflected in the Voice Profile panel on the right.
                  </p>
                  <button
                    onClick={() => {
                      setAbCompleted(new Set())
                      setCurrentABIndex(0)
                    }}
                    className="mt-4 px-4 py-2 text-sm font-medium text-purple-600 border border-purple-200 rounded-lg hover:bg-purple-50 transition-colors"
                  >
                    Start Over
                  </button>
                </div>
              ) : (
                (() => {
                  const pair = AB_PAIRS[currentABIndex]
                  const isCompleted = abCompleted.has(pair.id)

                  return (
                    <div className="space-y-4">
                      <div className="bg-warm-white border border-border rounded-lg px-4 py-3">
                        <p className="text-xs font-medium text-sage-500 mb-1">Scenario:</p>
                        <p className="text-sm text-sage-800">{pair.scenario}</p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Option A */}
                        <button
                          onClick={() => handleABChoice(pair, 'A')}
                          disabled={isCompleted || abSaving}
                          className={`text-left p-4 border-2 rounded-xl transition-all ${
                            isCompleted && abCompleted.has(pair.id)
                              ? 'border-sage-200 opacity-60'
                              : 'border-sage-200 hover:border-purple-400 hover:shadow-md'
                          } disabled:cursor-not-allowed`}
                        >
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-semibold bg-sage-100 text-sage-600 rounded-full mb-3">
                            Option A
                          </span>
                          <p className="text-sm text-sage-700 leading-relaxed whitespace-pre-wrap">
                            {pair.optionA.text}
                          </p>
                        </button>

                        {/* Option B */}
                        <button
                          onClick={() => handleABChoice(pair, 'B')}
                          disabled={isCompleted || abSaving}
                          className={`text-left p-4 border-2 rounded-xl transition-all ${
                            isCompleted && abCompleted.has(pair.id)
                              ? 'border-sage-200 opacity-60'
                              : 'border-sage-200 hover:border-purple-400 hover:shadow-md'
                          } disabled:cursor-not-allowed`}
                        >
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-semibold bg-sage-100 text-sage-600 rounded-full mb-3">
                            Option B
                          </span>
                          <p className="text-sm text-sage-700 leading-relaxed whitespace-pre-wrap">
                            {pair.optionB.text}
                          </p>
                        </button>
                      </div>

                      {/* Nav arrows */}
                      <div className="flex items-center justify-between pt-2">
                        <button
                          onClick={() => setCurrentABIndex((prev) => Math.max(0, prev - 1))}
                          disabled={currentABIndex === 0}
                          className="text-sm text-sage-500 hover:text-sage-700 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          Previous
                        </button>
                        <span className="text-xs text-sage-400">
                          {currentABIndex + 1} of {AB_PAIRS.length}
                        </span>
                        <button
                          onClick={() =>
                            setCurrentABIndex((prev) =>
                              Math.min(AB_PAIRS.length - 1, prev + 1)
                            )
                          }
                          disabled={currentABIndex === AB_PAIRS.length - 1}
                          className="flex items-center gap-1 text-sm text-sage-500 hover:text-sage-700 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          Next <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )
                })()
              )}
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* RIGHT: What Sage Has Learned + Voice Profile                 */}
        {/* ============================================================ */}
        <div className="space-y-6">
          {/* ---- Voice Profile ---- */}
          <div className="bg-surface border border-border rounded-xl shadow-sm">
            <div className="px-6 pt-6 pb-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-sage-100 rounded-lg flex items-center justify-center">
                  <BarChart3 className="w-5 h-5 text-sage-600" />
                </div>
                <div>
                  <h2 className="font-heading text-lg font-semibold text-sage-900">
                    Voice Profile
                  </h2>
                  <p className="text-sm text-sage-500">
                    How {aiName} understands your style
                  </p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-4">
              {loading ? (
                <div className="space-y-4">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="animate-pulse space-y-1.5">
                      <div className="h-3 w-20 bg-sage-100 rounded" />
                      <div className="h-3 w-full bg-sage-50 rounded-full" />
                    </div>
                  ))}
                </div>
              ) : (
                allDimensions.map((dim) => (
                  <div key={dim.key}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm font-medium text-sage-700">{dim.label}</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-sage-500">{dim.score}/10</span>
                        {dim.source === 'trained' && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-purple-50 text-purple-600 rounded-full font-medium">
                            Trained
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="h-2.5 bg-sage-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${dimensionColor(dim.key)}`}
                        style={{ width: `${(dim.score / 10) * 100}%` }}
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* ---- What Sage Has Learned ---- */}
          <div className="bg-surface border border-border rounded-xl shadow-sm">
            <div className="px-6 pt-6 pb-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-amber-50 rounded-lg flex items-center justify-center">
                  <GraduationCap className="w-5 h-5 text-amber-600" />
                </div>
                <div>
                  <h2 className="font-heading text-lg font-semibold text-sage-900">
                    What {aiName} Has Learned
                  </h2>
                  <p className="text-sm text-sage-500">
                    Patterns from {totalFeedback} feedback interactions
                  </p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-3">
              {loading ? (
                <div className="space-y-3">
                  <CardSkeleton />
                  <CardSkeleton />
                </div>
              ) : learnedPatterns.length === 0 && totalFeedback === 0 ? (
                <div className="text-center py-6">
                  <GraduationCap className="w-8 h-8 text-sage-300 mx-auto mb-2" />
                  <p className="text-sm text-sage-500">
                    {aiName} hasn&apos;t learned any patterns yet. Start by approving or
                    editing drafts in the Approval Queue, or add sample emails above.
                  </p>
                </div>
              ) : (
                <>
                  {/* Feedback summary */}
                  {totalFeedback > 0 && (
                    <div className="bg-warm-white border border-border rounded-lg p-4 space-y-2">
                      <p className="text-xs font-medium text-sage-500 uppercase tracking-wider">
                        Learning Summary
                      </p>
                      {approvedCount > 0 && (
                        <div className="flex items-center gap-2">
                          <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                          <span className="text-sm text-sage-700">
                            {approvedCount} draft{approvedCount !== 1 ? 's' : ''} approved as-is
                          </span>
                        </div>
                      )}
                      {editedCount > 0 && (
                        <div className="flex items-center gap-2">
                          <Pencil className="w-3.5 h-3.5 text-amber-500" />
                          <span className="text-sm text-sage-700">
                            {editedCount} draft{editedCount !== 1 ? 's' : ''} edited before sending
                          </span>
                        </div>
                      )}
                      {rejectedCount > 0 && (
                        <div className="flex items-center gap-2">
                          <XCircle className="w-3.5 h-3.5 text-red-500" />
                          <span className="text-sm text-sage-700">
                            {rejectedCount} draft{rejectedCount !== 1 ? 's' : ''} rejected
                          </span>
                        </div>
                      )}
                      {totalFeedback > 0 && (
                        <div className="pt-1 border-t border-border">
                          <p className="text-xs text-sage-500">
                            Approval rate:{' '}
                            <span className="font-semibold text-sage-800">
                              {totalFeedback > 0
                                ? Math.round(
                                    ((approvedCount + editedCount) / totalFeedback) * 100
                                  )
                                : 0}
                              %
                            </span>
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Learned patterns list */}
                  {learnedPatterns.map((pattern) => (
                    <div
                      key={pattern.id}
                      className="flex items-start gap-3 p-3 bg-warm-white border border-border rounded-lg"
                    >
                      <Sparkles className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm text-sage-800">{pattern.pattern}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] px-1.5 py-0.5 bg-sage-100 text-sage-600 rounded-full font-medium">
                            {pattern.preference_type}
                          </span>
                          {pattern.confidence && (
                            <span className="text-[10px] text-sage-400">
                              {Math.round(pattern.confidence * 100)}% confidence
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* ---- Quick Tips ---- */}
          <div className="bg-gradient-to-br from-sage-50 to-teal-50 border border-sage-200 rounded-xl p-5">
            <h3 className="font-heading text-sm font-semibold text-sage-800 mb-3">
              Tips for Better Training
            </h3>
            <ul className="space-y-2">
              {[
                'Share emails you\'re proudest of — the ones that feel most "you"',
                'Include a mix: inquiry responses, follow-ups, booking confirmations',
                'The more examples, the better — aim for 10+ sample emails',
                'Edit AI drafts in the Approval Queue — every edit teaches ' + aiName,
                'Complete the A/B training to fine-tune voice dimensions',
              ].map((tip, i) => (
                <li key={i} className="flex items-start gap-2">
                  <ArrowRight className="w-3.5 h-3.5 text-sage-500 mt-0.5 shrink-0" />
                  <span className="text-xs text-sage-600 leading-relaxed">{tip}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* ---- Preview modal ---- */}
      {previewSample && (
        <PreviewModal
          email={previewSample}
          onClose={() => setPreviewSample(null)}
        />
      )}
    </div>
  )
}
