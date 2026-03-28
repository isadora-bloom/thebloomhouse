'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  FileText,
  Upload,
  Plus,
  X,
  Search,
  Loader2,
  Brain,
  Send,
  ChevronDown,
  ChevronUp,
  FileImage,
  File,
  Sparkles,
  AlertCircle,
  CheckCircle,
  Clock,
} from 'lucide-react'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Contract {
  id: string
  file_name: string
  file_type: string | null
  file_url: string | null
  extracted_text: string | null
  key_terms: string[] | null
  analysis: string | null
  analyzed_at: string | null
  created_at: string
}

interface UploadFormData {
  file_name: string
  file_type: string
  file_url: string
}

const EMPTY_FORM: UploadFormData = {
  file_name: '',
  file_type: 'pdf',
  file_url: '',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileTypeConfig(type: string | null) {
  switch (type) {
    case 'pdf':
      return { label: 'PDF', className: 'bg-red-50 text-red-600 border-red-200', icon: File }
    case 'image':
      return { label: 'Image', className: 'bg-blue-50 text-blue-600 border-blue-200', icon: FileImage }
    case 'doc':
      return { label: 'DOC', className: 'bg-indigo-50 text-indigo-600 border-indigo-200', icon: FileText }
    default:
      return { label: 'File', className: 'bg-gray-50 text-gray-600 border-gray-200', icon: FileText }
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ---------------------------------------------------------------------------
// Highlighted text renderer
// ---------------------------------------------------------------------------

function HighlightedText({
  text,
  keyTerms,
}: {
  text: string
  keyTerms: string[]
}) {
  if (!keyTerms || keyTerms.length === 0) {
    return <span>{text}</span>
  }

  // Build a regex that matches any key term
  const escaped = keyTerms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts = text.split(regex)

  return (
    <>
      {parts.map((part, i) => {
        const isHighlighted = keyTerms.some(
          (t) => t.toLowerCase() === part.toLowerCase()
        )
        return isHighlighted ? (
          <mark
            key={i}
            className="bg-amber-100 text-amber-900 px-0.5 rounded"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// Contract Card Component
// ---------------------------------------------------------------------------

function ContractCard({
  contract,
  onAnalyze,
  isAnalyzing,
}: {
  contract: Contract
  onAnalyze: (id: string) => void
  isAnalyzing: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [showAsk, setShowAsk] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)

  const config = fileTypeConfig(contract.file_type)
  const TypeIcon = config.icon
  const isAnalyzed = !!contract.analyzed_at

  async function handleAsk() {
    const trimmed = question.trim()
    if (!trimmed || asking || !contract.extracted_text) return

    setAsking(true)
    setAnswer(null)

    try {
      // TODO: Wire to real AI endpoint for contract Q&A
      // For now, simulate a placeholder response
      await new Promise((resolve) => setTimeout(resolve, 1000))
      setAnswer(
        'This feature is coming soon. When wired up, I will analyze the contract text and answer your question about key terms, obligations, deadlines, and more.'
      )
    } catch {
      setAnswer('Sorry, I could not process that question. Please try again.')
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      {/* Main row */}
      <div className="p-5 flex items-start gap-4">
        {/* Type icon */}
        <div className={`p-2.5 rounded-lg shrink-0 ${config.className} border`}>
          <TypeIcon className="w-5 h-5" />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-gray-800 truncate">{contract.file_name}</h3>
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${config.className}`}>
              {config.label}
            </span>
            <span>{timeAgo(contract.created_at)}</span>
            {isAnalyzed && (
              <span className="inline-flex items-center gap-0.5 text-emerald-600">
                <CheckCircle className="w-3 h-3" />
                Analyzed
              </span>
            )}
            {!isAnalyzed && (
              <span className="inline-flex items-center gap-0.5 text-gray-400">
                <Clock className="w-3 h-3" />
                Not analyzed
              </span>
            )}
          </div>

          {/* Key terms badges */}
          {contract.key_terms && contract.key_terms.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {contract.key_terms.slice(0, 8).map((term) => (
                <span
                  key={term}
                  className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200"
                >
                  {term}
                </span>
              ))}
              {contract.key_terms.length > 8 && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-50 text-gray-500 border border-gray-200">
                  +{contract.key_terms.length - 8} more
                </span>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {!isAnalyzed && (
            <button
              onClick={() => onAnalyze(contract.id)}
              disabled={isAnalyzing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              {isAnalyzing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Brain className="w-3.5 h-3.5" />
              )}
              Analyze
            </button>
          )}
          {isAnalyzed && (
            <>
              <button
                onClick={() => setExpanded(!expanded)}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
              >
                View
                {expanded ? (
                  <ChevronUp className="w-3 h-3" />
                ) : (
                  <ChevronDown className="w-3 h-3" />
                )}
              </button>
              <button
                onClick={() => setShowAsk(!showAsk)}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors border"
                style={{
                  color: 'var(--couple-primary)',
                  borderColor: 'var(--couple-primary)',
                }}
              >
                <Sparkles className="w-3 h-3" />
                Ask
              </button>
            </>
          )}
        </div>
      </div>

      {/* Analysis summary */}
      {isAnalyzed && contract.analysis && expanded && (
        <div className="px-5 pb-4 border-t border-gray-50 pt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
            AI Analysis
          </h4>
          <p className="text-sm text-gray-700 leading-relaxed">
            {contract.analysis}
          </p>
        </div>
      )}

      {/* Extracted text with highlights */}
      {isAnalyzed && contract.extracted_text && expanded && (
        <div className="px-5 pb-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
            Extracted Text
          </h4>
          <div className="max-h-64 overflow-y-auto bg-gray-50 rounded-lg p-4 text-sm text-gray-700 leading-relaxed font-mono whitespace-pre-wrap">
            <HighlightedText
              text={contract.extracted_text}
              keyTerms={contract.key_terms || []}
            />
          </div>
        </div>
      )}

      {/* Ask about contract */}
      {showAsk && contract.extracted_text && (
        <div className="px-5 pb-4 border-t border-gray-50 pt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
            Ask About This Contract
          </h4>
          <div className="flex items-end gap-2">
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAsk()
              }}
              placeholder="e.g., What are the cancellation terms?"
              className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              disabled={asking}
            />
            <button
              onClick={handleAsk}
              disabled={asking || !question.trim()}
              className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-white transition-opacity disabled:opacity-50"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              {asking ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </div>

          {answer && (
            <div className="mt-3 bg-gray-50 rounded-lg p-3 text-sm text-gray-700 leading-relaxed">
              <div className="flex items-start gap-2">
                <Sparkles className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--couple-primary)' }} />
                <p>{answer}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function ContractsPage() {
  const [contracts, setContracts] = useState<Contract[]>([])
  const [loading, setLoading] = useState(true)
  const [showUpload, setShowUpload] = useState(false)
  const [form, setForm] = useState<UploadFormData>(EMPTY_FORM)
  const [analyzingId, setAnalyzingId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchContracts = useCallback(async () => {
    const { data, error } = await supabase
      .from('contracts')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('created_at', { ascending: false })

    if (!error && data) {
      setContracts(data as Contract[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchContracts()
  }, [fetchContracts])

  // ---- Upload (store reference -- actual file upload is TODO) ----
  async function handleUpload() {
    if (!form.file_name.trim()) return

    await supabase.from('contracts').insert({
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      file_name: form.file_name.trim(),
      file_type: form.file_type || null,
      file_url: form.file_url.trim() || null,
    })

    setForm(EMPTY_FORM)
    setShowUpload(false)
    fetchContracts()
  }

  // ---- Analyze (placeholder -- real implementation uses AI) ----
  async function handleAnalyze(contractId: string) {
    setAnalyzingId(contractId)

    try {
      // TODO: Wire to real AI analysis endpoint
      // For now, simulate with a delay and placeholder data
      await new Promise((resolve) => setTimeout(resolve, 2000))

      await supabase
        .from('contracts')
        .update({
          extracted_text:
            'This is placeholder extracted text. When the AI analysis pipeline is wired up, this will contain the full OCR/extracted text from the uploaded document.',
          key_terms: [
            'payment schedule',
            'cancellation policy',
            'liability',
            'force majeure',
            'deposit',
            'final payment',
          ],
          analysis:
            'This contract contains standard venue rental terms. Key areas to review: payment schedule requires 50% deposit with remaining balance due 30 days before the event. Cancellation policy allows full refund up to 90 days before the event, 50% refund up to 30 days, and no refund within 30 days. Force majeure clause covers natural disasters and pandemics.',
          analyzed_at: new Date().toISOString(),
        })
        .eq('id', contractId)

      fetchContracts()
    } catch (err) {
      console.error('Analysis error:', err)
    } finally {
      setAnalyzingId(null)
    }
  }

  // ---- Delete ----
  async function handleDelete(contractId: string) {
    if (!confirm('Remove this contract?')) return
    await supabase.from('contracts').delete().eq('id', contractId)
    fetchContracts()
  }

  // ---- Drag & drop handlers ----
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(true)
  }

  function handleDragLeave() {
    setDragOver(false)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    // TODO: actual file upload via Supabase Storage
    // For now, just open the modal
    const files = e.dataTransfer.files
    if (files.length > 0) {
      const file = files[0]
      const ext = file.name.split('.').pop()?.toLowerCase()
      setForm({
        file_name: file.name,
        file_type: ext === 'pdf' ? 'pdf' : ['jpg', 'jpeg', 'png', 'webp'].includes(ext || '') ? 'image' : 'doc',
        file_url: '',
      })
      setShowUpload(true)
    }
  }

  // Stats
  const totalContracts = contracts.length
  const analyzedCount = contracts.filter((c) => c.analyzed_at).length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Contracts & Documents
          </h1>
          <p className="text-gray-500 text-sm">
            Upload vendor contracts and let AI highlight the important terms.
          </p>
        </div>
        <button
          onClick={() => setShowUpload(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Contract
        </button>
      </div>

      {/* Drag & drop upload area */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          dragOver
            ? 'border-current bg-opacity-5'
            : 'border-gray-200 hover:border-gray-300 bg-white'
        }`}
        style={
          dragOver
            ? { borderColor: 'var(--couple-primary)', backgroundColor: 'color-mix(in srgb, var(--couple-primary) 5%, white)' }
            : undefined
        }
      >
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) {
              const ext = file.name.split('.').pop()?.toLowerCase()
              setForm({
                file_name: file.name,
                file_type: ext === 'pdf' ? 'pdf' : ['jpg', 'jpeg', 'png', 'webp'].includes(ext || '') ? 'image' : 'doc',
                file_url: '',
              })
              setShowUpload(true)
            }
          }}
        />
        <Upload
          className="w-8 h-8 mx-auto mb-3"
          style={{ color: dragOver ? 'var(--couple-primary)' : '#9ca3af' }}
        />
        <p className="text-sm text-gray-600 font-medium">
          Drop files here or click to upload
        </p>
        <p className="text-xs text-gray-400 mt-1">
          PDF, images, or documents. Actual storage upload coming soon.
        </p>
      </div>

      {/* Stats */}
      {totalContracts > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {totalContracts}
            </p>
            <p className="text-xs text-gray-500 font-medium">Documents</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums text-emerald-600">
              {analyzedCount}
              <span className="text-sm font-normal text-gray-400">
                /{totalContracts}
              </span>
            </p>
            <p className="text-xs text-gray-500 font-medium">Analyzed</p>
          </div>
        </div>
      )}

      {/* Contracts list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-100 shadow-sm p-5">
              <div className="animate-pulse flex items-center gap-4">
                <div className="w-11 h-11 bg-gray-100 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-48 bg-gray-100 rounded" />
                  <div className="h-3 w-32 bg-gray-50 rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : contracts.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <FileText
            className="w-12 h-12 mx-auto mb-4"
            style={{ color: 'var(--couple-primary)', opacity: 0.3 }}
          />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No contracts yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            Upload vendor contracts to keep everything in one place.
          </p>
          <button
            onClick={() => setShowUpload(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add First Contract
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {contracts.map((contract) => (
            <ContractCard
              key={contract.id}
              contract={contract}
              onAnalyze={handleAnalyze}
              isAnalyzing={analyzingId === contract.id}
            />
          ))}
        </div>
      )}

      {/* Upload Modal */}
      {showUpload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setShowUpload(false)}
          />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                Add Contract
              </h2>
              <button
                onClick={() => setShowUpload(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              {/* File name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  File Name
                </label>
                <input
                  type="text"
                  value={form.file_name}
                  onChange={(e) => setForm({ ...form, file_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., Venue Contract 2026.pdf"
                />
              </div>

              {/* File type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Document Type
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['pdf', 'image', 'doc'] as const).map((type) => {
                    const cfg = fileTypeConfig(type)
                    const Icon = cfg.icon
                    return (
                      <button
                        key={type}
                        onClick={() => setForm({ ...form, file_type: type })}
                        className={`flex flex-col items-center gap-1 p-3 rounded-lg border text-xs font-medium transition-colors ${
                          form.file_type === type
                            ? 'text-white border-transparent'
                            : `${cfg.className} hover:opacity-80`
                        }`}
                        style={
                          form.file_type === type
                            ? { backgroundColor: 'var(--couple-primary)' }
                            : undefined
                        }
                      >
                        <Icon className="w-5 h-5" />
                        {cfg.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* File URL (temporary until storage is wired) */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  File URL (optional)
                </label>
                <input
                  type="url"
                  value={form.file_url}
                  onChange={(e) => setForm({ ...form, file_url: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="https://..."
                />
                <p className="text-xs text-gray-400 mt-1 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  Direct file upload via Supabase Storage coming soon.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowUpload(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                disabled={!form.file_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                Add Contract
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
