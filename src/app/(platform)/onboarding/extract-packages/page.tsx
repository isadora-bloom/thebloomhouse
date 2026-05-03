'use client'

/**
 * Canonical-packages extraction (T5-Rixey-HH).
 *
 * One-time onboarding step. Walks the venue's web-form schema +
 * submitted values to propose a packages catalog (package tiers,
 * upgrade add-ons, discounts). Coordinator confirms the proposed
 * rows; confirmed rows go into the public.packages table with
 * status='active', confidence_flag='live'.
 *
 * Pairs with /onboarding/web-form-import. The form CSV is the input;
 * the resulting catalog feeds the venue AI's pricing-context loader,
 * the temporal-trigger booking-value resolver, and future
 * pricing-history reconciliation.
 */

import { useState } from 'react'
import {
  Upload, AlertCircle, CheckCircle2, Loader2, Package, Sparkles, Trash2,
} from 'lucide-react'
import Link from 'next/link'
import { useAiName } from '@/lib/hooks/use-ai-name'

interface ProposedPackage {
  kind: 'package' | 'upgrade' | 'discount' | 'fee'
  name: string
  season?: string | null
  tier?: string | null
  guest_count_min?: number | null
  guest_count_max?: number | null
  price_cents?: number | null
  discount_percent?: number | null
  source_text: string
  source_column: string
  occurrences: number
}

const PROVIDERS: Array<{ provider: string; label: string }> = [
  { provider: 'rixey_calculator', label: 'Rixey Manor pricing calculator' },
  { provider: 'typeform', label: 'Typeform' },
  { provider: 'jotform', label: 'Jotform' },
  { provider: 'google_forms', label: 'Google Forms' },
  { provider: 'custom', label: 'Custom (provide hint overrides)' },
]

export default function ExtractPackagesPage() {
  const aiName = useAiName()
  const [provider, setProvider] = useState<string>('rixey_calculator')
  const [csv, setCsv] = useState('')
  const [proposals, setProposals] = useState<ProposedPackage[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [errors, setErrors] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [success, setSuccess] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function clearMessages() {
    setErrors([])
    setWarnings([])
    setSuccess(null)
  }

  async function runExtract() {
    clearMessages()
    if (!csv.trim()) { setErrors(['csv content is empty']); return }
    setBusy(true)
    try {
      const res = await fetch('/api/onboarding/extract-packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'extract', formProvider: provider, csv }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErrors([data.error ?? `HTTP ${res.status}`])
        setProposals([])
        return
      }
      const got = (data.proposals ?? []) as ProposedPackage[]
      setProposals(got)
      setSelected(new Set(got.map((_, i) => i)))  // pre-check all
      if (Array.isArray(data.warnings)) setWarnings(data.warnings)
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Network error'])
    } finally { setBusy(false) }
  }

  async function runConfirm() {
    clearMessages()
    const chosen = proposals.filter((_, i) => selected.has(i))
    if (chosen.length === 0) {
      setErrors(['select at least one proposal to confirm'])
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/onboarding/extract-packages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'confirm', proposals: chosen }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErrors([data.error ?? `HTTP ${res.status}`])
        return
      }
      setSuccess(`Confirmed ${data.inserted} packages. View them at the venue catalog.`)
      setProposals([])
      setSelected(new Set())
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Network error'])
    } finally { setBusy(false) }
  }

  function toggle(i: number) {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(i)) next.delete(i); else next.add(i)
      return next
    })
  }

  function selectByKind(kind: ProposedPackage['kind'], on: boolean) {
    setSelected((s) => {
      const next = new Set(s)
      proposals.forEach((p, i) => {
        if (p.kind === kind) {
          if (on) next.add(i); else next.delete(i)
        }
      })
      return next
    })
  }

  function removeProposal(i: number) {
    setProposals((p) => p.filter((_, idx) => idx !== i))
    setSelected((s) => {
      const next = new Set<number>()
      let outIdx = 0
      proposals.forEach((_, idx) => {
        if (idx === i) return
        if (s.has(idx)) next.add(outIdx)
        outIdx++
      })
      return next
    })
  }

  const grouped = {
    package: proposals.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'package'),
    upgrade: proposals.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'upgrade'),
    discount: proposals.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'discount'),
    fee: proposals.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'fee'),
  }

  return (
    <div className="p-8 max-w-5xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Package className="w-6 h-6 text-sage-700" />
          <h1 className="font-heading text-2xl font-semibold text-sage-900">Extract package catalog from form schema</h1>
        </div>
        <p className="text-sm text-sage-600 max-w-3xl">
          Many venues encode their pricing structure in the form they expose to couples
          (season tiers, upgrades, discounts). This tool walks your form data once and
          proposes a catalog you can confirm with one click. Confirmed packages feed
          {aiName}&apos;s pricing context, the temporal-trigger booking-value resolver, and
          future pricing-history reconciliation.
        </p>
        <p className="text-xs text-sage-500">
          Pairs with{' '}
          <Link href="/onboarding/web-form-import" className="underline">web-form import</Link>{' '}
          &mdash; same CSV, complementary one-time extraction.
        </p>
      </header>

      {proposals.length === 0 && (
        <section className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-medium text-sage-700">Form provider</label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-sage-200 rounded"
            >
              {PROVIDERS.map((p) => (
                <option key={p.provider} value={p.provider}>{p.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <label className="text-xs font-medium text-sage-700">CSV content</label>
            <textarea
              rows={8}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder="Paste the CSV export (with a header row)."
              className="w-full px-3 py-2 text-xs font-mono border border-sage-200 rounded"
            />
          </div>
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={runExtract}
              disabled={busy || !csv.trim()}
              className="inline-flex items-center gap-1.5 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-3 py-2"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              Extract proposals
            </button>
          </div>
        </section>
      )}

      {proposals.length > 0 && (
        <section className="bg-white border border-sage-200 rounded-xl p-5 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-sage-700">
              {proposals.length} proposal{proposals.length === 1 ? '' : 's'} extracted &middot;{' '}
              {selected.size} selected
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { setProposals([]); setSelected(new Set()); clearMessages() }}
                className="text-xs text-sage-700 underline"
              >
                Start over
              </button>
              <button
                type="button"
                onClick={runConfirm}
                disabled={busy || selected.size === 0}
                className="inline-flex items-center gap-1.5 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 text-white text-sm font-medium px-3 py-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                Confirm {selected.size}
              </button>
            </div>
          </div>

          {(['package', 'upgrade', 'discount', 'fee'] as const).map((kind) => {
            const rows = grouped[kind]
            if (rows.length === 0) return null
            return (
              <div key={kind} className="border border-sage-200 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold text-sage-900 uppercase tracking-wide">
                    {kind === 'package' && 'Wedding packages'}
                    {kind === 'upgrade' && 'Upgrades & add-ons'}
                    {kind === 'discount' && 'Discounts'}
                    {kind === 'fee' && 'Fees'}
                    {' '}({rows.length})
                  </h3>
                  <div className="flex items-center gap-2 text-[10px]">
                    <button onClick={() => selectByKind(kind, true)} className="text-sage-700 underline">
                      Select all
                    </button>
                    <button onClick={() => selectByKind(kind, false)} className="text-sage-700 underline">
                      None
                    </button>
                  </div>
                </div>
                <table className="w-full text-xs">
                  <thead className="text-left text-sage-600">
                    <tr>
                      <th className="font-medium pb-1 w-8"></th>
                      <th className="font-medium pb-1">Name</th>
                      <th className="font-medium pb-1">Season</th>
                      <th className="font-medium pb-1">Guest band</th>
                      <th className="font-medium pb-1 text-right">Price / %</th>
                      <th className="font-medium pb-1 text-right">Picks</th>
                      <th className="font-medium pb-1 text-right w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ p, i }) => (
                      <tr key={i} className="border-t border-sage-100">
                        <td className="py-1">
                          <input
                            type="checkbox"
                            checked={selected.has(i)}
                            onChange={() => toggle(i)}
                          />
                        </td>
                        <td className="py-1 pr-2">{p.name}</td>
                        <td className="py-1 pr-2">{p.season ?? '—'}</td>
                        <td className="py-1 pr-2">
                          {p.guest_count_min != null && p.guest_count_max != null
                            ? `${p.guest_count_min}-${p.guest_count_max}`
                            : '—'}
                        </td>
                        <td className="py-1 pr-2 text-right">
                          {p.kind === 'discount'
                            ? p.discount_percent != null ? `${p.discount_percent}%` : '—'
                            : p.price_cents != null
                              ? (p.price_cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
                              : '—'}
                        </td>
                        <td className="py-1 pr-2 text-right text-sage-500">{p.occurrences}</td>
                        <td className="py-1 text-right">
                          <button
                            type="button"
                            onClick={() => removeProposal(i)}
                            title="Remove this proposal"
                            className="text-sage-500 hover:text-amber-700"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })}
        </section>
      )}

      {errors.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 space-y-1">
          {errors.map((e, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{e}</span>
            </div>
          ))}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="bg-amber-50/50 border border-amber-200 rounded-lg p-3 text-xs text-amber-700 space-y-1">
          <p className="font-medium">Warnings:</p>
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {success && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-800 flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4" />
          {success}
        </div>
      )}
    </div>
  )
}
