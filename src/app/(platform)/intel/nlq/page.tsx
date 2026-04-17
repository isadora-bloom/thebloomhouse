'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Sparkles,
  Send,
  Loader2,
  ThumbsUp,
  ThumbsDown,
  MessageSquare,
  BarChart3,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NLQMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  queryId: string | null
  tokensUsed: number | null
  cost: number | null
  helpful: boolean | null
  created_at: string
  needsMoreData?: boolean
  weddingCount?: number
}

interface HistoryRow {
  id: string
  query_text: string
  response_text: string
  tokens_used: number | null
  cost: number | null
  helpful: boolean | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Suggested questions
// ---------------------------------------------------------------------------

const SUGGESTED_QUESTIONS = [
  'How are we doing compared to last month?',
  'Which source gives us the best ROI?',
  "What's our average booking value this year?",
  'How long does it take us to respond to inquiries?',
  'Show me our conversion funnel',
]

// ---------------------------------------------------------------------------
// Markdown-like renderer
// ---------------------------------------------------------------------------

function renderResponse(text: string) {
  const lines = text.split('\n')

  return lines.map((line, i) => {
    // Bold: **text**
    const parts = line.split(/(\*\*[^*]+\*\*)/g)
    const rendered = parts.map((part, j) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <strong key={j} className="font-semibold text-sage-900">
            {part.slice(2, -2)}
          </strong>
        )
      }
      return <span key={j}>{part}</span>
    })

    // Bullet list items
    if (line.trimStart().startsWith('- ') || line.trimStart().startsWith('* ')) {
      const content = line.trimStart().slice(2)
      const bulletParts = content.split(/(\*\*[^*]+\*\*)/g)
      const bulletRendered = bulletParts.map((part, j) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={j} className="font-semibold text-sage-900">
              {part.slice(2, -2)}
            </strong>
          )
        }
        return <span key={j}>{part}</span>
      })

      return (
        <div key={i} className="flex items-start gap-2 ml-2">
          <span className="text-sage-400 mt-0.5 shrink-0">&#8226;</span>
          <span>{bulletRendered}</span>
        </div>
      )
    }

    // Numbered list items
    const numberedMatch = line.trimStart().match(/^(\d+)\.\s(.+)/)
    if (numberedMatch) {
      const content = numberedMatch[2]
      const numParts = content.split(/(\*\*[^*]+\*\*)/g)
      const numRendered = numParts.map((part, j) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={j} className="font-semibold text-sage-900">
              {part.slice(2, -2)}
            </strong>
          )
        }
        return <span key={j}>{part}</span>
      })

      return (
        <div key={i} className="flex items-start gap-2 ml-2">
          <span className="text-sage-500 font-medium shrink-0">{numberedMatch[1]}.</span>
          <span>{numRendered}</span>
        </div>
      )
    }

    // Empty line = spacing
    if (line.trim() === '') {
      return <div key={i} className="h-2" />
    }

    // Regular paragraph
    return (
      <p key={i} className="leading-relaxed">
        {rendered}
      </p>
    )
  })
}

// ---------------------------------------------------------------------------
// Feedback button component
// ---------------------------------------------------------------------------

function FeedbackButtons({
  queryId,
  currentHelpful,
  onFeedback,
}: {
  queryId: string
  currentHelpful: boolean | null
  onFeedback: (queryId: string, helpful: boolean) => void
}) {
  return (
    <div className="flex items-center gap-1 mt-2">
      <span className="text-xs text-sage-400 mr-1">Was this helpful?</span>
      <button
        onClick={() => onFeedback(queryId, true)}
        className={`p-1 rounded transition-colors ${
          currentHelpful === true
            ? 'text-emerald-500 bg-emerald-50'
            : 'text-sage-300 hover:text-emerald-500 hover:bg-emerald-50'
        }`}
      >
        <ThumbsUp className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => onFeedback(queryId, false)}
        className={`p-1 rounded transition-colors ${
          currentHelpful === false
            ? 'text-red-500 bg-red-50'
            : 'text-sage-300 hover:text-red-500 hover:bg-red-50'
        }`}
      >
        <ThumbsDown className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function NaturalLanguageQueryPage() {
  const [messages, setMessages] = useState<NLQMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ---- Load history from natural_language_queries table ----
  const loadHistory = useCallback(async () => {
    try {
      const supabase = createClient()
      const { data } = await supabase
        .from('natural_language_queries')
        .select('id, query_text, response_text, tokens_used, cost, helpful, created_at')
        .order('created_at', { ascending: true })
        .limit(50)

      if (data) {
        const msgs: NLQMessage[] = []
        ;(data as HistoryRow[]).forEach((row) => {
          msgs.push({
            id: `user-${row.id}`,
            role: 'user',
            content: row.query_text,
            queryId: null,
            tokensUsed: null,
            cost: null,
            helpful: null,
            created_at: row.created_at,
          })
          msgs.push({
            id: `ai-${row.id}`,
            role: 'assistant',
            content: row.response_text,
            queryId: row.id,
            tokensUsed: row.tokens_used,
            cost: row.cost,
            helpful: row.helpful,
            created_at: row.created_at,
          })
        })
        setMessages(msgs)
      }
    } catch (err) {
      console.error('Failed to load NLQ history:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // ---- Send query ----
  async function handleSend() {
    const trimmed = input.trim()
    if (!trimmed || sending) return

    setInput('')
    setSending(true)

    // Optimistically add user message
    const tempUserMsg: NLQMessage = {
      id: `temp-user-${Date.now()}`,
      role: 'user',
      content: trimmed,
      queryId: null,
      tokensUsed: null,
      cost: null,
      helpful: null,
      created_at: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, tempUserMsg])

    try {
      const res = await fetch('/api/intel/nlq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      })

      if (!res.ok) throw new Error('Failed to query')
      const data = await res.json()

      // GAP-07 empty-state: not enough weddings for a reliable answer.
      if (data.needs_more_data) {
        const needsDataMsg: NLQMessage = {
          id: `needs-data-${Date.now()}`,
          role: 'assistant',
          content: data.message,
          queryId: null,
          tokensUsed: null,
          cost: null,
          helpful: null,
          created_at: new Date().toISOString(),
          needsMoreData: true,
          weddingCount: data.wedding_count,
        }
        setMessages((prev) => [...prev, needsDataMsg])
        return
      }

      const aiMsg: NLQMessage = {
        id: `ai-${data.queryId || Date.now()}`,
        role: 'assistant',
        content: data.response,
        queryId: data.queryId,
        tokensUsed: data.tokensUsed,
        cost: data.cost,
        helpful: null,
        created_at: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, aiMsg])
    } catch (err) {
      console.error('NLQ error:', err)
      const errorMsg: NLQMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content:
          'Sorry, I had trouble processing that question. Please try again or rephrase your question.',
        queryId: null,
        tokensUsed: null,
        cost: null,
        helpful: null,
        created_at: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, errorMsg])
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  // ---- Feedback ----
  async function handleFeedback(queryId: string, helpful: boolean) {
    try {
      await fetch('/api/intel/nlq', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queryId, helpful }),
      })

      // Update local state
      setMessages((prev) =>
        prev.map((msg) =>
          msg.queryId === queryId ? { ...msg, helpful } : msg
        )
      )
    } catch (err) {
      console.error('Feedback error:', err)
    }
  }

  // ---- Key handler ----
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ---- Use a suggested question ----
  function useSuggestion(question: string) {
    setInput(question)
    inputRef.current?.focus()
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="flex items-center gap-3 pb-4 border-b border-border">
        <div className="p-2 bg-gold-50 rounded-lg">
          <Sparkles className="w-5 h-5 text-gold-500" />
        </div>
        <div>
          <h1 className="font-heading text-2xl font-bold text-sage-900">
            Ask Your Data
          </h1>
          <p className="text-sm text-sage-600">
            Ask questions about your data in plain English — like &quot;How many inquiries came from Instagram last month?&quot; The AI searches your analytics and gives you a direct answer.
          </p>
        </div>
      </div>

      {/* Chat area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto py-6 space-y-5">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-sage-400" />
          </div>
        ) : messages.length === 0 ? (
          /* Empty state with suggested questions */
          <div className="text-center py-12">
            <div className="w-16 h-16 bg-sage-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <BarChart3 className="w-8 h-8 text-sage-400" />
            </div>
            <h3 className="font-heading text-lg font-semibold text-sage-900 mb-2">
              What would you like to know?
            </h3>
            <p className="text-sage-500 text-sm max-w-md mx-auto mb-8">
              Ask any question about your venue data -- bookings, revenue, sources,
              conversions, response times, and more.
            </p>

            <div className="flex flex-wrap justify-center gap-2 max-w-2xl mx-auto">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => useSuggestion(q)}
                  className="px-4 py-2 text-sm rounded-full bg-surface border border-border text-sage-700 hover:bg-sage-50 hover:border-sage-300 transition-colors"
                >
                  <MessageSquare className="w-3.5 h-3.5 inline mr-1.5 text-sage-400" />
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Message list */
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {/* AI avatar */}
              {msg.role === 'assistant' && (
                <div className="w-8 h-8 bg-sage-100 rounded-full flex items-center justify-center shrink-0 mt-1">
                  <Sparkles className="w-4 h-4 text-sage-600" />
                </div>
              )}

              <div className={`max-w-[80%] sm:max-w-[70%]`}>
                {/* Bubble */}
                {msg.role === 'assistant' && msg.needsMoreData ? (
                  <div className="rounded-2xl rounded-bl-md px-4 py-4 text-sm bg-gold-50 border border-gold-200 text-sage-800 shadow-sm">
                    <div className="flex items-start gap-2 mb-2">
                      <BarChart3 className="w-4 h-4 text-gold-500 mt-0.5 shrink-0" />
                      <div className="font-semibold text-sage-900">
                        Not enough data yet
                      </div>
                    </div>
                    <p className="leading-relaxed text-sage-700 mb-2">
                      {msg.content}
                    </p>
                    {typeof msg.weddingCount === 'number' && (
                      <p className="text-xs text-sage-500">
                        Current wedding count:{' '}
                        <span className="font-semibold text-sage-700">
                          {msg.weddingCount}
                        </span>
                      </p>
                    )}
                  </div>
                ) : (
                  <div
                    className={`rounded-2xl px-4 py-3 text-sm ${
                      msg.role === 'user'
                        ? 'bg-sage-500 text-white rounded-br-md'
                        : 'bg-surface border border-border text-sage-800 shadow-sm rounded-bl-md'
                    }`}
                  >
                    {msg.role === 'assistant' ? (
                      <div className="space-y-1">{renderResponse(msg.content)}</div>
                    ) : (
                      msg.content
                    )}
                  </div>
                )}

                {/* Feedback for AI messages */}
                {msg.role === 'assistant' && msg.queryId && (
                  <FeedbackButtons
                    queryId={msg.queryId}
                    currentHelpful={msg.helpful}
                    onFeedback={handleFeedback}
                  />
                )}

                {/* Timestamp */}
                <div className={`mt-1 px-1 ${msg.role === 'user' ? 'text-right' : ''}`}>
                  <span className="text-xs text-sage-300">
                    {new Date(msg.created_at).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>

              {/* User avatar */}
              {msg.role === 'user' && (
                <div className="w-8 h-8 bg-sage-500 rounded-full flex items-center justify-center shrink-0 mt-1 text-white text-xs font-bold">
                  U
                </div>
              )}
            </div>
          ))
        )}

        {/* Typing indicator */}
        {sending && (
          <div className="flex gap-3 justify-start">
            <div className="w-8 h-8 bg-sage-100 rounded-full flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4 text-sage-600" />
            </div>
            <div className="bg-surface border border-border rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
              <div className="flex gap-1.5">
                <div
                  className="w-2 h-2 rounded-full bg-sage-300 animate-bounce"
                  style={{ animationDelay: '0ms' }}
                />
                <div
                  className="w-2 h-2 rounded-full bg-sage-300 animate-bounce"
                  style={{ animationDelay: '150ms' }}
                />
                <div
                  className="w-2 h-2 rounded-full bg-sage-300 animate-bounce"
                  style={{ animationDelay: '300ms' }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="border-t border-border pt-4 pb-2">
        <div className="flex items-end gap-3">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything about your venue performance..."
            rows={1}
            className="flex-1 resize-none rounded-xl border border-border bg-surface px-4 py-3 text-sm text-sage-900 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-500 focus:border-transparent"
            disabled={sending}
          />
          <button
            onClick={handleSend}
            disabled={sending || !input.trim()}
            className="shrink-0 w-11 h-11 rounded-xl bg-sage-500 hover:bg-sage-600 flex items-center justify-center text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
        <p className="text-xs text-sage-400 mt-2 text-center">
          Powered by AI. Answers are based on your venue data and may not always be
          perfectly accurate.
        </p>
      </div>
    </div>
  )
}
