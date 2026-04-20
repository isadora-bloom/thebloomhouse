'use client'

/**
 * Settings → Sage Identity
 *
 * Per-venue customisation of Sage's first-touch identity:
 *   - Name (ai_name) — Sage by default, venue can rename
 *   - Role (ai_role) — dropdown of "AI <noun>" labels (DB CHECK enforces)
 *   - Purposes (ai_purposes + ai_custom_purpose) — multi-select 1-4 + free text
 *   - Opener shape (ai_opener_shape) — structural variation
 *
 * What this page CANNOT do:
 *   - Hide that Sage is AI. Every role option contains "AI" by design.
 *   - Turn off the disclosure footer. That's a non-negotiable send-boundary
 *     enforcement in src/lib/services/ai-disclosure.ts.
 *   - Bypass the "if asked, must confirm AI" universal rule.
 */

import { useState, useEffect, useMemo } from 'react'
import { createBrowserClient } from '@supabase/ssr'
import { useScope } from '@/lib/hooks/use-scope'
import { Save, Sparkles, Check } from 'lucide-react'
import {
  SAGE_ROLE_OPTIONS,
  SAGE_PURPOSE_OPTIONS,
  SAGE_OPENER_SHAPES,
  SAGE_DEFAULTS,
  resolveSageIdentity,
  renderIntroPreview,
} from '@/lib/services/sage-identity'
import type { SageRole, SageOpenerShape } from '@/lib/supabase/types'

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface SageIdentityForm {
  ai_name: string
  ai_role: SageRole
  ai_purposes: string[]
  ai_custom_purpose: string
  ai_opener_shape: SageOpenerShape
}

const EMPTY_FORM: SageIdentityForm = {
  ai_name: SAGE_DEFAULTS.ai_name,
  ai_role: SAGE_DEFAULTS.ai_role,
  ai_purposes: SAGE_DEFAULTS.ai_purposes,
  ai_custom_purpose: '',
  ai_opener_shape: SAGE_DEFAULTS.ai_opener_shape,
}

export default function SageIdentityPage() {
  const { venueId } = useScope()
  const [venueName, setVenueName] = useState<string>('the venue')
  const [form, setForm] = useState<SageIdentityForm>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load
  useEffect(() => {
    if (!venueId) return
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const [{ data: cfg, error: cfgErr }, { data: venue }] = await Promise.all([
          supabase
            .from('venue_ai_config')
            .select('ai_name, ai_role, ai_purposes, ai_custom_purpose, ai_opener_shape')
            .eq('venue_id', venueId)
            .maybeSingle(),
          supabase.from('venues').select('name').eq('id', venueId).maybeSingle(),
        ])

        if (cfgErr) throw cfgErr

        setVenueName(venue?.name ?? 'the venue')
        setForm({
          ai_name: cfg?.ai_name ?? SAGE_DEFAULTS.ai_name,
          ai_role: (cfg?.ai_role ?? SAGE_DEFAULTS.ai_role) as SageRole,
          ai_purposes: cfg?.ai_purposes?.length ? cfg.ai_purposes : SAGE_DEFAULTS.ai_purposes,
          ai_custom_purpose: cfg?.ai_custom_purpose ?? '',
          ai_opener_shape: (cfg?.ai_opener_shape ?? SAGE_DEFAULTS.ai_opener_shape) as SageOpenerShape,
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        setLoading(false)
      }
    })()
  }, [venueId])

  // Live preview — what the first-touch opener will look like.
  const preview = useMemo(() => {
    const id = resolveSageIdentity({
      ai_name: form.ai_name,
      ai_role: form.ai_role,
      ai_purposes: form.ai_purposes,
      ai_custom_purpose: form.ai_custom_purpose || null,
      ai_opener_shape: form.ai_opener_shape,
      venue_name: venueName,
    })
    return renderIntroPreview(id, 'Jenna')
  }, [form, venueName])

  function togglePurpose(p: string) {
    setForm((f) => {
      const has = f.ai_purposes.includes(p)
      if (has) {
        if (f.ai_purposes.length === 1) return f // require at least 1
        return { ...f, ai_purposes: f.ai_purposes.filter((x) => x !== p) }
      }
      if (f.ai_purposes.length >= 4) return f // cap at 4
      return { ...f, ai_purposes: [...f.ai_purposes, p] }
    })
  }

  async function handleSave() {
    if (!venueId) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const { error: upErr } = await supabase
        .from('venue_ai_config')
        .update({
          ai_name: form.ai_name.trim() || SAGE_DEFAULTS.ai_name,
          ai_role: form.ai_role,
          ai_purposes: form.ai_purposes,
          ai_custom_purpose: form.ai_custom_purpose.trim() || null,
          ai_opener_shape: form.ai_opener_shape,
        })
        .eq('venue_id', venueId)
      if (upErr) throw upErr
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="text-sm text-sage-500 p-6">Loading Sage identity…</div>
    )
  }

  return (
    <div className="max-w-3xl space-y-8">
      <header className="flex items-center gap-3">
        <Sparkles className="w-6 h-6 text-sage-600" />
        <div>
          <h1 className="text-2xl font-serif text-sage-900">Sage Identity</h1>
          <p className="text-sm text-sage-600 mt-1">
            How Sage introduces herself to couples. These settings shape tone and
            structure — they do not (and cannot) change the requirement that Sage
            discloses she is AI.
          </p>
        </div>
      </header>

      {/* Name */}
      <section className="space-y-2">
        <label className="block text-sm font-medium text-sage-800">Name</label>
        <input
          type="text"
          value={form.ai_name}
          onChange={(e) => setForm({ ...form, ai_name: e.target.value })}
          placeholder={SAGE_DEFAULTS.ai_name}
          className="w-full max-w-xs border border-border rounded-lg px-3 py-2.5 bg-warm-white text-sage-900 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300"
        />
        <p className="text-xs text-sage-500">What couples will call your assistant. Defaults to {SAGE_DEFAULTS.ai_name}.</p>
      </section>

      {/* Role */}
      <section className="space-y-2">
        <label className="block text-sm font-medium text-sage-800">Role label</label>
        <p className="text-xs text-sage-500 -mt-1 mb-2">
          Every option contains the word "AI". This is a legal disclosure
          requirement (EU AI Act, CA SB 1001). We don't offer options without it.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {SAGE_ROLE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setForm({ ...form, ai_role: opt.value })}
              className={`text-left border rounded-lg px-3 py-2.5 transition-colors ${
                form.ai_role === opt.value
                  ? 'border-sage-500 bg-sage-50'
                  : 'border-border bg-warm-white hover:border-sage-300'
              }`}
            >
              <div className="text-sm font-medium text-sage-900 flex items-center gap-1.5">
                {form.ai_role === opt.value && <Check className="w-3.5 h-3.5 text-sage-600" />}
                {opt.label}
              </div>
              <div className="text-xs text-sage-500 mt-0.5">{opt.blurb}</div>
            </button>
          ))}
        </div>
      </section>

      {/* Purposes */}
      <section className="space-y-2">
        <label className="block text-sm font-medium text-sage-800">
          What Sage is here for
        </label>
        <p className="text-xs text-sage-500 -mt-1 mb-2">
          Pick 1–4 to complete "I'm here to make sure you get ___". Current: {form.ai_purposes.length}/4.
        </p>
        <div className="flex flex-wrap gap-2">
          {SAGE_PURPOSE_OPTIONS.map((p) => {
            const active = form.ai_purposes.includes(p)
            return (
              <button
                key={p}
                type="button"
                onClick={() => togglePurpose(p)}
                className={`text-sm px-3 py-1.5 rounded-full border transition-colors ${
                  active
                    ? 'border-sage-500 bg-sage-100 text-sage-900'
                    : 'border-border bg-warm-white text-sage-700 hover:border-sage-300'
                }`}
              >
                {active ? '✓ ' : '+ '}{p}
              </button>
            )
          })}
        </div>

        <div className="mt-3">
          <label className="block text-xs font-medium text-sage-700 mb-1">
            Or add one of your own (optional)
          </label>
          <input
            type="text"
            value={form.ai_custom_purpose}
            onChange={(e) => setForm({ ...form, ai_custom_purpose: e.target.value })}
            placeholder="e.g. photos of the venue whenever you want them"
            className="w-full border border-border rounded-lg px-3 py-2 bg-warm-white text-sage-900 text-sm focus:outline-none focus:ring-2 focus:ring-sage-300"
          />
        </div>
      </section>

      {/* Opener shape */}
      <section className="space-y-2">
        <label className="block text-sm font-medium text-sage-800">Opener shape</label>
        <p className="text-xs text-sage-500 -mt-1 mb-2">
          The structural pattern of Sage's first message. Same shape, different
          words every time — no two couples get an identical opener.
        </p>
        <div className="space-y-2">
          {SAGE_OPENER_SHAPES.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setForm({ ...form, ai_opener_shape: s.value })}
              className={`w-full text-left border rounded-lg px-3 py-2.5 transition-colors ${
                form.ai_opener_shape === s.value
                  ? 'border-sage-500 bg-sage-50'
                  : 'border-border bg-warm-white hover:border-sage-300'
              }`}
            >
              <div className="text-sm font-medium text-sage-900 flex items-center gap-1.5">
                {form.ai_opener_shape === s.value && <Check className="w-3.5 h-3.5 text-sage-600" />}
                {s.label}
              </div>
              <div className="text-xs text-sage-500 mt-0.5">{s.description}</div>
              <div className="text-xs text-sage-400 italic mt-1">{s.example}</div>
            </button>
          ))}
        </div>
      </section>

      {/* Live preview */}
      <section className="space-y-2">
        <label className="block text-sm font-medium text-sage-800">Preview</label>
        <div className="border border-border rounded-lg bg-warm-white px-4 py-3 text-sm text-sage-900 leading-relaxed">
          {preview}
        </div>
        <p className="text-xs text-sage-500">
          This is an example — the actual opener is generated fresh per couple,
          using these settings as constraints rather than a template.
        </p>
      </section>

      {/* Save */}
      <div className="flex items-center gap-3 pt-2">
        <button
          type="button"
          disabled={saving}
          onClick={handleSave}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-sage-600 text-white rounded-lg text-sm font-medium hover:bg-sage-700 disabled:opacity-50 transition-colors"
        >
          <Save className="w-4 h-4" />
          {saving ? 'Saving…' : 'Save identity'}
        </button>
        {saved && <span className="text-sm text-sage-600">Saved.</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  )
}
