'use client'

import { useState, useEffect, useCallback } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import {
  Megaphone,
  Plus,
  Trash2,
  AlertTriangle,
  Edit2,
  ToggleLeft,
  ToggleRight,
  Save,
  X,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Per-venue marketing channels admin (T2-B Phase 2 / LIMB-16.2.4-A)
//
// Canonical registry of the marketing channels this venue actually uses.
// /intel/sources reads this for the channel-mix dashboard. weddings.source +
// attribution_events.source_platform write `key` values from this table.
// normalize-source.ts maps raw inputs ('knot.com' → 'the_knot') onto these
// keys at the pipeline edge.
//
// Coordinators add long-tail channels (regional bridal magazines, podcast
// appearances, partner referrals) without code deploys. The 'key' column is
// machine-readable; the 'label' is what shows in scorecards.
// ---------------------------------------------------------------------------

interface MarketingChannel {
  id: string
  venue_id: string
  key: string
  label: string
  category: string | null
  is_active: boolean
  notes: string | null
  created_at: string
}

const CATEGORY_OPTIONS = [
  { value: '', label: 'Uncategorised' },
  { value: 'platform', label: 'Vendor platform' },
  { value: 'social', label: 'Social media' },
  { value: 'search', label: 'Search / SEO' },
  { value: 'print', label: 'Print' },
  { value: 'event', label: 'Bridal expo / event' },
  { value: 'referral', label: 'Referral' },
  { value: 'direct', label: 'Direct (own website)' },
  { value: 'paid', label: 'Paid ad' },
  { value: 'other', label: 'Other' },
]

// Suggested channels for the empty state — common keys that match the
// codebase's normalize-source mappings. Coordinators can add without
// these but the suggestions reduce typos and key-mismatch issues.
const SUGGESTED_CHANNELS: Array<{ key: string; label: string; category: string }> = [
  { key: 'the_knot', label: 'The Knot', category: 'platform' },
  { key: 'wedding_wire', label: 'WeddingWire', category: 'platform' },
  { key: 'zola', label: 'Zola', category: 'platform' },
  { key: 'here_comes_the_guide', label: 'Here Comes The Guide', category: 'platform' },
  { key: 'instagram', label: 'Instagram', category: 'social' },
  { key: 'pinterest', label: 'Pinterest', category: 'social' },
  { key: 'facebook', label: 'Facebook', category: 'social' },
  { key: 'tiktok', label: 'TikTok', category: 'social' },
  { key: 'google_business', label: 'Google Business Profile', category: 'search' },
  { key: 'direct', label: 'Venue website', category: 'direct' },
  { key: 'referral', label: 'Past-couple referral', category: 'referral' },
]

export default function MarketingChannelsConfigPage() {
  const venueId = useVenueId()
  const supabase = createClient()
  const [channels, setChannels] = useState<MarketingChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newKey, setNewKey] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [newNotes, setNewNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const fetchChannels = useCallback(async () => {
    if (!venueId) return
    setLoading(true)
    try {
      const { data, error: fetchErr } = await supabase
        .from('marketing_channels')
        .select('id, venue_id, key, label, category, is_active, notes, created_at')
        .eq('venue_id', venueId)
        .is('deleted_at', null)
        .order('is_active', { ascending: false })
        .order('label', { ascending: true })
      if (fetchErr) throw fetchErr
      setChannels((data ?? []) as MarketingChannel[])
      setError(null)
    } catch (err) {
      console.error('Failed to load marketing channels:', err)
      setError('Failed to load marketing channels')
    } finally {
      setLoading(false)
    }
  }, [venueId, supabase])

  useEffect(() => { fetchChannels() }, [fetchChannels])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!venueId || !newKey.trim() || !newLabel.trim() || submitting) return
    setSubmitting(true)
    try {
      const key = newKey.trim().toLowerCase().replace(/\s+/g, '_')
      const { error: insertErr } = await supabase.from('marketing_channels').insert({
        venue_id: venueId,
        key,
        label: newLabel.trim(),
        category: newCategory || null,
        notes: newNotes.trim() || null,
      })
      if (insertErr) throw insertErr
      setNewKey('')
      setNewLabel('')
      setNewCategory('')
      setNewNotes('')
      await fetchChannels()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add'
      setError(/duplicate|unique/i.test(msg) ? 'That key already exists for this venue.' : msg)
    } finally {
      setSubmitting(false)
    }
  }

  async function addSuggested(s: { key: string; label: string; category: string }) {
    if (!venueId) return
    if (channels.some((c) => c.key === s.key)) return
    try {
      const { error: insertErr } = await supabase.from('marketing_channels').insert({
        venue_id: venueId,
        key: s.key,
        label: s.label,
        category: s.category,
      })
      if (insertErr) throw insertErr
      await fetchChannels()
    } catch (err) {
      console.error('Failed to add suggested channel:', err)
    }
  }

  async function toggleActive(c: MarketingChannel) {
    if (!venueId) return
    try {
      const { error: updErr } = await supabase
        .from('marketing_channels')
        .update({ is_active: !c.is_active })
        .eq('id', c.id)
      if (updErr) throw updErr
      await fetchChannels()
    } catch (err) {
      console.error('Failed to toggle:', err)
    }
  }

  async function handleDelete(id: string) {
    if (!venueId) return
    try {
      const { error: delErr } = await supabase
        .from('marketing_channels')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
      if (delErr) throw delErr
      await fetchChannels()
    } catch (err) {
      console.error('Failed to delete:', err)
      setError('Failed to delete')
    }
  }

  async function saveEdit(c: MarketingChannel, patch: Partial<Pick<MarketingChannel, 'label' | 'category' | 'notes'>>) {
    if (!venueId) return
    try {
      const { error: updErr } = await supabase
        .from('marketing_channels')
        .update(patch)
        .eq('id', c.id)
      if (updErr) throw updErr
      setEditingId(null)
      await fetchChannels()
    } catch (err) {
      console.error('Failed to save edit:', err)
      setError('Failed to save')
    }
  }

  if (loading) {
    return <div className="p-8"><p className="text-sage-500 text-sm">Loading…</p></div>
  }

  const unsuggestedKeys = SUGGESTED_CHANNELS.filter((s) => !channels.some((c) => c.key === s.key))

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Megaphone className="w-5 h-5 text-sage-700" />
          <h1 className="font-heading text-2xl font-semibold text-sage-900">Marketing channels</h1>
        </div>
        <p className="text-sm text-sage-600 max-w-2xl">
          The canonical list of channels this venue actively markets through.
          /intel/sources reads this to build the channel-mix dashboard. The
          email pipeline writes the &apos;key&apos; values into{' '}
          <code className="bg-sage-50 px-1 rounded">weddings.source</code> and{' '}
          <code className="bg-sage-50 px-1 rounded">attribution_events.source_platform</code>.
          Add long-tail channels (regional magazines, partnerships, ad campaigns)
          here without a code deploy.
        </p>
      </header>

      {error && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <form onSubmit={handleAdd} className="rounded-lg border border-sage-200 bg-white p-4 space-y-3">
        <h2 className="font-medium text-sage-900">Add a channel</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            type="text"
            required
            placeholder="Key (e.g. local_bridal_mag)"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            className="rounded border border-sage-200 px-3 py-2 text-sm font-mono focus:outline-none focus:border-sage-400"
          />
          <input
            type="text"
            required
            placeholder="Display name (e.g. NoVa Bride Magazine)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            className="rounded border border-sage-200 px-3 py-2 text-sm focus:outline-none focus:border-sage-400"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            className="rounded border border-sage-200 px-3 py-2 text-sm focus:outline-none focus:border-sage-400"
          >
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Internal notes (cadence, contract terms, contact)"
            value={newNotes}
            onChange={(e) => setNewNotes(e.target.value)}
            className="rounded border border-sage-200 px-3 py-2 text-sm focus:outline-none focus:border-sage-400"
          />
        </div>
        <button
          type="submit"
          disabled={submitting || !newKey.trim() || !newLabel.trim()}
          className="inline-flex items-center gap-1.5 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-3 py-1.5"
        >
          <Plus className="w-4 h-4" />
          {submitting ? 'Adding…' : 'Add channel'}
        </button>
      </form>

      {unsuggestedKeys.length > 0 && (
        <div className="rounded-lg border border-dashed border-sage-200 bg-sage-50/30 p-4 space-y-2">
          <p className="text-sm font-medium text-sage-700">Quick-add common channels</p>
          <p className="text-xs text-sage-500">
            One-click adds for channels matching the pipeline&apos;s canonical
            keys. Click to register; you can edit the label or category after.
          </p>
          <div className="flex flex-wrap gap-2">
            {unsuggestedKeys.map((s) => (
              <button
                key={s.key}
                onClick={() => addSuggested(s)}
                className="inline-flex items-center gap-1 rounded bg-white border border-sage-200 hover:border-sage-400 text-xs text-sage-700 px-2 py-1"
              >
                <Plus className="w-3 h-3" />
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="font-medium text-sage-900">Current channels ({channels.length})</h2>
        {channels.length === 0 ? (
          <p className="text-sm text-sage-500 italic">No channels registered yet — add some above or pick from quick-adds.</p>
        ) : (
          <ul className="rounded-lg border border-sage-200 bg-white divide-y divide-sage-100">
            {channels.map((c) => (
              <li key={c.id} className="px-4 py-3">
                {editingId === c.id ? (
                  <ChannelEditRow
                    channel={c}
                    onCancel={() => setEditingId(null)}
                    onSave={(patch) => saveEdit(c, patch)}
                  />
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-sm font-medium ${c.is_active ? 'text-sage-900' : 'text-sage-400'}`}>{c.label}</span>
                        <span className="font-mono text-xs text-sage-500">{c.key}</span>
                        {c.category && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sage-50 text-[10px] font-medium text-sage-600 uppercase">
                            {CATEGORY_OPTIONS.find((o) => o.value === c.category)?.label ?? c.category}
                          </span>
                        )}
                        {!c.is_active && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-sage-100 text-[10px] font-medium text-sage-500 uppercase">inactive</span>
                        )}
                      </div>
                      {c.notes && <p className="text-xs text-sage-500 mt-1">{c.notes}</p>}
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => toggleActive(c)} className="text-sage-400 hover:text-sage-600 p-1" title={c.is_active ? 'Deactivate' : 'Reactivate'}>
                        {c.is_active ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                      </button>
                      <button onClick={() => setEditingId(c.id)} className="text-sage-400 hover:text-sage-600 p-1" title="Edit">
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleDelete(c.id)} className="text-sage-400 hover:text-red-600 p-1" title="Remove">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

interface ChannelEditRowProps {
  channel: MarketingChannel
  onCancel: () => void
  onSave: (patch: Partial<Pick<MarketingChannel, 'label' | 'category' | 'notes'>>) => void
}

function ChannelEditRow({ channel, onCancel, onSave }: ChannelEditRowProps) {
  const [label, setLabel] = useState(channel.label)
  const [category, setCategory] = useState(channel.category ?? '')
  const [notes, setNotes] = useState(channel.notes ?? '')
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="rounded border border-sage-200 px-2 py-1 text-sm"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded border border-sage-200 px-2 py-1 text-sm"
        >
          {CATEGORY_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>
      <input
        type="text"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Internal notes"
        className="w-full rounded border border-sage-200 px-2 py-1 text-sm"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSave({ label: label.trim(), category: category || null, notes: notes.trim() || null })}
          className="inline-flex items-center gap-1 rounded bg-sage-700 hover:bg-sage-800 text-white text-xs px-2 py-1"
        >
          <Save className="w-3 h-3" />
          Save
        </button>
        <button onClick={onCancel} className="inline-flex items-center gap-1 rounded text-xs text-sage-500 px-2 py-1">
          <X className="w-3 h-3" />
          Cancel
        </button>
      </div>
    </div>
  )
}
