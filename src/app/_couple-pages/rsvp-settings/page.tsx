'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import {
  Settings,
  Save,
  Plus,
  X,
  Trash2,
  CheckCircle2,
  Loader2,
  CalendarDays,
  ToggleLeft,
  ToggleRight,
  MessageSquare,
  ListChecks,
  GripVertical,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CustomQuestion {
  id: string
  label: string
  type: 'text' | 'select' | 'boolean'
  options?: string[]
}

interface RsvpConfig {
  ask_meal_choice: boolean
  ask_dietary: boolean
  ask_allergies: boolean
  ask_phone: boolean
  ask_email: boolean
  ask_address: boolean
  ask_hotel: boolean
  ask_shuttle: boolean
  ask_accessibility: boolean
  ask_song_request: boolean
  ask_message: boolean
  allow_maybe: boolean
  custom_questions: CustomQuestion[]
  rsvp_deadline: string | null
  attending_message: string
  declined_message: string
}

const DEFAULT_CONFIG: RsvpConfig = {
  ask_meal_choice: true,
  ask_dietary: true,
  ask_allergies: false,
  ask_phone: false,
  ask_email: false,
  ask_address: false,
  ask_hotel: false,
  ask_shuttle: false,
  ask_accessibility: false,
  ask_song_request: false,
  ask_message: false,
  allow_maybe: false,
  custom_questions: [],
  rsvp_deadline: null,
  attending_message: "Thank you for confirming! We can't wait to celebrate with you.",
  declined_message: "We'll miss you! Thank you for letting us know.",
}

// ---------------------------------------------------------------------------
// Field Toggle Component
// ---------------------------------------------------------------------------

interface FieldToggleProps {
  label: string
  description: string
  checked: boolean
  onChange: (val: boolean) => void
}

function FieldToggle({ label, description, checked, onChange }: FieldToggleProps) {
  return (
    <div
      className="flex items-center justify-between py-3 px-4 rounded-lg border transition-colors"
      style={{
        borderColor: checked ? 'var(--couple-primary, #7D8471)' : '#E5E7EB',
        backgroundColor: checked ? 'rgba(125, 132, 113, 0.04)' : 'transparent',
      }}
    >
      <div className="flex-1 min-w-0 mr-4">
        <p className="text-sm font-medium text-gray-900">{label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className="shrink-0 transition-colors"
        style={{ color: checked ? 'var(--couple-primary, #7D8471)' : '#D1D5DB' }}
      >
        {checked ? (
          <ToggleRight className="w-8 h-8" />
        ) : (
          <ToggleLeft className="w-8 h-8" />
        )}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Custom Question Editor
// ---------------------------------------------------------------------------

interface CustomQuestionEditorProps {
  question: CustomQuestion
  onUpdate: (q: CustomQuestion) => void
  onRemove: () => void
}

function CustomQuestionEditor({ question, onUpdate, onRemove }: CustomQuestionEditorProps) {
  const [newOption, setNewOption] = useState('')

  function addOption() {
    if (!newOption.trim()) return
    const opts = [...(question.options || []), newOption.trim()]
    onUpdate({ ...question, options: opts })
    setNewOption('')
  }

  function removeOption(idx: number) {
    const opts = (question.options || []).filter((_, i) => i !== idx)
    onUpdate({ ...question, options: opts })
  }

  return (
    <div className="border border-gray-200 rounded-lg p-4 space-y-3 bg-white">
      <div className="flex items-start gap-3">
        <GripVertical className="w-4 h-4 text-gray-300 mt-2.5 shrink-0" />
        <div className="flex-1 space-y-3">
          {/* Question text */}
          <input
            type="text"
            value={question.label}
            onChange={(e) => onUpdate({ ...question, label: e.target.value })}
            placeholder="Question text"
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--couple-primary,#7D8471)] focus:border-transparent"
          />

          {/* Type selector */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Type:</label>
            <select
              value={question.type}
              onChange={(e) =>
                onUpdate({
                  ...question,
                  type: e.target.value as 'text' | 'select' | 'boolean',
                  options: e.target.value === 'select' ? question.options || [] : undefined,
                })
              }
              className="px-2 py-1.5 border border-gray-200 rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-[var(--couple-primary,#7D8471)]"
            >
              <option value="text">Text</option>
              <option value="select">Multiple Choice</option>
              <option value="boolean">Yes / No</option>
            </select>
          </div>

          {/* Options for select type */}
          {question.type === 'select' && (
            <div className="space-y-2 pl-1">
              {(question.options || []).map((opt, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 w-4">{idx + 1}.</span>
                  <span className="text-sm text-gray-700 flex-1">{opt}</span>
                  <button
                    onClick={() => removeOption(idx)}
                    className="text-gray-300 hover:text-red-400 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newOption}
                  onChange={(e) => setNewOption(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addOption())}
                  placeholder="Add an option"
                  className="flex-1 px-2.5 py-1.5 border border-gray-200 rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-[var(--couple-primary,#7D8471)]"
                />
                <button
                  onClick={addOption}
                  className="text-xs px-2.5 py-1.5 rounded-md transition-colors text-white"
                  style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
                >
                  Add
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          onClick={onRemove}
          className="text-gray-300 hover:text-red-400 transition-colors shrink-0 mt-2"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function RsvpSettingsPage() {
  const { venueId, weddingId, loading: contextLoading } = useCoupleContext()
  const [config, setConfig] = useState<RsvpConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [hasExisting, setHasExisting] = useState(false)

  const supabase = createClient()

  // ---- Fetch config ----
  const fetchConfig = useCallback(async () => {
    const { data } = await supabase
      .from('rsvp_config')
      .select('*')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .maybeSingle()

    if (data) {
      setHasExisting(true)
      setConfig({
        ask_meal_choice: data.ask_meal_choice ?? true,
        ask_dietary: data.ask_dietary ?? true,
        ask_allergies: data.ask_allergies ?? false,
        ask_phone: data.ask_phone ?? false,
        ask_email: data.ask_email ?? false,
        ask_address: data.ask_address ?? false,
        ask_hotel: data.ask_hotel ?? false,
        ask_shuttle: data.ask_shuttle ?? false,
        ask_accessibility: data.ask_accessibility ?? false,
        ask_song_request: data.ask_song_request ?? false,
        ask_message: data.ask_message ?? false,
        allow_maybe: data.allow_maybe ?? false,
        custom_questions: (data.custom_questions as CustomQuestion[]) || [],
        rsvp_deadline: data.rsvp_deadline || null,
        attending_message: data.attending_message || DEFAULT_CONFIG.attending_message,
        declined_message: data.declined_message || DEFAULT_CONFIG.declined_message,
      })
    }
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchConfig()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Save config ----
  async function handleSave() {
    setSaving(true)
    setSaved(false)

    const payload = {
      venue_id: venueId,
      wedding_id: weddingId,
      ask_meal_choice: config.ask_meal_choice,
      ask_dietary: config.ask_dietary,
      ask_allergies: config.ask_allergies,
      ask_phone: config.ask_phone,
      ask_email: config.ask_email,
      ask_address: config.ask_address,
      ask_hotel: config.ask_hotel,
      ask_shuttle: config.ask_shuttle,
      ask_accessibility: config.ask_accessibility,
      ask_song_request: config.ask_song_request,
      ask_message: config.ask_message,
      allow_maybe: config.allow_maybe,
      custom_questions: config.custom_questions,
      rsvp_deadline: config.rsvp_deadline || null,
      attending_message: config.attending_message,
      declined_message: config.declined_message,
      updated_at: new Date().toISOString(),
    }

    await supabase
      .from('rsvp_config')
      .upsert(payload, { onConflict: 'venue_id,wedding_id' })

    setHasExisting(true)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  // ---- Custom question helpers ----
  function addCustomQuestion() {
    const q: CustomQuestion = {
      id: crypto.randomUUID(),
      label: '',
      type: 'text',
    }
    setConfig((prev) => ({
      ...prev,
      custom_questions: [...prev.custom_questions, q],
    }))
  }

  function updateCustomQuestion(id: string, updated: CustomQuestion) {
    setConfig((prev) => ({
      ...prev,
      custom_questions: prev.custom_questions.map((q) => (q.id === id ? updated : q)),
    }))
  }

  function removeCustomQuestion(id: string) {
    setConfig((prev) => ({
      ...prev,
      custom_questions: prev.custom_questions.filter((q) => q.id !== id),
    }))
  }

  // ---- Update helper ----
  function update(partial: Partial<RsvpConfig>) {
    setConfig((prev) => ({ ...prev, ...partial }))
  }

  if (contextLoading || !weddingId || !venueId || loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1
            className="text-2xl font-semibold"
            style={{ color: 'var(--couple-primary, #7D8471)', fontFamily: 'var(--couple-font-heading)' }}
          >
            RSVP Settings
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Configure what your guests see when they RSVP
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className={cn(
            'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-white transition-all',
            saved ? 'bg-green-600' : 'hover:opacity-90'
          )}
          style={!saved ? { backgroundColor: 'var(--couple-primary, #7D8471)' } : undefined}
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : saved ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Settings'}
        </button>
      </div>

      {/* ---- RSVP Deadline ---- */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <CalendarDays className="w-4.5 h-4.5" style={{ color: 'var(--couple-primary, #7D8471)' }} />
          <h2 className="text-base font-semibold text-gray-900">RSVP Deadline</h2>
        </div>
        <p className="text-xs text-gray-500">
          Set a date after which guests can no longer RSVP. Leave blank for no deadline.
        </p>
        <input
          type="date"
          value={config.rsvp_deadline || ''}
          onChange={(e) => update({ rsvp_deadline: e.target.value || null })}
          className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--couple-primary,#7D8471)] focus:border-transparent w-full sm:w-auto"
        />
        {config.rsvp_deadline && (
          <button
            onClick={() => update({ rsvp_deadline: null })}
            className="text-xs text-gray-400 hover:text-red-400 transition-colors ml-2"
          >
            Clear deadline
          </button>
        )}
      </section>

      {/* ---- Fields to Ask ---- */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <ListChecks className="w-4.5 h-4.5" style={{ color: 'var(--couple-primary, #7D8471)' }} />
          <h2 className="text-base font-semibold text-gray-900">Fields to Ask</h2>
        </div>
        <p className="text-xs text-gray-500">
          Toggle which fields appear on your public RSVP form.
        </p>

        <div className="space-y-2">
          <FieldToggle
            label="Meal Choice"
            description="Ask guests to choose their meal"
            checked={config.ask_meal_choice}
            onChange={(v) => update({ ask_meal_choice: v })}
          />
          <FieldToggle
            label="Dietary Restrictions"
            description="Ask about food allergies or dietary needs"
            checked={config.ask_dietary}
            onChange={(v) => update({ ask_dietary: v })}
          />
          <FieldToggle
            label="Allergies"
            description="Detailed allergy information (severity, EpiPen needed)"
            checked={config.ask_allergies}
            onChange={(v) => update({ ask_allergies: v })}
          />
          <FieldToggle
            label="Phone Number"
            description="Collect guest phone numbers"
            checked={config.ask_phone}
            onChange={(v) => update({ ask_phone: v })}
          />
          <FieldToggle
            label="Email"
            description="Collect guest email addresses"
            checked={config.ask_email}
            onChange={(v) => update({ ask_email: v })}
          />
          <FieldToggle
            label="Mailing Address"
            description="Collect mailing addresses (for thank-you cards)"
            checked={config.ask_address}
            onChange={(v) => update({ ask_address: v })}
          />
          <FieldToggle
            label="Hotel / Accommodation"
            description="Ask where they're staying"
            checked={config.ask_hotel}
            onChange={(v) => update({ ask_hotel: v })}
          />
          <FieldToggle
            label="Shuttle Needed"
            description="Ask if they need shuttle transportation"
            checked={config.ask_shuttle}
            onChange={(v) => update({ ask_shuttle: v })}
          />
          <FieldToggle
            label="Accessibility Needs"
            description="Ask about mobility or accessibility requirements"
            checked={config.ask_accessibility}
            onChange={(v) => update({ ask_accessibility: v })}
          />
          <FieldToggle
            label="Song Request"
            description="Let guests request a song"
            checked={config.ask_song_request}
            onChange={(v) => update({ ask_song_request: v })}
          />
          <FieldToggle
            label="Message to Couple"
            description="Let guests leave a personal message"
            checked={config.ask_message}
            onChange={(v) => update({ ask_message: v })}
          />
        </div>
      </section>

      {/* ---- Allow Maybe ---- */}
      <section className="bg-white rounded-xl border border-gray-200 p-6">
        <FieldToggle
          label='Allow "Maybe"'
          description='Allow guests to respond "Maybe" in addition to Accept / Decline'
          checked={config.allow_maybe}
          onChange={(v) => update({ allow_maybe: v })}
        />
      </section>

      {/* ---- Custom Questions ---- */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings className="w-4.5 h-4.5" style={{ color: 'var(--couple-primary, #7D8471)' }} />
            <h2 className="text-base font-semibold text-gray-900">Custom Questions</h2>
          </div>
          <button
            onClick={addCustomQuestion}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--couple-primary, #7D8471)' }}
          >
            <Plus className="w-3.5 h-3.5" />
            Add Question
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Add your own questions for guests to answer when they RSVP.
        </p>

        {config.custom_questions.length === 0 ? (
          <div className="text-center py-6 text-gray-400 text-sm">
            No custom questions yet. Click &ldquo;Add Question&rdquo; to create one.
          </div>
        ) : (
          <div className="space-y-3">
            {config.custom_questions.map((q) => (
              <CustomQuestionEditor
                key={q.id}
                question={q}
                onUpdate={(updated) => updateCustomQuestion(q.id, updated)}
                onRemove={() => removeCustomQuestion(q.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ---- Confirmation Messages ---- */}
      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4.5 h-4.5" style={{ color: 'var(--couple-primary, #7D8471)' }} />
          <h2 className="text-base font-semibold text-gray-900">Confirmation Messages</h2>
        </div>
        <p className="text-xs text-gray-500">
          Customize what guests see after they submit their RSVP.
        </p>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="block text-xs font-medium text-gray-700">
              When guest is attending
            </label>
            <textarea
              value={config.attending_message}
              onChange={(e) => update({ attending_message: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--couple-primary,#7D8471)] focus:border-transparent resize-none"
              placeholder="Thank you for confirming! We can't wait to celebrate with you."
            />
          </div>
          <div className="space-y-2">
            <label className="block text-xs font-medium text-gray-700">
              When guest declines
            </label>
            <textarea
              value={config.declined_message}
              onChange={(e) => update({ declined_message: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[var(--couple-primary,#7D8471)] focus:border-transparent resize-none"
              placeholder="We'll miss you! Thank you for letting us know."
            />
          </div>
        </div>
      </section>

      {/* Bottom save button */}
      <div className="flex justify-end pb-8">
        <button
          onClick={handleSave}
          disabled={saving}
          className={cn(
            'flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium text-white transition-all',
            saved ? 'bg-green-600' : 'hover:opacity-90'
          )}
          style={!saved ? { backgroundColor: 'var(--couple-primary, #7D8471)' } : undefined}
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : saved ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
