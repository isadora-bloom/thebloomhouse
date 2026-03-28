'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Sparkles,
  Plus,
  X,
  Search,
  Heart,
  ImageIcon,
  ZoomIn,
  Tag,
  Loader2,
} from 'lucide-react'

// TODO: Get from auth session
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InspoImage {
  id: string
  image_url: string
  caption: string | null
  tags: string[] | null
  created_at: string
}

interface UploadFormData {
  image_url: string
  caption: string
  tags: string
}

const EMPTY_FORM: UploadFormData = {
  image_url: '',
  caption: '',
  tags: '',
}

const TAG_OPTIONS = [
  'ceremony',
  'reception',
  'outdoor',
  'decor',
  'florals',
  'lighting',
  'table-setting',
  'cake',
  'attire',
  'details',
  'portrait',
  'venue',
]

// ---------------------------------------------------------------------------
// Inspo Gallery Page
// ---------------------------------------------------------------------------

export default function InspoGalleryPage() {
  const [images, setImages] = useState<InspoImage[]>([])
  const [loading, setLoading] = useState(true)
  const [showUpload, setShowUpload] = useState(false)
  const [form, setForm] = useState<UploadFormData>(EMPTY_FORM)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [lightboxImage, setLightboxImage] = useState<InspoImage | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const supabase = createClient()

  // ---- Fetch ----
  const fetchImages = useCallback(async () => {
    const { data, error } = await supabase
      .from('inspo_gallery')
      .select('*')
      .eq('venue_id', VENUE_ID)
      .order('created_at', { ascending: false })

    if (!error && data) {
      setImages(data as InspoImage[])
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchImages()
  }, [fetchImages])

  // ---- Filter ----
  const filteredImages = images.filter((img) => {
    // Tag filter
    if (activeTag && !(img.tags || []).includes(activeTag)) return false
    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      const caption = (img.caption || '').toLowerCase()
      const tags = (img.tags || []).join(' ').toLowerCase()
      if (!caption.includes(q) && !tags.includes(q)) return false
    }
    return true
  })

  // All unique tags from images
  const allTags = Array.from(
    new Set(images.flatMap((img) => img.tags || []))
  ).sort()

  // ---- Upload ----
  async function handleUpload() {
    if (!form.image_url.trim()) return

    const tags = form.tags
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)

    await supabase.from('inspo_gallery').insert({
      venue_id: VENUE_ID,
      image_url: form.image_url.trim(),
      caption: form.caption.trim() || null,
      tags: tags.length > 0 ? tags : null,
    })

    setForm(EMPTY_FORM)
    setShowUpload(false)
    fetchImages()
  }

  // ---- Delete ----
  async function handleDelete(id: string) {
    if (!confirm('Remove this image from the gallery?')) return
    await supabase.from('inspo_gallery').delete().eq('id', id)
    if (lightboxImage?.id === id) setLightboxImage(null)
    fetchImages()
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
            Inspiration
          </h1>
          <p className="text-gray-500 text-sm">
            Collect and organize images for your dream wedding.
          </p>
        </div>
        <button
          onClick={() => setShowUpload(true)}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Upload
        </button>
      </div>

      {/* Search + Tag Filters */}
      <div className="space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by caption or tag..."
            className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-lg text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent"
            style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
          />
        </div>

        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setActiveTag(null)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                activeTag === null
                  ? 'text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
              style={activeTag === null ? { backgroundColor: 'var(--couple-primary)' } : undefined}
            >
              All
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  activeTag === tag
                    ? 'text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                style={activeTag === tag ? { backgroundColor: 'var(--couple-primary)' } : undefined}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Gallery */}
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--couple-primary)' }} />
        </div>
      ) : filteredImages.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <ImageIcon
            className="w-12 h-12 mx-auto mb-4"
            style={{ color: 'var(--couple-primary)', opacity: 0.3 }}
          />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            {searchQuery || activeTag ? 'No matching images' : 'No inspiration yet'}
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            {searchQuery || activeTag
              ? 'Try a different search or filter.'
              : 'Start collecting images for your wedding vision.'}
          </p>
          {!searchQuery && !activeTag && (
            <button
              onClick={() => setShowUpload(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              <Plus className="w-4 h-4" />
              Add First Image
            </button>
          )}
        </div>
      ) : (
        /* Masonry grid using CSS columns */
        <div className="columns-1 sm:columns-2 lg:columns-3 gap-4 space-y-4">
          {filteredImages.map((img) => (
            <div
              key={img.id}
              className="break-inside-avoid group relative rounded-xl overflow-hidden border border-gray-100 shadow-sm bg-white"
            >
              {/* Image */}
              <div className="relative">
                <img
                  src={img.image_url}
                  alt={img.caption || 'Inspiration'}
                  className="w-full h-auto object-cover"
                  loading="lazy"
                  onError={(e) => {
                    ;(e.target as HTMLImageElement).src =
                      'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjMwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNDAwIiBoZWlnaHQ9IjMwMCIgZmlsbD0iI2YzZjRmNiIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBkb21pbmFudC1iYXNlbGluZT0ibWlkZGxlIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjOWNhM2FmIiBmb250LXNpemU9IjE0Ij5JbWFnZSBub3QgZm91bmQ8L3RleHQ+PC9zdmc+'
                  }}
                />

                {/* Hover overlay */}
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-end">
                  <div className="w-full p-4 opacity-0 group-hover:opacity-100 transition-opacity transform translate-y-2 group-hover:translate-y-0">
                    {img.caption && (
                      <p className="text-white text-sm font-medium mb-2 line-clamp-2">
                        {img.caption}
                      </p>
                    )}
                    {img.tags && img.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {img.tags.map((tag) => (
                          <span
                            key={tag}
                            className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/20 text-white backdrop-blur-sm"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Action buttons */}
                  <div className="absolute top-3 right-3 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => setLightboxImage(img)}
                      className="w-8 h-8 rounded-full bg-white/90 flex items-center justify-center text-gray-700 hover:bg-white transition-colors shadow-sm"
                    >
                      <ZoomIn className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(img.id)}
                      className="w-8 h-8 rounded-full bg-white/90 flex items-center justify-center text-red-500 hover:bg-white transition-colors shadow-sm"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
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
                Add Inspiration
              </h2>
              <button
                onClick={() => setShowUpload(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Image URL */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <ImageIcon className="w-3.5 h-3.5 inline mr-1" />
                  Image URL
                </label>
                <input
                  type="url"
                  value={form.image_url}
                  onChange={(e) => setForm({ ...form, image_url: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="https://..."
                />
                <p className="text-xs text-gray-400 mt-1">
                  Paste a link to an image. File upload coming soon.
                </p>
              </div>

              {/* Preview */}
              {form.image_url.trim() && (
                <div className="rounded-lg overflow-hidden border border-gray-200 max-h-48">
                  <img
                    src={form.image_url}
                    alt="Preview"
                    className="w-full h-48 object-cover"
                    onError={(e) => {
                      ;(e.target as HTMLImageElement).style.display = 'none'
                    }}
                  />
                </div>
              )}

              {/* Caption */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Caption
                </label>
                <input
                  type="text"
                  value={form.caption}
                  onChange={(e) => setForm({ ...form, caption: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="Describe this image..."
                />
              </div>

              {/* Tags */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <Tag className="w-3.5 h-3.5 inline mr-1" />
                  Tags
                </label>
                <input
                  type="text"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="ceremony, florals, outdoor"
                />

                {/* Quick tag buttons */}
                <div className="flex flex-wrap gap-1 mt-2">
                  {TAG_OPTIONS.map((tag) => {
                    const currentTags = form.tags
                      .split(',')
                      .map((t) => t.trim().toLowerCase())
                    const isActive = currentTags.includes(tag)
                    return (
                      <button
                        key={tag}
                        onClick={() => {
                          if (isActive) {
                            setForm({
                              ...form,
                              tags: currentTags
                                .filter((t) => t !== tag)
                                .join(', '),
                            })
                          } else {
                            const newTags = [...currentTags.filter(Boolean), tag]
                            setForm({ ...form, tags: newTags.join(', ') })
                          }
                        }}
                        className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                          isActive
                            ? 'text-white'
                            : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                        }`}
                        style={
                          isActive
                            ? { backgroundColor: 'var(--couple-accent)' }
                            : undefined
                        }
                      >
                        {tag}
                      </button>
                    )
                  })}
                </div>
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
                disabled={!form.image_url.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                Add to Gallery
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightboxImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8">
          <div
            className="absolute inset-0 bg-black/80"
            onClick={() => setLightboxImage(null)}
          />
          <div className="relative max-w-4xl w-full max-h-[90vh] flex flex-col">
            {/* Close button */}
            <button
              onClick={() => setLightboxImage(null)}
              className="absolute -top-10 right-0 text-white/70 hover:text-white transition-colors"
            >
              <X className="w-6 h-6" />
            </button>

            {/* Image */}
            <div className="flex-1 flex items-center justify-center overflow-hidden rounded-xl">
              <img
                src={lightboxImage.image_url}
                alt={lightboxImage.caption || 'Inspiration'}
                className="max-w-full max-h-[75vh] object-contain rounded-xl"
              />
            </div>

            {/* Caption + tags below */}
            <div className="mt-4 text-center">
              {lightboxImage.caption && (
                <p className="text-white text-lg font-medium mb-2">
                  {lightboxImage.caption}
                </p>
              )}
              {lightboxImage.tags && lightboxImage.tags.length > 0 && (
                <div className="flex flex-wrap justify-center gap-2">
                  {lightboxImage.tags.map((tag) => (
                    <span
                      key={tag}
                      className="px-3 py-1 rounded-full text-xs font-medium bg-white/15 text-white/80 backdrop-blur-sm"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
