'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import {
  Share2,
  Plus,
  X,
  Zap,
  TrendingUp,
  Heart,
  MessageCircle,
  Eye,
  Bookmark,
  ExternalLink,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

function getSupabase() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SocialPost {
  id: string
  venue_id: string
  platform: string
  post_date: string
  caption: string | null
  url: string | null
  reach: number
  saves: number
  shares: number
  comments: number
  likes: number
  website_clicks: number
  created_at: string
}

interface WeddingRow {
  id: string
  created_at: string
}

const PLATFORMS = ['instagram', 'facebook', 'tiktok', 'pinterest', 'twitter', 'other']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function platformBadge(platform: string): string {
  const m: Record<string, string> = {
    instagram: 'bg-pink-50 text-pink-700 border-pink-200',
    facebook: 'bg-blue-50 text-blue-700 border-blue-200',
    tiktok: 'bg-slate-50 text-slate-700 border-slate-200',
    pinterest: 'bg-red-50 text-red-700 border-red-200',
    twitter: 'bg-sky-50 text-sky-700 border-sky-200',
  }
  return m[platform] ?? 'bg-sage-50 text-sage-700 border-sage-200'
}

function formatLabel(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
}

function fmtNum(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`
  return String(v)
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function PostCardSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
      <div className="animate-pulse space-y-3">
        <div className="flex items-center gap-2">
          <div className="h-5 w-16 bg-sage-100 rounded-full" />
          <div className="h-4 w-20 bg-sage-50 rounded" />
        </div>
        <div className="h-4 w-full bg-sage-50 rounded" />
        <div className="h-4 w-2/3 bg-sage-50 rounded" />
        <div className="flex gap-4">
          <div className="h-4 w-12 bg-sage-50 rounded" />
          <div className="h-4 w-12 bg-sage-50 rounded" />
          <div className="h-4 w-12 bg-sage-50 rounded" />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default function SocialPage() {
  const [posts, setPosts] = useState<SocialPost[]>([])
  const [weddings, setWeddings] = useState<WeddingRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showModal, setShowModal] = useState(false)

  // Form state
  const [formPlatform, setFormPlatform] = useState('instagram')
  const [formDate, setFormDate] = useState('')
  const [formCaption, setFormCaption] = useState('')
  const [formUrl, setFormUrl] = useState('')
  const [formReach, setFormReach] = useState('')
  const [formSaves, setFormSaves] = useState('')
  const [formShares, setFormShares] = useState('')
  const [formComments, setFormComments] = useState('')
  const [formLikes, setFormLikes] = useState('')
  const [formClicks, setFormClicks] = useState('')
  const [saving, setSaving] = useState(false)

  const fetchData = useCallback(async () => {
    const supabase = getSupabase()
    try {
      const [postRes, weddingRes] = await Promise.all([
        supabase.from('social_posts').select('*').order('post_date', { ascending: false }),
        supabase.from('weddings').select('id, created_at'),
      ])
      if (postRes.error) throw postRes.error
      if (weddingRes.error) throw weddingRes.error
      setPosts((postRes.data ?? []) as SocialPost[])
      setWeddings((weddingRes.data ?? []) as WeddingRow[])
      setError(null)
    } catch (err) {
      console.error('Failed to fetch social data:', err)
      setError('Failed to load social data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Inquiry correlation: count inquiries in 14-day window after each post
  const postsWithCorrelation = useMemo(() => {
    return posts.map((p) => {
      const postDate = new Date(p.post_date).getTime()
      const windowEnd = postDate + 14 * 24 * 60 * 60 * 1000
      const spikeCount = weddings.filter((w) => {
        const t = new Date(w.created_at).getTime()
        return t >= postDate && t <= windowEnd
      }).length
      const isViral = p.reach > 5000
      const engagement = p.likes + p.comments + p.saves + p.shares
      return { ...p, spikeCount, isViral, engagement }
    })
  }, [posts, weddings])

  // Sorted by engagement
  const ranked = useMemo(
    () => [...postsWithCorrelation].sort((a, b) => b.engagement - a.engagement),
    [postsWithCorrelation]
  )

  const handleSave = async () => {
    setSaving(true)
    const supabase = getSupabase()
    try {
      const { error: err } = await supabase.from('social_posts').insert({
        platform: formPlatform,
        post_date: formDate || new Date().toISOString().slice(0, 10),
        caption: formCaption || null,
        url: formUrl || null,
        reach: Number(formReach) || 0,
        saves: Number(formSaves) || 0,
        shares: Number(formShares) || 0,
        comments: Number(formComments) || 0,
        likes: Number(formLikes) || 0,
        website_clicks: Number(formClicks) || 0,
      })
      if (err) throw err
      setShowModal(false)
      setFormPlatform('instagram')
      setFormDate('')
      setFormCaption('')
      setFormUrl('')
      setFormReach('')
      setFormSaves('')
      setFormShares('')
      setFormComments('')
      setFormLikes('')
      setFormClicks('')
      setLoading(true)
      fetchData()
    } catch (err) {
      console.error('Failed to save post:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Social Media Correlation
          </h1>
          <p className="text-sage-600">
            Track post performance and correlate with inquiry spikes.
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Add Post
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <Share2 className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Post list */}
      {loading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <PostCardSkeleton key={i} />
          ))}
        </div>
      ) : ranked.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Share2 className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">No posts tracked</h3>
          <p className="text-sm text-sage-600">Add social media posts to start tracking engagement and inquiry correlation.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {ranked.map((p, idx) => (
            <div key={p.id} className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  {/* Platform + date */}
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider border ${platformBadge(p.platform)}`}>
                      {formatLabel(p.platform)}
                    </span>
                    <span className="text-xs text-sage-500">
                      {new Date(p.post_date).toLocaleDateString()}
                    </span>
                    {idx === 0 && <span className="text-[10px] font-bold uppercase tracking-wider text-gold-600">Top Engagement</span>}
                    {p.isViral && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                        <Zap className="w-2.5 h-2.5" /> Viral
                      </span>
                    )}
                    {p.url && (
                      <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-sage-400 hover:text-sage-600 transition-colors">
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>

                  {/* Caption */}
                  {p.caption && (
                    <p className="text-sm text-sage-700 mb-3 line-clamp-2">{p.caption}</p>
                  )}

                  {/* Metrics row */}
                  <div className="flex flex-wrap gap-4 text-xs text-sage-600">
                    <span className="flex items-center gap-1"><Eye className="w-3 h-3" /> {fmtNum(p.reach)} reach</span>
                    <span className="flex items-center gap-1"><Heart className="w-3 h-3" /> {fmtNum(p.likes)}</span>
                    <span className="flex items-center gap-1"><MessageCircle className="w-3 h-3" /> {p.comments}</span>
                    <span className="flex items-center gap-1"><Share2 className="w-3 h-3" /> {p.shares}</span>
                    <span className="flex items-center gap-1"><Bookmark className="w-3 h-3" /> {p.saves}</span>
                    <span className="flex items-center gap-1"><ExternalLink className="w-3 h-3" /> {p.website_clicks} clicks</span>
                  </div>
                </div>

                {/* Inquiry correlation */}
                <div className="shrink-0 text-center bg-warm-white border border-sage-100 rounded-lg px-4 py-3">
                  <TrendingUp className={`w-4 h-4 mx-auto mb-1 ${p.spikeCount > 0 ? 'text-emerald-500' : 'text-sage-400'}`} />
                  <p className="text-lg font-bold text-sage-900 tabular-nums">{p.spikeCount}</p>
                  <p className="text-[10px] text-sage-500">inquiries (14d)</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Post Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowModal(false)} />
          <div className="relative bg-surface rounded-xl shadow-xl w-full max-w-lg p-6 mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-heading text-lg font-semibold text-sage-900">Add Post</h3>
              <button onClick={() => setShowModal(false)} className="p-1.5 rounded-lg hover:bg-sage-50"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Platform</label>
                  <select value={formPlatform} onChange={(e) => setFormPlatform(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900">
                    {PLATFORMS.map((p) => <option key={p} value={p}>{formatLabel(p)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-sage-700 mb-1">Post Date</label>
                  <input type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">Caption</label>
                <textarea value={formCaption} onChange={(e) => setFormCaption(e.target.value)} rows={2} placeholder="Post caption..." className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400 resize-none" />
              </div>
              <div>
                <label className="block text-sm font-medium text-sage-700 mb-1">URL (optional)</label>
                <input type="url" value={formUrl} onChange={(e) => setFormUrl(e.target.value)} placeholder="https://..." className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  ['Reach', formReach, setFormReach],
                  ['Likes', formLikes, setFormLikes],
                  ['Comments', formComments, setFormComments],
                  ['Shares', formShares, setFormShares],
                  ['Saves', formSaves, setFormSaves],
                  ['Website Clicks', formClicks, setFormClicks],
                ].map(([label, val, setter]) => (
                  <div key={label as string}>
                    <label className="block text-xs font-medium text-sage-700 mb-1">{label as string}</label>
                    <input type="number" value={val as string} onChange={(e) => (setter as (v: string) => void)(e.target.value)} placeholder="0" className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-warm-white text-sage-900 placeholder:text-sage-400" />
                  </div>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
