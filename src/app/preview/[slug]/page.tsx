'use client'

import { useState, useEffect, useRef } from 'react'
import { Send, Sparkles, Loader2, MessageCircle } from 'lucide-react'
import { useParams } from 'next/navigation'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

interface VenueInfo {
  name: string
  aiName: string
  primaryColor: string
  tourBookingUrl: string | null
}

// ---------------------------------------------------------------------------
// Max preview messages
// ---------------------------------------------------------------------------

const MAX_MESSAGES = 5

// ---------------------------------------------------------------------------
// Sage Preview Chat Page
// ---------------------------------------------------------------------------

export default function SagePreviewPage() {
  const params = useParams()
  const slug = params.slug as string

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [messageCount, setMessageCount] = useState(0)
  const [venue, setVenue] = useState<VenueInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Load venue info on mount
  useEffect(() => {
    async function loadVenue() {
      try {
        const res = await fetch(`/api/public/sage-preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ venueSlug: slug, message: 'hello' }),
        })

        // We use the first message to test the venue exists and get AI name
        if (!res.ok) {
          if (res.status === 404) {
            setError('Venue not found')
          } else {
            setError('Something went wrong')
          }
          setLoading(false)
          return
        }

        const data = await res.json()

        // We'll parse venue info from a separate lightweight fetch
        // For now, set venue from slug and use defaults
        setVenue({
          name: slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
          aiName: 'Sage',
          primaryColor: getComputedStyle(document.documentElement).getPropertyValue('--preview-primary').trim() || '#7D8471',
          tourBookingUrl: null,
        })

        // Add the initial greeting response
        setMessages([{
          id: `sage-${Date.now()}`,
          role: 'assistant',
          content: data.response,
        }])
        setMessageCount(1)
      } catch {
        setError('Failed to connect')
      } finally {
        setLoading(false)
      }
    }

    loadVenue()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const limitReached = messageCount >= MAX_MESSAGES

  async function handleSend() {
    const trimmed = input.trim()
    if (!trimmed || sending || limitReached) return

    setInput('')
    setSending(true)

    // Optimistic user message
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
    }
    setMessages((prev) => [...prev, userMsg])

    try {
      const res = await fetch('/api/public/sage-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ venueSlug: slug, message: trimmed }),
      })

      if (!res.ok) throw new Error('Failed to get response')

      const data = await res.json()
      const newCount = messageCount + 1
      setMessageCount(newCount)

      const sageMsg: ChatMessage = {
        id: `sage-${Date.now()}`,
        role: 'assistant',
        content: data.response,
      }
      setMessages((prev) => [...prev, sageMsg])
    } catch {
      const errorMsg: ChatMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: "I'm sorry, I had trouble processing that. Please try again.",
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

  const aiName = venue?.aiName || 'Sage'
  const primaryColor = venue?.primaryColor || '#7D8471'

  // Error state
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="text-center">
          <MessageCircle className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h1 className="text-lg font-semibold text-gray-700 mb-2">{error}</h1>
          <p className="text-sm text-gray-500">Please check the URL and try again.</p>
        </div>
      </div>
    )
  }

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col max-w-2xl mx-auto">
      {/* Header */}
      <div className="px-4 py-4 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center"
            style={{ backgroundColor: primaryColor }}
          >
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1
              className="text-lg font-semibold"
              style={{ fontFamily: 'var(--font-heading)', color: primaryColor }}
            >
              Chat with {aiName}
            </h1>
            <p className="text-xs text-gray-500">
              {venue?.name} — AI Wedding Assistant Preview
            </p>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6 space-y-4 bg-gray-50">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {msg.role === 'assistant' && (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1"
                style={{ backgroundColor: primaryColor }}
              >
                <Sparkles className="w-4 h-4 text-white" />
              </div>
            )}

            <div className="max-w-[80%]">
              <div
                className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'text-white rounded-br-md'
                    : 'bg-white border border-gray-100 text-gray-800 shadow-sm rounded-bl-md'
                }`}
                style={
                  msg.role === 'user'
                    ? { backgroundColor: primaryColor }
                    : undefined
                }
              >
                {msg.content.split('\n').map((line, i) => (
                  <span key={i}>
                    {line}
                    {i < msg.content.split('\n').length - 1 && <br />}
                  </span>
                ))}
              </div>
            </div>

            {msg.role === 'user' && (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1 bg-gray-300 text-white text-xs font-bold"
              >
                U
              </div>
            )}
          </div>
        ))}

        {/* Typing indicator */}
        {sending && (
          <div className="flex gap-3 justify-start">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
              style={{ backgroundColor: primaryColor }}
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

      {/* Limit reached banner */}
      {limitReached && (
        <div className="px-4 py-6 bg-white border-t border-gray-200 text-center">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3"
            style={{ backgroundColor: primaryColor, opacity: 0.15 }}
          >
            <Sparkles className="w-6 h-6" style={{ color: primaryColor }} />
          </div>
          <p className="text-sm font-semibold text-gray-800 mb-1">
            Sign up to continue chatting with {aiName}
          </p>
          <p className="text-xs text-gray-500 mb-4">
            Get full access to your personal AI wedding planning assistant, detailed venue info, and more.
          </p>
          <a
            href={venue?.tourBookingUrl || '#'}
            className="inline-block px-5 py-2.5 rounded-lg text-white text-sm font-medium transition-opacity hover:opacity-90"
            style={{ backgroundColor: primaryColor }}
          >
            Book a Tour
          </a>
        </div>
      )}

      {/* Input bar — hidden when limit reached */}
      {!limitReached && (
        <div className="border-t border-gray-200 bg-white px-4 py-3">
          <div className="flex items-end gap-3">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Ask ${aiName} about the venue...`}
              rows={1}
              maxLength={500}
              className="flex-1 resize-none rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ '--tw-ring-color': primaryColor } as React.CSSProperties}
              disabled={sending}
            />
            <button
              onClick={handleSend}
              disabled={sending || !input.trim()}
              className="shrink-0 w-11 h-11 rounded-xl flex items-center justify-center text-white transition-opacity disabled:opacity-50"
              style={{ backgroundColor: primaryColor }}
            >
              {sending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>
          <div className="flex justify-between items-center mt-2 px-1">
            <p className="text-xs text-gray-400">
              {aiName} is an AI preview assistant. {MAX_MESSAGES - messageCount} messages remaining.
            </p>
          </div>
        </div>
      )}

      {/* Footer CTA */}
      <div className="px-4 py-3 border-t border-gray-100 bg-white text-center">
        <p className="text-xs text-gray-400">
          Want to learn more?{' '}
          <a
            href={venue?.tourBookingUrl || '#'}
            className="font-medium underline underline-offset-2"
            style={{ color: primaryColor }}
          >
            Book a tour
          </a>
          {' '}to explore everything {venue?.name || 'we'} {venue?.name ? 'has' : 'have'} to offer.
        </p>
      </div>
    </div>
  )
}
