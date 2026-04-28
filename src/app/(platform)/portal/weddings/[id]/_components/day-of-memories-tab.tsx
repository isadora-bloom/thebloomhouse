'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Camera, Film, MessageSquare, Trash2, Upload, Loader2, ExternalLink } from 'lucide-react'

const BUCKET = 'day-of-media'

type Category = 'photo' | 'video' | 'video_message'

interface DayOfMediaRow {
  id: string
  category: Category
  url: string
  storage_path: string | null
  filename: string | null
  mime_type: string | null
  size_bytes: number | null
  caption: string | null
  sort_order: number
  created_at: string
}

interface Props {
  weddingId: string
  venueId: string
}

const ACCEPT_BY_CATEGORY: Record<Category, string> = {
  photo: 'image/*',
  video: 'video/*',
  video_message: 'video/*',
}

const CATEGORY_META: Record<Category, { label: string; icon: React.ComponentType<{ className?: string }>; helper: string }> = {
  photo: { label: 'Photos', icon: Camera, helper: 'Drop photos from the wedding day for the couple to keep.' },
  video: { label: 'Video', icon: Film, helper: 'Add reels, montages, or footage from the day.' },
  video_message: { label: 'Video messages', icon: MessageSquare, helper: 'Personal messages recorded by family or friends.' },
}

function publicUrl(path: string) {
  // The day-of-media bucket is public — Supabase composes the URL deterministically.
  // Using SUPABASE_URL keeps this server/browser parity (same path either side).
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) return path
  return `${base}/storage/v1/object/public/${BUCKET}/${path}`
}

function formatBytes(n: number | null) {
  if (!n) return ''
  const mb = n / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}

export function DayOfMemoriesTab({ weddingId, venueId }: Props) {
  const [items, setItems] = useState<DayOfMediaRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState<Category | null>(null)
  const [captionDrafts, setCaptionDrafts] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data, error: loadErr } = await supabase
      .from('day_of_media')
      .select('id, category, url, storage_path, filename, mime_type, size_bytes, caption, sort_order, created_at')
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: false })

    if (loadErr) {
      setError(loadErr.message)
      setItems([])
    } else {
      setItems((data ?? []) as DayOfMediaRow[])
      setError(null)
    }
    setLoading(false)
  }, [weddingId])

  useEffect(() => {
    load()
  }, [load])

  async function handleUpload(category: Category, file: File) {
    if (!file) return
    if (file.size > 200 * 1024 * 1024) {
      setError('File too large (200 MB max).')
      return
    }
    setUploading(category)
    setError(null)
    const supabase = createClient()
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `${venueId}/${weddingId}/${crypto.randomUUID()}-${safeName}`
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { contentType: file.type || undefined, cacheControl: '3600' })
      if (upErr) throw upErr

      const { error: insErr } = await supabase.from('day_of_media').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        category,
        url: publicUrl(path),
        storage_path: path,
        filename: file.name,
        mime_type: file.type || null,
        size_bytes: file.size,
        sort_order: items.length,
      })
      if (insErr) throw insErr

      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setUploading(null)
    }
  }

  async function saveCaption(id: string) {
    const next = captionDrafts[id]
    if (next === undefined) return
    const supabase = createClient()
    const { error: updErr } = await supabase
      .from('day_of_media')
      .update({ caption: next.trim() || null })
      .eq('id', id)
    if (!updErr) {
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, caption: next.trim() || null } : it)))
      setCaptionDrafts((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }
  }

  async function remove(item: DayOfMediaRow) {
    if (!confirm('Remove this from the couple\'s day-of memories?')) return
    const supabase = createClient()
    // Delete row first; couple stops seeing it. If the storage delete trails,
    // we have an orphaned object — preferable to the inverse half-state.
    const { error: delDbErr } = await supabase.from('day_of_media').delete().eq('id', item.id)
    if (delDbErr) {
      setError(delDbErr.message)
      return
    }
    if (item.storage_path) {
      await supabase.storage.from(BUCKET).remove([item.storage_path])
    }
    setItems((prev) => prev.filter((it) => it.id !== item.id))
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sage-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading day-of memories…
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl bg-sage-50 border border-sage-100 p-4 text-sm text-sage-700">
        Upload photos, video, or recorded video messages from the wedding day. The couple will see these
        in their portal under <span className="font-medium">After the day → Day-of memories</span>.
      </div>

      {error && (
        <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(['photo', 'video', 'video_message'] as Category[]).map((cat) => {
          const meta = CATEGORY_META[cat]
          const Icon = meta.icon
          const isBusy = uploading === cat
          return (
            <label
              key={cat}
              className={cn(
                'flex flex-col gap-2 cursor-pointer rounded-xl border-2 border-dashed border-sage-200 p-4 transition-colors',
                isBusy ? 'bg-sage-50' : 'hover:border-sage-400 hover:bg-warm-white'
              )}
            >
              <div className="flex items-center gap-2 text-sage-700">
                <Icon className="w-4 h-4" />
                <span className="text-sm font-medium">{meta.label}</span>
              </div>
              <p className="text-xs text-sage-500">{meta.helper}</p>
              <div className="flex items-center gap-2 text-xs text-sage-600 mt-1">
                {isBusy ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploading…
                  </>
                ) : (
                  <>
                    <Upload className="w-3.5 h-3.5" /> Click or drop a file
                  </>
                )}
              </div>
              <input
                type="file"
                accept={ACCEPT_BY_CATEGORY[cat]}
                className="hidden"
                disabled={!!uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) handleUpload(cat, f)
                  e.currentTarget.value = ''
                }}
              />
            </label>
          )
        })}
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-sage-900">Uploaded</h3>
          <span className="text-xs text-sage-500">{items.length} item{items.length === 1 ? '' : 's'}</span>
        </div>

        {items.length === 0 ? (
          <div className="text-center py-12 text-sage-400 text-sm">
            Nothing yet. Upload photos, video, or messages above.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {items.map((item) => {
              const Icon = CATEGORY_META[item.category].icon
              const isImage = item.mime_type?.startsWith('image/')
              const draftCaption = captionDrafts[item.id]
              const captionValue = draftCaption !== undefined ? draftCaption : item.caption ?? ''
              return (
                <div
                  key={item.id}
                  className="rounded-xl border border-sage-100 bg-warm-white overflow-hidden flex flex-col"
                >
                  <div className="relative aspect-video bg-sage-50 flex items-center justify-center overflow-hidden">
                    {isImage ? (
                      // Plain <img> rather than next/image — bucket URLs are signed/dynamic
                      // and the file list is small, so optimization isn't worth the config.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.url} alt={item.caption ?? ''} className="w-full h-full object-cover" />
                    ) : (
                      <video src={item.url} controls preload="metadata" className="w-full h-full object-contain" />
                    )}
                  </div>
                  <div className="p-3 space-y-2 flex-1 flex flex-col">
                    <div className="flex items-center gap-2 text-xs text-sage-500">
                      <Icon className="w-3.5 h-3.5" />
                      <span>{CATEGORY_META[item.category].label}</span>
                      <span>·</span>
                      <span>{formatBytes(item.size_bytes)}</span>
                    </div>
                    <textarea
                      value={captionValue}
                      onChange={(e) =>
                        setCaptionDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))
                      }
                      onBlur={() => saveCaption(item.id)}
                      placeholder="Add a caption…"
                      className="w-full text-xs text-sage-700 placeholder:text-sage-400 bg-transparent border-none resize-none focus:outline-none"
                      rows={2}
                    />
                    <div className="flex items-center justify-between gap-2 mt-auto">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-sage-500 hover:text-sage-700"
                      >
                        <ExternalLink className="w-3 h-3" /> Open
                      </a>
                      <button
                        onClick={() => remove(item)}
                        className="inline-flex items-center gap-1 text-xs text-rose-500 hover:text-rose-700"
                      >
                        <Trash2 className="w-3 h-3" /> Remove
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

