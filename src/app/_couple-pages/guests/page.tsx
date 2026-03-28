'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Users,
  Plus,
  X,
  Edit2,
  Trash2,
  Search,
  CheckCircle,
  XCircle,
  Clock,
  HelpCircle,
  Download,
  Upload,
  Mail,
  Phone,
  UserPlus,
  Tag,
  MapPin,
  ChevronDown,
  ChevronUp,
  Check,
  Filter,
  MoreHorizontal,
  Utensils,
  AlertTriangle,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Guest {
  id: string
  person_id: string | null
  group_name: string | null
  rsvp_status: 'pending' | 'attending' | 'declined' | 'maybe'
  meal_preference: string | null
  dietary_restrictions: string | null
  plus_one: boolean
  plus_one_name: string | null
  plus_one_rsvp: string | null
  plus_one_meal: string | null
  invitation_sent: boolean
  table_assignment: string | null
  address: string | null
  phone: string | null
  notes: string | null
  person: {
    first_name: string | null
    last_name: string | null
    email: string | null
  } | null
  tags?: GuestTagAssignment[]
}

interface GuestTag {
  id: string
  name: string
  color: string
}

interface GuestTagAssignment {
  id: string
  tag_id: string
  guest_id: string
  tag?: GuestTag
}

interface MealOption {
  id: string
  name: string
  description: string | null
  is_kids_option: boolean
}

interface GuestFormData {
  first_name: string
  last_name: string
  email: string
  phone: string
  address: string
  group_name: string
  rsvp_status: string
  meal_preference: string
  dietary_restrictions: string
  plus_one: boolean
  plus_one_name: string
  plus_one_rsvp: string
  plus_one_meal: string
  notes: string
  tag_ids: string[]
}

type StatusFilter = 'all' | 'attending' | 'declined' | 'pending' | 'maybe'
type ViewMode = 'table' | 'stats'

const TAG_COLORS = [
  '#3B82F6', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6',
  '#EC4899', '#14B8A6', '#F97316', '#6366F1', '#84CC16',
]

const DEFAULT_MEAL_OPTIONS = [
  'Chicken', 'Beef', 'Fish', 'Vegetarian', 'Vegan', 'Kids Meal',
]

const EMPTY_FORM: GuestFormData = {
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  address: '',
  group_name: '',
  rsvp_status: 'pending',
  meal_preference: '',
  dietary_restrictions: '',
  plus_one: false,
  plus_one_name: '',
  plus_one_rsvp: 'pending',
  plus_one_meal: '',
  notes: '',
  tag_ids: [],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function guestName(guest: Guest): string {
  if (guest.person) {
    return [guest.person.first_name, guest.person.last_name].filter(Boolean).join(' ') || 'Unnamed'
  }
  return 'Unnamed'
}

function statusConfig(status: string) {
  switch (status) {
    case 'attending':
      return { label: 'Attending', className: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: CheckCircle, color: '#10B981' }
    case 'declined':
      return { label: 'Declined', className: 'bg-red-50 text-red-600 border-red-200', icon: XCircle, color: '#EF4444' }
    case 'maybe':
      return { label: 'Maybe', className: 'bg-amber-50 text-amber-700 border-amber-200', icon: HelpCircle, color: '#F59E0B' }
    default:
      return { label: 'Pending', className: 'bg-gray-50 text-gray-600 border-gray-200', icon: Clock, color: '#6B7280' }
  }
}

// ---------------------------------------------------------------------------
// CSV Parser
// ---------------------------------------------------------------------------

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) return []

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase())
  const rows: Record<string, string>[] = []

  for (let i = 1; i < lines.length; i++) {
    const values: string[] = []
    let current = ''
    let inQuotes = false

    for (const char of lines[i]) {
      if (char === '"') {
        inQuotes = !inQuotes
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
    values.push(current.trim())

    const row: Record<string, string> = {}
    headers.forEach((h, idx) => {
      row[h] = values[idx] || ''
    })
    rows.push(row)
  }

  return rows
}

function mapCSVField(headers: string[], target: string): string | null {
  const mappings: Record<string, string[]> = {
    first_name: ['first name', 'first', 'firstname', 'given name', 'name'],
    last_name: ['last name', 'last', 'lastname', 'surname', 'family name'],
    email: ['email', 'e-mail', 'email address'],
    phone: ['phone', 'telephone', 'mobile', 'cell', 'phone number'],
    address: ['address', 'mailing address', 'street address', 'home address'],
    group_name: ['group', 'group name', 'category', 'side'],
    meal: ['meal', 'meal preference', 'entree', 'dinner', 'meal choice'],
    dietary: ['dietary', 'dietary restrictions', 'allergies', 'food allergies', 'dietary needs'],
  }

  const candidates = mappings[target] || [target]
  for (const h of headers) {
    const lower = h.toLowerCase().trim()
    if (candidates.includes(lower)) return h
  }
  return null
}

// ---------------------------------------------------------------------------
// Guests Page
// ---------------------------------------------------------------------------

export default function GuestsPage() {
  const [guests, setGuests] = useState<Guest[]>([])
  const [tags, setTags] = useState<GuestTag[]>([])
  const [mealOptions, setMealOptions] = useState<string[]>(DEFAULT_MEAL_OPTIONS)
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showTagManager, setShowTagManager] = useState(false)
  const [showBulkActions, setShowBulkActions] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<GuestFormData>(EMPTY_FORM)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [mealFilter, setMealFilter] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>('table')
  const [selectedGuests, setSelectedGuests] = useState<Set<string>>(new Set())
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[0])
  const [importData, setImportData] = useState<Record<string, string>[]>([])
  const [importPreview, setImportPreview] = useState(false)
  const [expandedDetail, setExpandedDetail] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()

  // ---- Fetch ----
  const fetchGuests = useCallback(async () => {
    const { data, error } = await supabase
      .from('guest_list')
      .select(`
        *,
        person:people(first_name, last_name, email),
        tags:guest_tag_assignments(id, tag_id, guest_id, tag:guest_tags(*))
      `)
      .eq('wedding_id', WEDDING_ID)
      .order('created_at', { ascending: true })

    if (!error && data) {
      setGuests(data as unknown as Guest[])
    }
    setLoading(false)
  }, [supabase])

  const fetchTags = useCallback(async () => {
    const { data } = await supabase
      .from('guest_tags')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('name')

    if (data) setTags(data as GuestTag[])
  }, [supabase])

  const fetchMealOptions = useCallback(async () => {
    const { data } = await supabase
      .from('guest_meal_options')
      .select('*')
      .eq('wedding_id', WEDDING_ID)
      .order('name')

    if (data && data.length > 0) {
      setMealOptions(data.map((m: MealOption) => m.name))
    }
  }, [supabase])

  useEffect(() => {
    fetchGuests()
    fetchTags()
    fetchMealOptions()
  }, [fetchGuests, fetchTags, fetchMealOptions])

  // ---- RSVP stats ----
  const stats = useMemo(() => {
    const attending = guests.filter(g => g.rsvp_status === 'attending')
    const plusOnesAttending = attending.filter(g => g.plus_one && g.plus_one_rsvp === 'attending').length

    const mealBreakdown: Record<string, number> = {}
    const dietaryList: string[] = []

    guests.forEach(g => {
      if (g.meal_preference) {
        mealBreakdown[g.meal_preference] = (mealBreakdown[g.meal_preference] || 0) + 1
      }
      if (g.plus_one && g.plus_one_meal) {
        mealBreakdown[g.plus_one_meal] = (mealBreakdown[g.plus_one_meal] || 0) + 1
      }
      if (g.dietary_restrictions) {
        dietaryList.push(`${guestName(g)}: ${g.dietary_restrictions}`)
      }
    })

    const tagDistribution: Record<string, number> = {}
    guests.forEach(g => {
      g.tags?.forEach(ta => {
        if (ta.tag) {
          tagDistribution[ta.tag.name] = (tagDistribution[ta.tag.name] || 0) + 1
        }
      })
    })

    return {
      total: guests.length,
      totalWithPlusOnes: guests.length + guests.filter(g => g.plus_one).length,
      attending: attending.length,
      attendingWithPlusOnes: attending.length + plusOnesAttending,
      declined: guests.filter(g => g.rsvp_status === 'declined').length,
      pending: guests.filter(g => g.rsvp_status === 'pending').length,
      maybe: guests.filter(g => g.rsvp_status === 'maybe').length,
      mealBreakdown,
      dietaryList,
      tagDistribution,
      invitationsSent: guests.filter(g => g.invitation_sent).length,
    }
  }, [guests])

  // ---- Filter + search ----
  const filteredGuests = useMemo(() => {
    return guests.filter(g => {
      if (statusFilter !== 'all' && g.rsvp_status !== statusFilter) return false
      if (tagFilter) {
        const hasTag = g.tags?.some(ta => ta.tag_id === tagFilter)
        if (!hasTag) return false
      }
      if (mealFilter && g.meal_preference !== mealFilter) return false
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const name = guestName(g).toLowerCase()
        const group = (g.group_name || '').toLowerCase()
        const email = (g.person?.email || '').toLowerCase()
        const tagNames = (g.tags || []).map(t => t.tag?.name?.toLowerCase() || '').join(' ')
        if (!name.includes(q) && !group.includes(q) && !email.includes(q) && !tagNames.includes(q)) return false
      }
      return true
    })
  }, [guests, statusFilter, tagFilter, mealFilter, searchQuery])

  // ---- Select all / bulk ----
  function toggleSelectAll() {
    if (selectedGuests.size === filteredGuests.length) {
      setSelectedGuests(new Set())
    } else {
      setSelectedGuests(new Set(filteredGuests.map(g => g.id)))
    }
  }

  function toggleSelect(id: string) {
    setSelectedGuests(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function bulkUpdateStatus(status: string) {
    const ids = Array.from(selectedGuests)
    await supabase.from('guest_list').update({ rsvp_status: status }).in('id', ids)
    setSelectedGuests(new Set())
    setShowBulkActions(false)
    fetchGuests()
  }

  async function bulkAssignTag(tagId: string) {
    const ids = Array.from(selectedGuests)
    const inserts = ids.map(guestId => ({
      wedding_id: WEDDING_ID,
      venue_id: VENUE_ID,
      guest_id: guestId,
      tag_id: tagId,
    }))
    await supabase.from('guest_tag_assignments').upsert(inserts, { onConflict: 'guest_id,tag_id' })
    setSelectedGuests(new Set())
    setShowBulkActions(false)
    fetchGuests()
  }

  async function bulkDelete() {
    if (!confirm(`Delete ${selectedGuests.size} selected guest(s)?`)) return
    const ids = Array.from(selectedGuests)
    await supabase.from('guest_list').delete().in('id', ids)
    setSelectedGuests(new Set())
    setShowBulkActions(false)
    fetchGuests()
  }

  // ---- Modal helpers ----
  function openAdd() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowModal(true)
  }

  function openEdit(guest: Guest) {
    setForm({
      first_name: guest.person?.first_name || '',
      last_name: guest.person?.last_name || '',
      email: guest.person?.email || '',
      phone: guest.phone || '',
      address: guest.address || '',
      group_name: guest.group_name || '',
      rsvp_status: guest.rsvp_status,
      meal_preference: guest.meal_preference || '',
      dietary_restrictions: guest.dietary_restrictions || '',
      plus_one: guest.plus_one,
      plus_one_name: guest.plus_one_name || '',
      plus_one_rsvp: guest.plus_one_rsvp || 'pending',
      plus_one_meal: guest.plus_one_meal || '',
      notes: guest.notes || '',
      tag_ids: guest.tags?.map(t => t.tag_id) || [],
    })
    setEditingId(guest.id)
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.first_name.trim()) return

    if (editingId) {
      await supabase.from('guest_list').update({
        group_name: form.group_name || null,
        rsvp_status: form.rsvp_status,
        meal_preference: form.meal_preference || null,
        dietary_restrictions: form.dietary_restrictions || null,
        plus_one: form.plus_one,
        plus_one_name: form.plus_one ? form.plus_one_name || null : null,
        plus_one_rsvp: form.plus_one ? form.plus_one_rsvp : null,
        plus_one_meal: form.plus_one ? form.plus_one_meal || null : null,
        phone: form.phone || null,
        address: form.address || null,
        notes: form.notes || null,
      }).eq('id', editingId)

      const guest = guests.find(g => g.id === editingId)
      if (guest?.person_id) {
        await supabase.from('people').update({
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim() || null,
          email: form.email.trim() || null,
        }).eq('id', guest.person_id)
      }

      // Update tags
      await supabase.from('guest_tag_assignments').delete().eq('guest_id', editingId)
      if (form.tag_ids.length > 0) {
        await supabase.from('guest_tag_assignments').insert(
          form.tag_ids.map(tagId => ({
            wedding_id: WEDDING_ID,
            venue_id: VENUE_ID,
            guest_id: editingId,
            tag_id: tagId,
          }))
        )
      }
    } else {
      const { data: person } = await supabase
        .from('people')
        .insert({
          venue_id: VENUE_ID,
          wedding_id: WEDDING_ID,
          role: 'guest',
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim() || null,
          email: form.email.trim() || null,
        })
        .select('id')
        .single()

      if (person) {
        const { data: newGuest } = await supabase.from('guest_list').insert({
          venue_id: VENUE_ID,
          wedding_id: WEDDING_ID,
          person_id: person.id,
          group_name: form.group_name || null,
          rsvp_status: form.rsvp_status,
          meal_preference: form.meal_preference || null,
          dietary_restrictions: form.dietary_restrictions || null,
          plus_one: form.plus_one,
          plus_one_name: form.plus_one ? form.plus_one_name || null : null,
          plus_one_rsvp: form.plus_one ? form.plus_one_rsvp : null,
          plus_one_meal: form.plus_one ? form.plus_one_meal || null : null,
          phone: form.phone || null,
          address: form.address || null,
          notes: form.notes || null,
        }).select('id').single()

        if (newGuest && form.tag_ids.length > 0) {
          await supabase.from('guest_tag_assignments').insert(
            form.tag_ids.map(tagId => ({
              wedding_id: WEDDING_ID,
              venue_id: VENUE_ID,
              guest_id: newGuest.id,
              tag_id: tagId,
            }))
          )
        }
      }
    }

    setShowModal(false)
    setEditingId(null)
    fetchGuests()
  }

  async function handleDelete(guest: Guest) {
    if (!confirm(`Remove ${guestName(guest)} from the guest list?`)) return
    await supabase.from('guest_tag_assignments').delete().eq('guest_id', guest.id)
    await supabase.from('guest_list').delete().eq('id', guest.id)
    fetchGuests()
  }

  // ---- Tag management ----
  async function createTag() {
    if (!newTagName.trim()) return
    await supabase.from('guest_tags').insert({
      wedding_id: WEDDING_ID,
      venue_id: VENUE_ID,
      name: newTagName.trim(),
      color: newTagColor,
    })
    setNewTagName('')
    setNewTagColor(TAG_COLORS[Math.floor(Math.random() * TAG_COLORS.length)])
    fetchTags()
  }

  async function deleteTag(id: string) {
    if (!confirm('Delete this tag? It will be removed from all guests.')) return
    await supabase.from('guest_tag_assignments').delete().eq('tag_id', id)
    await supabase.from('guest_tags').delete().eq('id', id)
    fetchTags()
    fetchGuests()
  }

  // ---- CSV Import ----
  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (evt) => {
      const text = evt.target?.result as string
      const rows = parseCSV(text)
      setImportData(rows)
      setImportPreview(true)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  async function confirmImport() {
    if (importData.length === 0) return

    const headers = Object.keys(importData[0])
    const firstNameField = mapCSVField(headers, 'first_name')
    const lastNameField = mapCSVField(headers, 'last_name')
    const emailField = mapCSVField(headers, 'email')
    const phoneField = mapCSVField(headers, 'phone')
    const addressField = mapCSVField(headers, 'address')
    const groupField = mapCSVField(headers, 'group_name')
    const mealField = mapCSVField(headers, 'meal')
    const dietaryField = mapCSVField(headers, 'dietary')

    for (const row of importData) {
      const firstName = (firstNameField ? row[firstNameField] : '').trim()
      if (!firstName) continue

      const { data: person } = await supabase
        .from('people')
        .insert({
          venue_id: VENUE_ID,
          wedding_id: WEDDING_ID,
          role: 'guest',
          first_name: firstName,
          last_name: (lastNameField ? row[lastNameField] : '').trim() || null,
          email: (emailField ? row[emailField] : '').trim() || null,
        })
        .select('id')
        .single()

      if (person) {
        await supabase.from('guest_list').insert({
          venue_id: VENUE_ID,
          wedding_id: WEDDING_ID,
          person_id: person.id,
          group_name: (groupField ? row[groupField] : '').trim() || null,
          rsvp_status: 'pending',
          meal_preference: (mealField ? row[mealField] : '').trim() || null,
          dietary_restrictions: (dietaryField ? row[dietaryField] : '').trim() || null,
          phone: (phoneField ? row[phoneField] : '').trim() || null,
          address: (addressField ? row[addressField] : '').trim() || null,
          plus_one: false,
        })
      }
    }

    setImportData([])
    setImportPreview(false)
    setShowImport(false)
    fetchGuests()
  }

  // ---- CSV Export ----
  function exportCSV() {
    const headers = ['First Name', 'Last Name', 'Email', 'Phone', 'Address', 'Group', 'RSVP', 'Meal', 'Dietary', 'Plus One', 'Plus One Name', 'Plus One RSVP', 'Plus One Meal', 'Tags', 'Notes']
    const rows = guests.map(g => [
      g.person?.first_name || '',
      g.person?.last_name || '',
      g.person?.email || '',
      g.phone || '',
      g.address || '',
      g.group_name || '',
      g.rsvp_status,
      g.meal_preference || '',
      g.dietary_restrictions || '',
      g.plus_one ? 'Yes' : 'No',
      g.plus_one_name || '',
      g.plus_one_rsvp || '',
      g.plus_one_meal || '',
      (g.tags || []).map(t => t.tag?.name).filter(Boolean).join('; '),
      g.notes || '',
    ])

    const csv = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'guest-list.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const statusFilters: { key: StatusFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: stats.total },
    { key: 'attending', label: 'Attending', count: stats.attending },
    { key: 'pending', label: 'Pending', count: stats.pending },
    { key: 'maybe', label: 'Maybe', count: stats.maybe },
    { key: 'declined', label: 'Declined', count: stats.declined },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Guest List
            <span className="ml-2 text-lg font-normal text-gray-400">({stats.total})</span>
          </h1>
          <p className="text-gray-500 text-sm">
            {stats.attendingWithPlusOnes} attending (incl. plus-ones) · {stats.pending} awaiting response
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setViewMode(viewMode === 'table' ? 'stats' : 'table')}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            {viewMode === 'table' ? 'Stats' : 'List'}
          </button>
          <button
            onClick={() => setShowTagManager(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <Tag className="w-3.5 h-3.5" />
            Tags
          </button>
          <button
            onClick={exportCSV}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <Upload className="w-3.5 h-3.5" />
            Import
          </button>
          <button
            onClick={openAdd}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <UserPlus className="w-4 h-4" />
            Add Guest
          </button>
        </div>
      </div>

      {/* RSVP Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-emerald-50 rounded-xl p-4 border border-emerald-100 text-center">
          <p className="text-2xl font-bold text-emerald-700 tabular-nums">{stats.attending}</p>
          <p className="text-xs text-emerald-600 font-medium">Attending</p>
          {stats.attendingWithPlusOnes > stats.attending && (
            <p className="text-[10px] text-emerald-500 mt-0.5">+{stats.attendingWithPlusOnes - stats.attending} plus-ones</p>
          )}
        </div>
        <div className="bg-gray-50 rounded-xl p-4 border border-gray-200 text-center">
          <p className="text-2xl font-bold text-gray-700 tabular-nums">{stats.pending}</p>
          <p className="text-xs text-gray-500 font-medium">Pending</p>
        </div>
        <div className="bg-amber-50 rounded-xl p-4 border border-amber-100 text-center">
          <p className="text-2xl font-bold text-amber-700 tabular-nums">{stats.maybe}</p>
          <p className="text-xs text-amber-600 font-medium">Maybe</p>
        </div>
        <div className="bg-red-50 rounded-xl p-4 border border-red-100 text-center">
          <p className="text-2xl font-bold text-red-600 tabular-nums">{stats.declined}</p>
          <p className="text-xs text-red-500 font-medium">Declined</p>
        </div>
      </div>

      {/* Stats View */}
      {viewMode === 'stats' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Meal breakdown */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Utensils className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
              <h3 className="font-semibold text-sm" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
                Meal Choices
              </h3>
            </div>
            {Object.keys(stats.mealBreakdown).length === 0 ? (
              <p className="text-sm text-gray-400">No meal selections yet.</p>
            ) : (
              <div className="space-y-2">
                {Object.entries(stats.mealBreakdown).sort((a, b) => b[1] - a[1]).map(([meal, count]) => (
                  <div key={meal} className="flex items-center justify-between">
                    <span className="text-sm text-gray-700">{meal}</span>
                    <div className="flex items-center gap-2">
                      <div className="w-24 h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${(count / stats.total) * 100}%`, backgroundColor: 'var(--couple-accent, var(--couple-primary))' }}
                        />
                      </div>
                      <span className="text-xs text-gray-500 tabular-nums w-6 text-right">{count}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Dietary summary */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
              <h3 className="font-semibold text-sm" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
                Dietary Restrictions ({stats.dietaryList.length})
              </h3>
            </div>
            {stats.dietaryList.length === 0 ? (
              <p className="text-sm text-gray-400">None reported.</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {stats.dietaryList.map((item, i) => (
                  <p key={i} className="text-sm text-gray-600">{item}</p>
                ))}
              </div>
            )}
          </div>

          {/* Tag distribution */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Tag className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
              <h3 className="font-semibold text-sm" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
                Tag Distribution
              </h3>
            </div>
            {Object.keys(stats.tagDistribution).length === 0 ? (
              <p className="text-sm text-gray-400">No tags assigned yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {Object.entries(stats.tagDistribution).map(([name, count]) => {
                  const tag = tags.find(t => t.name === name)
                  return (
                    <span
                      key={name}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium text-white"
                      style={{ backgroundColor: tag?.color || '#6B7280' }}
                    >
                      {name} ({count})
                    </span>
                  )
                })}
              </div>
            )}
          </div>

          {/* Summary stats */}
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
            <h3 className="font-semibold text-sm mb-4" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
              Summary
            </h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-gray-500">Total invited</span><span className="font-medium">{stats.total}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">With plus-ones</span><span className="font-medium">{stats.totalWithPlusOnes}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Invitations sent</span><span className="font-medium">{stats.invitationsSent}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Response rate</span><span className="font-medium">{stats.total > 0 ? Math.round(((stats.attending + stats.declined) / stats.total) * 100) : 0}%</span></div>
            </div>
          </div>
        </div>
      )}

      {/* Filter + Search Bar */}
      {viewMode === 'table' && (
        <>
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex flex-wrap gap-2">
              {statusFilters.map(sf => (
                <button
                  key={sf.key}
                  onClick={() => setStatusFilter(sf.key)}
                  className={cn(
                    'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                    statusFilter === sf.key ? 'text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  )}
                  style={statusFilter === sf.key ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                >
                  {sf.label}
                  <span className={cn(
                    'ml-1.5 px-1.5 py-0.5 rounded-full text-[10px]',
                    statusFilter === sf.key ? 'bg-white/20 text-white' : 'bg-gray-200 text-gray-500'
                  )}>
                    {sf.count}
                  </span>
                </button>
              ))}
            </div>

            {/* Tag filter */}
            {tags.length > 0 && (
              <div className="flex items-center gap-1.5">
                <Tag className="w-3 h-3 text-gray-400" />
                <select
                  value={tagFilter || ''}
                  onChange={e => setTagFilter(e.target.value || null)}
                  className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-600"
                >
                  <option value="">All tags</option>
                  {tags.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Meal filter */}
            <select
              value={mealFilter || ''}
              onChange={e => setMealFilter(e.target.value || null)}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-600"
            >
              <option value="">All meals</option>
              {mealOptions.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>

            <div className="relative sm:ml-auto">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search guests, tags..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:border-transparent w-full sm:w-56"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              />
            </div>
          </div>

          {/* Bulk actions bar */}
          {selectedGuests.size > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-center justify-between">
              <span className="text-sm font-medium text-blue-700">
                {selectedGuests.size} guest{selectedGuests.size !== 1 ? 's' : ''} selected
              </span>
              <div className="flex items-center gap-2">
                <select
                  onChange={e => { if (e.target.value) bulkUpdateStatus(e.target.value); e.target.value = '' }}
                  className="text-xs border border-blue-200 rounded-lg px-2 py-1.5 bg-white text-blue-700"
                  defaultValue=""
                >
                  <option value="" disabled>Set status...</option>
                  <option value="attending">Attending</option>
                  <option value="pending">Pending</option>
                  <option value="maybe">Maybe</option>
                  <option value="declined">Declined</option>
                </select>
                {tags.length > 0 && (
                  <select
                    onChange={e => { if (e.target.value) bulkAssignTag(e.target.value); e.target.value = '' }}
                    className="text-xs border border-blue-200 rounded-lg px-2 py-1.5 bg-white text-blue-700"
                    defaultValue=""
                  >
                    <option value="" disabled>Assign tag...</option>
                    {tags.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                )}
                <button
                  onClick={bulkDelete}
                  className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
                >
                  Delete
                </button>
                <button
                  onClick={() => setSelectedGuests(new Set())}
                  className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* Guest Table */}
          {loading ? (
            <div className="animate-pulse space-y-3">
              {[1, 2, 3, 4, 5, 6].map(i => (
                <div key={i} className="h-14 bg-gray-100 rounded-lg" />
              ))}
            </div>
          ) : filteredGuests.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
              <Users className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
              <h3 className="text-lg font-semibold mb-2" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
                {searchQuery || tagFilter || mealFilter ? 'No matching guests' : 'No guests yet'}
              </h3>
              <p className="text-gray-500 text-sm mb-4">
                {searchQuery || tagFilter || mealFilter ? 'Try a different search or filter.' : 'Start adding guests or import a CSV.'}
              </p>
              {!searchQuery && !tagFilter && !mealFilter && (
                <div className="flex items-center justify-center gap-3">
                  <button onClick={openAdd} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white" style={{ backgroundColor: 'var(--couple-primary)' }}>
                    <UserPlus className="w-4 h-4" /> Add Guest
                  </button>
                  <button onClick={() => setShowImport(true)} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50">
                    <Upload className="w-4 h-4" /> Import CSV
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-left">
                      <th className="px-3 py-3 w-10">
                        <input
                          type="checkbox"
                          checked={selectedGuests.size === filteredGuests.length && filteredGuests.length > 0}
                          onChange={toggleSelectAll}
                          className="w-4 h-4 rounded border-gray-300"
                          style={{ accentColor: 'var(--couple-primary)' }}
                        />
                      </th>
                      <th className="px-3 py-3 font-medium text-gray-500">Name</th>
                      <th className="px-3 py-3 font-medium text-gray-500 hidden sm:table-cell">Tags</th>
                      <th className="px-3 py-3 font-medium text-gray-500">RSVP</th>
                      <th className="px-3 py-3 font-medium text-gray-500 hidden md:table-cell">Meal</th>
                      <th className="px-3 py-3 font-medium text-gray-500 hidden lg:table-cell">Plus One</th>
                      <th className="px-3 py-3 w-20" />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredGuests.map(guest => {
                      const config = statusConfig(guest.rsvp_status)
                      const StatusIcon = config.icon
                      const guestTags = guest.tags || []

                      return (
                        <tr key={guest.id} className="border-b border-gray-50 group hover:bg-gray-50/50">
                          <td className="px-3 py-3">
                            <input
                              type="checkbox"
                              checked={selectedGuests.has(guest.id)}
                              onChange={() => toggleSelect(guest.id)}
                              className="w-4 h-4 rounded border-gray-300"
                              style={{ accentColor: 'var(--couple-primary)' }}
                            />
                          </td>
                          <td className="px-3 py-3">
                            <div>
                              <p className="font-medium text-gray-800">{guestName(guest)}</p>
                              <div className="flex items-center gap-2 text-xs text-gray-400 mt-0.5">
                                {guest.person?.email && <span>{guest.person.email}</span>}
                                {guest.group_name && <span className="text-gray-300">|</span>}
                                {guest.group_name && <span>{guest.group_name}</span>}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3 hidden sm:table-cell">
                            <div className="flex flex-wrap gap-1">
                              {guestTags.map(ta => ta.tag && (
                                <span
                                  key={ta.id}
                                  className="px-1.5 py-0.5 rounded text-[9px] font-medium text-white"
                                  style={{ backgroundColor: ta.tag.color }}
                                >
                                  {ta.tag.name}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${config.className}`}>
                              <StatusIcon className="w-3 h-3" />
                              {config.label}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-gray-600 hidden md:table-cell">
                            <div>
                              {guest.meal_preference || <span className="text-gray-300">--</span>}
                              {guest.dietary_restrictions && (
                                <p className="text-[10px] text-amber-600 mt-0.5">{guest.dietary_restrictions}</p>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-3 text-gray-600 hidden lg:table-cell">
                            {guest.plus_one ? (
                              <div className="text-xs">
                                <p>{guest.plus_one_name || 'Yes (unnamed)'}</p>
                                {guest.plus_one_rsvp && guest.plus_one_rsvp !== 'pending' && (
                                  <p className="text-[10px] text-gray-400">{guest.plus_one_rsvp}</p>
                                )}
                              </div>
                            ) : (
                              <span className="text-gray-300 text-xs">No</span>
                            )}
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button onClick={() => openEdit(guest)} className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100">
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => handleDelete(guest)} className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="px-5 py-3 border-t border-gray-50 text-xs text-gray-400">
                Showing {filteredGuests.length} of {stats.total} guests
              </div>
            </div>
          )}
        </>
      )}

      {/* Add/Edit Guest Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
                {editingId ? 'Edit Guest' : 'Add Guest'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Name */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
                  <input type="text" value={form.first_name} onChange={e => setForm({ ...form, first_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="First" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
                  <input type="text" value={form.last_name} onChange={e => setForm({ ...form, last_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="Last" />
                </div>
              </div>

              {/* Contact */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1"><Mail className="w-3.5 h-3.5 inline mr-1" />Email</label>
                  <input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="Optional" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1"><Phone className="w-3.5 h-3.5 inline mr-1" />Phone</label>
                  <input type="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="Optional" />
                </div>
              </div>

              {/* Address */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1"><MapPin className="w-3.5 h-3.5 inline mr-1" />Mailing Address</label>
                <input type="text" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="For invitations" />
              </div>

              {/* Group + RSVP */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Group</label>
                  <input type="text" value={form.group_name} onChange={e => setForm({ ...form, group_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="e.g., Family" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">RSVP Status</label>
                  <select value={form.rsvp_status} onChange={e => setForm({ ...form, rsvp_status: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}>
                    <option value="pending">Pending</option>
                    <option value="attending">Attending</option>
                    <option value="maybe">Maybe</option>
                    <option value="declined">Declined</option>
                  </select>
                </div>
              </div>

              {/* Meal + Dietary */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Meal Preference</label>
                  <select value={form.meal_preference} onChange={e => setForm({ ...form, meal_preference: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}>
                    <option value="">Not selected</option>
                    {mealOptions.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Dietary Restrictions</label>
                  <input type="text" value={form.dietary_restrictions} onChange={e => setForm({ ...form, dietary_restrictions: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="e.g., Gluten-free" />
                </div>
              </div>

              {/* Tags */}
              {tags.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5"><Tag className="w-3.5 h-3.5 inline mr-1" />Tags</label>
                  <div className="flex flex-wrap gap-2">
                    {tags.map(tag => {
                      const isSelected = form.tag_ids.includes(tag.id)
                      return (
                        <button
                          key={tag.id}
                          onClick={() => {
                            setForm(prev => ({
                              ...prev,
                              tag_ids: isSelected
                                ? prev.tag_ids.filter(id => id !== tag.id)
                                : [...prev.tag_ids, tag.id],
                            }))
                          }}
                          className={cn(
                            'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border-2 transition-all',
                            isSelected ? 'text-white' : 'bg-white'
                          )}
                          style={{
                            borderColor: tag.color,
                            backgroundColor: isSelected ? tag.color : undefined,
                            color: isSelected ? 'white' : tag.color,
                          }}
                        >
                          {isSelected && <Check className="w-3 h-3" />}
                          {tag.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Plus One */}
              <div className="space-y-2 border-t border-gray-100 pt-3">
                <label className="flex items-center gap-2 text-sm font-medium text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={form.plus_one} onChange={e => setForm({ ...form, plus_one: e.target.checked })}
                    className="w-4 h-4 rounded border-gray-300" style={{ accentColor: 'var(--couple-primary)' }} />
                  Has a plus one
                </label>
                {form.plus_one && (
                  <div className="grid grid-cols-3 gap-3 pl-6">
                    <input type="text" value={form.plus_one_name} onChange={e => setForm({ ...form, plus_one_name: e.target.value })}
                      className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="Name" />
                    <select value={form.plus_one_rsvp} onChange={e => setForm({ ...form, plus_one_rsvp: e.target.value })}
                      className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}>
                      <option value="pending">Pending</option>
                      <option value="attending">Attending</option>
                      <option value="declined">Declined</option>
                    </select>
                    <select value={form.plus_one_meal} onChange={e => setForm({ ...form, plus_one_meal: e.target.value })}
                      className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}>
                      <option value="">Meal...</option>
                      {mealOptions.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                )}
              </div>

              {/* Notes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} rows={2} placeholder="Internal notes..." />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors">Cancel</button>
              <button onClick={handleSave} disabled={!form.first_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}>
                {editingId ? 'Save Changes' : 'Add Guest'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tag Manager Modal */}
      {showTagManager && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowTagManager(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>Manage Tags</h2>
              <button onClick={() => setShowTagManager(false)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>

            {/* Create tag */}
            <div className="flex items-center gap-2">
              <input type="text" value={newTagName} onChange={e => setNewTagName(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="Tag name"
                onKeyDown={e => e.key === 'Enter' && createTag()} />
              <button onClick={createTag} disabled={!newTagName.trim()}
                className="p-2 rounded-lg text-white disabled:opacity-50" style={{ backgroundColor: 'var(--couple-primary)' }}>
                <Plus className="w-4 h-4" />
              </button>
            </div>

            {/* Color picker */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-500">Color:</span>
              {TAG_COLORS.map(color => (
                <button key={color} onClick={() => setNewTagColor(color)}
                  className={cn('w-6 h-6 rounded-full border-2 transition-all', newTagColor === color ? 'border-gray-700 scale-110' : 'border-gray-200')}
                  style={{ backgroundColor: color }} />
              ))}
            </div>

            {/* Existing tags */}
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {tags.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">No tags created yet.</p>
              ) : (
                tags.map(tag => (
                  <div key={tag.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50">
                    <span className="inline-flex items-center gap-2 text-sm">
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: tag.color }} />
                      {tag.name}
                      <span className="text-[10px] text-gray-400">({stats.tagDistribution[tag.name] || 0})</span>
                    </span>
                    <button onClick={() => deleteTag(tag.id)} className="text-gray-300 hover:text-red-500">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Import CSV Modal */}
      {showImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => { setShowImport(false); setImportData([]); setImportPreview(false) }} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-xl p-6 space-y-4 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>Import Guests</h2>
              <button onClick={() => { setShowImport(false); setImportData([]); setImportPreview(false) }} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>

            {!importPreview ? (
              <div className="space-y-4">
                <p className="text-sm text-gray-600">
                  Upload a CSV file with guest information. We will automatically map columns like name, email, phone, address, group, meal, and dietary.
                </p>
                <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center hover:border-gray-300 transition-colors cursor-pointer"
                  onClick={() => fileInputRef.current?.click()}>
                  <Upload className="w-8 h-8 mx-auto mb-3 text-gray-400" />
                  <p className="text-sm font-medium text-gray-700">Click to upload CSV</p>
                  <p className="text-xs text-gray-400 mt-1">or drag and drop</p>
                </div>
                <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
                <div className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs font-medium text-gray-600 mb-1">Expected columns:</p>
                  <p className="text-xs text-gray-400">First Name, Last Name, Email, Phone, Address, Group, Meal, Dietary</p>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-gray-600">
                  Preview: <strong>{importData.length}</strong> guest(s) found. All will be imported with status &quot;Pending&quot;.
                </p>
                <div className="max-h-48 overflow-auto border border-gray-100 rounded-lg">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gray-50 border-b">
                        {Object.keys(importData[0] || {}).slice(0, 5).map(h => (
                          <th key={h} className="px-3 py-2 text-left font-medium text-gray-500">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {importData.slice(0, 5).map((row, i) => (
                        <tr key={i} className="border-b border-gray-50">
                          {Object.values(row).slice(0, 5).map((val, j) => (
                            <td key={j} className="px-3 py-2 text-gray-600">{val}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {importData.length > 5 && (
                    <p className="text-xs text-gray-400 text-center py-2">...and {importData.length - 5} more</p>
                  )}
                </div>
                <div className="flex justify-end gap-3">
                  <button onClick={() => { setImportData([]); setImportPreview(false) }}
                    className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
                  <button onClick={confirmImport}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
                    style={{ backgroundColor: 'var(--couple-primary)' }}>
                    Import {importData.length} Guest{importData.length !== 1 ? 's' : ''}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
