'use client'

/**
 * /intel/agencies/[id]/edit — Edit an agency profile.
 *
 * Engagement edits happen on the detail page (inline form). This page
 * only edits the agency-level identity fields (name, contact, services,
 * default retainer, notes).
 */

import { useCallback, useEffect, useState, use as usePromise } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, AlertCircle, ArrowLeft } from 'lucide-react'

const SERVICE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'seo', label: 'SEO' },
  { value: 'paid_search', label: 'Paid search' },
  { value: 'paid_social', label: 'Paid social' },
  { value: 'content', label: 'Content / blog' },
  { value: 'web_design', label: 'Web design' },
  { value: 'email', label: 'Email nurture' },
  { value: 'pinterest', label: 'Pinterest' },
  { value: 'reputation', label: 'Reputation / listings' },
]

export default function EditAgencyPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: agencyId } = usePromise(params)
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [website, setWebsite] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [monthlyRetainerStr, setMonthlyRetainerStr] = useState('')
  const [performanceFeePctStr, setPerformanceFeePctStr] = useState('')
  const [services, setServices] = useState<Set<string>>(new Set())
  const [notes, setNotes] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch(`/api/intel/agencies/${agencyId}`)
        if (!resp.ok) return
        const j = (await resp.json()) as {
          agency: {
            name: string
            website: string | null
            contactName: string | null
            contactEmail: string | null
            contactPhone: string | null
            defaultMonthlyRetainerCents: number | null
            performanceFeePct: number | null
            services: string[]
            notes: string | null
          }
        }
        if (cancelled || !j.agency) return
        setName(j.agency.name)
        setWebsite(j.agency.website ?? '')
        setContactName(j.agency.contactName ?? '')
        setContactEmail(j.agency.contactEmail ?? '')
        setContactPhone(j.agency.contactPhone ?? '')
        setMonthlyRetainerStr(
          j.agency.defaultMonthlyRetainerCents !== null
            ? String(j.agency.defaultMonthlyRetainerCents / 100)
            : '',
        )
        setPerformanceFeePctStr(
          j.agency.performanceFeePct !== null
            ? String(j.agency.performanceFeePct)
            : '',
        )
        setServices(new Set(j.agency.services ?? []))
        setNotes(j.agency.notes ?? '')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agencyId])

  const toggleService = useCallback((v: string) => {
    setServices((prev) => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })
  }, [])

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setError(null)
      if (!name.trim()) {
        setError('Name is required.')
        return
      }
      setSubmitting(true)
      try {
        const retainer = Number(monthlyRetainerStr.replace(/[$,]/g, ''))
        const pct = Number(performanceFeePctStr)
        const resp = await fetch(`/api/intel/agencies/${agencyId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            website: website.trim() || null,
            contactName: contactName.trim() || null,
            contactEmail: contactEmail.trim() || null,
            contactPhone: contactPhone.trim() || null,
            defaultMonthlyRetainerCents:
              Number.isFinite(retainer) && retainer > 0
                ? Math.round(retainer * 100)
                : null,
            performanceFeePct: Number.isFinite(pct) && pct > 0 ? pct : null,
            services: [...services],
            notes: notes.trim() || null,
          }),
        })
        if (!resp.ok) {
          const j = (await resp.json().catch(() => null)) as
            | { error?: string }
            | null
          setError(j?.error ?? 'Save failed.')
          return
        }
        router.push(`/intel/agencies/${agencyId}`)
      } finally {
        setSubmitting(false)
      }
    },
    [
      agencyId,
      name,
      website,
      contactName,
      contactEmail,
      contactPhone,
      monthlyRetainerStr,
      performanceFeePctStr,
      services,
      notes,
      router,
    ],
  )

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-[var(--bh-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <Link
          href={`/intel/agencies/${agencyId}`}
          className="inline-flex items-center gap-1 text-sm text-[var(--bh-muted)] hover:text-[var(--bh-ink)]"
        >
          <ArrowLeft className="h-3 w-3" /> Back to agency
        </Link>
        <h1 className="mt-2 font-serif text-2xl text-[var(--bh-ink)]">
          Edit agency
        </h1>
      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-5 rounded-2xl border border-[var(--bh-line)] bg-white p-6 shadow-sm"
      >
        <Field label="Agency name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
          />
        </Field>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Website">
            <input
              type="url"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              className="w-full rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Contact name">
            <input
              type="text"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              className="w-full rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Contact email">
            <input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              className="w-full rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Contact phone">
            <input
              type="tel"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              className="w-full rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Default monthly retainer (USD)">
            <input
              type="text"
              inputMode="decimal"
              value={monthlyRetainerStr}
              onChange={(e) => setMonthlyRetainerStr(e.target.value)}
              className="w-full rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Performance fee (%)">
            <input
              type="text"
              inputMode="decimal"
              value={performanceFeePctStr}
              onChange={(e) => setPerformanceFeePctStr(e.target.value)}
              className="w-full rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
            />
          </Field>
        </div>

        <Field label="Services they provide">
          <div className="flex flex-wrap gap-2">
            {SERVICE_OPTIONS.map((s) => {
              const on = services.has(s.value)
              return (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => toggleService(s.value)}
                  className={`rounded-full border px-3 py-1 text-xs transition ${
                    on
                      ? 'border-[var(--bh-sage-700)] bg-[var(--bh-sage-700)] text-white'
                      : 'border-[var(--bh-line)] bg-white text-[var(--bh-ink)] hover:border-[var(--bh-sage-500)]'
                  }`}
                >
                  {s.label}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="Notes">
          <textarea
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
          />
        </Field>

        {error ? (
          <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-md bg-[var(--bh-sage-700)] px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Save changes
          </button>
          <Link
            href={`/intel/agencies/${agencyId}`}
            className="text-sm text-[var(--bh-muted)] hover:text-[var(--bh-ink)]"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-wide text-[var(--bh-muted)]">
        {label}
        {required ? <span className="ml-0.5 text-rose-600">*</span> : null}
      </span>
      {children}
    </label>
  )
}
