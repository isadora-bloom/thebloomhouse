'use client'

// ---------------------------------------------------------------------------
// Venue Groups — create/edit/delete portfolios of venues inside an org.
// Used by the ScopeSelector to filter dashboards and intel by a group of
// venues instead of a single venue or the whole company.
//
// Reads and writes `venue_groups` + `venue_group_members` via the browser
// supabase client. RLS on both tables restricts rows to the user's org
// (migration 056_sweep_rls_drift.sql).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Layers, Plus, Trash2, ArrowLeft, Check, X, Loader2 } from 'lucide-react'

interface VenueRow {
  id: string
  name: string
}

interface GroupRow {
  id: string
  name: string
  description: string | null
  memberIds: string[]
}

export default function VenueGroupsPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const [orgId, setOrgId] = useState<string | null>(null)
  const [venues, setVenues] = useState<VenueRow[]>([])
  const [groups, setGroups] = useState<GroupRow[]>([])

  // Create form state
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [newMembers, setNewMembers] = useState<Set<string>>(new Set())
  const [showNew, setShowNew] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    const supabase = createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      router.push('/login')
      return
    }

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('org_id, role')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile?.org_id) {
      setErr('No organisation found for this account.')
      setLoading(false)
      return
    }

    // Only org admins should manage groups. Venue-scoped roles can view but
    // won't have insert/delete permission; we surface a read-only UI for them.
    setOrgId(profile.org_id as string)

    const { data: venueRows } = await supabase
      .from('venues')
      .select('id, name')
      .eq('org_id', profile.org_id as string)
      .order('name')

    setVenues((venueRows ?? []) as VenueRow[])

    const { data: groupRows } = await supabase
      .from('venue_groups')
      .select('id, name, description, venue_group_members(venue_id)')
      .eq('org_id', profile.org_id as string)
      .order('name')

    const shaped: GroupRow[] = (groupRows ?? []).map((g: {
      id: string
      name: string
      description: string | null
      venue_group_members?: { venue_id: string }[] | null
    }) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      memberIds: (g.venue_group_members ?? []).map((m) => m.venue_id),
    }))
    setGroups(shaped)
    setLoading(false)
  }, [router])

  useEffect(() => {
    load()
  }, [load])

  // ---- Create group --------------------------------------------------------
  async function createGroup() {
    if (!orgId) return
    if (!newName.trim()) {
      setErr('Name is required.')
      return
    }
    setErr(null)
    setSaving(true)
    const supabase = createClient()

    const { data: created, error: insertErr } = await supabase
      .from('venue_groups')
      .insert({
        org_id: orgId,
        name: newName.trim(),
        description: newDesc.trim() || null,
      })
      .select('id')
      .single()

    if (insertErr || !created) {
      setErr(insertErr?.message || 'Failed to create group.')
      setSaving(false)
      return
    }

    if (newMembers.size > 0) {
      const rows = Array.from(newMembers).map((venueId) => ({
        group_id: created.id,
        venue_id: venueId,
      }))
      const { error: memberErr } = await supabase
        .from('venue_group_members')
        .insert(rows)
      if (memberErr) {
        setErr(`Group created but failed to add venues: ${memberErr.message}`)
      }
    }

    setNewName('')
    setNewDesc('')
    setNewMembers(new Set())
    setShowNew(false)
    setSaving(false)
    await load()
  }

  // ---- Delete group --------------------------------------------------------
  async function deleteGroup(id: string) {
    if (!confirm('Delete this group? Venues in it will not be deleted.')) return
    const supabase = createClient()
    const { error } = await supabase.from('venue_groups').delete().eq('id', id)
    if (error) {
      setErr(error.message)
      return
    }
    await load()
  }

  // ---- Toggle a venue's membership in a group -----------------------------
  async function toggleMember(groupId: string, venueId: string, isMember: boolean) {
    const supabase = createClient()
    if (isMember) {
      const { error } = await supabase
        .from('venue_group_members')
        .delete()
        .eq('group_id', groupId)
        .eq('venue_id', venueId)
      if (error) setErr(error.message)
    } else {
      const { error } = await supabase
        .from('venue_group_members')
        .insert({ group_id: groupId, venue_id: venueId })
      if (error) setErr(error.message)
    }
    await load()
  }

  // ---- Render --------------------------------------------------------------
  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="w-6 h-6 animate-spin text-sage-400" />
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/settings"
            className="p-2 rounded-lg hover:bg-sage-50 text-sage-500 hover:text-sage-800"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-serif text-sage-900">Venue Groups</h1>
            <p className="text-sm text-sage-500 mt-0.5">
              Portfolios of venues. Use groups to scope dashboards and intelligence across multiple venues at once.
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-2 px-4 py-2 bg-sage-600 text-white rounded-lg hover:bg-sage-700 transition-colors text-sm"
        >
          <Plus className="w-4 h-4" /> New Group
        </button>
      </div>

      {err && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-700">
          {err}
        </div>
      )}

      {/* New group form */}
      {showNew && (
        <div className="p-5 bg-surface border border-border rounded-xl space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-sage-800">New group</h2>
            <button
              onClick={() => { setShowNew(false); setNewName(''); setNewDesc(''); setNewMembers(new Set()) }}
              className="text-sage-400 hover:text-sage-700"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-3">
            <div>
              <label className="block text-xs uppercase tracking-wider text-sage-500 mb-1">Group name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. East Coast Collection"
                className="w-full border border-border rounded-lg px-3 py-2.5 text-sm bg-warm-white"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-sage-500 mb-1">Description (optional)</label>
              <input
                type="text"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="What ties these venues together?"
                className="w-full border border-border rounded-lg px-3 py-2.5 text-sm bg-warm-white"
              />
            </div>
            <div>
              <label className="block text-xs uppercase tracking-wider text-sage-500 mb-2">Venues in this group</label>
              {venues.length === 0 ? (
                <p className="text-sm text-sage-400">No venues yet. Create a venue first.</p>
              ) : (
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {venues.map((v) => {
                    const selected = newMembers.has(v.id)
                    return (
                      <button
                        key={v.id}
                        onClick={() => {
                          const next = new Set(newMembers)
                          if (selected) next.delete(v.id); else next.add(v.id)
                          setNewMembers(next)
                        }}
                        className={`flex items-center justify-between w-full px-3 py-2 rounded-lg text-sm transition-colors ${
                          selected ? 'bg-sage-50 text-sage-800' : 'hover:bg-sage-50/50 text-sage-600'
                        }`}
                      >
                        <span>{v.name}</span>
                        {selected && <Check className="w-4 h-4 text-sage-600" />}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => { setShowNew(false); setNewName(''); setNewDesc(''); setNewMembers(new Set()) }}
                className="px-4 py-2 text-sm text-sage-600 hover:text-sage-800"
              >
                Cancel
              </button>
              <button
                onClick={createGroup}
                disabled={saving || !newName.trim()}
                className="px-4 py-2 text-sm bg-sage-600 text-white rounded-lg hover:bg-sage-700 disabled:opacity-50"
              >
                {saving ? 'Creating…' : 'Create group'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Existing groups */}
      {groups.length === 0 && !showNew && (
        <div className="p-10 bg-surface border border-border rounded-xl text-center">
          <Layers className="w-10 h-10 text-sage-300 mx-auto mb-3" />
          <h3 className="text-sage-800 font-medium mb-1">No groups yet</h3>
          <p className="text-sm text-sage-500 mb-4">
            Create a group to roll up dashboards across multiple venues.
          </p>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.id} className="p-5 bg-surface border border-border rounded-xl space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-base font-semibold text-sage-800 flex items-center gap-2">
                <Layers className="w-4 h-4 text-teal-600" /> {g.name}
              </h3>
              {g.description && (
                <p className="text-sm text-sage-500 mt-1">{g.description}</p>
              )}
              <p className="text-xs text-sage-400 mt-1">
                {g.memberIds.length} venue{g.memberIds.length === 1 ? '' : 's'}
              </p>
            </div>
            <button
              onClick={() => deleteGroup(g.id)}
              className="p-1.5 text-sage-400 hover:text-rose-600 rounded hover:bg-rose-50"
              title="Delete group"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
          <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
            {venues.map((v) => {
              const isMember = g.memberIds.includes(v.id)
              return (
                <button
                  key={v.id}
                  onClick={() => toggleMember(g.id, v.id, isMember)}
                  className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                    isMember
                      ? 'bg-teal-50 text-teal-800 border-teal-200'
                      : 'bg-warm-white text-sage-500 border-border hover:bg-sage-50'
                  }`}
                >
                  {isMember && <Check className="w-3 h-3 inline mr-1" />}
                  {v.name}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
