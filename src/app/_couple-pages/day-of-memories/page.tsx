'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import { Camera, Film, MessageSquare, Loader2, Download } from 'lucide-react'

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
  created_at: string
}

const CATEGORY_META: Record<Category, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  photo: { label: 'Photo', icon: Camera },
  video: { label: 'Video', icon: Film },
  video_message: { label: 'Video message', icon: MessageSquare },
}

export default function DayOfMemoriesPage() {
  const { weddingId, loading: contextLoading } = useCoupleContext()
  const [items, setItems] = useState<DayOfMediaRow[]>([])
  const [loading, setLoading] = useState(true)
  const [activeCategory, setActiveCategory] = useState<Category | 'all'>('all')

  const load = useCallback(async () => {
    if (!weddingId) return
    setLoading(true)
    const supabase = createClient()
    const { data } = await supabase
      .from('day_of_media')
      .select('id, category, url, storage_path, filename, mime_type, size_bytes, caption, created_at')
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: false })
    setItems((data ?? []) as DayOfMediaRow[])
    setLoading(false)
  }, [weddingId])

  useEffect(() => {
    if (!contextLoading) load()
  }, [contextLoading, load])

  if (contextLoading || loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-sage-400">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading your day-of memories…
      </div>
    )
  }

  const filtered = activeCategory === 'all' ? items : items.filter((it) => it.category === activeCategory)
  const counts: Record<Category, number> = {
    photo: items.filter((i) => i.category === 'photo').length,
    video: items.filter((i) => i.category === 'video').length,
    video_message: items.filter((i) => i.category === 'video_message').length,
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <header>
        <h1 className="font-display text-3xl text-sage-900 mb-2">Day-of memories</h1>
        <p className="text-sage-600 text-sm">
          Photos, video, and messages your venue captured during the wedding day. Click any item to open
          it full-size or download.
        </p>
      </header>

      {items.length === 0 ? (
        <div className="rounded-2xl bg-warm-white border border-sage-100 p-10 text-center">
          <Camera className="w-8 h-8 mx-auto text-sage-300 mb-3" />
          <p className="text-sm text-sage-500">
            Nothing here yet. After the wedding, your venue will add photos and messages from the day.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <FilterChip
              label={`All (${items.length})`}
              active={activeCategory === 'all'}
              onClick={() => setActiveCategory('all')}
            />
            {(['photo', 'video', 'video_message'] as Category[]).map((cat) => {
              if (counts[cat] === 0) return null
              return (
                <FilterChip
                  key={cat}
                  label={`${CATEGORY_META[cat].label}s (${counts[cat]})`}
                  active={activeCategory === cat}
                  onClick={() => setActiveCategory(cat)}
                />
              )
            })}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((item) => (
              <MediaCard key={item.id} item={item} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? 'px-3 py-1.5 rounded-full text-xs font-medium bg-sage-700 text-white'
          : 'px-3 py-1.5 rounded-full text-xs font-medium bg-warm-white border border-sage-200 text-sage-700 hover:bg-sage-50'
      }
    >
      {label}
    </button>
  )
}

function MediaCard({ item }: { item: DayOfMediaRow }) {
  const isImage = item.mime_type?.startsWith('image/')
  const Icon = CATEGORY_META[item.category].icon

  return (
    <article className="rounded-2xl bg-warm-white border border-sage-100 overflow-hidden flex flex-col">
      <div className="relative aspect-video bg-sage-50">
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.url} alt={item.caption ?? ''} className="w-full h-full object-cover" />
        ) : (
          <video src={item.url} controls preload="metadata" className="w-full h-full object-contain" />
        )}
      </div>
      <div className="p-3 flex flex-col gap-2 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-sage-500">
          <Icon className="w-3 h-3" />
          {CATEGORY_META[item.category].label}
        </div>
        {item.caption && <p className="text-sm text-sage-800 leading-snug">{item.caption}</p>}
        <a
          href={item.url}
          download={item.filename ?? undefined}
          className="mt-auto inline-flex items-center gap-1.5 text-xs text-sage-600 hover:text-sage-900"
        >
          <Download className="w-3 h-3" />
          Download
        </a>
      </div>
    </article>
  )
}
