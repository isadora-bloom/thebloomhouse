'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
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
  Crown,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

interface Photo {
  id: string
  image_url: string
  caption: string | null
  tags: string[]
  is_website: boolean
  is_hero: boolean
  people_tags: string[]
  created_at: string
}

interface PhotoFormData {
  image_url: string
  caption: string
  tags: string[]
  is_website: boolean
  is_hero: boolean
  people_tags: string[]
}

interface GuestName {
  id: string
  first_name: string
  last_name: string
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
  is_hero: false,
  people_tags: [],
}

type TagFilter = 'all' | '_website' | '_hero' | string

// ---------------------------------------------------------------------------
// Photo Library Page
// ---------------------------------------------------------------------------

export default function PhotoLibraryPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [photos, setPhotos] = useState<Photo[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<PhotoFormData>(EMPTY_FORM)
  const [tagFilter, setTagFilter] = useState<TagFilter>('all')
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null)
  const [guestNames, setGuestNames] = useState<GuestName[]>([])
  const [peopleSearch, setPeopleSearch] = useState('')

  const supabase = createClient()

  // ---- Fetch ----
  const fetchPhotos = useCallback(async () => {
    const { data, error } = await supabase
      .from('photo_library')
      .select('*')
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: false })

    if (!error && data) {
      setPhotos(
        (data as Record<string, unknown>[]).map((d) => ({
          ...d,
          is_hero: (d.is_hero as boolean) ?? false,
          people_tags: (d.people_tags as string[]) ?? [],
        })) as Photo[]
      )
    }
    setLoading(false)
  }, [supabase])

  const fetchGuests = useCallback(async () => {
    const { data } = await supabase
      .from('guest_list')
      .select('id, first_name, last_name')
      .eq('wedding_id', weddingId)
      .order('first_name', { ascending: true })

    if (data) {
      setGuestNames(data as GuestName[])
    }
  }, [supabase])

  useEffect(() => {
    fetchPhotos()
    fetchGuests()
  }, [fetchPhotos, fetchGuests])

  // ---- Derived ----
  const filtered = photos.filter((p) => {
    if (tagFilter === 'all') return true
    if (tagFilter === '_website') return p.is_website
    if (tagFilter === '_hero') return p.is_hero
    return p.tags?.includes(tagFilter)
  })

  const websiteCount = photos.filter((p) => p.is_website).length
  const heroPhoto = photos.find((p) => p.is_hero)

  // ---- Filter counts ----
  const filterCounts: Record<string, number> = {
    all: photos.length,
    _website: websiteCount,
    _hero: heroPhoto ? 1 : 0,
  }
  PHOTO_TAGS.forEach((tag) => {
    filterCounts[tag] = photos.filter((p) => p.tags?.includes(tag)).length
  })

  // ---- Modal ----
  function openAdd() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setPeopleSearch('')
    setShowModal(true)
  }

  function openEdit(photo: Photo) {
    setForm({
      image_url: photo.image_url,
      caption: photo.caption || '',
      tags: photo.tags || [],
      is_website: photo.is_website,
      is_hero: photo.is_hero ?? false,
      people_tags: photo.people_tags ?? [],
    })
    setEditingId(photo.id)
    setPeopleSearch('')
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

  function togglePersonTag(name: string) {
    setForm((prev) => ({
      ...prev,
      people_tags: prev.people_tags.includes(name)
        ? prev.people_tags.filter((n) => n !== name)
        : [...prev.people_tags, name],
    }))
  }

  async function handleSave() {
    if (!form.image_url.trim()) return

    const payload = {
      venue_id: venueId,
      wedding_id: weddingId,
      image_url: form.image_url.trim(),
      caption: form.caption.trim() || null,
      tags: form.tags,
      is_website: form.is_website,
      is_hero: form.is_hero,
      people_tags: form.people_tags,
    }

    // If marking as hero, un-hero all others first
    if (form.is_hero) {
      await supabase
        .from('photo_library')
        .update({ is_hero: false })
        .eq('wedding_id', weddingId)
        .neq('id', editingId || '')
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

  async function toggleHero(photo: Photo) {
    const newHeroState = !photo.is_hero
    // If setting as hero, un-hero all others first
    if (newHeroState) {
      await supabase
        .from('photo_library')
        .update({ is_hero: false })
        .eq('wedding_id', weddingId)
    }
    await supabase
      .from('photo_library')
      .update({ is_hero: newHeroState })
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

  // ---- People search filter ----
  const filteredGuests = guestNames.filter((g) => {
    const fullName = `${g.first_name} ${g.last_name}`.toLowerCase()
    return fullName.includes(peopleSearch.toLowerCase())
  })

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
            Manage your wedding photos.{' '}
            {websiteCount > 0 && `${websiteCount} shown on your website.`}
            {heroPhoto && ' Hero banner set.'}
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

      {/* Filter Tabs */}
      <div className="flex flex-wrap gap-2">
        {/* All */}
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
          <span
            className={cn(
              'ml-1.5 px-1.5 py-0.5 rounded-full text-[10px]',
              tagFilter === 'all' ? 'bg-white/20 text-white' : 'bg-gray-200 text-gray-500'
            )}
          >
            {filterCounts.all}
          </span>
        </button>

        {/* Website filter */}
        <button
          onClick={() => setTagFilter('_website')}
          className={cn(
            'px-3 py-1.5 rounded-full text-xs font-medium transition-colors inline-flex items-center gap-1',
            tagFilter === '_website'
              ? 'text-white bg-emerald-600'
              : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
          )}
        >
          <Globe className="w-3 h-3" />
          Website
          <span
            className={cn(
              'ml-1 px-1.5 py-0.5 rounded-full text-[10px]',
              tagFilter === '_website'
                ? 'bg-white/20 text-white'
                : 'bg-emerald-100 text-emerald-600'
            )}
          >
            {filterCounts._website}
          </span>
        </button>

        {/* Hero filter */}
        <button
          onClick={() => setTagFilter('_hero')}
          className={cn(
            'px-3 py-1.5 rounded-full text-xs font-medium transition-colors inline-flex items-center gap-1',
            tagFilter === '_hero'
              ? 'text-white bg-amber-500'
              : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
          )}
        >
          <Crown className="w-3 h-3" />
          Hero
          <span
            className={cn(
              'ml-1 px-1.5 py-0.5 rounded-full text-[10px]',
              tagFilter === '_hero'
                ? 'bg-white/20 text-white'
                : 'bg-amber-100 text-amber-600'
            )}
          >
            {filterCounts._hero}
          </span>
        </button>

        {/* Divider */}
        <div className="w-px h-7 bg-gray-200 self-center" />

        {/* Tag filters */}
        {PHOTO_TAGS.map((tag) => (
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
            {filterCounts[tag] > 0 && (
              <span
                className={cn(
                  'ml-1.5 px-1.5 py-0.5 rounded-full text-[10px]',
                  tagFilter === tag ? 'bg-white/20 text-white' : 'bg-gray-200 text-gray-500'
                )}
              >
                {filterCounts[tag]}
              </span>
            )}
          </button>
        ))}
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
          <ImageIcon
            className="w-12 h-12 mx-auto mb-4"
            style={{ color: 'var(--couple-primary)', opacity: 0.3 }}
          />
          <h3
            className="text-lg font-semibold mb-2"
            style={{
              fontFamily: 'var(--couple-font-heading)',
              color: 'var(--couple-primary)',
            }}
          >
            {tagFilter === '_website'
              ? 'No website photos yet'
              : tagFilter === '_hero'
                ? 'No hero photo set'
                : tagFilter !== 'all'
                  ? 'No photos with this tag'
                  : 'No photos yet'}
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            {tagFilter === '_website'
              ? 'Toggle the globe icon on photos to show them on your website.'
              : tagFilter === '_hero'
                ? 'Set a hero photo using the crown icon to feature it as your website banner.'
                : tagFilter !== 'all'
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
              className={cn(
                'group relative aspect-square rounded-xl overflow-hidden border shadow-sm cursor-pointer hover:shadow-md transition-shadow',
                photo.is_hero ? 'border-amber-400 ring-2 ring-amber-200' : 'border-gray-100'
              )}
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
                  <div className="flex items-center gap-1 flex-wrap">
                    {photo.tags?.slice(0, 2).map((tag) => (
                      <span
                        key={tag}
                        className="px-1.5 py-0.5 rounded text-[9px] bg-white/20 text-white capitalize"
                      >
                        {tag}
                      </span>
                    ))}
                    {(photo.people_tags?.length ?? 0) > 0 && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] bg-blue-500/30 text-white inline-flex items-center gap-0.5">
                        <Users className="w-2.5 h-2.5" />
                        {photo.people_tags.length}
                      </span>
                    )}
                  </div>
                </div>

                {/* Action buttons */}
                <div
                  className="absolute top-2 right-2 flex items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Hero toggle */}
                  <button
                    onClick={() => toggleHero(photo)}
                    className={cn(
                      'p-1.5 rounded-md backdrop-blur-sm transition-colors',
                      photo.is_hero
                        ? 'bg-amber-500/90 text-white'
                        : 'bg-black/30 text-white/70 hover:text-amber-300'
                    )}
                    title={photo.is_hero ? 'Hero banner photo' : 'Set as hero banner'}
                  >
                    <Crown className="w-3.5 h-3.5" />
                  </button>
                  {/* Website toggle */}
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
                    {photo.is_website ? (
                      <Globe className="w-3.5 h-3.5" />
                    ) : (
                      <GlobeOff className="w-3.5 h-3.5" />
                    )}
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

              {/* Badges (always visible) */}
              <div className="absolute top-2 left-2 flex flex-col gap-1">
                {photo.is_hero && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-500 text-white shadow-sm">
                    <Crown className="w-2.5 h-2.5" />
                    Hero
                  </span>
                )}
                {photo.is_website && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500 text-white shadow-sm">
                    <Globe className="w-2.5 h-2.5" />
                    Website
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {lightboxIdx !== null && filtered[lightboxIdx] && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
          onClick={closeLightbox}
        >
          <button
            onClick={(e) => {
              e.stopPropagation()
              lightboxNav('prev')
            }}
            className="absolute left-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              lightboxNav('next')
            }}
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
              <p className="text-white text-center mt-3 text-sm">
                {filtered[lightboxIdx].caption}
              </p>
            )}
            <div className="flex items-center justify-center gap-3 mt-2">
              {filtered[lightboxIdx].is_hero && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-500 text-white">
                  <Crown className="w-3 h-3" />
                  Hero Banner
                </span>
              )}
              {filtered[lightboxIdx].is_website && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-500 text-white">
                  <Globe className="w-3 h-3" />
                  On Website
                </span>
              )}
              {(filtered[lightboxIdx].people_tags?.length ?? 0) > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-500 text-white">
                  <Users className="w-3 h-3" />
                  {filtered[lightboxIdx].people_tags.join(', ')}
                </span>
              )}
            </div>
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
                style={{
                  fontFamily: 'var(--couple-font-heading)',
                  color: 'var(--couple-primary)',
                }}
              >
                {editingId ? 'Edit Photo' : 'Add Photo'}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
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

              {/* Context Tags */}
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
                        style={
                          selected ? { backgroundColor: 'var(--couple-primary)' } : undefined
                        }
                      >
                        {tag}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* People Tags */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <Users className="w-3.5 h-3.5 inline mr-1" />
                  People
                </label>

                {/* Selected people */}
                {form.people_tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {form.people_tags.map((name) => (
                      <button
                        key={name}
                        type="button"
                        onClick={() => togglePersonTag(name)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors"
                      >
                        {name}
                        <X className="w-3 h-3" />
                      </button>
                    ))}
                  </div>
                )}

                {/* Search guests */}
                {guestNames.length > 0 ? (
                  <>
                    <input
                      type="text"
                      value={peopleSearch}
                      onChange={(e) => setPeopleSearch(e.target.value)}
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:border-transparent mb-2"
                      style={
                        { '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties
                      }
                      placeholder="Search guests to tag..."
                    />
                    <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                      {filteredGuests
                        .filter(
                          (g) =>
                            !form.people_tags.includes(`${g.first_name} ${g.last_name}`)
                        )
                        .slice(0, 20)
                        .map((g) => {
                          const fullName = `${g.first_name} ${g.last_name}`
                          return (
                            <button
                              key={g.id}
                              type="button"
                              onClick={() => togglePersonTag(fullName)}
                              className="px-2.5 py-1 rounded-full text-xs font-medium bg-gray-50 text-gray-600 border border-gray-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 transition-colors"
                            >
                              {fullName}
                            </button>
                          )
                        })}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-gray-400">
                    No guests in your guest list yet. Add guests first to tag them in photos.
                  </p>
                )}
              </div>

              {/* Show on Website toggle */}
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, is_website: !form.is_website })}
                  className={cn(
                    'w-full flex items-center justify-between px-4 py-2.5 rounded-lg border text-sm font-medium transition-all',
                    form.is_website
                      ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                      : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
                  )}
                >
                  <span className="inline-flex items-center gap-2">
                    {form.is_website ? (
                      <Globe className="w-4 h-4" />
                    ) : (
                      <GlobeOff className="w-4 h-4" />
                    )}
                    Show on wedding website
                  </span>
                  <span
                    className={cn(
                      'w-9 h-5 rounded-full relative transition-colors',
                      form.is_website ? 'bg-emerald-500' : 'bg-gray-300'
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                        form.is_website ? 'translate-x-4' : 'translate-x-0.5'
                      )}
                    />
                  </span>
                </button>
              </div>

              {/* Hero banner toggle */}
              <div>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, is_hero: !form.is_hero })}
                  className={cn(
                    'w-full flex items-center justify-between px-4 py-2.5 rounded-lg border text-sm font-medium transition-all',
                    form.is_hero
                      ? 'bg-amber-50 border-amber-300 text-amber-700'
                      : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
                  )}
                >
                  <span className="inline-flex items-center gap-2">
                    <Crown className="w-4 h-4" />
                    Set as hero banner
                  </span>
                  <span
                    className={cn(
                      'w-9 h-5 rounded-full relative transition-colors',
                      form.is_hero ? 'bg-amber-500' : 'bg-gray-300'
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                        form.is_hero ? 'translate-x-4' : 'translate-x-0.5'
                      )}
                    />
                  </span>
                </button>
                {form.is_hero && (
                  <p className="text-xs text-amber-600 mt-1 px-1">
                    Only one photo can be the hero banner. This will replace any existing hero.
                  </p>
                )}
              </div>
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
