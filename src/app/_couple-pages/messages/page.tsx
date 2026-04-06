'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { MessagesSquare, Send, Loader2, MessageCircle } from 'lucide-react'

// TODO: Get from auth session
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  id: string
  venue_id: string
  wedding_id: string
  sender_id: string | null
  sender_role: 'couple' | 'coordinator'
  content: string
  read_at: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMessageTime(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()

  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear()

  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24)
  )

  const timeStr = date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })

  if (isToday) {
    return timeStr
  }

  if (isYesterday) {
    return `Yesterday ${timeStr}`
  }

  if (diffDays < 7) {
    const dayName = date.toLocaleDateString([], { weekday: 'long' })
    return `${dayName} ${timeStr}`
  }

  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  }) + ` ${timeStr}`
}

/**
 * Determine if we should show a date separator between two messages.
 * Returns the label if we should show one, or null.
 */
function getDateSeparator(
  current: Message,
  previous: Message | null
): string | null {
  if (!previous) {
    return formatDateLabel(current.created_at)
  }
  const currentDate = new Date(current.created_at).toDateString()
  const previousDate = new Date(previous.created_at).toDateString()
  if (currentDate !== previousDate) {
    return formatDateLabel(current.created_at)
  }
  return null
}

function formatDateLabel(dateStr: string): string {
  const date = new Date(dateStr)
  const now = new Date()

  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()

  if (isToday) return 'Today'

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday =
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear()

  if (isYesterday) return 'Yesterday'

  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24)
  )

  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'long' })
  }

  return date.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  })
}

// ---------------------------------------------------------------------------
// Messages Page
// ---------------------------------------------------------------------------

export default function MessagesPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [unreadCount, setUnreadCount] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastMessageCountRef = useRef(0)

  // ---- Scroll to bottom ----
  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  // ---- Fetch messages ----
  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch('/api/couple/messages')
      if (!res.ok) return

      const json = await res.json()
      const data = json.data as Message[]
      setMessages(data)

      // Scroll to bottom if new messages arrived
      if (data.length !== lastMessageCountRef.current) {
        lastMessageCountRef.current = data.length
        // Small delay to ensure DOM has updated
        setTimeout(scrollToBottom, 50)
      }
    } catch (err) {
      console.error('Failed to fetch messages:', err)
    }
  }, [scrollToBottom])

  // ---- Fetch unread count ----
  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch('/api/couple/messages?unread=true')
      if (!res.ok) return

      const json = await res.json()
      setUnreadCount(json.data?.unread ?? 0)
    } catch {
      // silent
    }
  }, [])

  // ---- Initial load ----
  useEffect(() => {
    async function init() {
      await fetchUnreadCount()
      await fetchMessages()
      setLoading(false)
    }
    init()
  }, [fetchMessages, fetchUnreadCount])

  // ---- Auto-scroll on messages change ----
  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  // ---- Poll every 15 seconds ----
  useEffect(() => {
    pollRef.current = setInterval(() => {
      fetchMessages()
    }, 15000)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [fetchMessages])

  // ---- Send message ----
  async function handleSend() {
    const trimmed = input.trim()
    if (!trimmed || sending) return

    setInput('')
    setSending(true)

    // Optimistic update
    const tempMsg: Message = {
      id: `temp-${Date.now()}`,
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      sender_id: null,
      sender_role: 'couple',
      content: trimmed,
      read_at: null,
      created_at: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, tempMsg])
    setTimeout(scrollToBottom, 50)

    try {
      const res = await fetch('/api/couple/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: trimmed, sender_role: 'couple' }),
      })

      if (!res.ok) {
        throw new Error('Failed to send message')
      }

      // Refetch to get the real message with server-generated id
      await fetchMessages()
    } catch (err) {
      console.error('Failed to send message:', err)
      // Remove the optimistic message on failure
      setMessages((prev) => prev.filter((m) => m.id !== tempMsg.id))
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  // ---- Keyboard handler ----
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ---- Auto-resize textarea ----
  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value)
    // Auto-resize
    const textarea = e.target
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      {/* ---- Header ---- */}
      <div className="flex items-center gap-3 pb-4 border-b border-gray-100">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <MessagesSquare className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1
              className="text-xl font-semibold"
              style={{
                fontFamily: 'var(--couple-font-heading)',
                color: 'var(--couple-primary)',
              }}
            >
              Messages
            </h1>
            {unreadCount > 0 && (
              <span
                className="inline-flex items-center justify-center px-2 py-0.5 text-xs font-bold text-white rounded-full"
                style={{ backgroundColor: 'var(--couple-accent)' }}
              >
                {unreadCount}
              </span>
            )}
          </div>
          <p className="text-sm text-gray-500">
            Direct messages with your planning team
          </p>
        </div>
      </div>

      {/* ---- Message Thread ---- */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto py-6 space-y-1"
      >
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : messages.length === 0 ? (
          /* ---- Empty State ---- */
          <div className="text-center py-12">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{
                backgroundColor: 'var(--couple-primary)',
                opacity: 0.1,
              }}
            >
              <MessageCircle
                className="w-8 h-8"
                style={{ color: 'var(--couple-primary)' }}
              />
            </div>
            <h3
              className="text-lg font-semibold mb-2"
              style={{
                fontFamily: 'var(--couple-font-heading)',
                color: 'var(--couple-primary)',
              }}
            >
              No messages yet
            </h3>
            <p className="text-gray-500 max-w-md mx-auto text-sm">
              Send a message to your planning team! They will be notified and
              respond as soon as possible.
            </p>
          </div>
        ) : (
          /* ---- Messages List ---- */
          messages.map((msg, idx) => {
            const previous = idx > 0 ? messages[idx - 1] : null
            const dateSep = getDateSeparator(msg, previous)
            const isCoupleMsg = msg.sender_role === 'couple'

            return (
              <div key={msg.id}>
                {/* Date Separator */}
                {dateSep && (
                  <div className="flex items-center gap-3 py-4">
                    <div className="flex-1 h-px bg-gray-200" />
                    <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                      {dateSep}
                    </span>
                    <div className="flex-1 h-px bg-gray-200" />
                  </div>
                )}

                {/* Message Bubble */}
                <div
                  className={cn(
                    'flex mb-3',
                    isCoupleMsg ? 'justify-end' : 'justify-start'
                  )}
                >
                  <div
                    className={cn(
                      'max-w-[80%] sm:max-w-[70%]',
                      isCoupleMsg ? 'items-end' : 'items-start'
                    )}
                  >
                    {/* Sender Label */}
                    {!isCoupleMsg && (
                      <p className="text-xs font-medium text-gray-500 mb-1 ml-1">
                        Your Coordinator
                      </p>
                    )}

                    {/* Bubble */}
                    <div
                      className={cn(
                        'rounded-2xl px-4 py-3 text-sm leading-relaxed',
                        isCoupleMsg
                          ? 'text-white rounded-br-sm'
                          : 'bg-white border border-gray-100 text-gray-800 shadow-sm rounded-bl-sm'
                      )}
                      style={
                        isCoupleMsg
                          ? { backgroundColor: 'var(--couple-primary)' }
                          : undefined
                      }
                    >
                      {msg.content.split('\n').map((line, i, arr) => (
                        <span key={i}>
                          {line}
                          {i < arr.length - 1 && <br />}
                        </span>
                      ))}
                    </div>

                    {/* Timestamp */}
                    <div
                      className={cn(
                        'mt-1 px-1',
                        isCoupleMsg ? 'text-right' : 'text-left'
                      )}
                    >
                      <span className="text-xs text-gray-300">
                        {formatMessageTime(msg.created_at)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )
          })
        )}

        {/* Sending indicator */}
        {sending && (
          <div className="flex justify-end mb-3">
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-gray-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              Sending...
            </div>
          </div>
        )}
      </div>

      {/* ---- Input Bar ---- */}
      <div className="border-t border-gray-100 pt-4 pb-2">
        <div className="flex items-end gap-3">
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent"
            style={
              {
                '--tw-ring-color': 'var(--couple-primary)',
              } as React.CSSProperties
            }
            disabled={sending}
          />
          <button
            onClick={handleSend}
            disabled={sending || !input.trim()}
            className="shrink-0 w-11 h-11 rounded-xl flex items-center justify-center text-white transition-opacity disabled:opacity-50"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            {sending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-2 text-center">
          Messages are sent directly to your planning team.
        </p>
      </div>
    </div>
  )
}
