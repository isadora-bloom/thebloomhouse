'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createBrowserClient } from '@supabase/ssr'
import {
  BookOpen,
  Plus,
  Search,
  Edit,
  Trash2,
  X,
  Upload,
  MoreVertical,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type KBSource = 'manual' | 'auto-learned' | 'csv'

interface KBEntry {
  id: string
  venue_id: string
  category: string
  question: string
  answer: string
  keywords: string[]
  priority: number
  is_active: boolean
  source: KBSource | null
  created_at: string
  updated_at: string
}

interface EntryForm {
  question: string
  answer: string
  category: string
  is_active: boolean
}

const CATEGORIES = [
  'Pricing',
  'Capacity',
  'Logistics',
  'Catering',
  'Bar',
  'Ceremony',
  'Accommodation',
  'General',
  'Policies',
  'Vendors',
] as const

const EMPTY_FORM: EntryForm = {
  question: '',
  answer: '',
  category: 'General',
  is_active: true,
}

const PAGE_SIZE = 25

// Normalize category for comparison (case-insensitive)
function normalizeCategory(raw: string | null | undefined): string {
  if (!raw) return 'General'
  const lower = raw.toLowerCase().trim()
  const match = CATEGORIES.find((c) => c.toLowerCase() === lower)
  return match ?? (raw.charAt(0).toUpperCase() + raw.slice(1))
}

const CATEGORY_COLORS: Record<string, string> = {
  Pricing: 'bg-gold-100 text-gold-700 border-gold-200',
  Capacity: 'bg-teal-100 text-teal-700 border-teal-200',
  Logistics: 'bg-sage-100 text-sage-700 border-sage-200',
  Catering: 'bg-amber-100 text-amber-700 border-amber-200',
  Bar: 'bg-rose-100 text-rose-700 border-rose-200',
  Ceremony: 'bg-purple-100 text-purple-700 border-purple-200',
  Accommodation: 'bg-blue-100 text-blue-700 border-blue-200',
  General: 'bg-stone-100 text-stone-700 border-stone-200',
  Policies: 'bg-red-100 text-red-700 border-red-200',
  Vendors: 'bg-emerald-100 text-emerald-700 border-emerald-200',
}

function categoryColor(cat: string) {
  return CATEGORY_COLORS[cat] ?? 'bg-sage-100 text-sage-700 border-sage-200'
}

const SOURCE_LABELS: Record<KBSource, string> = {
  manual: 'Manual',
  'auto-learned': 'Auto-learned',
  csv: 'CSV',
}

const SOURCE_COLORS: Record<KBSource, string> = {
  manual: 'bg-sage-50 text-sage-700 border-sage-200',
  'auto-learned': 'bg-teal-50 text-teal-700 border-teal-200',
  csv: 'bg-gold-50 text-gold-700 border-gold-200',
}

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

function formatDate(iso: string | null | undefined) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return '—'
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function KnowledgeBasePage() {
  const scope = useScope()
  const venueId = scope.venueId ?? ''

  const [entries, setEntries] = useState<KBEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [searchQuery, setSearchQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('All')
  const [page, setPage] = useState(1)

  // Expansion of rows (click question to expand answer)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Edit/create modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [editingEntry, setEditingEntry] = useState<KBEntry | null>(null)
  const [form, setForm] = useState<EntryForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  // Kebab menu state
  const [kebabOpenId, setKebabOpenId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // CSV
  const csvInputRef = useRef<HTMLInputElement>(null)
  const [csvUploading, setCsvUploading] = useState(false)

  // -------------------------------------------------------------------------
  // Data fetch
  // -------------------------------------------------------------------------

  const fetchEntries = useCallback(async () => {
    if (!venueId) {
      setEntries([])
      setLoading(false)
      return
    }
    setLoading(true)
    const supabase = getSupabase()
    const { data, error: err } = await supabase
      .from('knowledge_base')
      .select('*')
      .eq('venue_id', venueId)
      .order('category', { ascending: true })
      .order('created_at', { ascending: false })

    if (err) {
      console.error('Failed to fetch KB entries:', err)
      setError(`Failed to load entries: ${err.message}`)
      setLoading(false)
      return
    }

    setEntries((data ?? []) as KBEntry[])
    setLoading(false)
  }, [venueId])

  useEffect(() => {
    fetchEntries()
  }, [fetchEntries])

  // Close kebab on outside click
  useEffect(() => {
    if (!kebabOpenId) return
    const handler = () => setKebabOpenId(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [kebabOpenId])

  // -------------------------------------------------------------------------
  // Derived: filtered list
  // -------------------------------------------------------------------------

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return entries.filter((e) => {
      if (activeCategory !== 'All') {
        if (normalizeCategory(e.category) !== activeCategory) return false
      }
      if (!q) return true
      return (
        e.question.toLowerCase().includes(q) ||
        e.answer.toLowerCase().includes(q)
      )
    })
  }, [entries, searchQuery, activeCategory])

  // Reset page on filter change
  useEffect(() => {
    setPage(1)
  }, [searchQuery, activeCategory])

  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageEntries = useMemo(
    () =>
      filteredEntries.slice(
        (currentPage - 1) * PAGE_SIZE,
        currentPage * PAGE_SIZE
      ),
    [filteredEntries, currentPage]
  )

  // Categories present in data (for chips)
  const presentCategories = useMemo(() => {
    const set = new Set<string>()
    entries.forEach((e) => set.add(normalizeCategory(e.category)))
    // Always include the default categories that have entries, preserving
    // declared order
    const ordered: string[] = []
    CATEGORIES.forEach((c) => {
      if (set.has(c)) ordered.push(c)
    })
    // Any extra custom categories
    Array.from(set).forEach((c) => {
      if (!ordered.includes(c)) ordered.push(c)
    })
    return ordered
  }, [entries])

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  function openCreateModal() {
    setEditingEntry(null)
    setForm(EMPTY_FORM)
    setModalOpen(true)
  }

  function openEditModal(entry: KBEntry) {
    setEditingEntry(entry)
    setForm({
      question: entry.question,
      answer: entry.answer,
      category: normalizeCategory(entry.category),
      is_active: entry.is_active,
    })
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
    setEditingEntry(null)
    setForm(EMPTY_FORM)
  }

  async function handleSave() {
    if (!venueId) {
      setError('No venue selected.')
      return
    }
    const supabase = getSupabase()
    setSaving(true)

    const payload = {
      venue_id: venueId,
      category: form.category,
      question: form.question.trim(),
      answer: form.answer.trim(),
      is_active: form.is_active,
    }

    if (editingEntry) {
      const { error: err } = await supabase
        .from('knowledge_base')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', editingEntry.id)

      if (err) {
        console.error('Failed to update entry:', err)
        setError(`Failed to save: ${err.message}`)
        setSaving(false)
        return
      }
    } else {
      const { error: err } = await supabase.from('knowledge_base').insert({
        ...payload,
        source: 'manual',
        priority: 5,
        keywords: [],
      })

      if (err) {
        console.error('Failed to create entry:', err)
        setError(`Failed to save: ${err.message}`)
        setSaving(false)
        return
      }
    }

    setSaving(false)
    closeModal()
    fetchEntries()
  }

  async function toggleActive(entry: KBEntry) {
    const supabase = getSupabase()
    // Optimistic
    setEntries((prev) =>
      prev.map((e) =>
        e.id === entry.id ? { ...e, is_active: !e.is_active } : e
      )
    )
    const { error: err } = await supabase
      .from('knowledge_base')
      .update({
        is_active: !entry.is_active,
        updated_at: new Date().toISOString(),
      })
      .eq('id', entry.id)

    if (err) {
      console.error('Failed to toggle active:', err)
      setError(`Failed to toggle: ${err.message}`)
      fetchEntries()
    }
  }

  async function handleDelete(id: string) {
    const supabase = getSupabase()
    const { error: err } = await supabase
      .from('knowledge_base')
      .delete()
      .eq('id', id)

    if (err) {
      console.error('Failed to delete:', err)
      setError(`Failed to delete: ${err.message}`)
      return
    }
    setConfirmDeleteId(null)
    setKebabOpenId(null)
    fetchEntries()
  }

  async function handleCSVUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !venueId) return

    setCsvUploading(true)
    try {
      const text = await file.text()
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
      if (lines.length < 2) {
        setError('CSV must have a header row and at least one data row')
        return
      }
      const header = lines[0]
        .toLowerCase()
        .split(',')
        .map((h) => h.trim().replace(/"/g, ''))
      const qIdx = header.findIndex((h) => h === 'question' || h === 'q')
      const aIdx = header.findIndex((h) => h === 'answer' || h === 'a')
      const catIdx = header.findIndex((h) => h === 'category' || h === 'cat')

      if (qIdx === -1 || aIdx === -1) {
        setError('CSV must have "question" and "answer" columns')
        return
      }

      const rows = []
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i]
          .split(',')
          .map((c) => c.trim().replace(/^"|"$/g, ''))
        const question = cols[qIdx]?.trim()
        const answer = cols[aIdx]?.trim()
        if (!question || !answer) continue
        const rawCategory = catIdx >= 0 ? cols[catIdx]?.trim() : 'General'
        rows.push({
          venue_id: venueId,
          category: normalizeCategory(rawCategory),
          question,
          answer,
          keywords: [],
          priority: 5,
          is_active: true,
          source: 'csv' as const,
        })
      }

      if (rows.length === 0) {
        setError('No valid entries found in CSV')
        return
      }

      const supabase = getSupabase()
      const { error: insertErr } = await supabase
        .from('knowledge_base')
        .insert(rows)

      if (insertErr) throw insertErr
      setError(null)
      fetchEntries()
    } catch (err) {
      console.error('CSV upload failed:', err)
      setError('Failed to upload CSV')
    } finally {
      setCsvUploading(false)
      if (csvInputRef.current) csvInputRef.current.value = ''
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const chipCategories = ['All', ...presentCategories]
  const totalCount = entries.length
  const filteredCount = filteredEntries.length

  return (
    <div className="space-y-6">
      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <BookOpen className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700 flex-1">{error}</p>
          <button
            onClick={() => setError(null)}
            className="text-sm font-medium text-red-600 hover:text-red-800"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Knowledge Base
          </h1>
          <p className="text-sage-600">
            Manage what Sage knows about your venue
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => csvInputRef.current?.click()}
            disabled={csvUploading}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sage-700 border border-sage-300 rounded-lg text-sm font-medium hover:bg-sage-50 transition-colors disabled:opacity-50"
          >
            <Upload className="w-4 h-4" />
            {csvUploading ? 'Uploading...' : 'Upload CSV'}
          </button>
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv"
            onChange={handleCSVUpload}
            className="hidden"
          />
          <button
            onClick={openCreateModal}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Entry
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
        <input
          type="text"
          placeholder="Search questions and answers..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-10 py-2.5 bg-surface border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 text-sage-400 hover:text-sage-600"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Count + Category chips */}
      <div className="flex flex-col gap-3">
        <div className="text-xs text-sage-500">
          Showing{' '}
          <span className="font-semibold text-sage-700">{filteredCount}</span>{' '}
          of <span className="font-semibold text-sage-700">{totalCount}</span>{' '}
          {totalCount === 1 ? 'entry' : 'entries'}
        </div>
        <div className="flex flex-wrap gap-2">
          {chipCategories.map((cat) => (
            <button
              key={cat}
              onClick={() => setActiveCategory(cat)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-medium transition-colors border',
                activeCategory === cat
                  ? 'bg-sage-600 text-white border-sage-600'
                  : 'bg-surface text-sage-700 border-border hover:bg-sage-50'
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Table / Empty state */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-sage-300 border-t-sage-600 rounded-full animate-spin" />
        </div>
      ) : totalCount === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <BookOpen className="w-10 h-10 text-sage-300 mx-auto mb-3" />
          <p className="text-sage-700 font-medium mb-1">
            No knowledge base entries yet.
          </p>
          <p className="text-sage-500 text-sm mb-6">
            Add your first entry to give Sage venue-specific knowledge.
          </p>
          <button
            onClick={openCreateModal}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Entry
          </button>
        </div>
      ) : filteredCount === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <Search className="w-10 h-10 text-sage-300 mx-auto mb-3" />
          <p className="text-sage-600 font-medium mb-1">No matches found</p>
          <p className="text-sage-400 text-sm">
            Try a different search term or category.
          </p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-sage-50 border-b border-border">
                <tr className="text-left text-xs font-semibold text-sage-700 uppercase tracking-wide">
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Question / Answer</th>
                  <th className="px-4 py-3 whitespace-nowrap">Source</th>
                  <th className="px-4 py-3 whitespace-nowrap">Last edited</th>
                  <th className="px-4 py-3 text-center whitespace-nowrap">
                    Active
                  </th>
                  <th className="px-4 py-3 w-24 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pageEntries.map((entry) => {
                  const normCat = normalizeCategory(entry.category)
                  const source: KBSource =
                    (entry.source as KBSource) ?? 'manual'
                  const isExpanded = expandedId === entry.id
                  const preview =
                    entry.answer.length > 80
                      ? entry.answer.slice(0, 80) + '...'
                      : entry.answer

                  return (
                    <tr
                      key={entry.id}
                      className={cn(
                        'hover:bg-sage-50/40 transition-colors',
                        !entry.is_active && 'opacity-60'
                      )}
                    >
                      <td className="px-4 py-3 align-top">
                        <span
                          className={cn(
                            'inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border',
                            categoryColor(normCat)
                          )}
                        >
                          {normCat}
                        </span>
                      </td>
                      <td className="px-4 py-3 align-top max-w-md">
                        <button
                          onClick={() =>
                            setExpandedId(isExpanded ? null : entry.id)
                          }
                          className="text-left w-full group"
                        >
                          <div className="font-medium text-sage-900 group-hover:text-sage-700 leading-snug">
                            {entry.question}
                          </div>
                          <div className="text-xs text-sage-600 mt-1 leading-relaxed whitespace-pre-wrap">
                            {isExpanded ? entry.answer : preview}
                          </div>
                        </button>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <span
                          className={cn(
                            'inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border',
                            SOURCE_COLORS[source]
                          )}
                        >
                          {SOURCE_LABELS[source]}
                        </span>
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap text-xs text-sage-500">
                        {formatDate(entry.updated_at ?? entry.created_at)}
                      </td>
                      <td className="px-4 py-3 align-top text-center">
                        <button
                          onClick={() => toggleActive(entry)}
                          role="switch"
                          aria-checked={entry.is_active}
                          className={cn(
                            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                            entry.is_active ? 'bg-sage-600' : 'bg-sage-200'
                          )}
                          title={entry.is_active ? 'Deactivate' : 'Activate'}
                        >
                          <span
                            className={cn(
                              'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform shadow',
                              entry.is_active
                                ? 'translate-x-5'
                                : 'translate-x-1'
                            )}
                          />
                        </button>
                      </td>
                      <td className="px-4 py-3 align-top text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            onClick={() => openEditModal(entry)}
                            className="p-1.5 rounded-md hover:bg-sage-100 transition-colors"
                            title="Edit"
                          >
                            <Edit className="w-4 h-4 text-sage-500" />
                          </button>
                          <div className="relative">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                setKebabOpenId(
                                  kebabOpenId === entry.id ? null : entry.id
                                )
                              }}
                              className="p-1.5 rounded-md hover:bg-sage-100 transition-colors"
                              title="More"
                            >
                              <MoreVertical className="w-4 h-4 text-sage-500" />
                            </button>
                            {kebabOpenId === entry.id && (
                              <div
                                className="absolute right-0 mt-1 w-48 bg-surface border border-border rounded-lg shadow-lg z-20 py-1"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  onClick={() => setConfirmDeleteId(entry.id)}
                                  className="w-full text-left px-3 py-2 text-xs font-medium text-red-600 hover:bg-red-50 inline-flex items-center gap-2"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  Delete permanently
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-sage-50/40 text-xs text-sage-600">
              <div>
                Page {currentPage} of {totalPages}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-3 py-1.5 rounded-md border border-border bg-surface hover:bg-sage-50 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                >
                  Previous
                </button>
                <button
                  onClick={() =>
                    setPage((p) => Math.min(totalPages, p + 1))
                  }
                  disabled={currentPage === totalPages}
                  className="px-3 py-1.5 rounded-md border border-border bg-surface hover:bg-sage-50 disabled:opacity-40 disabled:cursor-not-allowed font-medium"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Add/Edit modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={closeModal}
          />
          <div className="relative bg-surface rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-border">
              <h2 className="font-heading text-xl font-bold text-sage-900">
                {editingEntry ? 'Edit Entry' : 'New Entry'}
              </h2>
              <button
                onClick={closeModal}
                className="p-1.5 rounded-md hover:bg-sage-50 transition-colors"
              >
                <X className="w-5 h-5 text-sage-500" />
              </button>
            </div>

            <div className="p-6 space-y-5">
              {/* Category */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1.5">
                  Category
                </label>
                <select
                  value={form.category}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, category: e.target.value }))
                  }
                  className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              {/* Question */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1.5">
                  Question / Topic
                </label>
                <input
                  type="text"
                  value={form.question}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, question: e.target.value }))
                  }
                  placeholder="e.g. What is the venue capacity?"
                  className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
              </div>

              {/* Answer */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1.5">
                  Answer
                </label>
                <textarea
                  rows={6}
                  value={form.answer}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, answer: e.target.value }))
                  }
                  placeholder="Our venue accommodates up to 200 guests for a seated dinner..."
                  className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-none transition-colors"
                />
              </div>

              {/* Active toggle */}
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-sage-700">
                  Active
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setForm((f) => ({ ...f, is_active: !f.is_active }))
                  }
                  role="switch"
                  aria-checked={form.is_active}
                  className={cn(
                    'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                    form.is_active ? 'bg-sage-600' : 'bg-sage-200'
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow',
                      form.is_active ? 'translate-x-6' : 'translate-x-1'
                    )}
                  />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 p-6 border-t border-border">
              <button
                onClick={closeModal}
                className="px-4 py-2 text-sm font-medium text-sage-600 bg-sage-50 rounded-lg hover:bg-sage-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={
                  saving ||
                  !form.question.trim() ||
                  !form.answer.trim() ||
                  !form.category
                }
                className="px-4 py-2 text-sm font-medium text-white bg-sage-600 rounded-lg hover:bg-sage-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving
                  ? 'Saving...'
                  : editingEntry
                    ? 'Save Changes'
                    : 'Create Entry'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setConfirmDeleteId(null)}
          />
          <div className="relative bg-surface rounded-2xl shadow-xl w-full max-w-sm p-6">
            <h3 className="font-heading text-lg font-bold text-sage-900 mb-2">
              Delete this entry?
            </h3>
            <p className="text-sm text-sage-600 mb-6">
              This will permanently remove the entry from your knowledge base.
              This cannot be undone.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setConfirmDeleteId(null)}
                className="px-4 py-2 text-sm font-medium text-sage-600 bg-sage-50 rounded-lg hover:bg-sage-100 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDeleteId)}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
