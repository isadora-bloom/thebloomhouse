'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'
import {
  Calendar,
  Users,
  DollarSign,
  CheckSquare,
  Clock,
  MessageCircle,
  ArrowRight,
  Heart,
  Sparkles,
  Camera,
  FileText,
  Briefcase,
  ClipboardList,
  X as XIcon,
} from 'lucide-react'
import { CouplePhotoPrompt } from '@/components/couple/couple-photo-prompt'

// TODO: Get wedding ID from auth session / couple's user profile
const WEDDING_ID = 'ab000000-0000-0000-0000-000000000001'
const SLUG = 'hawthorne-manor'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardData {
  coupleNames: string
  weddingDate: string | null
  guestCount: number | null
  guestsAttending: number
  guestsPending: number
  guestsDeclined: number
  budgetTotal: number | null
  budgetBudgeted: number
  budgetCommitted: number
  budgetPaid: number
  checklistTotal: number
  checklistDone: number
  checklistOverdue: number
  timelineCeremonyTime: string | null
  timelineReceptionEnd: string | null
  timelineDinnerType: string | null
  timelineEventsCount: number
  upcomingTasks: Array<{
    id: string
    title: string
    due_date: string | null
    category: string | null
  }>
  recentMessages: Array<{
    id: string
    content: string
    sender_role: string | null
    created_at: string
  }>
  // Alert inputs
  couplePhotoUrl: string | null
  guestListCount: number
  contractsCount: number
  bookedVendorsCount: number
}

// ---------------------------------------------------------------------------
// Planning Alerts
// ---------------------------------------------------------------------------

type AlertId = 'photo' | 'budget' | 'contracts' | 'vendors' | 'guests' | 'checklist'

interface PlanningAlert {
  id: AlertId
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  title: string
  href: string
}

function buildAlerts(data: DashboardData): PlanningAlert[] {
  const alerts: PlanningAlert[] = []
  const days = daysUntil(data.weddingDate)

  // 1. Photo
  if (!data.couplePhotoUrl) {
    alerts.push({
      id: 'photo',
      icon: Camera,
      title: "Add a couple photo — it'll appear on your website and throughout your portal.",
      href: `/couple/${SLUG}/couple-photo`,
    })
  }

  // 2. Budget
  if (data.budgetTotal === null || data.budgetTotal === 0) {
    alerts.push({
      id: 'budget',
      icon: DollarSign,
      title: 'Set your overall budget to start tracking spending.',
      href: `/couple/${SLUG}/budget`,
    })
  }

  // 3. Contracts (wedding_date < 6 months away)
  if (data.contractsCount === 0 && days !== null && days < 183) {
    alerts.push({
      id: 'contracts',
      icon: FileText,
      title: "It's a good time to start collecting vendor contracts.",
      href: `/couple/${SLUG}/contracts`,
    })
  }

  // 4. Vendors
  if (data.bookedVendorsCount === 0) {
    alerts.push({
      id: 'vendors',
      icon: Briefcase,
      title: 'Add your vendors to keep all your contacts in one place.',
      href: `/couple/${SLUG}/vendors`,
    })
  }

  // 5. Guests (wedding_date < 9 months away)
  if (data.guestListCount === 0 && days !== null && days < 274) {
    alerts.push({
      id: 'guests',
      icon: Users,
      title: 'Your guest list is empty — add guests to unlock seating, shuttle, and more.',
      href: `/couple/${SLUG}/guests`,
    })
  }

  // 6. Checklist (wedding_date < 6 months away)
  if (data.checklistDone === 0 && days !== null && days < 183) {
    alerts.push({
      id: 'checklist',
      icon: ClipboardList,
      title: "Your planning checklist hasn't been started yet.",
      href: `/couple/${SLUG}/checklist`,
    })
  }

  return alerts
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const target = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Date TBD'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatDueDate(dateStr: string | null): string {
  if (!dateStr) return 'No due date'
  const due = new Date(dateStr + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffDays = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
  if (diffDays < 0) return `Overdue (${due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`
  if (diffDays === 0) return 'Due today'
  if (diffDays === 1) return 'Due tomorrow'
  if (diffDays < 7) return `Due in ${diffDays} days`
  return `Due ${due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

function fmt$(value: number): string {
  return `$${Math.round(value).toLocaleString()}`
}

function getCountdownMessage(days: number | null): string | null {
  if (days === null || days < 0) return null
  if (days === 0) return 'Today is your day!'
  if (days === 1) return "Tomorrow's the day!"
  if (days <= 7) return 'This is really happening!'
  if (days < 30) return 'Almost there! One week to go.'
  if (days < 100) return "The home stretch! Let's make sure nothing's missed."
  if (days < 200) return 'Things are coming together. Time for details!'
  if (days < 400) return "Plenty of time to plan. Let's lock in the big stuff."
  return 'You have all the time in the world. Start dreaming!'
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ---------------------------------------------------------------------------
// Dashboard Page
// ---------------------------------------------------------------------------

const ALERT_PRIORITY: AlertId[] = ['photo', 'budget', 'contracts', 'vendors', 'guests', 'checklist']

export default function CoupleDashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [showPhotoPrompt, setShowPhotoPrompt] = useState(false)
  const [dismissedAlerts, setDismissedAlerts] = useState<AlertId[]>([])

  // Load dismissed alerts from sessionStorage on mount
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = sessionStorage.getItem('bloom_dismissed_alerts')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) setDismissedAlerts(parsed as AlertId[])
      }
    } catch {
      // ignore
    }
  }, [])

  function dismissAlert(id: AlertId) {
    setDismissedAlerts((prev) => {
      if (prev.includes(id)) return prev
      const next = [...prev, id]
      try {
        sessionStorage.setItem('bloom_dismissed_alerts', JSON.stringify(next))
      } catch {
        // ignore
      }
      return next
    })
  }

  // Trigger the first-login couple photo prompt
  useEffect(() => {
    if (!data) return
    if (typeof window === 'undefined') return
    if (data.couplePhotoUrl) return
    const alreadyPrompted = sessionStorage.getItem('bloom_demo_couple_photo_prompted')
    if (alreadyPrompted) return
    sessionStorage.setItem('bloom_demo_couple_photo_prompted', '1')
    setShowPhotoPrompt(true)
  }, [data])

  useEffect(() => {
    async function loadDashboard() {
      const supabase = createClient()

      try {
        // Fetch wedding with people
        const { data: wedding } = await supabase
          .from('weddings')
          .select('*, people(*)')
          .eq('id', WEDDING_ID)
          .single()

        if (!wedding) {
          setLoading(false)
          return
        }

        // Fetch related data in parallel
        const [
          guests,
          budgetItemsRes,
          weddingConfigRes,
          checklist,
          upcomingChecklist,
          allTimeline,
          messages,
          contractsRes,
          bookedVendorsRes,
        ] = await Promise.all([
          supabase.from('guest_list').select('id, rsvp_status').eq('wedding_id', WEDDING_ID),
          supabase
            .from('budget_items')
            .select('budgeted, committed, paid, budget_payments(amount)')
            .eq('wedding_id', WEDDING_ID),
          supabase
            .from('wedding_config')
            .select('total_budget')
            .eq('wedding_id', WEDDING_ID)
            .maybeSingle(),
          supabase.from('checklist_items').select('id, is_completed, due_date').eq('wedding_id', WEDDING_ID),
          supabase
            .from('checklist_items')
            .select('id, title, due_date, category')
            .eq('wedding_id', WEDDING_ID)
            .eq('is_completed', false)
            .order('due_date', { ascending: true, nullsFirst: false })
            .limit(5),
          supabase
            .from('timeline')
            .select('id, title, time, category')
            .eq('wedding_id', WEDDING_ID)
            .order('time', { ascending: true }),
          supabase
            .from('messages')
            .select('id, content, sender_role, created_at')
            .eq('wedding_id', WEDDING_ID)
            .order('created_at', { ascending: false })
            .limit(3),
          supabase
            .from('contracts')
            .select('id', { count: 'exact', head: true })
            .eq('wedding_id', WEDDING_ID),
          supabase
            .from('booked_vendors')
            .select('id', { count: 'exact', head: true })
            .eq('wedding_id', WEDDING_ID),
        ])

        const people = (wedding.people || []) as Array<{
          first_name: string
          role: string
        }>
        const principals = people.filter(
          (p) => p.role === 'partner1' || p.role === 'partner2'
        )
        const coupleNames = principals.length > 0
          ? principals.map((p) => p.first_name).join(' & ')
          : 'there'

        const guestList = guests.data || []
        const budgetItems = (budgetItemsRes.data || []) as Array<{
          budgeted: number | null
          committed: number | null
          paid: number | null
          budget_payments: Array<{ amount: number | null }> | null
        }>
        const weddingConfig = weddingConfigRes.data as { total_budget: number | null } | null
        const checklistItems = checklist.data || []
        const allTimelineItems = (allTimeline.data || []) as Array<{ id: string; title: string; time: string | null; category: string | null }>

        // Compute checklist overdue count
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const overdueCount = checklistItems.filter((c: { is_completed: boolean; due_date: string | null }) => {
          if (c.is_completed || !c.due_date) return false
          return new Date(c.due_date + 'T00:00:00') < today
        }).length

        // Derive timeline summary
        const ceremonyItem = allTimelineItems.find((t) => t.category === 'ceremony' || t.title.toLowerCase().includes('ceremony'))
        const receptionEndItem = [...allTimelineItems].reverse().find((t) => t.category === 'reception' || t.title.toLowerCase().includes('last dance') || t.title.toLowerCase().includes('reception end') || t.title.toLowerCase().includes('send off') || t.title.toLowerCase().includes('exit'))
        const dinnerItem = allTimelineItems.find((t) => t.category === 'dinner' || t.title.toLowerCase().includes('dinner') || t.title.toLowerCase().includes('supper'))

        setData({
          coupleNames,
          weddingDate: wedding.wedding_date,
          guestCount: wedding.guest_count_estimate,
          guestsAttending: guestList.filter((g) => g.rsvp_status === 'attending').length,
          guestsPending: guestList.filter((g) => g.rsvp_status === 'pending').length,
          guestsDeclined: guestList.filter((g) => g.rsvp_status === 'declined').length,
          budgetTotal:
            weddingConfig?.total_budget === null || weddingConfig?.total_budget === undefined
              ? null
              : Number(weddingConfig.total_budget),
          budgetBudgeted: budgetItems.reduce((s, b) => s + (Number(b.budgeted) || 0), 0),
          budgetCommitted: budgetItems.reduce((s, b) => s + (Number(b.committed) || 0), 0),
          budgetPaid: budgetItems.reduce((s, b) => {
            const paymentsSum = (b.budget_payments || []).reduce((ps, p) => ps + (Number(p.amount) || 0), 0)
            return s + (paymentsSum > 0 ? paymentsSum : Number(b.paid) || 0)
          }, 0),
          checklistTotal: checklistItems.length,
          checklistDone: checklistItems.filter((c: { is_completed: boolean }) => c.is_completed).length,
          checklistOverdue: overdueCount,
          timelineCeremonyTime: ceremonyItem?.time || null,
          timelineReceptionEnd: receptionEndItem?.time || null,
          timelineDinnerType: dinnerItem?.title || null,
          timelineEventsCount: allTimelineItems.length,
          upcomingTasks: (upcomingChecklist.data || []) as DashboardData['upcomingTasks'],
          recentMessages: (messages.data || []) as DashboardData['recentMessages'],
          couplePhotoUrl: (wedding as { couple_photo_url?: string | null }).couple_photo_url || null,
          guestListCount: guestList.length,
          contractsCount: contractsRes.count ?? 0,
          bookedVendorsCount: bookedVendorsRes.count ?? 0,
        })
      } catch (err) {
        console.error('Failed to load couple dashboard:', err)
      } finally {
        setLoading(false)
      }
    }

    loadDashboard()
  }, [])

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="animate-pulse space-y-6">
          <div className="h-8 w-72 bg-gray-200 rounded" />
          <div className="h-5 w-48 bg-gray-100 rounded" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
                <div className="h-4 w-20 bg-gray-100 rounded mb-3" />
                <div className="h-8 w-16 bg-gray-200 rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="text-center py-20">
        <Heart className="w-12 h-12 mx-auto mb-4" style={{ color: 'var(--couple-primary)' }} />
        <h2
          className="text-xl font-semibold mb-2"
          style={{ fontFamily: 'var(--couple-font-heading)' }}
        >
          Wedding not found
        </h2>
        <p className="text-gray-500">We could not find your wedding details. Please contact your coordinator.</p>
      </div>
    )
  }

  const days = daysUntil(data.weddingDate)
  const checklistPercent = data.checklistTotal > 0
    ? Math.round((data.checklistDone / data.checklistTotal) * 100)
    : 0
  // Budget math aligns with budget page: remaining = total budget - committed
  const budgetTotalNum = data.budgetTotal ?? 0
  const budgetRemaining = budgetTotalNum - data.budgetCommitted
  const budgetCommittedPct = budgetTotalNum > 0
    ? Math.round((data.budgetCommitted / budgetTotalNum) * 100)
    : 0
  const budgetPaidPct = budgetTotalNum > 0
    ? Math.round((data.budgetPaid / budgetTotalNum) * 100)
    : 0
  const countdownMessage = getCountdownMessage(days)

  // Detect admin preview mode (has bloom_scope cookie = admin user)
  const isAdminPreview = typeof document !== 'undefined' && document.cookie.includes('bloom_scope=')

  // Planning alerts — compute from data, filter dismissed, sort by priority, cap at 3
  const allAlerts = buildAlerts(data)
  const visibleAlerts = ALERT_PRIORITY
    .map((id) => allAlerts.find((a) => a.id === id))
    .filter((a): a is PlanningAlert => !!a && !dismissedAlerts.includes(a.id))
    .slice(0, 3)

  return (
    <div className="space-y-8">
      {/* Couple photo prompt — first-login only (once per session) */}
      {showPhotoPrompt && (
        <CouplePhotoPrompt
          weddingId={WEDDING_ID}
          onDismiss={() => setShowPhotoPrompt(false)}
          onUploaded={(url) => {
            setData((prev) => (prev ? { ...prev, couplePhotoUrl: url } : prev))
          }}
        />
      )}
      {/* Admin Preview Banner */}
      {isAdminPreview && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex items-center gap-3">
          <Sparkles className="w-5 h-5 text-amber-600 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-amber-800">Admin Preview Mode</p>
            <p className="text-xs text-amber-600">You&apos;re viewing this portal as your client would see it.</p>
          </div>
          <button
            onClick={() => window.close()}
            className="text-xs font-medium text-amber-700 hover:text-amber-900 transition-colors"
          >
            Close Preview
          </button>
        </div>
      )}

      {/* Welcome Header */}
      <div>
        <h1
          className="text-3xl sm:text-4xl font-bold mb-2"
          style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
        >
          Welcome, {data.coupleNames}!
        </h1>
        <p className="text-gray-600" style={{ fontFamily: 'var(--couple-font-body)' }}>
          {data.weddingDate ? (
            <>
              {formatDate(data.weddingDate)}
              {days !== null && days > 0 && (
                <span
                  className="ml-2 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-sm font-medium text-white"
                  style={{ backgroundColor: 'var(--couple-accent)' }}
                >
                  <Calendar className="w-3.5 h-3.5" />
                  {days} days to go
                </span>
              )}
              {days !== null && days === 0 && (
                <span className="ml-2 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-sm font-medium bg-pink-100 text-pink-700">
                  <Heart className="w-3.5 h-3.5" />
                  Today is the day!
                </span>
              )}
            </>
          ) : (
            'Your wedding date has not been set yet.'
          )}
        </p>
        {countdownMessage && (
          <p
            className="text-sm mt-2 italic"
            style={{ color: 'var(--couple-primary)', fontFamily: 'var(--couple-font-body)' }}
          >
            {countdownMessage}
          </p>
        )}
      </div>

      {/* Planning Alerts Strip */}
      {visibleAlerts.length > 0 && (
        <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
          {visibleAlerts.map((alert) => {
            const Icon = alert.icon
            return (
              <div
                key={alert.id}
                className="relative flex items-start gap-3 px-4 py-3 rounded-xl border border-gray-200 bg-white shadow-sm min-w-[280px] flex-1"
              >
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center shrink-0"
                  style={{ backgroundColor: '#7D847115' }}
                >
                  <Icon className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
                </div>
                <Link
                  href={alert.href}
                  className="flex-1 text-sm text-gray-700 leading-snug hover:underline pr-4"
                >
                  {alert.title}
                </Link>
                <button
                  onClick={() => dismissAlert(alert.id)}
                  className="absolute top-2 right-2 text-gray-300 hover:text-gray-500 transition-colors"
                  aria-label="Dismiss alert"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Quick Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Days Until */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
            <span className="text-sm text-gray-500 font-medium">Days Until</span>
          </div>
          <p className="text-3xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
            {days !== null && days >= 0 ? days : '--'}
          </p>
        </div>

        {/* Guests */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <Users className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
            <span className="text-sm text-gray-500 font-medium">Guests</span>
          </div>
          <p className="text-3xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
            {data.guestsAttending}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {data.guestsPending} pending
          </p>
        </div>

        {/* Budget */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
            <span className="text-sm text-gray-500 font-medium">Budget</span>
          </div>
          <p className="text-3xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
            {fmt$(budgetRemaining)}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            remaining of {fmt$(budgetTotalNum)}
          </p>
        </div>

        {/* Checklist */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-2">
            <CheckSquare className="w-4 h-4" style={{ color: 'var(--couple-primary)' }} />
            <span className="text-sm text-gray-500 font-medium">Checklist</span>
          </div>
          <p className="text-3xl font-bold tabular-nums" style={{ color: 'var(--couple-primary)' }}>
            {checklistPercent}%
          </p>
          <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${checklistPercent}%`,
                backgroundColor: 'var(--couple-primary)',
              }}
            />
          </div>
        </div>
      </div>

      {/* Detailed Summary Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Budget Summary Card */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h2
            className="text-lg font-semibold mb-4"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            <DollarSign className="w-4 h-4 inline mr-2" />
            Budget Summary
          </h2>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Total Budget</span>
              <span className="font-medium text-gray-800">{fmt$(budgetTotalNum)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Budgeted</span>
              <span className="font-medium text-gray-800">{fmt$(data.budgetBudgeted)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Committed</span>
              <span className="font-medium text-gray-800">{fmt$(data.budgetCommitted)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Paid</span>
              <span className="font-medium text-gray-800">{fmt$(data.budgetPaid)}</span>
            </div>
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                <span>Committed vs Budget</span>
                <span>{budgetCommittedPct}%</span>
              </div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full relative" style={{ width: '100%' }}>
                  <div
                    className="absolute inset-y-0 left-0 rounded-full transition-all"
                    style={{ width: `${budgetCommittedPct}%`, backgroundColor: 'var(--couple-primary)', opacity: 0.4 }}
                  />
                  <div
                    className="absolute inset-y-0 left-0 rounded-full transition-all"
                    style={{ width: `${budgetPaidPct}%`, backgroundColor: 'var(--couple-primary)' }}
                  />
                </div>
              </div>
              <div className="flex items-center gap-4 mt-2 text-xs text-gray-400">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--couple-primary)' }} />
                  Paid
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--couple-primary)', opacity: 0.4 }} />
                  Committed
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Guest RSVP Summary Card */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h2
            className="text-lg font-semibold mb-4"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            <Users className="w-4 h-4 inline mr-2" />
            Guest RSVPs
          </h2>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                Attending
              </span>
              <span className="font-medium text-gray-800">{data.guestsAttending}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                Pending
              </span>
              <span className="font-medium text-gray-800">{data.guestsPending}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-400" />
                Declined
              </span>
              <span className="font-medium text-gray-800">{data.guestsDeclined}</span>
            </div>
            {(data.guestsAttending + data.guestsPending + data.guestsDeclined) > 0 && (
              <div className="mt-3 h-3 bg-gray-100 rounded-full overflow-hidden flex">
                {data.guestsAttending > 0 && (
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${(data.guestsAttending / (data.guestsAttending + data.guestsPending + data.guestsDeclined)) * 100}%` }}
                  />
                )}
                {data.guestsPending > 0 && (
                  <div
                    className="h-full bg-amber-400 transition-all"
                    style={{ width: `${(data.guestsPending / (data.guestsAttending + data.guestsPending + data.guestsDeclined)) * 100}%` }}
                  />
                )}
                {data.guestsDeclined > 0 && (
                  <div
                    className="h-full bg-red-400 transition-all"
                    style={{ width: `${(data.guestsDeclined / (data.guestsAttending + data.guestsPending + data.guestsDeclined)) * 100}%` }}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        {/* Timeline Summary Card */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h2
            className="text-lg font-semibold mb-4"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            <Clock className="w-4 h-4 inline mr-2" />
            Day-Of Snapshot
          </h2>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Ceremony</span>
              <span className="font-medium text-gray-800">
                {data.timelineCeremonyTime || 'Not set'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Reception End</span>
              <span className="font-medium text-gray-800">
                {data.timelineReceptionEnd || 'Not set'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Dinner</span>
              <span className="font-medium text-gray-800">
                {data.timelineDinnerType || 'Not set'}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Timeline Events</span>
              <span className="font-medium text-gray-800">{data.timelineEventsCount}</span>
            </div>
          </div>
        </div>

        {/* Checklist Progress Card */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <h2
            className="text-lg font-semibold mb-4"
            style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
          >
            <CheckSquare className="w-4 h-4 inline mr-2" />
            Checklist Progress
          </h2>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Completed</span>
              <span className="font-medium text-gray-800">{data.checklistDone} of {data.checklistTotal}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Completion</span>
              <span className="font-medium text-gray-800">{checklistPercent}%</span>
            </div>
            {data.checklistOverdue > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-red-600 font-medium">Overdue</span>
                <span className="font-medium text-red-600">{data.checklistOverdue}</span>
              </div>
            )}
            <div className="mt-2 h-2.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${checklistPercent}%`,
                  backgroundColor: data.checklistOverdue > 0 ? '#ef4444' : 'var(--couple-primary)',
                }}
              />
            </div>
            {data.checklistOverdue > 0 && (
              <p className="text-xs text-red-500 mt-1">
                {data.checklistOverdue} item{data.checklistOverdue !== 1 ? 's' : ''} past due date
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Two-column grid: Timeline + Messages */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Upcoming Timeline */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between p-5 border-b border-gray-50">
            <h2
              className="text-lg font-semibold"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              <Clock className="w-4 h-4 inline mr-2" />
              Upcoming
            </h2>
            <Link
              href={`/couple/${SLUG}/checklist`}
              className="text-sm font-medium flex items-center gap-1 hover:underline"
              style={{ color: 'var(--couple-primary)' }}
            >
              View all <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          <div className="p-5">
            {data.upcomingTasks.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">
                Nothing on your checklist! You&apos;re all caught up.
              </p>
            ) : (
              <div className="space-y-3">
                {data.upcomingTasks.map((item) => (
                  <div key={item.id} className="flex items-start gap-3">
                    <div
                      className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                      style={{ backgroundColor: 'var(--couple-accent)' }}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">
                        {item.title}
                      </p>
                      <p className="text-xs text-gray-400">
                        {formatDueDate(item.due_date)}
                        {item.category && (
                          <span
                            className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-medium text-white"
                            style={{ backgroundColor: 'var(--couple-accent)' }}
                          >
                            {item.category}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent Messages */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between p-5 border-b border-gray-50">
            <h2
              className="text-lg font-semibold"
              style={{ fontFamily: 'var(--couple-font-heading)', color: 'var(--couple-primary)' }}
            >
              <MessageCircle className="w-4 h-4 inline mr-2" />
              Messages
            </h2>
            <Link
              href={`/couple/${SLUG}/messages`}
              className="text-sm font-medium flex items-center gap-1 hover:underline"
              style={{ color: 'var(--couple-primary)' }}
            >
              View all <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          <div className="p-5">
            {data.recentMessages.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">
                No messages yet. Your coordinator will reach out soon!
              </p>
            ) : (
              <div className="space-y-3">
                {data.recentMessages.map((msg) => (
                  <div key={msg.id} className="flex items-start gap-3">
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
                      style={{
                        backgroundColor: msg.sender_role === 'coordinator'
                          ? 'var(--couple-primary)'
                          : 'var(--couple-accent)',
                      }}
                    >
                      {msg.sender_role === 'coordinator' ? 'C' : 'Y'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-700 line-clamp-2">
                        {msg.content}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {timeAgo(msg.created_at)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sage Chat Prompt */}
      <Link href="/chat" className="block group">
        <div
          className="rounded-xl p-6 transition-shadow hover:shadow-md border-2"
          style={{
            backgroundColor: 'var(--couple-primary)',
            borderColor: 'var(--couple-primary)',
          }}
        >
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center shrink-0">
              <Sparkles className="w-6 h-6 text-white" />
            </div>
            <div className="flex-1">
              <h3
                className="text-lg font-semibold text-white mb-1"
                style={{ fontFamily: 'var(--couple-font-heading)' }}
              >
                Ask Sage anything about your wedding
              </h3>
              <p className="text-white/80 text-sm">
                Venue details, day-of logistics, vendor recommendations, or just brainstorming ideas — Sage is here to help.
              </p>
            </div>
            <ArrowRight className="w-5 h-5 text-white/80 group-hover:translate-x-1 transition-transform shrink-0" />
          </div>
        </div>
      </Link>
    </div>
  )
}
