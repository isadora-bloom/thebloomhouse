'use client'

import { useState, useEffect, useCallback } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
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
  Activity,
  Inbox,
  Trash2,
  Star,
  Pencil,
  Check,
  Plus,
  User,
} from 'lucide-react'

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
  { value: 'wedding_wire', label: 'WeddingWire' },
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
  const VENUE_ID = useVenueId()
  const [activeTab, setActiveTab] = useState<TabKey>('auto-send')
  const [rules, setRules] = useState<AutoSendRule[]>([])
  const [syncState, setSyncState] = useState<EmailSyncState | null>(null)
  const [aiConfig, setAiConfig] = useState<VenueAIConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [emailsSynced7d, setEmailsSynced7d] = useState<number>(0)

  // Gmail connection state (from API, not just sync state)
  const [gmailStatus, setGmailStatus] = useState<{ connected: boolean; email?: string } | null>(null)
  const [gmailConnecting, setGmailConnecting] = useState(false)
  const [gmailConnections, setGmailConnections] = useState<Array<{
    id: string; emailAddress: string; isPrimary: boolean; label: string | null;
    syncEnabled: boolean; lastSyncAt: string | null; status: string;
    errorMessage: string | null; userId: string | null; userName: string | null;
  }>>([])
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const [labelDraft, setLabelDraft] = useState('')

  const supabase = createClient()

  // ---- Fetch all data ----
  const fetchData = useCallback(async () => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const [rulesRes, syncRes, aiRes, syncedRes] = await Promise.all([
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
      supabase
        .from('interactions')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', VENUE_ID)
        .gte('created_at', sevenDaysAgo),
    ])

    if (rulesRes.data) setRules(rulesRes.data as AutoSendRule[])
    if (syncRes.data) setSyncState(syncRes.data as EmailSyncState)
    if (aiRes.data) setAiConfig(aiRes.data as VenueAIConfig)
    setEmailsSynced7d(syncedRes.count ?? 0)
    setLoading(false)
  }, [supabase, VENUE_ID])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ---- Gmail status check ----
  const fetchGmailStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/gmail')
      if (res.ok) {
        const data = await res.json()
        setGmailStatus({ connected: data.connected, email: data.email })
        if (data.connections) {
          setGmailConnections(data.connections)
        }
      }
    } catch {
      // Silently fail
    }
  }, [])

  useEffect(() => {
    fetchGmailStatus()
  }, [fetchGmailStatus])

  // ---- Gmail OAuth callback result handler ----
  // The new /api/auth/gmail flow redirects back with ?gmail=connected or
  // ?gmail=error&reason=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const gmail = params.get('gmail')
    if (!gmail) return

    if (gmail === 'connected') {
      const email = params.get('email') ?? undefined
      setGmailStatus({ connected: true, email })
      setSaveMessage('Gmail connected successfully.')
      setTimeout(() => setSaveMessage(null), 3000)
      fetchData()
      fetchGmailStatus()
    } else if (gmail === 'error') {
      const reason = params.get('reason') || 'unknown'
      const friendly: Record<string, string> = {
        access_denied: 'You declined Google access.',
        not_configured: 'Gmail integration is not configured.',
        bad_state: 'Security check failed. Please try again.',
        no_refresh_token: 'Google did not return a refresh token. Remove Bloom from your Google account permissions and try again.',
        token_exchange_failed: 'Google rejected the authorization code.',
        db_write_failed: 'Could not save your Gmail connection.',
        auth_mismatch: 'Session mismatch. Please sign in again and retry.',
      }
      setSaveMessage(friendly[reason] || `Failed to connect Gmail (${reason}).`)
      setTimeout(() => setSaveMessage(null), 5000)
    }

    // Clean URL
    window.history.replaceState({}, '', '/agent/settings')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Gmail connect ----
  // Redirects through /api/auth/gmail which handles OAuth + CSRF state.
  function connectGmail() {
    setGmailConnecting(true)
    const returnTo = '/agent/settings'
    window.location.href = `/api/auth/gmail?returnTo=${encodeURIComponent(returnTo)}`
  }

  // ---- Gmail disconnect (all or specific connection) ----
  async function disconnectGmail(connectionId?: string) {
    setGmailConnecting(true)
    try {
      // New per-connection disconnect path that revokes the Google token
      if (connectionId) {
        const res = await fetch('/api/auth/gmail/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ connectionId }),
        })
        const data = await res.json()
        if (data.ok) {
          setSaveMessage('Gmail disconnected successfully.')
          setTimeout(() => setSaveMessage(null), 3000)
          fetchGmailStatus()
          fetchData()
        } else {
          setSaveMessage(data.reason || 'Failed to disconnect Gmail.')
          setTimeout(() => setSaveMessage(null), 3000)
        }
        return
      }

      // No specific connection → disconnect all via legacy endpoint
      const res = await fetch('/api/agent/gmail', { method: 'DELETE' })
      const data = await res.json()
      if (data.success) {
        setGmailStatus({ connected: false })
        setGmailConnections([])
        setSyncState(null)
        setSaveMessage('Gmail disconnected successfully.')
        setTimeout(() => setSaveMessage(null), 3000)
        fetchGmailStatus()
        fetchData()
      } else {
        setSaveMessage(data.error || 'Failed to disconnect Gmail.')
        setTimeout(() => setSaveMessage(null), 3000)
      }
    } catch {
      setSaveMessage('Failed to disconnect Gmail.')
      setTimeout(() => setSaveMessage(null), 3000)
    } finally {
      setGmailConnecting(false)
    }
  }

  // ---- Set connection as primary ----
  async function setPrimary(connectionId: string) {
    try {
      const res = await fetch('/api/agent/gmail', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId, isPrimary: true }),
      })
      if (res.ok) {
        fetchGmailStatus()
        setSaveMessage('Primary inbox updated.')
        setTimeout(() => setSaveMessage(null), 3000)
      }
    } catch {
      setSaveMessage('Failed to update primary inbox.')
      setTimeout(() => setSaveMessage(null), 3000)
    }
  }

  // ---- Update connection label ----
  async function saveLabel(connectionId: string) {
    try {
      const res = await fetch('/api/agent/gmail', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId, label: labelDraft }),
      })
      if (res.ok) {
        setEditingLabel(null)
        fetchGmailStatus()
      }
    } catch {
      // Silently fail
    }
  }

  // ---- Toggle sync ----
  async function toggleSync(connectionId: string, currentlyEnabled: boolean) {
    try {
      const res = await fetch('/api/agent/gmail', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId, syncEnabled: !currentlyEnabled }),
      })
      if (res.ok) {
        fetchGmailStatus()
      }
    } catch {
      // Silently fail
    }
  }

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

  const gmailConnected = gmailStatus?.connected ?? (syncState !== null && syncState.status !== 'disconnected')

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
          Configure your AI agent&apos;s email connection, auto-send thresholds, and operational preferences. Changes here affect how the agent handles all incoming and outgoing communications.
        </p>
      </div>

      {/* Email Health Card */}
      {(() => {
        const connected = gmailStatus?.connected ?? (syncState !== null && syncState.status !== 'disconnected')
        const hasError = !!syncState?.error_message
        const status: 'green' | 'amber' | 'red' = !connected
          ? 'red'
          : hasError
            ? 'red'
            : syncState?.status === 'syncing'
              ? 'amber'
              : 'green'
        const statusColors = {
          green: 'border-emerald-200 bg-emerald-50/30',
          amber: 'border-amber-200 bg-amber-50/30',
          red: 'border-red-200 bg-red-50/30',
        }
        const dotColors = {
          green: 'bg-emerald-400',
          amber: 'bg-amber-400 animate-pulse',
          red: 'bg-red-400',
        }
        const statusLabels = {
          green: 'Healthy',
          amber: 'Syncing',
          red: connected ? 'Error' : 'Disconnected',
        }
        return (
          <div className={`border rounded-xl p-4 ${statusColors[status]}`}>
            <div className="flex items-center gap-4 flex-wrap">
              {/* Status indicator */}
              <div className="flex items-center gap-2 min-w-[140px]">
                <Activity className={`w-4 h-4 ${status === 'green' ? 'text-emerald-600' : status === 'amber' ? 'text-amber-600' : 'text-red-500'}`} />
                <div className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${dotColors[status]}`} />
                  <span className={`text-sm font-semibold ${status === 'green' ? 'text-emerald-700' : status === 'amber' ? 'text-amber-700' : 'text-red-700'}`}>
                    {statusLabels[status]}
                  </span>
                </div>
              </div>

              {/* Gmail connection */}
              <div className="flex items-center gap-1.5 text-sm text-sage-600">
                <Mail className="w-3.5 h-3.5 text-sage-400" />
                <span>{connected ? 'Gmail Connected' : 'Gmail Not Connected'}</span>
              </div>

              {/* Last sync */}
              <div className="flex items-center gap-1.5 text-sm text-sage-600">
                <Clock className="w-3.5 h-3.5 text-sage-400" />
                <span>Last sync: {formatSyncTime(syncState?.last_sync_at ?? null)}</span>
              </div>

              {/* Emails synced 7d */}
              <div className="flex items-center gap-1.5 text-sm text-sage-600">
                <Inbox className="w-3.5 h-3.5 text-sage-400" />
                <span>{emailsSynced7d} emails synced (7d)</span>
              </div>

              {/* Error message */}
              {hasError && (
                <div className="flex items-center gap-1.5 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate max-w-[300px]">{syncState?.error_message}</span>
                </div>
              )}
            </div>
          </div>
        )
      })()}

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
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-heading text-xl font-semibold text-sage-900">Gmail Connections</h2>
              <p className="text-sm text-sage-500 mt-1">
                Connect one or more Gmail accounts. Each account syncs independently and can be labeled.
              </p>
            </div>
            <button
              onClick={connectGmail}
              disabled={gmailConnecting}
              className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 text-white font-medium rounded-lg px-5 py-2.5 transition-colors text-sm"
            >
              {gmailConnecting ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              {gmailConnecting ? 'Connecting...' : 'Connect Gmail Account'}
            </button>
          </div>

          {/* Connection List */}
          {gmailConnections.length > 0 ? (
            <div className="space-y-3">
              {gmailConnections.map((conn) => (
                <div
                  key={conn.id}
                  className={`bg-surface border rounded-xl p-5 shadow-sm transition-all ${
                    conn.status === 'error' ? 'border-red-200' :
                    conn.isPrimary ? 'border-sage-300' : 'border-border'
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div className={`p-2.5 rounded-xl ${
                        conn.status === 'active' ? 'bg-green-50' :
                        conn.status === 'error' ? 'bg-red-50' : 'bg-sage-50'
                      }`}>
                        <Mail className={`w-5 h-5 ${
                          conn.status === 'active' ? 'text-green-600' :
                          conn.status === 'error' ? 'text-red-500' : 'text-sage-400'
                        }`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sage-900 text-sm truncate">{conn.emailAddress}</span>
                          {conn.isPrimary && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                              <Star className="w-2.5 h-2.5" />
                              Primary
                            </span>
                          )}
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            conn.status === 'active' ? 'bg-green-50 text-green-700' :
                            conn.status === 'error' ? 'bg-red-50 text-red-700' : 'bg-sage-50 text-sage-600'
                          }`}>
                            {conn.status === 'active' ? 'Active' : conn.status === 'error' ? 'Error' : 'Disconnected'}
                          </span>
                        </div>

                        {/* Label */}
                        <div className="mt-1 flex items-center gap-2">
                          {editingLabel === conn.id ? (
                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                value={labelDraft}
                                onChange={(e) => setLabelDraft(e.target.value)}
                                placeholder="e.g. Inquiry inbox"
                                className={inputClasses + ' max-w-[200px] text-xs py-1'}
                                autoFocus
                                onKeyDown={(e) => { if (e.key === 'Enter') saveLabel(conn.id) }}
                              />
                              <button onClick={() => saveLabel(conn.id)} className="p-1 text-sage-500 hover:text-sage-700">
                                <Check className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => setEditingLabel(null)} className="p-1 text-sage-400 hover:text-sage-600">
                                <XCircle className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => { setEditingLabel(conn.id); setLabelDraft(conn.label || '') }}
                              className="flex items-center gap-1 text-xs text-sage-500 hover:text-sage-700 transition-colors"
                            >
                              <Pencil className="w-3 h-3" />
                              {conn.label || 'Add label'}
                            </button>
                          )}
                        </div>

                        {/* Meta */}
                        <div className="flex items-center gap-4 mt-2 text-xs text-sage-500">
                          {conn.userName && (
                            <span className="flex items-center gap-1">
                              <User className="w-3 h-3" />
                              {conn.userName}
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            Last sync: {formatSyncTime(conn.lastSyncAt)}
                          </span>
                        </div>

                        {/* Error */}
                        {conn.errorMessage && (
                          <div className="mt-2 flex items-start gap-1.5 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                            <span className="truncate">{conn.errorMessage}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 shrink-0">
                      {/* Toggle sync */}
                      <button
                        onClick={() => toggleSync(conn.id, conn.syncEnabled)}
                        className="text-sage-500 hover:text-sage-700 transition-colors"
                        title={conn.syncEnabled ? 'Disable sync' : 'Enable sync'}
                      >
                        {conn.syncEnabled ? (
                          <ToggleRight className="w-7 h-7 text-sage-500" />
                        ) : (
                          <ToggleLeft className="w-7 h-7 text-sage-300" />
                        )}
                      </button>

                      {/* Set as primary */}
                      {!conn.isPrimary && (
                        <button
                          onClick={() => setPrimary(conn.id)}
                          className="p-1.5 rounded-lg text-sage-400 hover:text-amber-500 hover:bg-amber-50 transition-colors"
                          title="Set as primary"
                        >
                          <Star className="w-4 h-4" />
                        </button>
                      )}

                      {/* Disconnect */}
                      <button
                        onClick={() => disconnectGmail(conn.id)}
                        className="p-1.5 rounded-lg text-sage-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                        title="Disconnect this account"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : !gmailConnected ? (
            <div className="bg-surface border border-border rounded-xl p-12 text-center">
              <Mail className="w-12 h-12 text-sage-300 mx-auto mb-4" />
              <h3 className="font-heading text-lg font-semibold text-sage-900 mb-1">No Gmail accounts connected</h3>
              <p className="text-sm text-sage-500 max-w-md mx-auto">
                Connect a Gmail account to start syncing emails. You can connect multiple accounts for different coordinators or inboxes.
              </p>
            </div>
          ) : (
            /* Legacy single connection (no gmail_connections rows yet) */
            <div className="bg-surface border border-sage-300 rounded-xl p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-xl bg-green-50">
                  <Mail className="w-5 h-5 text-green-600" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sage-900 text-sm">{gmailStatus?.email || 'Connected'}</span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                      <Star className="w-2.5 h-2.5" />
                      Primary
                    </span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-50 text-green-700">Active</span>
                  </div>
                  <p className="text-xs text-sage-500 mt-1">Legacy connection. Connect another Gmail to migrate to the new multi-account system.</p>
                </div>
                <button
                  onClick={() => disconnectGmail()}
                  className="p-1.5 rounded-lg text-sage-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                  title="Disconnect"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Sync actions */}
          <div className="flex items-center gap-3">
            <button
              onClick={triggerSync}
              disabled={syncing || !gmailConnected}
              className="flex items-center gap-2 bg-sage-500 hover:bg-sage-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg px-5 py-2.5 transition-colors text-sm"
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing...' : 'Sync All Now'}
            </button>
          </div>

          {/* Sync info */}
          <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
            <h3 className="font-heading text-lg font-semibold text-sage-900 mb-3">How Email Sync Works</h3>
            <ul className="space-y-3 text-sm text-sage-600">
              <li className="flex items-start gap-3">
                <span className="w-6 h-6 bg-sage-100 rounded-full flex items-center justify-center text-xs font-bold text-sage-700 shrink-0 mt-0.5">1</span>
                The Agent polls all connected Gmail accounts every 5 minutes for new messages.
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
                Each email is tagged with which Gmail account it came from, for coordinator attribution.
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
