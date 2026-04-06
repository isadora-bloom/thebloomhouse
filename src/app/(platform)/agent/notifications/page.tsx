'use client'

import { useState, useEffect, useCallback } from 'react'
import { useVenueId } from '@/lib/hooks/use-venue-id'
import { createClient } from '@/lib/supabase/client'
import {
  Bell,
  Mail,
  Smartphone,
  Monitor,
  Save,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Flame,
  Calendar,
  FileCheck,
  Send,
  TrendingUp,
  ShieldAlert,
  Newspaper,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NotificationSetting {
  key: string
  label: string
  description: string
  icon: typeof Bell
  in_app: boolean
  email: boolean
  push: boolean
}

interface RecentNotification {
  id: string
  type: string
  title: string
  body: string | null
  read: boolean
  created_at: string
}

const DEFAULT_NOTIFICATION_SETTINGS: NotificationSetting[] = [
  {
    key: 'new_inquiry',
    label: 'New Inquiry Received',
    description: 'When a new wedding inquiry arrives',
    icon: Mail,
    in_app: true,
    email: true,
    push: true,
  },
  {
    key: 'draft_pending',
    label: 'Draft Pending Approval',
    description: 'When Sage generates a draft that needs your review',
    icon: FileCheck,
    in_app: true,
    email: true,
    push: true,
  },
  {
    key: 'auto_send',
    label: 'Auto-Send Completed',
    description: 'When an email is automatically sent on your behalf',
    icon: Send,
    in_app: true,
    email: false,
    push: false,
  },
  {
    key: 'tour_scheduled',
    label: 'Tour Scheduled',
    description: 'When a new tour is booked',
    icon: Calendar,
    in_app: true,
    email: true,
    push: true,
  },
  {
    key: 'wedding_this_week',
    label: 'Wedding This Week',
    description: 'Reminder for weddings happening in the next 7 days',
    icon: Flame,
    in_app: true,
    email: true,
    push: false,
  },
  {
    key: 'anomaly_detected',
    label: 'Anomaly Detected',
    description: 'When intelligence detects something unusual (review spike, etc.)',
    icon: ShieldAlert,
    in_app: true,
    email: true,
    push: true,
  },
  {
    key: 'hold_expiring',
    label: 'Hold Expiring',
    description: 'When a date hold is about to expire',
    icon: Clock,
    in_app: true,
    email: true,
    push: true,
  },
  {
    key: 'digest_ready',
    label: 'Digest Ready',
    description: 'When the daily/weekly digest briefing is ready',
    icon: Newspaper,
    in_app: true,
    email: true,
    push: false,
  },
]

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function SettingsSkeleton() {
  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="divide-y divide-border">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="p-5">
            <div className="animate-pulse flex items-center gap-4">
              <div className="h-10 w-10 bg-sage-100 rounded-lg" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-40 bg-sage-100 rounded" />
                <div className="h-3 w-64 bg-sage-50 rounded" />
              </div>
              <div className="flex gap-6">
                <div className="h-5 w-5 bg-sage-100 rounded" />
                <div className="h-5 w-5 bg-sage-100 rounded" />
                <div className="h-5 w-5 bg-sage-100 rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function NotificationsPage() {
  const VENUE_ID = useVenueId()
  const [settings, setSettings] = useState<NotificationSetting[]>(DEFAULT_NOTIFICATION_SETTINGS)
  const [recentNotifications, setRecentNotifications] = useState<RecentNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pushSupported, setPushSupported] = useState(false)
  const [pushRegistered, setPushRegistered] = useState(false)

  const supabase = createClient()

  // ---- Load settings from venue_config ----
  const fetchSettings = useCallback(async () => {
    try {
      const { data: config } = await supabase
        .from('venue_config')
        .select('feature_flags')
        .eq('venue_id', VENUE_ID)
        .maybeSingle()

      if (config?.feature_flags?.notification_settings) {
        const saved = config.feature_flags.notification_settings as Record<
          string,
          { in_app: boolean; email: boolean; push: boolean }
        >
        setSettings((prev) =>
          prev.map((s) =>
            saved[s.key]
              ? { ...s, in_app: saved[s.key].in_app, email: saved[s.key].email, push: saved[s.key].push }
              : s
          )
        )
      }

      // Check push support
      if (typeof window !== 'undefined' && 'Notification' in window) {
        setPushSupported(true)
        setPushRegistered(Notification.permission === 'granted')
      }

      // Fetch recent notifications
      const { data: notifs } = await supabase
        .from('notifications')
        .select('*')
        .eq('venue_id', VENUE_ID)
        .order('created_at', { ascending: false })
        .limit(20)

      setRecentNotifications(notifs ?? [])
      setError(null)
    } catch (err) {
      console.error('Failed to load notification settings:', err)
      setError('Failed to load notification settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  // ---- Toggle handler ----
  const toggleSetting = (key: string, channel: 'in_app' | 'email' | 'push') => {
    setSettings((prev) =>
      prev.map((s) =>
        s.key === key ? { ...s, [channel]: !s[channel] } : s
      )
    )
    setSaved(false)
  }

  // ---- Save settings ----
  const handleSave = async () => {
    setSaving(true)
    try {
      // Build the settings object
      const notifSettings: Record<string, { in_app: boolean; email: boolean; push: boolean }> = {}
      for (const s of settings) {
        notifSettings[s.key] = { in_app: s.in_app, email: s.email, push: s.push }
      }

      // Get existing config
      const { data: existing } = await supabase
        .from('venue_config')
        .select('id, feature_flags')
        .eq('venue_id', VENUE_ID)
        .maybeSingle()

      if (existing) {
        await supabase
          .from('venue_config')
          .update({
            feature_flags: {
              ...(existing.feature_flags || {}),
              notification_settings: notifSettings,
            },
          })
          .eq('id', existing.id)
      } else {
        await supabase.from('venue_config').insert({
          venue_id: VENUE_ID,
          feature_flags: { notification_settings: notifSettings },
        })
      }

      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      console.error('Failed to save settings:', err)
      setError('Failed to save notification settings')
    } finally {
      setSaving(false)
    }
  }

  // ---- Request push permission ----
  const handleRequestPush = async () => {
    if (!pushSupported) return
    try {
      const permission = await Notification.requestPermission()
      if (permission === 'granted') {
        setPushRegistered(true)

        // Register device token (simplified — real implementation would use service worker)
        await supabase.from('notification_tokens').upsert({
          venue_id: VENUE_ID,
          token: 'browser-' + Date.now(),
          platform: 'web',
          active: true,
        })
      }
    } catch (err) {
      console.error('Push permission request failed:', err)
    }
  }

  return (
    <div className="space-y-6">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Notifications
          </h1>
          <p className="text-sage-600">
            Configure how and when you get alerted about new inquiries, AI draft approvals, pipeline changes, and Sage questions. Set thresholds so you only see what matters.
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2.5 bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          {saved ? (
            <>
              <CheckCircle2 className="w-4 h-4" />
              Saved
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : 'Save Settings'}
            </>
          )}
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

      {/* ---- Push Notification Setup ---- */}
      {pushSupported && !pushRegistered && (
        <div className="bg-teal-50 border border-teal-200 rounded-xl p-5 flex items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-teal-100 flex items-center justify-center shrink-0">
            <Smartphone className="w-5 h-5 text-teal-700" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-teal-900">
              Enable Push Notifications
            </h3>
            <p className="text-xs text-teal-700 mt-0.5">
              Get browser push notifications for important events even when the app is in the background.
            </p>
          </div>
          <button
            onClick={handleRequestPush}
            className="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
          >
            Enable
          </button>
        </div>
      )}

      {pushRegistered && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          <p className="text-sm text-emerald-700">
            Push notifications are enabled for this browser.
          </p>
        </div>
      )}

      {/* ---- Notification Settings ---- */}
      {loading ? (
        <SettingsSkeleton />
      ) : (
        <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
          {/* Header */}
          <div className="px-5 py-3 border-b border-border bg-sage-50/50">
            <div className="flex items-center">
              <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-sage-500">
                Event Type
              </span>
              <div className="flex items-center gap-8 pr-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-sage-500 w-14 text-center flex items-center gap-1">
                  <Monitor className="w-3.5 h-3.5" /> App
                </span>
                <span className="text-xs font-semibold uppercase tracking-wider text-sage-500 w-14 text-center flex items-center gap-1">
                  <Mail className="w-3.5 h-3.5" /> Email
                </span>
                <span className="text-xs font-semibold uppercase tracking-wider text-sage-500 w-14 text-center flex items-center gap-1">
                  <Smartphone className="w-3.5 h-3.5" /> Push
                </span>
              </div>
            </div>
          </div>

          {/* Settings Rows */}
          <div className="divide-y divide-border">
            {settings.map((setting) => {
              const Icon = setting.icon
              return (
                <div key={setting.key} className="px-5 py-4 flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-sage-50 flex items-center justify-center shrink-0">
                    <Icon className="w-5 h-5 text-sage-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-sage-900">{setting.label}</p>
                    <p className="text-xs text-sage-500">{setting.description}</p>
                  </div>
                  <div className="flex items-center gap-8 pr-2">
                    {/* In-App */}
                    <label className="w-14 flex items-center justify-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={setting.in_app}
                        onChange={() => toggleSetting(setting.key, 'in_app')}
                        className="w-4 h-4 rounded border-sage-300 text-sage-600 focus:ring-sage-500"
                      />
                    </label>
                    {/* Email */}
                    <label className="w-14 flex items-center justify-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={setting.email}
                        onChange={() => toggleSetting(setting.key, 'email')}
                        className="w-4 h-4 rounded border-sage-300 text-sage-600 focus:ring-sage-500"
                      />
                    </label>
                    {/* Push */}
                    <label className="w-14 flex items-center justify-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={setting.push}
                        onChange={() => toggleSetting(setting.key, 'push')}
                        className="w-4 h-4 rounded border-sage-300 text-sage-600 focus:ring-sage-500"
                      />
                    </label>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ---- Recent Notifications ---- */}
      <div>
        <h2 className="font-heading text-lg font-semibold text-sage-900 mb-3">
          Recent Notifications
        </h2>
        {recentNotifications.length === 0 ? (
          <div className="bg-surface border border-border rounded-xl p-8 shadow-sm text-center">
            <Bell className="w-10 h-10 text-sage-300 mx-auto mb-3" />
            <p className="text-sm text-sage-500">No notifications yet</p>
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-xl shadow-sm overflow-hidden divide-y divide-border">
            {recentNotifications.map((notif) => (
              <div
                key={notif.id}
                className={`px-5 py-3 flex items-start gap-3 ${
                  !notif.read ? 'bg-sage-50/50' : ''
                }`}
              >
                {!notif.read && (
                  <span className="w-2 h-2 rounded-full bg-sage-500 mt-1.5 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className={`text-sm ${!notif.read ? 'font-medium text-sage-900' : 'text-sage-700'}`}>
                    {notif.title}
                  </p>
                  {notif.body && (
                    <p className="text-xs text-sage-500 truncate mt-0.5">{notif.body}</p>
                  )}
                </div>
                <span className="text-xs text-sage-400 shrink-0 whitespace-nowrap">
                  {timeAgo(notif.created_at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
