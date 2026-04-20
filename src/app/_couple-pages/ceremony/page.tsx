'use client'

// Feature: configurable via venue_config.feature_flags
// Table: ceremony_order

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import {
  Plus,
  X,
  ChevronUp,
  ChevronDown,
  Heart,
  ArrowDown,
  ArrowUp,
  GripVertical,
  Trash2,
  ListOrdered,
  Save,
  Check,
  Tag,
  UserPlus,
  Info,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// TODO: Get from auth session
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type CeremonySection = 'processional' | 'family_escort' | 'recessional'

const SECTIONS: { key: CeremonySection; label: string; icon: typeof ArrowDown }[] = [
  { key: 'processional', label: 'Processional', icon: ArrowDown },
  { key: 'family_escort', label: 'Family Escort', icon: Heart },
  { key: 'recessional', label: 'Recessional', icon: ArrowUp },
]

const ROLE_OPTIONS = [
  // Couple
  'Bride', 'Groom',
  // Wedding party - traditional
  'Bridesmaid', 'Groomsman', 'Maid of Honor', 'Best Man',
  // Wedding party - inclusive
  'Attendant', 'Best Woman', 'Man of Honor', 'Bride\'s Person', 'Groom\'s Person',
  // Kids
  'Flower Girl', 'Ring Bearer', 'Junior Bridesmaid',
  // Family
  'Mother of Bride', 'Father of Bride', 'Parent of Bride',
  'Mother of Groom', 'Father of Groom', 'Parent of Groom',
  'Grandparent', 'Sibling',
  // Other
  'Usher', 'Officiant', 'Reader', 'Musician',
]

// Traditional processional order (lower index = walks earlier)
const TRAD_ORDER = [
  'Officiant',
  'Grandparent',
  'Mother of Groom', 'Father of Groom', 'Parent of Groom',
  'Mother of Bride',
  'Groom',
  'Usher',
  'Groomsman', 'Groom\'s Person',
  'Best Man', 'Best Woman',
  'Sibling', 'Attendant',
  'Bridesmaid', 'Bride\'s Person',
  'Junior Bridesmaid',
  'Maid of Honor', 'Man of Honor',
  'Ring Bearer', 'Flower Girl',
  'Father of Bride', 'Parent of Bride',
  'Bride',
  'Reader', 'Musician',
]

function roleRank(role: string): number {
  const i = TRAD_ORDER.indexOf(role)
  return i === -1 ? 99 : i
}

function roleBadgeColor(role: string): string {
  if (['Bride', 'Groom'].includes(role)) return '#EC4899'
  if (['Maid of Honor', 'Best Man', 'Man of Honor', 'Best Woman'].includes(role)) return '#8B5CF6'
  if (['Bridesmaid', 'Groomsman', 'Attendant', 'Bride\'s Person', 'Groom\'s Person'].includes(role)) return '#10B981'
  if (['Flower Girl', 'Ring Bearer', 'Junior Bridesmaid'].includes(role)) return '#F59E0B'
  if (['Mother of Bride', 'Father of Bride', 'Parent of Bride', 'Mother of Groom', 'Father of Groom', 'Parent of Groom', 'Grandparent', 'Sibling'].includes(role)) return '#3B82F6'
  if (['Officiant'].includes(role)) return '#6366F1'
  if (['Usher'].includes(role)) return '#14B8A6'
  if (['Reader'].includes(role)) return '#F97316'
  if (['Musician'].includes(role)) return '#EF4444'
  return '#6B7280'
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CeremonyEntry {
  id: string
  participant_name: string
  role: string
  section: CeremonySection
  sort_order: number
  notes: string | null
}

// Marker helpers — used to identify auto-synced ceremony entries
const PARTY_MARKER_RE = /\[party:([0-9a-f-]+)\]/i
const TAG_MARKER_RE = /\[tag:([a-z0-9_-]+)\]/i
function isAutoSynced(entry: CeremonyEntry): boolean {
  if (!entry.notes) return false
  return PARTY_MARKER_RE.test(entry.notes) || TAG_MARKER_RE.test(entry.notes)
}

// Group entries by sort_order to form "steps" (people walking together)
function toSteps(entries: CeremonyEntry[]): CeremonyEntry[][] {
  const sorted = [...entries].sort((a, b) => a.sort_order - b.sort_order)
  const map = new Map<number, CeremonyEntry[]>()
  sorted.forEach((e) => {
    if (!map.has(e.sort_order)) map.set(e.sort_order, [])
    map.get(e.sort_order)!.push(e)
  })
  return [...map.values()]
}

function buildSortUpdates(steps: CeremonyEntry[][]): { id: string; sort_order: number }[] {
  const updates: { id: string; sort_order: number }[] = []
  steps.forEach((step, i) => {
    step.forEach((e) => updates.push({ id: e.id, sort_order: i + 1 }))
  })
  return updates
}

// ---------------------------------------------------------------------------
// Add Person Modal
// ---------------------------------------------------------------------------

function AddPersonModal({
  onClose,
  onAdd,
  defaultSection,
}: {
  onClose: () => void
  onAdd: (name: string, role: string, section: CeremonySection) => Promise<void>
  defaultSection: CeremonySection
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [customRole, setCustomRole] = useState('')
  const [section, setSection] = useState<CeremonySection>(defaultSection)
  const [saving, setSaving] = useState(false)

  const handleSubmit = async () => {
    if (!name.trim()) return
    setSaving(true)
    await onAdd(name.trim(), customRole.trim() || role, section)
    setSaving(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2
            className="text-lg font-semibold"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Add Person
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name *</label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            />
          </div>

          {/* Role chips */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Role</label>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {ROLE_OPTIONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => { setRole(r === role ? '' : r); setCustomRole('') }}
                  className={cn(
                    'px-2.5 py-1 rounded-full text-xs border transition-colors',
                    role === r && !customRole
                      ? 'text-white border-transparent'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                  )}
                  style={role === r && !customRole ? { backgroundColor: roleBadgeColor(r) } : undefined}
                >
                  {r}
                </button>
              ))}
            </div>
            <input
              type="text"
              value={customRole}
              onChange={(e) => { setCustomRole(e.target.value); if (e.target.value) setRole('') }}
              placeholder="Or type a custom role..."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:border-transparent"
              style={{ '--tw-ring-color': 'var(--couple-primary)' } as React.CSSProperties}
            />
          </div>

          {/* Section */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Section</label>
            <div className="grid grid-cols-3 gap-2">
              {SECTIONS.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setSection(s.key)}
                  className={cn(
                    'px-3 py-2 rounded-lg border text-xs font-medium transition-colors',
                    section === s.key
                      ? 'text-white border-transparent'
                      : 'text-gray-600 border-gray-200 hover:border-gray-300 bg-white'
                  )}
                  style={section === s.key ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || saving}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            {saving ? 'Adding...' : 'Add Person'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Person Card
// ---------------------------------------------------------------------------

function PersonCard({ entry }: { entry: CeremonyEntry }) {
  const isParty = entry.notes && PARTY_MARKER_RE.test(entry.notes)
  const isTag = entry.notes && TAG_MARKER_RE.test(entry.notes)
  return (
    <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2 shadow-sm">
      <GripVertical className="w-3.5 h-3.5 text-gray-300 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-gray-800 truncate">{entry.participant_name}</p>
      </div>
      {isParty && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 flex items-center gap-0.5"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--couple-primary) 12%, white)',
            color: 'var(--couple-primary)',
          }}
          title="Auto-synced from wedding party"
        >
          <UserPlus className="w-2.5 h-2.5" />
          Party
        </span>
      )}
      {isTag && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 flex items-center gap-0.5 bg-emerald-50 text-emerald-700"
          title="Added from guest tag"
        >
          <Tag className="w-2.5 h-2.5" />
          Tagged
        </span>
      )}
      {entry.role && (
        <span
          className="px-2 py-0.5 rounded-full text-[10px] font-medium text-white shrink-0"
          style={{ backgroundColor: roleBadgeColor(entry.role) }}
        >
          {entry.role}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section Builder
// ---------------------------------------------------------------------------

function SectionBuilder({
  sectionKey,
  sectionLabel,
  entries,
  onMoveUp,
  onMoveDown,
  onDelete,
  onTraditionalSort,
  onAddPerson,
  onAddTaggedGuests,
  isRecessional,
}: {
  sectionKey: CeremonySection
  sectionLabel: string
  entries: CeremonyEntry[]
  onMoveUp: (entryId: string, sectionKey: CeremonySection) => void
  onMoveDown: (entryId: string, sectionKey: CeremonySection) => void
  onDelete: (entryId: string) => void
  onTraditionalSort: (sectionKey: CeremonySection) => void
  onAddPerson: (sectionKey: CeremonySection) => void
  onAddTaggedGuests?: () => void
  isRecessional?: boolean
}) {
  const steps = toSteps(entries)
  const partyAutoCount = entries.filter((e) => e.notes && PARTY_MARKER_RE.test(e.notes)).length

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      {/* Auto-sync hint for processional */}
      {sectionKey === 'processional' && partyAutoCount > 0 && (
        <div
          className="px-4 py-2.5 border-b border-gray-100 flex items-start gap-2"
          style={{ backgroundColor: 'color-mix(in srgb, var(--couple-primary) 5%, white)' }}
        >
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: 'var(--couple-primary)' }} />
          <p className="text-xs text-gray-600">
            <span className="font-medium" style={{ color: 'var(--couple-primary)' }}>
              {partyAutoCount} wedding party member{partyAutoCount === 1 ? '' : 's'} added automatically.
            </span>{' '}
            Remove individuals below to exclude from the processional.
          </p>
        </div>
      )}

      {/* Hint bar */}
      {entries.length > 0 && (
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
          <p className="text-xs text-gray-400">
            Use arrows to reorder. Up to 3 people can walk together in one step.
          </p>
          <button
            onClick={() => onTraditionalSort(sectionKey)}
            className="text-xs font-medium hover:opacity-80 transition-opacity"
            style={{ color: 'var(--couple-primary)' }}
          >
            <span className="flex items-center gap-1">
              <ListOrdered className="w-3.5 h-3.5" />
              Sort traditionally
            </span>
          </button>
        </div>
      )}

      {/* Vertical timeline */}
      <div className="p-4">
        {steps.length === 0 ? (
          <p className="text-sm text-gray-400 italic text-center py-8">
            Add people below to build this section.
          </p>
        ) : (
          <div className="relative">
            {/* Vertical line */}
            <div
              className="absolute left-[18px] top-5 bottom-5 w-0.5"
              style={{ backgroundColor: 'var(--couple-primary)', opacity: 0.15 }}
            />

            <div className="space-y-4">
              {steps.map((step, stepIdx) => (
                <div key={stepIdx} className="flex items-start gap-3">
                  {/* Step number circle */}
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-xs font-bold text-white z-10"
                    style={{ backgroundColor: 'var(--couple-primary)' }}
                  >
                    {stepIdx + 1}
                  </div>

                  {/* People in this step */}
                  <div className="flex-1 space-y-1.5">
                    {step.map((entry) => (
                      <div key={entry.id} className="flex items-center gap-1.5 group">
                        <div className="flex-1">
                          <PersonCard entry={entry} />
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                          <button
                            onClick={() => onMoveUp(entry.id, sectionKey)}
                            className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-50"
                            title="Move up"
                          >
                            <ChevronUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onMoveDown(entry.id, sectionKey)}
                            className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-50"
                            title="Move down"
                          >
                            <ChevronDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => onDelete(entry.id)}
                            className="p-1 rounded text-gray-400 hover:text-red-500 hover:bg-red-50"
                            title="Remove"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Add buttons */}
      <div className="px-4 py-3 border-t border-gray-100 flex items-center gap-4 flex-wrap">
        <button
          onClick={() => onAddPerson(sectionKey)}
          className="text-sm font-medium flex items-center gap-1 hover:opacity-80 transition-opacity"
          style={{ color: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" /> Add person
        </button>
        {sectionKey === 'processional' && onAddTaggedGuests && (
          <button
            onClick={onAddTaggedGuests}
            className="text-sm font-medium flex items-center gap-1 hover:opacity-80 transition-opacity"
            style={{ color: 'var(--couple-primary)' }}
          >
            <Tag className="w-4 h-4" /> Add tagged guests
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add Tagged Guests Modal
// ---------------------------------------------------------------------------

interface TaggedGuest {
  id: string
  first_name: string
  last_name: string
}

function AddTaggedGuestsModal({
  onClose,
  onAdd,
  existingNames,
  supabase,
  weddingId,
}: {
  onClose: () => void
  onAdd: (guests: TaggedGuest[]) => Promise<void>
  existingNames: Set<string>
  supabase: ReturnType<typeof createClient>
  weddingId: string
}) {
  const [loading, setLoading] = useState(true)
  const [guests, setGuests] = useState<TaggedGuest[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [tagMissing, setTagMissing] = useState(false)

  useEffect(() => {
    const load = async () => {
      try {
        // 1) Find the Processional tag for this wedding
        const { data: tagRows } = await supabase
          .from('guest_tags')
          .select('id, tag_name')
          .eq('wedding_id', weddingId)
          .ilike('tag_name', 'Processional')

        if (!tagRows || tagRows.length === 0) {
          setTagMissing(true)
          setLoading(false)
          return
        }

        const tagIds = tagRows.map((t: { id: string }) => t.id)

        // 2) Get assignments for those tags
        const { data: assignments } = await supabase
          .from('guest_tag_assignments')
          .select('guest_id')
          .in('tag_id', tagIds)

        const guestIds = Array.from(new Set((assignments || []).map((a: { guest_id: string }) => a.guest_id)))
        if (guestIds.length === 0) {
          setGuests([])
          setLoading(false)
          return
        }

        // 3) Fetch guest list rows
        const { data: guestRows } = await supabase
          .from('guest_list')
          .select('id, first_name, last_name')
          .in('id', guestIds)
          .eq('wedding_id', weddingId)
          .order('last_name', { ascending: true })

        // Filter out guests already in the ceremony order (by name)
        const filtered = (guestRows || []).filter((g: TaggedGuest) => {
          const fullName = `${g.first_name} ${g.last_name}`.trim()
          return !existingNames.has(fullName)
        })
        setGuests(filtered as TaggedGuest[])
      } catch (err) {
        console.error('Failed to load tagged guests:', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [supabase, existingNames])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === guests.length) setSelected(new Set())
    else setSelected(new Set(guests.map((g) => g.id)))
  }

  const handleSubmit = async () => {
    const chosen = guests.filter((g) => selected.has(g.id))
    if (chosen.length === 0) return
    setSaving(true)
    await onAdd(chosen)
    setSaving(false)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2
            className="text-lg font-semibold"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            Add Tagged Guests
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : tagMissing ? (
          <div className="text-center py-6">
            <Tag className="w-10 h-10 mx-auto mb-3 text-gray-300" />
            <p className="text-sm text-gray-500 mb-1 font-medium">No Processional tag found.</p>
            <p className="text-xs text-gray-400">
              Tag guests as &lsquo;Processional&rsquo; on the guest list page first.
            </p>
          </div>
        ) : guests.length === 0 ? (
          <div className="text-center py-6">
            <Tag className="w-10 h-10 mx-auto mb-3 text-gray-300" />
            <p className="text-sm text-gray-500 mb-1 font-medium">No guests to add.</p>
            <p className="text-xs text-gray-400">
              Tag guests as &lsquo;Processional&rsquo; on the guest list page first.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>{guests.length} guest{guests.length === 1 ? '' : 's'} tagged Processional</span>
              <button
                type="button"
                onClick={toggleAll}
                className="font-medium hover:opacity-80"
                style={{ color: 'var(--couple-primary)' }}
              >
                {selected.size === guests.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {guests.map((g) => {
                const isSel = selected.has(g.id)
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => toggle(g.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors text-left"
                  >
                    <span
                      className={cn(
                        'w-4 h-4 rounded border flex items-center justify-center shrink-0',
                        isSel ? 'border-transparent' : 'border-gray-300',
                      )}
                      style={isSel ? { backgroundColor: 'var(--couple-primary)' } : undefined}
                    >
                      {isSel && <Check className="w-3 h-3 text-white" />}
                    </span>
                    <span className="text-sm text-gray-700">
                      {g.first_name} {g.last_name}
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 transition-colors"
          >
            Cancel
          </button>
          {!loading && !tagMissing && guests.length > 0 && (
            <button
              onClick={handleSubmit}
              disabled={selected.size === 0 || saving}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: 'var(--couple-primary)' }}
            >
              {saving ? 'Adding...' : `Add ${selected.size || ''}`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function CeremonyOrderPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [entries, setEntries] = useState<CeremonyEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [modalSection, setModalSection] = useState<CeremonySection>('processional')
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState(false)
  const [showTaggedModal, setShowTaggedModal] = useState(false)

  const supabase = createClient()

  // ---- Fetch ----
  const fetchEntries = useCallback(async () => {
    if (!weddingId) return
    try {
      const { data, error } = await supabase
        .from('ceremony_order')
        .select('id, participant_name, role, section, sort_order, notes')
        .eq('wedding_id', weddingId)
        .order('sort_order', { ascending: true })

      if (!error && data) {
        setEntries(data as CeremonyEntry[])
      }
    } catch (err) {
      console.error('Failed to load ceremony order:', err)
    } finally {
      setLoading(false)
    }
  }, [supabase, weddingId])

  // BUG-04A: wait for weddingId before firing fetch.
  useEffect(() => {
    if (!weddingId) return
    fetchEntries()
  }, [weddingId, fetchEntries])

  // ---- Add person ----
  const handleAdd = async (name: string, role: string, section: CeremonySection) => {
    const sectionEntries = entries.filter((e) => e.section === section)
    const maxOrder = sectionEntries.length > 0
      ? Math.max(...sectionEntries.map((e) => e.sort_order))
      : 0

    const { error } = await supabase.from('ceremony_order').insert({
      venue_id: venueId,
      wedding_id: weddingId,
      section,
      participant_name: name,
      role: role || null,
      sort_order: maxOrder + 1,
      side: 'both',
    })

    if (error) {
      console.error('Failed to add ceremony participant:', error)
      alert('Failed to add person. Please try again.')
      return
    }

    fetchEntries()
  }

  // ---- Delete ----
  const handleDelete = async (id: string) => {
    if (!confirm('Remove this person from the ceremony?')) return
    await supabase.from('ceremony_order').delete().eq('id', id)
    setEntries((prev) => prev.filter((e) => e.id !== id))
  }

  // ---- Persist sort order updates ----
  const persistSortUpdates = async (updates: { id: string; sort_order: number }[]) => {
    setSaving(true)
    try {
      await Promise.all(
        updates.map(({ id, sort_order }) =>
          supabase.from('ceremony_order').update({ sort_order }).eq('id', id)
        )
      )
      // Update local state
      setEntries((prev) =>
        prev.map((e) => {
          const u = updates.find((up) => up.id === e.id)
          return u ? { ...e, sort_order: u.sort_order } : e
        })
      )
    } catch (err) {
      console.error('Failed to update order:', err)
    }
    setSaving(false)
  }

  // ---- Move up ----
  const handleMoveUp = (entryId: string, sectionKey: CeremonySection) => {
    const sectionEntries = entries.filter((e) => e.section === sectionKey)
    const steps = toSteps(sectionEntries)

    // Find which step and index within step
    let stepIdx = -1
    let entryIdx = -1
    steps.forEach((step, si) => {
      const ei = step.findIndex((e) => e.id === entryId)
      if (ei !== -1) { stepIdx = si; entryIdx = ei }
    })

    if (stepIdx <= 0 && entryIdx === 0) return // Already at top

    // If multiple people in the step, move entry to previous step
    // If alone in step, swap step with previous
    const newSteps = steps.map((s) => [...s])

    if (newSteps[stepIdx].length > 1) {
      // Remove from current step, create new step before current
      const entry = newSteps[stepIdx].splice(entryIdx, 1)[0]
      newSteps.splice(stepIdx, 0, [entry])
    } else {
      // Swap with previous step
      if (stepIdx > 0) {
        const temp = newSteps[stepIdx - 1]
        newSteps[stepIdx - 1] = newSteps[stepIdx]
        newSteps[stepIdx] = temp
      }
    }

    const updates = buildSortUpdates(newSteps)
    persistSortUpdates(updates)
  }

  // ---- Move down ----
  const handleMoveDown = (entryId: string, sectionKey: CeremonySection) => {
    const sectionEntries = entries.filter((e) => e.section === sectionKey)
    const steps = toSteps(sectionEntries)

    let stepIdx = -1
    let entryIdx = -1
    steps.forEach((step, si) => {
      const ei = step.findIndex((e) => e.id === entryId)
      if (ei !== -1) { stepIdx = si; entryIdx = ei }
    })

    if (stepIdx >= steps.length - 1 && (steps[stepIdx]?.length ?? 0) <= 1) return // Already at bottom

    const newSteps = steps.map((s) => [...s])

    if (newSteps[stepIdx].length > 1) {
      // Remove from current step, create new step after current
      const entry = newSteps[stepIdx].splice(entryIdx, 1)[0]
      newSteps.splice(stepIdx + 1, 0, [entry])
    } else {
      // Swap with next step
      if (stepIdx < newSteps.length - 1) {
        const temp = newSteps[stepIdx + 1]
        newSteps[stepIdx + 1] = newSteps[stepIdx]
        newSteps[stepIdx] = temp
      }
    }

    const updates = buildSortUpdates(newSteps)
    persistSortUpdates(updates)
  }

  // ---- Traditional sort ----
  const handleTraditionalSort = (sectionKey: CeremonySection) => {
    const sectionEntries = entries.filter((e) => e.section === sectionKey)
    const sorted = [...sectionEntries].sort((a, b) => {
      const diff = roleRank(a.role) - roleRank(b.role)
      // Recessional exits in reverse order
      if (sectionKey === 'recessional') return -diff
      return diff
    })

    // Each person gets their own step
    const newSteps = sorted.map((e) => [e])
    const updates = buildSortUpdates(newSteps)
    persistSortUpdates(updates)
  }

  // ---- Open modal ----
  const openAddModal = (sectionKey: CeremonySection) => {
    setModalSection(sectionKey)
    setShowModal(true)
  }

  // ---- Add tagged guests (Processional) ----
  const handleAddTaggedGuests = async (guests: TaggedGuest[]) => {
    const processionalEntries = entries.filter((e) => e.section === 'processional')
    let nextOrder = processionalEntries.length > 0
      ? Math.max(...processionalEntries.map((e) => e.sort_order)) + 1
      : 1

    const inserts = guests.map((g) => ({
      venue_id: venueId,
      wedding_id: weddingId,
      section: 'processional',
      participant_name: `${g.first_name} ${g.last_name}`.trim(),
      role: null,
      sort_order: nextOrder++,
      side: 'both',
      notes: '[tag:processional]',
    }))

    if (inserts.length === 0) return

    const { error } = await supabase.from('ceremony_order').insert(inserts)
    if (error) {
      console.error('Failed to add tagged guests:', error)
      alert('Failed to add tagged guests. Please try again.')
      return
    }
    fetchEntries()
  }

  // ---- Stats ----
  const processionalCount = entries.filter((e) => e.section === 'processional').length
  const familyEscortCount = entries.filter((e) => e.section === 'family_escort').length
  const recessionalCount = entries.filter((e) => e.section === 'recessional').length
  const totalCount = entries.length

  if (contextLoading || !weddingId || !venueId || loading) {
    return (
      <div className="animate-pulse space-y-6">
        <div className="h-8 w-48 bg-gray-200 rounded" />
        <div className="grid grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-gray-100 rounded-xl" />
          ))}
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-48 bg-gray-100 rounded-xl" />
        ))}
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
            Ceremony Order
          </h1>
          <p className="text-gray-500 text-sm">
            Build your processional, family escort, and recessional lineup. Drop onto cards to walk together.
          </p>
        </div>
        <button
          onClick={() => openAddModal('processional')}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: 'var(--couple-primary)' }}
        >
          <Plus className="w-4 h-4" />
          Add Person
        </button>
      </div>

      {/* Stats */}
      {totalCount > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl p-4 border text-center" style={{ backgroundColor: 'color-mix(in srgb, var(--couple-primary) 6%, white)', borderColor: 'color-mix(in srgb, var(--couple-primary) 15%, white)' }}>
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>{processionalCount}</p>
            <p className="text-xs font-medium text-gray-500">Processional</p>
          </div>
          <div className="bg-pink-50 rounded-xl p-4 border border-pink-100 text-center">
            <p className="text-2xl font-bold text-pink-700 tabular-nums">{familyEscortCount}</p>
            <p className="text-xs text-pink-600 font-medium">Family Escort</p>
          </div>
          <div className="bg-blue-50 rounded-xl p-4 border border-blue-100 text-center">
            <p className="text-2xl font-bold text-blue-700 tabular-nums">{recessionalCount}</p>
            <p className="text-xs text-blue-600 font-medium">Recessional</p>
          </div>
        </div>
      )}

      {/* Empty state */}
      {totalCount === 0 && (
        <div className="text-center py-16 bg-white rounded-xl border border-gray-100 shadow-sm">
          <Heart className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)', opacity: 0.3 }} />
          <h3
            className="text-lg font-semibold mb-2"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            No ceremony lineup yet
          </h3>
          <p className="text-gray-500 text-sm mb-4">Add participants to build your processional order.</p>
          <button
            onClick={() => openAddModal('processional')}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: 'var(--couple-primary)' }}
          >
            <Plus className="w-4 h-4" />
            Add First Person
          </button>
        </div>
      )}

      {/* Sections */}
      {totalCount > 0 && (
        <div className="space-y-8">
          {SECTIONS.map(({ key, label, icon: Icon }, sectionIdx) => {
            const sectionEntries = entries.filter((e) => e.section === key)
            return (
              <section key={key}>
                <div className="flex items-center gap-2 mb-3">
                  <span
                    className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white"
                    style={{ backgroundColor: 'var(--couple-primary)' }}
                  >
                    {sectionIdx + 1}
                  </span>
                  <h3
                    className="text-base font-semibold"
                    style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
                  >
                    {label}
                  </h3>
                  <div className="flex-1 h-px bg-gray-200" />
                  <Icon className="w-4 h-4 text-gray-400" />
                </div>

                <SectionBuilder
                  sectionKey={key}
                  sectionLabel={label}
                  entries={sectionEntries}
                  onMoveUp={handleMoveUp}
                  onMoveDown={handleMoveDown}
                  onDelete={handleDelete}
                  onTraditionalSort={handleTraditionalSort}
                  onAddPerson={openAddModal}
                  onAddTaggedGuests={key === 'processional' ? () => setShowTaggedModal(true) : undefined}
                  isRecessional={key === 'recessional'}
                />
              </section>
            )
          })}
        </div>
      )}

      {/* Save indicator */}
      {saving && (
        <div className="fixed bottom-6 right-6 bg-white rounded-lg shadow-lg border border-gray-200 px-4 py-2 text-sm text-gray-500 flex items-center gap-2 z-40">
          <div className="w-3 h-3 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
          Saving...
        </div>
      )}

      {/* Add Person Modal */}
      {showModal && (
        <AddPersonModal
          onClose={() => setShowModal(false)}
          onAdd={handleAdd}
          defaultSection={modalSection}
        />
      )}

      {/* Add Tagged Guests Modal */}
      {showTaggedModal && (
        <AddTaggedGuestsModal
          onClose={() => setShowTaggedModal(false)}
          onAdd={handleAddTaggedGuests}
          existingNames={
            new Set(
              entries
                .filter((e) => e.section === 'processional')
                .map((e) => e.participant_name.trim()),
            )
          }
          supabase={supabase}
          weddingId={weddingId}
        />
      )}
    </div>
  )
}
