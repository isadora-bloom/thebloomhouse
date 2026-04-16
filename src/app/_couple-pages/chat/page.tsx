'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { Send, Sparkles, AlertCircle, Loader2, RotateCcw, FileText, Brain, Paperclip, X, File as FileIcon } from 'lucide-react'

// TODO: Get from auth session
// TODO: Derive venue_id from wedding or session
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
  /** Optional attached file metadata (for display in user bubbles) */
  attachedFile?: {
    name: string
    type: string
    url?: string
  }
}

interface ContractContext {
  id: string
  filename: string
  extractedText: string
}

// ---------------------------------------------------------------------------
// File upload constants
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const ACCEPTED_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
const ACCEPTED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png', '.webp']

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

const INITIAL_MESSAGE_LIMIT = 20

function formatDateDivider(dateStr: string): string {
  const d = new Date(dateStr)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(d)
  target.setHours(0, 0, 0, 0)
  const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) {
    return d.toLocaleDateString('en-US', { weekday: 'long' })
  }
  const thisYear = new Date().getFullYear()
  if (d.getFullYear() === thisYear) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function dayKey(dateStr: string): string {
  return new Date(dateStr).toISOString().slice(0, 10)
}

export default function SageChatPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([])
  const [weddingStateLoaded, setWeddingStateLoaded] = useState(false)
  const [hasMoreHistory, setHasMoreHistory] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [attachedFile, setAttachedFile] = useState<File | null>(null)
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null)
  const [uploadingFile, setUploadingFile] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [contractContext, setContractContext] = useState<ContractContext | null>(null)
  const [contractBannerDismissed, setContractBannerDismissed] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const autoSentRef = useRef(false)
  const contractLoadedRef = useRef(false)

  const searchParams = useSearchParams()

  // Load wedding state for context-aware suggestions
  useEffect(() => {
    async function loadWeddingState() {
      const supabase = createClient()

      const [timelineRes, vendorRes, guestRes, budgetRes, weddingRes] = await Promise.all([
        supabase
          .from('wedding_timeline')
          .select('id', { count: 'exact', head: true })
          .eq('wedding_id', weddingId),
        supabase
          .from('booked_vendors')
          .select('id', { count: 'exact', head: true })
          .eq('wedding_id', weddingId),
        supabase
          .from('guest_list')
          .select('id, rsvp_status')
          .eq('wedding_id', weddingId),
        supabase
          .from('budget_items')
          .select('id, payment_due_date')
          .eq('wedding_id', weddingId)
          .not('payment_due_date', 'is', null),
        supabase
          .from('weddings')
          .select('wedding_date')
          .eq('id', weddingId)
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

  // Load existing conversation history — most recent INITIAL_MESSAGE_LIMIT messages
  useEffect(() => {
    async function loadHistory() {
      const supabase = createClient()

      // Get total count first to know if we should show "Load earlier"
      const { count } = await supabase
        .from('sage_conversations')
        .select('id', { count: 'exact', head: true })
        .eq('wedding_id', weddingId)

      // Fetch the most recent INITIAL_MESSAGE_LIMIT rows (desc), then reverse for display
      const { data } = await supabase
        .from('sage_conversations')
        .select('id, role, content, confidence_score, created_at')
        .eq('wedding_id', weddingId)
        .order('created_at', { ascending: false })
        .limit(INITIAL_MESSAGE_LIMIT)

      if (data) {
        setMessages([...(data as Message[])].reverse())
      }
      if ((count ?? 0) > INITIAL_MESSAGE_LIMIT) {
        setHasMoreHistory(true)
      }
      setLoading(false)
    }

    loadHistory()
  }, [])

  // Load contract context if contractId query param is present
  useEffect(() => {
    if (contractLoadedRef.current) return
    const contractId = searchParams.get('contractId')
    if (!contractId || !weddingId) return

    contractLoadedRef.current = true

    async function loadContract() {
      const supabase = createClient()
      const { data } = await supabase
        .from('contracts')
        .select('id, filename, extracted_text')
        .eq('id', contractId!)
        .eq('wedding_id', weddingId!)
        .single()

      if (data && data.extracted_text) {
        setContractContext({
          id: data.id as string,
          filename: data.filename as string,
          extractedText: data.extracted_text as string,
        })
      }
    }

    loadContract()
  }, [searchParams, weddingId])

  // Handle file selection
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setFileError(null)

    // Validate file type
    if (!ACCEPTED_FILE_TYPES.includes(file.type)) {
      setFileError('Please upload a PDF, JPEG, PNG, or WebP file.')
      e.target.value = ''
      return
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      setFileError('File must be under 10MB.')
      e.target.value = ''
      return
    }

    setAttachedFile(file)

    // Create preview URL for images
    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file)
      setFilePreviewUrl(url)
    } else {
      setFilePreviewUrl(null)
    }

    e.target.value = ''
    inputRef.current?.focus()
  }

  function clearAttachedFile() {
    if (filePreviewUrl) {
      URL.revokeObjectURL(filePreviewUrl)
    }
    setAttachedFile(null)
    setFilePreviewUrl(null)
    setFileError(null)
  }

  // Upload file to Supabase storage and return the signed URL
  async function uploadFileToStorage(file: File): Promise<string | null> {
    try {
      const supabase = createClient()
      const timestamp = Date.now()
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const storagePath = `${weddingId}/chat/${timestamp}_${safeName}`

      const { error: storageErr } = await supabase.storage
        .from('contracts')
        .upload(storagePath, file, { upsert: true })

      if (storageErr) {
        console.error('Storage upload error:', storageErr)
        return null
      }

      const { data: urlData } = await supabase.storage
        .from('contracts')
        .createSignedUrl(storagePath, 60 * 60 * 24 * 365) // 1 year

      return urlData?.signedUrl || null
    } catch (err) {
      console.error('File upload failed:', err)
      return null
    }
  }

  // Load earlier messages (pagination)
  async function loadEarlierMessages() {
    if (loadingMore || messages.length === 0) return
    setLoadingMore(true)
    try {
      const supabase = createClient()
      const oldest = messages[0]
      const { data } = await supabase
        .from('sage_conversations')
        .select('id, role, content, confidence_score, created_at')
        .eq('wedding_id', weddingId)
        .lt('created_at', oldest.created_at)
        .order('created_at', { ascending: false })
        .limit(INITIAL_MESSAGE_LIMIT)

      if (data && data.length > 0) {
        const earlier = [...(data as Message[])].reverse()
        setMessages((prev) => [...earlier, ...prev])
        if (data.length < INITIAL_MESSAGE_LIMIT) {
          setHasMoreHistory(false)
        }
      } else {
        setHasMoreHistory(false)
      }
    } catch (err) {
      console.error('Failed to load earlier messages:', err)
    } finally {
      setLoadingMore(false)
    }
  }

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // Send a message (extracted to reuse for retry)
  const sendMessage = useCallback(
    async (text: string, retryFileInfo?: Message['attachedFile']) => {
      if (!text.trim() || sending) return

      const currentFile = retryFileInfo ? null : attachedFile
      const currentFileInfo = retryFileInfo || (currentFile ? {
        name: currentFile.name,
        type: currentFile.type,
      } : undefined)

      setInput('')
      setSending(true)

      // Clear file attachment after capturing it
      if (currentFile) {
        clearAttachedFile()
      }

      // Optimistically add user message
      const tempId = `temp-${Date.now()}`
      const tempUserMsg: Message = {
        id: tempId,
        role: 'user',
        content: text.trim(),
        confidence_score: null,
        created_at: new Date().toISOString(),
        attachedFile: currentFileInfo,
      }
      setMessages((prev) => [...prev, tempUserMsg])

      try {
        // Upload file to storage if attached (not for retries)
        let fileUrl: string | undefined
        if (currentFile) {
          setUploadingFile(true)
          const url = await uploadFileToStorage(currentFile)
          setUploadingFile(false)
          if (url) {
            fileUrl = url
            // Update the optimistic message with the URL
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempId
                  ? { ...m, attachedFile: { ...m.attachedFile!, url } }
                  : m
              )
            )
          }
        }

        // Build file context from contract context (if active and not dismissed)
        let fileContext: string | undefined
        if (contractContext && !contractBannerDismissed) {
          fileContext = `Contract: "${contractContext.filename}"\n\n${contractContext.extractedText.slice(0, 6000)}`
        }

        const res = await fetch('/api/portal/sage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            venueId: venueId,
            weddingId: weddingId,
            message: text.trim(),
            fileUrl,
            fileContext,
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
        setUploadingFile(false)
        inputRef.current?.focus()
      }
    },
    [sending, attachedFile, contractContext, contractBannerDismissed, venueId, weddingId]
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
    // Resend (pass file info from original message if it had one)
    sendMessage(failedMsg.content, failedMsg.attachedFile)
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
    const text = input.trim() || (attachedFile ? `[Attached: ${attachedFile.name}] Please analyze this file.` : '')
    if (text) sendMessage(text)
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

      {/* Contract context banner */}
      {contractContext && !contractBannerDismissed && (
        <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 border border-blue-100 rounded-lg mt-2">
          <FileText className="w-4 h-4 text-blue-500 shrink-0" />
          <p className="text-sm text-blue-700 flex-1">
            Asking about: <span className="font-semibold">{contractContext.filename}</span>
          </p>
          <button
            onClick={() => setContractBannerDismissed(true)}
            className="text-blue-400 hover:text-blue-600 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

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
          <>
            {hasMoreHistory && (
              <div className="flex justify-center pb-2">
                <button
                  onClick={loadEarlierMessages}
                  disabled={loadingMore}
                  className="text-xs font-medium px-3 py-1.5 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
                >
                  {loadingMore ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Loading...
                    </span>
                  ) : (
                    'Load earlier messages'
                  )}
                </button>
              </div>
            )}
            {messages.map((msg, idx) => {
              const prev = idx > 0 ? messages[idx - 1] : null
              const showDivider = !prev || dayKey(prev.created_at) !== dayKey(msg.created_at)
              return (
                <div key={msg.id}>
                  {showDivider && (
                    <div className="flex items-center gap-3 my-4" aria-hidden="true">
                      <div className="flex-1 h-px bg-gray-100" />
                      <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">
                        {formatDateDivider(msg.created_at)}
                      </span>
                      <div className="flex-1 h-px bg-gray-100" />
                    </div>
                  )}
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
                  {/* Attached file preview (above message bubble) */}
                  {msg.attachedFile && msg.role === 'user' && (
                    <div className="mb-1.5 rounded-xl overflow-hidden border border-white/20 bg-white/10 max-w-[240px] ml-auto">
                      {msg.attachedFile.type.startsWith('image/') && msg.attachedFile.url ? (
                        <img
                          src={msg.attachedFile.url}
                          alt={msg.attachedFile.name}
                          className="w-full max-h-40 object-cover"
                        />
                      ) : (
                        <div className="flex items-center gap-2 px-3 py-2 bg-white/90 rounded-lg">
                          <FileIcon className="w-4 h-4 text-red-500 shrink-0" />
                          <span className="text-xs text-gray-700 truncate">{msg.attachedFile.name}</span>
                        </div>
                      )}
                    </div>
                  )}

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
              )
            })}
          </>
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
        {/* File preview */}
        {attachedFile && (
          <div className="mb-2 flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg border border-gray-200">
            {filePreviewUrl ? (
              <img
                src={filePreviewUrl}
                alt={attachedFile.name}
                className="w-10 h-10 rounded object-cover shrink-0"
              />
            ) : (
              <div className="w-10 h-10 rounded bg-red-50 border border-red-200 flex items-center justify-center shrink-0">
                <FileIcon className="w-5 h-5 text-red-500" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800 truncate">{attachedFile.name}</p>
              <p className="text-xs text-gray-400">
                {(attachedFile.size / 1024 / 1024).toFixed(1)} MB
              </p>
            </div>
            <button
              onClick={clearAttachedFile}
              className="text-gray-400 hover:text-gray-600 shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* File error */}
        {fileError && (
          <div className="mb-2 flex items-center gap-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {fileError}
            <button onClick={() => setFileError(null)} className="ml-auto text-red-400 hover:text-red-600">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept={ACCEPTED_EXTENSIONS.join(',')}
          onChange={handleFileSelect}
        />

        <div className="flex items-end gap-2">
          {/* Paperclip attachment button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={sending || uploadingFile}
            className="shrink-0 w-11 h-11 rounded-xl flex items-center justify-center border border-gray-200 text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50"
            title="Attach a file (PDF, JPEG, PNG, WebP)"
          >
            <Paperclip className="w-4 h-4" />
          </button>

          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={attachedFile ? 'Add a message about this file...' : 'Ask Sage anything...'}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-200 px-4 py-3 text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            disabled={sending}
          />
          <button
            onClick={handleSend}
            disabled={sending || (!input.trim() && !attachedFile)}
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
