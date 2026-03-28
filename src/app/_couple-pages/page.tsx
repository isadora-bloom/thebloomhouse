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
} from 'lucide-react'

// TODO: Get wedding ID from auth session / couple's user profile
const WEDDING_ID = '44444444-4444-4444-4444-444444000109'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DashboardData {
  coupleNames: string
  weddingDate: string | null
  guestCount: number | null
  guestsAttending: number
  guestsPending: number
  budgetEstimated: number
  budgetActual: number
  budgetPaid: number
  checklistTotal: number
  checklistDone: number
  upcomingTimeline: Array<{
    id: string
    title: string
    time: string | null
    category: string | null
  }>
  recentMessages: Array<{
    id: string
    content: string
    sender_role: string | null
    created_at: string
  }>
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

function fmt$(value: number): string {
  return `$${Math.round(value).toLocaleString()}`
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

export default function CoupleDashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

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
        const [guests, budget, checklist, timeline, messages] = await Promise.all([
          supabase.from('guest_list').select('id, rsvp_status').eq('wedding_id', WEDDING_ID),
          supabase.from('budget').select('estimated_cost, actual_cost, paid_amount').eq('wedding_id', WEDDING_ID),
          supabase.from('checklist_items').select('id, is_completed').eq('wedding_id', WEDDING_ID),
          supabase
            .from('timeline')
            .select('id, title, time, category')
            .eq('wedding_id', WEDDING_ID)
            .order('time', { ascending: true })
            .limit(5),
          supabase
            .from('messages')
            .select('id, content, sender_role, created_at')
            .eq('wedding_id', WEDDING_ID)
            .order('created_at', { ascending: false })
            .limit(3),
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
        const budgetItems = budget.data || []
        const checklistItems = checklist.data || []

        setData({
          coupleNames,
          weddingDate: wedding.wedding_date,
          guestCount: wedding.guest_count_estimate,
          guestsAttending: guestList.filter((g) => g.rsvp_status === 'attending').length,
          guestsPending: guestList.filter((g) => g.rsvp_status === 'pending').length,
          budgetEstimated: budgetItems.reduce((s, b) => s + (Number(b.estimated_cost) || 0), 0),
          budgetActual: budgetItems.reduce((s, b) => s + (Number(b.actual_cost) || 0), 0),
          budgetPaid: budgetItems.reduce((s, b) => s + (Number(b.paid_amount) || 0), 0),
          checklistTotal: checklistItems.length,
          checklistDone: checklistItems.filter((c) => c.is_completed).length,
          upcomingTimeline: (timeline.data || []) as DashboardData['upcomingTimeline'],
          recentMessages: (messages.data || []) as DashboardData['recentMessages'],
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
  const budgetRemaining = data.budgetEstimated - data.budgetPaid

  return (
    <div className="space-y-8">
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
      </div>

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
            remaining of {fmt$(data.budgetEstimated)}
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
              href="/timeline"
              className="text-sm font-medium flex items-center gap-1 hover:underline"
              style={{ color: 'var(--couple-primary)' }}
            >
              View all <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          <div className="p-5">
            {data.upcomingTimeline.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">
                No timeline items yet. Start building your day-of timeline!
              </p>
            ) : (
              <div className="space-y-3">
                {data.upcomingTimeline.map((item) => (
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
                        {item.time || 'Time TBD'}
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
              href="/chat"
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
