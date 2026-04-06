'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Send, Sparkles, AlertCircle, Loader2, RotateCcw, FileText, Brain } from 'lucide-react'

// TODO: Get from auth session
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
// TODO: Derive venue_id from wedding or session
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  confidence_score: number | null
  created_at: string
  failed?: boolean
}

interface WeddingState {
  hasTimeline: boolean
  hasVendors: boolean
  hasGuests: boolean
  hasBudgetDueDates: boolean
  hasRsvps: boolean
  daysUntilWedding: number | null
}

// ---------------------------------------------------------------------------
// Context-aware suggested questions
// ---------------------------------------------------------------------------

function buildSuggestedQuestions(state: WeddingState): string[] {
  const questions: string[] = []

  if (!state.hasTimeline) {
    questions.push('Help me build my wedding day timeline')
  }
  if (!state.hasVendors) {
    questions.push('What vendors should I book first?')
  }
  if (state.daysUntilWedding !== null && state.daysUntilWedding < 30 && state.daysUntilWedding > 0) {
    questions.push('What should I double-check before the big day?')
  }
  if (state.hasBudgetDueDates) {
    questions.push('Do I have any upcoming payment deadlines?')
  }
  if (!state.hasRsvps) {
    questions.push('How should I handle RSVP tracking?')
  }
  if (state.hasGuests && !state.hasTimeline) {
    questions.push('How does the day-of timeline usually work?')
  }

  // Always include some fallbacks if we have fewer than 3
  const fallbacks = [
    'What time should we start the ceremony?',
    'What happens if it rains?',
    'Do you have a preferred caterer list?',
    'How can I make the most of my venue?',
  ]

  let fallbackIdx = 0
  while (questions.length < 3 && fallbackIdx < fallbacks.length) {
    if (!questions.includes(fallbacks[fallbackIdx])) {
      questions.push(fallbacks[fallbackIdx])
    }
    fallbackIdx++
  }

  return questions.slice(0, 4)
}

// ---------------------------------------------------------------------------
// Contract mention detector
// ---------------------------------------------------------------------------

function mentionsContracts(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('contract') || lower.includes('agreement')
}

// ---------------------------------------------------------------------------
// Chat Page
// ---------------------------------------------------------------------------

export default function SageChatPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([])
  const [weddingStateLoaded, setWeddingStateLoaded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const autoSentRef = useRef(false)

  const searchParams = useSearchParams()

  // Load wedding state for context-aware suggestions
  useEffect(() => {
    async function loadWeddingState() {
      const supabase = createClient()

      const [timelineRes, vendorRes, guestRes, budgetRes, weddingRes] = await Promise.all([
        supabase
          .from('wedding_timeline')
          .select('id', { count: 'exact', head: true })
          .eq('wedding_id', WEDDING_ID),
        supabase
          .from('booked_vendors')
          .select('id', { count: 'exact', head: true })
          .eq('wedding_id', WEDDING_ID),
        supabase
          .from('guest_list')
          .select('id, rsvp_status')
          .eq('wedding_id', WEDDING_ID),
        supabase
          .from('couple_budget')
          .select('id, payment_due_date')
          .eq('wedding_id', WEDDING_ID)
          .not('payment_due_date', 'is', null),
        supabase
          .from('weddings')
          .select('wedding_date')
          .eq('id', WEDDING_ID)
          .single(),
      ])

      let daysUntilWedding: number | null = null
      if (weddingRes.data?.wedding_date) {
        const weddingDate = new Date(weddingRes.data.wedding_date)
        const now = new Date()
        daysUntilWedding = Math.ceil(
          (weddingDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
        )
      }

      const guests = (guestRes.data ?? []) as { id: string; rsvp_status: string }[]
      const hasRsvps = guests.some(
        (g) => g.rsvp_status === 'attending' || g.rsvp_status === 'declined'
      )

      const state: WeddingState = {
        hasTimeline: (timelineRes.count ?? 0) > 0,
        hasVendors: (vendorRes.count ?? 0) > 0,
        hasGuests: guests.length > 0,
        hasBudgetDueDates: (budgetRes.data?.length ?? 0) > 0,
        hasRsvps,
        daysUntilWedding,
      }

      setSuggestedQuestions(buildSuggestedQuestions(state))
      setWeddingStateLoaded(true)
    }

    loadWeddingState()
  }, [])

  // Load existing conversation history
  useEffect(() => {
    async function loadHistory() {
      const supabase = createClient()

      const { data } = await supabase
        .from('sage_conversations')
        .select('id, role, content, confidence_score, created_at')
        .eq('wedding_id', WEDDING_ID)
        .order('created_at', { ascending: true })
        .limit(100)

      if (data) {
        setMessages(data as Message[])
      }
      setLoading(false)
    }

    loadHistory()
  }, [])

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // Send a message (extracted to reuse for retry)
  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || sending) return

      setInput('')
      setSending(true)

      // Optimistically add user message
      const tempId = `temp-${Date.now()}`
      const tempUserMsg: Message = {
        id: tempId,
        role: 'user',
        content: text.trim(),
        confidence_score: null,
        created_at: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, tempUserMsg])

      try {
        const res = await fetch('/api/portal/sage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            venueId: VENUE_ID,
            weddingId: WEDDING_ID,
            message: text.trim(),
          }),
        })

        if (!res.ok) {
          throw new Error('Failed to send message')
        }

        const data = await res.json()

        // Add Sage's response
        const sageMsg: Message = {
          id: data.conversationId || `sage-${Date.now()}`,
          role: 'assistant',
          content: data.response,
          confidence_score: data.confidence,
          created_at: new Date().toISOString(),
        }
        setMessages((prev) => [...prev, sageMsg])
      } catch (err) {
        console.error('Sage chat error:', err)
        // Mark the user message as failed
        setMessages((prev) =>
          prev.map((m) => (m.id === tempId ? { ...m, failed: true } : m))
        )
        // Add error message from Sage
        const errorMsg: Message = {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: "I'm sorry, I had trouble processing that. Please try again in a moment.",
          confidence_score: null,
          created_at: new Date().toISOString(),
          failed: true,
        }
        setMessages((prev) => [...prev, errorMsg])
      } finally {
        setSending(false)
        inputRef.current?.focus()
      }
    },
    [sending]
  )

  // Handle retry for failed messages
  function handleRetry(failedMsg: Message) {
    // Remove the failed user message and any associated error response
    setMessages((prev) => {
      const failedIdx = prev.findIndex((m) => m.id === failedMsg.id)
      if (failedIdx === -1) return prev
      // Remove the failed message and the error response that follows
      const cleaned = prev.filter((m, idx) => {
        if (m.id === failedMsg.id) return false
        if (idx === failedIdx + 1 && m.role === 'assistant' && m.failed) return false
        return true
      })
      return cleaned
    })
    // Resend
    sendMessage(failedMsg.content)
  }

  // Query parameter support — auto-send ?q=... on mount
  useEffect(() => {
    if (autoSentRef.current) return
    if (loading) return
    const q = searchParams.get('q')
    if (q && q.trim()) {
      autoSentRef.current = true
      sendMessage(q.trim())
    }
  }, [loading, searchParams, sendMessage])

  // Regular send
  function handleSend() {
    sendMessage(input)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-8rem)]">
      {/* Header */}
      <div className="flex items-center gap-3 pb-4 border-b border-gray-100">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Sparkles className="w-5 h-5 text-white" />
        </div>
        <div>
          <h1
            className="text-xl font-semibold"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Chat with Sage
          </h1>
          <p className="text-sm text-gray-500">
            Your AI wedding concierge — ask about anything!
          </p>
        </div>
      </div>

      {/* Messages Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-6 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-12">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
              style={{ backgroundColor: 'var(--couple-primary)', opacity: 0.1 }}
            >
              <Sparkles className="w-8 h-8" style={{ color: 'var(--couple-primary)' }} />
            </div>
            <h3
              className="text-lg font-semibold mb-2"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              Hi there! I am Sage.
            </h3>
            <p className="text-gray-500 max-w-md mx-auto text-sm">
              I know all about your venue and can help with planning questions, logistics,
              vendor suggestions, and more. What is on your mind?
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {(weddingStateLoaded ? suggestedQuestions : [
                'What time should we start the ceremony?',
                'Do you have a preferred caterer list?',
                'What happens if it rains?',
                'How does the day-of timeline usually work?',
              ]).map((q) => (
                <button
                  key={q}
                  onClick={() => {
                    setInput(q)
                    inputRef.current?.focus()
                  }}
                  className="px-3 py-1.5 text-sm rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id}>
              <div
                className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {/* Sage avatar */}
                {msg.role === 'assistant' && (
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1"
                    style={{ backgroundColor: 'var(--couple-primary)' }}
                  >
                    <Sparkles className="w-4 h-4 text-white" />
                  </div>
                )}

                <div className={`max-w-[80%] sm:max-w-[70%]`}>
                  {/* Message bubble */}
                  <div
                    className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'text-white rounded-br-md'
                        : 'bg-white border border-gray-100 text-gray-800 shadow-sm rounded-bl-md'
                    } ${msg.failed && msg.role === 'user' ? 'opacity-70' : ''}`}
                    style={
                      msg.role === 'user'
                        ? { backgroundColor: 'var(--couple-primary)' }
                        : undefined
                    }
                  >
                    {/* Render multi-line content */}
                    {msg.content.split('\n').map((line, i) => (
                      <span key={i}>
                        {line}
                        {i < msg.content.split('\n').length - 1 && <br />}
                      </span>
                    ))}
                  </div>

                  {/* Failed message indicator with retry */}
                  {msg.failed && msg.role === 'user' && (
                    <div className="mt-1 px-1 flex items-center justify-end gap-2">
                      <span className="inline-flex items-center gap-1 text-xs text-red-500 font-medium">
                        <AlertCircle className="w-3 h-3" />
                        Failed to send
                      </span>
                      <button
                        onClick={() => handleRetry(msg)}
                        className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Retry
                      </button>
                    </div>
                  )}

                  {/* Confidence indicator for Sage messages */}
                  {msg.role === 'assistant' && !msg.failed && msg.confidence_score !== null && (
                    <div className="mt-1 px-1">
                      {msg.confidence_score < 70 ? (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                          <AlertCircle className="w-3 h-3" />
                          Sage is checking with your coordinator...
                        </span>
                      ) : (
                        <span className="text-xs text-gray-300">
                          {new Date(msg.created_at).toLocaleTimeString([], {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Timestamp for user messages (non-failed) */}
                  {msg.role === 'user' && !msg.failed && (
                    <div className="mt-1 px-1 text-right">
                      <span className="text-xs text-gray-300">
                        {new Date(msg.created_at).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                  )}
                </div>

                {/* User avatar */}
                {msg.role === 'user' && (
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1 text-white text-xs font-bold"
                    style={{ backgroundColor: 'var(--couple-accent)' }}
                  >
                    Y
                  </div>
                )}
              </div>

              {/* Contract reference info bar — shown after Sage responses that mention contracts */}
              {msg.role === 'assistant' && !msg.failed && mentionsContracts(msg.content) && (
                <div className="ml-11 mt-2 flex items-start gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-100 max-w-[80%] sm:max-w-[70%]">
                  <FileText className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-blue-700">
                    Sage can analyze your uploaded contracts. Go to{' '}
                    <span className="font-semibold">Contracts</span> to upload and review yours.
                  </p>
                </div>
              )}

              {/* Also detect contract mentions in user messages */}
              {msg.role === 'user' && !msg.failed && mentionsContracts(msg.content) && (
                <div className="mr-11 mt-2 ml-auto flex items-start gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-100 max-w-[80%] sm:max-w-[70%]">
                  <FileText className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-blue-700">
                    Sage can analyze your uploaded contracts. Go to{' '}
                    <span className="font-semibold">Contracts</span> to upload and review yours.
                  </p>
                </div>
              )}
            </div>
          ))
        )}

        {/* Typing indicator — improved */}
        {sending && (
          <div className="flex gap-3 justify-start">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div className="bg-white border border-gray-100 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
              <div className="flex items-center gap-2">
                <Brain className="w-4 h-4 text-gray-400 animate-pulse" />
                <span className="text-sm text-gray-500 font-medium">Sage is thinking</span>
                <span className="flex gap-1">
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce"
                    style={{ animationDelay: '0ms' }}
                  />
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce"
                    style={{ animationDelay: '150ms' }}
                  />
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce"
                    style={{ animationDelay: '300ms' }}
                  />
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input Bar */}
      <div className="border-t border-gray-100 pt-4 pb-2">
        <div className="flex items-end gap-3">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Sage anything..."
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
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
          Sage is an AI assistant and may not always be perfect. Your coordinator reviews flagged
          answers.
        </p>
      </div>
    </div>
  )
}
