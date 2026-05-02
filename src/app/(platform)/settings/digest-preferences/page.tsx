'use client'

/**
 * /settings/digest-preferences (T4-H).
 *
 * Per-coordinator digest configuration. Coordinator picks cadence,
 * day-of-week, send time, which categories to include, which channels.
 * Self-knowledge is opt-in only per ANTI-19.9-5.
 */

import { useState, useEffect } from 'react'
import { Loader2, Save, Mail, Bell } from 'lucide-react'

interface Prefs {
  cadence: 'off' | 'daily' | 'weekly' | 'biweekly'
  send_time_local: string
  send_dow: number
  include_lead_conversion: boolean
  include_pricing: boolean
  include_source_attribution: boolean
  include_anomalies: boolean
  include_macro_correlations: boolean
  include_self_knowledge: boolean
  channel_email: boolean
  channel_in_app: boolean
}

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function DigestPreferencesPage() {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<Date | null>(null)

  useEffect(() => {
    fetch('/api/settings/digest-preferences')
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error)
        else setPrefs(d as Prefs)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  function patch<K extends keyof Prefs>(key: K, value: Prefs[K]) {
    if (!prefs) return
    setPrefs({ ...prefs, [key]: value })
  }

  async function save() {
    if (!prefs) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/digest-preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      const updated = (await res.json()) as Prefs
      setPrefs(updated)
      setSavedAt(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm text-sage-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading preferences…
      </div>
    )
  }

  if (!prefs) {
    return (
      <div className="p-6">
        <p className="text-sm text-amber-700">{error ?? 'Could not load preferences.'}</p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-semibold text-sage-900">Digest preferences</h1>
        <p className="text-sm text-sage-600 mt-1">
          When and what arrives in your digest. Each coordinator manages their own.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">{error}</div>
      )}

      {/* Cadence */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-sage-500">Cadence</h2>
        <div className="flex gap-2 flex-wrap">
          {(['off', 'daily', 'weekly', 'biweekly'] as const).map((c) => (
            <button
              key={c}
              onClick={() => patch('cadence', c)}
              className={`px-3 py-2 text-sm rounded border transition-colors ${
                prefs.cadence === c
                  ? 'border-sage-700 bg-sage-100 text-sage-900'
                  : 'border-sage-200 bg-warm-white text-sage-600 hover:border-sage-300'
              }`}
            >
              {c.charAt(0).toUpperCase() + c.slice(1)}
            </button>
          ))}
        </div>
        {(prefs.cadence === 'weekly' || prefs.cadence === 'biweekly') && (
          <div className="flex gap-2 items-center">
            <span className="text-sm text-sage-600">on</span>
            {DOW_LABELS.map((dow, idx) => (
              <button
                key={idx}
                onClick={() => patch('send_dow', idx)}
                className={`px-2 py-1 text-xs rounded border ${
                  prefs.send_dow === idx
                    ? 'border-sage-700 bg-sage-100 text-sage-900'
                    : 'border-sage-200 bg-warm-white text-sage-500 hover:border-sage-300'
                }`}
              >
                {dow}
              </button>
            ))}
          </div>
        )}
        {prefs.cadence !== 'off' && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-sage-600">at</span>
            <input
              type="time"
              value={prefs.send_time_local.slice(0, 5)}
              onChange={(e) => patch('send_time_local', e.target.value + ':00')}
              className="px-2 py-1 text-sm border border-sage-200 rounded"
            />
            <span className="text-xs text-sage-500">venue-local time</span>
          </div>
        )}
      </section>

      {/* Categories */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-sage-500">Include categories</h2>
        <CategoryToggle label="Lead conversion (heat, decay, cohort, risk)"     value={prefs.include_lead_conversion}     onChange={(v) => patch('include_lead_conversion', v)} />
        <CategoryToggle label="Pricing (elasticity insights)"                   value={prefs.include_pricing}             onChange={(v) => patch('include_pricing', v)} />
        <CategoryToggle label="Source attribution (channel mix, counterfactual)" value={prefs.include_source_attribution}  onChange={(v) => patch('include_source_attribution', v)} />
        <CategoryToggle label="Anomalies + data integrity"                       value={prefs.include_anomalies}           onChange={(v) => patch('include_anomalies', v)} />
        <CategoryToggle label="Macro correlations (weather, trends, FRED)"       value={prefs.include_macro_correlations}  onChange={(v) => patch('include_macro_correlations', v)} />
        <CategoryToggle
          label="Self-knowledge (coordinator override patterns, strength areas)"
          value={prefs.include_self_knowledge}
          onChange={(v) => patch('include_self_knowledge', v)}
          subtle="Opt-in: surveillance-flavoured insights about your own behaviour."
        />
      </section>

      {/* Channels */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-sage-500">Channels</h2>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={prefs.channel_email}
            onChange={(e) => patch('channel_email', e.target.checked)}
            className="rounded border-sage-300"
          />
          <Mail className="w-4 h-4 text-sage-500" />
          Email
        </label>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={prefs.channel_in_app}
            onChange={(e) => patch('channel_in_app', e.target.checked)}
            className="rounded border-sage-300"
          />
          <Bell className="w-4 h-4 text-sage-500" />
          In-app pulse / dashboard
        </label>
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 rounded bg-sage-700 hover:bg-sage-800 text-white text-sm font-medium disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save
        </button>
        {savedAt && <span className="text-xs text-sage-500">Saved {savedAt.toLocaleTimeString()}</span>}
      </div>
    </div>
  )
}

function CategoryToggle({ label, value, onChange, subtle }: { label: string; value: boolean; onChange: (v: boolean) => void; subtle?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm cursor-pointer">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 rounded border-sage-300"
      />
      <div>
        <div>{label}</div>
        {subtle && <div className="text-xs text-sage-500 italic">{subtle}</div>}
      </div>
    </label>
  )
}
