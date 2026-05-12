'use client'

/**
 * Wave 6E dashboard + profile depth — sections that hang off the
 * /intel/agencies/[id] page. Extracted into a component file because
 * the page itself was already at the comfortable size and this added
 * ~600 lines of new sections.
 *
 * Each section is self-contained: takes agencyId + a reload callback,
 * fetches its own data, renders its own form.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Loader2,
  Plus,
  Trash2,
  Users,
  FileText,
  Target,
  History,
  Calendar,
  TrendingUp,
  Briefcase,
  AlertTriangle,
  ExternalLink,
  Edit2,
  Check,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Shared formatting helpers
// ---------------------------------------------------------------------------

export function formatDollars(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return '—'
  const dollars = cents / 100
  return `$${dollars.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`
}

export function formatShortMonth(monthIso: string): string {
  const d = new Date(`${monthIso}T00:00:00.000Z`)
  return d.toLocaleString('en-US', { month: 'short', year: '2-digit' })
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

// ===========================================================================
// 12-month trend strip
// ===========================================================================

interface TrendMonth {
  month: string
  spendCents: number
  retainerCents: number
  totalCents: number
  firstTouchLeads: number
  firstTouchBookings: number
}

export function AgencyTrendStrip({ trend }: { trend: TrendMonth[] }) {
  if (trend.length === 0) return null
  const maxSpend = Math.max(...trend.map((m) => m.totalCents), 1)
  const maxLeads = Math.max(...trend.map((m) => m.firstTouchLeads), 1)
  return (
    <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg flex items-center gap-2">
          <TrendingUp className="h-4 w-4" /> 12-month trend
        </h2>
        <span className="text-xs text-[var(--bh-muted)]">
          Spend + retainer (bars) and first-touch leads (line)
        </span>
      </div>

      <div className="mt-4 grid grid-cols-12 gap-1">
        {trend.slice(-12).map((m) => {
          const spendH = (m.totalCents / maxSpend) * 100
          return (
            <div key={m.month} className="flex flex-col items-stretch">
              <div className="relative h-32 bg-[var(--bh-warm-50)]/40 rounded flex flex-col-reverse">
                <div
                  className="bg-[var(--bh-sage-500)] rounded-t"
                  style={{ height: `${spendH}%`, minHeight: m.totalCents > 0 ? '2px' : 0 }}
                  title={`${formatDollars(m.totalCents)} spend`}
                />
                {m.firstTouchLeads > 0 ? (
                  <div
                    className="absolute left-0 right-0 h-px bg-[var(--bh-gold-500)]"
                    style={{
                      bottom: `${(m.firstTouchLeads / maxLeads) * 100}%`,
                    }}
                  />
                ) : null}
              </div>
              <div className="mt-1 text-center text-[9px] text-[var(--bh-muted)] tabular-nums">
                {formatShortMonth(m.month)}
              </div>
              <div className="text-center text-[10px] tabular-nums">
                {m.firstTouchLeads || '–'}
                {m.firstTouchBookings > 0 ? (
                  <span className="text-emerald-700"> · {m.firstTouchBookings}b</span>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      <p className="mt-3 text-[10px] text-[var(--bh-muted)]">
        Bars are total monthly cost (direct spend + retainer accrual). Bottom
        annotations show first-touch leads / bookings. Empty months mean
        either no spend or no attributed activity in the window.
      </p>
    </section>
  )
}

// ===========================================================================
// Per-channel breakdown table
// ===========================================================================

interface PerChannelRow {
  channelKey: string
  spendCents: number
  firstTouchLeads: number
  firstTouchTours: number
  firstTouchBookings: number
  bookedRevenueCents: number
  costPerBookingCents: number | null
  costPerLeadCents: number | null
}

export function AgencyPerChannelTable({
  rows,
  channelLabels,
}: {
  rows: PerChannelRow[]
  channelLabels: Map<string, string>
}) {
  if (rows.length === 0) return null
  return (
    <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
      <h2 className="font-serif text-lg">Per-channel breakdown</h2>
      <p className="mt-1 text-xs text-[var(--bh-muted)]">
        Spend + first-touch attribution split by each managed channel.
      </p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--bh-line)] text-left text-xs uppercase tracking-wide text-[var(--bh-muted)]">
              <th className="py-2 pr-3">Channel</th>
              <th className="py-2 pr-3 text-right">Spend</th>
              <th className="py-2 pr-3 text-right">Leads</th>
              <th className="py-2 pr-3 text-right">Tours</th>
              <th className="py-2 pr-3 text-right">Bookings</th>
              <th className="py-2 pr-3 text-right">$/lead</th>
              <th className="py-2 pr-3 text-right">$/booking</th>
              <th className="py-2 pr-3 text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.channelKey}
                className="border-b border-[var(--bh-line)]/60"
              >
                <td className="py-2 pr-3 font-medium">
                  {channelLabels.get(r.channelKey) ?? r.channelKey}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatDollars(r.spendCents)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {r.firstTouchLeads}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {r.firstTouchTours}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {r.firstTouchBookings}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatDollars(r.costPerLeadCents)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatDollars(r.costPerBookingCents)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatDollars(r.bookedRevenueCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ===========================================================================
// Persona overlay (which personas the agency attracts)
// ===========================================================================

export function AgencyPersonaOverlay({
  personaCounts,
}: {
  personaCounts: Record<string, number>
}) {
  const entries = Object.entries(personaCounts).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  const total = entries.reduce((s, [, n]) => s + n, 0)
  return (
    <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
      <h2 className="font-serif text-lg">Persona distribution</h2>
      <p className="mt-1 text-xs text-[var(--bh-muted)]">
        Which personas this agency&apos;s channels brought, based on Wave 5A
        couple_intel labels overlaid on first-touch attribution.
      </p>
      <div className="mt-4 space-y-2">
        {entries.map(([label, n]) => (
          <div key={label}>
            <div className="flex items-baseline justify-between text-sm">
              <span>{label}</span>
              <span className="tabular-nums text-[var(--bh-muted)]">
                {n} · {Math.round((n / total) * 100)}%
              </span>
            </div>
            <div className="h-1.5 rounded bg-[var(--bh-warm-50)]">
              <div
                className="h-1.5 rounded bg-[var(--bh-sage-500)]"
                style={{ width: `${(n / total) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ===========================================================================
// Contacts section
// ===========================================================================

interface ContactRow {
  id: string
  name: string
  email: string | null
  phone: string | null
  role: string | null
  notes: string | null
  isPrimary: boolean
}

const ROLE_OPTIONS = [
  { value: 'account_manager', label: 'Account manager' },
  { value: 'strategist', label: 'Strategist' },
  { value: 'creative', label: 'Creative' },
  { value: 'billing', label: 'Billing' },
  { value: 'founder', label: 'Founder' },
  { value: 'support', label: 'Support' },
  { value: 'other', label: 'Other' },
]

export function AgencyContactsSection({ agencyId }: { agencyId: string }) {
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch(`/api/intel/agencies/${agencyId}/contacts`)
      if (!resp.ok) return
      const j = (await resp.json()) as { contacts: ContactRow[] }
      setContacts(j.contacts ?? [])
    } finally {
      setLoading(false)
    }
  }, [agencyId])
  useEffect(() => {
    void reload()
  }, [reload])

  const handleDelete = useCallback(
    async (id: string) => {
      await fetch(`/api/intel/agencies/${agencyId}/contacts/${id}`, {
        method: 'DELETE',
      })
      await reload()
    },
    [agencyId, reload],
  )

  return (
    <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg flex items-center gap-2">
          <Users className="h-4 w-4" /> Contacts
          {contacts.length > 0 ? (
            <span className="text-xs text-[var(--bh-muted)]">
              ({contacts.length})
            </span>
          ) : null}
        </h2>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--bh-line)] bg-white px-3 py-1 text-xs hover:bg-[var(--bh-sage-50)]"
        >
          <Plus className="h-3 w-3" /> {showForm ? 'Cancel' : 'Add contact'}
        </button>
      </div>

      {showForm ? (
        <ContactForm
          agencyId={agencyId}
          onSaved={async () => {
            setShowForm(false)
            await reload()
          }}
        />
      ) : null}

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-[var(--bh-muted)]">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading…
        </div>
      ) : contacts.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--bh-muted)]">
          No contacts on file. Add the account manager, strategist, and
          billing contact so the activity log has names attached.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--bh-line)]/60">
          {contacts.map((c) => (
            <li key={c.id} className="py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{c.name}</span>
                  {c.isPrimary ? (
                    <span className="rounded-full bg-[var(--bh-sage-50)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--bh-sage-700)]">
                      primary
                    </span>
                  ) : null}
                  {c.role ? (
                    <span className="text-xs text-[var(--bh-muted)]">
                      {ROLE_OPTIONS.find((r) => r.value === c.role)?.label ?? c.role}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-xs text-[var(--bh-muted)]">
                  {[c.email, c.phone].filter(Boolean).join(' · ') || '—'}
                </div>
                {c.notes ? (
                  <p className="mt-1 text-xs text-[var(--bh-ink)]">{c.notes}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => void handleDelete(c.id)}
                className="text-rose-600 hover:text-rose-800"
                title="Delete"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ContactForm({
  agencyId,
  onSaved,
}: {
  agencyId: string
  onSaved: () => Promise<void> | void
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState('')
  const [notes, setNotes] = useState('')
  const [isPrimary, setIsPrimary] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!name.trim()) return
      setSubmitting(true)
      try {
        await fetch(`/api/intel/agencies/${agencyId}/contacts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            email: email || null,
            phone: phone || null,
            role: role || null,
            notes: notes || null,
            isPrimary,
          }),
        })
        await onSaved()
      } finally {
        setSubmitting(false)
      }
    },
    [agencyId, name, email, phone, role, notes, isPrimary, onSaved],
  )
  return (
    <form
      onSubmit={submit}
      className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-[var(--bh-line)] bg-[var(--bh-sage-50)]/40 p-3 md:grid-cols-2"
    >
      <input
        type="text"
        placeholder="Name"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
      >
        <option value="">— role —</option>
        {ROLE_OPTIONS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
      />
      <input
        type="tel"
        placeholder="Phone"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
      />
      <input
        type="text"
        placeholder="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm md:col-span-2"
      />
      <label className="flex items-center gap-1 text-xs text-[var(--bh-muted)] md:col-span-2">
        <input
          type="checkbox"
          checked={isPrimary}
          onChange={(e) => setIsPrimary(e.target.checked)}
        />
        Primary contact (only one per agency)
      </label>
      <button
        type="submit"
        disabled={submitting || !name.trim()}
        className="inline-flex items-center gap-2 rounded-md bg-[var(--bh-sage-700)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50 md:col-span-2"
      >
        {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        Save contact
      </button>
    </form>
  )
}

// ===========================================================================
// Documents section
// ===========================================================================

interface DocumentRow {
  id: string
  name: string
  fileUrl: string | null
  kind: string | null
  effectiveDate: string | null
  expiresAt: string | null
  notes: string | null
  createdAt: string
}

const DOCUMENT_KINDS = [
  { value: 'contract', label: 'Contract' },
  { value: 'sow', label: 'SOW' },
  { value: 'monthly_report', label: 'Monthly report' },
  { value: 'quarterly_review', label: 'Quarterly review' },
  { value: 'statement', label: 'Statement' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'asset_brief', label: 'Asset brief' },
  { value: 'other', label: 'Other' },
]

export function AgencyDocumentsSection({ agencyId }: { agencyId: string }) {
  const [docs, setDocs] = useState<DocumentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch(`/api/intel/agencies/${agencyId}/documents`)
      if (!resp.ok) return
      const j = (await resp.json()) as { documents: DocumentRow[] }
      setDocs(j.documents ?? [])
    } finally {
      setLoading(false)
    }
  }, [agencyId])
  useEffect(() => {
    void reload()
  }, [reload])

  const today = todayIso()
  const expiringSoon = docs.filter(
    (d) =>
      d.expiresAt &&
      d.expiresAt >= today &&
      new Date(d.expiresAt).getTime() - new Date(today).getTime() <
        30 * 24 * 60 * 60 * 1000,
  )

  const handleDelete = useCallback(
    async (id: string) => {
      await fetch(`/api/intel/agencies/${agencyId}/documents/${id}`, {
        method: 'DELETE',
      })
      await reload()
    },
    [agencyId, reload],
  )

  return (
    <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg flex items-center gap-2">
          <FileText className="h-4 w-4" /> Documents
          {docs.length > 0 ? (
            <span className="text-xs text-[var(--bh-muted)]">
              ({docs.length})
            </span>
          ) : null}
        </h2>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--bh-line)] bg-white px-3 py-1 text-xs hover:bg-[var(--bh-sage-50)]"
        >
          <Plus className="h-3 w-3" /> {showForm ? 'Cancel' : 'Add link'}
        </button>
      </div>

      {expiringSoon.length > 0 ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          <AlertTriangle className="h-3 w-3 mt-0.5" />
          {expiringSoon.length} document
          {expiringSoon.length === 1 ? '' : 's'} expiring in the next 30 days.
        </div>
      ) : null}

      {showForm ? (
        <DocumentForm
          agencyId={agencyId}
          onSaved={async () => {
            setShowForm(false)
            await reload()
          }}
        />
      ) : null}

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-[var(--bh-muted)]">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading…
        </div>
      ) : docs.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--bh-muted)]">
          No documents linked. Drop contract URLs (Drive, Dropbox, agency
          portal) here so they live next to the truth view.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--bh-line)]/60">
          {docs.map((d) => (
            <li key={d.id} className="py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {d.fileUrl ? (
                    <a
                      href={d.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium hover:underline"
                    >
                      {d.name}
                      <ExternalLink className="ml-1 inline h-3 w-3" />
                    </a>
                  ) : (
                    <span className="font-medium">{d.name}</span>
                  )}
                  {d.kind ? (
                    <span className="rounded-full bg-[var(--bh-warm-50)] px-2 py-0.5 text-[10px] uppercase text-[var(--bh-muted)]">
                      {DOCUMENT_KINDS.find((k) => k.value === d.kind)?.label ?? d.kind}
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-xs text-[var(--bh-muted)]">
                  {d.effectiveDate ? `Effective ${d.effectiveDate}` : null}
                  {d.effectiveDate && d.expiresAt ? ' · ' : null}
                  {d.expiresAt ? `Expires ${d.expiresAt}` : null}
                </div>
                {d.notes ? (
                  <p className="mt-1 text-xs text-[var(--bh-ink)]">{d.notes}</p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => void handleDelete(d.id)}
                className="text-rose-600 hover:text-rose-800"
                title="Remove"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function DocumentForm({
  agencyId,
  onSaved,
}: {
  agencyId: string
  onSaved: () => Promise<void> | void
}) {
  const [name, setName] = useState('')
  const [fileUrl, setFileUrl] = useState('')
  const [kind, setKind] = useState('')
  const [effectiveDate, setEffectiveDate] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!name.trim()) return
      setSubmitting(true)
      try {
        await fetch(`/api/intel/agencies/${agencyId}/documents`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            fileUrl: fileUrl || null,
            kind: kind || null,
            effectiveDate: effectiveDate || null,
            expiresAt: expiresAt || null,
            notes: notes || null,
          }),
        })
        await onSaved()
      } finally {
        setSubmitting(false)
      }
    },
    [agencyId, name, fileUrl, kind, effectiveDate, expiresAt, notes, onSaved],
  )
  return (
    <form
      onSubmit={submit}
      className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-[var(--bh-line)] bg-[var(--bh-sage-50)]/40 p-3 md:grid-cols-2"
    >
      <input
        type="text"
        placeholder="Document name"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm md:col-span-2"
      />
      <input
        type="url"
        placeholder="URL (Drive / Dropbox / portal)"
        value={fileUrl}
        onChange={(e) => setFileUrl(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm md:col-span-2"
      />
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
      >
        <option value="">— type —</option>
        {DOCUMENT_KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </select>
      <input
        type="text"
        placeholder="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
      />
      <label className="text-xs text-[var(--bh-muted)]">
        Effective date
        <input
          type="date"
          value={effectiveDate}
          onChange={(e) => setEffectiveDate(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
        />
      </label>
      <label className="text-xs text-[var(--bh-muted)]">
        Expires at
        <input
          type="date"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
        />
      </label>
      <button
        type="submit"
        disabled={submitting || !name.trim()}
        className="inline-flex items-center gap-2 rounded-md bg-[var(--bh-sage-700)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50 md:col-span-2"
      >
        {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        Save document
      </button>
    </form>
  )
}

// ===========================================================================
// KPI commitments section
// ===========================================================================

interface KpiRow {
  id: string
  metricName: string
  targetValue: number
  targetUnit: string
  targetWindow: string
  notes: string | null
  effectiveFrom: string
  effectiveTo: string | null
}

const KPI_UNITS = [
  { value: 'count', label: 'count' },
  { value: 'usd', label: 'USD' },
  { value: 'cents', label: 'cents' },
  { value: 'percent', label: '%' },
  { value: 'days', label: 'days' },
  { value: 'minutes', label: 'min' },
  { value: 'other', label: 'other' },
]

const KPI_WINDOWS = [
  { value: 'month', label: 'per month' },
  { value: 'quarter', label: 'per quarter' },
  { value: 'year', label: 'per year' },
  { value: 'engagement', label: 'per engagement' },
]

export function AgencyKpisSection({ agencyId }: { agencyId: string }) {
  const [kpis, setKpis] = useState<KpiRow[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch(`/api/intel/agencies/${agencyId}/kpis`)
      if (!resp.ok) return
      const j = (await resp.json()) as { kpis: KpiRow[] }
      setKpis(j.kpis ?? [])
    } finally {
      setLoading(false)
    }
  }, [agencyId])
  useEffect(() => {
    void reload()
  }, [reload])

  const handleRetire = useCallback(
    async (id: string) => {
      await fetch(`/api/intel/agencies/${agencyId}/kpis/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endedAt: todayIso() }),
      })
      await reload()
    },
    [agencyId, reload],
  )

  return (
    <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg flex items-center gap-2">
          <Target className="h-4 w-4" /> Committed KPIs
        </h2>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--bh-line)] bg-white px-3 py-1 text-xs hover:bg-[var(--bh-sage-50)]"
        >
          <Plus className="h-3 w-3" /> {showForm ? 'Cancel' : 'Add commitment'}
        </button>
      </div>
      <p className="mt-1 text-xs text-[var(--bh-muted)]">
        What the agency promised. The TBH Report compares each commitment
        against what Bloom actually measured.
      </p>

      {showForm ? (
        <KpiForm
          agencyId={agencyId}
          onSaved={async () => {
            setShowForm(false)
            await reload()
          }}
        />
      ) : null}

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-[var(--bh-muted)]">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading…
        </div>
      ) : kpis.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--bh-muted)]">
          No KPI commitments recorded yet.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--bh-line)]/60">
          {kpis.map((k) => {
            const active = k.effectiveTo === null
            return (
              <li key={k.id} className="py-3 flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{k.metricName}</span>
                    <span className="text-sm text-[var(--bh-ink)]">
                      <span className="tabular-nums font-semibold">
                        {k.targetValue}
                      </span>{' '}
                      {k.targetUnit} ·{' '}
                      {KPI_WINDOWS.find((w) => w.value === k.targetWindow)?.label ??
                        k.targetWindow}
                    </span>
                    {!active ? (
                      <span className="rounded-full bg-[var(--bh-warm-50)] px-2 py-0.5 text-[10px] uppercase text-[var(--bh-muted)]">
                        retired
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-xs text-[var(--bh-muted)]">
                    {k.effectiveFrom} → {k.effectiveTo ?? 'present'}
                  </div>
                  {k.notes ? (
                    <p className="mt-1 text-xs text-[var(--bh-ink)]">{k.notes}</p>
                  ) : null}
                </div>
                {active ? (
                  <button
                    type="button"
                    onClick={() => void handleRetire(k.id)}
                    className="text-xs text-[var(--bh-muted)] hover:text-[var(--bh-ink)]"
                    title="Retire (preserves history)"
                  >
                    Retire
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function KpiForm({
  agencyId,
  onSaved,
}: {
  agencyId: string
  onSaved: () => Promise<void> | void
}) {
  const [metricName, setMetricName] = useState('')
  const [targetValue, setTargetValue] = useState('')
  const [targetUnit, setTargetUnit] = useState('count')
  const [targetWindow, setTargetWindow] = useState('month')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      const v = Number(targetValue.replace(/[$,]/g, ''))
      if (!metricName.trim() || !Number.isFinite(v)) return
      setSubmitting(true)
      try {
        await fetch(`/api/intel/agencies/${agencyId}/kpis`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            metricName,
            targetValue: v,
            targetUnit,
            targetWindow,
            notes: notes || null,
          }),
        })
        await onSaved()
      } finally {
        setSubmitting(false)
      }
    },
    [agencyId, metricName, targetValue, targetUnit, targetWindow, notes, onSaved],
  )
  return (
    <form
      onSubmit={submit}
      className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-[var(--bh-line)] bg-[var(--bh-sage-50)]/40 p-3 md:grid-cols-2"
    >
      <input
        type="text"
        placeholder="Metric (e.g. leads_per_month)"
        required
        value={metricName}
        onChange={(e) => setMetricName(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm md:col-span-2"
      />
      <input
        type="text"
        inputMode="decimal"
        placeholder="Target value"
        required
        value={targetValue}
        onChange={(e) => setTargetValue(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
      />
      <select
        value={targetUnit}
        onChange={(e) => setTargetUnit(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
      >
        {KPI_UNITS.map((u) => (
          <option key={u.value} value={u.value}>
            {u.label}
          </option>
        ))}
      </select>
      <select
        value={targetWindow}
        onChange={(e) => setTargetWindow(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm md:col-span-2"
      >
        {KPI_WINDOWS.map((w) => (
          <option key={w.value} value={w.value}>
            {w.label}
          </option>
        ))}
      </select>
      <input
        type="text"
        placeholder="Notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm md:col-span-2"
      />
      <button
        type="submit"
        disabled={submitting || !metricName.trim() || !targetValue}
        className="inline-flex items-center gap-2 rounded-md bg-[var(--bh-sage-700)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50 md:col-span-2"
      >
        {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        Save commitment
      </button>
    </form>
  )
}

// ===========================================================================
// Activity log section
// ===========================================================================

interface ActivityRow {
  id: string
  occurredAt: string
  kind: string
  summary: string
  body: string | null
}

const ACTIVITY_KINDS = [
  { value: 'note', label: 'Note' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'review', label: 'Review' },
  { value: 'decision', label: 'Decision' },
  { value: 'escalation', label: 'Escalation' },
  { value: 'contract_renewed', label: 'Contract renewed' },
  { value: 'channel_change', label: 'Channel change' },
  { value: 'kpi_set', label: 'KPI set' },
  { value: 'kpi_missed', label: 'KPI missed' },
  { value: 'report_received', label: 'Report received' },
]

export function AgencyActivitySection({ agencyId }: { agencyId: string }) {
  const [items, setItems] = useState<ActivityRow[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch(`/api/intel/agencies/${agencyId}/activity`)
      if (!resp.ok) return
      const j = (await resp.json()) as { activity: ActivityRow[] }
      setItems(j.activity ?? [])
    } finally {
      setLoading(false)
    }
  }, [agencyId])
  useEffect(() => {
    void reload()
  }, [reload])

  const handleDelete = useCallback(
    async (id: string) => {
      await fetch(`/api/intel/agencies/${agencyId}/activity/${id}`, {
        method: 'DELETE',
      })
      await reload()
    },
    [agencyId, reload],
  )

  return (
    <section className="rounded-2xl border border-[var(--bh-line)] bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-serif text-lg flex items-center gap-2">
          <History className="h-4 w-4" /> Activity log
        </h2>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--bh-line)] bg-white px-3 py-1 text-xs hover:bg-[var(--bh-sage-50)]"
        >
          <Plus className="h-3 w-3" /> {showForm ? 'Cancel' : 'Add entry'}
        </button>
      </div>

      {showForm ? (
        <ActivityForm
          agencyId={agencyId}
          onSaved={async () => {
            setShowForm(false)
            await reload()
          }}
        />
      ) : null}

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-[var(--bh-muted)]">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--bh-muted)]">
          Timeline empty. Log meetings, reviews, channel changes here so the
          decision history lives next to the data.
        </p>
      ) : (
        <ol className="mt-3 relative border-l border-[var(--bh-line)] pl-4">
          {items.map((it) => (
            <li key={it.id} className="mb-4 ml-1">
              <span className="absolute -left-1.5 mt-1.5 h-2 w-2 rounded-full bg-[var(--bh-sage-500)]" />
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-xs text-[var(--bh-muted)]">
                  {new Date(it.occurredAt).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })}{' '}
                  ·{' '}
                  {ACTIVITY_KINDS.find((k) => k.value === it.kind)?.label ??
                    it.kind}
                </div>
                <button
                  type="button"
                  onClick={() => void handleDelete(it.id)}
                  className="text-rose-600 hover:text-rose-800 text-xs"
                  title="Delete"
                >
                  ×
                </button>
              </div>
              <div className="mt-0.5 text-sm font-medium">{it.summary}</div>
              {it.body ? (
                <p className="mt-1 whitespace-pre-wrap text-xs text-[var(--bh-ink)]">
                  {it.body}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function ActivityForm({
  agencyId,
  onSaved,
}: {
  agencyId: string
  onSaved: () => Promise<void> | void
}) {
  const [kind, setKind] = useState('note')
  const [occurredAt, setOccurredAt] = useState(todayIso())
  const [summary, setSummary] = useState('')
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!summary.trim()) return
      setSubmitting(true)
      try {
        await fetch(`/api/intel/agencies/${agencyId}/activity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind,
            occurredAt: `${occurredAt}T12:00:00.000Z`,
            summary,
            body: body || null,
          }),
        })
        await onSaved()
      } finally {
        setSubmitting(false)
      }
    },
    [agencyId, kind, occurredAt, summary, body, onSaved],
  )
  return (
    <form
      onSubmit={submit}
      className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-[var(--bh-line)] bg-[var(--bh-sage-50)]/40 p-3 md:grid-cols-2"
    >
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
      >
        {ACTIVITY_KINDS.map((k) => (
          <option key={k.value} value={k.value}>
            {k.label}
          </option>
        ))}
      </select>
      <input
        type="date"
        value={occurredAt}
        onChange={(e) => setOccurredAt(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
      />
      <input
        type="text"
        placeholder="Summary"
        required
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm md:col-span-2"
      />
      <textarea
        rows={3}
        placeholder="Body (optional, supports newlines)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm md:col-span-2"
      />
      <button
        type="submit"
        disabled={submitting || !summary.trim()}
        className="inline-flex items-center gap-2 rounded-md bg-[var(--bh-sage-700)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50 md:col-span-2"
      >
        {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        Add entry
      </button>
    </form>
  )
}

// ===========================================================================
// Engagement extras (channel sub-budgets + reporting cadence + dashboard URL)
// ===========================================================================

const REPORTING_CADENCE_OPTIONS = [
  { value: '', label: '— pick a cadence —' },
  { value: 'weekly_email', label: 'Weekly email' },
  { value: 'biweekly_call', label: 'Biweekly call' },
  { value: 'monthly_dashboard', label: 'Monthly dashboard' },
  { value: 'monthly_call', label: 'Monthly call' },
  { value: 'quarterly_review', label: 'Quarterly review' },
  { value: 'on_demand', label: 'On-demand' },
  { value: 'other', label: 'Other' },
]

export interface EngagementExtrasFormProps {
  agencyId: string
  engagementId: string
  startedAt: string
  endedAt: string | null
  monthlyFeeCents: number
  managedChannels: string[]
  scopeDescription: string | null
  channelSubBudgets: Record<string, number>
  reportingCadence: string | null
  dashboardUrl: string | null
  channelLabels: Map<string, string>
  onSaved: () => Promise<void> | void
}

export function EngagementExtrasForm(props: EngagementExtrasFormProps) {
  const [subBudgets, setSubBudgets] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const c of props.managedChannels) {
      init[c] =
        props.channelSubBudgets[c] !== undefined
          ? String(props.channelSubBudgets[c] / 100)
          : ''
    }
    return init
  })
  const [reportingCadence, setReportingCadence] = useState(
    props.reportingCadence ?? '',
  )
  const [dashboardUrl, setDashboardUrl] = useState(props.dashboardUrl ?? '')
  const [submitting, setSubmitting] = useState(false)

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setSubmitting(true)
      try {
        const cents: Record<string, number> = {}
        for (const [k, v] of Object.entries(subBudgets)) {
          const n = Number(v.replace(/[$,]/g, ''))
          if (Number.isFinite(n) && n > 0) cents[k] = Math.round(n * 100)
        }
        await fetch(`/api/intel/agencies/${props.agencyId}/engagements`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startedAt: props.startedAt,
            endedAt: props.endedAt,
            monthlyFeeCents: props.monthlyFeeCents,
            managedChannels: props.managedChannels,
            scopeDescription: props.scopeDescription,
            channelSubBudgets: cents,
            reportingCadence: reportingCadence || null,
            dashboardUrl: dashboardUrl || null,
          }),
        })
        await props.onSaved()
      } finally {
        setSubmitting(false)
      }
    },
    [props, subBudgets, reportingCadence, dashboardUrl],
  )

  const subtotal = Object.values(subBudgets).reduce((sum, v) => {
    const n = Number(v.replace(/[$,]/g, ''))
    return sum + (Number.isFinite(n) && n > 0 ? n : 0)
  }, 0)
  const monthlyTotal = props.monthlyFeeCents / 100
  const allocationDelta = subtotal - monthlyTotal

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-lg border border-[var(--bh-line)] bg-white p-4"
    >
      <h3 className="font-serif text-base flex items-center gap-2">
        <Briefcase className="h-4 w-4" /> Engagement extras
      </h3>

      <div>
        <span className="mb-2 block text-xs uppercase tracking-wide text-[var(--bh-muted)]">
          Channel sub-budgets (monthly USD)
        </span>
        {props.managedChannels.length === 0 ? (
          <p className="text-xs text-[var(--bh-muted)]">
            Add managed channels first.
          </p>
        ) : (
          <div className="space-y-2">
            {props.managedChannels.map((c) => (
              <label key={c} className="flex items-center gap-2 text-sm">
                <span className="w-32 truncate text-[var(--bh-muted)]">
                  {props.channelLabels.get(c) ?? c}
                </span>
                <span className="text-[var(--bh-muted)]">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={subBudgets[c] ?? ''}
                  onChange={(e) =>
                    setSubBudgets((prev) => ({ ...prev, [c]: e.target.value }))
                  }
                  placeholder="0"
                  className="w-32 rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
                />
              </label>
            ))}
            <div className="text-xs text-[var(--bh-muted)]">
              Sum: ${subtotal.toFixed(0)} of ${monthlyTotal.toFixed(0)} monthly fee
              {allocationDelta !== 0 ? (
                <span
                  className={`ml-2 ${allocationDelta > 0 ? 'text-rose-700' : 'text-amber-700'}`}
                >
                  ({allocationDelta > 0 ? '+' : ''}
                  ${allocationDelta.toFixed(0)} delta)
                </span>
              ) : (
                <span className="ml-2 text-emerald-700">(balanced)</span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-[var(--bh-muted)]">
            Reporting cadence
          </span>
          <select
            value={reportingCadence}
            onChange={(e) => setReportingCadence(e.target.value)}
            className="w-full rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
          >
            {REPORTING_CADENCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs uppercase tracking-wide text-[var(--bh-muted)]">
            Their dashboard URL
          </span>
          <input
            type="url"
            value={dashboardUrl}
            onChange={(e) => setDashboardUrl(e.target.value)}
            placeholder="https://hawthorn.example.com/clients/rixey"
            className="w-full rounded-md border border-[var(--bh-line)] bg-white px-2 py-1 text-sm"
          />
        </label>
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="inline-flex items-center gap-2 rounded-md bg-[var(--bh-sage-700)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        Save extras
      </button>
    </form>
  )
}

// Re-export Edit2 + Check so the page can reuse them without a fresh import.
export { Edit2, Check, Calendar }
