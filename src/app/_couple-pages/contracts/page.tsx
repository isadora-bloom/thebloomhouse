'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { cn } from '@/lib/utils'
import {
  FileText,
  Upload,
  Plus,
  X,
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
  Trash2,
  ExternalLink,
  Eye,
  Search,
} from 'lucide-react'

// TODO: Get from auth session
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Contract {
  id: string
  venue_id: string
  wedding_id: string
  filename: string
  file_type: string | null
  file_url: string | null
  storage_path: string | null
  extracted_text: string | null
  key_terms: string[] | null
  analysis: string | null
  analyzed_at: string | null
  vendor_id: string | null
  vendor_name: string | null
  status: string | null
  created_at: string
  updated_at: string | null
}

interface BookedVendor {
  id: string
  vendor_type: string
  vendor_name: string | null
  is_booked: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY_TERM_HIGHLIGHTS = [
  'payment schedule', 'deposit', 'final payment', 'cancellation policy',
  'liability', 'force majeure', 'damage', 'insurance', 'gratuity',
  'overtime', 'refund', 'non-refundable', 'retainer', 'balance due',
  'minimum', 'maximum', 'guest count', 'indemnify', 'termination',
  'security deposit', 'act of god', 'rain plan',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileTypeConfig(type: string | null) {
  switch (type) {
    case 'pdf':
      return { label: 'PDF', className: 'bg-red-50 text-red-600 border-red-200', icon: File, iconColor: 'text-red-500' }
    case 'image':
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'webp':
      return { label: 'Image', className: 'bg-blue-50 text-blue-600 border-blue-200', icon: FileImage, iconColor: 'text-blue-500' }
    case 'doc':
    case 'docx':
      return { label: 'DOC', className: 'bg-indigo-50 text-indigo-600 border-indigo-200', icon: FileText, iconColor: 'text-indigo-500' }
    default:
      return { label: 'File', className: 'bg-gray-50 text-gray-600 border-gray-200', icon: FileText, iconColor: 'text-gray-500' }
  }
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatDate(dateStr)
}

// ---------------------------------------------------------------------------
// HighlightedText — highlights key contract terms in extracted text
// ---------------------------------------------------------------------------

function HighlightedText({ text }: { text: string }) {
  if (!text) return null

  // Build regex from key terms
  const escaped = KEY_TERM_HIGHLIGHTS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts = text.split(regex)

  return (
    <>
      {parts.map((part, i) => {
        const isHighlighted = KEY_TERM_HIGHLIGHTS.some(
          t => t.toLowerCase() === part.toLowerCase()
        )
        return isHighlighted ? (
          <mark key={i} className="bg-amber-100 text-amber-900 px-0.5 rounded font-medium">
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
// ContractCard
// ---------------------------------------------------------------------------

function ContractCard({
  contract,
  onAnalyze,
  onDelete,
  isAnalyzing,
}: {
  contract: Contract
  onAnalyze: (id: string, imageBase64?: string, mediaType?: string) => void
  onDelete: (id: string) => void
  isAnalyzing: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [showAsk, setShowAsk] = useState(false)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [showFullText, setShowFullText] = useState(false)

  const config = fileTypeConfig(contract.file_type)
  const TypeIcon = config.icon
  const isAnalyzed = !!contract.analyzed_at

  async function handleAsk() {
    const trimmed = question.trim()
    if (!trimmed || asking) return

    setAsking(true)
    setAnswer(null)

    try {
      const res = await fetch('/api/couple/contracts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'ask',
          contractId: contract.id,
          question: trimmed,
        }),
      })

      const data = await res.json()

      if (data.error) {
        setAnswer('Sorry, I could not answer that question. ' + data.error)
      } else {
        setAnswer(data.answer)
      }
    } catch {
      setAnswer('Sorry, something went wrong. Please try again.')
    } finally {
      setAsking(false)
    }
  }

  async function handleAnalyzeClick() {
    // If it's an image type and we have storage, try downloading and converting
    if (contract.storage_path && ['image', 'jpg', 'jpeg', 'png', 'webp'].includes(contract.file_type || '')) {
      // Try to fetch the file for vision analysis
      const supabase = createClient()
      const { data: fileData } = await supabase.storage
        .from('contracts')
        .download(contract.storage_path)

      if (fileData) {
        const arrayBuffer = await fileData.arrayBuffer()
        const base64 = btoa(
          new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
        )
        const mimeMap: Record<string, string> = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', image: 'image/jpeg',
        }
        onAnalyze(contract.id, base64, mimeMap[contract.file_type || ''] || 'image/jpeg')
        return
      }
    }

    onAnalyze(contract.id)
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      {/* Main row */}
      <div className="p-5">
        <div className="flex items-start gap-4">
          {/* Type icon */}
          <div className={cn('p-2.5 rounded-lg shrink-0 border', config.className)}>
            <TypeIcon className="w-5 h-5" />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-gray-800 truncate">{contract.filename}</h3>

            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 flex-wrap">
              <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border', config.className)}>
                {config.label}
              </span>
              {contract.vendor_name && (
                <span className="inline-flex items-center gap-1 text-gray-600">
                  <FileText className="w-3 h-3" />
                  {contract.vendor_name}
                </span>
              )}
              <span>{timeAgo(contract.created_at)}</span>
              {isAnalyzed ? (
                <span className="inline-flex items-center gap-0.5 text-emerald-600 font-medium">
                  <CheckCircle className="w-3 h-3" />
                  Analyzed
                </span>
              ) : (
                <span className="inline-flex items-center gap-0.5 text-amber-500">
                  <Clock className="w-3 h-3" />
                  Pending
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
            {contract.file_url && (
              <a
                href={contract.file_url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                title="View file"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            {!isAnalyzed && (
              <button
                onClick={handleAnalyzeClick}
                disabled={isAnalyzing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {isAnalyzing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Brain className="w-3.5 h-3.5" />
                )}
                {isAnalyzing ? 'Analyzing...' : 'Analyze'}
              </button>
            )}
            {isAnalyzed && (
              <>
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  <Eye className="w-3 h-3" />
                  {expanded ? 'Hide' : 'View'}
                  {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
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
            <button
              onClick={() => onDelete(contract.id)}
              className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              title="Delete"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* AI Analysis summary */}
      {isAnalyzed && contract.analysis && expanded && (
        <div className="px-5 pb-4 border-t border-gray-50 pt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
            AI Analysis
          </h4>
          <div className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
            {contract.analysis}
          </div>
        </div>
      )}

      {/* Extracted text with highlights */}
      {isAnalyzed && contract.extracted_text && expanded && (
        <div className="px-5 pb-4">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Extracted Text
            </h4>
            <button
              onClick={() => setShowFullText(!showFullText)}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              {showFullText ? 'Show less' : 'Show all'}
            </button>
          </div>
          <div
            className={cn(
              'bg-gray-50 rounded-lg p-4 text-sm text-gray-700 leading-relaxed font-mono whitespace-pre-wrap overflow-y-auto',
              showFullText ? 'max-h-[600px]' : 'max-h-48'
            )}
          >
            <HighlightedText
              text={showFullText ? contract.extracted_text : contract.extracted_text.slice(0, 1500)}
            />
            {!showFullText && contract.extracted_text.length > 1500 && (
              <span className="text-gray-400">... (click "Show all" to see full text)</span>
            )}
          </div>
        </div>
      )}

      {/* Ask about contract */}
      {showAsk && (
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
                if (e.key === 'Enter' && !e.shiftKey) handleAsk()
              }}
              placeholder="e.g., What are the cancellation terms?"
              className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent text-gray-900 placeholder:text-gray-400"
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
                <Sparkles
                  className="w-4 h-4 shrink-0 mt-0.5"
                  style={{ color: 'var(--couple-primary)' }}
                />
                <p className="whitespace-pre-wrap">{answer}</p>
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
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [contracts, setContracts] = useState<Contract[]>([])
  const [vendors, setVendors] = useState<BookedVendor[]>([])
  const [loading, setLoading] = useState(true)
  const [showUpload, setShowUpload] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadVendorId, setUploadVendorId] = useState<string>('')
  const [uploading, setUploading] = useState(false)
  const [analyzingId, setAnalyzingId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const supabase = createClient()

  // ---- Fetch contracts ----
  const fetchContracts = useCallback(async () => {
    const { data, error: fetchErr } = await supabase
      .from('contracts')
      .select('*')
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: false })

    if (fetchErr) {
      console.error('Error fetching contracts:', fetchErr)
    }
    if (data) {
      setContracts(data as Contract[])
    }
    setLoading(false)
  }, [supabase])

  // ---- Fetch vendors for linking ----
  const fetchVendors = useCallback(async () => {
    const { data } = await supabase
      .from('booked_vendors')
      .select('id, vendor_type, vendor_name, is_booked')
      .eq('wedding_id', weddingId)
      .order('vendor_type')

    if (data) {
      setVendors(data as BookedVendor[])
    }
  }, [supabase])

  useEffect(() => {
    fetchContracts()
    fetchVendors()
  }, [fetchContracts, fetchVendors])

  // ---- Upload file to storage + create record ----
  async function handleUpload() {
    if (!uploadFile) return

    setUploading(true)
    setError(null)

    try {
      const timestamp = Date.now()
      const safeName = uploadFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const storagePath = `${weddingId}/${timestamp}_${safeName}`

      // Upload to Supabase Storage
      const { error: storageErr } = await supabase.storage
        .from('contracts')
        .upload(storagePath, uploadFile, { upsert: true })

      if (storageErr) throw storageErr

      // Get signed URL
      const { data: urlData } = await supabase.storage
        .from('contracts')
        .createSignedUrl(storagePath, 60 * 60 * 24 * 365)

      const signedUrl = urlData?.signedUrl || null

      // Determine file type
      const ext = uploadFile.name.split('.').pop()?.toLowerCase() || ''
      const fileType = ext === 'pdf' ? 'pdf'
        : ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? 'image'
        : ['doc', 'docx'].includes(ext) ? 'doc'
        : 'file'

      // Get vendor info if linked
      const linkedVendor = vendors.find(v => v.id === uploadVendorId)

      // Create contract record
      const res = await fetch('/api/couple/contracts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: uploadFile.name,
          fileType,
          storagePath,
          fileUrl: signedUrl,
          vendorId: uploadVendorId || undefined,
          vendorName: linkedVendor?.vendor_name || undefined,
        }),
      })

      const data = await res.json()

      if (data.error) throw new Error(data.error)

      setShowUpload(false)
      setUploadFile(null)
      setUploadVendorId('')
      fetchContracts()

      // Auto-trigger analysis for images
      if (fileType === 'image' && data.contract?.id) {
        const reader = new FileReader()
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1]
          const mimeMap: Record<string, string> = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
          }
          handleAnalyze(data.contract.id, base64, mimeMap[ext] || 'image/jpeg')
        }
        reader.readAsDataURL(uploadFile)
      }
    } catch (err) {
      console.error('Upload failed:', err)
      setError('Failed to upload file. Please try again.')
    } finally {
      setUploading(false)
    }
  }

  // ---- Analyze contract with AI ----
  async function handleAnalyze(contractId: string, imageBase64?: string, mediaType?: string) {
    setAnalyzingId(contractId)

    try {
      const res = await fetch('/api/couple/contracts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'analyze',
          contractId,
          imageBase64,
          mediaType,
        }),
      })

      const data = await res.json()

      if (data.error) {
        console.error('Analysis error:', data.error)
        setError(`Analysis failed: ${data.error}`)
      }

      fetchContracts()
    } catch (err) {
      console.error('Analysis failed:', err)
      setError('AI analysis failed. Please try again.')
    } finally {
      setAnalyzingId(null)
    }
  }

  // ---- Delete contract ----
  async function handleDelete(contractId: string) {
    if (!confirm('Delete this contract? This cannot be undone.')) return

    try {
      const res = await fetch('/api/couple/contracts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contractId }),
      })

      const data = await res.json()
      if (data.error) throw new Error(data.error)

      fetchContracts()
    } catch (err) {
      console.error('Delete failed:', err)
      setError('Failed to delete contract.')
    }
  }

  // ---- Drag & drop ----
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

    const files = e.dataTransfer.files
    if (files.length > 0) {
      setUploadFile(files[0])
      setUploadVendorId('')
      setShowUpload(true)
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) {
      setUploadFile(file)
      setUploadVendorId('')
      setShowUpload(true)
    }
    e.target.value = ''
  }

  // ---- Filtered contracts ----
  const filteredContracts = searchQuery.trim()
    ? contracts.filter(c => {
        const q = searchQuery.toLowerCase()
        return (
          c.filename.toLowerCase().includes(q) ||
          (c.vendor_name?.toLowerCase().includes(q) ?? false) ||
          (c.analysis?.toLowerCase().includes(q) ?? false)
        )
      })
    : contracts

  // ---- Stats ----
  const totalContracts = contracts.length
  const analyzedCount = contracts.filter(c => c.analyzed_at).length
  const unanalyzedCount = totalContracts - analyzedCount

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
            Upload vendor contracts and let AI extract the important details.
          </p>
        </div>
        <button
          onClick={() => {
            setUploadFile(null)
            setUploadVendorId('')
            setShowUpload(true)
          }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Upload Contract
        </button>
      </div>

      {/* Stats */}
      {totalContracts > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
              {totalContracts}
            </p>
            <p className="text-xs text-gray-500 font-medium">Documents</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums text-emerald-600">
              {analyzedCount}
            </p>
            <p className="text-xs text-gray-500 font-medium">Analyzed</p>
          </div>
          <div className="bg-white rounded-xl p-4 border border-gray-100 shadow-sm text-center">
            <p className="text-2xl font-bold tabular-nums text-amber-500">
              {unanalyzedCount}
            </p>
            <p className="text-xs text-gray-500 font-medium">Pending</p>
          </div>
        </div>
      )}

      {/* Drag & drop upload zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          'border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all',
          dragOver
            ? 'border-current bg-opacity-5'
            : 'border-gray-200 hover:border-gray-300 bg-white'
        )}
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
          onChange={handleFileSelect}
        />
        <Upload
          className="w-8 h-8 mx-auto mb-3"
          style={{ color: dragOver ? 'var(--couple-primary)' : '#9ca3af' }}
        />
        <p className="text-sm text-gray-600 font-medium">
          Drop files here or click to upload
        </p>
        <p className="text-xs text-gray-400 mt-1">
          PDF, images, or documents. AI will extract and analyze the content.
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Search (when contracts exist) */}
      {totalContracts > 3 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search contracts by name, vendor, or content..."
            className="w-full pl-9 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent bg-white"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
          />
        </div>
      )}

      {/* Contract list */}
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
      ) : filteredContracts.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <FileText
            className="w-12 h-12 mx-auto mb-4"
            style={{ color: 'var(--couple-primary)', opacity: 0.3 }}
          />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            {searchQuery ? 'No matching contracts' : 'No contracts yet'}
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            {searchQuery
              ? `No contracts match "${searchQuery}".`
              : 'Upload vendor contracts to keep everything in one place and let AI highlight the important terms.'}
          </p>
          {!searchQuery && (
            <button
              onClick={() => {
                setUploadFile(null)
                setUploadVendorId('')
                setShowUpload(true)
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Plus className="w-4 h-4" />
              Upload First Contract
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredContracts.map((contract) => (
            <ContractCard
              key={contract.id}
              contract={contract}
              onAnalyze={handleAnalyze}
              onDelete={handleDelete}
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
            onClick={() => { setShowUpload(false); setUploadFile(null) }}
          />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                Upload Contract
              </h2>
              <button
                onClick={() => { setShowUpload(false); setUploadFile(null) }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              {/* File selection */}
              {!uploadFile ? (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center cursor-pointer hover:border-gray-300 transition-colors"
                >
                  <Upload className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                  <p className="text-sm text-gray-500 font-medium">Click to select a file</p>
                  <p className="text-xs text-gray-400 mt-1">PDF, images, or documents</p>
                </div>
              ) : (
                <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  {(() => {
                    const ext = uploadFile.name.split('.').pop()?.toLowerCase() || ''
                    const ft = ext === 'pdf' ? 'pdf' : ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? 'image' : 'doc'
                    const cfg = fileTypeConfig(ft)
                    const Icon = cfg.icon
                    return (
                      <div className={cn('p-2 rounded-lg border', cfg.className)}>
                        <Icon className="w-4 h-4" />
                      </div>
                    )
                  })()}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{uploadFile.name}</p>
                    <p className="text-xs text-gray-400">
                      {(uploadFile.size / 1024 / 1024).toFixed(1)} MB
                    </p>
                  </div>
                  <button
                    onClick={() => setUploadFile(null)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {/* Link to vendor */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Link to Vendor (optional)
                </label>
                <select
                  value={uploadVendorId}
                  onChange={(e) => setUploadVendorId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent bg-white text-gray-900"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                >
                  <option value="">No vendor (standalone upload)</option>
                  {vendors.map(v => (
                    <option key={v.id} value={v.id}>
                      {v.vendor_name || v.vendor_type}
                      {v.is_booked ? ' (Booked)' : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-400 mt-1">
                  Link this contract to a vendor from your vendor list.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => { setShowUpload(false); setUploadFile(null) }}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                disabled={!uploadFile || uploading}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {uploading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" />
                    Upload & Analyze
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
