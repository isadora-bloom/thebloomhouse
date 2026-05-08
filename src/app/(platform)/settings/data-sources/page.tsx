'use client'

/**
 * Data sources picker. C-INGEST-2 (Tier-C universal ingest).
 *
 * Coordinators tick which platforms they receive leads from. The
 * answer lives in venue_config.feature_flags.data_sources so the
 * brain-dump CSV/screenshot detector can bias toward the configured
 * sources when sniffing an ambiguous upload.
 *
 * Today this page reads + writes the flag list. The detection-bias
 * wiring (use the list to break ties between two equally-confident
 * detectors) is a follow-up — the storage half is the gating step.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { ArrowLeft, Loader2, Check, Database, Save } from 'lucide-react'

const SOURCES: Array<{ key: string; name: string; group: 'crm' | 'directory' | 'social' | 'other'; note?: string }> = [
  { key: 'honeybook', name: 'HoneyBook', group: 'crm' },
  { key: 'tripleseat', name: 'Tripleseat', group: 'crm' },
  { key: 'aisle_planner', name: 'Aisle Planner', group: 'crm' },
  { key: 'dubsado', name: 'Dubsado', group: 'crm' },
  { key: 'the_knot', name: 'The Knot', group: 'directory' },
  { key: 'wedding_wire', name: 'WeddingWire', group: 'directory' },
  { key: 'zola', name: 'Zola', group: 'directory' },
  { key: 'instagram', name: 'Instagram', group: 'social', note: 'Screenshots + 3rd-party scraper output' },
  { key: 'pinterest', name: 'Pinterest', group: 'social' },
  { key: 'facebook', name: 'Facebook', group: 'social' },
  { key: 'google_business', name: 'Google Business', group: 'directory' },
  { key: 'web_form', name: 'Direct web form', group: 'other', note: 'Inquiries via your own website' },
]

const GROUP_LABEL: Record<string, string> = {
  crm: 'Lead / project CRMs',
  directory: 'Wedding directories',
  social: 'Social platforms',
  other: 'Other',
}

export default function DataSourcesPage() {
  const venueId = useVenueId()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!venueId) return
    let cancelled = false
    ;(async () => {
      const supabase = createClient()
      const { data, error } = await supabase
        .from('venue_config')
        .select('feature_flags')
        .eq('venue_id', venueId)
        .maybeSingle()
      if (cancelled) return
      if (error) {
        setErr(error.message)
        setLoading(false)
        return
      }
      const ff = (data?.feature_flags ?? {}) as Record<string, unknown>
      const list = Array.isArray(ff.data_sources) ? (ff.data_sources as string[]) : []
      setSelected(new Set(list))
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [venueId])

  async function save() {
    if (!venueId) return
    setSaving(true)
    setErr(null)
    const supabase = createClient()
    // Read-merge-write to avoid clobbering other feature_flags entries.
    const { data: existing } = await supabase
      .from('venue_config')
      .select('feature_flags')
      .eq('venue_id', venueId)
      .maybeSingle()
    const ff = ((existing?.feature_flags ?? {}) as Record<string, unknown>)
    ff.data_sources = Array.from(selected).sort()
    const { error } = await supabase
      .from('venue_config')
      .update({ feature_flags: ff })
      .eq('venue_id', venueId)
    if (error) {
      setErr(error.message)
    } else {
      setSavedAt(new Date())
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="w-6 h-6 animate-spin text-sage-400" />
      </div>
    )
  }

  const groups = ['crm', 'directory', 'social', 'other'] as const

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/settings" className="p-2 rounded-lg hover:bg-sage-50 text-sage-500 hover:text-sage-800">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-serif text-sage-900 flex items-center gap-2">
            <Database className="w-6 h-6 text-teal-600" />
            Data sources
          </h1>
          <p className="text-sm text-sage-500 mt-0.5">
            Tell us which platforms you collect leads from. The brain dump uses this to recognise CSV exports and screenshot uploads from your stack faster.
          </p>
        </div>
      </div>

      {err && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-700">
          {err}
        </div>
      )}

      {groups.map((g) => {
        const items = SOURCES.filter((s) => s.group === g)
        return (
          <div key={g} className="bg-surface border border-border rounded-xl p-5 space-y-3">
            <h2 className="text-sm uppercase tracking-wider text-sage-500">{GROUP_LABEL[g]}</h2>
            <div className="space-y-1">
              {items.map((s) => {
                const checked = selected.has(s.key)
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => {
                      const next = new Set(selected)
                      if (checked) next.delete(s.key); else next.add(s.key)
                      setSelected(next)
                    }}
                    className={`flex items-center justify-between w-full px-3 py-2.5 rounded-lg text-sm transition-colors ${
                      checked ? 'bg-sage-50 text-sage-900' : 'hover:bg-sage-50/50 text-sage-700'
                    }`}
                  >
                    <span className="flex items-center gap-3">
                      <span className={`w-4 h-4 rounded border flex items-center justify-center ${
                        checked ? 'bg-sage-600 border-sage-600' : 'bg-warm-white border-border'
                      }`}>
                        {checked && <Check className="w-3 h-3 text-white" />}
                      </span>
                      <span>
                        {s.name}
                        {s.note && <span className="ml-2 text-xs text-sage-400">{s.note}</span>}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}

      <div className="flex items-center justify-between pt-2">
        <p className="text-xs text-sage-400">
          {savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : `${selected.size} of ${SOURCES.length} selected`}
        </p>
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-sage-600 text-white rounded-lg hover:bg-sage-700 disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
