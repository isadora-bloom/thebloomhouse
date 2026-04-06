'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Users,
  Plus,
  X,
  Edit2,
  Trash2,
  GripVertical,
  ChevronUp,
  ChevronDown,
  User,
  RefreshCw,
  Search,
  AlertCircle,
  Check,
  ImageOff,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

interface PartyMember {
  id: string
  name: string
  role: string
  side: string
  relationship: string | null
  bio: string | null
  photo_url: string | null
  sort_order: number | null
  created_at: string
}

interface GuestOption {
  id: string
  first_name: string
  last_name: string
}

interface PartyFormData {
  name: string
  role: string
  custom_role: string
  side: string
  relationship: string
  bio: string
  blurb: string
  photo_url: string
  guest_id: string
}

const ROLES = [
  { value: 'honor_attendant', label: 'Honor Attendant' },
  { value: 'best_person', label: 'Best Person' },
  { value: 'attendant', label: 'Attendant' },
  { value: 'maid_of_honor', label: 'Maid of Honor' },
  { value: 'best_man', label: 'Best Man' },
  { value: 'bridesmaid', label: 'Bridesmaid' },
  { value: 'groomsman', label: 'Groomsman' },
  { value: 'flower_child', label: 'Flower Child' },
  { value: 'ring_bearer', label: 'Ring Bearer' },
  { value: 'parent', label: 'Parent' },
  { value: 'grandparent', label: 'Grandparent' },
  { value: 'pet', label: 'Pet' },
  { value: 'other', label: 'Other' },
]

const EMPTY_FORM: PartyFormData = {
  name: '',
  role: 'attendant',
  custom_role: '',
  side: 'partner_1',
  relationship: '',
  bio: '',
  blurb: '',
  photo_url: '',
  guest_id: '',
}

// Maps wedding party roles to ceremony sections
function roleToCeremonySection(role: string): 'processional' | 'family_escort' | null {
  const processionalRoles = [
    'honor_attendant', 'best_person', 'attendant',
    'maid_of_honor', 'best_man', 'bridesmaid', 'groomsman',
    'flower_child', 'ring_bearer',
  ]
  const familyEscortRoles = ['parent', 'grandparent']

  if (processionalRoles.includes(role)) return 'processional'
  if (familyEscortRoles.includes(role)) return 'family_escort'
  return null // officiant, reader, musician, pet, other — not added
}

// Maps wedding party roles to ceremony_order role values
function partyRoleToCeremonyRole(role: string): string {
  const mapping: Record<string, string> = {
    honor_attendant: 'other',
    best_person: 'other',
    attendant: 'other',
    maid_of_honor: 'maid_of_honor',
    best_man: 'best_man',
    bridesmaid: 'bridesmaid',
    groomsman: 'groomsman',
    flower_child: 'flower_girl',
    ring_bearer: 'ring_bearer',
    parent: 'other',
    grandparent: 'other',
  }
  return mapping[role] || 'other'
}

// Maps wedding party side to ceremony side
function partySideToCeremonySide(side: string): string {
  if (side === 'partner_1' || side === 'bride') return 'bride'
  if (side === 'partner_2' || side === 'groom') return 'groom'
  return 'both'
}

function roleLabel(role: string): string {
  return ROLES.find((r) => r.value === role)?.label || role
}

// ---------------------------------------------------------------------------
// Wedding Party Page
// ---------------------------------------------------------------------------

export default function WeddingPartyPage() {
  const [members, setMembers] = useState<PartyMember[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<PartyFormData>(EMPTY_FORM)
  const [guestOptions, setGuestOptions] = useState<GuestOption[]>([])
  const [guestSearch, setGuestSearch] = useState('')
  const [showGuestPicker, setShowGuestPicker] = useState(false)
  const [syncingToCeremony, setSyncingToCeremony] = useState(false)
  const [syncMessage, setSyncMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchMembers = useCallback(async () => {
    const { data, error } = await supabase
      .from('wedding_party')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('sort_order', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })

    if (!error && data) {
      setMembers(data as PartyMember[])
    }
    setLoading(false)
  }, [supabase])

  // ---- Fetch guest list for picker ----
  const fetchGuests = useCallback(async () => {
    const { data } = await supabase
      .from('guest_list')
      .select('id, first_name, last_name')
      .eq('wedding_id', WEDDING_ID)
      .order('last_name', { ascending: true })

    if (data) {
      setGuestOptions(data as GuestOption[])
    }
  }, [supabase])

  useEffect(() => {
    fetchMembers()
    fetchGuests()
  }, [fetchMembers, fetchGuests])

  // ---- Derived ----
  const partner1Members = members.filter((m) => m.side === 'partner_1' || m.side === 'bride')
  const partner2Members = members.filter((m) => m.side === 'partner_2' || m.side === 'groom')
  const sharedMembers = members.filter((m) => m.side === 'both' || (!m.side))

  // ---- Modal ----
  function openAdd(side?: string) {
    setForm({ ...EMPTY_FORM, side: side || 'partner_1' })
    setEditingId(null)
    setShowModal(true)
    setShowGuestPicker(false)
    setGuestSearch('')
  }

  function openEdit(member: PartyMember) {
    const matchedRole = ROLES.find((r) => r.value === member.role)
    setForm({
      name: member.name,
      role: matchedRole ? member.role : 'other',
      custom_role: matchedRole ? '' : member.role,
      side: member.side || 'partner_1',
      relationship: member.relationship || '',
      bio: member.bio || '',
      blurb: (member as PartyMember & { blurb?: string }).blurb || '',
      photo_url: member.photo_url || '',
      guest_id: '',
    })
    setEditingId(member.id)
    setShowModal(true)
    setShowGuestPicker(false)
    setGuestSearch('')
  }

  async function handleSave() {
    if (!form.name.trim()) return

    const resolvedRole = form.role === 'other' && form.custom_role.trim()
      ? form.custom_role.trim()
      : form.role

    const sideMembers = members.filter((m) => m.side === form.side)
    const maxOrder = sideMembers.reduce((max, m) => Math.max(max, m.sort_order || 0), 0)

    const payload: Record<string, unknown> = {
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      name: form.name.trim(),
      role: resolvedRole,
      side: form.side,
      relationship: form.relationship.trim() || null,
      bio: form.bio.trim() || null,
      blurb: form.blurb.trim() || null,
      photo_url: form.photo_url.trim() || null,
    }

    if (editingId) {
      await supabase.from('wedding_party').update(payload).eq('id', editingId)
    } else {
      await supabase.from('wedding_party').insert({
        ...payload,
        sort_order: maxOrder + 1,
      })
    }

    setShowModal(false)
    setEditingId(null)
    fetchMembers()
  }

  async function handleDelete(member: PartyMember) {
    if (!confirm(`Remove ${member.name} from the wedding party?`)) return
    await supabase.from('wedding_party').delete().eq('id', member.id)
    fetchMembers()
  }

  async function moveInList(member: PartyMember, direction: 'up' | 'down') {
    const sideList = members
      .filter((m) => m.side === member.side)
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))

    const idx = sideList.findIndex((m) => m.id === member.id)
    if (idx < 0) return
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= sideList.length) return

    const swapWith = sideList[targetIdx]
    const thisOrder = member.sort_order || idx
    const thatOrder = swapWith.sort_order || targetIdx

    await Promise.all([
      supabase.from('wedding_party').update({ sort_order: thatOrder }).eq('id', member.id),
      supabase.from('wedding_party').update({ sort_order: thisOrder }).eq('id', swapWith.id),
    ])

    fetchMembers()
  }

  // ---- Sync to Ceremony ----
  async function syncToCeremony() {
    if (!confirm('This will add your wedding party members to the ceremony order. Continue?')) return
    setSyncingToCeremony(true)
    setSyncMessage(null)

    try {
      // Get existing ceremony order to find max sort_order
      const { data: existing } = await supabase
        .from('ceremony_order')
        .select('sort_order')
        .eq('wedding_id', WEDDING_ID)
        .order('sort_order', { ascending: false })
        .limit(1)

      let nextOrder = (existing?.[0]?.sort_order || 0) + 1
      let addedCount = 0

      // Build inserts grouped by ceremony section
      const processional: typeof members = []
      const familyEscort: typeof members = []

      for (const member of members) {
        const section = roleToCeremonySection(member.role)
        if (section === 'processional') processional.push(member)
        else if (section === 'family_escort') familyEscort.push(member)
        // null = skip (officiant, reader, musician, pet, other)
      }

      const inserts = []

      // Family escort first, then processional
      for (const member of familyEscort) {
        inserts.push({
          venue_id: VENUE_ID,
          wedding_id: WEDDING_ID,
          participant_name: member.name,
          role: partyRoleToCeremonyRole(member.role),
          side: partySideToCeremonySide(member.side),
          sort_order: nextOrder++,
          notes: `family_escort | Synced from wedding party`,
        })
        addedCount++
      }

      for (const member of processional) {
        inserts.push({
          venue_id: VENUE_ID,
          wedding_id: WEDDING_ID,
          participant_name: member.name,
          role: partyRoleToCeremonyRole(member.role),
          side: partySideToCeremonySide(member.side),
          sort_order: nextOrder++,
          notes: `processional | Synced from wedding party`,
        })
        addedCount++
      }

      if (inserts.length > 0) {
        const { error } = await supabase.from('ceremony_order').insert(inserts)
        if (error) throw error
      }

      setSyncMessage({
        text: addedCount > 0
          ? `Added ${addedCount} member${addedCount !== 1 ? 's' : ''} to ceremony order.`
          : 'No applicable members to sync (roles like officiant, reader, musician are not auto-added).',
        type: 'success',
      })
    } catch (err) {
      console.error('Sync to ceremony failed:', err)
      setSyncMessage({ text: 'Failed to sync. Please try again.', type: 'error' })
    } finally {
      setSyncingToCeremony(false)
      setTimeout(() => setSyncMessage(null), 5000)
    }
  }

  // ---- Guest picker helpers ----
  const filteredGuests = guestOptions.filter((g) => {
    const fullName = `${g.first_name} ${g.last_name}`.toLowerCase()
    return fullName.includes(guestSearch.toLowerCase())
  })

  function selectGuest(guest: GuestOption) {
    setForm({
      ...form,
      name: `${guest.first_name} ${guest.last_name}`.trim(),
      guest_id: guest.id,
    })
    setShowGuestPicker(false)
    setGuestSearch('')
  }

  // ---- Render side column ----
  function renderSide(label: string, sideMembers: PartyMember[], side: string) {
    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2
            className="text-lg font-semibold"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            {label}
            <span className="ml-2 text-sm font-normal text-gray-400">({sideMembers.length})</span>
          </h2>
          <button
            onClick={() => openAdd(side)}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
        </div>

        {sideMembers.length === 0 ? (
          <div className="text-center py-8 bg-white rounded-xl border border-gray-100 shadow-sm">
            <User className="w-8 h-8 mx-auto mb-2 text-gray-300" />
            <p className="text-sm text-gray-400">No members yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sideMembers.map((member, idx) => (
              <div
                key={member.id}
                className="bg-white rounded-xl border border-gray-100 shadow-sm p-3 group hover:shadow-md transition-shadow"
              >
                <div className="flex items-start gap-3">
                  {/* Avatar / photo */}
                  <div className="shrink-0">
                    {member.photo_url ? (
                      <img
                        src={member.photo_url}
                        alt={member.name}
                        className="w-10 h-10 rounded-full object-cover"
                      />
                    ) : (
                      <div
                        className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold"
                        style={{ backgroundColor: 'var(--couple-primary)', opacity: 0.7 }}
                      >
                        {member.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-800 text-sm">{member.name}</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-600 border border-gray-200">
                        {roleLabel(member.role)}
                      </span>
                      {!member.photo_url && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-600 border border-amber-200 inline-flex items-center gap-0.5">
                          <ImageOff className="w-2.5 h-2.5" />
                          No photo
                        </span>
                      )}
                    </div>
                    {member.relationship && (
                      <p className="text-xs text-gray-500 mt-0.5">{member.relationship}</p>
                    )}
                    {member.bio && (
                      <p className="text-xs text-gray-400 mt-1 line-clamp-2">{member.bio}</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-col items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      onClick={() => moveInList(member, 'up')}
                      disabled={idx === 0}
                      className="p-1 rounded text-gray-400 hover:text-gray-600 disabled:opacity-30"
                    >
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => moveInList(member, 'down')}
                      disabled={idx === sideMembers.length - 1}
                      className="p-1 rounded text-gray-400 hover:text-gray-600 disabled:opacity-30"
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => openEdit(member)}
                      className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(member)}
                      className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
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
            Wedding Party
            <span className="ml-2 text-lg font-normal text-gray-400">({members.length})</span>
          </h1>
          <p className="text-gray-500 text-sm">
            Your people, your way. Add everyone who stands with you.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {members.length > 0 && (
            <button
              onClick={syncToCeremony}
              disabled={syncingToCeremony}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors hover:bg-gray-50 disabled:opacity-50"
              style={{ borderColor: 'var(--couple-primary)', color: 'var(--couple-primary)' }}
            >
              <RefreshCw className={cn('w-4 h-4', syncingToCeremony && 'animate-spin')} />
              Sync to Ceremony
            </button>
          )}
          <button
            onClick={() => openAdd()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add Member
          </button>
        </div>
      </div>

      {/* Sync Message */}
      {syncMessage && (
        <div
          className={cn(
            'flex items-center gap-2 px-4 py-3 rounded-lg text-sm',
            syncMessage.type === 'success'
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          )}
        >
          {syncMessage.type === 'success' ? <Check className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {syncMessage.text}
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 bg-gray-100 rounded-xl" />
          ))}
        </div>
      ) : members.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Users className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No wedding party members yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">
            Add the people standing beside you on your wedding day.
          </p>
          <button
            onClick={() => openAdd()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add First Member
          </button>
        </div>
      ) : (
        <>
          {/* Two-column layout */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {renderSide('Partner 1', partner1Members, 'partner_1')}
            {renderSide('Partner 2', partner2Members, 'partner_2')}
          </div>

          {/* Shared members */}
          {sharedMembers.length > 0 && (
            <div>
              {renderSide('Shared', sharedMembers, 'both')}
            </div>
          )}
        </>
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
                {editingId ? 'Edit Member' : 'Add Member'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Guest list picker */}
              {!editingId && (
                <div className="relative">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Link to existing guest
                    <span className="text-gray-400 font-normal ml-1">(optional)</span>
                  </label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                    <input
                      type="text"
                      value={guestSearch}
                      onChange={(e) => {
                        setGuestSearch(e.target.value)
                        setShowGuestPicker(e.target.value.length > 0)
                      }}
                      onFocus={() => { if (guestSearch.length > 0) setShowGuestPicker(true) }}
                      className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                      placeholder="Search guest list..."
                    />
                  </div>
                  {showGuestPicker && filteredGuests.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
                      {filteredGuests.map((g) => (
                        <button
                          key={g.id}
                          onClick={() => selectGuest(g)}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors"
                        >
                          {g.first_name} {g.last_name}
                        </button>
                      ))}
                    </div>
                  )}
                  {showGuestPicker && guestSearch.length > 0 && filteredGuests.length === 0 && (
                    <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg px-3 py-2 text-sm text-gray-400">
                      No matching guests
                    </div>
                  )}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="Full name"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                  <select
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  >
                    {ROLES.map((r) => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Side</label>
                  <select
                    value={form.side}
                    onChange={(e) => setForm({ ...form, side: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  >
                    <option value="partner_1">Partner 1</option>
                    <option value="partner_2">Partner 2</option>
                    <option value="both">Both</option>
                  </select>
                </div>
              </div>

              {form.role === 'other' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Custom Role</label>
                  <input
                    type="text"
                    value={form.custom_role}
                    onChange={(e) => setForm({ ...form, custom_role: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="e.g., Man of Honor, Officiant"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Relationship</label>
                <input
                  type="text"
                  value={form.relationship}
                  onChange={(e) => setForm({ ...form, relationship: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="e.g., College roommate, Sister"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Bio <span className="text-gray-400 font-normal">(internal notes)</span></label>
                <textarea
                  value={form.bio}
                  onChange={(e) => setForm({ ...form, bio: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={3}
                  placeholder="A few words about this person (optional)"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Website blurb <span className="text-gray-400 font-normal">(shown on your wedding website)</span></label>
                <textarea
                  value={form.blurb}
                  onChange={(e) => setForm({ ...form, blurb: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent resize-none"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={3}
                  placeholder="e.g., &quot;Sarah and I have been best friends since the 3rd grade...&quot;"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Photo URL</label>
                <input
                  type="url"
                  value={form.photo_url}
                  onChange={(e) => setForm({ ...form, photo_url: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  placeholder="https://..."
                />
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
                disabled={!form.name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Member'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
