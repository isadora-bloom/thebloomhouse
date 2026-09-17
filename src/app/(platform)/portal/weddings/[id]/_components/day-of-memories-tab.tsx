'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { ArrowDown, ArrowUp, Camera, Film, MessageSquare, Trash2, Upload, Loader2, ExternalLink } from 'lucide-react'
import { safeHref } from '@/lib/utils/safe-url'

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
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [reordering, setReordering] = useState<string | null>(null)
  const [captionDrafts, setCaptionDrafts] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    const supabase = createClient()
    const { data, error: loadErr } = await supabase
      .from('day_of_media')
      .select('id, category, url, storage_path, filename, mime_type, size_bytes, caption, sort_order, created_at')
      .eq('wedding_id', weddingId)
      // sort_order was written at insert and never read, so the arrange
      // buttons below had no effect on anything. Explicit order first,
      // upload time as the tiebreak.
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })

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

  /**
   * Upload a whole selection, one file at a time, and keep going when one
   * of them fails.
   *
   * This took a single file per click. A coordinator with forty photos
   * from the day clicked forty times, and the moment one file was too big
   * or the connection dropped, the message replaced whatever the last one
   * said. Each file now stands or falls on its own and the failures are
   * named at the end, because "3 of 40 failed" is only useful if you know
   * which three.
   */
  async function handleUpload(category: Category, files: File[]) {
    if (files.length === 0) return
    setUploading(category)
    setError(null)
    setProgress({ done: 0, total: files.length })

    const supabase = createClient()
    // Carry on from the highest order in play, so a new batch lands after
    // whatever is already arranged rather than on top of it.
    let nextOrder = items.reduce((max, item) => Math.max(max, item.sort_order ?? 0), -1) + 1
    const failures: string[] = []

    for (const [index, file] of files.entries()) {
      try {
        if (file.size > 200 * 1024 * 1024) {
          throw new Error('over the 200 MB limit')
        }
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
          sort_order: nextOrder,
        })
        if (insErr) throw insErr
        nextOrder++
      } catch (err) {
        failures.push(`${file.name} (${err instanceof Error ? err.message : 'failed'})`)
      } finally {
        setProgress({ done: index + 1, total: files.length })
      }
    }

    if (failures.length > 0) {
      const succeeded = files.length - failures.length
      setError(
        `${succeeded} of ${files.length} uploaded. These did not: ${failures.join('; ')}.`
      )
    }

    await load()
    setProgress(null)
    setUploading(null)
  }

  async function move(item: DayOfMediaRow, direction: -1 | 1) {
    const index = items.findIndex((i) => i.id === item.id)
    const swapWith = items[index + direction]
    if (!swapWith) return

    // Write both rows' positions from their on-screen index, so a set of
    // legacy rows that all share sort_order 0 still separates cleanly.
    const supabase = createClient()
    setReordering(item.id)
    const updates = items.map((row, i) => {
      if (i === index) return { id: row.id, sort_order: index + direction }
      if (i === index + direction) return { id: row.id, sort_order: index }
      return { id: row.id, sort_order: i }
    })
    for (const u of updates) {
      const { error: updErr } = await supabase
        .from('day_of_media')
        .update({ sort_order: u.sort_order })
        .eq('id', u.id)
      if (updErr) {
        setError(`Could not reorder: ${updErr.message}`)
        break
      }
    }
    await load()
    setReordering(null)
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
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />{' '}
                    {progress && progress.total > 1
                      ? `Uploading ${progress.done} of ${progress.total}…`
                      : 'Uploading…'}
                  </>
                ) : (
                  <>
                    <Upload className="w-3.5 h-3.5" /> Click or drop files
                  </>
                )}
              </div>
              <input
                type="file"
                accept={ACCEPT_BY_CATEGORY[cat]}
                multiple
                className="hidden"
                disabled={!!uploading}
                onChange={(e) => {
                  const chosen = Array.from(e.target.files ?? [])
                  if (chosen.length > 0) handleUpload(cat, chosen)
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
            {items.map((item, index) => {
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
                      {/* Arrange. This is the order the couple sees. */}
                      <span className="ml-auto flex items-center gap-0.5">
                        <button
                          onClick={() => move(item, -1)}
                          disabled={index === 0 || reordering !== null}
                          className="p-1 rounded hover:bg-sage-50 disabled:opacity-30 disabled:hover:bg-transparent"
                          title="Move earlier"
                          aria-label="Move earlier"
                        >
                          <ArrowUp className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => move(item, 1)}
                          disabled={index === items.length - 1 || reordering !== null}
                          className="p-1 rounded hover:bg-sage-50 disabled:opacity-30 disabled:hover:bg-transparent"
                          title="Move later"
                          aria-label="Move later"
                        >
                          <ArrowDown className="w-3 h-3" />
                        </button>
                      </span>
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
                        href={safeHref(item.url)}
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

