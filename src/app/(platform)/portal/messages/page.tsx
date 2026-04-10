'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { useScope } from '@/lib/hooks/use-scope'
import { createBrowserClient } from '@supabase/ssr'
import { VenueChip } from '@/components/intel/venue-chip'
import {
  MessageSquare,
  Send,
  Search,
  Users,
  Clock,
  User,
  Shield,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Person {
  first_name: string
  last_name: string
  role: string
}

interface WeddingThread {
  id: string
  people: Person[]
  message_count: number
  last_message_at: string | null
  unread_count: number
  venue_name?: string | null
}

interface Message {
  id: string
  wedding_id: string
  sender_role: 'coordinator' | 'couple' | 'sage'
  sender_name: string | null
  body: string
  created_at: string
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
// Helpers
// ---------------------------------------------------------------------------

function getCoupleLabel(people: Person[]): string {
  const principals = people.filter(
    (p) => p.role === 'bride' || p.role === 'groom' || p.role === 'partner'
  )
  const names = principals.length > 0 ? principals : people.slice(0, 2)
  return names.map((p) => p.first_name).join(' & ') || 'Unknown'
}

function getInitials(people: Person[]): string {
  const principals = people.filter(
    (p) => p.role === 'bride' || p.role === 'groom' || p.role === 'partner'
  )
  const names = principals.length > 0 ? principals : people.slice(0, 2)
  return names
    .map((p) => p.first_name[0])
    .join('')
    .toUpperCase()
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()

  if (isToday) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday'
  }

  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatTimestamp(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDateSeparator(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()

  if (d.toDateString() === now.toDateString()) return 'Today'

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'

  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

function senderConfig(role: string): {
  label: string
  className: string
  icon: React.ComponentType<{ className?: string }>
  bubbleClass: string
} {
  switch (role) {
    case 'coordinator':
      return {
        label: 'Coordinator',
        className: 'bg-sage-100 text-sage-700',
        icon: Shield,
        bubbleClass: 'bg-sage-500 text-white ml-auto',
      }
    case 'couple':
      return {
        label: 'Couple',
        className: 'bg-teal-100 text-teal-700',
        icon: Users,
        bubbleClass: 'bg-warm-white border border-sage-200 text-sage-900 mr-auto',
      }
    case 'sage':
      return {
        label: 'Sage AI',
        className: 'bg-gold-100 text-gold-700',
        icon: MessageSquare,
        bubbleClass: 'bg-gold-50 border border-gold-200 text-sage-900 mr-auto',
      }
    default:
      return {
        label: role,
        className: 'bg-sage-100 text-sage-600',
        icon: User,
        bubbleClass: 'bg-warm-white border border-sage-200 text-sage-900 mr-auto',
      }
  }
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function ThreadListSkeleton() {
  return (
    <div className="space-y-1 p-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="animate-pulse flex items-center gap-3 p-3 rounded-lg">
          <div className="w-10 h-10 bg-sage-100 rounded-full shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-24 bg-sage-100 rounded" />
            <div className="h-3 w-16 bg-sage-50 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

function MessagesSkeleton() {
  return (
    <div className="flex-1 p-6 space-y-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className={cn('animate-pulse', i % 2 === 0 ? 'flex justify-start' : 'flex justify-end')}>
          <div className={cn('h-12 rounded-2xl', i % 2 === 0 ? 'w-2/3 bg-sage-50' : 'w-1/2 bg-sage-100')} />
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function MessagesPage() {
  const VENUE_ID = useVenueId()
  const scope = useScope()
  const showVenueChip = scope.level !== 'venue'
  const [threads, setThreads] = useState<WeddingThread[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [selectedWeddingId, setSelectedWeddingId] = useState<string | null>(null)
  const [loadingThreads, setLoadingThreads] = useState(true)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [newMessage, setNewMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const messagesEndRef = useRef<HTMLDivElement>(null)

  // ---- Fetch threads ----
  const fetchThreads = useCallback(async () => {
    const supabase = getSupabase()

    try {
      // Get all weddings for this venue with people
      const { data: weddingsData, error: weddingsErr } = await supabase
        .from('weddings')
        .select('id, venues:venue_id ( name ), people (first_name, last_name, role)')
        .eq('venue_id', VENUE_ID)

      if (weddingsErr) throw weddingsErr

      const weddings = ((weddingsData ?? []) as any[]).map((row) => {
        const venueRel = row.venues as { name?: string } | { name?: string }[] | null | undefined
        const venueName = Array.isArray(venueRel) ? venueRel[0]?.name ?? null : venueRel?.name ?? null
        return {
          id: row.id as string,
          people: (row.people ?? []) as Person[],
          venue_name: venueName,
        }
      })

      // Get message counts per wedding
      const { data: msgCounts, error: msgErr } = await supabase
        .from('messages')
        .select('wedding_id, created_at')
        .eq('venue_id', VENUE_ID)
        .order('created_at', { ascending: false })

      if (msgErr) throw msgErr

      const countMap = new Map<string, { count: number; lastAt: string | null }>()
      for (const m of (msgCounts ?? []) as { wedding_id: string; created_at: string }[]) {
        const existing = countMap.get(m.wedding_id)
        if (!existing) {
          countMap.set(m.wedding_id, { count: 1, lastAt: m.created_at })
        } else {
          existing.count++
        }
      }

      const threadList: WeddingThread[] = weddings
        .map((w) => ({
          id: w.id,
          people: w.people,
          message_count: countMap.get(w.id)?.count ?? 0,
          last_message_at: countMap.get(w.id)?.lastAt ?? null,
          unread_count: 0, // TODO: Track unread status
          venue_name: w.venue_name,
        }))
        .filter((t) => t.message_count > 0 || true) // Show all for now
        .sort((a, b) => {
          // Threads with messages first, sorted by most recent
          if (a.last_message_at && b.last_message_at) {
            return b.last_message_at.localeCompare(a.last_message_at)
          }
          if (a.last_message_at) return -1
          if (b.last_message_at) return 1
          return 0
        })

      setThreads(threadList)

      // Auto-select first thread
      if (!selectedWeddingId && threadList.length > 0) {
        setSelectedWeddingId(threadList[0].id)
      }
    } catch (err) {
      console.error('Failed to fetch threads:', err)
    } finally {
      setLoadingThreads(false)
    }
  }, [selectedWeddingId])

  // ---- Fetch messages for selected wedding ----
  const fetchMessages = useCallback(async () => {
    if (!selectedWeddingId) return
    setLoadingMessages(true)

    const supabase = getSupabase()

    try {
      const { data, error: fetchErr } = await supabase
        .from('messages')
        .select('*')
        .eq('wedding_id', selectedWeddingId)
        .order('created_at', { ascending: true })

      if (fetchErr) throw fetchErr

      setMessages((data ?? []) as Message[])
    } catch (err) {
      console.error('Failed to fetch messages:', err)
    } finally {
      setLoadingMessages(false)
    }
  }, [selectedWeddingId])

  useEffect(() => {
    fetchThreads()
  }, [fetchThreads])

  useEffect(() => {
    fetchMessages()
  }, [fetchMessages])

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ---- Send message ----
  const handleSend = async () => {
    if (!newMessage.trim() || !selectedWeddingId) return
    setSending(true)

    const supabase = getSupabase()

    try {
      const { error: insertErr } = await supabase.from('messages').insert({
        venue_id: VENUE_ID,
        wedding_id: selectedWeddingId,
        sender_role: 'coordinator',
        sender_name: 'Coordinator', // TODO: Use current user name
        body: newMessage.trim(),
      })

      if (insertErr) throw insertErr

      setNewMessage('')
      await fetchMessages()
      await fetchThreads()
    } catch (err) {
      console.error('Failed to send message:', err)
    } finally {
      setSending(false)
    }
  }

  // ---- Filter threads ----
  const filteredThreads = threads.filter((t) => {
    if (!searchQuery.trim()) return true
    const label = getCoupleLabel(t.people).toLowerCase()
    return label.includes(searchQuery.toLowerCase())
  })

  const selectedThread = threads.find((t) => t.id === selectedWeddingId)

  // ---- Group messages by date ----
  const groupedMessages: { date: string; messages: Message[] }[] = []
  for (const msg of messages) {
    const dateKey = new Date(msg.created_at).toDateString()
    const lastGroup = groupedMessages[groupedMessages.length - 1]
    if (lastGroup && lastGroup.date === dateKey) {
      lastGroup.messages.push(msg)
    } else {
      groupedMessages.push({ date: dateKey, messages: [msg] })
    }
  }

  return (
    <div className="space-y-0">
      {/* ---- Header ---- */}
      <div className="mb-6">
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Messages
        </h1>
        <p className="text-sage-600">
          Direct messages between your team and couples through the portal. Send updates, answer questions, and keep all wedding communications in one organized thread.
        </p>
      </div>

      {/* ---- Main layout ---- */}
      <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden" style={{ height: 'calc(100vh - 260px)', minHeight: '500px' }}>
        <div className="flex h-full">
          {/* ---- Left panel: Thread list ---- */}
          <div className="w-80 border-r border-border flex flex-col shrink-0">
            {/* Search */}
            <div className="p-3 border-b border-border">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sage-400" />
                <input
                  type="text"
                  placeholder="Search couples..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 text-sm border border-sage-200 rounded-lg text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 bg-warm-white"
                />
              </div>
            </div>

            {/* Thread list */}
            <div className="flex-1 overflow-y-auto">
              {loadingThreads ? (
                <ThreadListSkeleton />
              ) : filteredThreads.length === 0 ? (
                <div className="p-6 text-center">
                  <MessageSquare className="w-8 h-8 text-sage-300 mx-auto mb-2" />
                  <p className="text-sm text-sage-500">
                    {searchQuery ? 'No matching threads' : 'No wedding threads yet'}
                  </p>
                </div>
              ) : (
                <div className="p-1">
                  {filteredThreads.map((thread) => (
                    <button
                      key={thread.id}
                      onClick={() => setSelectedWeddingId(thread.id)}
                      className={cn(
                        'w-full flex items-center gap-3 p-3 rounded-lg text-left transition-colors',
                        selectedWeddingId === thread.id
                          ? 'bg-sage-100'
                          : 'hover:bg-sage-50'
                      )}
                    >
                      <div className="w-10 h-10 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center text-sm font-bold shrink-0">
                        {getInitials(thread.people)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-sage-900 truncate">
                            {getCoupleLabel(thread.people)}
                          </span>
                          {thread.last_message_at && (
                            <span className="text-[11px] text-sage-400 shrink-0">
                              {formatTime(thread.last_message_at)}
                            </span>
                          )}
                        </div>
                        {showVenueChip && thread.venue_name && (
                          <div className="mt-0.5">
                            <VenueChip venueName={thread.venue_name} />
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-2 mt-0.5">
                          <span className="text-xs text-sage-500">
                            {thread.message_count > 0
                              ? `${thread.message_count} message${thread.message_count !== 1 ? 's' : ''}`
                              : 'No messages'}
                          </span>
                          {thread.unread_count > 0 && (
                            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-teal-500 text-white text-[10px] font-bold">
                              {thread.unread_count}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ---- Right panel: Messages ---- */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Thread header */}
            {selectedThread && (
              <div className="px-6 py-4 border-b border-border bg-warm-white flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center text-xs font-bold">
                  {getInitials(selectedThread.people)}
                </div>
                <div>
                  <h3 className="font-heading text-base font-semibold text-sage-900">
                    {getCoupleLabel(selectedThread.people)}
                  </h3>
                  <p className="text-xs text-sage-500">
                    {selectedThread.message_count} message{selectedThread.message_count !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>
            )}

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {!selectedWeddingId ? (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center">
                    <MessageSquare className="w-12 h-12 text-sage-200 mx-auto mb-3" />
                    <p className="text-sage-500 text-sm">
                      Select a wedding thread to view messages
                    </p>
                  </div>
                </div>
              ) : loadingMessages ? (
                <MessagesSkeleton />
              ) : messages.length === 0 ? (
                <div className="h-full flex items-center justify-center">
                  <div className="text-center">
                    <MessageSquare className="w-10 h-10 text-sage-200 mx-auto mb-3" />
                    <p className="text-sage-500 text-sm">
                      No messages yet. Start the conversation below.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {groupedMessages.map((group) => (
                    <div key={group.date}>
                      {/* Date separator */}
                      <div className="flex items-center gap-3 my-4">
                        <div className="flex-1 h-px bg-sage-200" />
                        <span className="text-xs text-sage-400 font-medium">
                          {formatDateSeparator(group.messages[0].created_at)}
                        </span>
                        <div className="flex-1 h-px bg-sage-200" />
                      </div>

                      {/* Messages in group */}
                      {group.messages.map((msg) => {
                        const config = senderConfig(msg.sender_role)
                        const SenderIcon = config.icon
                        const isCoordinator = msg.sender_role === 'coordinator'

                        return (
                          <div
                            key={msg.id}
                            className={cn(
                              'flex flex-col gap-1 mb-3 max-w-[75%]',
                              isCoordinator ? 'ml-auto items-end' : 'mr-auto items-start'
                            )}
                          >
                            {/* Sender label */}
                            <div className="flex items-center gap-1.5 px-1">
                              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${config.className}`}>
                                <SenderIcon className="w-2.5 h-2.5" />
                                {msg.sender_name ?? config.label}
                              </span>
                              <span className="text-[10px] text-sage-400">
                                {formatTimestamp(msg.created_at)}
                              </span>
                            </div>

                            {/* Message bubble */}
                            <div className={cn(
                              'rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap',
                              config.bubbleClass
                            )}>
                              {msg.body}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            {/* Message input */}
            {selectedWeddingId && (
              <div className="px-4 py-3 border-t border-border bg-warm-white">
                <div className="flex items-end gap-3">
                  <textarea
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleSend()
                      }
                    }}
                    placeholder="Type a message..."
                    rows={1}
                    className="flex-1 px-4 py-2.5 border border-sage-200 rounded-xl text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-300 focus:border-sage-400 resize-none bg-surface"
                    style={{ minHeight: '42px', maxHeight: '120px' }}
                  />
                  <button
                    onClick={handleSend}
                    disabled={!newMessage.trim() || sending}
                    className="p-2.5 bg-sage-500 hover:bg-sage-600 text-white rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  >
                    <Send className={cn('w-4 h-4', sending && 'animate-pulse')} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
