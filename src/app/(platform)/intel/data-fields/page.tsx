'use client'

/**
 * Data fields — the surface for un-homed imported data.
 *
 * Anchor: the silent-field-drop sweep. Imports preserve every column
 * in a raw jsonb, but un-mapped columns were invisible. This page
 * makes them visible: each un-homed column from imported data is
 * listed with an LLM-suggested label, type, and sample values, and a
 * "Track this field" action that promotes it into a tracked field.
 *
 * The LLM only RECOGNISES — it never writes. The operator confirms
 * (and may edit the label / type) before a tracked field is created.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Check,
  Database,
  Loader2,
  RefreshCw,
  Sparkles,
  Tag,
} from 'lucide-react'

interface TrackedField {
  id: string
  entity_type: string
  source_key: string
  label: string
  data_type: string
  llm_suggestion: string | null
  created_at: string
}

interface UnmappedField {
  entity_type: string
  source_key: string
  samples: string[]
  suggested_label: string
  suggested_type: string
  what_it_looks_like: string
}

const ENTITY_LABEL: Record<string, string> = {
  wedding: 'Couples / weddings (CRM import)',
  review: 'Reviews',
  marketing_spend: 'Marketing spend',
  knowledge_base: 'Knowledge base',
  wedding_details: 'Couple portal — wedding details',
  wedding_tables: 'Couple portal — table layout',
}

const TYPE_OPTIONS = ['text', 'number', 'money', 'date', 'boolean'] as const

export default function DataFieldsPage() {
  const [tracked, setTracked] = useState<TrackedField[]>([])
  const [unmapped, setUnmapped] = useState<UnmappedField[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Per-row editable label/type, keyed by entity::key.
  const [edits, setEdits] = useState<Record<string, { label: string; type: string }>>({})
  const [working, setWorking] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/data-fields')
      if (!res.ok) {
        setError(`HTTP ${res.status}`)
        return
      }
      const data = (await res.json()) as {
        tracked: TrackedField[]
        unmapped: UnmappedField[]
      }
      setTracked(data.tracked ?? [])
      setUnmapped(data.unmapped ?? [])
      // Seed the editable label/type from the LLM suggestion.
      const seed: Record<string, { label: string; type: string }> = {}
      for (const u of data.unmapped ?? []) {
        seed[`${u.entity_type}::${u.source_key}`] = {
          label: u.suggested_label,
          type: u.suggested_type,
        }
      }
      setEdits(seed)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const track = async (u: UnmappedField) => {
    const rowKey = `${u.entity_type}::${u.source_key}`
    const edit = edits[rowKey] ?? { label: u.suggested_label, type: u.suggested_type }
    setWorking(rowKey)
    try {
      const res = await fetch('/api/admin/data-fields', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entity_type: u.entity_type,
          source_key: u.source_key,
          label: edit.label,
          data_type: edit.type,
          llm_suggestion: u.what_it_looks_like,
        }),
      })
      if (res.ok) {
        // Move it from unmapped to tracked locally.
        setUnmapped((rows) =>
          rows.filter(
            (r) => !(r.entity_type === u.entity_type && r.source_key === u.source_key),
          ),
        )
        setTracked((rows) => [
          {
            id: rowKey,
            entity_type: u.entity_type,
            source_key: u.source_key,
            label: edit.label,
            data_type: edit.type,
            llm_suggestion: u.what_it_looks_like,
            created_at: new Date().toISOString(),
          },
          ...rows,
        ])
      } else {
        const d = (await res.json().catch(() => ({}))) as { error?: string }
        setError(d.error ?? `HTTP ${res.status}`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setWorking(null)
    }
  }

  const unmappedByEntity = useMemo(() => {
    const m = new Map<string, UnmappedField[]>()
    for (const u of unmapped) {
      const arr = m.get(u.entity_type) ?? []
      arr.push(u)
      m.set(u.entity_type, arr)
    }
    return m
  }, [unmapped])

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-stone-500" />
            <h1 className="font-serif text-3xl text-stone-900">Data fields</h1>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-stone-600">
            Columns that arrived in your imported data with no built-in home.
            Nothing here was lost — every value is preserved — but until you
            track a field, it stays out of sight. Bloom reads each one and
            suggests what it is; you confirm and give it a home.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm hover:bg-stone-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-6 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <AlertCircle className="mt-0.5 h-4 w-4" /> {error}
        </div>
      )}

      {loading && (
        <div className="rounded-lg border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-stone-400" />
        </div>
      )}

      {/* Unmapped — needs an operator decision */}
      {!loading && unmapped.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-stone-700">
            <Sparkles className="h-4 w-4 text-violet-500" />
            Untracked columns ({unmapped.length})
          </h2>
          {Array.from(unmappedByEntity.entries()).map(([entity, rows]) => (
            <div key={entity} className="mb-4">
              <div className="mb-1 text-xs uppercase tracking-wide text-stone-500">
                {ENTITY_LABEL[entity] ?? entity}
              </div>
              <div className="space-y-2">
                {rows.map((u) => {
                  const rowKey = `${u.entity_type}::${u.source_key}`
                  const edit =
                    edits[rowKey] ?? { label: u.suggested_label, type: u.suggested_type }
                  return (
                    <div
                      key={rowKey}
                      className="rounded-lg border border-stone-200 bg-white p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-xs text-stone-500">
                            {u.source_key}
                          </div>
                          <div className="mt-0.5 text-xs text-violet-700">
                            <Sparkles className="mr-1 inline h-3 w-3" />
                            {u.what_it_looks_like}
                          </div>
                          <div className="mt-1 line-clamp-1 text-xs text-stone-400">
                            e.g. {u.samples.slice(0, 4).join(' · ')}
                          </div>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          value={edit.label}
                          onChange={(e) =>
                            setEdits((s) => ({
                              ...s,
                              [rowKey]: { ...edit, label: e.target.value },
                            }))
                          }
                          className="rounded-md border border-stone-300 px-2 py-1 text-sm outline-none"
                          placeholder="Field label"
                        />
                        <select
                          value={edit.type}
                          onChange={(e) =>
                            setEdits((s) => ({
                              ...s,
                              [rowKey]: { ...edit, type: e.target.value },
                            }))
                          }
                          className="rounded-md border border-stone-300 px-2 py-1 text-sm outline-none"
                        >
                          {TYPE_OPTIONS.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => track(u)}
                          disabled={working === rowKey || !edit.label.trim()}
                          className="ml-auto flex items-center gap-1 rounded-md bg-stone-900 px-3 py-1 text-xs text-white hover:bg-stone-700 disabled:opacity-40"
                        >
                          {working === rowKey ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Tag className="h-3 w-3" />
                          )}
                          Track this field
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </section>
      )}

      {!loading && unmapped.length === 0 && (
        <div className="mb-8 rounded-lg border border-stone-200 bg-white p-6 text-center text-sm text-stone-500">
          No untracked columns. Every column in your imported data either has
          a built-in field or has been tracked below.
        </div>
      )}

      {/* Tracked */}
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-stone-700">
          <Check className="h-4 w-4 text-emerald-600" />
          Tracked fields ({tracked.length})
        </h2>
        {tracked.length === 0 ? (
          <div className="rounded-lg border border-stone-200 bg-white p-6 text-center text-sm text-stone-500">
            Nothing tracked yet. Track an untracked column above to give it a
            home.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-600">
                <tr>
                  <th className="px-4 py-2">Label</th>
                  <th className="px-4 py-2">Source column</th>
                  <th className="px-4 py-2">From</th>
                  <th className="px-4 py-2">Type</th>
                </tr>
              </thead>
              <tbody>
                {tracked.map((t) => (
                  <tr key={t.id} className="border-t border-stone-100">
                    <td className="px-4 py-2 font-medium text-stone-900">
                      {t.label}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-stone-500">
                      {t.source_key}
                    </td>
                    <td className="px-4 py-2 text-xs text-stone-600">
                      {ENTITY_LABEL[t.entity_type] ?? t.entity_type}
                    </td>
                    <td className="px-4 py-2 text-xs text-stone-600">
                      {t.data_type}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-6 text-xs text-stone-400">
        Tracked fields read their value straight from the preserved import
        row — the value is never copied or duplicated, so it can never drift.
      </p>
    </div>
  )
}
