'use client'

import { useState, useEffect, useCallback } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import { VenueChip } from '@/components/intel/venue-chip'
import { BrainDumpClarifications } from '@/components/agent/brain-dump-clarifications'
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
  XCircle,
  Timer,
  Loader2,
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
  venue_name?: string | null
}

interface PendingAutoSendDetails {
  draftId: string
  toEmail: string
  toName: string | null
  subject: string
  threadId?: string
  sendAt: string
  confidenceScore: number | null
  source: string
}

interface BookingConfirmDetails {
  weddingId: string
  interactionId: string | null
  coupleLabel: string
  weddingDate: string | null
  weddingDatePrecision: 'day' | 'month' | 'season' | 'year' | null
  currentBooked: number
  maxEvents: number
  matchedPhrase: string | null
  fromEmail: string
  subject: string
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
// Pending Auto-Send Card
// ---------------------------------------------------------------------------

function PendingAutoSendCard({
  notification,
  onCancel,
}: {
  notification: RecentNotification
  onCancel: (notificationId: string, draftId: string) => Promise<void>
}) {
  const [timeLeft, setTimeLeft] = useState<number>(0)
  const [cancelling, setCancelling] = useState(false)
  const [cancelled, setCancelled] = useState(false)

  let details: PendingAutoSendDetails | null = null
  try {
    if (notification.body) {
      details = JSON.parse(notification.body) as PendingAutoSendDetails
    }
  } catch {
    // Body might not be JSON
  }

  useEffect(() => {
    if (!details?.sendAt) return
    const target = new Date(details.sendAt).getTime()

    const tick = () => {
      const remaining = Math.max(0, target - Date.now())
      setTimeLeft(remaining)
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [details?.sendAt])

  if (!details) return null

  const minutes = Math.floor(timeLeft / 60000)
  const seconds = Math.floor((timeLeft % 60000) / 1000)
  const expired = timeLeft <= 0

  const handleCancel = async () => {
    setCancelling(true)
    try {
      await onCancel(notification.id, details!.draftId)
      setCancelled(true)
    } finally {
      setCancelling(false)
    }
  }

  if (cancelled) {
    return (
      <div className="px-5 py-4 flex items-center gap-3 bg-red-50/50">
        <XCircle className="w-5 h-5 text-red-500 shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-medium text-red-800">
            Auto-send cancelled
          </p>
          <p className="text-xs text-red-600">
            Draft to {details.toName || details.toEmail} was not sent.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="px-5 py-4 flex items-start gap-3 bg-amber-50/50">
      <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
        <Timer className="w-5 h-5 text-amber-700" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-900">
          {expired ? 'Sending...' : `Auto-sending in ${minutes}:${seconds.toString().padStart(2, '0')}`}
        </p>
        <p className="text-xs text-amber-700 mt-0.5">
          To: {details.toName || details.toEmail}
          {details.subject ? ` — ${details.subject}` : ''}
        </p>
        {details.confidenceScore !== null && (
          <p className="text-[10px] text-amber-600 mt-0.5">
            Confidence: {Math.round((details.confidenceScore ?? 0) * 100)}% | Source: {details.source}
          </p>
        )}
      </div>
      {!expired && (
        <button
          onClick={handleCancel}
          disabled={cancelling}
          className="flex items-center gap-1.5 px-3 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {cancelling ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <XCircle className="w-4 h-4" />
          )}
          Cancel Send
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Booking Confirmation Card
//
// Renders a "Looks like [date] may have been booked" prompt with a confirm
// or dismiss action. The body field on the notification is a JSON blob
// written by email-pipeline.ts when detectBookingSignal fires. The confirm
// path POSTs to /api/agent/confirm-booking; the DB triggers stamp
// booked_at and sync venue_availability.booked_count.
// ---------------------------------------------------------------------------

function formatWeddingDate(iso: string, precision: string | null): string {
  // iso is YYYY-MM-DD (wedding_date column). Construct in local tz.
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, (m ?? 1) - 1, d ?? 1)
  if (precision === 'year') {
    return date.toLocaleDateString('en-US', { year: 'numeric' })
  }
  if (precision === 'month' || precision === 'season') {
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }
  return date.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  })
}

function BookingConfirmCard({
  notification,
  onResolved,
}: {
  notification: RecentNotification
  onResolved: (notificationId: string) => void
}) {
  const [working, setWorking] = useState<'confirm' | 'dismiss' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<'confirmed' | 'dismissed' | null>(null)

  let details: BookingConfirmDetails | null = null
  try {
    if (notification.body) {
      details = JSON.parse(notification.body) as BookingConfirmDetails
    }
  } catch {
    // Body might be a legacy free-text string from the previous
    // contract_signing_detected flow — render a simple fallback.
  }

  async function act(confirmed: boolean) {
    setWorking(confirmed ? 'confirm' : 'dismiss')
    setError(null)
    try {
      const res = await fetch('/api/agent/confirm-booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notificationId: notification.id,
          weddingId: details?.weddingId ?? null,
          confirmed,
        }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(payload.error || `HTTP ${res.status}`)
      }
      setDone(confirmed ? 'confirmed' : 'dismissed')
      onResolved(notification.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setWorking(null)
    }
  }

  if (done === 'confirmed') {
    return (
      <div className="px-5 py-4 flex items-center gap-3 bg-emerald-50/60">
        <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-medium text-emerald-900">
            Marked as booked
          </p>
          <p className="text-xs text-emerald-700">
            {details?.coupleLabel ?? 'Wedding'} is now in the Booked stage.
            Availability calendar updated.
          </p>
        </div>
      </div>
    )
  }

  if (done === 'dismissed') {
    return (
      <div className="px-5 py-4 flex items-center gap-3 bg-sage-50/60">
        <XCircle className="w-5 h-5 text-sage-500 shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-medium text-sage-800">Prompt dismissed</p>
          <p className="text-xs text-sage-600">
            Wedding status unchanged.
          </p>
        </div>
      </div>
    )
  }

  // Fallback render for legacy/unknown body shapes.
  if (!details) {
    return (
      <div className="px-5 py-4 flex items-start gap-3 bg-amber-50/60">
        <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-900">{notification.title}</p>
          {notification.body && (
            <p className="text-xs text-amber-700 mt-0.5">{notification.body}</p>
          )}
        </div>
      </div>
    )
  }

  const dateLabel = details.weddingDate
    ? formatWeddingDate(details.weddingDate, details.weddingDatePrecision)
    : null

  // Slot math — how many slots remain AFTER confirming this booking.
  // Per Task 13 spec: "Do you want to mark one slot on [Date] as booked?
  // [X of Y] slots would then remain available."
  const slotsAfter = Math.max(0, details.maxEvents - details.currentBooked - 1)
  const multiWedding = details.maxEvents > 1
  const overCap = details.currentBooked >= details.maxEvents

  return (
    <div className="px-5 py-4 flex items-start gap-3 bg-amber-50/50">
      <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
        <Calendar className="w-5 h-5 text-amber-700" />
      </div>
      <div className="flex-1 min-w-0 space-y-1">
        <p className="text-sm font-medium text-amber-900">
          {dateLabel
            ? `Looks like ${dateLabel} may have been booked by ${details.coupleLabel}`
            : `Possible booking from ${details.coupleLabel}`}
        </p>
        {details.matchedPhrase && (
          <p className="text-xs text-amber-700 italic truncate">
            “{details.matchedPhrase}” in {details.subject || 'the latest email'}
          </p>
        )}
        {dateLabel && multiWedding && !overCap && (
          <p className="text-xs text-amber-800">
            Marking this slot as booked would leave <strong>{slotsAfter}</strong> of{' '}
            <strong>{details.maxEvents}</strong> slots available on this date.
          </p>
        )}
        {dateLabel && multiWedding && overCap && (
          <p className="text-xs text-rose-700">
            This date is already fully booked ({details.currentBooked} of{' '}
            {details.maxEvents}). Confirming would exceed capacity.
          </p>
        )}
        {dateLabel && !multiWedding && (
          <p className="text-xs text-amber-800">
            Confirming will mark this date as booked on the availability calendar.
          </p>
        )}
        {!dateLabel && (
          <p className="text-xs text-amber-700">
            No wedding date on file yet. Confirming will move this couple to the
            Booked stage without updating the calendar.
          </p>
        )}
        {error && (
          <p className="text-xs text-rose-700 mt-1">{error}</p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => act(false)}
          disabled={working !== null}
          className="px-3 py-1.5 text-xs font-medium text-sage-700 hover:bg-sage-100 rounded-lg disabled:opacity-50"
        >
          {working === 'dismiss' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : 'Dismiss'}
        </button>
        <button
          type="button"
          onClick={() => act(true)}
          disabled={working !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium rounded-lg disabled:opacity-50"
        >
          {working === 'confirm' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="w-3.5 h-3.5" />
          )}
          Mark as booked
        </button>
      </div>
    </div>
  )
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
  const scope = useScope()
  const showVenueChip = scope.level !== 'venue'
  // Notification settings (venue_config) require a specific venue; fall back to first venue in scope when not at venue level
  const settingsVenueId = scope.venueId ?? ''
  const [settings, setSettings] = useState<NotificationSetting[]>(DEFAULT_NOTIFICATION_SETTINGS)
  const [recentNotifications, setRecentNotifications] = useState<RecentNotification[]>([])
  const [pendingAutoSends, setPendingAutoSends] = useState<RecentNotification[]>([])
  const [bookingPrompts, setBookingPrompts] = useState<RecentNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pushSupported, setPushSupported] = useState(false)
  const [pushRegistered, setPushRegistered] = useState(false)

  const supabase = createClient()

  // ---- Load settings from venue_config ----
  const fetchSettings = useCallback(async () => {
    if (scope.loading) return
    try {
      // Build venue filter from scope
      let venueIds: string[] | null = null
      if (scope.level === 'venue' && scope.venueId) {
        venueIds = [scope.venueId]
      } else if (scope.level === 'group' && scope.groupId) {
        const { data: members } = await supabase
          .from('venue_group_members')
          .select('venue_id')
          .eq('group_id', scope.groupId)
        venueIds = (members ?? []).map((r) => r.venue_id as string)
      } else if (scope.orgId) {
        const { data: orgVenues } = await supabase
          .from('venues')
          .select('id')
          .eq('org_id', scope.orgId)
        venueIds = (orgVenues ?? []).map((v) => v.id as string)
      }

      // Settings are per-venue; only load when a specific venue is in scope
      if (settingsVenueId) {
        const { data: config } = await supabase
          .from('venue_config')
          .select('feature_flags')
          .eq('venue_id', settingsVenueId)
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
      }

      // Check push support
      if (typeof window !== 'undefined' && 'Notification' in window) {
        setPushSupported(true)
        setPushRegistered(Notification.permission === 'granted')
      }

      // Fetch recent notifications (scoped). Reads admin_notifications —
      // the canonical table written by email-pipeline (auto_send_pending),
      // heat-mapping (booking_confirmation_prompt), and the cron jobs.
      // The deprecated `notifications` table from migration 017 has no
      // current writers; switching here so coordinators see the actual
      // alert stream instead of an empty seed-only table.
      let notifsQuery = supabase
        .from('admin_notifications')
        .select('*, venues:venue_id ( name )')
      if (venueIds && venueIds.length > 0) {
        notifsQuery = notifsQuery.in('venue_id', venueIds)
      }
      const { data: notifs } = await notifsQuery
        .order('created_at', { ascending: false })
        .limit(20)

      const mappedNotifs: RecentNotification[] = (notifs ?? []).map((row: any) => {
        const venueRel = row.venues as { name?: string } | { name?: string }[] | null | undefined
        const venueName = Array.isArray(venueRel) ? venueRel[0]?.name ?? null : venueRel?.name ?? null
        return { ...row, venue_name: venueName }
      })

      // Separate pending auto-sends + booking-confirmation prompts out of
      // the regular feed — each has a dedicated action card. Resolved rows
      // (read=true) fall through to the Recent Notifications feed for the
      // audit trail.
      const pending = mappedNotifs.filter(
        (n) => n.type === 'auto_send_pending' && !n.read
      )
      const booking = mappedNotifs.filter(
        (n) => n.type === 'booking_confirmation_prompt' && !n.read
      )
      const regular = mappedNotifs.filter(
        (n) =>
          (n.type !== 'auto_send_pending' && n.type !== 'booking_confirmation_prompt') ||
          n.read
      )
      setPendingAutoSends(pending)
      setBookingPrompts(booking)
      setRecentNotifications(regular)
      setError(null)
    } catch (err) {
      console.error('Failed to load notification settings:', err)
      setError('Failed to load notification settings')
    } finally {
      setLoading(false)
    }
  }, [scope.loading, scope.level, scope.venueId, scope.groupId, settingsVenueId, supabase])

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
    if (!settingsVenueId) {
      setError('Select a specific venue to edit notification settings')
      return
    }
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
        .eq('venue_id', settingsVenueId)
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
          venue_id: settingsVenueId,
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

  // ---- Cancel pending auto-send ----
  const handleCancelAutoSend = async (notificationId: string, draftId: string) => {
    try {
      const res = await fetch('/api/agent/auto-send-cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationId, draftId }),
      })
      if (!res.ok) throw new Error('Cancel failed')
      // Remove from pending list
      setPendingAutoSends((prev) => prev.filter((n) => n.id !== notificationId))
    } catch (err) {
      console.error('Failed to cancel auto-send:', err)
    }
  }

  // ---- Request push permission ----
  const handleRequestPush = async () => {
    if (!pushSupported) return
    if (!settingsVenueId) return
    try {
      const permission = await Notification.requestPermission()
      if (permission === 'granted') {
        setPushRegistered(true)

        // Register device token (simplified — real implementation would use service worker)
        await supabase.from('notification_tokens').upsert({
          venue_id: settingsVenueId,
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

      {/* ---- Brain-dump clarifications ---- */}
      <BrainDumpClarifications />

      {/* ---- Booking-confirmation prompts ---- */}
      {bookingPrompts.length > 0 && (
        <div>
          <h2 className="font-heading text-lg font-semibold text-sage-900 mb-3 flex items-center gap-2">
            <Calendar className="w-5 h-5 text-amber-500" />
            Confirm Bookings
          </h2>
          <div className="bg-surface border border-amber-200 rounded-xl shadow-sm overflow-hidden divide-y divide-amber-100">
            {bookingPrompts.map((notif) => (
              <BookingConfirmCard
                key={notif.id}
                notification={notif}
                onResolved={(id) =>
                  setBookingPrompts((prev) => prev.filter((n) => n.id !== id))
                }
              />
            ))}
          </div>
        </div>
      )}

      {/* ---- Pending Auto-Sends ---- */}
      {pendingAutoSends.length > 0 && (
        <div>
          <h2 className="font-heading text-lg font-semibold text-sage-900 mb-3 flex items-center gap-2">
            <Timer className="w-5 h-5 text-amber-500" />
            Pending Auto-Sends
          </h2>
          <div className="bg-surface border border-amber-200 rounded-xl shadow-sm overflow-hidden divide-y divide-amber-100">
            {pendingAutoSends.map((notif) => (
              <PendingAutoSendCard
                key={notif.id}
                notification={notif}
                onCancel={handleCancelAutoSend}
              />
            ))}
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
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className={`text-sm ${!notif.read ? 'font-medium text-sage-900' : 'text-sage-700'}`}>
                      {notif.title}
                    </p>
                    {showVenueChip && <VenueChip venueName={notif.venue_name} />}
                  </div>
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
