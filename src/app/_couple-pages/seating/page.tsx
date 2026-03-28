'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Plus,
  X,
  Users,
  Circle,
  RectangleHorizontal,
  Crown,
  Heart,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Loader2,
  Search,
  Edit2,
  Trash2,
  Check,
  Palette,
  Table2,
  Coffee,
  Cake,
  Gift,
  Calculator,
  Settings2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const WEDDING_ID = '44444444-4444-4444-4444-444444000109'
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TableType = 'round' | 'rectangle' | 'farm' | 'head_one_sided' | 'head_two_sided' | 'sweetheart' | 'cocktail' | 'cake' | 'gift'

interface SeatingTable {
  id: string
  table_name: string
  table_type: TableType
  capacity: number
  position_x: number | null
  position_y: number | null
  linen_color: string | null
  linen_runner: string | null
  table_size: string | null
  is_special: boolean
}

interface SeatingAssignment {
  id: string
  table_id: string
  guest_id: string
}

interface Guest {
  id: string
  group_name: string | null
  rsvp_status: string | null
  person: {
    first_name: string | null
    last_name: string | null
  } | null
}

interface TableFormData {
  table_name: string
  table_type: TableType
  capacity: string
  linen_color: string
  linen_runner: string
  table_size: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLE_TYPES: { value: TableType; label: string; icon: React.ElementType; isSpecial: boolean; defaultCapacity: number; description: string }[] = [
  { value: 'round', label: 'Round', icon: Circle, isSpecial: false, defaultCapacity: 8, description: 'Standard round guest table' },
  { value: 'rectangle', label: 'Rectangle', icon: RectangleHorizontal, isSpecial: false, defaultCapacity: 8, description: 'Rectangular guest table' },
  { value: 'farm', label: 'Farm', icon: RectangleHorizontal, isSpecial: false, defaultCapacity: 10, description: 'Long farmhouse-style table' },
  { value: 'head_one_sided', label: 'Head Table (One Side)', icon: Crown, isSpecial: true, defaultCapacity: 8, description: 'Guests face the room' },
  { value: 'head_two_sided', label: 'Head Table (Two Sides)', icon: Crown, isSpecial: true, defaultCapacity: 12, description: 'Guests on both sides' },
  { value: 'sweetheart', label: 'Sweetheart', icon: Heart, isSpecial: true, defaultCapacity: 2, description: 'Just for the couple' },
  { value: 'cocktail', label: 'Cocktail High-Top', icon: Coffee, isSpecial: true, defaultCapacity: 4, description: 'Standing cocktail table' },
  { value: 'cake', label: 'Cake Table', icon: Cake, isSpecial: true, defaultCapacity: 0, description: 'Display table for cake' },
  { value: 'gift', label: 'Gift Table', icon: Gift, isSpecial: true, defaultCapacity: 0, description: 'Gift and card collection' },
]

const LINEN_COLORS = [
  { value: 'white', label: 'White', hex: '#FFFFFF' },
  { value: 'ivory', label: 'Ivory', hex: '#FFFFF0' },
  { value: 'champagne', label: 'Champagne', hex: '#F7E7CE' },
  { value: 'blush', label: 'Blush', hex: '#F4C2C2' },
  { value: 'dusty_rose', label: 'Dusty Rose', hex: '#C4A4A7' },
  { value: 'sage', label: 'Sage', hex: '#BCB88A' },
  { value: 'dusty_blue', label: 'Dusty Blue', hex: '#B0C4DE' },
  { value: 'navy', label: 'Navy', hex: '#000080' },
  { value: 'burgundy', label: 'Burgundy', hex: '#800020' },
  { value: 'black', label: 'Black', hex: '#1A1A1A' },
]

const RUNNER_STYLES = [
  { value: 'none', label: 'No Runner' },
  { value: 'fabric', label: 'Fabric Runner' },
  { value: 'sheer', label: 'Sheer/Organza' },
  { value: 'greenery', label: 'Greenery/Garland' },
  { value: 'lace', label: 'Lace' },
]

const TABLE_SIZES: Record<string, { label: string; clothSize: string; yardage: number }[]> = {
  round: [
    { label: '48" Round (4-6)', clothSize: '108" or 120"', yardage: 3.0 },
    { label: '60" Round (8)', clothSize: '120" or 132"', yardage: 3.3 },
    { label: '72" Round (10)', clothSize: '132"', yardage: 3.7 },
  ],
  rectangle: [
    { label: '6ft Banquet (6-8)', clothSize: '90x132"', yardage: 3.7 },
    { label: '8ft Banquet (8-10)', clothSize: '90x156"', yardage: 4.3 },
  ],
  farm: [
    { label: '8ft Farm (8-10)', clothSize: '90x156" or bare', yardage: 4.3 },
    { label: '10ft Farm (10-12)', clothSize: '108x156"', yardage: 4.8 },
  ],
}

const EMPTY_TABLE_FORM: TableFormData = {
  table_name: '',
  table_type: 'round',
  capacity: '8',
  linen_color: 'white',
  linen_runner: 'none',
  table_size: '',
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

function getTableTypeConfig(type: TableType) {
  return TABLE_TYPES.find(t => t.value === type) || TABLE_TYPES[0]
}

function getLinenColor(value: string | null): { label: string; hex: string } {
  return LINEN_COLORS.find(c => c.value === value) || LINEN_COLORS[0]
}

// ---------------------------------------------------------------------------
// Table Visual Component
// ---------------------------------------------------------------------------

function TableVisual({
  table,
  assignedGuests,
  isSelected,
  onClick,
}: {
  table: SeatingTable
  assignedGuests: Guest[]
  isSelected: boolean
  onClick: () => void
}) {
  const config = getTableTypeConfig(table.table_type)
  const TypeIcon = config.icon
  const isFull = assignedGuests.length >= table.capacity && table.capacity > 0
  const linenColor = getLinenColor(table.linen_color)

  // Sweetheart table
  if (table.table_type === 'sweetheart') {
    return (
      <button
        onClick={onClick}
        className={cn(
          'relative w-24 h-24 rounded-full border-2 transition-all flex flex-col items-center justify-center gap-0.5',
          isSelected ? 'border-current shadow-md' : 'border-gray-200 bg-white hover:border-gray-300'
        )}
        style={isSelected ? { borderColor: 'var(--couple-primary)', backgroundColor: 'color-mix(in srgb, var(--couple-primary) 5%, white)' } : { borderColor: linenColor.hex === '#FFFFFF' ? undefined : linenColor.hex + '60' }}
      >
        <Heart className="w-4 h-4 text-pink-400" />
        <span className="text-[10px] font-semibold text-gray-700 truncate max-w-[80%]">{table.table_name}</span>
        <span className="text-[9px] text-gray-400">{assignedGuests.length}/{table.capacity}</span>
      </button>
    )
  }

  // Special display tables (cake, gift) - no seats
  if (table.table_type === 'cake' || table.table_type === 'gift') {
    return (
      <button
        onClick={onClick}
        className={cn(
          'relative w-20 h-20 rounded-lg border-2 border-dashed transition-all flex flex-col items-center justify-center gap-0.5',
          isSelected ? 'border-current shadow-md' : 'border-gray-200 bg-gray-50 hover:border-gray-300'
        )}
        style={isSelected ? { borderColor: 'var(--couple-primary)' } : undefined}
      >
        <TypeIcon className="w-4 h-4 text-gray-400" />
        <span className="text-[9px] font-semibold text-gray-600 truncate max-w-[90%]">{table.table_name}</span>
      </button>
    )
  }

  // Cocktail high-top
  if (table.table_type === 'cocktail') {
    return (
      <button
        onClick={onClick}
        className={cn(
          'relative w-20 h-20 rounded-full border-2 transition-all flex flex-col items-center justify-center gap-0.5',
          isSelected ? 'border-current shadow-md' : isFull ? 'border-emerald-300 bg-emerald-50/50' : 'border-gray-200 bg-white hover:border-gray-300'
        )}
        style={isSelected ? { borderColor: 'var(--couple-primary)', backgroundColor: 'color-mix(in srgb, var(--couple-primary) 5%, white)' } : undefined}
      >
        <Coffee className="w-3.5 h-3.5 text-gray-400" />
        <span className="text-[9px] font-semibold text-gray-700 truncate max-w-[80%]">{table.table_name}</span>
        <span className="text-[8px] text-gray-400">{assignedGuests.length}/{table.capacity}</span>
      </button>
    )
  }

  // Head tables
  if (table.table_type === 'head_one_sided' || table.table_type === 'head_two_sided') {
    return (
      <button
        onClick={onClick}
        className={cn(
          'relative w-64 h-20 rounded-xl border-2 transition-all flex flex-col items-center justify-center gap-1',
          isSelected ? 'border-current shadow-md' : isFull ? 'border-emerald-300 bg-emerald-50/50' : 'border-gray-200 bg-white hover:border-gray-300'
        )}
        style={isSelected ? { borderColor: 'var(--couple-primary)', backgroundColor: 'color-mix(in srgb, var(--couple-primary) 5%, white)' } : undefined}
      >
        <div className="flex items-center gap-1">
          <Crown className="w-3.5 h-3.5 text-amber-500" />
          <span className="text-xs font-semibold text-gray-700">{table.table_name}</span>
        </div>
        <span className="text-[10px] text-gray-500">{assignedGuests.length}/{table.capacity}</span>
        {table.table_type === 'head_one_sided' && (
          <div className="absolute -top-3 left-4 right-4 flex justify-center gap-1 flex-wrap">
            {assignedGuests.slice(0, 10).map(g => (
              <div key={g.id} className="w-5 h-5 rounded-full text-white text-[8px] font-bold flex items-center justify-center"
                style={{ backgroundColor: 'var(--couple-primary)' }} title={guestName(g)}>
                {(g.person?.first_name?.[0] || '?').toUpperCase()}
              </div>
            ))}
          </div>
        )}
        {table.table_type === 'head_two_sided' && (
          <>
            <div className="absolute -top-3 left-4 right-4 flex justify-center gap-1 flex-wrap">
              {assignedGuests.slice(0, Math.ceil(assignedGuests.length / 2)).map(g => (
                <div key={g.id} className="w-5 h-5 rounded-full text-white text-[8px] font-bold flex items-center justify-center"
                  style={{ backgroundColor: 'var(--couple-primary)' }} title={guestName(g)}>
                  {(g.person?.first_name?.[0] || '?').toUpperCase()}
                </div>
              ))}
            </div>
            <div className="absolute -bottom-3 left-4 right-4 flex justify-center gap-1 flex-wrap">
              {assignedGuests.slice(Math.ceil(assignedGuests.length / 2)).map(g => (
                <div key={g.id} className="w-5 h-5 rounded-full text-white text-[8px] font-bold flex items-center justify-center"
                  style={{ backgroundColor: 'var(--couple-accent, var(--couple-primary))' }} title={guestName(g)}>
                  {(g.person?.first_name?.[0] || '?').toUpperCase()}
                </div>
              ))}
            </div>
          </>
        )}
        {table.linen_color && table.linen_color !== 'white' && (
          <div className="absolute -right-1 -top-1 w-3 h-3 rounded-full border border-white" style={{ backgroundColor: getLinenColor(table.linen_color).hex }} title={getLinenColor(table.linen_color).label} />
        )}
      </button>
    )
  }

  // Round table
  if (table.table_type === 'round') {
    return (
      <button
        onClick={onClick}
        className={cn(
          'relative w-32 h-32 rounded-full border-2 transition-all flex flex-col items-center justify-center gap-1',
          isSelected ? 'border-current shadow-md' : isFull ? 'border-emerald-300 bg-emerald-50/50' : 'border-gray-200 bg-white hover:border-gray-300'
        )}
        style={isSelected ? { borderColor: 'var(--couple-primary)', backgroundColor: 'color-mix(in srgb, var(--couple-primary) 5%, white)' } : undefined}
      >
        <span className="text-xs font-semibold text-gray-700 truncate max-w-[90%]">{table.table_name}</span>
        <span className="text-[10px] text-gray-500">{assignedGuests.length}/{table.capacity}</span>
        {assignedGuests.slice(0, 8).map((g, i) => {
          const angle = (i * 360) / Math.min(assignedGuests.length, 8) - 90
          const rad = (angle * Math.PI) / 180
          const x = 50 + 44 * Math.cos(rad)
          const y = 50 + 44 * Math.sin(rad)
          return (
            <div key={g.id} className="absolute w-5 h-5 rounded-full text-white text-[8px] font-bold flex items-center justify-center"
              style={{ left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)', backgroundColor: 'var(--couple-accent, var(--couple-primary))' }}
              title={guestName(g)}>
              {(g.person?.first_name?.[0] || '?').toUpperCase()}
            </div>
          )
        })}
        {table.linen_color && table.linen_color !== 'white' && (
          <div className="absolute -right-0.5 -top-0.5 w-3 h-3 rounded-full border border-white" style={{ backgroundColor: getLinenColor(table.linen_color).hex }} />
        )}
      </button>
    )
  }

  // Rectangle / Farm tables
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative h-28 border-2 transition-all flex flex-col items-center justify-center gap-1',
        table.table_type === 'farm' ? 'w-56 rounded-xl' : 'w-40 rounded-xl',
        isSelected ? 'border-current shadow-md' : isFull ? 'border-emerald-300 bg-emerald-50/50' : 'border-gray-200 bg-white hover:border-gray-300'
      )}
      style={isSelected ? { borderColor: 'var(--couple-primary)', backgroundColor: 'color-mix(in srgb, var(--couple-primary) 5%, white)' } : undefined}
    >
      <TypeIcon className="w-4 h-4 text-gray-400" />
      <span className="text-xs font-semibold text-gray-700 truncate max-w-[90%]">{table.table_name}</span>
      <span className="text-[10px] text-gray-500">{assignedGuests.length}/{table.capacity}</span>
      <div className="absolute -left-3 top-3 bottom-3 flex flex-col justify-center gap-1">
        {assignedGuests.slice(0, Math.ceil(assignedGuests.length / 2)).map(g => (
          <div key={g.id} className="w-5 h-5 rounded-full text-white text-[8px] font-bold flex items-center justify-center"
            style={{ backgroundColor: 'var(--couple-accent, var(--couple-primary))' }} title={guestName(g)}>
            {(g.person?.first_name?.[0] || '?').toUpperCase()}
          </div>
        ))}
      </div>
      <div className="absolute -right-3 top-3 bottom-3 flex flex-col justify-center gap-1">
        {assignedGuests.slice(Math.ceil(assignedGuests.length / 2)).map(g => (
          <div key={g.id} className="w-5 h-5 rounded-full text-white text-[8px] font-bold flex items-center justify-center"
            style={{ backgroundColor: 'var(--couple-accent, var(--couple-primary))' }} title={guestName(g)}>
            {(g.person?.first_name?.[0] || '?').toUpperCase()}
          </div>
        ))}
      </div>
      {table.linen_color && table.linen_color !== 'white' && (
        <div className="absolute -right-0.5 -top-0.5 w-3 h-3 rounded-full border border-white" style={{ backgroundColor: getLinenColor(table.linen_color).hex }} />
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function SeatingChartPage() {
  const [tables, setTables] = useState<SeatingTable[]>([])
  const [assignments, setAssignments] = useState<SeatingAssignment[]>([])
  const [guests, setGuests] = useState<Guest[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const [showAddTable, setShowAddTable] = useState(false)
  const [showEditTable, setShowEditTable] = useState(false)
  const [showLinenCalc, setShowLinenCalc] = useState(false)
  const [showAssignModal, setShowAssignModal] = useState(false)
  const [showConfigPanel, setShowConfigPanel] = useState(false)
  const [tableForm, setTableForm] = useState<TableFormData>(EMPTY_TABLE_FORM)
  const [editingTableId, setEditingTableId] = useState<string | null>(null)
  const [guestSearch, setGuestSearch] = useState('')
  const [quickAddCount, setQuickAddCount] = useState('5')
  const [quickAddType, setQuickAddType] = useState<TableType>('round')
  const [defaultLinenColor, setDefaultLinenColor] = useState('white')
  const [defaultRunner, setDefaultRunner] = useState('none')

  const supabase = createClient()

  // ---- Fetch data ----
  const fetchData = useCallback(async () => {
    const [tablesRes, assignmentsRes, guestsRes] = await Promise.all([
      supabase.from('seating_tables').select('*').eq('wedding_id', WEDDING_ID).order('created_at', { ascending: true }),
      supabase.from('seating_assignments').select('*').eq('wedding_id', WEDDING_ID),
      supabase.from('guest_list').select('id, group_name, rsvp_status, person:people(first_name, last_name)').eq('wedding_id', WEDDING_ID).order('created_at', { ascending: true }),
    ])

    if (tablesRes.data) setTables(tablesRes.data as SeatingTable[])
    if (assignmentsRes.data) setAssignments(assignmentsRes.data as SeatingAssignment[])
    if (guestsRes.data) setGuests(guestsRes.data as unknown as Guest[])
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Derived data ----
  const assignmentsByTable = useMemo(() => {
    const map: Record<string, string[]> = {}
    assignments.forEach(a => {
      if (!map[a.table_id]) map[a.table_id] = []
      map[a.table_id].push(a.guest_id)
    })
    return map
  }, [assignments])

  const assignedGuestIds = useMemo(() => new Set(assignments.map(a => a.guest_id)), [assignments])
  const unassignedGuests = useMemo(() => guests.filter(g => !assignedGuestIds.has(g.id)), [guests, assignedGuestIds])

  const selectedTable = tables.find(t => t.id === selectedTableId) || null
  const selectedTableGuestIds = selectedTableId ? assignmentsByTable[selectedTableId] || [] : []
  const selectedTableGuests = guests.filter(g => selectedTableGuestIds.includes(g.id))

  const filteredUnassigned = useMemo(() => {
    if (!guestSearch.trim()) return unassignedGuests
    const q = guestSearch.toLowerCase()
    return unassignedGuests.filter(g => {
      const name = guestName(g).toLowerCase()
      const group = (g.group_name || '').toLowerCase()
      return name.includes(q) || group.includes(q)
    })
  }, [unassignedGuests, guestSearch])

  // ---- Stats ----
  const stats = useMemo(() => {
    const guestTables = tables.filter(t => t.capacity > 0)
    const specialTables = tables.filter(t => t.capacity === 0)
    const totalSeats = tables.reduce((s, t) => s + t.capacity, 0)
    const totalAssigned = assignments.length

    // Linen summary
    const linenSummary: Record<string, { count: number; yardage: number }> = {}
    tables.forEach(table => {
      const color = table.linen_color || 'white'
      if (!linenSummary[color]) linenSummary[color] = { count: 0, yardage: 0 }
      linenSummary[color].count++

      // Calculate yardage
      const sizeOptions = TABLE_SIZES[table.table_type]
      if (sizeOptions && table.table_size) {
        const size = sizeOptions.find(s => s.label === table.table_size)
        if (size) linenSummary[color].yardage += size.yardage
      } else if (sizeOptions && sizeOptions.length > 0) {
        linenSummary[color].yardage += sizeOptions[0].yardage
      }

      // Runner
      if (table.linen_runner && table.linen_runner !== 'none') {
        const runnerKey = `runner_${table.linen_runner}`
        if (!linenSummary[runnerKey]) linenSummary[runnerKey] = { count: 0, yardage: 0 }
        linenSummary[runnerKey].count++
        linenSummary[runnerKey].yardage += table.table_type === 'farm' ? 3.5 : 2.5
      }
    })

    return { guestTableCount: guestTables.length, specialTableCount: specialTables.length, totalSeats, totalAssigned, unassigned: unassignedGuests.length, linenSummary }
  }, [tables, assignments, unassignedGuests])

  // ---- Add table ----
  async function handleAddTable() {
    if (!tableForm.table_name.trim()) return

    const config = getTableTypeConfig(tableForm.table_type)

    await supabase.from('seating_tables').insert({
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      table_name: tableForm.table_name.trim(),
      table_type: tableForm.table_type,
      capacity: parseInt(tableForm.capacity) || config.defaultCapacity,
      linen_color: tableForm.linen_color,
      linen_runner: tableForm.linen_runner,
      table_size: tableForm.table_size || null,
      is_special: config.isSpecial,
    })

    setTableForm(EMPTY_TABLE_FORM)
    setShowAddTable(false)
    fetchData()
  }

  // ---- Quick add tables ----
  async function handleQuickAdd() {
    const count = parseInt(quickAddCount) || 0
    if (count <= 0) return

    const config = getTableTypeConfig(quickAddType)
    const existingCount = tables.filter(t => t.table_type === quickAddType).length

    const newTables = Array.from({ length: count }, (_, i) => ({
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      table_name: `Table ${existingCount + i + 1}`,
      table_type: quickAddType,
      capacity: config.defaultCapacity,
      linen_color: defaultLinenColor,
      linen_runner: defaultRunner,
      is_special: config.isSpecial,
    }))

    await supabase.from('seating_tables').insert(newTables)
    setShowConfigPanel(false)
    fetchData()
  }

  // ---- Edit table ----
  function openEditTable(table: SeatingTable) {
    setTableForm({
      table_name: table.table_name,
      table_type: table.table_type,
      capacity: table.capacity.toString(),
      linen_color: table.linen_color || 'white',
      linen_runner: table.linen_runner || 'none',
      table_size: table.table_size || '',
    })
    setEditingTableId(table.id)
    setShowEditTable(true)
  }

  async function handleUpdateTable() {
    if (!editingTableId || !tableForm.table_name.trim()) return

    await supabase.from('seating_tables').update({
      table_name: tableForm.table_name.trim(),
      table_type: tableForm.table_type,
      capacity: parseInt(tableForm.capacity) || 8,
      linen_color: tableForm.linen_color,
      linen_runner: tableForm.linen_runner,
      table_size: tableForm.table_size || null,
    }).eq('id', editingTableId)

    setShowEditTable(false)
    setEditingTableId(null)
    fetchData()
  }

  // ---- Delete table ----
  async function handleDeleteTable(tableId: string) {
    if (!confirm('Remove this table? All seat assignments will be lost.')) return
    await supabase.from('seating_assignments').delete().eq('table_id', tableId)
    await supabase.from('seating_tables').delete().eq('id', tableId)
    if (selectedTableId === tableId) setSelectedTableId(null)
    fetchData()
  }

  // ---- Assign / Unassign ----
  async function handleAssignGuest(guestId: string) {
    if (!selectedTableId) return
    const currentCount = (assignmentsByTable[selectedTableId] || []).length
    const table = tables.find(t => t.id === selectedTableId)
    if (table && table.capacity > 0 && currentCount >= table.capacity) {
      alert('This table is full. Increase capacity or choose another table.')
      return
    }
    await supabase.from('seating_assignments').insert({
      venue_id: VENUE_ID,
      wedding_id: WEDDING_ID,
      table_id: selectedTableId,
      guest_id: guestId,
    })
    fetchData()
  }

  async function handleUnassignGuest(guestId: string) {
    await supabase.from('seating_assignments').delete().eq('guest_id', guestId).eq('wedding_id', WEDDING_ID)
    fetchData()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'var(--couple-primary)' }} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-1" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
            Seating Chart
          </h1>
          <p className="text-gray-500 text-sm">Arrange tables, assign guests, manage linens.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowConfigPanel(!showConfigPanel)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
            <Settings2 className="w-3.5 h-3.5" /> Config
          </button>
          <button onClick={() => setShowLinenCalc(!showLinenCalc)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
            <Calculator className="w-3.5 h-3.5" /> Linens
          </button>
          <button onClick={() => { setTableForm(EMPTY_TABLE_FORM); setShowAddTable(true) }}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary)' }}>
            <Plus className="w-4 h-4" /> Add Table
          </button>
        </div>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
          <p className="text-xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>{stats.guestTableCount}</p>
          <p className="text-[10px] text-gray-500 font-medium">Guest Tables</p>
        </div>
        <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
          <p className="text-xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>{stats.specialTableCount}</p>
          <p className="text-[10px] text-gray-500 font-medium">Special Tables</p>
        </div>
        <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
          <p className="text-xl font-bold tabular-nums" style={{ color: 'var(--couple-secondary, var(--couple-primary))' }}>{stats.totalSeats}</p>
          <p className="text-[10px] text-gray-500 font-medium">Total Seats</p>
        </div>
        <div className="bg-white rounded-xl p-3 border border-gray-100 shadow-sm text-center">
          <p className="text-xl font-bold tabular-nums text-emerald-600">{stats.totalAssigned}</p>
          <p className="text-[10px] text-gray-500 font-medium">Assigned</p>
        </div>
        <div className={cn('rounded-xl p-3 border shadow-sm text-center', stats.unassigned > 0 ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200')}>
          <p className={cn('text-xl font-bold tabular-nums', stats.unassigned > 0 ? 'text-amber-600' : 'text-emerald-600')}>{stats.unassigned}</p>
          <p className="text-[10px] text-gray-500 font-medium">Unassigned</p>
        </div>
      </div>

      {/* Config Panel */}
      {showConfigPanel && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>Quick Setup</h3>
            <button onClick={() => setShowConfigPanel(false)} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Table Type</label>
              <select value={quickAddType} onChange={e => setQuickAddType(e.target.value as TableType)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                {TABLE_TYPES.filter(t => !t.isSpecial).map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Count</label>
              <input type="number" value={quickAddCount} onChange={e => setQuickAddCount(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" min={1} max={30} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Default Linen</label>
              <select value={defaultLinenColor} onChange={e => setDefaultLinenColor(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                {LINEN_COLORS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div className="flex items-end">
              <button onClick={handleQuickAdd}
                className="w-full px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
                style={{ backgroundColor: 'var(--couple-primary)' }}>
                Add {quickAddCount} Tables
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Default Runner</label>
            <div className="flex flex-wrap gap-2">
              {RUNNER_STYLES.map(r => (
                <button key={r.value} onClick={() => setDefaultRunner(r.value)}
                  className={cn('px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                    defaultRunner === r.value ? 'text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  )}
                  style={defaultRunner === r.value ? { backgroundColor: 'var(--couple-primary)', borderColor: 'var(--couple-primary)' } : undefined}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Linen Calculator */}
      {showLinenCalc && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>Linen Summary</h3>
            <button onClick={() => setShowLinenCalc(false)} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
          </div>

          {Object.keys(stats.linenSummary).length === 0 ? (
            <p className="text-sm text-gray-400">Add tables to see linen calculations.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Object.entries(stats.linenSummary).map(([key, data]) => {
                const isRunner = key.startsWith('runner_')
                const color = isRunner ? null : LINEN_COLORS.find(c => c.value === key)
                const runnerStyle = isRunner ? RUNNER_STYLES.find(r => r.value === key.replace('runner_', '')) : null

                return (
                  <div key={key} className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50">
                    <div className="flex items-center gap-2">
                      {color && <div className="w-4 h-4 rounded-full border border-gray-200" style={{ backgroundColor: color.hex }} />}
                      <span className="text-sm text-gray-700">
                        {isRunner ? `${runnerStyle?.label || key}` : `${color?.label || key} Linens`}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-sm font-medium tabular-nums">{data.count}</span>
                      {data.yardage > 0 && (
                        <span className="text-xs text-gray-400 ml-2">(~{data.yardage.toFixed(1)} yds)</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Main layout */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Floor plan area */}
        <div className="flex-1">
          {tables.length === 0 ? (
            <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
              <Table2 className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
              <h3 className="text-lg font-semibold mb-2" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
                No tables yet
              </h3>
              <p className="text-gray-500 text-sm mb-6 max-w-md mx-auto">
                Start by using quick setup to add multiple tables at once, or add them one by one.
              </p>
              <div className="flex items-center justify-center gap-3">
                <button onClick={() => setShowConfigPanel(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
                  style={{ backgroundColor: 'var(--couple-primary)' }}>
                  <Settings2 className="w-4 h-4" /> Quick Setup
                </button>
                <button onClick={() => { setTableForm(EMPTY_TABLE_FORM); setShowAddTable(true) }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50">
                  <Plus className="w-4 h-4" /> Add Single Table
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 min-h-[400px]">
              {/* Special tables (head, sweetheart) at top */}
              {tables.some(t => ['head_one_sided', 'head_two_sided', 'sweetheart'].includes(t.table_type)) && (
                <div className="flex flex-wrap justify-center gap-6 mb-8 pb-6 border-b border-gray-100">
                  {tables.filter(t => ['head_one_sided', 'head_two_sided', 'sweetheart'].includes(t.table_type)).map(table => (
                    <TableVisual key={table.id} table={table}
                      assignedGuests={guests.filter(g => (assignmentsByTable[table.id] || []).includes(g.id))}
                      isSelected={selectedTableId === table.id}
                      onClick={() => setSelectedTableId(selectedTableId === table.id ? null : table.id)} />
                  ))}
                </div>
              )}

              {/* Guest tables */}
              <div className="flex flex-wrap justify-center gap-8 py-4">
                {tables.filter(t => !['head_one_sided', 'head_two_sided', 'sweetheart', 'cocktail', 'cake', 'gift'].includes(t.table_type)).map(table => (
                  <TableVisual key={table.id} table={table}
                    assignedGuests={guests.filter(g => (assignmentsByTable[table.id] || []).includes(g.id))}
                    isSelected={selectedTableId === table.id}
                    onClick={() => setSelectedTableId(selectedTableId === table.id ? null : table.id)} />
                ))}
              </div>

              {/* Cocktail / display tables at bottom */}
              {tables.some(t => ['cocktail', 'cake', 'gift'].includes(t.table_type)) && (
                <div className="flex flex-wrap justify-center gap-4 mt-6 pt-6 border-t border-gray-100">
                  {tables.filter(t => ['cocktail', 'cake', 'gift'].includes(t.table_type)).map(table => (
                    <TableVisual key={table.id} table={table}
                      assignedGuests={guests.filter(g => (assignmentsByTable[table.id] || []).includes(g.id))}
                      isSelected={selectedTableId === table.id}
                      onClick={() => setSelectedTableId(selectedTableId === table.id ? null : table.id)} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Selected table detail panel */}
          {selectedTable && (
            <div className="mt-4 bg-white rounded-xl border border-gray-100 shadow-sm p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  {(() => { const Icon = getTableTypeConfig(selectedTable.table_type).icon; return <Icon className="w-4 h-4 text-gray-400" /> })()}
                  <h3 className="font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
                    {selectedTable.table_name}
                  </h3>
                  <span className="text-xs text-gray-400">
                    {getTableTypeConfig(selectedTable.table_type).label} · {selectedTableGuests.length}/{selectedTable.capacity} seats
                  </span>
                  {selectedTable.linen_color && selectedTable.linen_color !== 'white' && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-gray-400">
                      <Palette className="w-3 h-3" />
                      {getLinenColor(selectedTable.linen_color).label}
                      {selectedTable.linen_runner && selectedTable.linen_runner !== 'none' && ` + ${RUNNER_STYLES.find(r => r.value === selectedTable.linen_runner)?.label}`}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {selectedTable.capacity > 0 && (
                    <button onClick={() => setShowAssignModal(true)}
                      disabled={selectedTableGuests.length >= selectedTable.capacity}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                      style={{ backgroundColor: 'var(--couple-primary)' }}>
                      <Plus className="w-3 h-3" /> Assign
                    </button>
                  )}
                  <button onClick={() => openEditTable(selectedTable)}
                    className="px-3 py-1.5 text-xs font-medium text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                    Edit
                  </button>
                  <button onClick={() => handleDeleteTable(selectedTable.id)}
                    className="px-3 py-1.5 text-xs font-medium text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
                    Remove
                  </button>
                </div>
              </div>

              {selectedTable.capacity === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">Display table — no guest seating.</p>
              ) : selectedTableGuests.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">No guests assigned yet. Click &quot;Assign&quot; or click guests in the sidebar.</p>
              ) : (
                <div className="space-y-1.5">
                  {selectedTableGuests.map(guest => (
                    <div key={guest.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50 group">
                      <div className="flex items-center gap-2">
                        <GripVertical className="w-3.5 h-3.5 text-gray-300" />
                        <span className="text-sm text-gray-700">{guestName(guest)}</span>
                        {guest.group_name && <span className="text-[10px] text-gray-400">({guest.group_name})</span>}
                      </div>
                      <button onClick={() => handleUnassignGuest(guest.id)} className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Unassigned guests sidebar */}
        <div className="lg:w-72 shrink-0">
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 sticky top-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-sm" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
                Unassigned Guests
              </h3>
              <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full border',
                unassignedGuests.length > 0 ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200')}>
                {unassignedGuests.length}
              </span>
            </div>

            {/* Search */}
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input type="text" placeholder="Search..." value={guestSearch} onChange={e => setGuestSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} />
            </div>

            {filteredUnassigned.length === 0 ? (
              <div className="text-center py-6">
                {unassignedGuests.length === 0 ? (
                  <>
                    <Users className="w-8 h-8 mx-auto mb-2 text-emerald-300" />
                    <p className="text-xs text-gray-500">Everyone is seated!</p>
                  </>
                ) : (
                  <p className="text-xs text-gray-500">No matching guests.</p>
                )}
              </div>
            ) : (
              <div className="space-y-0.5 max-h-[60vh] overflow-y-auto">
                {filteredUnassigned.map(guest => (
                  <button
                    key={guest.id}
                    onClick={() => {
                      if (selectedTableId) handleAssignGuest(guest.id)
                      else alert('Select a table first, then click a guest to assign them.')
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors group"
                  >
                    <div className="text-left">
                      <span className="block text-sm">{guestName(guest)}</span>
                      {guest.group_name && <span className="text-[10px] text-gray-400">{guest.group_name}</span>}
                    </div>
                    {selectedTableId && (
                      <Plus className="w-3.5 h-3.5 text-gray-300 group-hover:text-gray-500 shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Add Table Modal */}
      {showAddTable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowAddTable(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>Add Table</h2>
              <button onClick={() => setShowAddTable(false)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Table Name</label>
                <input type="text" value={tableForm.table_name} onChange={e => setTableForm({ ...tableForm, table_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} placeholder="e.g., Table 1" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Table Type</label>
                <div className="grid grid-cols-3 gap-2">
                  {TABLE_TYPES.map(type => {
                    const Icon = type.icon
                    return (
                      <button key={type.value} onClick={() => setTableForm({ ...tableForm, table_type: type.value, capacity: type.defaultCapacity.toString() })}
                        className={cn('flex flex-col items-center gap-1 p-2 rounded-lg border text-[10px] font-medium transition-colors',
                          tableForm.table_type === type.value ? 'text-white border-transparent' : 'text-gray-600 border-gray-200 hover:border-gray-300 bg-white')}
                        style={tableForm.table_type === type.value ? { backgroundColor: 'var(--couple-primary)' } : undefined}>
                        <Icon className="w-4 h-4" />
                        {type.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Capacity</label>
                  <input type="number" value={tableForm.capacity} onChange={e => setTableForm({ ...tableForm, capacity: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" min={0} max={30} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Table Size</label>
                  <select value={tableForm.table_size} onChange={e => setTableForm({ ...tableForm, table_size: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                    <option value="">Standard</option>
                    {(TABLE_SIZES[tableForm.table_type] || []).map(s => (
                      <option key={s.label} value={s.label}>{s.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Linen options */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5"><Palette className="w-3.5 h-3.5 inline mr-1" />Linen Color</label>
                <div className="flex flex-wrap gap-1.5">
                  {LINEN_COLORS.map(c => (
                    <button key={c.value} onClick={() => setTableForm({ ...tableForm, linen_color: c.value })}
                      className={cn('w-7 h-7 rounded-full border-2 transition-all', tableForm.linen_color === c.value ? 'border-gray-700 ring-2 ring-offset-1 ring-gray-300' : 'border-gray-200')}
                      style={{ backgroundColor: c.hex }} title={c.label} />
                  ))}
                </div>
                <p className="text-[10px] text-gray-400 mt-1">{LINEN_COLORS.find(c => c.value === tableForm.linen_color)?.label}</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Runner Style</label>
                <div className="flex flex-wrap gap-2">
                  {RUNNER_STYLES.map(r => (
                    <button key={r.value} onClick={() => setTableForm({ ...tableForm, linen_runner: r.value })}
                      className={cn('px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                        tableForm.linen_runner === r.value ? 'text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                      )}
                      style={tableForm.linen_runner === r.value ? { backgroundColor: 'var(--couple-primary)', borderColor: 'var(--couple-primary)' } : undefined}>
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowAddTable(false)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
              <button onClick={handleAddTable} disabled={!tableForm.table_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}>
                Add Table
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Table Modal */}
      {showEditTable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowEditTable(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>Edit Table</h2>
              <button onClick={() => setShowEditTable(false)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Table Name</label>
                <input type="text" value={tableForm.table_name} onChange={e => setTableForm({ ...tableForm, table_name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                  style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Capacity</label>
                  <input type="number" value={tableForm.capacity} onChange={e => setTableForm({ ...tableForm, capacity: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm" min={0} max={30} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Table Size</label>
                  <select value={tableForm.table_size} onChange={e => setTableForm({ ...tableForm, table_size: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-white">
                    <option value="">Standard</option>
                    {(TABLE_SIZES[tableForm.table_type] || []).map(s => (
                      <option key={s.label} value={s.label}>{s.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Linen Color</label>
                <div className="flex flex-wrap gap-1.5">
                  {LINEN_COLORS.map(c => (
                    <button key={c.value} onClick={() => setTableForm({ ...tableForm, linen_color: c.value })}
                      className={cn('w-7 h-7 rounded-full border-2 transition-all', tableForm.linen_color === c.value ? 'border-gray-700 ring-2 ring-offset-1 ring-gray-300' : 'border-gray-200')}
                      style={{ backgroundColor: c.hex }} title={c.label} />
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Runner</label>
                <div className="flex flex-wrap gap-2">
                  {RUNNER_STYLES.map(r => (
                    <button key={r.value} onClick={() => setTableForm({ ...tableForm, linen_runner: r.value })}
                      className={cn('px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                        tableForm.linen_runner === r.value ? 'text-white' : 'border-gray-200 text-gray-600'
                      )}
                      style={tableForm.linen_runner === r.value ? { backgroundColor: 'var(--couple-primary)', borderColor: 'var(--couple-primary)' } : undefined}>
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowEditTable(false)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Cancel</button>
              <button onClick={handleUpdateTable} disabled={!tableForm.table_name.trim()}
                className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: 'var(--couple-primary)' }}>
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Guest Modal */}
      {showAssignModal && selectedTable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30" onClick={() => setShowAssignModal(false)} />
          <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold" style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}>
                Assign to {selectedTable.table_name}
              </h2>
              <button onClick={() => setShowAssignModal(false)} className="text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-gray-500">{selectedTableGuests.length}/{selectedTable.capacity} seats filled.</p>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input type="text" placeholder="Search guests..." value={guestSearch} onChange={e => setGuestSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:border-transparent"
                style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties} />
            </div>

            {filteredUnassigned.length === 0 ? (
              <p className="text-sm text-gray-400 py-4 text-center">{unassignedGuests.length === 0 ? 'All guests are assigned.' : 'No matching guests.'}</p>
            ) : (
              <div className="space-y-0.5 max-h-60 overflow-y-auto">
                {filteredUnassigned.map(guest => (
                  <button key={guest.id}
                    onClick={() => {
                      handleAssignGuest(guest.id)
                      const currentCount = (assignmentsByTable[selectedTableId!] || []).length + 1
                      if (currentCount >= selectedTable.capacity) setShowAssignModal(false)
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                    <div>
                      <span>{guestName(guest)}</span>
                      {guest.group_name && <span className="text-[10px] text-gray-400 ml-2">{guest.group_name}</span>}
                    </div>
                    <Plus className="w-3.5 h-3.5 text-gray-300" />
                  </button>
                ))}
              </div>
            )}

            <div className="flex justify-end pt-2">
              <button onClick={() => setShowAssignModal(false)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800">Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
