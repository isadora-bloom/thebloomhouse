'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  Settings,
  Mail,
  RefreshCw,
  Shield,
  Zap,
  Clock,
  ToggleLeft,
  ToggleRight,
  Save,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  CalendarClock,
} from 'lucide-react'

// TODO: Replace with venue from auth context
const VENUE_ID = '22222222-2222-2222-2222-222222222201'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutoSendRule {
  id: string
  venue_id: string
  context: 'inquiry' | 'client'
  source: string
  enabled: boolean
  confidence_threshold: number
  daily_limit: number
  require_new_contact: boolean
}

interface EmailSyncState {
  id: string
  venue_id: string
  last_history_id: string | null
  last_sync_at: string | null
  status: string
  error_message: string | null
}

interface VenueAIConfig {
  id: string
  venue_id: string
  follow_up_style: string
  max_follow_ups: number
}

type TabKey = 'auto-send' | 'gmail' | 'follow-ups'

const SOURCES = [
  { value: 'all', label: 'All Sources' },
  { value: 'the_knot', label: 'The Knot' },
  { value: 'weddingwire', label: 'WeddingWire' },
  { value: 'zola', label: 'Zola' },
  { value: 'google', label: 'Google' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'website', label: 'Website' },
  { value: 'referral', label: 'Referral' },
  { value: 'direct', label: 'Direct' },
]

const FOLLOW_UP_STYLES = [
  { value: 'aggressive', label: 'Aggressive', desc: 'Follow up quickly, more reminders' },
  { value: 'moderate', label: 'Moderate', desc: 'Balanced pacing, standard cadence' },
  { value: 'gentle', label: 'Gentle', desc: 'Patient pacing, fewer touchpoints' },
  { value: 'minimal', label: 'Minimal', desc: 'Only follow up when critical' },
]

const FOLLOW_UP_INTERVALS: Record<string, number[]> = {
  aggressive: [1, 3, 5, 7],
  moderate: [3, 7, 14],
  gentle: [5, 14, 28],
  minimal: [7, 21],
}

const inputClasses =
  'w-full border border-border rounded-lg px-3 py-2 text-sage-900 bg-warm-white focus:ring-2 focus:ring-sage-300 focus:border-sage-500 outline-none transition-colors text-sm'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSyncTime(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const d = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function AutoSendRuleCard({
  rule,
  onToggle,
  onUpdate,
}: {
  rule: AutoSendRule
  onToggle: () => void
  onUpdate: (field: keyof AutoSendRule, value: number | boolean | string) => void
}) {
  const sourceLabel = SOURCES.find((s) => s.value === rule.source)?.label ?? rule.source

  return (
    <div className={`bg-surface border rounded-xl p-5 transition-all ${rule.enabled ? 'border-sage-300 shadow-sm' : 'border-border opacity-75'}`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
            rule.context === 'inquiry'
              ? 'bg-teal-50 text-teal-700'
              : 'bg-sage-50 text-sage-700'
          }`}>
            {rule.context === 'inquiry' ? 'Inquiry' : 'Client'}
          </span>
          <span className="text-sm font-medium text-sage-800">{sourceLabel}</span>
        </div>
        <button onClick={onToggle} className="text-sage-500 hover:text-sage-700 transition-colors">
          {rule.enabled ? (
            <ToggleRight className="w-8 h-8 text-sage-500" />
          ) : (
            <ToggleLeft className="w-8 h-8 text-sage-300" />
          )}
        </button>
      </div>

      {rule.enabled && (
        <div className="space-y-4 pt-2 border-t border-border">
          {/* Confidence Threshold */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm font-medium text-sage-700">Confidence Threshold</label>
              <span className="text-sm font-semibold text-sage-900 tabular-nums">
                {Math.round(rule.confidence_threshold * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={50}
              max={100}
              step={5}
              value={Math.round(rule.confidence_threshold * 100)}
              onChange={(e) => onUpdate('confidence_threshold', parseInt(e.target.value) / 100)}
              className="w-full h-2 bg-sage-100 rounded-full appearance-none cursor-pointer accent-sage-500"
            />
            <div className="flex justify-between text-[10px] text-sage-400 mt-0.5">
              <span>50%</span>
              <span>75%</span>
              <span>100%</span>
            </div>
          </div>

          {/* Daily Limit */}
          <div>
            <label className="block text-sm font-medium text-sage-700 mb-1">Daily Limit</label>
            <input
              type="number"
              min={1}
              max={50}
              value={rule.daily_limit}
              onChange={(e) => onUpdate('daily_limit', parseInt(e.target.value) || 1)}
              className={inputClasses + ' max-w-[120px]'}
            />
            <p className="text-xs text-sage-400 mt-1">Max auto-sent emails per day for this rule</p>
          </div>

          {/* Require New Contact */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-sage-700">Require New Contact</p>
              <p className="text-xs text-sage-400">Only auto-send for contacts we haven&apos;t emailed before</p>
            </div>
            <button
              onClick={() => onUpdate('require_new_contact', !rule.require_new_contact)}
              className="text-sage-500 hover:text-sage-700 transition-colors"
            >
              {rule.require_new_contact ? (
                <ToggleRight className="w-7 h-7 text-sage-500" />
              ) : (
                <ToggleLeft className="w-7 h-7 text-sage-300" />
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AgentSettingsPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('auto-send')
  const [rules, setRules] = useState<AutoSendRule[]>([])
  const [syncState, setSyncState] = useState<EmailSyncState | null>(null)
  const [aiConfig, setAiConfig] = useState<VenueAIConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  const supabase = createClient()

  // ---- Fetch all data ----
  const fetchData = useCallback(async () => {
    const [rulesRes, syncRes, aiRes] = await Promise.all([
      supabase
        .from('auto_send_rules')
        .select('*')
        .eq('venue_id', VENUE_ID)
        .order('context', { ascending: true })
        .order('source', { ascending: true }),
      supabase
        .from('email_sync_state')
        .select('*')
        .eq('venue_id', VENUE_ID)
        .maybeSingle(),
      supabase
        .from('venue_ai_config')
        .select('id, venue_id, follow_up_style, max_follow_ups')
        .eq('venue_id', VENUE_ID)
        .maybeSingle(),
    ])

    if (rulesRes.data) setRules(rulesRes.data as AutoSendRule[])
    if (syncRes.data) setSyncState(syncRes.data as EmailSyncState)
    if (aiRes.data) setAiConfig(aiRes.data as VenueAIConfig)
    setLoading(false)
  }, [supabase])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Toggle a rule ----
  function toggleRule(id: string) {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    )
  }

  // ---- Update a rule field ----
  function updateRule(id: string, field: keyof AutoSendRule, value: number | boolean | string) {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: value } : r))
    )
  }

  // ---- Save rules ----
  async function saveRules() {
    setSaving(true)
    setSaveMessage(null)

    let hasError = false
    for (const rule of rules) {
      const { error } = await supabase
        .from('auto_send_rules')
        .update({
          enabled: rule.enabled,
          confidence_threshold: rule.confidence_threshold,
          daily_limit: rule.daily_limit,
          require_new_contact: rule.require_new_contact,
        })
        .eq('id', rule.id)

      if (error) {
        hasError = true
        console.error('Failed to save rule:', error)
      }
    }

    setSaveMessage(hasError ? 'Some rules failed to save.' : 'Auto-send rules saved.')
    setSaving(false)
    setTimeout(() => setSaveMessage(null), 3000)
  }

  // ---- Save follow-up config ----
  async function saveFollowUpConfig() {
    if (!aiConfig) return
    setSaving(true)
    setSaveMessage(null)

    const { error } = await supabase
      .from('venue_ai_config')
      .update({
        follow_up_style: aiConfig.follow_up_style,
        max_follow_ups: aiConfig.max_follow_ups,
        updated_at: new Date().toISOString(),
      })
      .eq('id', aiConfig.id)

    setSaveMessage(error ? 'Failed to save follow-up settings.' : 'Follow-up settings saved.')
    setSaving(false)
    setTimeout(() => setSaveMessage(null), 3000)
  }

  // ---- Trigger email sync ----
  async function triggerSync() {
    setSyncing(true)
    try {
      const res = await fetch('/api/agent/sync', { method: 'POST' })
      if (!res.ok) throw new Error('Sync failed')
      // Re-fetch sync state
      const { data } = await supabase
        .from('email_sync_state')
        .select('*')
        .eq('venue_id', VENUE_ID)
        .maybeSingle()
      if (data) setSyncState(data as EmailSyncState)
    } catch (err) {
      console.error('Email sync failed:', err)
    } finally {
      setSyncing(false)
    }
  }

  // ---- Tabs ----
  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'auto-send', label: 'Auto-Send Rules', icon: <Zap className="w-4 h-4" /> },
    { key: 'gmail', label: 'Gmail Connection', icon: <Mail className="w-4 h-4" /> },
    { key: 'follow-ups', label: 'Follow-Up Sequences', icon: <CalendarClock className="w-4 h-4" /> },
  ]

  const gmailConnected = syncState !== null && syncState.status !== 'disconnected'

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse space-y-4">
          <div className="h-10 w-64 bg-sage-100 rounded-lg" />
          <div className="h-5 w-96 bg-sage-50 rounded" />
          <div className="h-12 bg-sage-50 rounded-lg" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-48 bg-sage-50 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1 flex items-center gap-3">
          <Settings className="w-8 h-8 text-sage-500" />
          Agent Settings
        </h1>
        <p className="text-sage-600">
          Configure auto-send rules, email sync, and follow-up sequences.
        </p>
      </div>

      {/* Save feedback */}
      {saveMessage && (
        <div className={`px-4 py-2.5 rounded-lg text-sm font-medium ${
          saveMessage.includes('Failed') || saveMessage.includes('failed')
            ? 'bg-red-50 text-red-700 border border-red-200'
            : 'bg-green-50 text-green-700 border border-green-200'
        }`}>
          {saveMessage}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
              activeTab === tab.key
                ? 'bg-surface text-sage-900 shadow-sm'
                : 'text-sage-600 hover:text-sage-800'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ================================================================== */}
      {/* Auto-Send Rules Tab                                                 */}
      {/* ================================================================== */}
      {activeTab === 'auto-send' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-heading text-xl font-semibold text-sage-900">Auto-Send Rules</h2>
              <p className="text-sm text-sage-500 mt-1">
                Control when the Agent sends emails without coordinator approval.
              </p>
            </div>
            <button
              onClick={saveRules}
              disabled={saving}
              className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2.5 transition-colors text-sm"
            >
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Rules'}
            </button>
          </div>

          {/* Safety notice */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
            <Shield className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-800">Safety checks always apply</p>
              <p className="text-xs text-amber-600 mt-1">
                Even when auto-send is enabled, emails are blocked if escalation keywords are detected,
                confidence is below threshold, or daily limits are reached. You can always review sent emails in the Inbox.
              </p>
            </div>
          </div>

          {rules.length === 0 ? (
            <div className="bg-surface border border-border rounded-xl p-12 text-center">
              <Zap className="w-12 h-12 text-sage-300 mx-auto mb-4" />
              <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">No auto-send rules configured</h3>
              <p className="text-sm text-sage-500 max-w-md mx-auto">
                Auto-send rules are created during onboarding or via the database.
                They allow the Agent to send responses automatically based on context and source.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {rules.map((rule) => (
                <AutoSendRuleCard
                  key={rule.id}
                  rule={rule}
                  onToggle={() => toggleRule(rule.id)}
                  onUpdate={(field, value) => updateRule(rule.id, field, value)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ================================================================== */}
      {/* Gmail Connection Tab                                                */}
      {/* ================================================================== */}
      {activeTab === 'gmail' && (
        <div className="space-y-6">
          <div>
            <h2 className="font-heading text-xl font-semibold text-sage-900">Gmail Connection</h2>
            <p className="text-sm text-sage-500 mt-1">
              Manage your Gmail integration for email sync and sending.
            </p>
          </div>

          {/* Connection Status Card */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <div className={`p-3 rounded-xl ${gmailConnected ? 'bg-green-50' : 'bg-red-50'}`}>
                <Mail className={`w-6 h-6 ${gmailConnected ? 'text-green-600' : 'text-red-500'}`} />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-heading text-lg font-semibold text-sage-900">Gmail</h3>
                  {gmailConnected ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700">
                      <CheckCircle2 className="w-3 h-3" />
                      Connected
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
                      <XCircle className="w-3 h-3" />
                      Not Connected
                    </span>
                  )}
                </div>

                {syncState && (
                  <div className="space-y-1.5 text-sm text-sage-600 mt-2">
                    <p className="flex items-center gap-2">
                      <Clock className="w-3.5 h-3.5 text-sage-400" />
                      Last sync: {formatSyncTime(syncState.last_sync_at)}
                    </p>
                    {syncState.status && (
                      <p className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${
                          syncState.status === 'synced' ? 'bg-green-400' :
                          syncState.status === 'syncing' ? 'bg-amber-400 animate-pulse' :
                          syncState.status === 'error' ? 'bg-red-400' : 'bg-sage-300'
                        }`} />
                        Status: <span className="capitalize">{syncState.status}</span>
                      </p>
                    )}
                    {syncState.error_message && (
                      <div className="flex items-start gap-2 mt-2 bg-red-50 border border-red-200 rounded-lg p-3">
                        <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                        <p className="text-xs text-red-700">{syncState.error_message}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3 mt-6 pt-4 border-t border-border">
              <button
                onClick={triggerSync}
                disabled={syncing || !gmailConnected}
                className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg px-5 py-2.5 transition-colors text-sm"
              >
                <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Syncing...' : 'Sync Now'}
              </button>

              {!gmailConnected && (
                <a
                  href="/api/auth/gmail"
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg px-5 py-2.5 transition-colors text-sm"
                >
                  <Mail className="w-4 h-4" />
                  Connect Gmail
                </a>
              )}
            </div>
          </div>

          {/* Sync info */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h3 className="font-heading text-lg font-semibold text-sage-900 mb-3">How Email Sync Works</h3>
            <ul className="space-y-3 text-sm text-sage-600">
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 bg-sage-100 rounded-full flex items-center justify-center text-xs font-bold text-sage-700 shrink-0 mt-0.5">1</span>
                The Agent polls Gmail every 5 minutes for new messages via Edge Functions.
              </li>
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 bg-sage-100 rounded-full flex items-center justify-center text-xs font-bold text-sage-700 shrink-0 mt-0.5">2</span>
                New emails are classified as inquiry or client, then matched to existing contacts.
              </li>
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 bg-sage-100 rounded-full flex items-center justify-center text-xs font-bold text-sage-700 shrink-0 mt-0.5">3</span>
                AI generates a draft response, which goes to your approval queue (or auto-sends if rules allow).
              </li>
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 bg-sage-100 rounded-full flex items-center justify-center text-xs font-bold text-sage-700 shrink-0 mt-0.5">4</span>
                Use the &quot;Sync Now&quot; button to trigger an immediate sync outside the 5-minute cycle.
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* ================================================================== */}
      {/* Follow-Up Sequences Tab                                             */}
      {/* ================================================================== */}
      {activeTab === 'follow-ups' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-heading text-xl font-semibold text-sage-900">Follow-Up Sequences</h2>
              <p className="text-sm text-sage-500 mt-1">
                Configure how the Agent follows up with leads who haven&apos;t responded.
              </p>
            </div>
            <button
              onClick={saveFollowUpConfig}
              disabled={saving || !aiConfig}
              className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2.5 transition-colors text-sm"
            >
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>

          {!aiConfig ? (
            <div className="bg-surface border border-border rounded-xl p-12 text-center">
              <CalendarClock className="w-12 h-12 text-sage-300 mx-auto mb-4" />
              <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">No AI configuration found</h3>
              <p className="text-sm text-sage-500">Complete venue onboarding to configure follow-up sequences.</p>
            </div>
          ) : (
            <>
              {/* Style selector */}
              <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-5">
                <h3 className="font-heading text-lg font-semibold text-sage-900">Follow-Up Style</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {FOLLOW_UP_STYLES.map((style) => {
                    const isSelected = aiConfig.follow_up_style === style.value
                    return (
                      <button
                        key={style.value}
                        onClick={() => setAiConfig({ ...aiConfig, follow_up_style: style.value })}
                        className={`text-left p-4 rounded-xl border-2 transition-all ${
                          isSelected
                            ? 'border-sage-500 bg-sage-50'
                            : 'border-border hover:border-sage-300'
                        }`}
                      >
                        <p className={`text-sm font-semibold ${isSelected ? 'text-sage-900' : 'text-sage-700'}`}>
                          {style.label}
                        </p>
                        <p className="text-xs text-sage-500 mt-1">{style.desc}</p>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Intervals preview */}
              <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-4">
                <h3 className="font-heading text-lg font-semibold text-sage-900">Sequence Timeline</h3>
                <p className="text-sm text-sage-500">
                  Based on your selected style, leads will receive follow-ups at these intervals after the initial response:
                </p>
                <div className="flex items-center gap-3 flex-wrap">
                  {(FOLLOW_UP_INTERVALS[aiConfig.follow_up_style] ?? [3, 7, 14]).map((days, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      {idx > 0 && <div className="w-8 h-0.5 bg-sage-200" />}
                      <div className="bg-sage-100 rounded-lg px-4 py-2.5 text-center">
                        <p className="text-lg font-bold text-sage-900 tabular-nums">{days}</p>
                        <p className="text-[10px] text-sage-500 uppercase tracking-wider">day{days !== 1 ? 's' : ''}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Max follow-ups */}
              <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-4">
                <h3 className="font-heading text-lg font-semibold text-sage-900">Maximum Follow-Ups</h3>
                <p className="text-sm text-sage-500">
                  After this many follow-ups without a response, the lead will be marked as cold.
                </p>
                <div className="flex items-center gap-4">
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={aiConfig.max_follow_ups}
                    onChange={(e) =>
                      setAiConfig({ ...aiConfig, max_follow_ups: parseInt(e.target.value) || 1 })
                    }
                    className={inputClasses + ' max-w-[100px]'}
                  />
                  <span className="text-sm text-sage-600">follow-up emails maximum</span>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
