'use client'

/**
 * Family + relationships panel.
 *
 * Wave 2D (2026-05-09) — surfaces the new `wedding_relationships` table
 * (mig 255). Today, mom / planner / MOH mentions get captured as
 * partner2 by accident; this panel is their proper home.
 *
 * Lays out rows grouped by relationship_role:
 *   - Mother / Father (parents collapsible)
 *   - Mother-in-law / Father-in-law
 *   - Siblings
 *   - Maid of Honor / Best Man (wedding party)
 *   - Planner
 *   - Vendor contacts
 *   - Family friends / other
 *
 * Each row: full_name, detail, source chip ("AI · email"), confidence
 * pill, archive button. "Add a person" form lands as
 * source='coordinator_added', confidence=null (per mig 255 column doc).
 *
 * Empty state: "No family or planner mentions captured yet — Sage will
 * add them as they appear in correspondence."
 */

import { useEffect, useState, useCallback } from 'react'
import {
  AlertCircle,
  Archive,
  Loader2,
  Plus,
  Users,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type Role =
  | 'mother'
  | 'father'
  | 'mother_in_law'
  | 'father_in_law'
  | 'sibling'
  | 'planner'
  | 'maid_of_honor'
  | 'best_man'
  | 'family_friend'
  | 'vendor_contact'
  | 'other'

interface RelationshipRow {
  id: string
  full_name: string
  relationship_role: Role
  detail: string | null
  email: string | null
  phone: string | null
  source: string
  confidence: number | null
  is_active: boolean
  created_at: string
}

interface ApiResponse {
  rows: RelationshipRow[]
}

const ROLE_LABEL: Record<Role, string> = {
  mother: 'Mother',
  father: 'Father',
  mother_in_law: 'Mother-in-law',
  father_in_law: 'Father-in-law',
  sibling: 'Sibling',
  planner: 'Planner',
  maid_of_honor: 'Maid of Honor',
  best_man: 'Best Man',
  family_friend: 'Family / friend',
  vendor_contact: 'Vendor contact',
  other: 'Other',
}

// Group order — surfaces parents at the top so the coordinator's eye
// hits the most-common relationship first.
const ROLE_GROUP_ORDER: Array<{ key: string; label: string; roles: Role[] }> = [
  { key: 'parents', label: 'Parents', roles: ['mother', 'father'] },
  { key: 'in_laws', label: 'In-laws', roles: ['mother_in_law', 'father_in_law'] },
  { key: 'wedding_party', label: 'Wedding party', roles: ['maid_of_honor', 'best_man'] },
  { key: 'planner', label: 'Planner', roles: ['planner'] },
  { key: 'siblings', label: 'Siblings', roles: ['sibling'] },
  { key: 'vendor_contact', label: 'Vendor contacts', roles: ['vendor_contact'] },
  { key: 'family_friend', label: 'Family + friends', roles: ['family_friend', 'other'] },
]

const SOURCE_LABEL: Record<string, string> = {
  ai_email_extraction: 'AI · email',
  ai_brain_dump: 'AI · brain dump',
  ai_tour_transcript: 'AI · tour',
  coordinator_added: 'Coordinator',
  csv_import: 'CSV import',
}

function fmtSource(s: string): string {
  return SOURCE_LABEL[s] ?? s.replace(/_/g, ' ')
}

function RoleGroupBlock({
  label,
  rows,
  onArchive,
  busyId,
}: {
  label: string
  rows: RelationshipRow[]
  onArchive: (id: string) => void
  busyId: string | null
}) {
  if (rows.length === 0) return null
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] uppercase tracking-wide text-sage-500 font-medium">{label}</p>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex items-start gap-2 rounded-lg border border-sage-100 bg-warm-white px-3 py-2"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-sage-900">{r.full_name}</span>
                <span className="text-[10px] text-sage-500">{ROLE_LABEL[r.relationship_role] ?? r.relationship_role}</span>
                {r.detail && (
                  <span className="text-[11px] text-sage-500 italic">{r.detail}</span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <span
                  className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded font-medium',
                    r.source === 'coordinator_added'
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : 'bg-blue-50 text-blue-700 border border-blue-200',
                  )}
                >
                  {fmtSource(r.source)}
                </span>
                {typeof r.confidence === 'number' && (
                  <span className="text-[10px] text-sage-500">{r.confidence}%</span>
                )}
                {(r.email || r.phone) && (
                  <span className="text-[10px] text-sage-400 truncate">
                    {r.email ?? r.phone}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onArchive(r.id)}
              disabled={busyId === r.id}
              title="Archive"
              className="p-1 rounded hover:bg-sage-100 text-sage-500 disabled:opacity-50 shrink-0"
            >
              <Archive className="w-3.5 h-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add-a-person form
// ---------------------------------------------------------------------------

function AddPersonForm({
  onAdd,
  busy,
}: {
  onAdd: (name: string, role: Role) => void
  busy: boolean
}) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('mother')

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) return
        onAdd(trimmed, role)
        setName('')
      }}
      className="space-y-2"
    >
      <div className="flex items-center gap-2 text-xs font-medium text-sage-700">
        <Plus className="w-3.5 h-3.5" /> Add a person
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          maxLength={200}
          className="flex-1 min-w-[140px] text-sm rounded border border-sage-200 bg-warm-white px-2 py-1.5 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-400"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          className="text-xs rounded border border-sage-200 bg-warm-white px-2 py-1.5 text-sage-700"
        >
          {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="text-xs rounded-md bg-sage-700 text-white px-3 py-1.5 hover:bg-sage-800 disabled:opacity-50"
        >
          {busy ? 'Adding...' : 'Add'}
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function RelationshipsPanel({ weddingId }: { weddingId: string }) {
  const [rows, setRows] = useState<RelationshipRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setErr(null)
    try {
      const res = await fetch(`/api/intel/relationships/${weddingId}`)
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(text || `HTTP ${res.status}`)
      }
      const body = (await res.json()) as ApiResponse
      setRows(body.rows ?? [])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [weddingId])

  useEffect(() => {
    setLoading(true)
    void refresh()
  }, [refresh])

  async function addPerson(fullName: string, role: Role) {
    setPosting(true)
    setErr(null)
    try {
      const res = await fetch(`/api/intel/relationships/${weddingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: fullName, relationship_role: role }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(text || `HTTP ${res.status}`)
      }
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setPosting(false)
    }
  }

  async function archive(id: string) {
    setBusyId(id)
    setErr(null)
    try {
      const res = await fetch(`/api/intel/relationships/${weddingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action: 'archive' }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(text || `HTTP ${res.status}`)
      }
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <Users className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Family + relationships
          </h2>
        </div>
        <div className="flex items-center gap-2 text-sage-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading...
        </div>
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Family + relationships
          </h2>
        </div>
        <p className="text-xs text-sage-500 mt-1">
          Non-partner humans associated with this wedding. Family, planner, MOH, vendor contacts.
        </p>
      </div>

      {err && (
        <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1">{err}</div>
          <button
            type="button"
            onClick={() => setErr(null)}
            className="text-red-500 hover:text-red-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <AddPersonForm onAdd={addPerson} busy={posting} />

      {rows.length === 0 ? (
        <p className="text-sm text-sage-400 italic">
          No family or planner mentions captured yet — Sage will add them as they appear in
          correspondence.
        </p>
      ) : (
        <div className="space-y-3">
          {ROLE_GROUP_ORDER.map((group) => {
            const groupRows = rows.filter((r) => group.roles.includes(r.relationship_role))
            return (
              <RoleGroupBlock
                key={group.key}
                label={group.label}
                rows={groupRows}
                onArchive={archive}
                busyId={busyId}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
