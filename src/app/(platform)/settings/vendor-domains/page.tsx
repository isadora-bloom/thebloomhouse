'use client'

/**
 * Settings → Vendor domains
 *
 * Per-venue vendor-domain allow-list (migration 258). Sister of the
 * global ADVERTISER_DOMAINS but venue-scoped: Rixey's florist isn't
 * Wedgewood's florist.
 *
 * After the "Auto-classify Other" sweep on /agent/inbox runs, Haiku
 * confidently labels real vendors (Gibson Rental, Signature Event
 * Rentals, Parts Town, etc.). Without this allow-list, every NEW
 * email from those domains the next day falls back through the
 * rule-based decider into 'other' and the coordinator pays Haiku
 * again. Promoting the domain here means the decider catches it
 * cheaply on every subsequent email — same path as the advertiser
 * pass.
 *
 * Coordinator workflow:
 *   - Auto-promotions appear automatically after each "Auto-classify
 *     Other" sweep (confidence ≥ 80 → ai_classifier source).
 *   - Coordinator can manually add a domain (e.g. add gibsonrental.com
 *     before the AI ever sees it).
 *   - Coordinator can remove an entry that's wrong.
 *   - One-shot "Backfill from history" sweeps existing
 *     'vendor'-labelled inbox rows and promotes any domain seen ≥ 2x.
 */

import { useEffect, useState } from 'react'
import { Trash2, Plus, Sparkles, Bot, Hand, Archive, RefreshCcw } from 'lucide-react'

type Source = 'ai_classifier' | 'manual' | 'backfill'

interface VendorDomainRow {
  id: string
  domain: string
  source: Source
  confidence: number
  note: string | null
  added_at: string
  updated_at: string
  added_by: string | null
}

const SOURCE_LABELS: Record<Source, { label: string; Icon: typeof Bot; color: string }> = {
  ai_classifier: { label: 'Auto-promoted', Icon: Bot, color: 'text-sage-700 bg-sage-50 border-sage-200' },
  manual: { label: 'Manual', Icon: Hand, color: 'text-gold-700 bg-gold-50 border-gold-200' },
  backfill: { label: 'Backfilled', Icon: Archive, color: 'text-teal-700 bg-teal-50 border-teal-200' },
}

export default function VendorDomainsPage() {
  const [rows, setRows] = useState<VendorDomainRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const [domain, setDomain] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [seeding, setSeeding] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/agent/vendor-domains', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setRows((json.domains ?? []) as VendorDomainRow[])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!domain.trim()) return
    setSaving(true)
    setError(null)
    setInfo(null)
    try {
      const res = await fetch('/api/agent/vendor-domains', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: domain.trim(),
          note: note.trim() || null,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setDomain('')
      setNote('')
      setInfo(json.upserted ? `Confirmed ${json.domain.domain}` : `Added ${json.domain.domain}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string, label: string) {
    if (!confirm(`Remove ${label} from the vendor allow-list?`)) return
    setError(null)
    try {
      const res = await fetch(`/api/agent/vendor-domains?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove')
    }
  }

  async function handleBackfill() {
    if (!confirm('Scan inbox history for repeating vendor-labelled domains and auto-promote any seen 2+ times?')) return
    setSeeding(true)
    setError(null)
    setInfo(null)
    try {
      const res = await fetch('/api/admin/identity/seed-vendor-domains', { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setInfo(
        `Scanned ${json.scanned} rows across ${json.distinct_domains} domains. ` +
        `Promoted ${json.promoted_count} new entries (floor: ${json.floor}+ occurrences).`,
      )
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backfill failed')
    } finally {
      setSeeding(false)
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      <header>
        <h1 className="text-2xl font-serif text-sage-900 flex items-center gap-3">
          <Sparkles className="w-6 h-6 text-sage-700" />
          Vendor domains
        </h1>
        <p className="text-sage-600 mt-2 text-sm max-w-2xl">
          Domains that always classify as <em>vendor</em> for this venue. Auto-promoted
          after each Auto-classify Other sweep when Haiku is confident (≥ 80). Skipping
          re-classification on these domains saves thousands of cheap classifier calls
          per year. Manual adds work too.
        </p>
      </header>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}
      {info && (
        <div className="bg-sage-50 border border-sage-200 rounded-lg px-4 py-3 text-sm text-sage-800">
          {info}
        </div>
      )}

      <section className="bg-white border border-sage-200 rounded-lg p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-medium text-sage-900">Add a domain</h2>
            <p className="text-sage-600 text-xs mt-1">
              Enter the bare domain (e.g. <code className="bg-sage-50 px-1 rounded">gibsonrental.com</code>).
              Subdomains match automatically.
            </p>
          </div>
          <button
            onClick={handleBackfill}
            disabled={seeding}
            className="flex items-center gap-2 px-3 py-2 text-sage-700 border border-sage-300 text-sm rounded-lg hover:bg-sage-50 disabled:opacity-50 whitespace-nowrap"
            title="Scan existing 'vendor'-labelled inbox rows and promote domains seen 2+ times"
          >
            <RefreshCcw className={`w-4 h-4 ${seeding ? 'animate-spin' : ''}`} />
            {seeding ? 'Scanning...' : 'Backfill from history'}
          </button>
        </div>

        <form onSubmit={handleAdd} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3">
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="gibsonrental.com"
            className="border border-sage-300 rounded-md px-3 py-2 text-sm bg-warm-white"
            autoComplete="off"
            required
          />
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note (e.g. 'tent + table rentals')"
            className="border border-sage-300 rounded-md px-3 py-2 text-sm bg-warm-white"
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={saving || !domain.trim()}
            className="flex items-center justify-center gap-2 px-4 py-2 bg-sage-500 text-white text-sm rounded-md hover:bg-sage-600 disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            Add
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-base font-medium text-sage-900 mb-3">
          Allow-list <span className="text-sm text-sage-500">({rows.length})</span>
        </h2>
        {loading ? (
          <div className="text-sm text-sage-500">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-sage-500 italic border border-dashed border-sage-200 rounded-lg p-6 text-center">
            No vendor domains yet. Run Auto-classify Other on the inbox or add one manually above.
          </div>
        ) : (
          <ul className="divide-y divide-sage-100 bg-white border border-sage-200 rounded-lg">
            {rows.map((row) => {
              const meta = SOURCE_LABELS[row.source] ?? SOURCE_LABELS.manual
              const Icon = meta.Icon
              return (
                <li key={row.id} className="p-4 flex items-center gap-4 text-sm">
                  <div className="flex-1 min-w-0">
                    <div className="text-sage-900 font-mono truncate">{row.domain}</div>
                    {row.note && (
                      <div className="text-sage-500 text-xs truncate mt-0.5">{row.note}</div>
                    )}
                  </div>
                  <span className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border ${meta.color}`}>
                    <Icon className="w-3 h-3" />
                    {meta.label}
                  </span>
                  <span className="text-xs text-sage-500 whitespace-nowrap" title={`Confidence: ${row.confidence}`}>
                    {row.confidence}%
                  </span>
                  <span className="text-xs text-sage-500 whitespace-nowrap">
                    {new Date(row.added_at).toLocaleDateString()}
                  </span>
                  <button
                    onClick={() => handleDelete(row.id, row.domain)}
                    className="p-1.5 text-sage-500 hover:text-rose-600 hover:bg-rose-50 rounded-md transition-colors"
                    title="Remove from allow-list"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
