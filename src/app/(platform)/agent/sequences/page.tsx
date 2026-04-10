'use client'

import { useState, useEffect, useCallback } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import { VenueChip } from '@/components/intel/venue-chip'
import {
  Workflow,
  Plus,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  X,
  Zap,
  Mail,
  Clock,
  Bell,
  ClipboardList,
  GripVertical,
  ArrowUp,
  ArrowDown,
  CheckCircle2,
  Sparkles,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SequenceStep {
  id: string
  sequence_id: string
  step_order: number
  delay_days: number
  action_type: 'email' | 'task' | 'alert'
  email_subject_template: string | null
  email_body_template: string | null
  is_active: boolean
  created_at: string
}

interface Sequence {
  id: string
  venue_id: string
  name: string
  description: string | null
  trigger_type: 'post_tour' | 'ghosted' | 'post_booking' | 'pre_event' | 'custom'
  trigger_config: Record<string, unknown>
  is_active: boolean
  created_at: string
  sequence_steps?: SequenceStep[]
  venue_name?: string | null
}

// Local step form data (no id yet for new steps)
interface StepFormData {
  id?: string
  step_order: number
  delay_days: number
  action_type: 'email' | 'task' | 'alert'
  email_subject_template: string
  email_body_template: string
  is_active: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRIGGER_TYPES = [
  { value: 'post_tour', label: 'Post-Tour', desc: 'After a tour is completed', color: 'bg-blue-50 text-blue-700' },
  { value: 'ghosted', label: 'Ghosted', desc: 'No response after outreach', color: 'bg-amber-50 text-amber-700' },
  { value: 'post_booking', label: 'Post-Booking', desc: 'After status changes to booked', color: 'bg-emerald-50 text-emerald-700' },
  { value: 'pre_event', label: 'Pre-Event', desc: 'Before the wedding date', color: 'bg-purple-50 text-purple-700' },
  { value: 'custom', label: 'Custom', desc: 'Custom trigger condition', color: 'bg-sage-50 text-sage-600' },
] as const

const ACTION_TYPES = [
  { value: 'email', label: 'Email', icon: Mail },
  { value: 'task', label: 'Task', icon: ClipboardList },
  { value: 'alert', label: 'Alert', icon: Bell },
] as const

function getTriggerMeta(trigger: string) {
  return TRIGGER_TYPES.find((t) => t.value === trigger) ?? TRIGGER_TYPES[4]
}

function getActionMeta(action: string) {
  return ACTION_TYPES.find((a) => a.value === action) ?? ACTION_TYPES[0]
}

// ---------------------------------------------------------------------------
// Default sequence templates
// ---------------------------------------------------------------------------

interface DefaultTemplate {
  name: string
  description: string
  trigger_type: Sequence['trigger_type']
  trigger_config: Record<string, unknown>
  steps: Omit<StepFormData, 'id'>[]
}

const DEFAULT_TEMPLATES: DefaultTemplate[] = [
  {
    name: 'Post-Tour Follow-Up',
    description: 'Warm follow-up after a couple completes a venue tour. Builds excitement and nudges toward booking.',
    trigger_type: 'post_tour',
    trigger_config: { days_after: 3, stage: 'tour_completed' },
    steps: [
      {
        step_order: 1,
        delay_days: 1,
        action_type: 'email',
        email_subject_template: 'So wonderful meeting you!',
        email_body_template: 'Thank the couple for visiting, mention 1-2 things they loved, ask if they have questions.',
        is_active: true,
      },
      {
        step_order: 2,
        delay_days: 3,
        action_type: 'email',
        email_subject_template: 'A few things we thought of...',
        email_body_template: 'Share a relevant seasonal tip or vendor recommendation based on their wedding date.',
        is_active: true,
      },
      {
        step_order: 3,
        delay_days: 7,
        action_type: 'task',
        email_subject_template: '',
        email_body_template: 'Create a task to check in personally if no reply by day 7.',
        is_active: true,
      },
    ],
  },
  {
    name: 'Ghosted Re-engagement',
    description: 'Re-engage leads who stopped responding. Gentle, value-driven nudges before a graceful close.',
    trigger_type: 'ghosted',
    trigger_config: { days_after: 7, stage: 'no_response' },
    steps: [
      {
        step_order: 1,
        delay_days: 7,
        action_type: 'email',
        email_subject_template: 'Still thinking things over?',
        email_body_template: 'Light check-in. Share a new photo or upcoming open house date.',
        is_active: true,
      },
      {
        step_order: 2,
        delay_days: 14,
        action_type: 'email',
        email_subject_template: 'Quick availability update for your date',
        email_body_template: 'Create urgency with a genuine availability update for their preferred date.',
        is_active: true,
      },
      {
        step_order: 3,
        delay_days: 21,
        action_type: 'email',
        email_subject_template: 'Wishing you the best!',
        email_body_template: 'Graceful close. Let them know the door is open if they change their mind.',
        is_active: true,
      },
      {
        step_order: 4,
        delay_days: 21,
        action_type: 'alert',
        email_subject_template: '',
        email_body_template: 'Alert coordinator that lead has been through full ghosted sequence with no response.',
        is_active: true,
      },
    ],
  },
  {
    name: 'Post-Booking Nurture',
    description: 'Welcome newly booked couples and guide them through the first steps of planning with you.',
    trigger_type: 'post_booking',
    trigger_config: { days_after: 0, stage: 'booked' },
    steps: [
      {
        step_order: 1,
        delay_days: 0,
        action_type: 'email',
        email_subject_template: 'Welcome to the family!',
        email_body_template: 'Celebrate the booking! Share portal login details and what to expect next.',
        is_active: true,
      },
      {
        step_order: 2,
        delay_days: 3,
        action_type: 'email',
        email_subject_template: 'Your planning checklist is ready',
        email_body_template: 'Point them to the planning checklist in the portal. Highlight the first 3 items.',
        is_active: true,
      },
      {
        step_order: 3,
        delay_days: 7,
        action_type: 'task',
        email_subject_template: '',
        email_body_template: 'Schedule the first planning call with the couple.',
        is_active: true,
      },
      {
        step_order: 4,
        delay_days: 14,
        action_type: 'email',
        email_subject_template: 'Vendor recommendations for your date',
        email_body_template: 'Share curated vendor recommendations based on their wedding date and style.',
        is_active: true,
      },
    ],
  },
  {
    name: 'Pre-Event Check-In',
    description: 'Final countdown touches before the wedding day. Confirms details and builds anticipation.',
    trigger_type: 'pre_event',
    trigger_config: { days_before: 30, stage: 'wedding_date' },
    steps: [
      {
        step_order: 1,
        delay_days: 30,
        action_type: 'email',
        email_subject_template: '30 days to go!',
        email_body_template: 'Excitement builder. Confirm key logistics and outstanding items from their checklist.',
        is_active: true,
      },
      {
        step_order: 2,
        delay_days: 14,
        action_type: 'task',
        email_subject_template: '',
        email_body_template: 'Review final floor plan, seating chart, and vendor timeline with the couple.',
        is_active: true,
      },
      {
        step_order: 3,
        delay_days: 7,
        action_type: 'email',
        email_subject_template: 'Final details for your big day',
        email_body_template: 'Week-of logistics email: arrival times, vendor contacts, weather backup plan.',
        is_active: true,
      },
      {
        step_order: 4,
        delay_days: 1,
        action_type: 'alert',
        email_subject_template: '',
        email_body_template: 'Alert the team: wedding is tomorrow. Final walk-through reminder.',
        is_active: true,
      },
    ],
  },
]

const inputClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function CardSkeleton() {
  return (
    <div className="space-y-4">
      {[...Array(3)].map((_, i) => (
        <div key={i} className="bg-surface border border-border rounded-xl p-5 shadow-sm">
          <div className="animate-pulse space-y-3">
            <div className="flex items-center justify-between">
              <div className="h-5 w-48 bg-sage-100 rounded" />
              <div className="h-4 w-16 bg-sage-100 rounded-full" />
            </div>
            <div className="h-4 w-72 bg-sage-50 rounded" />
            <div className="flex gap-4">
              <div className="h-3 w-24 bg-sage-50 rounded" />
              <div className="h-3 w-24 bg-sage-50 rounded" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step Editor (inline within sequence form)
// ---------------------------------------------------------------------------

function StepEditor({
  steps,
  onChange,
}: {
  steps: StepFormData[]
  onChange: (steps: StepFormData[]) => void
}) {
  const addStep = () => {
    const lastDelay = steps.length > 0 ? steps[steps.length - 1].delay_days : 0
    onChange([
      ...steps,
      {
        step_order: steps.length + 1,
        delay_days: lastDelay + 3,
        action_type: 'email',
        email_subject_template: '',
        email_body_template: '',
        is_active: true,
      },
    ])
  }

  const removeStep = (idx: number) => {
    const updated = steps.filter((_, i) => i !== idx).map((s, i) => ({ ...s, step_order: i + 1 }))
    onChange(updated)
  }

  const updateStep = (idx: number, changes: Partial<StepFormData>) => {
    onChange(steps.map((s, i) => (i === idx ? { ...s, ...changes } : s)))
  }

  const moveStep = (idx: number, direction: 'up' | 'down') => {
    if ((direction === 'up' && idx === 0) || (direction === 'down' && idx === steps.length - 1)) return
    const newSteps = [...steps]
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    ;[newSteps[idx], newSteps[targetIdx]] = [newSteps[targetIdx], newSteps[idx]]
    onChange(newSteps.map((s, i) => ({ ...s, step_order: i + 1 })))
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <label className="block text-sm font-medium text-sage-700">Steps</label>
        <button
          type="button"
          onClick={addStep}
          className="flex items-center gap-1 text-xs font-medium text-sage-600 hover:text-sage-800 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Step
        </button>
      </div>

      {steps.length === 0 && (
        <p className="text-sm text-sage-400 italic">No steps yet. Add one to get started.</p>
      )}

      <div className="space-y-3">
        {steps.map((step, idx) => {
          const actionMeta = getActionMeta(step.action_type)
          const ActionIcon = actionMeta.icon

          return (
            <div
              key={idx}
              className="bg-sage-50 rounded-lg p-4 border border-sage-100 relative"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <GripVertical className="w-4 h-4 text-sage-300" />
                  <span className="text-xs font-semibold text-sage-500 uppercase">
                    Step {idx + 1}
                  </span>
                  <ActionIcon className="w-3.5 h-3.5 text-sage-400" />
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveStep(idx, 'up')}
                    disabled={idx === 0}
                    className="p-1 rounded text-sage-400 hover:text-sage-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStep(idx, 'down')}
                    disabled={idx === steps.length - 1}
                    className="p-1 rounded text-sage-400 hover:text-sage-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  {steps.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeStep(idx)}
                      className="p-1 rounded text-sage-400 hover:text-red-500 transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                <div>
                  <label className="block text-xs text-sage-500 mb-1">Delay (days)</label>
                  <input
                    type="number"
                    min={0}
                    value={step.delay_days}
                    onChange={(e) => updateStep(idx, { delay_days: parseInt(e.target.value) || 0 })}
                    className={inputClasses}
                  />
                </div>
                <div>
                  <label className="block text-xs text-sage-500 mb-1">Action Type</label>
                  <select
                    value={step.action_type}
                    onChange={(e) => updateStep(idx, { action_type: e.target.value as StepFormData['action_type'] })}
                    className={inputClasses}
                  >
                    {ACTION_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={step.is_active}
                      onChange={(e) => updateStep(idx, { is_active: e.target.checked })}
                      className="w-4 h-4 rounded border-sage-300 text-sage-600 focus:ring-sage-500"
                    />
                    <span className="text-xs text-sage-600">Active</span>
                  </label>
                </div>
              </div>

              {step.action_type === 'email' && (
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs text-sage-500 mb-1">Subject Template</label>
                    <input
                      type="text"
                      value={step.email_subject_template}
                      onChange={(e) => updateStep(idx, { email_subject_template: e.target.value })}
                      className={inputClasses}
                      placeholder="e.g., So wonderful meeting you!"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-sage-500 mb-1">Body Template / Instructions</label>
                    <textarea
                      value={step.email_body_template}
                      onChange={(e) => updateStep(idx, { email_body_template: e.target.value })}
                      className={`${inputClasses} resize-none`}
                      rows={2}
                      placeholder="Instructions for the AI to generate this email..."
                    />
                  </div>
                </div>
              )}

              {(step.action_type === 'task' || step.action_type === 'alert') && (
                <div>
                  <label className="block text-xs text-sage-500 mb-1">
                    {step.action_type === 'task' ? 'Task Description' : 'Alert Message'}
                  </label>
                  <textarea
                    value={step.email_body_template}
                    onChange={(e) => updateStep(idx, { email_body_template: e.target.value })}
                    className={`${inputClasses} resize-none`}
                    rows={2}
                    placeholder={
                      step.action_type === 'task'
                        ? 'Describe the task to create...'
                        : 'Describe what to alert the coordinator about...'
                    }
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sequence Modal (Create/Edit)
// ---------------------------------------------------------------------------

function SequenceModal({
  sequence,
  onClose,
  onSave,
}: {
  sequence: Sequence | null
  onClose: () => void
  onSave: (data: {
    id?: string
    name: string
    description: string
    trigger_type: Sequence['trigger_type']
    trigger_config: Record<string, unknown>
    is_active: boolean
    steps: StepFormData[]
  }) => Promise<void>
}) {
  const [name, setName] = useState(sequence?.name ?? '')
  const [description, setDescription] = useState(sequence?.description ?? '')
  const [triggerType, setTriggerType] = useState<Sequence['trigger_type']>(sequence?.trigger_type ?? 'post_tour')
  const [triggerConfig, setTriggerConfig] = useState<string>(
    sequence?.trigger_config ? JSON.stringify(sequence.trigger_config, null, 2) : '{}'
  )
  const [steps, setSteps] = useState<StepFormData[]>(() => {
    if (sequence?.sequence_steps && sequence.sequence_steps.length > 0) {
      return sequence.sequence_steps
        .sort((a, b) => a.step_order - b.step_order)
        .map((s) => ({
          id: s.id,
          step_order: s.step_order,
          delay_days: s.delay_days,
          action_type: s.action_type,
          email_subject_template: s.email_subject_template ?? '',
          email_body_template: s.email_body_template ?? '',
          is_active: s.is_active,
        }))
    }
    return [{ step_order: 1, delay_days: 1, action_type: 'email', email_subject_template: '', email_body_template: '', is_active: true }]
  })
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || steps.length === 0) return
    setSaving(true)

    let parsedConfig: Record<string, unknown> = {}
    try {
      parsedConfig = JSON.parse(triggerConfig)
    } catch {
      parsedConfig = {}
    }

    await onSave({
      id: sequence?.id,
      name: name.trim(),
      description: description.trim(),
      trigger_type: triggerType,
      trigger_config: parsedConfig,
      is_active: sequence?.is_active ?? true,
      steps,
    })
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-surface rounded-xl shadow-xl border border-border w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-border sticky top-0 bg-surface z-10">
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            {sequence ? 'Edit Sequence' : 'Create Sequence'}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Sequence Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClasses}
              placeholder="e.g., Post-Tour Follow-Up"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={`${inputClasses} resize-none`}
              rows={2}
              placeholder="Describe what this sequence does and when it fires..."
            />
          </div>

          {/* Trigger Type */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Trigger Type</label>
            <select
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value as Sequence['trigger_type'])}
              className={inputClasses}
            >
              {TRIGGER_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label} — {t.desc}
                </option>
              ))}
            </select>
          </div>

          {/* Trigger Config */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">
              Trigger Config <span className="text-sage-400 font-normal">(JSON)</span>
            </label>
            <textarea
              value={triggerConfig}
              onChange={(e) => setTriggerConfig(e.target.value)}
              className={`${inputClasses} font-mono text-xs resize-none`}
              rows={3}
              placeholder='{"days_after": 3, "stage": "tour_completed"}'
            />
          </div>

          {/* Steps */}
          <StepEditor steps={steps} onChange={setSteps} />

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-sage-600 hover:text-sage-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim() || steps.length === 0}
              className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : sequence ? 'Update Sequence' : 'Create Sequence'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Default Templates Panel
// ---------------------------------------------------------------------------

function DefaultTemplatesPanel({
  onActivate,
  existingTriggers,
}: {
  onActivate: (template: DefaultTemplate) => Promise<void>
  existingTriggers: Set<string>
}) {
  const [activating, setActivating] = useState<string | null>(null)

  const handleActivate = async (template: DefaultTemplate) => {
    setActivating(template.name)
    await onActivate(template)
    setActivating(null)
  }

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-border bg-sage-50/50">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-gold-500" />
          <h3 className="text-sm font-semibold text-sage-800">Quick-Start Templates</h3>
        </div>
        <p className="text-xs text-sage-500 mt-1">
          Activate a pre-built sequence to get started quickly. You can customize after activating.
        </p>
      </div>
      <div className="divide-y divide-border">
        {DEFAULT_TEMPLATES.map((template) => {
          const trigger = getTriggerMeta(template.trigger_type)
          const alreadyExists = existingTriggers.has(template.trigger_type)
          const isActivating = activating === template.name

          return (
            <div key={template.name} className="px-5 py-4 flex items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <h4 className="text-sm font-medium text-sage-900">{template.name}</h4>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${trigger.color}`}>
                    {trigger.label}
                  </span>
                </div>
                <p className="text-xs text-sage-500">{template.description}</p>
                <p className="text-xs text-sage-400 mt-1">
                  {template.steps.length} step{template.steps.length !== 1 ? 's' : ''} over{' '}
                  {template.steps[template.steps.length - 1].delay_days} days
                </p>
              </div>
              <button
                onClick={() => handleActivate(template)}
                disabled={alreadyExists || isActivating}
                className={`shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  alreadyExists
                    ? 'bg-sage-100 text-sage-400 cursor-not-allowed'
                    : 'bg-sage-500 hover:bg-sage-600 text-white'
                }`}
              >
                {isActivating ? 'Activating...' : alreadyExists ? 'Already Added' : 'Activate'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function SequencesPage() {
  const VENUE_ID = useVenueId()
  const scope = useScope()
  const showVenueChip = scope.level !== 'venue'
  const [sequences, setSequences] = useState<Sequence[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingSequence, setEditingSequence] = useState<Sequence | null | 'new'>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showTemplates, setShowTemplates] = useState(false)

  const supabase = createClient()

  // ---- Fetch sequences with steps ----
  const fetchSequences = useCallback(async () => {
    try {
      const { data, error: fetchError } = await supabase
        .from('follow_up_sequences')
        .select(`
          *,
          sequence_steps (*),
          venues:venue_id ( name )
        `)
        .eq('venue_id', VENUE_ID)
        .order('created_at', { ascending: false })

      if (fetchError) throw fetchError
      const mapped: Sequence[] = (data ?? []).map((row: any) => {
        const venueRel = row.venues as { name?: string } | { name?: string }[] | null | undefined
        const venueName = Array.isArray(venueRel) ? venueRel[0]?.name ?? null : venueRel?.name ?? null
        return { ...row, venue_name: venueName }
      })
      setSequences(mapped)
    } catch (err) {
      console.error('Failed to fetch sequences:', err)
      setError('Failed to load sequences')
    }
  }, [VENUE_ID])

  useEffect(() => {
    fetchSequences().then(() => setLoading(false))
  }, [fetchSequences])

  // ---- Save sequence + steps ----
  const handleSave = async (data: {
    id?: string
    name: string
    description: string
    trigger_type: Sequence['trigger_type']
    trigger_config: Record<string, unknown>
    is_active: boolean
    steps: StepFormData[]
  }) => {
    try {
      let sequenceId = data.id

      if (sequenceId) {
        // Update sequence
        const { error: updateError } = await supabase
          .from('follow_up_sequences')
          .update({
            name: data.name,
            description: data.description,
            trigger_type: data.trigger_type,
            trigger_config: data.trigger_config,
            is_active: data.is_active,
          })
          .eq('id', sequenceId)

        if (updateError) throw updateError

        // Delete existing steps and re-insert (simplest for reordering)
        const { error: deleteError } = await supabase
          .from('sequence_steps')
          .delete()
          .eq('sequence_id', sequenceId)

        if (deleteError) throw deleteError
      } else {
        // Create new sequence
        const { data: newSeq, error: insertError } = await supabase
          .from('follow_up_sequences')
          .insert({
            venue_id: VENUE_ID,
            name: data.name,
            description: data.description,
            trigger_type: data.trigger_type,
            trigger_config: data.trigger_config,
            is_active: data.is_active,
          })
          .select('id')
          .single()

        if (insertError) throw insertError
        sequenceId = newSeq.id
      }

      // Insert steps
      if (data.steps.length > 0 && sequenceId) {
        const stepsToInsert = data.steps.map((s) => ({
          sequence_id: sequenceId,
          step_order: s.step_order,
          delay_days: s.delay_days,
          action_type: s.action_type,
          email_subject_template: s.email_subject_template || null,
          email_body_template: s.email_body_template || null,
          is_active: s.is_active,
        }))

        const { error: stepsError } = await supabase
          .from('sequence_steps')
          .insert(stepsToInsert)

        if (stepsError) throw stepsError
      }

      setEditingSequence(null)
      await fetchSequences()
    } catch (err) {
      console.error('Failed to save sequence:', err)
      setError('Failed to save sequence. Please try again.')
    }
  }

  // ---- Toggle active ----
  const handleToggleActive = async (id: string, currentlyActive: boolean) => {
    try {
      const { error: updateError } = await supabase
        .from('follow_up_sequences')
        .update({ is_active: !currentlyActive })
        .eq('id', id)

      if (updateError) throw updateError
      await fetchSequences()
    } catch (err) {
      console.error('Failed to toggle sequence:', err)
    }
  }

  // ---- Delete sequence ----
  const handleDelete = async (id: string) => {
    if (!confirm('Delete this sequence and all its steps? This cannot be undone.')) return
    try {
      const { error: deleteError } = await supabase
        .from('follow_up_sequences')
        .delete()
        .eq('id', id)

      if (deleteError) throw deleteError
      if (expandedId === id) setExpandedId(null)
      await fetchSequences()
    } catch (err) {
      console.error('Failed to delete sequence:', err)
    }
  }

  // ---- Activate default template ----
  const handleActivateTemplate = async (template: DefaultTemplate) => {
    await handleSave({
      name: template.name,
      description: template.description,
      trigger_type: template.trigger_type,
      trigger_config: template.trigger_config,
      is_active: true,
      steps: template.steps.map((s) => ({ ...s })),
    })
  }

  // ---- Derived data ----
  const activeCount = sequences.filter((s) => s.is_active).length
  const totalStepCount = sequences.reduce((sum, s) => sum + (s.sequence_steps?.length ?? 0), 0)
  const existingTriggers = new Set(sequences.map((s) => s.trigger_type))

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Sequences
          </h1>
          <p className="text-sage-600">
            Automated follow-up workflows that trigger based on lead activity — post-tour nurture, ghosted re-engagement, booking welcome, and pre-event check-ins. Activate a template or build your own.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setShowTemplates(!showTemplates)}
            className="flex items-center gap-2 px-4 py-2.5 border border-sage-200 text-sage-700 hover:bg-sage-50 text-sm font-medium rounded-lg transition-colors"
          >
            <Sparkles className="w-4 h-4" />
            Templates
          </button>
          <button
            onClick={() => setEditingSequence('new')}
            className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Sequence
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
          <button
            onClick={() => setError(null)}
            className="ml-auto text-sm font-medium text-red-600 hover:text-red-800 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Stats */}
      {!loading && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-sage-50 flex items-center justify-center">
                <Workflow className="w-5 h-5 text-sage-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{sequences.length}</p>
                <p className="text-xs text-sage-500">Total Sequences</p>
              </div>
            </div>
          </div>
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center">
                <Zap className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{activeCount}</p>
                <p className="text-xs text-sage-500">Active Sequences</p>
              </div>
            </div>
          </div>
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-teal-50 flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-teal-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{totalStepCount}</p>
                <p className="text-xs text-sage-500">Total Steps</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Default Templates Panel */}
      {showTemplates && (
        <DefaultTemplatesPanel
          onActivate={handleActivateTemplate}
          existingTriggers={existingTriggers}
        />
      )}

      {/* Sequences List */}
      {loading ? (
        <CardSkeleton />
      ) : sequences.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
          <Workflow className="w-12 h-12 text-sage-300 mx-auto mb-4" />
          <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
            No sequences yet
          </h3>
          <p className="text-sm text-sage-600 max-w-md mx-auto mb-4">
            Create follow-up sequences to automate outreach at key moments — post-tour, ghosted leads, post-booking, and pre-event.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => setShowTemplates(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 border border-sage-200 text-sage-700 hover:bg-sage-50 text-sm font-medium rounded-lg transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              Use a Template
            </button>
            <button
              onClick={() => setEditingSequence('new')}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create from Scratch
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {sequences.map((seq) => {
            const trigger = getTriggerMeta(seq.trigger_type)
            const isExpanded = expandedId === seq.id
            const steps = (seq.sequence_steps ?? []).sort((a, b) => a.step_order - b.step_order)
            const maxDelay = steps.length > 0 ? Math.max(...steps.map((s) => s.delay_days)) : 0

            return (
              <div
                key={seq.id}
                className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden"
              >
                <div className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                        <h3 className="font-heading text-base font-semibold text-sage-900 truncate">
                          {seq.name}
                        </h3>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${trigger.color}`}>
                          {trigger.label}
                        </span>
                        {seq.is_active ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-700">
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-sage-100 text-sage-500">
                            Inactive
                          </span>
                        )}
                        {showVenueChip && <VenueChip venueName={seq.venue_name} />}
                      </div>
                      {seq.description && (
                        <p className="text-xs text-sage-500 mb-2 line-clamp-2">{seq.description}</p>
                      )}
                      <div className="flex items-center gap-4 text-xs text-sage-500">
                        <span className="flex items-center gap-1">
                          <Mail className="w-3.5 h-3.5" />
                          {steps.length} step{steps.length !== 1 ? 's' : ''}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5" />
                          {maxDelay} day span
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => handleToggleActive(seq.id, seq.is_active)}
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                          seq.is_active
                            ? 'text-amber-700 bg-amber-50 hover:bg-amber-100'
                            : 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                        }`}
                      >
                        {seq.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button
                        onClick={() => setEditingSequence(seq)}
                        className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
                        title="Edit"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(seq.id)}
                        className="p-1.5 rounded-lg text-sage-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : seq.id)}
                        className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
                        title={isExpanded ? 'Collapse' : 'Expand'}
                      >
                        {isExpanded ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Expanded: show steps */}
                {isExpanded && steps.length > 0 && (
                  <div className="border-t border-border bg-sage-50/50 px-5 py-4">
                    <div className="space-y-2">
                      {steps.map((step, idx) => {
                        const actionMeta = getActionMeta(step.action_type)
                        const ActionIcon = actionMeta.icon

                        return (
                          <div
                            key={step.id}
                            className={`flex items-start gap-4 bg-surface rounded-lg p-3 border ${
                              step.is_active ? 'border-border' : 'border-border opacity-50'
                            }`}
                          >
                            <span className="w-7 h-7 rounded-full bg-sage-100 text-sage-600 text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                              {idx + 1}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <ActionIcon className="w-3.5 h-3.5 text-sage-500" />
                                <p className="text-sm font-medium text-sage-800">
                                  Day {step.delay_days} — {actionMeta.label}
                                </p>
                                {!step.is_active && (
                                  <span className="text-[10px] text-sage-400 font-medium">(disabled)</span>
                                )}
                              </div>
                              {step.action_type === 'email' && step.email_subject_template && (
                                <p className="text-xs text-sage-600 truncate">
                                  Subject: {step.email_subject_template}
                                </p>
                              )}
                              {step.email_body_template && (
                                <p className="text-xs text-sage-500 mt-0.5 line-clamp-2">
                                  {step.email_body_template}
                                </p>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {isExpanded && steps.length === 0 && (
                  <div className="border-t border-border bg-sage-50/50 px-5 py-4">
                    <p className="text-sm text-sage-400 italic text-center">No steps configured.</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Sequence Modal */}
      {editingSequence !== null && (
        <SequenceModal
          sequence={editingSequence === 'new' ? null : editingSequence}
          onClose={() => setEditingSequence(null)}
          onSave={handleSave}
        />
      )}
    </div>
  )
}
