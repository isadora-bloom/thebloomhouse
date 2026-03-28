'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  ListOrdered,
  Plus,
  Pencil,
  Pause,
  Play,
  XCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  X,
  Zap,
  Users,
  Mail,
  Clock,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SequenceStep {
  day_offset: number
  template_type: string
  subject_line: string
}

interface SequenceTemplate {
  id: string
  venue_id: string
  name: string
  trigger: 'new_inquiry' | 'no_response' | 'post_tour' | 'post_hold'
  steps: SequenceStep[]
  is_active: boolean
  created_at: string
}

interface Enrollment {
  id: string
  venue_id: string
  wedding_id: string
  template_id: string
  current_step: number
  status: 'active' | 'paused' | 'completed' | 'cancelled'
  enrolled_at: string
  created_at: string
  // Joined
  template_name?: string
  couple_name?: string
}

type TabKey = 'templates' | 'enrollments'

// TODO: Replace with venue from auth context
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

const TRIGGER_TYPES = [
  { value: 'new_inquiry', label: 'New Inquiry', desc: 'Triggered when a new inquiry comes in' },
  { value: 'no_response', label: 'No Response', desc: 'Triggered when a lead goes silent' },
  { value: 'post_tour', label: 'Post Tour', desc: 'Triggered after a tour is completed' },
  { value: 'post_hold', label: 'Post Hold', desc: 'Triggered after a date hold is placed' },
]

const STEP_TYPES = [
  { value: 'follow_up', label: 'Follow Up' },
  { value: 'check_in', label: 'Check In' },
  { value: 'value_add', label: 'Value Add' },
  { value: 'final_nudge', label: 'Final Nudge' },
  { value: 'break_up', label: 'Break Up' },
]

function triggerBadge(trigger: string): { bg: string; text: string; label: string } {
  switch (trigger) {
    case 'new_inquiry':
      return { bg: 'bg-teal-50', text: 'text-teal-700', label: 'New Inquiry' }
    case 'no_response':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'No Response' }
    case 'post_tour':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Post Tour' }
    case 'post_hold':
      return { bg: 'bg-purple-50', text: 'text-purple-700', label: 'Post Hold' }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: trigger }
  }
}

function enrollmentStatusBadge(status: string) {
  switch (status) {
    case 'active':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', label: 'Active' }
    case 'paused':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Paused' }
    case 'completed':
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Completed' }
    case 'cancelled':
      return { bg: 'bg-red-50', text: 'text-red-700', label: 'Cancelled' }
    default:
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: status }
  }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

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
            <div className="h-4 w-32 bg-sage-50 rounded" />
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
// Template Modal (Create/Edit)
// ---------------------------------------------------------------------------

function TemplateModal({
  template,
  onClose,
  onSave,
}: {
  template: SequenceTemplate | null
  onClose: () => void
  onSave: (data: Partial<SequenceTemplate>) => Promise<void>
}) {
  const [name, setName] = useState(template?.name ?? '')
  const [triggerType, setTriggerType] = useState(template?.trigger ?? 'new_inquiry')
  const [steps, setSteps] = useState<SequenceStep[]>(
    template?.steps ?? [{ day_offset: 1, template_type: 'follow_up', subject_line: '' }]
  )
  const [saving, setSaving] = useState(false)

  const addStep = () => {
    const lastDay = steps.length > 0 ? steps[steps.length - 1].day_offset : 0
    setSteps([...steps, { day_offset: lastDay + 3, template_type: 'follow_up', subject_line: '' }])
  }

  const removeStep = (idx: number) => {
    setSteps(steps.filter((_, i) => i !== idx))
  }

  const updateStep = (idx: number, field: keyof SequenceStep, value: string | number) => {
    setSteps(
      steps.map((s, i) => (i === idx ? { ...s, [field]: value } : s))
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || steps.length === 0) return
    setSaving(true)
    await onSave({
      id: template?.id,
      name,
      trigger: triggerType as SequenceTemplate['trigger'],
      steps,
      is_active: template?.is_active ?? true,
    })
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-surface rounded-xl shadow-xl border border-border w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-border sticky top-0 bg-surface z-10">
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            {template ? 'Edit Sequence' : 'Create Sequence'}
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
              placeholder="e.g., New Inquiry Follow-Up"
            />
          </div>

          {/* Trigger Type */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Trigger</label>
            <select
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value as SequenceTemplate['trigger'])}
              className={inputClasses}
            >
              {TRIGGER_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label} — {t.desc}
                </option>
              ))}
            </select>
          </div>

          {/* Steps */}
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

            <div className="space-y-3">
              {steps.map((step, idx) => (
                <div
                  key={idx}
                  className="bg-sage-50 rounded-lg p-4 border border-sage-100"
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold text-sage-500 uppercase">
                      Step {idx + 1}
                    </span>
                    {steps.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeStep(idx)}
                        className="text-sage-400 hover:text-red-500 transition-colors"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-sage-500 mb-1">Day Offset</label>
                      <input
                        type="number"
                        min={0}
                        value={step.day_offset}
                        onChange={(e) =>
                          updateStep(idx, 'day_offset', parseInt(e.target.value) || 0)
                        }
                        className={inputClasses}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-sage-500 mb-1">Type</label>
                      <select
                        value={step.template_type}
                        onChange={(e) => updateStep(idx, 'template_type', e.target.value)}
                        className={inputClasses}
                      >
                        {STEP_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-sage-500 mb-1">Subject Line</label>
                      <input
                        type="text"
                        value={step.subject_line}
                        onChange={(e) => updateStep(idx, 'subject_line', e.target.value)}
                        className={inputClasses}
                        placeholder="Custom subject..."
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

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
              {saving ? 'Saving...' : template ? 'Update Sequence' : 'Create Sequence'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function SequencesPage() {
  const [templates, setTemplates] = useState<SequenceTemplate[]>([])
  const [enrollments, setEnrollments] = useState<Enrollment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('templates')
  const [editingTemplate, setEditingTemplate] = useState<SequenceTemplate | null | 'new'>(null)
  const [expandedTemplateId, setExpandedTemplateId] = useState<string | null>(null)

  const supabase = createClient()

  // ---- Fetch templates ----
  const fetchTemplates = useCallback(async () => {
    try {
      const { data, error: fetchError } = await supabase
        .from('follow_up_sequence_templates')
        .select('*')
        .eq('venue_id', VENUE_ID)
        .order('created_at', { ascending: false })

      if (fetchError) throw fetchError
      setTemplates(data ?? [])
    } catch (err) {
      console.error('Failed to fetch sequence templates:', err)
      setError('Failed to load sequence templates')
    }
  }, [])

  // ---- Fetch enrollments ----
  const fetchEnrollments = useCallback(async () => {
    try {
      const { data, error: fetchError } = await supabase
        .from('wedding_sequences')
        .select(`
          id,
          venue_id,
          wedding_id,
          template_id,
          current_step,
          status,
          enrolled_at,
          created_at,
          follow_up_sequence_templates ( name ),
          weddings!wedding_sequences_wedding_id_fkey (
            people!people_wedding_id_fkey ( role, first_name, last_name )
          )
        `)
        .eq('venue_id', VENUE_ID)
        .order('created_at', { ascending: false })

      if (fetchError) throw fetchError

      const mapped: Enrollment[] = (data ?? []).map((row: any) => {
        const tmpl = row.follow_up_sequence_templates
        const people = row.weddings?.people ?? []
        const p1 = people.find((p: any) => p.role === 'partner1')
        const p2 = people.find((p: any) => p.role === 'partner2')
        const name1 = p1 ? [p1.first_name, p1.last_name].filter(Boolean).join(' ') : null
        const name2 = p2 ? [p2.first_name, p2.last_name].filter(Boolean).join(' ') : null

        return {
          id: row.id,
          venue_id: row.venue_id,
          wedding_id: row.wedding_id,
          template_id: row.template_id,
          current_step: row.current_step,
          status: row.status,
          enrolled_at: row.enrolled_at,
          created_at: row.created_at,
          template_name: tmpl?.name ?? 'Unknown',
          couple_name: name1 && name2 ? `${name1} & ${name2}` : name1 || name2 || 'Unknown',
        }
      })

      setEnrollments(mapped)
    } catch (err) {
      console.error('Failed to fetch enrollments:', err)
      setError('Failed to load sequence enrollments')
    }
  }, [])

  useEffect(() => {
    Promise.all([fetchTemplates(), fetchEnrollments()]).then(() => setLoading(false))
  }, [fetchTemplates, fetchEnrollments])

  // ---- Save template ----
  const handleSaveTemplate = async (data: Partial<SequenceTemplate>) => {
    try {
      if (data.id) {
        // Update
        const { error: updateError } = await supabase
          .from('follow_up_sequence_templates')
          .update({
            name: data.name,
            trigger: data.trigger,
            steps: data.steps,
            is_active: data.is_active,
          })
          .eq('id', data.id)

        if (updateError) throw updateError
      } else {
        // Insert
        const { error: insertError } = await supabase
          .from('follow_up_sequence_templates')
          .insert({
            venue_id: VENUE_ID,
            name: data.name,
            trigger: data.trigger,
            steps: data.steps,
            is_active: data.is_active ?? true,
          })

        if (insertError) throw insertError
      }

      setEditingTemplate(null)
      await fetchTemplates()
    } catch (err) {
      console.error('Failed to save template:', err)
    }
  }

  // ---- Toggle active ----
  const handleToggleActive = async (id: string, is_active: boolean) => {
    try {
      await supabase
        .from('follow_up_sequence_templates')
        .update({ is_active: !is_active })
        .eq('id', id)
      await fetchTemplates()
    } catch (err) {
      console.error('Failed to toggle template:', err)
    }
  }

  // ---- Enrollment actions ----
  const handleEnrollmentAction = async (
    enrollmentId: string,
    action: 'pause' | 'resume' | 'cancel'
  ) => {
    try {
      const newStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled'
      const updates: Record<string, unknown> = { status: newStatus }
      if (action === 'pause') updates.paused_at = new Date().toISOString()
      if (action === 'cancel') updates.completed_at = new Date().toISOString()
      if (action === 'resume') updates.paused_at = null
      await supabase
        .from('wedding_sequences')
        .update(updates)
        .eq('id', enrollmentId)
      await fetchEnrollments()
    } catch (err) {
      console.error('Failed to update enrollment:', err)
    }
  }

  // ---- Stats ----
  const activeTemplateCount = templates.filter((t) => t.is_active).length
  const activeEnrollments = enrollments.filter((e) => e.status === 'active').length
  const completedThisMonth = enrollments.filter((e) => {
    if (e.status !== 'completed') return false
    const d = new Date(e.created_at)
    const now = new Date()
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  }).length

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'templates', label: 'Templates' },
    { key: 'enrollments', label: 'Enrollments' },
  ]

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Sequences
          </h1>
          <p className="text-sage-600">
            Configurable follow-up sequences for automated outreach.
          </p>
        </div>
        <button
          onClick={() => setEditingTemplate('new')}
          className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          New Sequence
        </button>
      </div>

      {/* ---- Error ---- */}
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

      {/* ---- Stats ---- */}
      {!loading && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-sage-50 flex items-center justify-center">
                <Zap className="w-5 h-5 text-sage-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{activeTemplateCount}</p>
                <p className="text-xs text-sage-500">Active Templates</p>
              </div>
            </div>
          </div>
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-teal-50 flex items-center justify-center">
                <Users className="w-5 h-5 text-teal-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{activeEnrollments}</p>
                <p className="text-xs text-sage-500">Active Enrollments</p>
              </div>
            </div>
          </div>
          <div className="bg-surface border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <p className="text-2xl font-bold text-sage-900">{completedThisMonth}</p>
                <p className="text-xs text-sage-500">Completed This Month</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---- Tabs ---- */}
      <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              activeTab === tab.key
                ? 'bg-surface text-sage-900 shadow-sm'
                : 'text-sage-600 hover:text-sage-800'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ---- Templates Tab ---- */}
      {activeTab === 'templates' && (
        <>
          {loading ? (
            <CardSkeleton />
          ) : templates.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
              <ListOrdered className="w-12 h-12 text-sage-300 mx-auto mb-4" />
              <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
                No sequences yet
              </h3>
              <p className="text-sm text-sage-600 max-w-md mx-auto mb-4">
                Create follow-up sequences to automate outreach at key moments in the lead journey.
              </p>
              <button
                onClick={() => setEditingTemplate('new')}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" />
                Create First Sequence
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {templates.map((template) => {
                const trigger = triggerBadge(template.trigger)
                const isExpanded = expandedTemplateId === template.id
                const steps = template.steps as SequenceStep[] | null

                return (
                  <div
                    key={template.id}
                    className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden"
                  >
                    <div className="p-5">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-3 mb-2">
                            <h3 className="font-heading text-base font-semibold text-sage-900 truncate">
                              {template.name}
                            </h3>
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${trigger.bg} ${trigger.text}`}
                            >
                              {trigger.label}
                            </span>
                            {template.is_active ? (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-700">
                                Active
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-sage-100 text-sage-500">
                                Inactive
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-4 text-xs text-sage-500">
                            <span className="flex items-center gap-1">
                              <Mail className="w-3.5 h-3.5" />
                              {steps?.length ?? 0} step{(steps?.length ?? 0) !== 1 ? 's' : ''}
                            </span>
                            <span className="flex items-center gap-1">
                              <Clock className="w-3.5 h-3.5" />
                              {steps && steps.length > 0
                                ? `${steps[steps.length - 1].day_offset} day span`
                                : '0 days'}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => handleToggleActive(template.id, template.is_active)}
                            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                              template.is_active
                                ? 'text-amber-700 bg-amber-50 hover:bg-amber-100'
                                : 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                            }`}
                          >
                            {template.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                          <button
                            onClick={() => setEditingTemplate(template)}
                            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() =>
                              setExpandedTemplateId(isExpanded ? null : template.id)
                            }
                            className="p-1.5 rounded-lg text-sage-400 hover:text-sage-600 hover:bg-sage-50 transition-colors"
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

                    {/* Expanded steps */}
                    {isExpanded && steps && steps.length > 0 && (
                      <div className="border-t border-border bg-sage-50/50 px-5 py-4">
                        <div className="space-y-2">
                          {steps.map((step, idx) => (
                            <div
                              key={idx}
                              className="flex items-center gap-4 bg-surface rounded-lg p-3 border border-border"
                            >
                              <span className="w-7 h-7 rounded-full bg-sage-100 text-sage-600 text-xs font-bold flex items-center justify-center shrink-0">
                                {idx + 1}
                              </span>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-sage-800">
                                  Day {step.day_offset} — {step.template_type.replace(/_/g, ' ')}
                                </p>
                                {step.subject_line && (
                                  <p className="text-xs text-sage-500 truncate">
                                    Subject: {step.subject_line}
                                  </p>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* ---- Enrollments Tab ---- */}
      {activeTab === 'enrollments' && (
        <>
          {loading ? (
            <CardSkeleton />
          ) : enrollments.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 shadow-sm text-center">
              <Users className="w-12 h-12 text-sage-300 mx-auto mb-4" />
              <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">
                No active enrollments
              </h3>
              <p className="text-sm text-sage-600 max-w-md mx-auto">
                When weddings are enrolled in a sequence, they appear here with progress tracking.
              </p>
            </div>
          ) : (
            <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left px-4 py-3">
                        <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">Couple</span>
                      </th>
                      <th className="text-left px-4 py-3">
                        <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">Sequence</span>
                      </th>
                      <th className="text-left px-4 py-3">
                        <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">Step</span>
                      </th>
                      <th className="text-left px-4 py-3">
                        <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">Status</span>
                      </th>
                      <th className="text-left px-4 py-3">
                        <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">Started</span>
                      </th>
                      <th className="text-right px-4 py-3">
                        <span className="text-xs font-semibold uppercase tracking-wider text-sage-500">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {enrollments.map((enrollment) => {
                      const statusBdg = enrollmentStatusBadge(enrollment.status)
                      const tmpl = templates.find((t) => t.id === enrollment.template_id)
                      const totalSteps = (tmpl?.steps as SequenceStep[] | null)?.length ?? 0

                      return (
                        <tr key={enrollment.id} className="hover:bg-sage-50/50 transition-colors">
                          <td className="px-4 py-3">
                            <span className="text-sm font-medium text-sage-900">
                              {enrollment.couple_name}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-sm text-sage-700">
                              {enrollment.template_name}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-sm text-sage-600 tabular-nums">
                              {enrollment.current_step}/{totalSteps}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${statusBdg.bg} ${statusBdg.text}`}
                            >
                              {statusBdg.label}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-sm text-sage-600">
                              {formatDate(enrollment.enrolled_at)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-1">
                              {enrollment.status === 'active' && (
                                <button
                                  onClick={() => handleEnrollmentAction(enrollment.id, 'pause')}
                                  className="p-1.5 rounded-lg text-sage-400 hover:text-amber-600 hover:bg-amber-50 transition-colors"
                                  title="Pause"
                                >
                                  <Pause className="w-4 h-4" />
                                </button>
                              )}
                              {enrollment.status === 'paused' && (
                                <button
                                  onClick={() => handleEnrollmentAction(enrollment.id, 'resume')}
                                  className="p-1.5 rounded-lg text-sage-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
                                  title="Resume"
                                >
                                  <Play className="w-4 h-4" />
                                </button>
                              )}
                              {(enrollment.status === 'active' || enrollment.status === 'paused') && (
                                <button
                                  onClick={() => handleEnrollmentAction(enrollment.id, 'cancel')}
                                  className="p-1.5 rounded-lg text-sage-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                                  title="Cancel"
                                >
                                  <XCircle className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ---- Template Modal ---- */}
      {editingTemplate !== null && (
        <TemplateModal
          template={editingTemplate === 'new' ? null : editingTemplate}
          onClose={() => setEditingTemplate(null)}
          onSave={handleSaveTemplate}
        />
      )}
    </div>
  )
}
