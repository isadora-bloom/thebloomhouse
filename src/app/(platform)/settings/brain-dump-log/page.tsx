'use client'

/**
 * /settings/brain-dump-log — graduated pattern audit (T4-E).
 *
 * Lists active brain-dump pattern grants — standing rules the
 * coordinator authorised after 3+ confirmations of the same shape.
 * Each row shows description + intent + hit count + last used, with
 * a Revoke button that re-engages propose-and-confirm for future
 * matching entries.
 */

import { useState, useEffect, useCallback } from 'react'
import { Loader2, Trash2, Brain, Clock } from 'lucide-react'

interface Grant {
  id: string
  pattern_signature: string
  description: string
  intent: string
  routed_table: string | null
  routed_action: string | null
  granted_at: string
  hit_count: number
  last_used_at: string | null
  revoked_at: string | null
}

function formatDate(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function BrainDumpLogPage() {
  const [grants, setGrants] = useState<Grant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/brain-dump/grants')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { grants: Grant[] }
      setGrants(json.grants)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  async function revoke(id: string) {
    if (!confirm('Revoke this grant? Future matching brain-dumps will go back to propose-and-confirm.')) return
    setRevoking(id)
    try {
      const res = await fetch(`/api/brain-dump/grants?id=${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed')
    } finally {
      setRevoking(null)
    }
  }

  const active = grants.filter((g) => !g.revoked_at)
  const revoked = grants.filter((g) => g.revoked_at)

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-semibold text-sage-900 flex items-center gap-2">
          <Brain className="w-7 h-7" />
          Brain-dump rules
        </h1>
        <p className="text-sm text-sage-600 mt-2">
          Standing rules you confirmed after 3+ matching brain-dumps. Future brain-dumps with the same shape route automatically — no per-instance confirmation needed. Revoke a rule to re-engage propose-and-confirm.
        </p>
      </div>

      {loading && grants.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-sage-500 py-12 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{error}</div>
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-sage-500 mb-2">
          Active rules ({active.length})
        </h2>
        {active.length === 0 ? (
          <div className="rounded-lg border border-sage-200 bg-warm-white p-6 text-center text-sm text-sage-500">
            No active rules yet. After you confirm the same brain-dump shape 3 times, you&apos;ll be offered a rule prompt.
          </div>
        ) : (
          <ul className="space-y-2">
            {active.map((g) => (
              <li key={g.id} className="rounded-lg border border-sage-200 bg-warm-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-sage-900">{g.description}</div>
                    <div className="text-xs text-sage-500 mt-1 flex items-center gap-3 flex-wrap">
                      <span className="font-mono">intent: {g.intent}</span>
                      {g.routed_table && <span className="font-mono">→ {g.routed_table}{g.routed_action ? `:${g.routed_action}` : ''}</span>}
                      <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> granted {formatDate(g.granted_at)}</span>
                      <span>{g.hit_count} use{g.hit_count === 1 ? '' : 's'}{g.last_used_at ? `, last ${formatDate(g.last_used_at)}` : ''}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => revoke(g.id)}
                    disabled={revoking === g.id}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-sage-300 hover:border-red-300 hover:bg-red-50 hover:text-red-700 text-sage-600 disabled:opacity-50"
                  >
                    {revoking === g.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {revoked.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-sage-500 mb-2">
            Revoked ({revoked.length})
          </h2>
          <ul className="space-y-2">
            {revoked.map((g) => (
              <li key={g.id} className="rounded-lg border border-sage-200 bg-sage-50/30 p-4 opacity-70">
                <div className="text-sm text-sage-700 line-through">{g.description}</div>
                <div className="text-xs text-sage-500 mt-1">
                  Revoked {formatDate(g.revoked_at)} · {g.hit_count} use{g.hit_count === 1 ? '' : 's'} before revoke
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
