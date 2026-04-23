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
import { Save, Sparkles, Check, Link as LinkIcon, Plus, Trash2, Star } from 'lucide-react'
import {
  SAGE_ROLE_OPTIONS,
  SAGE_PURPOSE_OPTIONS,
  SAGE_OPENER_SHAPES,
  SAGE_DEFAULTS,
  resolveSageIdentity,
  renderIntroPreview,
  renderOpenerExample,
} from '@/lib/services/sage-identity'
import type { SageRole, SageOpenerShape } from '@/lib/supabase/types'

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface TourLink {
  label: string
  url: string
  is_default: boolean
}

interface SageIdentityForm {
  ai_name: string
  ai_role: SageRole
  ai_purposes: string[]
  ai_custom_purpose: string
  ai_opener_shape: SageOpenerShape
  tour_booking_links: TourLink[]
}

const EMPTY_FORM: SageIdentityForm = {
  ai_name: SAGE_DEFAULTS.ai_name,
  ai_role: SAGE_DEFAULTS.ai_role,
  ai_purposes: SAGE_DEFAULTS.ai_purposes,
  ai_custom_purpose: '',
  ai_opener_shape: SAGE_DEFAULTS.ai_opener_shape,
  tour_booking_links: [],
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
            .select('ai_name, ai_role, ai_purposes, ai_custom_purpose, ai_opener_shape, tour_booking_links')
            .eq('venue_id', venueId)
            .maybeSingle(),
          supabase.from('venues').select('name').eq('id', venueId).maybeSingle(),
        ])

        if (cfgErr) throw cfgErr

        setVenueName(venue?.name ?? 'the venue')
        const rawLinks = (cfg as { tour_booking_links?: unknown } | null)?.tour_booking_links
        const parsedLinks: TourLink[] = Array.isArray(rawLinks)
          ? rawLinks
              .filter((l): l is { label?: unknown; url?: unknown; is_default?: unknown } =>
                l !== null && typeof l === 'object'
              )
              .map((l) => ({
                label: typeof l.label === 'string' ? l.label : '',
                url: typeof l.url === 'string' ? l.url : '',
                is_default: l.is_default === true,
              }))
          : []
        setForm({
          ai_name: cfg?.ai_name ?? SAGE_DEFAULTS.ai_name,
          ai_role: (cfg?.ai_role ?? SAGE_DEFAULTS.ai_role) as SageRole,
          ai_purposes: cfg?.ai_purposes?.length ? cfg.ai_purposes : SAGE_DEFAULTS.ai_purposes,
          ai_custom_purpose: cfg?.ai_custom_purpose ?? '',
          ai_opener_shape: (cfg?.ai_opener_shape ?? SAGE_DEFAULTS.ai_opener_shape) as SageOpenerShape,
          tour_booking_links: parsedLinks,
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
      // Normalise the tour-link array before save: drop entries with no
      // URL, trim whitespace, and enforce the "exactly one default"
      // invariant. If the admin left no default selected, the first
      // entry becomes the default automatically.
      const cleanLinks = form.tour_booking_links
        .map((l) => ({
          label: l.label.trim() || 'Book a tour',
          url: l.url.trim(),
          is_default: l.is_default,
        }))
        .filter((l) => l.url.length > 0)
      if (cleanLinks.length > 0 && !cleanLinks.some((l) => l.is_default)) {
        cleanLinks[0].is_default = true
      } else if (cleanLinks.filter((l) => l.is_default).length > 1) {
        // More than one default — keep the first, unset the rest.
        let seen = false
        for (const l of cleanLinks) {
          if (l.is_default) {
            if (seen) l.is_default = false
            else seen = true
          }
        }
      }

      const { error: upErr } = await supabase
        .from('venue_ai_config')
        .update({
          ai_name: form.ai_name.trim() || SAGE_DEFAULTS.ai_name,
          ai_role: form.ai_role,
          ai_purposes: form.ai_purposes,
          ai_custom_purpose: form.ai_custom_purpose.trim() || null,
          ai_opener_shape: form.ai_opener_shape,
          tour_booking_links: cleanLinks,
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
              <div className="text-xs text-sage-400 italic mt-1">
                {renderOpenerExample(s.example, { aiName: form.ai_name, venueName })}
              </div>
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

      {/* Tour booking links — per-venue Calendly (or equivalent) URLs.
          The default link is what {form.ai_name} uses when a couple says
          "book a tour" without asking about a specific tour type. Add
          additional rows for weekday vs. weekend, or private tour vs.
          group tour — {form.ai_name} will mention them when the couple's
          intent is specific. */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <LinkIcon className="w-4 h-4 text-sage-600" />
          <label className="block text-sm font-medium text-sage-800">
            Tour booking links
          </label>
        </div>
        <p className="text-xs text-sage-500">
          Paste the Calendly (or equivalent) URL couples use to book a tour with
          you. Add more than one if you have different tour types — mark the
          one Sage should offer by default.
        </p>
        {form.tour_booking_links.length === 0 && (
          <p className="text-xs text-sage-500 italic py-2">
            No tour links yet. Couples will be asked to email for a tour until
            you add one.
          </p>
        )}
        <div className="space-y-2">
          {form.tour_booking_links.map((link, idx) => (
            <div
              key={idx}
              className="flex flex-col sm:flex-row gap-2 bg-warm-white border border-border rounded-lg px-3 py-2.5"
            >
              <input
                type="text"
                value={link.label}
                onChange={(e) => {
                  const v = e.target.value
                  setForm((f) => ({
                    ...f,
                    tour_booking_links: f.tour_booking_links.map((l, i) =>
                      i === idx ? { ...l, label: v } : l
                    ),
                  }))
                }}
                placeholder="Label (e.g. Weekday tours)"
                className="flex-1 min-w-0 px-2 py-1.5 border border-sage-200 rounded text-sm"
              />
              <input
                type="url"
                value={link.url}
                onChange={(e) => {
                  const v = e.target.value
                  setForm((f) => ({
                    ...f,
                    tour_booking_links: f.tour_booking_links.map((l, i) =>
                      i === idx ? { ...l, url: v } : l
                    ),
                  }))
                }}
                placeholder="https://calendly.com/venue/..."
                className="flex-[2] min-w-0 px-2 py-1.5 border border-sage-200 rounded text-sm font-mono"
              />
              <button
                type="button"
                onClick={() => {
                  setForm((f) => ({
                    ...f,
                    tour_booking_links: f.tour_booking_links.map((l, i) => ({
                      ...l,
                      is_default: i === idx,
                    })),
                  }))
                }}
                className={`flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                  link.is_default
                    ? 'bg-amber-100 text-amber-800 border border-amber-300'
                    : 'text-sage-600 hover:bg-sage-100 border border-transparent'
                }`}
                title={link.is_default ? 'Default — Sage uses this link for generic tour requests' : 'Set as default'}
              >
                <Star className={`w-3 h-3 ${link.is_default ? 'fill-current' : ''}`} />
                {link.is_default ? 'Default' : 'Make default'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setForm((f) => ({
                    ...f,
                    tour_booking_links: f.tour_booking_links.filter((_, i) => i !== idx),
                  }))
                }}
                className="flex items-center gap-1 px-2 py-1.5 text-rose-600 hover:bg-rose-50 rounded text-xs"
                title="Remove this link"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            setForm((f) => ({
              ...f,
              tour_booking_links: [
                ...f.tour_booking_links,
                {
                  label: '',
                  url: '',
                  is_default: f.tour_booking_links.length === 0,
                },
              ],
            }))
          }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-sage-700 border border-sage-200 rounded-lg hover:bg-sage-50"
        >
          <Plus className="w-3.5 h-3.5" />
          Add a tour link
        </button>
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
