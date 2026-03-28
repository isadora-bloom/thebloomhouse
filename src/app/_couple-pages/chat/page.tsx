'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Send, Sparkles, AlertCircle, Loader2 } from 'lucide-react'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
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
}

// ---------------------------------------------------------------------------
// Chat Page
// ---------------------------------------------------------------------------

export default function SageChatPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

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

  // Send a message
  async function handleSend() {
    const trimmed = input.trim()
    if (!trimmed || sending) return

    setInput('')
    setSending(true)

    // Optimistically add user message
    const tempUserMsg: Message = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: trimmed,
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
          message: trimmed,
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
      // Add error message
      const errorMsg: Message = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: "I'm sorry, I had trouble processing that. Please try again in a moment.",
        confidence_score: null,
        created_at: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, errorMsg])
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
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
              {[
                'What time should we start the ceremony?',
                'Do you have a preferred caterer list?',
                'What happens if it rains?',
                'How does the day-of timeline usually work?',
              ].map((q) => (
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
            <div
              key={msg.id}
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

              <div
                className={`max-w-[80%] sm:max-w-[70%] ${
                  msg.role === 'user' ? '' : ''
                }`}
              >
                {/* Message bubble */}
                <div
                  className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.role === 'user'
                      ? 'text-white rounded-br-md'
                      : 'bg-white border border-gray-100 text-gray-800 shadow-sm rounded-bl-md'
                  }`}
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

                {/* Confidence indicator for Sage messages */}
                {msg.role === 'assistant' && msg.confidence_score !== null && (
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

                {/* Timestamp for user messages */}
                {msg.role === 'user' && (
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
          ))
        )}

        {/* Typing indicator */}
        {sending && (
          <div className="flex gap-3 justify-start">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <div className="bg-white border border-gray-100 rounded-2xl rounded-bl-md px-4 py-3 shadow-sm">
              <div className="flex gap-1.5">
                <div className="w-2 h-2 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: '300ms' }} />
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
          Sage is an AI assistant and may not always be perfect. Your coordinator reviews flagged answers.
        </p>
      </div>
    </div>
  )
}
