'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Mail,
  RefreshCw,
  Search,
  Inbox,
  ArrowLeft,
  Clock,
  Tag,
  MailOpen,
  Send,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Interaction {
  id: string
  venue_id: string
  wedding_id: string | null
  person_id: string | null
  type: string
  direction: 'inbound' | 'outbound'
  subject: string | null
  body_preview: string | null
  full_body: string | null
  gmail_thread_id: string | null
  timestamp: string
  // Joined
  person_name?: string
  person_email?: string
  wedding_status?: string
  classification?: 'inquiry' | 'client' | 'vendor'
  is_read?: boolean
}

type FilterTab = 'all' | 'inquiries' | 'client' | 'unread'

// TODO: Replace with venue from auth context
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

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
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function formatFullDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function classifyInteraction(
  weddingStatus: string | null,
  direction: string
): 'inquiry' | 'client' | 'vendor' {
  if (!weddingStatus || weddingStatus === 'inquiry') return 'inquiry'
  if (['booked', 'completed'].includes(weddingStatus)) return 'client'
  return 'client'
}

function classificationBadge(cls: 'inquiry' | 'client' | 'vendor') {
  switch (cls) {
    case 'inquiry':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label: 'Inquiry' }
    case 'client':
      return { bg: 'bg-sage-50', text: 'text-sage-700', label: 'Client' }
    case 'vendor':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Vendor' }
  }
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function EmailListSkeleton() {
  return (
    <div className="divide-y divide-border">
      {[...Array(8)].map((_, i) => (
        <div key={i} className="p-4">
          <div className="animate-pulse space-y-2">
            <div className="flex items-center justify-between">
              <div className="h-4 w-32 bg-sage-100 rounded" />
              <div className="h-3 w-12 bg-sage-100 rounded" />
            </div>
            <div className="h-4 w-3/4 bg-sage-100 rounded" />
            <div className="h-3 w-full bg-sage-50 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="p-6">
      <div className="animate-pulse space-y-4">
        <div className="h-6 w-2/3 bg-sage-100 rounded" />
        <div className="h-4 w-1/3 bg-sage-100 rounded" />
        <div className="space-y-2 mt-6">
          <div className="h-4 w-full bg-sage-50 rounded" />
          <div className="h-4 w-full bg-sage-50 rounded" />
          <div className="h-4 w-5/6 bg-sage-50 rounded" />
          <div className="h-4 w-3/4 bg-sage-50 rounded" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Email List Item
// ---------------------------------------------------------------------------

function EmailListItem({
  interaction,
  isSelected,
  onClick,
}: {
  interaction: Interaction
  isSelected: boolean
  onClick: () => void
}) {
  const cls = interaction.classification ?? 'inquiry'
  const badge = classificationBadge(cls)
  const isRead = interaction.is_read ?? interaction.direction === 'outbound'

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 transition-colors border-l-2 ${
        isSelected
          ? 'bg-sage-50 border-l-sage-500'
          : 'border-l-transparent hover:bg-sage-50/50'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          {!isRead && (
            <span className="w-2 h-2 rounded-full bg-sage-500 shrink-0" />
          )}
          <span
            className={`text-sm truncate ${
              isRead ? 'text-sage-600' : 'font-semibold text-sage-900'
            }`}
          >
            {interaction.direction === 'inbound'
              ? interaction.person_name || interaction.person_email || 'Unknown'
              : `To: ${interaction.person_name || interaction.person_email || 'Unknown'}`}
          </span>
        </div>
        <span className="text-xs text-sage-400 shrink-0">
          {timeAgo(interaction.timestamp)}
        </span>
      </div>
      <p
        className={`text-sm truncate mb-1 ${
          isRead ? 'text-sage-600' : 'font-medium text-sage-800'
        }`}
      >
        {interaction.subject || '(No subject)'}
      </p>
      <div className="flex items-center gap-2">
        <p className="text-xs text-sage-400 truncate flex-1">
          {interaction.body_preview || 'No preview available'}
        </p>
        <span
          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${badge.bg} ${badge.text}`}
        >
          {badge.label}
        </span>
      </div>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Thread View
// ---------------------------------------------------------------------------

function ThreadView({
  interaction,
  threadMessages,
  draft,
  onBack,
}: {
  interaction: Interaction
  threadMessages: Interaction[]
  draft: { id: string; draft_body: string; subject: string } | null
  onBack: () => void
}) {
  return (
    <div className="flex flex-col h-full">
      {/* Thread header */}
      <div className="p-4 border-b border-border">
        <button
          onClick={onBack}
          className="lg:hidden flex items-center gap-1 text-sm text-sage-500 hover:text-sage-700 mb-2 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <h2 className="font-heading text-lg font-semibold text-sage-900">
          {interaction.subject || '(No subject)'}
        </h2>
        <div className="flex items-center gap-3 mt-1 text-sm text-sage-500">
          <span className="flex items-center gap-1">
            <Mail className="w-3.5 h-3.5" />
            {interaction.person_name || interaction.person_email || 'Unknown'}
          </span>
          <span className="flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" />
            {formatFullDate(interaction.timestamp)}
          </span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {threadMessages.map((msg) => (
          <div
            key={msg.id}
            className={`rounded-xl p-4 ${
              msg.direction === 'inbound'
                ? 'bg-warm-white border border-border'
                : 'bg-sage-50 border border-sage-200 ml-8'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-sage-800">
                {msg.direction === 'inbound'
                  ? msg.person_name || msg.person_email || 'Contact'
                  : 'You'}
              </span>
              <span className="text-xs text-sage-400">
                {formatFullDate(msg.timestamp)}
              </span>
            </div>
            <div className="text-sm text-sage-700 whitespace-pre-wrap leading-relaxed">
              {msg.full_body || msg.body_preview || '(No content)'}
            </div>
          </div>
        ))}

        {/* Draft reply if exists */}
        {draft && (
          <div className="rounded-xl p-4 bg-amber-50 border border-amber-200 ml-8">
            <div className="flex items-center gap-2 mb-2">
              <Send className="w-3.5 h-3.5 text-amber-600" />
              <span className="text-sm font-medium text-amber-800">
                Draft Reply (pending approval)
              </span>
            </div>
            <div className="text-sm text-amber-700 whitespace-pre-wrap leading-relaxed">
              {draft.draft_body}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function InboxPage() {
  const [interactions, setInteractions] = useState<Interaction[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<FilterTab>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [threadMessages, setThreadMessages] = useState<Interaction[]>([])
  const [threadDraft, setThreadDraft] = useState<{
    id: string
    draft_body: string
    subject: string
  } | null>(null)
  const [threadLoading, setThreadLoading] = useState(false)

  const supabase = createClient()

  // ---- Fetch interactions ----
  const fetchInteractions = useCallback(async () => {
    try {
      const { data: interactionsData, error: fetchError } = await supabase
        .from('interactions')
        .select(`
          id,
          venue_id,
          wedding_id,
          person_id,
          type,
          direction,
          subject,
          body_preview,
          gmail_thread_id,
          timestamp,
          people!interactions_person_id_fkey ( first_name, last_name, email ),
          weddings!interactions_wedding_id_fkey ( status )
        `)
        .eq('venue_id', VENUE_ID)
        .eq('type', 'email')
        .order('timestamp', { ascending: false })
        .limit(200)

      if (fetchError) throw fetchError

      const mapped: Interaction[] = (interactionsData ?? []).map((row: any) => {
        const person = row.people
        const wedding = row.weddings
        const personName = person
          ? [person.first_name, person.last_name].filter(Boolean).join(' ')
          : null
        const weddingStatus = wedding?.status ?? null

        return {
          id: row.id,
          venue_id: row.venue_id,
          wedding_id: row.wedding_id,
          person_id: row.person_id,
          type: row.type,
          direction: row.direction,
          subject: row.subject,
          body_preview: row.body_preview,
          full_body: null,
          gmail_thread_id: row.gmail_thread_id,
          timestamp: row.timestamp,
          person_name: personName || undefined,
          person_email: person?.email || undefined,
          wedding_status: weddingStatus,
          classification: classifyInteraction(weddingStatus, row.direction),
          is_read: row.direction === 'outbound',
        }
      })

      setInteractions(mapped)
      setError(null)
    } catch (err) {
      console.error('Failed to fetch interactions:', err)
      setError('Failed to load emails')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchInteractions()
  }, [fetchInteractions])

  // ---- Load thread when selecting an email ----
  const loadThread = useCallback(
    async (interaction: Interaction) => {
      setSelectedId(interaction.id)
      setThreadLoading(true)
      setThreadDraft(null)

      try {
        // Fetch all messages in this thread
        let query = supabase
          .from('interactions')
          .select(`
            id,
            venue_id,
            wedding_id,
            person_id,
            type,
            direction,
            subject,
            body_preview,
            full_body,
            gmail_thread_id,
            timestamp,
            people!interactions_person_id_fkey ( first_name, last_name, email )
          `)
          .eq('venue_id', VENUE_ID)
          .order('timestamp', { ascending: true })

        if (interaction.gmail_thread_id) {
          query = query.eq('gmail_thread_id', interaction.gmail_thread_id)
        } else {
          query = query.eq('id', interaction.id)
        }

        const { data: threadData } = await query

        const mapped: Interaction[] = (threadData ?? []).map((row: any) => {
          const person = row.people
          const personName = person
            ? [person.first_name, person.last_name].filter(Boolean).join(' ')
            : null
          return {
            ...row,
            person_name: personName || undefined,
            person_email: person?.email || undefined,
          }
        })

        setThreadMessages(mapped.length > 0 ? mapped : [interaction])

        // Check for a pending draft
        const { data: draftData } = await supabase
          .from('drafts')
          .select('id, draft_body, subject')
          .eq('venue_id', VENUE_ID)
          .eq('interaction_id', interaction.id)
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        if (draftData) {
          setThreadDraft(draftData)
        }
      } catch (err) {
        console.error('Failed to load thread:', err)
      } finally {
        setThreadLoading(false)
      }
    },
    []
  )

  // ---- Sync emails ----
  const handleSync = async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/agent/sync', { method: 'POST' })
      if (!res.ok) throw new Error('Sync failed')
      await fetchInteractions()
    } catch (err) {
      console.error('Failed to sync emails:', err)
      setError('Email sync failed. Check Gmail connection.')
    } finally {
      setSyncing(false)
    }
  }

  // ---- Filtering ----
  const filteredInteractions = interactions.filter((i) => {
    // Tab filter
    if (activeTab === 'inquiries' && i.classification !== 'inquiry') return false
    if (activeTab === 'client' && i.classification !== 'client') return false
    if (activeTab === 'unread' && i.is_read) return false

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      return (
        (i.subject?.toLowerCase().includes(q) ?? false) ||
        (i.person_name?.toLowerCase().includes(q) ?? false) ||
        (i.person_email?.toLowerCase().includes(q) ?? false) ||
        (i.body_preview?.toLowerCase().includes(q) ?? false)
      )
    }
    return true
  })

  // ---- Stats ----
  const totalCount = interactions.length
  const unreadCount = interactions.filter((i) => !i.is_read).length

  const selectedInteraction = interactions.find((i) => i.id === selectedId) ?? null

  const tabs: { key: FilterTab; label: string; count?: number }[] = [
    { key: 'all', label: 'All' },
    {
      key: 'inquiries',
      label: 'Inquiries',
      count: interactions.filter((i) => i.classification === 'inquiry').length,
    },
    {
      key: 'client',
      label: 'Client',
      count: interactions.filter((i) => i.classification === 'client').length,
    },
    { key: 'unread', label: 'Unread', count: unreadCount },
  ]

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Inbox
          </h1>
          <p className="text-sage-600">
            {totalCount} email{totalCount !== 1 ? 's' : ''}
            {unreadCount > 0 && (
              <span className="text-sage-500">
                {' '}
                &middot; {unreadCount} unread
              </span>
            )}
          </p>
        </div>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing...' : 'Sync Emails'}
        </button>
      </div>

      {/* ---- Error ---- */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Mail className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => {
              setError(null)
              setLoading(true)
              fetchInteractions()
            }}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Filters + Search ---- */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                activeTab === tab.key
                  ? 'bg-surface text-sage-900 shadow-sm'
                  : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              {tab.label}
              {tab.count !== undefined && (
                <span
                  className={`text-xs px-1.5 py-0.5 rounded-full ${
                    activeTab === tab.key
                      ? 'bg-sage-100 text-sage-700'
                      : 'bg-sage-100/50 text-sage-500'
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="relative sm:ml-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
          <input
            type="text"
            placeholder="Search emails..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 pr-4 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 w-full sm:w-64 bg-warm-white"
          />
        </div>
      </div>

      {/* ---- Main content: list + detail ---- */}
      <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
        {loading ? (
          <div className="grid grid-cols-1 lg:grid-cols-5">
            <div className="lg:col-span-2 border-r border-border">
              <EmailListSkeleton />
            </div>
            <div className="lg:col-span-3 hidden lg:block">
              <DetailSkeleton />
            </div>
          </div>
        ) : filteredInteractions.length === 0 ? (
          <div className="p-12 text-center">
            <Inbox className="w-12 h-12 text-sage-300 mx-auto mb-4" />
            <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
              {searchQuery
                ? 'No matching emails'
                : activeTab !== 'all'
                  ? `No ${activeTab} emails`
                  : 'Inbox is empty'}
            </h3>
            <p className="text-sm text-sage-600 max-w-md mx-auto">
              {searchQuery
                ? `No emails match "${searchQuery}". Try a different search term.`
                : 'Click "Sync Emails" to pull in the latest from Gmail.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-5 min-h-[600px]">
            {/* Left panel: email list */}
            <div
              className={`lg:col-span-2 border-r border-border overflow-y-auto max-h-[700px] divide-y divide-border ${
                selectedId ? 'hidden lg:block' : ''
              }`}
            >
              {filteredInteractions.map((interaction) => (
                <EmailListItem
                  key={interaction.id}
                  interaction={interaction}
                  isSelected={interaction.id === selectedId}
                  onClick={() => loadThread(interaction)}
                />
              ))}
            </div>

            {/* Right panel: detail / thread */}
            <div
              className={`lg:col-span-3 overflow-y-auto max-h-[700px] ${
                selectedId ? '' : 'hidden lg:flex'
              }`}
            >
              {selectedInteraction ? (
                threadLoading ? (
                  <DetailSkeleton />
                ) : (
                  <ThreadView
                    interaction={selectedInteraction}
                    threadMessages={threadMessages}
                    draft={threadDraft}
                    onBack={() => setSelectedId(null)}
                  />
                )
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
                  <MailOpen className="w-12 h-12 text-sage-200 mb-4" />
                  <p className="text-sm text-sage-400">
                    Select an email to view the conversation
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
