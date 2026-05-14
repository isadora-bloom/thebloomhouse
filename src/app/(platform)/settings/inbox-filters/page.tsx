'use client'

/**
 * Settings → Inbox Filters
 *
 * Per-venue control over which senders Sage drops (before the classifier)
 * vs classifies-but-doesn't-reply-to. Pairs with the universal no-reply /
 * bounce filter baked into email-pipeline.ts.
 *
 * pattern_type:
 *   sender_exact  — one email address
 *   sender_domain — matches both exact and subdomains (foo.com + bar.foo.com)
 *   gmail_label   — Gmail label id (e.g. CATEGORY_PROMOTIONS)
 *
 * action:
 *   ignore   — never classified, never stored
 *   no_draft — classified + stored for intelligence, but Sage won't reply
 */

import { useState, useEffect } from 'react'
import { Trash2, Plus, Shield, PenLine, MailX, Info } from 'lucide-react'
import { useAiName } from '@/lib/hooks/use-ai-name'

interface Filter {
  id: string
  pattern_type: 'sender_exact' | 'sender_domain' | 'gmail_label'
  pattern: string
  action: 'ignore' | 'no_draft'
  source: 'manual' | 'learned'
  note: string | null
  created_at: string
}

interface AuditEntry {
  filter_id: string
  pattern: string
  pattern_type: Filter['pattern_type']
  action: Filter['action']
  auditable: boolean
  unauditable_reason: 'pre_storage' | 'label_not_stored' | null
  count_30d: number
  last_match_at: string | null
  sample_senders: string[]
}

const PATTERN_TYPE_LABELS: Record<Filter['pattern_type'], string> = {
  sender_exact: 'Exact sender',
  sender_domain: 'Sender domain',
  gmail_label: 'Gmail label',
}

export default function InboxFiltersPage() {
  const aiName = useAiName()
  const [filters, setFilters] = useState<Filter[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [patternType, setPatternType] = useState<Filter['pattern_type']>('sender_domain')
  const [pattern, setPattern] = useState('')
  const [action, setAction] = useState<Filter['action']>('ignore')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [filtersRes, auditRes] = await Promise.all([
        fetch('/api/agent/inbox-filters'),
        fetch('/api/agent/inbox-filters/audit'),
      ])
      if (!filtersRes.ok) throw new Error(`HTTP ${filtersRes.status}`)
      const filtersJson = await filtersRes.json()
      setFilters(filtersJson.filters ?? [])
      if (auditRes.ok) {
        const auditJson = await auditRes.json()
        setAudit(auditJson.audit ?? [])
      } else {
        setAudit([])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!pattern.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/agent/inbox-filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pattern_type: patternType,
          pattern: pattern.trim(),
          action,
          note: note.trim() || null,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }))
        throw new Error(err.error || 'Failed to add')
      }
      setPattern('')
      setNote('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(`Remove this filter? Emails matching it will start flowing back into ${aiName}.`)) return
    try {
      const res = await fetch(`/api/agent/inbox-filters?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete')
    }
  }

  const manual = filters.filter((f) => f.source === 'manual')
  const learned = filters.filter((f) => f.source === 'learned')

  return (
    <div className="max-w-4xl space-y-8">
      <header className="flex items-center gap-3">
        <Shield className="w-6 h-6 text-sage-600" />
        <div>
          <h1 className="text-2xl font-serif text-sage-900">Inbox Filters</h1>
          <p className="text-sm text-sage-600 mt-1">
            Control which senders {aiName} processes. &quot;Ignore&quot; drops mail before
            the classifier runs — no AI cost, no interaction stored.
            &quot;No draft&quot; still classifies and stores (so the intelligence layer
            learns from it), but {aiName} won&apos;t reply.
          </p>
        </div>
      </header>

      {/* Add form */}
      <section className="border border-border rounded-lg bg-warm-white p-4">
        <h2 className="text-sm font-medium text-sage-800 mb-3 flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add filter
        </h2>
        <form onSubmit={handleAdd} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-sage-700 mb-1">Type</label>
              <select
                value={patternType}
                onChange={(e) => setPatternType(e.target.value as Filter['pattern_type'])}
                className="w-full border border-border rounded-lg px-3 py-2 bg-warm-white text-sage-900 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300"
              >
                <option value="sender_domain">Sender domain</option>
                <option value="sender_exact">Exact sender</option>
                <option value="gmail_label">Gmail label</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-sage-700 mb-1">
                {patternType === 'sender_domain'
                  ? 'Domain (e.g. mailchimp.com)'
                  : patternType === 'sender_exact'
                    ? 'Email (e.g. notifications@calendly.com)'
                    : 'Gmail label (e.g. CATEGORY_PROMOTIONS)'}
              </label>
              <input
                type="text"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder={
                  patternType === 'sender_domain'
                    ? 'mailchimp.com'
                    : patternType === 'sender_exact'
                      ? 'notifications@calendly.com'
                      : 'CATEGORY_PROMOTIONS'
                }
                className="w-full border border-border rounded-lg px-3 py-2 bg-warm-white text-sage-900 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-sage-700 mb-1">Action</label>
              <select
                value={action}
                onChange={(e) => setAction(e.target.value as Filter['action'])}
                className="w-full border border-border rounded-lg px-3 py-2 bg-warm-white text-sage-900 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300"
              >
                <option value="ignore">Ignore (drop before classifier)</option>
                <option value="no_draft">No draft (keep, don't reply)</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-sage-700 mb-1">Note (optional)</label>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why this rule exists"
                className="w-full border border-border rounded-lg px-3 py-2 bg-warm-white text-sage-900 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={saving || !pattern.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 disabled:opacity-50 transition-colors"
          >
            <Plus className="w-4 h-4" />
            {saving ? 'Adding…' : 'Add filter'}
          </button>
          {error && <div className="text-sm text-red-600">{error}</div>}
        </form>
      </section>

      {loading ? (
        <div className="text-sm text-sage-500">Loading filters…</div>
      ) : (
        <>
          <FilterGroup
            title="Manual rules"
            subtitle="Added by you or the seed list. These take precedence."
            items={manual}
            audit={audit}
            onDelete={handleDelete}
          />
          <FilterGroup
            title="Learned rules"
            subtitle={`Auto-added by the nightly learner when a domain consistently produces no draft. Remove any you want ${aiName} to start replying to again.`}
            items={learned}
            audit={audit}
            onDelete={handleDelete}
            empty={`No learned rules yet. The nightly job will start promoting domains after ${aiName} has seen 5+ non-draft inbound emails from them.`}
          />
        </>
      )}
    </div>
  )
}

function FilterGroup({
  title,
  subtitle,
  items,
  audit,
  onDelete,
  empty,
}: {
  title: string
  subtitle: string
  items: Filter[]
  audit: AuditEntry[]
  onDelete: (id: string) => void
  empty?: string
}) {
  const auditById = new Map<string, AuditEntry>(audit.map((a) => [a.filter_id, a]))
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-medium text-sage-800">{title}</h2>
        <p className="text-xs text-sage-500">{subtitle}</p>
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-sage-500 border border-dashed border-border rounded-lg px-4 py-6 text-center">
          {empty ?? 'Nothing here yet.'}
        </div>
      ) : (
        <div className="border border-border rounded-lg bg-warm-white divide-y divide-border">
          {items.map((f) => {
            const a = auditById.get(f.id)
            return (
              <div key={f.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-sage-100 text-sage-700">
                      {PATTERN_TYPE_LABELS[f.pattern_type]}
                    </span>
                    <code className="text-sm font-mono text-sage-900 truncate">{f.pattern}</code>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${
                        f.action === 'ignore'
                          ? 'bg-red-50 text-red-700'
                          : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {f.action === 'ignore' ? <MailX className="w-3 h-3" /> : <PenLine className="w-3 h-3" />}
                      {f.action === 'ignore' ? 'Ignore' : 'No draft'}
                    </span>
                  </div>
                  {f.note && <p className="text-xs text-sage-500 mt-1">{f.note}</p>}
                  <FilterAuditLine audit={a} action={f.action} />
                </div>
                <button
                  type="button"
                  onClick={() => onDelete(f.id)}
                  className="p-1.5 text-sage-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                  title="Remove filter"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function FilterAuditLine({
  audit,
  action,
}: {
  audit: AuditEntry | undefined
  action: Filter['action']
}) {
  if (!audit) return null
  if (!audit.auditable) {
    const reason =
      audit.unauditable_reason === 'pre_storage'
        ? 'Pre-storage filter, no audit log available.'
        : 'Gmail-label filter, not tracked via interactions table.'
    return (
      <p className="text-xs text-sage-400 mt-1 flex items-center gap-1">
        <Info className="w-3 h-3" />
        {reason}
      </p>
    )
  }
  if (audit.count_30d === 0) {
    return (
      <p className="text-xs text-sage-400 mt-1">
        No matches in the last 30 days. Rule may be redundant.
      </p>
    )
  }
  const last = audit.last_match_at ? new Date(audit.last_match_at) : null
  const lastLabel = last ? relativeTime(last) : null
  const sampleLabel = audit.sample_senders.slice(0, 3).join(', ')
  return (
    <p className="text-xs text-sage-600 mt-1">
      Caught {audit.count_30d} {action === 'ignore' ? 'ignored' : 'no-draft'} email
      {audit.count_30d === 1 ? '' : 's'} in 30d
      {lastLabel ? ` · last ${lastLabel}` : ''}
      {sampleLabel ? ` · ${sampleLabel}` : ''}
      {audit.sample_senders.length > 3 ? ` +${audit.sample_senders.length - 3}` : ''}
    </p>
  )
}

function relativeTime(d: Date): string {
  const diffMs = Date.now() - d.getTime()
  const mins = Math.round(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}
