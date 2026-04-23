'use client'

/**
 * Portal → Venue Assets
 *
 * Coordinator editor for venue_assets — brochures, floor plans, policy PDFs,
 * photo packs the couple portal surfaces as downloadable resources. Uses
 * the `venue-assets` Supabase Storage bucket; files are stored at
 * `{venue_id}/{uuid}-{filename}` so RLS on the bucket can enforce venue
 * scope.
 */

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { FileText, Upload, Trash2, Loader2, Download, Save } from 'lucide-react'

interface Asset {
  id: string
  title: string
  description: string | null
  file_name: string
  storage_path: string
  file_type: string | null
  file_size: number | null
  sort_order: number
  created_at: string
  signedUrl?: string
}

const BUCKET = 'venue-assets'

function humanSize(bytes: number | null): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function VenueAssetsConfigPage() {
  const venueId = useVenueId()
  const [venueName, setVenueName] = useState('')
  const [assets, setAssets] = useState<Asset[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [descDraft, setDescDraft] = useState('')
  const [fileDraft, setFileDraft] = useState<File | null>(null)

  const load = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    const supabase = createClient()
    const [{ data: rows }, { data: cfg }] = await Promise.all([
      supabase
        .from('venue_assets')
        .select('*')
        .eq('venue_id', venueId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false }),
      supabase
        .from('venue_config')
        .select('business_name')
        .eq('venue_id', venueId)
        .maybeSingle(),
    ])
    setVenueName((cfg?.business_name as string) || '')
    // Generate signed URLs so the coordinator can preview / download their
    // own uploads. 1-hour expiry is plenty for the edit-UI use case.
    const withUrls = await Promise.all(
      (rows ?? []).map(async (r) => {
        const row = r as unknown as Asset
        const { data: signed } = await supabase.storage
          .from(BUCKET)
          .createSignedUrl(row.storage_path, 3600)
        return { ...row, signedUrl: signed?.signedUrl }
      })
    )
    setAssets(withUrls)
    setLoading(false)
  }, [venueId])

  useEffect(() => {
    load()
  }, [load])

  async function handleUpload() {
    if (!venueId || !fileDraft || !titleDraft.trim()) {
      setError('Title + file are required.')
      return
    }
    setUploading(true)
    setError(null)
    const supabase = createClient()
    try {
      // Scope the path to the venue so a future bucket policy can enforce
      // that users only access their own venue's objects.
      const safeName = fileDraft.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `${venueId}/${crypto.randomUUID()}-${safeName}`
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, fileDraft, { contentType: fileDraft.type || undefined })
      if (upErr) throw upErr

      const { error: insErr } = await supabase.from('venue_assets').insert({
        venue_id: venueId,
        title: titleDraft.trim(),
        description: descDraft.trim() || null,
        file_name: fileDraft.name,
        storage_path: path,
        file_type: fileDraft.type || null,
        file_size: fileDraft.size,
        sort_order: assets.length,
      })
      if (insErr) throw insErr

      setTitleDraft('')
      setDescDraft('')
      setFileDraft(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function remove(asset: Asset) {
    if (!venueId) return
    if (!confirm(`Remove ${asset.title}? The file will be deleted from storage.`)) return
    const supabase = createClient()
    // Delete the DB row first (readers see the asset as gone); then the
    // storage object. If storage deletion fails we surface it — the file
    // is orphaned but the portal stops listing it, which is the safer of
    // the two half-states.
    const { error: delDbErr } = await supabase
      .from('venue_assets')
      .delete()
      .eq('id', asset.id)
    if (delDbErr) {
      setError(delDbErr.message)
      return
    }
    const { error: delStoErr } = await supabase.storage
      .from(BUCKET)
      .remove([asset.storage_path])
    if (delStoErr) {
      setError(`DB row removed, but storage object cleanup failed: ${delStoErr.message}`)
    }
    await load()
  }

  async function updateMeta(asset: Asset, patch: { title?: string; description?: string | null }) {
    const supabase = createClient()
    const { error: upErr } = await supabase
      .from('venue_assets')
      .update(patch)
      .eq('id', asset.id)
    if (upErr) {
      setError(upErr.message)
      return
    }
    setAssets((prev) => prev.map((a) => (a.id === asset.id ? { ...a, ...patch } : a)))
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold text-sage-900 flex items-center gap-2">
          <FileText className="w-6 h-6 text-sage-600" />
          {venueName ? `${venueName} · Resources` : 'Venue Assets'}
        </h1>
        <p className="text-sm text-sage-600 mt-1">
          Brochures, floor plans, preferred-vendor lists, policy PDFs — the
          documents couples download from their portal.
        </p>
      </div>

      {/* Upload */}
      <section className="bg-white border border-sage-200 rounded-xl p-4 space-y-3">
        <h2 className="font-medium text-sage-900 flex items-center gap-2">
          <Upload className="w-4 h-4" /> Upload new asset
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder="Title (e.g. 2026 Wedding Brochure)"
            className="px-3 py-2 border border-sage-200 rounded text-sm"
          />
          <input
            type="file"
            onChange={(e) => setFileDraft(e.target.files?.[0] ?? null)}
            className="px-3 py-2 border border-sage-200 rounded text-sm"
          />
        </div>
        <textarea
          value={descDraft}
          onChange={(e) => setDescDraft(e.target.value)}
          rows={2}
          placeholder="Description (optional)"
          className="w-full px-3 py-2 border border-sage-200 rounded text-sm"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleUpload}
            disabled={uploading || !fileDraft || !titleDraft.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 disabled:opacity-50"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
          {error && <span className="text-sm text-rose-600">{error}</span>}
        </div>
      </section>

      {/* List */}
      <section className="space-y-3">
        <h2 className="font-medium text-sage-900">Current assets</h2>
        {loading ? (
          <p className="text-sm text-sage-500 italic">Loading…</p>
        ) : assets.length === 0 ? (
          <p className="text-sm text-sage-500 italic">No assets yet.</p>
        ) : (
          <div className="space-y-2">
            {assets.map((a) => (
              <div
                key={a.id}
                className="bg-white border border-sage-200 rounded-lg p-3 flex items-center gap-3"
              >
                <FileText className="w-5 h-5 text-sage-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <input
                    type="text"
                    value={a.title}
                    onChange={(e) => setAssets((p) => p.map((x) => x.id === a.id ? { ...x, title: e.target.value } : x))}
                    onBlur={(e) => updateMeta(a, { title: e.target.value })}
                    className="w-full px-2 py-1 text-sm font-medium text-sage-900 border border-transparent hover:border-sage-200 rounded bg-transparent"
                  />
                  <div className="text-xs text-sage-500 flex items-center gap-2 px-2">
                    <span className="truncate font-mono">{a.file_name}</span>
                    {a.file_size && <span>· {humanSize(a.file_size)}</span>}
                    {a.file_type && <span>· {a.file_type}</span>}
                  </div>
                </div>
                {a.signedUrl && (
                  <a
                    href={a.signedUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="p-2 text-sage-600 hover:bg-sage-100 rounded"
                    title="Open"
                  >
                    <Download className="w-4 h-4" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => remove(a)}
                  className="p-2 text-rose-600 hover:bg-rose-50 rounded"
                  title="Remove"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
