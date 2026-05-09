'use client'

// ---------------------------------------------------------------------------
// Couple portal Resources page
// ---------------------------------------------------------------------------
// Surfaces venue brand_assets where couple_facing = true, grouped by
// couple_category. Coordinator uploads watercolors, sketches, floor plans,
// favor templates, programs etc. via Settings. Couples download from here
// for their stationery, favors, programs, and planning.
//
// Migration 243 added couple_facing + couple_category + caption +
// file_size_bytes + mime_type. The page reads brand_assets directly via
// the new couple_read_brand_assets RLS policy that gates on
// people.user_id = auth.uid() and venue_id matching the couple's wedding.
//
// Download flow:
//   - venue-assets bucket URLs - generate a 1-hour signed URL on click
//     so private buckets work even if the asset is not in a public bucket.
//   - external URLs (legacy URL-paste rows) - open in a new tab with
//     download semantics.
//
// Empty-state copy: "Your venue hasn't shared any resources yet."
// ---------------------------------------------------------------------------

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import {
  FileDown,
  FileText,
  ImageIcon,
  Loader2,
  Download,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BrandAssetRow {
  id: string
  venue_id: string
  asset_type: string
  label: string
  url: string
  caption: string | null
  category: string | null
  couple_category: string | null
  couple_facing: boolean
  sage_eligible: boolean | null
  file_size_bytes: number | null
  mime_type: string | null
  sort_order: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Couple-facing groups, in display order. Each row's couple_category
// drives which group it lands in. Anything missing or unrecognised falls
// into "Other".
const COUPLE_CATEGORY_GROUPS: { value: string; label: string; description: string }[] = [
  { value: 'favors',   label: 'Favors',   description: 'Tags, labels, and inserts for guest favors' },
  { value: 'programs', label: 'Programs', description: 'Ceremony programs and printable inserts' },
  { value: 'decor',    label: 'Decor',    description: 'Watercolors, motifs, and decorative artwork' },
  { value: 'planning', label: 'Planning', description: 'Floor plans, layouts, and reference sheets' },
  { value: 'other',    label: 'Other',    description: 'Everything else your venue has shared' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number | null): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isPdfAsset(asset: BrandAssetRow): boolean {
  if (asset.mime_type === 'application/pdf') return true
  return asset.url.toLowerCase().split('?')[0].endsWith('.pdf')
}

function isImageAsset(asset: BrandAssetRow): boolean {
  if (asset.mime_type?.startsWith('image/')) return true
  const lower = asset.url.toLowerCase().split('?')[0]
  return /\.(png|jpg|jpeg|webp|svg|gif)$/i.test(lower)
}

// Recognise URLs hosted in our own venue-assets Supabase Storage bucket.
// We extract the path-after-bucket so we can mint a signed URL on click.
// Public-URL shape:
//   {SUPABASE_URL}/storage/v1/object/public/venue-assets/{path}
// Sign-URL shape (legacy):
//   {SUPABASE_URL}/storage/v1/object/sign/venue-assets/{path}?token=...
function extractVenueAssetsPath(url: string): string | null {
  const m = url.match(/\/storage\/v1\/object\/(?:public|sign)\/venue-assets\/([^?#]+)/)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return m[1]
  }
}

// ---------------------------------------------------------------------------
// Asset card
// ---------------------------------------------------------------------------

function AssetCard({ asset, onDownload }: { asset: BrandAssetRow; onDownload: (a: BrandAssetRow) => Promise<void> }) {
  const [downloading, setDownloading] = useState(false)
  const isPdf = isPdfAsset(asset)
  const isImage = isImageAsset(asset)
  const filename = asset.label || asset.url.split('/').pop() || 'asset'

  async function handleClick() {
    setDownloading(true)
    try {
      await onDownload(asset)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
      {/* Thumbnail */}
      <div className="aspect-[4/3] bg-gray-50 flex items-center justify-center overflow-hidden">
        {isImage ? (
          <img
            src={asset.url}
            alt={asset.label}
            className="w-full h-full object-cover"
            onError={(e) => {
              const t = e.target as HTMLImageElement
              t.style.display = 'none'
            }}
          />
        ) : isPdf ? (
          <div className="flex flex-col items-center gap-2 text-gray-400">
            <FileText className="w-14 h-14" />
            <span className="text-xs font-semibold uppercase">PDF</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-gray-300">
            <ImageIcon className="w-14 h-14" />
            <span className="text-xs font-semibold uppercase">File</span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-4 flex-1 flex flex-col">
        <h3
          className="text-sm font-semibold mb-1"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          {asset.label}
        </h3>
        {asset.caption && (
          <p className="text-sm text-gray-500 leading-relaxed line-clamp-2 mb-3">
            {asset.caption}
          </p>
        )}

        <div className="flex items-center gap-2 mt-auto mb-3">
          {asset.mime_type && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-100 text-gray-500 uppercase">
              {isPdf ? 'PDF' : isImage ? 'IMAGE' : 'FILE'}
            </span>
          )}
          {asset.file_size_bytes && asset.file_size_bytes > 0 && (
            <span className="text-[11px] text-gray-400">{formatBytes(asset.file_size_bytes)}</span>
          )}
        </div>

        <button
          onClick={handleClick}
          disabled={downloading}
          aria-label={`Download ${filename}`}
          className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-60"
          style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
        >
          {downloading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Preparing...
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              Download
            </>
          )}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ResourcesPage() {
  const { venueId, loading: contextLoading } = useCoupleContext()
  const [assets, setAssets] = useState<BrandAssetRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const supabase = createClient()

  // ---- Fetch couple-facing brand assets ----
  useEffect(() => {
    if (contextLoading || !venueId) return
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      const { data, error: fetchErr } = await supabase
        .from('brand_assets')
        .select('id, venue_id, asset_type, label, url, caption, category, couple_category, couple_facing, sage_eligible, file_size_bytes, mime_type, sort_order')
        .eq('venue_id', venueId!)
        .eq('couple_facing', true)
        .order('sort_order', { ascending: true })
        .order('label', { ascending: true })
      if (cancelled) return
      if (fetchErr) {
        console.error('[resources] failed to load brand assets:', fetchErr)
        setError('We could not load your venue resources.')
      } else {
        setAssets((data ?? []) as BrandAssetRow[])
      }
      setLoading(false)
    }
    void load()
    return () => { cancelled = true }
  }, [venueId, contextLoading, supabase])

  // ---- Download click handler. Signed URL for our bucket, link for external. ----
  const handleDownload = useCallback(async (asset: BrandAssetRow) => {
    const internalPath = extractVenueAssetsPath(asset.url)
    if (internalPath) {
      const { data, error: signErr } = await supabase.storage
        .from('venue-assets')
        .createSignedUrl(internalPath, 3600)
      if (!signErr && data?.signedUrl) {
        window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
        return
      }
      console.error('[resources] sign url failed, falling back to public url:', signErr)
    }
    // External URL or sign failure - just open in a new tab. The browser
    // download attribute is best-effort; cross-origin servers can opt out.
    window.open(asset.url, '_blank', 'noopener,noreferrer')
  }, [supabase])

  // ---- Group assets by couple_category ----
  const groups = (() => {
    const map = new Map<string, BrandAssetRow[]>()
    for (const asset of assets) {
      const key = (asset.couple_category && COUPLE_CATEGORY_GROUPS.some((g) => g.value === asset.couple_category))
        ? asset.couple_category
        : 'other'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(asset)
    }
    return COUPLE_CATEGORY_GROUPS
      .map((g) => ({ ...g, items: map.get(g.value) ?? [] }))
      .filter((g) => g.items.length > 0)
  })()

  // ---- Loading state ----
  if (contextLoading || !venueId || loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--couple-primary)' }} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <FileDown className="w-6 h-6" style={{ color: 'var(--couple-primary)' }} />
          <h1
            className="text-3xl font-bold"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Resources
          </h1>
        </div>
        <p className="text-gray-500 text-sm">
          Watercolors, floor plans, and templates your venue has shared. Use them for your favors, programs, and planning.
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-100 text-red-700 text-sm px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Empty state */}
      {assets.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <FileDown
            className="w-12 h-12 mx-auto mb-4"
            style={{ color: 'var(--couple-primary)', opacity: 0.3 }}
          />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Nothing here yet
          </h3>
          <p className="text-gray-500 text-sm">
            Your venue hasn&apos;t shared any resources yet.
          </p>
        </div>
      ) : (
        <div className="space-y-10">
          {groups.map((group) => (
            <section key={group.value}>
              <div className="mb-3">
                <h2
                  className="text-xl font-semibold"
                  style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
                >
                  {group.label}
                  <span className="text-xs font-normal text-gray-400 ml-2">
                    ({group.items.length})
                  </span>
                </h2>
                <p className="text-xs text-gray-400">{group.description}</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {group.items.map((asset) => (
                  <AssetCard key={asset.id} asset={asset} onDownload={handleDownload} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
