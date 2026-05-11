'use client'

/**
 * Wave 19 — Knowledge Gaps coordinator dashboard.
 *
 * Three tabs:
 *   - Open gaps        — needs an answer (default)
 *   - Captured         — Sage has the operator-authored answer now
 *   - Dismissed        — gaps the operator dismissed as noise
 *
 * Each open gap card shows the implicit question + an answer input.
 * Submitting calls POST /api/admin/knowledge-gaps/capture which writes
 * a knowledge_captures row (the canonical answer store Sage folds into
 * every brain prompt as VENUE KNOWLEDGE) and marks the gap captured.
 *
 * Bulk-import: paste a list of FAQ-style entries to capture multiple
 * at once. Each line "Q: ... A: ..." becomes a capture row.
 *
 * Captured-knowledge tab lets the operator edit / deactivate captures.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { useAiName } from '@/lib/hooks/use-ai-name'
import {
  HelpCircle,
  CheckCircle2,
  Search,
  AlertTriangle,
  TrendingUp,
  FolderOpen,
  X,
  XCircle,
  Pencil,
  Trash2,
  Sparkles,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KnowledgeGap {
  id: string
  venue_id: string
  question: string
  category: string | null
  frequency: number
  status: 'open' | 'resolved'
  resolution: string | null
  resolved_at: string | null
  created_at: string
  captured_at: string | null
  captured_id: string | null
  dismissed_at: string | null
  dismissed_reason: string | null
}

interface KnowledgeCapture {
  id: string
  venue_id: string
  knowledge_gap_id: string | null
  question: string
  answer: string
  tags: string[]
  source_kind: 'operator_input' | 'inferred_from_past_email' | 'venue_doc'
  confidence_0_100: number
  applies_until: string | null
  active: boolean
  created_at: string
  updated_at: string
}

type Tab = 'open' | 'captured' | 'dismissed' | 'library'

const CATEGORY_TAGS: { value: string; label: string }[] = [
  { value: 'pricing', label: 'Pricing' },
  { value: 'availability', label: 'Availability' },
  { value: 'logistics', label: 'Logistics' },
  { value: 'policy', label: 'Policy' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'ceremony', label: 'Ceremony' },
  { value: 'catering', label: 'Catering' },
  { value: 'inclusions', label: 'Inclusions' },
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
  if (days < 7) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function categoryBadge(category: string | null): { bg: string; text: string; label: string } {
  switch (category) {
    case 'pricing':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Pricing' }
    case 'availability':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Availability' }
    case 'logistics':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Logistics' }
    case 'policy':
      return { bg: 'bg-purple-50', text: 'text-purple-700', label: 'Policy' }
    case 'vendor':
      return { bg: 'bg-rose-50', text: 'text-rose-700', label: 'Vendor' }
    case 'ceremony':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label: 'Ceremony' }
    case 'catering':
      return { bg: 'bg-orange-50', text: 'text-orange-700', label: 'Catering' }
    case 'inclusions':
      return { bg: 'bg-sage-50', text: 'text-sage-700', label: 'Inclusions' }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: category || 'Uncategorized' }
  }
}

const inputClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

// ---------------------------------------------------------------------------
// Capture Modal
// ---------------------------------------------------------------------------

function CaptureModal({
  gap,
  onClose,
  onSaved,
}: {
  gap: KnowledgeGap
  onClose: () => void
  onSaved: () => void
}) {
  const [answer, setAnswer] = useState('')
  const [tags, setTags] = useState<string[]>(gap.category ? [gap.category] : [])
  const [appliesUntil, setAppliesUntil] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!answer.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/knowledge-gaps/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          knowledgeGapId: gap.id,
          question: gap.question,
          answer,
          tags,
          appliesUntil: appliesUntil || undefined,
          sourceKind: 'operator_input',
        }),
      })
      const json = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'capture failed')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const toggleTag = (value: string) => {
    setTags((prev) => (prev.includes(value) ? prev.filter((t) => t !== value) : [...prev, value]))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-surface rounded-xl shadow-xl border border-border w-full max-w-lg">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-heading text-lg font-semibold text-sage-900">Capture Answer</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Question</label>
            <p className="text-sm text-sage-600 bg-sage-50 rounded-lg p-3">{gap.question}</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">
              Authoritative answer
            </label>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={5}
              className={inputClasses}
              placeholder="Provide the answer. This becomes the venue's permanent record — Sage uses it on every future draft."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-sage-700 mb-2">Tags</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORY_TAGS.map((t) => {
                const active = tags.includes(t.value)
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => toggleTag(t.value)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      active
                        ? 'bg-sage-500 text-white border-sage-500'
                        : 'bg-white text-sage-700 border-sage-200 hover:bg-sage-50'
                    }`}
                  >
                    {t.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">
              Expires (optional)
            </label>
            <input
              type="date"
              value={appliesUntil}
              onChange={(e) => setAppliesUntil(e.target.value)}
              className={inputClasses}
            />
            <p className="text-xs text-sage-500 mt-1">
              For seasonal rules or dated rates. Leave blank for permanent.
            </p>
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 rounded-lg p-3">{error}</div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !answer.trim()}
              className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Capture'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dismiss Modal
// ---------------------------------------------------------------------------

function DismissModal({
  gap,
  onClose,
  onSaved,
}: {
  gap: KnowledgeGap
  onClose: () => void
  onSaved: () => void
}) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/knowledge-gaps/${gap.id}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      const json = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'dismiss failed')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-surface rounded-xl shadow-xl border border-border w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-heading text-lg font-semibold text-sage-900">Dismiss Gap</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <p className="text-sm text-sage-600 bg-sage-50 rounded-lg p-3">{gap.question}</p>
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">
              Why dismiss this?
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className={inputClasses}
              placeholder="e.g. duplicate of existing capture, not a real question, noise"
            />
          </div>
          {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-3">{error}</div>}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !reason.trim()}
              className="flex items-center gap-2 px-4 py-2.5 bg-rose-500 hover:bg-rose-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <XCircle className="w-4 h-4" />
              {saving ? 'Saving...' : 'Dismiss'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bulk Import Modal
// ---------------------------------------------------------------------------

interface BulkParsedEntry {
  question: string
  answer: string
}

function parseBulk(input: string): BulkParsedEntry[] {
  const entries: BulkParsedEntry[] = []
  // Two parsing modes:
  //   - Block mode: "Q: ...\nA: ..." pairs separated by blank lines
  //   - Line mode: one Q&A per line "Q | A"
  const blocks = input.split(/\n\s*\n/)
  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue
    const qMatch = trimmed.match(/^Q:\s*([\s\S]+?)\nA:\s*([\s\S]+)$/i)
    if (qMatch) {
      entries.push({ question: qMatch[1].trim(), answer: qMatch[2].trim() })
      continue
    }
    // Single-line "Q | A" fallback
    const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean)
    for (const line of lines) {
      const parts = line.split('|')
      if (parts.length >= 2) {
        const q = parts[0].trim()
        const a = parts.slice(1).join('|').trim()
        if (q && a) entries.push({ question: q, answer: a })
      }
    }
  }
  return entries
}

function BulkModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ saved: number; failed: number } | null>(null)

  const parsed = useMemo(() => parseBulk(text), [text])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (parsed.length === 0) return
    setSaving(true)
    setError(null)
    let saved = 0
    let failed = 0
    for (const entry of parsed) {
      try {
        const res = await fetch('/api/admin/knowledge-gaps/capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question: entry.question,
            answer: entry.answer,
            sourceKind: 'operator_input',
          }),
        })
        const json = (await res.json()) as { ok: boolean }
        if (json.ok) saved++
        else failed++
      } catch {
        failed++
      }
    }
    setResult({ saved, failed })
    setSaving(false)
    if (failed === 0) onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-surface rounded-xl shadow-xl border border-border w-full max-w-2xl">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-heading text-lg font-semibold text-sage-900">Bulk Import FAQ</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <p className="text-sm text-sage-600">
            Paste FAQ entries. Format: <code>Q: question</code> on one line, <code>A: answer</code>{' '}
            on the next, blank line between entries. Or one per line as{' '}
            <code>question | answer</code>.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={12}
            className={inputClasses}
            placeholder={'Q: What\'s your minimum guest count?\nA: We require 60 guests on Saturdays in peak season.\n\nQ: Do you allow outside catering?\nA: Yes, with our preferred-vendor list approval.'}
          />
          {parsed.length > 0 && (
            <p className="text-xs text-sage-500">{parsed.length} entries parsed.</p>
          )}
          {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-3">{error}</div>}
          {result && (
            <div className="text-sm text-sage-700 bg-sage-50 rounded-lg p-3">
              Saved {result.saved} captures. {result.failed > 0 ? `${result.failed} failed.` : ''}
            </div>
          )}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={saving || parsed.length === 0}
              className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Sparkles className="w-4 h-4" />
              {saving ? 'Saving...' : `Capture ${parsed.length} entries`}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Capture Edit Modal
// ---------------------------------------------------------------------------

function CaptureEditModal({
  capture,
  onClose,
  onSaved,
}: {
  capture: KnowledgeCapture
  onClose: () => void
  onSaved: () => void
}) {
  const [question, setQuestion] = useState(capture.question)
  const [answer, setAnswer] = useState(capture.answer)
  const [tags, setTags] = useState<string[]>(capture.tags ?? [])
  const [active, setActive] = useState(capture.active)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleTag = (value: string) => {
    setTags((prev) => (prev.includes(value) ? prev.filter((t) => t !== value) : [...prev, value]))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/knowledge-gaps/captures/${capture.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer, tags, active }),
      })
      const json = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !json.ok) throw new Error(json.error ?? 'update failed')
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-surface rounded-xl shadow-xl border border-border w-full max-w-lg">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <h2 className="font-heading text-lg font-semibold text-sage-900">Edit Capture</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Question</label>
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              className={inputClasses}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Answer</label>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={5}
              className={inputClasses}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-2">Tags</label>
            <div className="flex flex-wrap gap-2">
              {CATEGORY_TAGS.map((t) => {
                const isActive = tags.includes(t.value)
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => toggleTag(t.value)}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      isActive
                        ? 'bg-sage-500 text-white border-sage-500'
                        : 'bg-white text-sage-700 border-sage-200 hover:bg-sage-50'
                    }`}
                  >
                    {t.label}
                  </button>
                )
              })}
            </div>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="w-4 h-4 rounded border-sage-300 text-sage-600 focus:ring-sage-500"
            />
            <span className="text-sm text-sage-700">Active (Sage uses this in drafts)</span>
          </label>
          {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg p-3">{error}</div>}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function KnowledgeGapsPage() {
  const VENUE_ID = useVenueId()
  const aiName = useAiName()

  const [tab, setTab] = useState<Tab>('open')
  const [openGaps, setOpenGaps] = useState<KnowledgeGap[]>([])
  const [capturedGaps, setCapturedGaps] = useState<KnowledgeGap[]>([])
  const [dismissedGaps, setDismissedGaps] = useState<KnowledgeGap[]>([])
  const [captures, setCaptures] = useState<KnowledgeCapture[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [capturingGap, setCapturingGap] = useState<KnowledgeGap | null>(null)
  const [dismissingGap, setDismissingGap] = useState<KnowledgeGap | null>(null)
  const [editingCapture, setEditingCapture] = useState<KnowledgeCapture | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)

  const fetchAll = useCallback(async () => {
    if (!VENUE_ID) return
    setLoading(true)
    setError(null)
    try {
      const [openRes, capturedRes, dismissedRes, capturesRes] = await Promise.all([
        fetch(`/api/admin/knowledge-gaps/list?venueId=${VENUE_ID}&status=open`),
        fetch(`/api/admin/knowledge-gaps/list?venueId=${VENUE_ID}&status=captured`),
        fetch(`/api/admin/knowledge-gaps/list?venueId=${VENUE_ID}&status=dismissed`),
        fetch(`/api/admin/knowledge-gaps/captures?venueId=${VENUE_ID}&active=all`),
      ])
      const openJson = (await openRes.json()) as { gaps?: KnowledgeGap[] }
      const capturedJson = (await capturedRes.json()) as { gaps?: KnowledgeGap[] }
      const dismissedJson = (await dismissedRes.json()) as { gaps?: KnowledgeGap[] }
      const capturesJson = (await capturesRes.json()) as { captures?: KnowledgeCapture[] }
      setOpenGaps(openJson.gaps ?? [])
      setCapturedGaps(capturedJson.gaps ?? [])
      setDismissedGaps(dismissedJson.gaps ?? [])
      setCaptures(capturesJson.captures ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [VENUE_ID])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const filteredOpenGaps = useMemo(() => {
    if (!searchQuery.trim()) return openGaps
    const q = searchQuery.toLowerCase()
    return openGaps.filter((g) => g.question.toLowerCase().includes(q))
  }, [openGaps, searchQuery])

  const filteredCaptures = useMemo(() => {
    if (!searchQuery.trim()) return captures
    const q = searchQuery.toLowerCase()
    return captures.filter(
      (c) => c.question.toLowerCase().includes(q) || c.answer.toLowerCase().includes(q),
    )
  }, [captures, searchQuery])

  const topCategories = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const g of openGaps) {
      const cat = g.category || 'uncategorized'
      counts[cat] = (counts[cat] || 0) + 1
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)
  }, [openGaps])

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'open', label: 'Open gaps', count: openGaps.length },
    { key: 'captured', label: 'Captured', count: capturedGaps.length },
    { key: 'library', label: 'Knowledge library', count: captures.filter((c) => c.active).length },
    { key: 'dismissed', label: 'Dismissed', count: dismissedGaps.length },
  ]

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">Knowledge Gaps</h1>
          <p className="text-sage-600 max-w-2xl">
            Questions {aiName} couldn&apos;t answer with confidence. Capture each answer once — it
            becomes permanent venue knowledge {aiName} uses on every future draft.
          </p>
        </div>
        <button
          onClick={() => setBulkOpen(true)}
          className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-sage-700 bg-sage-100 hover:bg-sage-200 rounded-lg transition-colors"
        >
          <Sparkles className="w-4 h-4" />
          Bulk import
        </button>
      </div>

      {/* ---- Error ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={fetchAll}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Stats ---- */}
      {!loading && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center">
                <HelpCircle className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{openGaps.length}</p>
                <p className="text-xs text-sage-500">Open gaps</p>
              </div>
            </div>
          </div>
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">
                  {captures.filter((c) => c.active).length}
                </p>
                <p className="text-xs text-sage-500">Captured answers</p>
              </div>
            </div>
          </div>
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-lg bg-sage-50 flex items-center justify-center">
                <FolderOpen className="w-5 h-5 text-sage-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-sage-900 mb-1">Top categories</p>
                <div className="flex flex-wrap gap-1">
                  {topCategories.length === 0 && (
                    <span className="text-xs text-sage-400">None yet</span>
                  )}
                  {topCategories.map(([cat, count]) => (
                    <span
                      key={cat}
                      className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sage-100 text-sage-700"
                    >
                      {cat} ({count})
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---- Tabs ---- */}
      <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1 w-fit">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
              tab === t.key
                ? 'bg-surface text-sage-900 shadow-sm'
                : 'text-sage-600 hover:text-sage-800'
            }`}
          >
            {t.label}
            <span
              className={`text-xs px-1.5 py-0.5 rounded-full ${
                tab === t.key ? 'bg-sage-100 text-sage-700' : 'bg-sage-100/50 text-sage-500'
              }`}
            >
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* ---- Search ---- */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
        <input
          type="text"
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full bg-warm-white"
        />
      </div>

      {/* ---- Body ---- */}
      {loading ? (
        <div className="bg-surface border border-border rounded-xl shadow-sm p-12 text-center text-sage-500">
          Loading...
        </div>
      ) : tab === 'open' ? (
        filteredOpenGaps.length === 0 ? (
          <EmptyState
            icon={<HelpCircle className="w-12 h-12 text-sage-300 mx-auto mb-4" />}
            title="No open gaps"
            subtitle={`When ${aiName} encounters questions it cannot answer, they appear here.`}
          />
        ) : (
          <div className="space-y-3">
            {filteredOpenGaps.map((gap) => (
              <OpenGapCard
                key={gap.id}
                gap={gap}
                onCapture={() => setCapturingGap(gap)}
                onDismiss={() => setDismissingGap(gap)}
              />
            ))}
          </div>
        )
      ) : tab === 'captured' ? (
        capturedGaps.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="w-12 h-12 text-sage-300 mx-auto mb-4" />}
            title="No captured gaps yet"
            subtitle="Captured gaps appear here once you answer them."
          />
        ) : (
          <div className="space-y-3">
            {capturedGaps.map((gap) => (
              <CapturedGapCard key={gap.id} gap={gap} />
            ))}
          </div>
        )
      ) : tab === 'library' ? (
        filteredCaptures.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="w-12 h-12 text-sage-300 mx-auto mb-4" />}
            title="No captured knowledge yet"
            subtitle="Captured answers from any source (gaps, bulk import, FAQ docs) live here."
          />
        ) : (
          <div className="space-y-3">
            {filteredCaptures.map((c) => (
              <CaptureCard
                key={c.id}
                capture={c}
                onEdit={() => setEditingCapture(c)}
                onDeactivate={async () => {
                  await fetch(`/api/admin/knowledge-gaps/captures/${c.id}`, { method: 'DELETE' })
                  fetchAll()
                }}
              />
            ))}
          </div>
        )
      ) : (
        dismissedGaps.length === 0 ? (
          <EmptyState
            icon={<XCircle className="w-12 h-12 text-sage-300 mx-auto mb-4" />}
            title="No dismissed gaps"
            subtitle="Dismissed gaps stay here as an audit trail."
          />
        ) : (
          <div className="space-y-3">
            {dismissedGaps.map((gap) => (
              <DismissedGapCard key={gap.id} gap={gap} />
            ))}
          </div>
        )
      )}

      {/* ---- Modals ---- */}
      {capturingGap && (
        <CaptureModal
          gap={capturingGap}
          onClose={() => setCapturingGap(null)}
          onSaved={() => {
            setCapturingGap(null)
            fetchAll()
          }}
        />
      )}
      {dismissingGap && (
        <DismissModal
          gap={dismissingGap}
          onClose={() => setDismissingGap(null)}
          onSaved={() => {
            setDismissingGap(null)
            fetchAll()
          }}
        />
      )}
      {editingCapture && (
        <CaptureEditModal
          capture={editingCapture}
          onClose={() => setEditingCapture(null)}
          onSaved={() => {
            setEditingCapture(null)
            fetchAll()
          }}
        />
      )}
      {bulkOpen && (
        <BulkModal
          onClose={() => setBulkOpen(false)}
          onSaved={() => {
            setBulkOpen(false)
            fetchAll()
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function OpenGapCard({
  gap,
  onCapture,
  onDismiss,
}: {
  gap: KnowledgeGap
  onCapture: () => void
  onDismiss: () => void
}) {
  const cat = categoryBadge(gap.category)
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1">
          <p className="text-sage-900 font-medium mb-2">{gap.question}</p>
          <div className="flex items-center gap-2 text-xs">
            <span className={`inline-flex items-center px-2 py-0.5 rounded font-medium ${cat.bg} ${cat.text}`}>
              {cat.label}
            </span>
            <span className="text-sage-500">
              Asked {gap.frequency}× · first seen {timeAgo(gap.created_at)}
            </span>
            {gap.frequency >= 3 && (
              <span className="inline-flex items-center gap-0.5 text-amber-600">
                <TrendingUp className="w-3 h-3" /> hot
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 text-xs font-medium text-sage-600 hover:text-sage-800 transition-colors"
          >
            Dismiss
          </button>
          <button
            onClick={onCapture}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-sage-500 hover:bg-sage-600 rounded-lg transition-colors"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Capture answer
          </button>
        </div>
      </div>
    </div>
  )
}

function CapturedGapCard({ gap }: { gap: KnowledgeGap }) {
  const cat = categoryBadge(gap.category)
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm p-5">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-sage-900 font-medium mb-1">{gap.question}</p>
          {gap.resolution && (
            <p className="text-sm text-sage-600 mb-2 whitespace-pre-wrap">{gap.resolution}</p>
          )}
          <div className="flex items-center gap-2 text-xs">
            <span className={`inline-flex items-center px-2 py-0.5 rounded font-medium ${cat.bg} ${cat.text}`}>
              {cat.label}
            </span>
            <span className="text-sage-500">
              Captured {gap.captured_at ? timeAgo(gap.captured_at) : ''}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function CaptureCard({
  capture,
  onEdit,
  onDeactivate,
}: {
  capture: KnowledgeCapture
  onEdit: () => void
  onDeactivate: () => void
}) {
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-sage-900 font-medium mb-1">{capture.question}</p>
          <p className="text-sm text-sage-600 mb-2 whitespace-pre-wrap">{capture.answer}</p>
          <div className="flex items-center flex-wrap gap-2 text-xs">
            {(capture.tags ?? []).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center px-2 py-0.5 rounded font-medium bg-sage-50 text-sage-700"
              >
                {tag}
              </span>
            ))}
            <span className="text-sage-500">
              {capture.source_kind === 'operator_input' ? 'Operator' :
                capture.source_kind === 'inferred_from_past_email' ? 'Inferred' : 'Doc'}
              {' · '}
              Updated {timeAgo(capture.updated_at)}
            </span>
            {capture.applies_until && (
              <span className="text-xs text-amber-600">
                Expires {new Date(capture.applies_until).toLocaleDateString()}
              </span>
            )}
            {!capture.active && (
              <span className="inline-flex items-center px-2 py-0.5 rounded bg-sage-100 text-sage-500">
                Inactive
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onEdit}
            className="p-1.5 text-sage-500 hover:text-sage-700 hover:bg-sage-50 rounded-lg transition-colors"
            title="Edit"
          >
            <Pencil className="w-4 h-4" />
          </button>
          {capture.active && (
            <button
              onClick={onDeactivate}
              className="p-1.5 text-sage-500 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
              title="Deactivate"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function DismissedGapCard({ gap }: { gap: KnowledgeGap }) {
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm p-5 opacity-75">
      <div className="flex items-start gap-3">
        <XCircle className="w-5 h-5 text-sage-400 shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-sage-700 mb-1">{gap.question}</p>
          {gap.dismissed_reason && (
            <p className="text-xs text-sage-500 italic">Reason: {gap.dismissed_reason}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
      {icon}
      <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">{title}</h3>
      <p className="text-sm text-sage-600 max-w-md mx-auto">{subtitle}</p>
    </div>
  )
}
