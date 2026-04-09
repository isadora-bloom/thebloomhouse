'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { cn } from '@/lib/utils'
import {
  Download,
  FileText,
  FileImage,
  File,
  ArrowDownToLine,
} from 'lucide-react'

// TODO: Get from auth session / couple context
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VenueAsset {
  id: string
  venue_id: string
  title: string
  description: string | null
  file_name: string
  storage_path: string
  file_type: string | null
  file_size: number | null
  sort_order: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFileUrl(storagePath: string): string {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/venue-assets/${storagePath}`
}

function isImageType(fileType: string | null): boolean {
  if (!fileType) return false
  const imageTypes = ['jpg', 'jpeg', 'png', 'webp', 'svg', 'gif', 'bmp']
  return imageTypes.includes(fileType.toLowerCase())
}

function isPdfType(fileType: string | null): boolean {
  if (!fileType) return false
  return fileType.toLowerCase() === 'pdf'
}

function formatFileSize(bytes: number | null): string {
  if (!bytes || bytes === 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileTypeLabel(fileType: string | null): string {
  if (!fileType) return 'File'
  const ft = fileType.toUpperCase()
  if (ft === 'JPEG') return 'JPG'
  return ft
}

// ---------------------------------------------------------------------------
// AssetCard
// ---------------------------------------------------------------------------

function AssetCard({ asset }: { asset: VenueAsset }) {
  const fileUrl = getFileUrl(asset.storage_path)
  const isImage = isImageType(asset.file_type)
  const isPdf = isPdfType(asset.file_type)

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
      {/* Thumbnail area */}
      <div className="aspect-[4/3] bg-gray-50 flex items-center justify-center overflow-hidden">
        {isImage ? (
          <img
            src={fileUrl}
            alt={asset.title}
            className="w-full h-full object-cover"
          />
        ) : isPdf ? (
          <div className="flex flex-col items-center gap-2">
            <FileText className="w-16 h-16 text-red-400" />
            <span className="text-xs font-medium text-gray-400 uppercase">PDF</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <File className="w-16 h-16 text-gray-300" />
            <span className="text-xs font-medium text-gray-400 uppercase">
              {getFileTypeLabel(asset.file_type)}
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-4 flex-1 flex flex-col">
        <h3
          className="text-sm font-medium mb-1"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          {asset.title}
        </h3>

        {asset.description && (
          <p className="text-sm text-gray-500 line-clamp-2 leading-relaxed mb-3">
            {asset.description}
          </p>
        )}

        {/* File info line */}
        <div className="flex items-center gap-2 mb-4 mt-auto">
          {asset.file_type && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-500 uppercase">
              {getFileTypeLabel(asset.file_type)}
            </span>
          )}
          {asset.file_size && asset.file_size > 0 && (
            <span className="text-[11px] text-gray-400">
              {formatFileSize(asset.file_size)}
            </span>
          )}
        </div>

        {/* Download button */}
        <a
          href={fileUrl}
          target="_blank"
          rel="noopener noreferrer"
          download={asset.file_name}
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg text-sm font-medium text-white transition-colors hover:opacity-90"
          style={{ backgroundColor: '#7D8471' }}
        >
          <ArrowDownToLine className="w-4 h-4" />
          Download
        </a>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DownloadsPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [assets, setAssets] = useState<VenueAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [activeFilter, setActiveFilter] = useState<string>('all')

  const supabase = createClient()

  // ---- Fetch assets ----
  const fetchAssets = useCallback(async () => {
    const { data, error } = await supabase
      .from('venue_assets')
      .select('*')
      .eq('venue_id', venueId)
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true })

    if (!error && data) {
      setAssets(data as VenueAsset[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchAssets()
  }, [fetchAssets])

  // ---- Derived data ----
  const fileTypes = Array.from(
    new Set(assets.map((a) => a.file_type?.toLowerCase() || 'other'))
  ).sort()

  const filteredAssets = assets.filter((a) => {
    if (activeFilter === 'all') return true
    const ft = a.file_type?.toLowerCase() || 'other'
    if (activeFilter === 'images') {
      return isImageType(a.file_type)
    }
    if (activeFilter === 'documents') {
      return isPdfType(a.file_type) || ['doc', 'docx', 'txt', 'rtf'].includes(ft)
    }
    return ft === activeFilter
  })

  const totalSize = assets.reduce((sum, a) => sum + (a.file_size || 0), 0)
  const hasImages = assets.some((a) => isImageType(a.file_type))
  const hasDocs = assets.some((a) => isPdfType(a.file_type) || ['doc', 'docx', 'txt', 'rtf'].includes(a.file_type?.toLowerCase() || ''))

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Download className="w-6 h-6" style={{ color: 'var(--couple-primary)' }} />
          <h1
            className="text-3xl font-bold"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Downloads
          </h1>
        </div>
        <p className="text-gray-500 text-sm">
          Venue logos, sketches, and assets for your stationery and website
        </p>
      </div>

      {/* Summary bar */}
      {!loading && assets.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-gray-400">
            {assets.length} file{assets.length !== 1 ? 's' : ''} available
            {totalSize > 0 && (
              <span className="ml-1">({formatFileSize(totalSize)} total)</span>
            )}
          </p>
        </div>
      )}

      {/* File type filter */}
      {!loading && assets.length > 0 && (hasImages || hasDocs || fileTypes.length > 1) && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setActiveFilter('all')}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-full transition-colors',
              activeFilter === 'all'
                ? 'text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            )}
            style={activeFilter === 'all' ? { backgroundColor: '#7D8471' } : undefined}
          >
            All ({assets.length})
          </button>
          {hasImages && (
            <button
              onClick={() => setActiveFilter('images')}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-full transition-colors',
                activeFilter === 'images'
                  ? 'text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              )}
              style={activeFilter === 'images' ? { backgroundColor: '#5D7A7A' } : undefined}
            >
              <span className="inline-flex items-center gap-1">
                <FileImage className="w-3 h-3" />
                Images
              </span>
            </button>
          )}
          {hasDocs && (
            <button
              onClick={() => setActiveFilter('documents')}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-full transition-colors',
                activeFilter === 'documents'
                  ? 'text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              )}
              style={activeFilter === 'documents' ? { backgroundColor: '#A6894A' } : undefined}
            >
              <span className="inline-flex items-center gap-1">
                <FileText className="w-3 h-3" />
                Documents
              </span>
            </button>
          )}
        </div>
      )}

      {/* Asset Grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-gray-100 rounded-xl animate-pulse" style={{ height: 320 }} />
          ))}
        </div>
      ) : assets.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Download
            className="w-12 h-12 mx-auto mb-4"
            style={{ color: 'var(--couple-primary)', opacity: 0.3 }}
          />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No downloads available yet
          </h3>
          <p className="text-gray-500 text-sm">
            Your venue hasn&apos;t uploaded any assets yet.
          </p>
        </div>
      ) : filteredAssets.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-xl border border-gray-100 shadow-sm">
          <File
            className="w-10 h-10 mx-auto mb-3"
            style={{ color: 'var(--couple-primary)', opacity: 0.3 }}
          />
          <h3
            className="text-base font-semibold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No matching files
          </h3>
          <p className="text-gray-500 text-sm mb-3">
            No files match the selected filter.
          </p>
          <button
            onClick={() => setActiveFilter('all')}
            className="text-xs font-medium transition-colors"
            style={{ color: 'var(--couple-primary)' }}
          >
            Show all files
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredAssets.map((asset) => (
            <AssetCard key={asset.id} asset={asset} />
          ))}
        </div>
      )}

      {/* Usage tips */}
      {!loading && assets.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <p className="text-xs text-gray-400 text-center">
            Use these assets for your stationery, wedding website, signage, and social media.
            Right-click and save, or use the download button on each card.
          </p>
        </div>
      )}
    </div>
  )
}
