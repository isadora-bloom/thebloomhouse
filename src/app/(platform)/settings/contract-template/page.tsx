'use client'

/**
 * The words that go on every contract this venue sends.
 *
 * One template, edited here, stored on the venue's own settings blob
 * (`venue_config.feature_flags.contract_template`) the same way the bar,
 * rehearsal and decor pages store theirs. A venue that never opens this
 * page sends the default, which is a complete contract in plain language,
 * not a placeholder.
 *
 * Plain text, not markup. A venue is typing terms, not authoring a web
 * page, and letting HTML through would put an injection surface into an
 * email and a public page for nothing in return. Everything typed here is
 * escaped before it is rendered anywhere.
 *
 * The {{tokens}} are the only clever part, and they are listed on the page
 * rather than in documentation nobody reads. A token with nothing behind
 * it prints "to be confirmed"; a token that does not exist is left on the
 * page exactly as typed, so a typo shows up in the preview rather than
 * quietly deleting a clause.
 */

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import {
  FileSignature,
  Save,
  Loader2,
  CheckCircle,
  Plus,
  Trash2,
  RotateCcw,
} from 'lucide-react'
import {
  CONTRACT_TOKENS,
  DEFAULT_CONTRACT_TEMPLATE,
  parseContractTemplate,
  // The settings key is spelled once, in templates.ts, so this page
  // cannot save to a key the contract builder does not read.
  TEMPLATE_FLAG_KEY as FLAG_KEY,
  type ContractTemplate,
} from '@/lib/services/contracts/templates'

export default function ContractTemplateSettingsPage() {
  const venueId = useVenueId()
  const [template, setTemplate] = useState<ContractTemplate>(DEFAULT_CONTRACT_TEMPLATE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const supabase = createClient()
      const { data, error: fetchErr } = await supabase
        .from('venue_config')
        .select('feature_flags')
        .eq('venue_id', venueId)
        .maybeSingle()

      if (fetchErr) throw fetchErr

      const flags = (data?.feature_flags ?? {}) as Record<string, unknown>
      setTemplate(parseContractTemplate(flags[FLAG_KEY]))
      setError(null)
    } catch (err) {
      console.error('Failed to load the contract template:', err)
      setError('Could not load your template. The default is shown below.')
    } finally {
      setLoading(false)
    }
  }, [venueId])

  useEffect(() => {
    void load()
  }, [load])

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const supabase = createClient()
      const { data: current } = await supabase
        .from('venue_config')
        .select('feature_flags')
        .eq('venue_id', venueId)
        .maybeSingle()

      const flags = (current?.feature_flags ?? {}) as Record<string, unknown>
      flags[FLAG_KEY] = {
        key: template.key,
        title: template.title,
        intro: template.intro,
        clauses: template.clauses,
        closing: template.closing,
        signaturePrompt: template.signaturePrompt,
      }

      const { error: updateErr } = await supabase
        .from('venue_config')
        .update({ feature_flags: flags, updated_at: new Date().toISOString() })
        .eq('venue_id', venueId)

      if (updateErr) throw updateErr
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      console.error('Failed to save the contract template:', err)
      setError('That did not save. Try again in a moment.')
    } finally {
      setSaving(false)
    }
  }

  function updateClause(index: number, field: 'heading' | 'body', value: string) {
    setTemplate((t) => ({
      ...t,
      clauses: t.clauses.map((c, i) => (i === index ? { ...c, [field]: value } : c)),
    }))
  }

  if (loading) {
    return (
      <div className="p-8">
        <div className="h-40 rounded-xl bg-sage-50 animate-pulse" />
      </div>
    )
  }

  return (
    <div className="p-8 max-w-3xl space-y-6">
      <header>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-sage-100 flex items-center justify-center">
            <FileSignature className="w-5 h-5 text-sage-600" />
          </div>
          <h1 className="font-heading text-2xl font-semibold text-sage-900">
            Contract template
          </h1>
        </div>
        <p className="mt-2 text-sm text-sage-600">
          These are the words on every contract you send. The figures come from each
          couple&apos;s own booking, so you never type a price here.
        </p>
      </header>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          {error}
        </p>
      )}

      <section className="bg-surface border border-border rounded-xl p-6 space-y-4">
        <div>
          <label htmlFor="title" className="block text-sm font-medium text-sage-800 mb-1">
            Title
          </label>
          <input
            id="title"
            value={template.title}
            onChange={(e) => setTemplate((t) => ({ ...t, title: e.target.value }))}
            className="w-full px-3 py-2 border border-border rounded-lg text-sm"
          />
        </div>
        <div>
          <label htmlFor="intro" className="block text-sm font-medium text-sage-800 mb-1">
            Opening paragraph
          </label>
          <textarea
            id="intro"
            rows={4}
            value={template.intro}
            onChange={(e) => setTemplate((t) => ({ ...t, intro: e.target.value }))}
            className="w-full px-3 py-2 border border-border rounded-lg text-sm font-mono"
          />
        </div>
      </section>

      <section className="bg-surface border border-border rounded-xl p-6 space-y-5">
        <div className="flex items-center justify-between">
          <h2 className="font-heading text-lg font-semibold text-sage-900">Clauses</h2>
          <button
            type="button"
            onClick={() =>
              setTemplate((t) => ({
                ...t,
                clauses: [...t.clauses, { heading: '', body: '' }],
              }))
            }
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-sage-800 hover:bg-sage-50"
          >
            <Plus className="w-3.5 h-3.5" />
            Add a clause
          </button>
        </div>

        {template.clauses.map((clause, i) => (
          <div key={i} className="border border-border rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-xs font-semibold text-sage-500 shrink-0">
                {i + 1}.
              </span>
              <input
                value={clause.heading}
                onChange={(e) => updateClause(i, 'heading', e.target.value)}
                placeholder="Heading"
                className="flex-1 px-3 py-2 border border-border rounded-lg text-sm font-medium"
              />
              <button
                type="button"
                onClick={() =>
                  setTemplate((t) => ({
                    ...t,
                    clauses: t.clauses.filter((_, j) => j !== i),
                  }))
                }
                className="p-1.5 text-sage-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                aria-label={`Remove clause ${i + 1}`}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <textarea
              rows={4}
              value={clause.body}
              onChange={(e) => updateClause(i, 'body', e.target.value)}
              placeholder="What this clause says, in plain words."
              className="w-full px-3 py-2 border border-border rounded-lg text-sm font-mono"
            />
          </div>
        ))}
      </section>

      <section className="bg-surface border border-border rounded-xl p-6 space-y-4">
        <div>
          <label htmlFor="closing" className="block text-sm font-medium text-sage-800 mb-1">
            Closing line
          </label>
          <textarea
            id="closing"
            rows={2}
            value={template.closing}
            onChange={(e) => setTemplate((t) => ({ ...t, closing: e.target.value }))}
            className="w-full px-3 py-2 border border-border rounded-lg text-sm font-mono"
          />
        </div>
        <div>
          <label htmlFor="prompt" className="block text-sm font-medium text-sage-800 mb-1">
            What the couple reads above the name box
          </label>
          <input
            id="prompt"
            value={template.signaturePrompt}
            onChange={(e) =>
              setTemplate((t) => ({ ...t, signaturePrompt: e.target.value }))
            }
            className="w-full px-3 py-2 border border-border rounded-lg text-sm"
          />
        </div>
      </section>

      <section className="bg-sage-50 border border-sage-200 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-sage-900 mb-2">
          Things you can drop into any box above
        </h2>
        <p className="text-xs text-sage-600 mb-3">
          Each one is replaced with that couple&apos;s own figure. Anything you have
          not recorded for them prints as &ldquo;to be confirmed&rdquo; rather than as a
          zero.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {CONTRACT_TOKENS.filter((t) => t !== 'coordinator_phone_suffix').map((token) => (
            <code
              key={token}
              className="px-2 py-1 rounded bg-white border border-sage-200 text-[11px] text-sage-700"
            >
              {`{{${token}}}`}
            </code>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sage-700 text-white text-sm font-semibold hover:bg-sage-800 disabled:opacity-40"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : saved ? (
            <CheckCircle className="w-4 h-4" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {saved ? 'Saved' : 'Save template'}
        </button>
        <button
          type="button"
          onClick={() => setTemplate(DEFAULT_CONTRACT_TEMPLATE)}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-border text-sm font-medium text-sage-700 hover:bg-sage-50"
        >
          <RotateCcw className="w-4 h-4" />
          Back to the standard wording
        </button>
      </div>
      <p className="text-xs text-sage-500">
        Changing this does not change a contract you have already sent. Those keep the
        wording they were sent with.
      </p>
    </div>
  )
}
