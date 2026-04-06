'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createBrowserClient } from '@supabase/ssr'
import {
  BookOpen,
  Plus,
  Search,
  Edit,
  Trash2,
  Tag,
  ToggleLeft,
  ToggleRight,
  ChevronDown,
  ChevronUp,
  X,
  Upload,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KBEntry {
  id: string
  venue_id: string
  category: string
  question: string
  answer: string
  keywords: string[]
  priority: number
  is_active: boolean
  created_at: string
  updated_at: string
}

interface EntryForm {
  question: string
  answer: string
  category: string
  customCategory: string
  keywords: string
  priority: number
  is_active: boolean
}

const EMPTY_FORM: EntryForm = {
  question: '',
  answer: '',
  category: '',
  customCategory: '',
  keywords: '',
  priority: 0,
  is_active: true,
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function KnowledgeBasePage() {
  const VENUE_ID = useVenueId()
  const [entries, setEntries] = useState<KBEntry[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [activeCategory, setActiveCategory] = useState<string>('All')
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [editingEntry, setEditingEntry] = useState<KBEntry | null>(null)
  const [form, setForm] = useState<EntryForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Error state
  const [error, setError] = useState<string | null>(null)

  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  const fetchEntries = useCallback(async () => {
    const supabase = getSupabase()

    let query = supabase
      .from('knowledge_base')
      .select('*')
      .eq('venue_id', VENUE_ID)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })

    if (activeCategory !== 'All') {
      query = query.eq('category', activeCategory)
    }

    const { data, error } = await query

    if (error) {
      console.error('Failed to fetch KB entries:', error)
      return
    }

    setEntries((data ?? []) as KBEntry[])
    setLoading(false)
  }, [activeCategory])

  const fetchCategories = useCallback(async () => {
    const supabase = getSupabase()

    const { data, error } = await supabase
      .from('knowledge_base')
      .select('category')
      .eq('venue_id', VENUE_ID)
      .order('category', { ascending: true })

    if (error) {
      console.error('Failed to fetch categories:', error)
      return
    }

    const unique = Array.from(
      new Set((data ?? []).map((r) => r.category as string).filter(Boolean))
    )
    setCategories(unique)
  }, [])

  const searchEntries = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        fetchEntries()
        return
      }

      const supabase = getSupabase()
      const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 1)

      if (words.length === 0) {
        fetchEntries()
        return
      }

      const orConditions = words
        .flatMap((word) => [
          `keywords.cs.{${word}}`,
          `question.ilike.%${word}%`,
          `answer.ilike.%${word}%`,
        ])
        .join(',')

      let query_ = supabase
        .from('knowledge_base')
        .select('*')
        .eq('venue_id', VENUE_ID)
        .eq('is_active', true)
        .or(orConditions)
        .order('priority', { ascending: false })

      if (activeCategory !== 'All') {
        query_ = query_.eq('category', activeCategory)
      }

      const { data, error } = await query_

      if (error) {
        console.error('Failed to search KB:', error)
        return
      }

      setEntries((data ?? []) as KBEntry[])
    },
    [activeCategory, fetchEntries]
  )

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  useEffect(() => {
    fetchEntries()
    fetchCategories()
  }, [fetchEntries, fetchCategories])

  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current)
    }
    searchTimeoutRef.current = setTimeout(() => {
      searchEntries(searchQuery)
    }, 300)
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current)
    }
  }, [searchQuery, searchEntries])

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
    const isCustomCategory = !categories.includes(entry.category)
    setForm({
      question: entry.question,
      answer: entry.answer,
      category: isCustomCategory ? '__custom__' : entry.category,
      customCategory: isCustomCategory ? entry.category : '',
      keywords: (entry.keywords ?? []).join(', '),
      priority: entry.priority,
      is_active: entry.is_active,
    })
    setModalOpen(true)
  }

  function closeModal() {
    setModalOpen(false)
    setEditingEntry(null)
    setForm(EMPTY_FORM)
  }

  const csvInputRef = useRef<HTMLInputElement>(null)
  const [csvUploading, setCsvUploading] = useState(false)

  async function handleCSVUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setCsvUploading(true)
    try {
      const text = await file.text()
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
      if (lines.length < 2) {
        setError('CSV must have a header row and at least one data row')
        return
      }

      // Parse header
      const header = lines[0].toLowerCase().split(',').map((h) => h.trim().replace(/"/g, ''))
      const qIdx = header.findIndex((h) => h === 'question' || h === 'q')
      const aIdx = header.findIndex((h) => h === 'answer' || h === 'a')
      const catIdx = header.findIndex((h) => h === 'category' || h === 'cat')
      const kwIdx = header.findIndex((h) => h === 'keywords' || h === 'tags')

      if (qIdx === -1 || aIdx === -1) {
        setError('CSV must have "question" and "answer" columns')
        return
      }

      // Parse rows
      const supabase = getSupabase()
      const rows = []
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
        const question = cols[qIdx]?.trim()
        const answer = cols[aIdx]?.trim()
        if (!question || !answer) continue

        const category = catIdx >= 0 ? (cols[catIdx]?.trim() || 'general') : 'general'
        const keywords = kwIdx >= 0
          ? (cols[kwIdx] || '').split(';').map((k) => k.trim().toLowerCase()).filter(Boolean)
          : []

        rows.push({
          venue_id: VENUE_ID,
          category,
          question,
          answer,
          keywords,
          priority: 0,
          is_active: true,
        })
      }

      if (rows.length === 0) {
        setError('No valid entries found in CSV')
        return
      }

      const { error: insertErr } = await supabase
        .from('knowledge_base')
        .insert(rows)

      if (insertErr) throw insertErr

      // Refresh
      fetchEntries()
      setError(null)
    } catch (err) {
      console.error('CSV upload failed:', err)
      setError('Failed to upload CSV')
    } finally {
      setCsvUploading(false)
      if (csvInputRef.current) csvInputRef.current.value = ''
    }
  }

  async function handleSave() {
    const supabase = getSupabase()
    setSaving(true)

    const resolvedCategory =
      form.category === '__custom__' ? form.customCategory.trim() : form.category
    const keywordsArray = form.keywords
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean)

    const payload = {
      venue_id: VENUE_ID,
      category: resolvedCategory,
      question: form.question.trim(),
      answer: form.answer.trim(),
      keywords: keywordsArray,
      priority: form.priority,
      is_active: form.is_active,
    }

    if (editingEntry) {
      const { error } = await supabase
        .from('knowledge_base')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', editingEntry.id)

      if (error) {
        console.error('Failed to update entry:', error)
        setSaving(false)
        return
      }
    } else {
      const { error } = await supabase
        .from('knowledge_base')
        .insert(payload)

      if (error) {
        console.error('Failed to create entry:', error)
        setSaving(false)
        return
      }
    }

    setSaving(false)
    closeModal()
    fetchEntries()
    fetchCategories()
  }

  async function handleDelete(id: string) {
    const supabase = getSupabase()

    const { error } = await supabase
      .from('knowledge_base')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('Failed to delete entry:', error)
      return
    }

    setDeletingId(null)
    fetchEntries()
    fetchCategories()
  }

  async function toggleActive(entry: KBEntry) {
    const supabase = getSupabase()

    const { error } = await supabase
      .from('knowledge_base')
      .update({
        is_active: !entry.is_active,
        updated_at: new Date().toISOString(),
      })
      .eq('id', entry.id)

    if (error) {
      console.error('Failed to toggle entry:', error)
      return
    }

    fetchEntries()
  }

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const allCategories = ['All', ...categories]

  return (
    <div className="space-y-6">
      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <BookOpen className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button onClick={() => setError(null)} className="ml-auto text-sm font-medium text-red-600 hover:text-red-800">Dismiss</button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Knowledge Base
          </h1>
          <p className="text-sage-600">
            Manage venue information and FAQs for Sage.
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
          placeholder="Search questions, answers, keywords..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 bg-surface border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
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

      {/* Category filter pills */}
      <div className="flex flex-wrap gap-2">
        {allCategories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
              activeCategory === cat
                ? 'bg-sage-600 text-white'
                : 'bg-sage-100 text-sage-700 hover:bg-sage-200'
            )}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Entries list */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-sage-300 border-t-sage-600 rounded-full animate-spin" />
        </div>
      ) : entries.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <BookOpen className="w-10 h-10 text-sage-300 mx-auto mb-3" />
          <p className="text-sage-600 font-medium mb-1">No entries found</p>
          <p className="text-sage-400 text-sm">
            {searchQuery
              ? 'Try a different search term.'
              : 'Add your first knowledge base entry to help Sage answer couple questions.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => {
            const isExpanded = expandedIds.has(entry.id)
            const isLongAnswer = entry.answer.length > 200

            return (
              <div
                key={entry.id}
                className={cn(
                  'bg-surface border border-border rounded-xl p-6 shadow-sm transition-opacity',
                  !entry.is_active && 'opacity-60'
                )}
              >
                {/* Top row: question + actions */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-heading text-base font-semibold text-sage-900 leading-snug">
                      {entry.question}
                    </h3>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => toggleActive(entry)}
                      className="p-1.5 rounded-md hover:bg-sage-50 transition-colors"
                      title={entry.is_active ? 'Deactivate' : 'Activate'}
                    >
                      {entry.is_active ? (
                        <ToggleRight className="w-5 h-5 text-sage-600" />
                      ) : (
                        <ToggleLeft className="w-5 h-5 text-sage-400" />
                      )}
                    </button>
                    <button
                      onClick={() => openEditModal(entry)}
                      className="p-1.5 rounded-md hover:bg-sage-50 transition-colors"
                      title="Edit"
                    >
                      <Edit className="w-4 h-4 text-sage-500" />
                    </button>
                    {deletingId === entry.id ? (
                      <div className="flex items-center gap-1 ml-1">
                        <button
                          onClick={() => handleDelete(entry.id)}
                          className="px-2 py-1 text-xs font-medium text-red-600 bg-red-50 rounded hover:bg-red-100 transition-colors"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={() => setDeletingId(null)}
                          className="px-2 py-1 text-xs font-medium text-sage-600 bg-sage-50 rounded hover:bg-sage-100 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setDeletingId(entry.id)}
                        className="p-1.5 rounded-md hover:bg-red-50 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4 text-sage-400 hover:text-red-500" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Answer */}
                <div className="mt-3">
                  <p className="text-sm text-sage-700 leading-relaxed whitespace-pre-wrap">
                    {isLongAnswer && !isExpanded
                      ? `${entry.answer.slice(0, 200)}...`
                      : entry.answer}
                  </p>
                  {isLongAnswer && (
                    <button
                      onClick={() => toggleExpand(entry.id)}
                      className="inline-flex items-center gap-1 mt-1.5 text-xs font-medium text-sage-500 hover:text-sage-700 transition-colors"
                    >
                      {isExpanded ? (
                        <>
                          Show less <ChevronUp className="w-3 h-3" />
                        </>
                      ) : (
                        <>
                          Show more <ChevronDown className="w-3 h-3" />
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* Meta row: category, priority, keywords */}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-teal-100 text-teal-700">
                    {entry.category}
                  </span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gold-100 text-gold-700">
                    Priority: {entry.priority}
                  </span>
                  {!entry.is_active && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-sage-100 text-sage-500">
                      Inactive
                    </span>
                  )}
                  {(entry.keywords ?? []).length > 0 && (
                    <div className="flex items-center gap-1 flex-wrap">
                      <Tag className="w-3 h-3 text-sage-400 shrink-0" />
                      {entry.keywords.map((kw) => (
                        <span
                          key={kw}
                          className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-sage-50 text-sage-600 border border-sage-200"
                        >
                          {kw}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Add/Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={closeModal}
          />

          {/* Modal */}
          <div className="relative bg-surface rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            {/* Modal header */}
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

            {/* Modal body */}
            <div className="p-6 space-y-5">
              {/* Question */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1.5">
                  Question
                </label>
                <textarea
                  rows={2}
                  value={form.question}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, question: e.target.value }))
                  }
                  placeholder="What is the venue capacity?"
                  className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-none transition-colors"
                />
              </div>

              {/* Answer */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1.5">
                  Answer
                </label>
                <textarea
                  rows={4}
                  value={form.answer}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, answer: e.target.value }))
                  }
                  placeholder="Our venue accommodates up to 200 guests for a seated dinner..."
                  className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-none transition-colors"
                />
              </div>

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
                  <option value="">Select category...</option>
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                  <option value="__custom__">+ New category</option>
                </select>
                {form.category === '__custom__' && (
                  <input
                    type="text"
                    value={form.customCategory}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        customCategory: e.target.value,
                      }))
                    }
                    placeholder="Enter new category name"
                    className="w-full mt-2 px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                )}
              </div>

              {/* Keywords */}
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1.5">
                  Keywords
                  <span className="font-normal text-sage-400 ml-1">
                    (comma-separated)
                  </span>
                </label>
                <input
                  type="text"
                  value={form.keywords}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, keywords: e.target.value }))
                  }
                  placeholder="capacity, guests, seating, max"
                  className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                />
                {form.keywords.trim() && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {form.keywords
                      .split(',')
                      .map((k) => k.trim())
                      .filter(Boolean)
                      .map((kw) => (
                        <span
                          key={kw}
                          className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-sage-50 text-sage-600 border border-sage-200"
                        >
                          {kw}
                        </span>
                      ))}
                  </div>
                )}
              </div>

              {/* Priority + Active toggle row */}
              <div className="flex items-end gap-6">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-sage-700 mb-1.5">
                    Priority
                    <span className="font-normal text-sage-400 ml-1">
                      (higher = more relevant)
                    </span>
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={form.priority}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        priority: parseInt(e.target.value) || 0,
                      }))
                    }
                    className="w-full px-3 py-2 bg-warm-white border border-border rounded-lg text-sm text-sage-900 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 transition-colors"
                  />
                </div>
                <div className="pb-1">
                  <button
                    type="button"
                    onClick={() =>
                      setForm((f) => ({ ...f, is_active: !f.is_active }))
                    }
                    className="inline-flex items-center gap-2 text-sm font-medium text-sage-700"
                  >
                    {form.is_active ? (
                      <ToggleRight className="w-6 h-6 text-sage-600" />
                    ) : (
                      <ToggleLeft className="w-6 h-6 text-sage-400" />
                    )}
                    {form.is_active ? 'Active' : 'Inactive'}
                  </button>
                </div>
              </div>
            </div>

            {/* Modal footer */}
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
                  (!form.category && !form.customCategory.trim()) ||
                  (form.category === '__custom__' && !form.customCategory.trim())
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
    </div>
  )
}
