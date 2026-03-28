'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Image as ImageIcon,
  Plus,
  X,
  Edit2,
  Trash2,
  Globe,
  GlobeOff,
  Tag,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

interface Photo {
  id: string
  image_url: string
  caption: string | null
  tags: string[]
  is_website: boolean
  created_at: string
}

interface PhotoFormData {
  image_url: string
  caption: string
  tags: string[]
  is_website: boolean
}

const PHOTO_TAGS = [
  'ceremony',
  'reception',
  'portraits',
  'getting-ready',
  'details',
  'party',
  'venue',
  'other',
]

const EMPTY_FORM: PhotoFormData = {
  image_url: '',
  caption: '',
  tags: [],
  is_website: false,
}

type TagFilter = 'all' | string

// ---------------------------------------------------------------------------
// Photo Library Page
// ---------------------------------------------------------------------------

export default function PhotoLibraryPage() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<PhotoFormData>(EMPTY_FORM)
  const [tagFilter, setTagFilter] = useState<TagFilter>('all')
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchPhotos = useCallback(async () => {
    const { data, error } = await supabase
      .from('photo_library')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('created_at', { ascending: false })

    if (!error && data) {
      setPhotos(data as Photo[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchPhotos()
  }, [fetchPhotos])

  // ---- Derived ----
  const filtered = photos.filter((p) => {
    if (tagFilter === 'all') return true
    return p.tags?.includes(tagFilter)
  })

  const websiteCount = photos.filter((p) => p.is_website).length

  // ---- Modal ----
  function openAdd() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowModal(true)
  }

  function openEdit(photo: Photo) {
    setForm({
      image_url: photo.image_url,
      caption: photo.caption || '',
      tags: photo.tags || [],
      is_website: photo.is_website,
    })
    setEditingId(photo.id)
    setShowModal(true)
  }

  function toggleFormTag(tag: string) {
    setForm((prev) => ({
      ...prev,
      tags: prev.tags.includes(tag)
        ? prev.tags.filter((t) => t !== tag)
        : [...prev.tags, tag],
    }))
  }

  async function handleSave() {
    if (!form.image_url.trim()) return

    const payload = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      image_url: form.image_url.trim(),
      caption: form.caption.trim() || null,
      tags: form.tags,
      is_website: form.is_website,
    }

    if (editingId) {
      await supabase.from('photo_library').update(payload).eq('id', editingId)
    } else {
      await supabase.from('photo_library').insert(payload)
    }

    setShowModal(false)
    setEditingId(null)
    fetchPhotos()
  }

  async function handleDelete(photo: Photo) {
    if (!confirm('Remove this photo?')) return
    await supabase.from('photo_library').delete().eq('id', photo.id)
    fetchPhotos()
  }

  async function toggleWebsite(photo: Photo) {
    await supabase
      .from('photo_library')
      .update({ is_website: !photo.is_website })
      .eq('id', photo.id)
    fetchPhotos()
  }

  // ---- Lightbox ----
  function openLightbox(idx: number) {
    setLightboxIdx(idx)
  }

  function closeLightbox() {
    setLightboxIdx(null)
  }

  function lightboxNav(direction: 'prev' | 'next') {
    if (lightboxIdx === null) return
    const max = filtered.length - 1
    if (direction === 'prev') {
      setLightboxIdx(lightboxIdx <= 0 ? max : lightboxIdx - 1)
    } else {
      setLightboxIdx(lightboxIdx >= max ? 0 : lightboxIdx + 1)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Photo Library
            <span className="ml-2 text-lg font-normal text-gray-400">({photos.length})</span>
          </h1>
          <p className="text-gray-500 text-sm">
            Manage your wedding photos. {websiteCount > 0 && `${websiteCount} shown on your website.`}
          </p>
        </div>
        <button
          onClick={openAdd}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Photo
        </button>
      </div>

      {/* Tag Filter */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setTagFilter('all')}
          className={cn(
            'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
            tagFilter === 'all'
              ? 'text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          )}
          style={tagFilter === 'all' ? { backgroundColor: 'var(--couple-primary)' } : undefined}
        >
          All
        </button>
        {PHOTO_TAGS.map((tag) => {
          const count = photos.filter((p) => p.tags?.includes(tag)).length
          return (
            <button
              key={tag}
              onClick={() => setTagFilter(tag)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-medium capitalize transition-colors',
                tagFilter === tag
                  ? 'text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              )}
              style={tagFilter === tag ? { backgroundColor: 'var(--couple-primary)' } : undefined}
            >
              {tag}
              {count > 0 && (
                <span className={cn(
                  'ml-1.5 px-1.5 py-0.5 rounded-full text-[10px]',
                  tagFilter === tag ? 'bg-white/20 text-white' : 'bg-gray-200 text-gray-500'
                )}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Photo Grid */}
      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="aspect-square bg-gray-100 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <ImageIcon className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            {tagFilter !== 'all' ? 'No photos with this tag' : 'No photos yet'}
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            {tagFilter !== 'all'
              ? 'Try a different tag filter.'
              : 'Add photos to build your wedding library.'}
          </p>
          {tagFilter === 'all' && (
            <button
              onClick={openAdd}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Plus className="w-4 h-4" />
              Add First Photo
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {filtered.map((photo, idx) => (
            <div
              key={photo.id}
              className="group relative aspect-square rounded-xl overflow-hidden border border-gray-100 shadow-sm cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => openLightbox(idx)}
            >
              <img
                src={photo.image_url}
                alt={photo.caption || 'Wedding photo'}
                className="w-full h-full object-cover"
              />

              {/* Overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="absolute bottom-0 left-0 right-0 p-3">
                  {photo.caption && (
                    <p className="text-white text-xs line-clamp-2 mb-1">{photo.caption}</p>
                  )}
                  <div className="flex items-center gap-1">
                    {photo.tags?.slice(0, 2).map((tag) => (
                      <span
                        key={tag}
                        className="px-1.5 py-0.5 rounded text-[9px] bg-white/20 text-white capitalize"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Action buttons */}
                <div
                  className="absolute top-2 right-2 flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => toggleWebsite(photo)}
                    className={cn(
                      'p-1.5 rounded-md backdrop-blur-sm transition-colors',
                      photo.is_website
                        ? 'bg-emerald-500/80 text-white'
                        : 'bg-black/30 text-white/70 hover:text-white'
                    )}
                    title={photo.is_website ? 'Shown on website' : 'Not on website'}
                  >
                    {photo.is_website ? <Globe className="w-3.5 h-3.5" /> : <GlobeOff className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => openEdit(photo)}
                    className="p-1.5 rounded-md bg-black/30 text-white/70 hover:text-white backdrop-blur-sm"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(photo)}
                    className="p-1.5 rounded-md bg-black/30 text-white/70 hover:text-red-300 backdrop-blur-sm"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Website badge (always visible) */}
              {photo.is_website && (
                <div className="absolute top-2 left-2">
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500 text-white">
                    <Globe className="w-2.5 h-2.5" />
                    Website
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {lightboxIdx !== null && filtered[lightboxIdx] && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90" onClick={closeLightbox}>
          <button
            onClick={(e) => { e.stopPropagation(); lightboxNav('prev') }}
            className="absolute left-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); lightboxNav('next') }}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
          <button
            onClick={closeLightbox}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>

          <div className="max-w-4xl max-h-[85vh] relative" onClick={(e) => e.stopPropagation()}>
            <img
              src={filtered[lightboxIdx].image_url}
              alt={filtered[lightboxIdx].caption || 'Wedding photo'}
              className="max-w-full max-h-[85vh] object-contain rounded-lg"
            />
            {filtered[lightboxIdx].caption && (
              <p className="text-white text-center mt-3 text-sm">{filtered[lightboxIdx].caption}</p>
            )}
            <p className="text-white/50 text-center mt-1 text-xs">
              {lightboxIdx + 1} of {filtered.length}
            </p>
          </div>
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {editingId ? 'Edit Photo' : 'Add Photo'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Image URL</label>
                <input
                  type="url"
                  value={form.image_url}
                  onChange={(e) => setForm({ ...form, image_url: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="https://..."
                />
              </div>

              {form.image_url && (
                <div className="rounded-lg overflow-hidden border border-gray-200">
                  <img
                    src={form.image_url}
                    alt="Preview"
                    className="w-full h-40 object-cover"
                    onError={(e) => {
                      ;(e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Caption</label>
                <input
                  type="text"
                  value={form.caption}
                  onChange={(e) => setForm({ ...form, caption: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="Describe this photo (optional)"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <Tag className="w-3.5 h-3.5 inline mr-1" />
                  Tags
                </label>
                <div className="flex flex-wrap gap-2">
                  {PHOTO_TAGS.map((tag) => {
                    const selected = form.tags.includes(tag)
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleFormTag(tag)}
                        className={cn(
                          'px-3 py-1.5 rounded-full text-xs font-medium border capitalize transition-colors',
                          selected
                            ? 'text-white border-transparent'
                            : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                        )}
                        style={selected ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                      >
                        {tag}
                      </button>
                    )
                  })}
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
                <input
                  type="checkbox"
                  checked={form.is_website}
                  onChange={(e) => setForm({ ...form, is_website: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300"
                  style={{ accentColor: 'var(--couple-primary)' }}
                />
                Show on wedding website
              </label>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!form.image_url.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Photo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
