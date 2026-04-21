'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
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
  Printer,
  Settings,
  BarChart3,
  List,
  Eye,
  Palette,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { exportToCsv } from '@/lib/utils/csv-export'
import { TagChip } from '@/components/couple/tag-chip'
import { TagPicker } from '@/components/couple/tag-picker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RsvpStatus = 'pending' | 'attending' | 'declined' | 'maybe'
type FoodMode = 'plated' | 'buffet' | 'food_trucks' | 'stations' | null
type ViewMode = 'list' | 'stats'

interface GuestTag {
  id: string
  name: string
  color: string
}

interface Guest {
  id: string
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  address: string | null
  group_side: string
  rsvp_status: RsvpStatus
  meal_choice: string | null
  dietary_restrictions: string | null
  // Tag IDs are derived from guest_tag_assignments (see guestTagMap state).
  tags: string[]
  table_assignment: string | null
  notes: string | null
  has_plus_one: boolean
  plus_one_name: string | null
  plus_one_rsvp: RsvpStatus | null
  plus_one_meal_choice: string | null
  plus_one_dietary: string | null
  invitation_sent: boolean
}

interface GuestFormData {
  first_name: string
  last_name: string
  email: string
  phone: string
  address: string
  group_side: string
  rsvp_status: RsvpStatus
  meal_choice: string
  dietary_restrictions: string
  tags: string[]
  table_assignment: string
  notes: string
  has_plus_one: boolean
  plus_one_name: string
  plus_one_rsvp: RsvpStatus
  plus_one_meal_choice: string
  plus_one_dietary: string
  invitation_sent: boolean
}

interface CsvRow {
  [key: string]: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GROUP_SIDES = ["Bride's Guest", "Groom's Guest", 'Both', 'Family']

const RSVP_OPTIONS: { value: RsvpStatus; label: string; icon: React.ReactNode; color: string; bg: string }[] = [
  { value: 'attending', label: 'Attending', icon: <CheckCircle className="w-3.5 h-3.5" />, color: 'text-green-700', bg: 'bg-green-50 border-green-200' },
  { value: 'declined', label: 'Declined', icon: <XCircle className="w-3.5 h-3.5" />, color: 'text-red-600', bg: 'bg-red-50 border-red-200' },
  { value: 'pending', label: 'Pending', icon: <Clock className="w-3.5 h-3.5" />, color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' },
  { value: 'maybe', label: 'Maybe', icon: <HelpCircle className="w-3.5 h-3.5" />, color: 'text-blue-600', bg: 'bg-blue-50 border-blue-200' },
]

const TAG_COLORS = [
  { name: 'rose', value: '#F43F5E' },
  { name: 'red', value: '#EF4444' },
  { name: 'purple', value: '#A855F7' },
  { name: 'blue', value: '#3B82F6' },
  { name: 'green', value: '#22C55E' },
  { name: 'amber', value: '#F59E0B' },
  { name: 'indigo', value: '#6366F1' },
  { name: 'pink', value: '#EC4899' },
  { name: 'teal', value: '#14B8A6' },
  { name: 'orange', value: '#F97316' },
]

const DEFAULT_MEAL_OPTIONS = ['Chicken', 'Beef', 'Fish', 'Vegetarian', 'Vegan', 'Kids Meal']

const FOOD_MODES: { value: string; label: string; emoji: string; desc: string }[] = [
  { value: 'plated', label: 'Plated', emoji: '\uD83C\uDF7D\uFE0F', desc: 'Track meal choices per guest' },
  { value: 'buffet', label: 'Buffet', emoji: '\uD83E\uDD58', desc: 'Just track dietary/allergies' },
  { value: 'food_trucks', label: 'Food Trucks', emoji: '\uD83D\uDE9A', desc: 'Just track dietary/allergies' },
  { value: 'stations', label: 'Stations', emoji: '\uD83E\uDD57', desc: 'Just track dietary/allergies' },
]

const CSV_HEADER_MAP: Record<string, string> = {
  'first name': 'first_name',
  'firstname': 'first_name',
  'given name': 'first_name',
  'first': 'first_name',
  'last name': 'last_name',
  'lastname': 'last_name',
  'surname': 'last_name',
  'family name': 'last_name',
  'last': 'last_name',
  'email': 'email',
  'email address': 'email',
  'phone': 'phone',
  'phone number': 'phone',
  'mobile': 'phone',
  'address': 'address',
  'mailing address': 'address',
  'group': 'group_side',
  'side': 'group_side',
  'table': 'table_assignment',
  'dietary': 'dietary_restrictions',
  'dietary restrictions': 'dietary_restrictions',
  'allergies': 'dietary_restrictions',
  'notes': 'notes',
  'meal': 'meal_choice',
  'meal choice': 'meal_choice',
  'meal preference': 'meal_choice',
  'rsvp': 'rsvp_status',
  'rsvp status': 'rsvp_status',
}

const EMPTY_FORM: GuestFormData = {
  first_name: '',
  last_name: '',
  email: '',
  phone: '',
  address: '',
  group_side: "Bride's Guest",
  rsvp_status: 'pending',
  meal_choice: '',
  dietary_restrictions: '',
  tags: [],
  table_assignment: '',
  notes: '',
  has_plus_one: false,
  plus_one_name: '',
  plus_one_rsvp: 'pending',
  plus_one_meal_choice: '',
  plus_one_dietary: '',
  invitation_sent: false,
}

// ---------------------------------------------------------------------------
// Guest List Page
// ---------------------------------------------------------------------------

export default function GuestListPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  // Core state
  const [guests, setGuests] = useState<Guest[]>([])
  const [loading, setLoading] = useState(true)
  const [foodMode, setFoodMode] = useState<FoodMode>(null)
  const [showFoodSetup, setShowFoodSetup] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('list')

  // Tags & Meals
  const [tags, setTags] = useState<GuestTag[]>([])
  // Normalized tag assignments: guest_id -> tag_id[]
  const [guestTagMap, setGuestTagMap] = useState<Record<string, string[]>>({})
  // Row where the tag picker popover is open
  const [tagPickerGuestId, setTagPickerGuestId] = useState<string | null>(null)
  const [mealOptions, setMealOptions] = useState<string[]>(DEFAULT_MEAL_OPTIONS)

  // Modals
  const [showGuestModal, setShowGuestModal] = useState(false)
  const [showSettingsModal, setShowSettingsModal] = useState(false)
  const [showCsvModal, setShowCsvModal] = useState(false)
  const [showBulkModal, setShowBulkModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<GuestFormData>(EMPTY_FORM)

  // Tags settings
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[0].value)
  const [newMealOption, setNewMealOption] = useState('')

  // Filters
  const [searchQuery, setSearchQuery] = useState('')
  const [filterRsvp, setFilterRsvp] = useState<RsvpStatus | 'all'>('all')
  // Multi-select tag filter: empty set means no filter
  const [filterTagIds, setFilterTagIds] = useState<Set<string>>(new Set())
  const [showTagFilterMenu, setShowTagFilterMenu] = useState(false)
  const [filterMeal, setFilterMeal] = useState<string>('all')
  const [filterDietary, setFilterDietary] = useState<string>('all')
  const [filterTable, setFilterTable] = useState<string>('all')
  // Sort option: 'name' (last name) or 'tag' (primary tag name)
  const [sortBy, setSortBy] = useState<'name' | 'tag'>('name')

  // Bulk actions
  const [selectedGuests, setSelectedGuests] = useState<Set<string>>(new Set())
  const [bulkAction, setBulkAction] = useState('')
  const [bulkValue, setBulkValue] = useState('')

  // CSV import
  const [csvData, setCsvData] = useState<CsvRow[]>([])
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [csvMapping, setCsvMapping] = useState<Record<string, string>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)

  const supabase = createClient()
  const isPlated = foodMode === 'plated'

  // ---- Fetch ----
  const fetchGuests = useCallback(async () => {
    if (!weddingId) return
    const { data, error } = await supabase
      .from('guest_list')
      .select('*')
      .eq('wedding_id', weddingId)
      .order('last_name', { ascending: true })

    if (!error && data) {
      const guestIds = (data as Record<string, unknown>[]).map((d) => d.id as string)

      // Load tag assignments in a separate query, build guest_id -> tag_id[] map
      let tagMap: Record<string, string[]> = {}
      if (guestIds.length > 0) {
        const { data: assignmentData } = await supabase
          .from('guest_tag_assignments')
          .select('guest_id, tag_id')
          .in('guest_id', guestIds)
        if (assignmentData) {
          for (const row of assignmentData as { guest_id: string; tag_id: string }[]) {
            if (!tagMap[row.guest_id]) tagMap[row.guest_id] = []
            tagMap[row.guest_id].push(row.tag_id)
          }
        }
      }
      setGuestTagMap(tagMap)

      setGuests(
        data.map((d: Record<string, unknown>) => ({
          id: d.id as string,
          first_name: (d.first_name as string) || '',
          last_name: (d.last_name as string) || '',
          email: d.email as string | null,
          phone: d.phone as string | null,
          address: d.address as string | null,
          group_side: (d.group_side as string) || "Bride's Guest",
          rsvp_status: (d.rsvp_status as RsvpStatus) || 'pending',
          meal_choice: (d.meal_choice as string | null) || (d.meal_preference as string | null),
          dietary_restrictions: d.dietary_restrictions as string | null,
          tags: tagMap[d.id as string] || [],
          table_assignment: d.table_assignment as string | null,
          notes: d.notes as string | null,
          has_plus_one: (d.has_plus_one as boolean) || (d.plus_one as boolean) || false,
          plus_one_name: d.plus_one_name as string | null,
          plus_one_rsvp: d.plus_one_rsvp as RsvpStatus | null,
          plus_one_meal_choice: d.plus_one_meal_choice as string | null,
          plus_one_dietary: d.plus_one_dietary as string | null,
          invitation_sent: (d.invitation_sent as boolean) || false,
        }))
      )
    }
    setLoading(false)
  }, [supabase, weddingId])

  const fetchConfig = useCallback(async () => {
    if (!weddingId) return
    // 1. Get plated_meal from wedding_config
    const { data: configData } = await supabase
      .from('wedding_config')
      .select('plated_meal')
      .eq('wedding_id', weddingId)
      .single()

    if (configData) {
      const d = configData as Record<string, unknown>
      if (d.plated_meal === true) {
        setFoodMode('plated')
      } else if (d.plated_meal === false) {
        setFoodMode('buffet')
      } else {
        setShowFoodSetup(true)
      }
    } else {
      setShowFoodSetup(true)
    }

    // 2. Get tags from guest_tags table
    const { data: tagData } = await supabase
      .from('guest_tags')
      .select('id, tag_name, color')
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: true })

    if (tagData && tagData.length > 0) {
      setTags(tagData.map((t: Record<string, unknown>) => ({
        id: t.id as string,
        name: t.tag_name as string,
        color: (t.color as string) || '#3B82F6',
      })))
    }

    // 3. Get meal options from guest_meal_options table
    const { data: mealData } = await supabase
      .from('guest_meal_options')
      .select('option_name')
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: true })

    if (mealData && mealData.length > 0) {
      setMealOptions(mealData.map((m: Record<string, unknown>) => m.option_name as string))
    }
  }, [supabase, weddingId])

  // BUG-04A: wait for weddingId before firing fetch.
  useEffect(() => {
    if (!weddingId) return
    fetchGuests()
    fetchConfig()
  }, [weddingId, fetchGuests, fetchConfig])

  // ---- Save config helper ----
  async function saveConfig(updates: Record<string, unknown>) {
    await supabase
      .from('wedding_config')
      .upsert({ wedding_id: weddingId, ...updates }, { onConflict: 'wedding_id' })
  }

  // ---- Food mode setup ----
  async function selectFoodMode(mode: FoodMode) {
    setFoodMode(mode)
    setShowFoodSetup(false)
    // plated_meal is a boolean: true = plated, false = anything else (buffet/trucks/stations)
    await saveConfig({ plated_meal: mode === 'plated' })
  }

  // ---- Computed stats ----
  const stats = useMemo(() => {
    const total = guests.length
    const plusOnes = guests.filter((g) => g.has_plus_one).length
    const totalWithPO = total + plusOnes

    const attending = guests.filter((g) => g.rsvp_status === 'attending').length
    const attendingPO = guests.filter((g) => g.has_plus_one && g.plus_one_rsvp === 'attending').length
    const declined = guests.filter((g) => g.rsvp_status === 'declined').length
    const declinedPO = guests.filter((g) => g.has_plus_one && g.plus_one_rsvp === 'declined').length
    const pending = guests.filter((g) => g.rsvp_status === 'pending').length
    const pendingPO = guests.filter((g) => g.has_plus_one && g.plus_one_rsvp === 'pending').length
    const maybe = guests.filter((g) => g.rsvp_status === 'maybe').length
    const maybePO = guests.filter((g) => g.has_plus_one && g.plus_one_rsvp === 'maybe').length
    const invSent = guests.filter((g) => g.invitation_sent).length

    // Meal breakdown
    const mealCounts: Record<string, number> = {}
    guests.forEach((g) => {
      if (g.meal_choice) mealCounts[g.meal_choice] = (mealCounts[g.meal_choice] || 0) + 1
      if (g.has_plus_one && g.plus_one_meal_choice)
        mealCounts[g.plus_one_meal_choice] = (mealCounts[g.plus_one_meal_choice] || 0) + 1
    })

    // Dietary compilation
    const dietaryList: string[] = []
    guests.forEach((g) => {
      if (g.dietary_restrictions) dietaryList.push(`${g.first_name} ${g.last_name}: ${g.dietary_restrictions}`)
      if (g.has_plus_one && g.plus_one_dietary && g.plus_one_name) dietaryList.push(`${g.plus_one_name}: ${g.plus_one_dietary}`)
    })

    // Tag distribution
    const tagCounts: Record<string, number> = {}
    guests.forEach((g) => {
      (g.tags || []).forEach((tid) => {
        tagCounts[tid] = (tagCounts[tid] || 0) + 1
      })
    })

    return {
      total, plusOnes, totalWithPO,
      attending: attending + attendingPO, attendingGuests: attending, attendingPO,
      declined: declined + declinedPO, declinedGuests: declined, declinedPO,
      pending: pending + pendingPO, pendingGuests: pending, pendingPO,
      maybe: maybe + maybePO, maybeGuests: maybe, maybePO,
      invSent, mealCounts, dietaryList, tagCounts,
    }
  }, [guests])

  // ---- Filtering ----
  const filteredGuests = useMemo(() => {
    const filtered = guests.filter((g) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const fullName = `${g.first_name} ${g.last_name}`.toLowerCase()
        if (
          !fullName.includes(q) &&
          !(g.email || '').toLowerCase().includes(q) &&
          !g.group_side.toLowerCase().includes(q) &&
          !(g.tags || []).some((tid) => {
            const tag = tags.find((t) => t.id === tid)
            return tag?.name.toLowerCase().includes(q)
          })
        ) return false
      }
      if (filterRsvp !== 'all' && g.rsvp_status !== filterRsvp) return false
      // Multi-select tag filter: match if guest has ANY of the selected tags
      if (filterTagIds.size > 0) {
        const guestTags = g.tags || []
        const hasAny = guestTags.some((tid) => filterTagIds.has(tid))
        if (!hasAny) return false
      }
      if (filterMeal !== 'all' && g.meal_choice !== filterMeal) return false
      if (filterDietary === 'has' && !g.dietary_restrictions) return false
      if (filterDietary === 'none' && g.dietary_restrictions) return false
      if (filterTable !== 'all' && g.table_assignment !== filterTable) return false
      return true
    })

    // Sorting
    if (sortBy === 'tag') {
      return [...filtered].sort((a, b) => {
        const aTagName = a.tags.length > 0
          ? (tags.find((t) => t.id === a.tags[0])?.name || '~')
          : '~~' // Guests without tags sort to end
        const bTagName = b.tags.length > 0
          ? (tags.find((t) => t.id === b.tags[0])?.name || '~')
          : '~~'
        const cmp = aTagName.localeCompare(bTagName)
        if (cmp !== 0) return cmp
        return (a.last_name || '').localeCompare(b.last_name || '')
      })
    }
    return filtered
  }, [guests, searchQuery, filterRsvp, filterTagIds, filterMeal, filterDietary, filterTable, tags, sortBy])

  // ---- Unique tables for filter ----
  const uniqueTables = useMemo(() => {
    const tables = new Set(guests.map((g) => g.table_assignment).filter(Boolean) as string[])
    return [...tables].sort()
  }, [guests])

  // ---- Guest CRUD ----
  function openAddGuest() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowGuestModal(true)
  }

  function openEditGuest(guest: Guest) {
    setForm({
      first_name: guest.first_name,
      last_name: guest.last_name,
      email: guest.email || '',
      phone: guest.phone || '',
      address: guest.address || '',
      group_side: guest.group_side,
      rsvp_status: guest.rsvp_status,
      meal_choice: guest.meal_choice || '',
      dietary_restrictions: guest.dietary_restrictions || '',
      tags: guest.tags || [],
      table_assignment: guest.table_assignment || '',
      notes: guest.notes || '',
      has_plus_one: guest.has_plus_one,
      plus_one_name: guest.plus_one_name || '',
      plus_one_rsvp: guest.plus_one_rsvp || 'pending',
      plus_one_meal_choice: guest.plus_one_meal_choice || '',
      plus_one_dietary: guest.plus_one_dietary || '',
      invitation_sent: guest.invitation_sent,
    })
    setEditingId(guest.id)
    setShowGuestModal(true)
  }

  async function handleSaveGuest() {
    if (!form.first_name.trim()) return

    // Note: guest_list does NOT have a `tags` column — tags live in
    // guest_tag_assignments and are synced separately below.
    const payload = {
      venue_id: venueId,
      wedding_id: weddingId,
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      address: form.address.trim() || null,
      group_side: form.group_side,
      rsvp_status: form.rsvp_status,
      meal_choice: form.meal_choice || null,
      dietary_restrictions: form.dietary_restrictions.trim() || null,
      table_assignment: form.table_assignment.trim() || null,
      notes: form.notes.trim() || null,
      has_plus_one: form.has_plus_one,
      plus_one_name: form.has_plus_one ? form.plus_one_name.trim() || null : null,
      plus_one_rsvp: form.has_plus_one ? form.plus_one_rsvp : null,
      plus_one_meal_choice: form.has_plus_one ? form.plus_one_meal_choice || null : null,
      plus_one_dietary: form.has_plus_one ? form.plus_one_dietary.trim() || null : null,
      invitation_sent: form.invitation_sent,
    }

    let guestId = editingId
    if (editingId) {
      await supabase.from('guest_list').update(payload).eq('id', editingId)
    } else {
      const { data: inserted } = await supabase
        .from('guest_list')
        .insert(payload)
        .select('id')
        .single()
      if (inserted) guestId = (inserted as { id: string }).id
    }

    // Sync tag assignments
    if (guestId) {
      await syncGuestTagAssignments(guestId, form.tags)
    }

    setShowGuestModal(false)
    setEditingId(null)
    fetchGuests()
  }

  // Replace the full set of tag assignments for a guest with the provided
  // list of tag IDs. Uses delete-all-then-insert for simplicity.
  async function syncGuestTagAssignments(guestId: string, tagIds: string[]) {
    await supabase.from('guest_tag_assignments').delete().eq('guest_id', guestId)
    if (tagIds.length > 0) {
      const rows = tagIds.map((tid) => ({ guest_id: guestId, tag_id: tid }))
      await supabase.from('guest_tag_assignments').insert(rows)
    }
  }

  async function handleDeleteGuest(id: string) {
    if (!confirm('Remove this guest?')) return
    await supabase.from('guest_list').delete().eq('id', id)
    setGuests((prev) => prev.filter((g) => g.id !== id))
    setSelectedGuests((prev) => { const n = new Set(prev); n.delete(id); return n })
  }

  async function quickUpdateRsvp(id: string, status: RsvpStatus) {
    await supabase.from('guest_list').update({ rsvp_status: status }).eq('id', id)
    setGuests((prev) => prev.map((g) => (g.id === id ? { ...g, rsvp_status: status } : g)))
  }

  // ---- Tag management ----
  async function addTag() {
    if (!newTagName.trim()) return
    const tagId = crypto.randomUUID()
    const { error } = await supabase.from('guest_tags').insert({
      id: tagId,
      venue_id: venueId,
      wedding_id: weddingId,
      tag_name: newTagName.trim(),
      color: newTagColor,
    })
    if (!error) {
      const tag: GuestTag = { id: tagId, name: newTagName.trim(), color: newTagColor }
      setTags((prev) => [...prev, tag])
      setNewTagName('')
    }
  }

  async function deleteTag(id: string) {
    // Cascade delete assignments, then the tag itself
    await supabase.from('guest_tag_assignments').delete().eq('tag_id', id)
    await supabase.from('guest_tags').delete().eq('id', id)
    setTags((prev) => prev.filter((t) => t.id !== id))
    fetchGuests()
  }

  function toggleFormTag(tagId: string) {
    setForm((prev) => {
      const has = prev.tags.includes(tagId)
      if (has) return { ...prev, tags: prev.tags.filter((t) => t !== tagId) }
      if (prev.tags.length >= 4) return prev
      return { ...prev, tags: [...prev.tags, tagId] }
    })
  }

  // ---- Row-level tag toggle (from picker popover) ----
  async function toggleGuestTag(guestId: string, tagId: string) {
    const current = guestTagMap[guestId] || []
    const has = current.includes(tagId)
    if (has) {
      await supabase
        .from('guest_tag_assignments')
        .delete()
        .eq('guest_id', guestId)
        .eq('tag_id', tagId)
      const next = current.filter((t) => t !== tagId)
      setGuestTagMap((prev) => ({ ...prev, [guestId]: next }))
      setGuests((prev) => prev.map((g) => (g.id === guestId ? { ...g, tags: next } : g)))
    } else {
      await supabase
        .from('guest_tag_assignments')
        .insert({ guest_id: guestId, tag_id: tagId })
      const next = [...current, tagId]
      setGuestTagMap((prev) => ({ ...prev, [guestId]: next }))
      setGuests((prev) => prev.map((g) => (g.id === guestId ? { ...g, tags: next } : g)))
    }
  }

  // ---- Meal options management ----
  async function addMealOption() {
    if (!newMealOption.trim() || mealOptions.includes(newMealOption.trim())) return
    const { error } = await supabase.from('guest_meal_options').insert({
      venue_id: venueId,
      wedding_id: weddingId,
      option_name: newMealOption.trim(),
    })
    if (!error) {
      setMealOptions((prev) => [...prev, newMealOption.trim()])
      setNewMealOption('')
    }
  }

  async function removeMealOption(opt: string) {
    await supabase
      .from('guest_meal_options')
      .delete()
      .eq('wedding_id', weddingId)
      .eq('option_name', opt)
    setMealOptions((prev) => prev.filter((m) => m !== opt))
  }

  // ---- CSV Import ----
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (evt) => {
      const text = evt.target?.result as string
      if (!text) return
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
      if (lines.length < 2) return

      const headers = lines[0].split(',').map((h) => h.replace(/"/g, '').trim())
      setCsvHeaders(headers)

      // Auto-map headers
      const mapping: Record<string, string> = {}
      headers.forEach((h) => {
        const key = h.toLowerCase().trim()
        if (CSV_HEADER_MAP[key]) mapping[h] = CSV_HEADER_MAP[key]
      })
      setCsvMapping(mapping)

      // Parse rows
      const rows: CsvRow[] = []
      for (let i = 1; i < lines.length && i <= 100; i++) {
        const vals = lines[i].split(',').map((v) => v.replace(/"/g, '').trim())
        const row: CsvRow = {}
        headers.forEach((h, idx) => {
          row[h] = vals[idx] || ''
        })
        rows.push(row)
      }
      setCsvData(rows)
      setShowCsvModal(true)
    }
    reader.readAsText(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function importCsv() {
    const toInsert = csvData.map((row) => {
      const guest: Record<string, unknown> = {
        venue_id: venueId,
        wedding_id: weddingId,
        rsvp_status: 'pending',
        has_plus_one: false,
        invitation_sent: false,
      }
      Object.entries(csvMapping).forEach(([csvHeader, field]) => {
        if (row[csvHeader]) guest[field] = row[csvHeader]
      })
      if (!guest.first_name) guest.first_name = 'Unknown'
      return guest
    })

    if (toInsert.length > 0) {
      await supabase.from('guest_list').insert(toInsert)
    }
    setShowCsvModal(false)
    setCsvData([])
    setCsvHeaders([])
    setCsvMapping({})
    fetchGuests()
  }

  // ---- Print Full Guest List ----
  function printGuestList() {
    const rows = filteredGuests.map(g => `
      <tr>
        <td style="padding:4px 8px;white-space:nowrap">${g.first_name} ${g.last_name || ''}</td>
        <td style="padding:4px 8px">${g.rsvp_status === 'attending' ? 'Attending' : g.rsvp_status === 'declined' ? 'Declined' : 'Pending'}</td>
        <td style="padding:4px 8px;font-size:11px">${g.phone || ''}</td>
        <td style="padding:4px 8px;font-size:11px">${g.email || ''}</td>
        <td style="padding:4px 8px">${g.dietary_restrictions || ''}</td>
        <td style="padding:4px 8px">${g.meal_choice || ''}</td>
        <td style="padding:4px 8px">${g.table_assignment || ''}</td>
        <td style="padding:4px 8px">${g.has_plus_one ? g.plus_one_name || 'Yes' : ''}</td>
        <td style="padding:4px 8px;font-size:11px">${g.notes || ''}</td>
      </tr>`).join('')
    const attending = guests.filter(g => g.rsvp_status === 'attending').length
    const declined = guests.filter(g => g.rsvp_status === 'declined').length
    const html = `<!DOCTYPE html><html><head><title>Guest List</title>
      <style>body{font-family:sans-serif;padding:20px;font-size:12px}
      h1{font-size:18px;margin-bottom:4px}
      .stats{color:#666;font-size:13px;margin-bottom:16px}
      table{width:100%;border-collapse:collapse}
      th{text-align:left;padding:4px 8px;font-size:10px;color:#666;border-bottom:2px solid #333;text-transform:uppercase}
      td{border-bottom:1px solid #eee}
      @media print{button{display:none}@page{size:landscape;margin:1cm}}</style></head>
      <body>
      <h1>Guest List</h1>
      <p class="stats">${guests.length} total | ${attending} attending | ${declined} declined | ${guests.length - attending - declined} pending</p>
      <table><thead><tr><th>Name</th><th>RSVP</th><th>Phone</th><th>Email</th><th>Dietary</th><th>Meal</th><th>Table</th><th>Plus One</th><th>Notes</th></tr></thead>
      <tbody>${rows}</tbody></table></body></html>`
    const w = window.open('', '_blank')
    if (w) { w.document.write(html); w.document.close(); w.print() }
  }

  // ---- CSV Export ----
  function exportCsv() {
    const columns = [
      { key: 'first_name', label: 'First Name' },
      { key: 'last_name', label: 'Last Name' },
      { key: 'email', label: 'Email' },
      { key: 'phone', label: 'Phone' },
      { key: 'group_side', label: 'Group' },
      { key: 'rsvp_status', label: 'RSVP' },
      { key: 'meal_choice', label: 'Meal' },
      { key: 'dietary_restrictions', label: 'Dietary' },
      { key: 'table_assignment', label: 'Table' },
      { key: 'plus_one', label: 'Plus One' },
      { key: 'plus_one_meal_choice', label: 'Plus One Meal' },
      { key: 'plus_one_dietary', label: 'Plus One Dietary' },
    ]
    const rows = guests.map((g) => ({
      first_name: g.first_name,
      last_name: g.last_name,
      email: g.email || '',
      phone: g.phone || '',
      group_side: g.group_side,
      rsvp_status: g.rsvp_status,
      meal_choice: g.meal_choice || '',
      dietary_restrictions: g.dietary_restrictions || '',
      table_assignment: g.table_assignment || '',
      plus_one: g.has_plus_one ? g.plus_one_name || 'Yes' : '',
      plus_one_meal_choice: g.plus_one_meal_choice || '',
      plus_one_dietary: g.plus_one_dietary || '',
    }))
    exportToCsv('guest-list.csv', columns, rows)
  }

  // ---- Bulk actions ----
  function toggleSelectAll() {
    if (selectedGuests.size === filteredGuests.length) {
      setSelectedGuests(new Set())
    } else {
      setSelectedGuests(new Set(filteredGuests.map((g) => g.id)))
    }
  }

  function toggleSelect(id: string) {
    setSelectedGuests((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function executeBulkAction() {
    if (!bulkAction || selectedGuests.size === 0) return

    const ids = [...selectedGuests]

    if (bulkAction === 'delete') {
      if (!confirm(`Delete ${ids.length} guest(s)?`)) return
      for (const id of ids) {
        await supabase.from('guest_list').delete().eq('id', id)
      }
    } else if (bulkAction === 'rsvp') {
      for (const id of ids) {
        await supabase.from('guest_list').update({ rsvp_status: bulkValue }).eq('id', id)
      }
    } else if (bulkAction === 'tag') {
      // Assign selected tag to each guest via guest_tag_assignments
      for (const id of ids) {
        const guest = guests.find((g) => g.id === id)
        if (guest && !guest.tags.includes(bulkValue)) {
          await supabase
            .from('guest_tag_assignments')
            .insert({ guest_id: id, tag_id: bulkValue })
        }
      }
    }

    setSelectedGuests(new Set())
    setBulkAction('')
    setBulkValue('')
    setShowBulkModal(false)
    fetchGuests()
  }

  // ---- RSVP badge ----
  function rsvpBadge(status: RsvpStatus) {
    const opt = RSVP_OPTIONS.find((o) => o.value === status)
    if (!opt) return null
    return (
      <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border', opt.bg, opt.color)}>
        {opt.icon}
        {opt.label}
      </span>
    )
  }

  // ---- Food Mode Setup Modal ----
  if (showFoodSetup) {
    return (
      <div className="max-w-lg mx-auto mt-16">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-8 text-center">
          <Utensils className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.6 }} />
          <h2
            className="text-2xl font-bold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            How are you serving food?
          </h2>
          <p className="text-gray-500 text-sm mb-6">
            This helps us set up your guest list with the right columns.
          </p>
          <div className="grid grid-cols-2 gap-3">
            {FOOD_MODES.map((mode) => (
              <button
                key={mode.value}
                onClick={() => selectFoodMode(mode.value as FoodMode)}
                className="p-4 border border-gray-200 rounded-xl hover:border-gray-400 hover:bg-gray-50 transition-all text-left"
              >
                <span className="text-2xl block mb-1">{mode.emoji}</span>
                <p className="text-sm font-semibold text-gray-800">{mode.label}</p>
                <p className="text-xs text-gray-500 mt-0.5">{mode.desc}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ---- Main Render ----
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1
            className="text-3xl font-bold mb-1"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Guest List
          </h1>
          <p className="text-gray-500 text-sm">
            {stats.total} guest{stats.total !== 1 ? 's' : ''}{stats.plusOnes > 0 ? ` + ${stats.plusOnes} plus-one${stats.plusOnes !== 1 ? 's' : ''}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode('list')}
              className={cn(
                'px-3 py-2 text-xs font-medium',
                viewMode === 'list' ? 'text-white' : 'text-gray-500 hover:bg-gray-50'
              )}
              style={viewMode === 'list' ? { backgroundColor: 'var(--couple-primary)' } : undefined}
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode('stats')}
              className={cn(
                'px-3 py-2 text-xs font-medium',
                viewMode === 'stats' ? 'text-white' : 'text-gray-500 hover:bg-gray-50'
              )}
              style={viewMode === 'stats' ? { backgroundColor: 'var(--couple-primary)' } : undefined}
            >
              <BarChart3 className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            onClick={() => setShowSettingsModal(true)}
            className="p-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            onClick={printGuestList}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            <Printer className="w-3.5 h-3.5" />
            Print
          </button>
          <button
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
          >
            <Download className="w-3.5 h-3.5" />
            Export
          </button>
          <label className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 cursor-pointer">
            <Upload className="w-3.5 h-3.5" />
            Import
            <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleFileSelect} />
          </label>
          <button
            onClick={openAddGuest}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add Guest
          </button>
        </div>
      </div>

      {/* RSVP Stats Dashboard */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          <div className="p-3 bg-gray-50 rounded-lg text-center">
            <p className="text-xs text-gray-500 mb-0.5">Total</p>
            <p className="text-xl font-bold text-gray-900">{stats.totalWithPO}</p>
            <p className="text-[10px] text-gray-400">{stats.total} guests{stats.plusOnes > 0 ? ` + ${stats.plusOnes} +1s` : ''}</p>
          </div>
          <button onClick={() => setFilterRsvp(filterRsvp === 'attending' ? 'all' : 'attending')} className={cn('p-3 rounded-lg text-center transition-colors', filterRsvp === 'attending' ? 'bg-green-100 ring-1 ring-green-300' : 'bg-green-50 hover:bg-green-100')}>
            <p className="text-xs text-green-700 mb-0.5">Attending</p>
            <p className="text-xl font-bold text-green-800">{stats.attending}</p>
          </button>
          <button onClick={() => setFilterRsvp(filterRsvp === 'declined' ? 'all' : 'declined')} className={cn('p-3 rounded-lg text-center transition-colors', filterRsvp === 'declined' ? 'bg-red-100 ring-1 ring-red-300' : 'bg-red-50 hover:bg-red-100')}>
            <p className="text-xs text-red-600 mb-0.5">Declined</p>
            <p className="text-xl font-bold text-red-700">{stats.declined}</p>
          </button>
          <button onClick={() => setFilterRsvp(filterRsvp === 'pending' ? 'all' : 'pending')} className={cn('p-3 rounded-lg text-center transition-colors', filterRsvp === 'pending' ? 'bg-amber-100 ring-1 ring-amber-300' : 'bg-amber-50 hover:bg-amber-100')}>
            <p className="text-xs text-amber-700 mb-0.5">Pending</p>
            <p className="text-xl font-bold text-amber-800">{stats.pending}</p>
          </button>
          <button onClick={() => setFilterRsvp(filterRsvp === 'maybe' ? 'all' : 'maybe')} className={cn('p-3 rounded-lg text-center transition-colors', filterRsvp === 'maybe' ? 'bg-blue-100 ring-1 ring-blue-300' : 'bg-blue-50 hover:bg-blue-100')}>
            <p className="text-xs text-blue-600 mb-0.5">Maybe</p>
            <p className="text-xl font-bold text-blue-700">{stats.maybe}</p>
          </button>
        </div>
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
          <span>{stats.invSent} invitation{stats.invSent !== 1 ? 's' : ''} sent</span>
          {filterRsvp !== 'all' && (
            <button onClick={() => setFilterRsvp('all')} className="text-xs font-medium hover:underline" style={{ color: 'var(--couple-primary)' }}>
              Clear filter
            </button>
          )}
        </div>
      </div>

      {/* Stats View */}
      {viewMode === 'stats' && (
        <div className="space-y-4">
          {/* Meal Breakdown */}
          {isPlated && Object.keys(stats.mealCounts).length > 0 && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
                <Utensils className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
                Meal Breakdown
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {Object.entries(stats.mealCounts).sort((a, b) => b[1] - a[1]).map(([meal, count]) => (
                  <div key={meal} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                    <span className="text-sm text-gray-700">{meal}</span>
                    <span className="text-sm font-bold" style={{ color: 'var(--couple-primary)' }}>{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Dietary Restrictions */}
          {stats.dietaryList.length > 0 && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                Dietary Restrictions ({stats.dietaryList.length})
              </h3>
              <div className="space-y-1.5">
                {stats.dietaryList.map((item, i) => (
                  <p key={i} className="text-sm text-gray-700">{item}</p>
                ))}
              </div>
            </div>
          )}

          {/* Tag Distribution */}
          {tags.length > 0 && Object.keys(stats.tagCounts).length > 0 && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <h3 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-2">
                <Tag className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
                Tag Distribution
              </h3>
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-white"
                    style={{ backgroundColor: tag.color }}
                  >
                    {tag.name}: {stats.tagCounts[tag.id] || 0}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* List View */}
      {viewMode === 'list' && (
        <>
          {/* Filter & Search Bar */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by name, email, tag..."
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              />
            </div>

            {/* Tag filter (multi-select popover) */}
            {tags.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setShowTagFilterMenu((v) => !v)}
                  className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white hover:border-gray-300 focus:outline-none focus:ring-2"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                >
                  <Tag className="w-3.5 h-3.5 text-gray-400" />
                  {filterTagIds.size === 0
                    ? 'Filter by tag'
                    : `${filterTagIds.size} tag${filterTagIds.size === 1 ? '' : 's'}`}
                  <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                </button>
                {showTagFilterMenu && (
                  <div className="absolute left-0 top-full mt-1 z-40">
                    <TagPicker
                      tags={tags}
                      selectedIds={[...filterTagIds]}
                      onToggle={(tid) => {
                        setFilterTagIds((prev) => {
                          const next = new Set(prev)
                          if (next.has(tid)) next.delete(tid)
                          else next.add(tid)
                          return next
                        })
                      }}
                      onClose={() => setShowTagFilterMenu(false)}
                      title="Filter by tag"
                    />
                  </div>
                )}
                {filterTagIds.size > 0 && (
                  <button
                    onClick={() => setFilterTagIds(new Set())}
                    className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-gray-300 hover:bg-gray-400 text-white flex items-center justify-center"
                    aria-label="Clear tag filter"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                )}
              </div>
            )}

            {/* Sort by */}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as 'name' | 'tag')}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              title="Sort by"
            >
              <option value="name">Sort: Name</option>
              <option value="tag">Sort: Tag</option>
            </select>

            {/* Meal filter (plated only) */}
            {isPlated && (
              <select
                value={filterMeal}
                onChange={(e) => setFilterMeal(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              >
                <option value="all">All Meals</option>
                {mealOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            )}

            {/* Dietary filter */}
            <select
              value={filterDietary}
              onChange={(e) => setFilterDietary(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            >
              <option value="all">All Dietary</option>
              <option value="has">Has Dietary</option>
              <option value="none">No Dietary</option>
            </select>

            {/* Table filter */}
            {uniqueTables.length > 0 && (
              <select
                value={filterTable}
                onChange={(e) => setFilterTable(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
              >
                <option value="all">All Tables</option>
                {uniqueTables.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            )}
          </div>

          {/* Bulk Actions Bar */}
          {selectedGuests.size > 0 && (
            <div className="flex items-center gap-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-xl">
              <span className="text-sm font-medium text-blue-800">
                {selectedGuests.size} selected
              </span>
              <button
                onClick={() => { setBulkAction('rsvp'); setBulkValue('attending'); setShowBulkModal(true) }}
                className="text-xs font-medium px-2 py-1 rounded bg-green-100 text-green-700 hover:bg-green-200"
              >
                Set RSVP
              </button>
              <button
                onClick={() => { setBulkAction('tag'); setBulkValue(tags[0]?.id || ''); setShowBulkModal(true) }}
                className="text-xs font-medium px-2 py-1 rounded bg-purple-100 text-purple-700 hover:bg-purple-200"
                disabled={tags.length === 0}
              >
                Assign Tag
              </button>
              <button
                onClick={() => { setBulkAction('delete'); executeBulkAction() }}
                className="text-xs font-medium px-2 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200"
              >
                Delete
              </button>
              <button
                onClick={() => setSelectedGuests(new Set())}
                className="text-xs text-gray-500 hover:text-gray-700 ml-auto"
              >
                Clear selection
              </button>
            </div>
          )}

          {/* Guest Cards */}
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="animate-pulse h-20 bg-gray-100 rounded-xl" />
              ))}
            </div>
          ) : filteredGuests.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
              <Users className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
              <h3
                className="text-lg font-semibold mb-2"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {searchQuery || filterRsvp !== 'all' || filterTagIds.size > 0 ? 'No matching guests' : 'No guests yet'}
              </h3>
              <p className="text-gray-500 text-sm mb-4">
                {searchQuery ? 'Try a different search.' : 'Add your first guest or import a CSV.'}
              </p>
              {!searchQuery && filterRsvp === 'all' && filterTagIds.size === 0 && (
                <button
                  onClick={openAddGuest}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
                  style={{ backgroundColor: 'var(--couple-primary)' }}
                >
                  <Plus className="w-4 h-4" />
                  Add First Guest
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {/* Select all */}
              <div className="flex items-center gap-3 px-4 py-2">
                <button
                  onClick={toggleSelectAll}
                  className={cn(
                    'w-4 h-4 rounded border flex items-center justify-center transition-colors',
                    selectedGuests.size === filteredGuests.length && filteredGuests.length > 0
                      ? 'border-transparent text-white'
                      : 'border-gray-300 hover:border-gray-400'
                  )}
                  style={
                    selectedGuests.size === filteredGuests.length && filteredGuests.length > 0
                      ? { backgroundColor: 'var(--couple-primary)' }
                      : undefined
                  }
                >
                  {selectedGuests.size === filteredGuests.length && filteredGuests.length > 0 && (
                    <Check className="w-3 h-3" />
                  )}
                </button>
                <span className="text-xs text-gray-400">
                  {filteredGuests.length} guest{filteredGuests.length !== 1 ? 's' : ''}
                </span>
              </div>

              {filteredGuests.map((guest) => (
                <div
                  key={guest.id}
                  className={cn(
                    'bg-white rounded-xl border shadow-sm p-4 group transition-all hover:border-gray-200',
                    selectedGuests.has(guest.id) ? 'border-blue-300 bg-blue-50/30' : 'border-gray-100'
                  )}
                >
                  <div className="flex items-start gap-3">
                    {/* Checkbox */}
                    <button
                      onClick={() => toggleSelect(guest.id)}
                      className={cn(
                        'w-4 h-4 rounded border flex items-center justify-center shrink-0 mt-1 transition-colors',
                        selectedGuests.has(guest.id) ? 'border-transparent text-white' : 'border-gray-300'
                      )}
                      style={selectedGuests.has(guest.id) ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                    >
                      {selectedGuests.has(guest.id) && <Check className="w-3 h-3" />}
                    </button>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-semibold text-gray-800">
                              {guest.first_name} {guest.last_name}
                            </p>
                            {rsvpBadge(guest.rsvp_status)}
                            {guest.invitation_sent && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] text-gray-400">
                                <Mail className="w-2.5 h-2.5" /> sent
                              </span>
                            )}
                          </div>

                          {/* Details row */}
                          <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-gray-500">
                            <span className="inline-flex items-center gap-1">
                              <Users className="w-3 h-3" />
                              {guest.group_side}
                            </span>
                            {guest.email && (
                              <span className="inline-flex items-center gap-1">
                                <Mail className="w-3 h-3" />
                                {guest.email}
                              </span>
                            )}
                            {guest.table_assignment && (
                              <span className="inline-flex items-center gap-1">
                                <MapPin className="w-3 h-3" />
                                Table {guest.table_assignment}
                              </span>
                            )}
                            {isPlated && guest.meal_choice && (
                              <span className="inline-flex items-center gap-1">
                                <Utensils className="w-3 h-3" />
                                {guest.meal_choice}
                              </span>
                            )}
                            {guest.dietary_restrictions && (
                              <span className="inline-flex items-center gap-1 text-amber-600">
                                <AlertTriangle className="w-3 h-3" />
                                {guest.dietary_restrictions}
                              </span>
                            )}
                          </div>

                          {/* Tags */}
                          <div className="flex flex-wrap items-center gap-1 mt-1.5 relative">
                            {guest.tags.map((tid) => {
                              const t = tags.find((tg) => tg.id === tid)
                              if (!t) return null
                              return (
                                <TagChip
                                  key={tid}
                                  tag={t}
                                  onRemove={() => toggleGuestTag(guest.id, tid)}
                                />
                              )
                            })}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setTagPickerGuestId(tagPickerGuestId === guest.id ? null : guest.id)
                              }}
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 transition-colors"
                              title="Add tag"
                            >
                              <Tag className="w-2.5 h-2.5" />
                              {guest.tags.length === 0 ? 'Add tag' : '+'}
                            </button>
                            {tagPickerGuestId === guest.id && (
                              <div className="absolute left-0 top-full mt-1 z-30">
                                <TagPicker
                                  tags={tags}
                                  selectedIds={guest.tags}
                                  onToggle={(tid) => toggleGuestTag(guest.id, tid)}
                                  onClose={() => setTagPickerGuestId(null)}
                                />
                              </div>
                            )}
                          </div>

                          {/* Plus one */}
                          {guest.has_plus_one && (
                            <div className="mt-2 pl-3 border-l-2 border-gray-200">
                              <div className="flex items-center gap-2 text-xs">
                                <UserPlus className="w-3 h-3 text-gray-400" />
                                <span className="font-medium text-gray-600">
                                  {guest.plus_one_name || 'Plus One'}
                                </span>
                                {guest.plus_one_rsvp && rsvpBadge(guest.plus_one_rsvp)}
                                {isPlated && guest.plus_one_meal_choice && (
                                  <span className="text-gray-400">{guest.plus_one_meal_choice}</span>
                                )}
                                {guest.plus_one_dietary && (
                                  <span className="text-amber-600">{guest.plus_one_dietary}</span>
                                )}
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          {/* Quick RSVP dropdown */}
                          <select
                            value={guest.rsvp_status}
                            onChange={(e) => quickUpdateRsvp(guest.id, e.target.value as RsvpStatus)}
                            className="text-[11px] border border-gray-200 rounded px-1 py-0.5 bg-white focus:outline-none"
                          >
                            {RSVP_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                          <button
                            onClick={() => openEditGuest(guest)}
                            className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteGuest(guest.id)}
                            className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ============================================================ */}
      {/* MODALS                                                       */}
      {/* ============================================================ */}

      {/* Add/Edit Guest Modal */}
      {showGuestModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowGuestModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {editingId ? 'Edit Guest' : 'Add Guest'}
              </h2>
              <button onClick={() => setShowGuestModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Name */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">First Name *</label>
                  <input
                    type="text"
                    value={form.first_name}
                    onChange={(e) => setForm({ ...form, first_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
                  <input
                    type="text"
                    value={form.last_name}
                    onChange={(e) => setForm({ ...form, last_name: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
              </div>

              {/* Contact */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  />
                </div>
              </div>

              {/* Address */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                <input
                  type="text"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                />
              </div>

              {/* Group + RSVP */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Group / Side</label>
                  <select
                    value={form.group_side}
                    onChange={(e) => setForm({ ...form, group_side: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  >
                    {GROUP_SIDES.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">RSVP Status</label>
                  <select
                    value={form.rsvp_status}
                    onChange={(e) => setForm({ ...form, rsvp_status: e.target.value as RsvpStatus })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  >
                    {RSVP_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Meal + Dietary */}
              <div className="grid grid-cols-2 gap-3">
                {isPlated && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Meal Choice</label>
                    <select
                      value={form.meal_choice}
                      onChange={(e) => setForm({ ...form, meal_choice: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                      style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    >
                      <option value="">Select...</option>
                      {mealOptions.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className={isPlated ? '' : 'col-span-2'}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Dietary Restrictions</label>
                  <input
                    type="text"
                    value={form.dietary_restrictions}
                    onChange={(e) => setForm({ ...form, dietary_restrictions: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="e.g., Gluten free, nut allergy"
                  />
                </div>
              </div>

              {/* Table + Invitation */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Table Assignment</label>
                  <input
                    type="text"
                    value={form.table_assignment}
                    onChange={(e) => setForm({ ...form, table_assignment: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    placeholder="e.g., 5"
                  />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.invitation_sent}
                      onChange={(e) => setForm({ ...form, invitation_sent: e.target.checked })}
                      className="w-4 h-4 rounded border-gray-300"
                      style={{ accentColor: 'var(--couple-primary)' }}
                    />
                    <span className="text-sm text-gray-700">Invitation sent</span>
                  </label>
                </div>
              </div>

              {/* Tags */}
              {tags.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Tags (max 4)
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tag) => {
                      const selected = form.tags.includes(tag.id)
                      return (
                        <button
                          key={tag.id}
                          onClick={() => toggleFormTag(tag.id)}
                          className={cn(
                            'inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium transition-all',
                            selected ? 'text-white ring-2 ring-offset-1' : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
                          )}
                          style={selected ? { backgroundColor: tag.color, '--tw-ring-color': tag.color } as React.CSSProperties : undefined}
                        >
                          {selected && <Check className="w-3 h-3" />}
                          {tag.name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Notes */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm resize-none focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  rows={2}
                  placeholder="Any notes about this guest..."
                />
              </div>

              {/* Plus One */}
              <div className="border-t border-gray-100 pt-3">
                <label className="flex items-center gap-2 cursor-pointer mb-3">
                  <input
                    type="checkbox"
                    checked={form.has_plus_one}
                    onChange={(e) => setForm({ ...form, has_plus_one: e.target.checked })}
                    className="w-4 h-4 rounded border-gray-300"
                    style={{ accentColor: 'var(--couple-primary)' }}
                  />
                  <span className="text-sm font-medium text-gray-700 flex items-center gap-1">
                    <UserPlus className="w-3.5 h-3.5" />
                    Has Plus One
                  </span>
                </label>

                {form.has_plus_one && (
                  <div className="space-y-3 pl-6 border-l-2 border-gray-200">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Plus One Name</label>
                        <input
                          type="text"
                          value={form.plus_one_name}
                          onChange={(e) => setForm({ ...form, plus_one_name: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                          style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Plus One RSVP</label>
                        <select
                          value={form.plus_one_rsvp}
                          onChange={(e) => setForm({ ...form, plus_one_rsvp: e.target.value as RsvpStatus })}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                          style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                        >
                          {RSVP_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {isPlated && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Plus One Meal</label>
                        <select
                          value={form.plus_one_meal_choice}
                          onChange={(e) => setForm({ ...form, plus_one_meal_choice: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:border-transparent"
                          style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                        >
                          <option value="">Select...</option>
                          {mealOptions.map((m) => (
                            <option key={m} value={m}>{m}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Plus One Dietary</label>
                      <input
                        type="text"
                        value={form.plus_one_dietary}
                        onChange={(e) => setForm({ ...form, plus_one_dietary: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                        style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                        placeholder="e.g., Vegetarian"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowGuestModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveGuest}
                disabled={!form.first_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                {editingId ? 'Save Changes' : 'Add Guest'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal (Tags + Meals) */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowSettingsModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                Guest List Settings
              </h2>
              <button onClick={() => setShowSettingsModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Food Mode */}
            <div>
              <h3 className="text-sm font-semibold text-gray-800 mb-2">Food Service Mode</h3>
              <div className="grid grid-cols-2 gap-2">
                {FOOD_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    onClick={() => selectFoodMode(mode.value as FoodMode)}
                    className={cn(
                      'p-3 border rounded-lg text-left transition-all',
                      foodMode === mode.value
                        ? 'border-2 bg-gray-50'
                        : 'border-gray-200 hover:border-gray-300'
                    )}
                    style={foodMode === mode.value ? { borderColor: 'var(--couple-primary)' } : undefined}
                  >
                    <span className="text-lg">{mode.emoji}</span>
                    <p className="text-xs font-medium text-gray-700 mt-0.5">{mode.label}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Manage Tags */}
            <div>
              <h3 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-1.5">
                <Tag className="w-4 h-4" />
                Manage Tags
              </h3>
              {tags.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  {tags.map((tag) => (
                    <div key={tag.id} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-full" style={{ backgroundColor: tag.color }} />
                        <span className="text-sm text-gray-700">{tag.name}</span>
                        <span className="text-xs text-gray-400">{stats.tagCounts[tag.id] || 0} guests</span>
                      </div>
                      <button onClick={() => deleteTag(tag.id)} className="text-gray-400 hover:text-red-500">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  placeholder="Tag name..."
                  className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                  onKeyDown={(e) => e.key === 'Enter' && addTag()}
                />
                <button
                  onClick={addTag}
                  disabled={!newTagName.trim()}
                  className="px-3 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                  style={{ backgroundColor: 'var(--couple-primary)' }}
                >
                  Add
                </button>
              </div>
              {/* Color picker */}
              <div className="flex gap-1.5 mt-2">
                {TAG_COLORS.map((c) => (
                  <button
                    key={c.name}
                    onClick={() => setNewTagColor(c.value)}
                    className={cn(
                      'w-6 h-6 rounded-full transition-all',
                      newTagColor === c.value ? 'ring-2 ring-offset-2 scale-110' : 'hover:scale-105'
                    )}
                    style={{ backgroundColor: c.value, '--tw-ring-color': c.value } as React.CSSProperties}
                  />
                ))}
              </div>
            </div>

            {/* Manage Meal Options (plated only) */}
            {isPlated && (
              <div>
                <h3 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-1.5">
                  <Utensils className="w-4 h-4" />
                  Manage Meal Options
                </h3>
                <div className="space-y-1.5 mb-3">
                  {mealOptions.map((opt) => (
                    <div key={opt} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                      <span className="text-sm text-gray-700">{opt}</span>
                      <button onClick={() => removeMealOption(opt)} className="text-gray-400 hover:text-red-500">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newMealOption}
                    onChange={(e) => setNewMealOption(e.target.value)}
                    placeholder="New meal option..."
                    className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                    style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
                    onKeyDown={(e) => e.key === 'Enter' && addMealOption()}
                  />
                  <button
                    onClick={addMealOption}
                    disabled={!newMealOption.trim()}
                    className="px-3 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
                    style={{ backgroundColor: 'var(--couple-primary)' }}
                  >
                    Add
                  </button>
                </div>
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setShowSettingsModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CSV Import Preview Modal */}
      {showCsvModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowCsvModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-3xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                Import CSV ({csvData.length} guests)
              </h2>
              <button onClick={() => setShowCsvModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Column Mapping */}
            <div>
              <p className="text-sm text-gray-600 mb-3">
                Map your CSV columns to guest fields. We auto-detected what we could.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {csvHeaders.map((header) => (
                  <div key={header}>
                    <label className="block text-xs text-gray-500 mb-0.5 truncate" title={header}>
                      {header}
                    </label>
                    <select
                      value={csvMapping[header] || ''}
                      onChange={(e) =>
                        setCsvMapping((prev) => ({ ...prev, [header]: e.target.value }))
                      }
                      className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs bg-white focus:outline-none"
                    >
                      <option value="">Skip</option>
                      <option value="first_name">First Name</option>
                      <option value="last_name">Last Name</option>
                      <option value="email">Email</option>
                      <option value="phone">Phone</option>
                      <option value="address">Address</option>
                      <option value="group_side">Group/Side</option>
                      <option value="meal_choice">Meal Choice</option>
                      <option value="dietary_restrictions">Dietary</option>
                      <option value="table_assignment">Table</option>
                      <option value="notes">Notes</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>

            {/* Preview Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-200">
                    {csvHeaders.map((h) => (
                      <th key={h} className="px-2 py-1.5 text-left text-gray-500 font-medium">
                        {csvMapping[h] || <span className="text-gray-300">skip</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {csvData.slice(0, 10).map((row, i) => (
                    <tr key={i} className="border-b border-gray-50">
                      {csvHeaders.map((h) => (
                        <td key={h} className="px-2 py-1.5 text-gray-700 truncate max-w-[120px]">
                          {row[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {csvData.length > 10 && (
                <p className="text-xs text-gray-400 mt-2 text-center">
                  Showing 10 of {csvData.length} rows
                </p>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowCsvModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={importCsv}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                Import {csvData.length} Guests
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Action Modal */}
      {showBulkModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowBulkModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2
                className="text-lg font-semibold"
                style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
              >
                {bulkAction === 'rsvp' ? 'Bulk Update RSVP' : 'Bulk Assign Tag'}
              </h2>
              <button onClick={() => setShowBulkModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-gray-500">
              Apply to {selectedGuests.size} selected guest{selectedGuests.size > 1 ? 's' : ''}
            </p>

            {bulkAction === 'rsvp' && (
              <div className="flex flex-wrap gap-2">
                {RSVP_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setBulkValue(opt.value)}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium border transition-colors',
                      bulkValue === opt.value
                        ? opt.bg + ' ' + opt.color + ' ring-1'
                        : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                    )}
                  >
                    {opt.icon}
                    {opt.label}
                  </button>
                ))}
              </div>
            )}

            {bulkAction === 'tag' && (
              <div className="flex flex-wrap gap-2">
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    onClick={() => setBulkValue(tag.id)}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-medium transition-all',
                      bulkValue === tag.id ? 'text-white ring-2 ring-offset-1' : 'text-gray-600 bg-gray-100 hover:bg-gray-200'
                    )}
                    style={bulkValue === tag.id ? { backgroundColor: tag.color } : undefined}
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setShowBulkModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={executeBulkAction}
                disabled={!bulkValue}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
