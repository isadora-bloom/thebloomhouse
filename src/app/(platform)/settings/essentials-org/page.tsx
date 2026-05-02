'use client'

/**
 * Settings → Org Essentials defaults (T5-followup-Z / yc LOW 19).
 *
 * Lets a coordinator-or-above set the default Essentials slider level
 * for everyone in their org. Inheritance chain (lowest to highest
 * priority):
 *   platform default ('recommended')
 *   per-(user, org) default        ← this page
 *   per-(user, venue) default      ← settings/personality (today, via the hook)
 *   per-(user, venue, surface)     ← Essentials slider on each surface
 *
 * Closes the multi-venue org pain point: coordinators with three
 * venues had to set the slider per-venue per-surface even when their
 * preference was the same across the whole org.
 *
 * Until role-management lands the API gates writes to coordinator-or-
 * above; we don't surface a "you can't write" branch here because the
 * platform-auth role list already excludes everyone below coordinator.
 */

import { useEffect, useState, useCallback } from 'react'
import { Save, RotateCcw, Layers, Loader2, AlertCircle, Check } from 'lucide-react'
import { ESSENTIALS_LEVELS, type EssentialsLevel } from '@/lib/hooks/use-essentials-level'

const LEVEL_DESCRIPTIONS: Record<EssentialsLevel, string> = {
  essentials: 'Just the must-knows. The tightest, fastest reading mode.',
  recommended: 'A balanced default — the platform pick.',
  expanded: 'Everything Essentials shows plus context and explanations.',
  everything: 'Show every signal we have. Best for deep coordinator review sessions.',
}

interface OrgPrefs {
  org_id: string | null
  default_level: EssentialsLevel | null
  updated_by: string | null
  updated_at: string | null
}

export default function EssentialsOrgSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [orgPrefs, setOrgPrefs] = useState<OrgPrefs | null>(null)
  const [selected, setSelected] = useState<EssentialsLevel>('recommended')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/essentials-preferences/org')
      const body = (await res.json()) as OrgPrefs | { error: string }
      if (!res.ok) {
        const msg = (body as { error?: string }).error ?? `HTTP ${res.status}`
        setError(msg)
        return
      }
      const prefs = body as OrgPrefs
      setOrgPrefs(prefs)
      if (prefs.default_level) setSelected(prefs.default_level)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch('/api/settings/essentials-preferences/org', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_level: selected }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setSuccess('Org default saved. New coordinators will inherit it on first sign-in.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save_failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleClear() {
    if (!window.confirm('Clear the org default? Future coordinators will fall back to the platform default ("recommended").')) {
      return
    }
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const res = await fetch('/api/settings/essentials-preferences/org', { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setSuccess('Org default cleared.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'clear_failed')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="p-8 max-w-2xl">
        <div className="flex items-center gap-2 text-sage-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading org preferences…
        </div>
      </div>
    )
  }

  if (!orgPrefs?.org_id) {
    return (
      <div className="p-8 max-w-2xl space-y-3">
        <h1 className="font-heading text-2xl font-semibold text-sage-900">Org Essentials defaults</h1>
        <p className="text-sm text-sage-600">
          You don&apos;t belong to a multi-venue organisation, so there&apos;s
          nothing to set here. Per-venue defaults live on each
          coordinator&apos;s personality page.
        </p>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-2xl space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <Layers className="w-5 h-5 text-sage-600" />
          <h1 className="font-heading text-2xl font-semibold text-sage-900">Org Essentials defaults</h1>
        </div>
        <p className="text-sm text-sage-600">
          Set the default Essentials slider level for everyone in your org.
          Coordinators can still override per-venue and per-surface from the
          slider on each work surface — this is the value they inherit when
          they haven&apos;t set their own.
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 flex items-start gap-2">
          <Check className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{success}</span>
        </div>
      )}

      <div className="rounded-lg border border-sage-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-sage-900">Current org default</p>
            <p className="text-xs text-sage-500 mt-0.5">
              {orgPrefs.default_level
                ? `Set to "${orgPrefs.default_level}" — every coordinator without a personal default inherits this.`
                : 'No org default set. Coordinators inherit the platform default ("recommended").'}
            </p>
          </div>
          {orgPrefs.default_level && (
            <button
              type="button"
              onClick={handleClear}
              disabled={saving}
              className="inline-flex items-center gap-1.5 text-xs text-sage-600 hover:text-sage-800 border border-sage-200 rounded px-2 py-1.5 hover:bg-sage-50 disabled:opacity-50"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Clear
            </button>
          )}
        </div>

        <div className="space-y-2 pt-2 border-t border-sage-100">
          <p className="text-xs font-medium text-sage-700 uppercase tracking-wider mt-3">
            Set new default
          </p>
          {ESSENTIALS_LEVELS.map((lvl) => (
            <label
              key={lvl}
              className={`flex items-start gap-3 rounded-md border px-3 py-2 cursor-pointer ${
                selected === lvl
                  ? 'border-sage-400 bg-sage-50'
                  : 'border-sage-100 hover:border-sage-200'
              }`}
            >
              <input
                type="radio"
                name="essentials-level"
                value={lvl}
                checked={selected === lvl}
                onChange={() => setSelected(lvl)}
                className="mt-1 accent-sage-600"
              />
              <div>
                <p className="text-sm font-medium text-sage-900 capitalize">{lvl}</p>
                <p className="text-xs text-sage-500 mt-0.5">{LEVEL_DESCRIPTIONS[lvl]}</p>
              </div>
            </label>
          ))}
        </div>

        <div className="pt-2 border-t border-sage-100 flex items-center justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || selected === orgPrefs.default_level}
            className="inline-flex items-center gap-2 rounded bg-sage-700 hover:bg-sage-800 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Save org default'}
          </button>
        </div>
      </div>
    </div>
  )
}
