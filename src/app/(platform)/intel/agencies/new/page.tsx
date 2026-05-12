'use client'

/**
 * /intel/agencies/new — Create a marketing agency.
 */

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
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

export default function NewAgencyPage() {
  const router = useRouter()

  const [name, setName] = useState('')
  const [scope, setScope] = useState<'venue' | 'org'>('venue')
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

        const resp = await fetch('/api/intel/agencies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            scope,
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
        const j = (await resp.json()) as {
          agency?: { id: string }
          error?: string
        }
        if (!resp.ok || !j.agency) {
          setError(j.error ?? 'Failed to create agency.')
          return
        }
        router.push(`/intel/agencies/${j.agency.id}`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Network error.')
      } finally {
        setSubmitting(false)
      }
    },
    [
      name,
      scope,
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

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <Link
          href="/intel/agencies"
          className="inline-flex items-center gap-1 text-sm text-[var(--bh-muted)] hover:text-[var(--bh-ink)]"
        >
          <ArrowLeft className="h-3 w-3" /> Back to agencies
        </Link>
        <h1 className="mt-2 font-serif text-2xl text-[var(--bh-ink)]">
          New marketing agency
        </h1>
        <p className="mt-1 text-sm text-[var(--bh-muted)]">
          Record an agency you work with. After creating it, add an
          engagement on the agency&apos;s page to tie monthly spend +
          managed channels to it.
        </p>
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
            placeholder="Hawthorn Creative"
            className="w-full rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Scope">
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scope"
                value="venue"
                checked={scope === 'venue'}
                onChange={() => setScope('venue')}
              />
              This venue only
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scope"
                value="org"
                checked={scope === 'org'}
                onChange={() => setScope('org')}
              />
              Whole organisation (shared across venues)
            </label>
          </div>
        </Field>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Website">
            <input
              type="url"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://hawthorncreative.com"
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
              placeholder="2000"
              className="w-full rounded-md border border-[var(--bh-line)] bg-white px-3 py-2 text-sm"
            />
          </Field>
          <Field label="Performance fee (%)">
            <input
              type="text"
              inputMode="decimal"
              value={performanceFeePctStr}
              onChange={(e) => setPerformanceFeePctStr(e.target.value)}
              placeholder="0"
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
            placeholder="Contract terms, account rep, history with this agency, anything worth remembering."
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
            Create agency
          </button>
          <Link
            href="/intel/agencies"
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
