'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  Mail, FileCheck, Newspaper, Heart,
  TrendingUp, DollarSign, ArrowRight,
} from 'lucide-react'
import { useVenueId } from '@/lib/hooks/use-venue-id'

interface Stats {
  activeInquiries: number
  upcomingWeddings: number
  pendingDrafts: number
  aiCost: number
}

interface Activity {
  id: string
  type: string
  summary: string
  created_at: string
}

export default function DashboardPage() {
  const VENUE_ID = useVenueId()
  const [stats, setStats] = useState<Stats>({
    activeInquiries: 0,
    upcomingWeddings: 0,
    pendingDrafts: 0,
    aiCost: 0,
  })
  const [activities, setActivities] = useState<Activity[]>([])
  const [venueName, setVenueName] = useState('Your Venue')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const supabase = createClient()

      // Venue name
      const { data: venue } = await supabase
        .from('venues')
        .select('name')
        .eq('id', VENUE_ID)
        .single()
      if (venue) setVenueName(venue.name)

      // Active inquiries
      const { count: inquiryCount } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', VENUE_ID)
        .eq('status', 'inquiry')

      // Upcoming weddings (next 30 days)
      const now = new Date()
      const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      const { count: upcomingCount } = await supabase
        .from('weddings')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', VENUE_ID)
        .gte('wedding_date', now.toISOString().split('T')[0])
        .lte('wedding_date', thirtyDays.toISOString().split('T')[0])

      // Pending drafts
      const { count: draftCount } = await supabase
        .from('drafts')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', VENUE_ID)
        .eq('status', 'pending')

      // AI cost this month
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
        .toISOString()
      const { data: costData } = await supabase
        .from('api_costs')
        .select('total_cost')
        .eq('venue_id', VENUE_ID)
        .gte('created_at', monthStart)

      const totalCost = (costData ?? []).reduce(
        (sum: number, row: { total_cost: number }) => sum + (row.total_cost ?? 0),
        0
      )

      setStats({
        activeInquiries: inquiryCount ?? 0,
        upcomingWeddings: upcomingCount ?? 0,
        pendingDrafts: draftCount ?? 0,
        aiCost: totalCost,
      })

      // Recent activity
      const { data: activityData } = await supabase
        .from('interactions')
        .select('id, type, summary, created_at')
        .eq('venue_id', VENUE_ID)
        .order('created_at', { ascending: false })
        .limit(5)

      setActivities((activityData as Activity[]) ?? [])
      setLoading(false)
    }

    if (VENUE_ID) load()
  }, [VENUE_ID])

  const statCards = [
    {
      label: 'Active Inquiries',
      value: stats.activeInquiries,
      icon: Mail,
      color: 'text-sage-600',
      bg: 'bg-sage-50',
    },
    {
      label: 'Upcoming Weddings',
      value: stats.upcomingWeddings,
      icon: Heart,
      color: 'text-rose-600',
      bg: 'bg-rose-50',
    },
    {
      label: 'Pending Drafts',
      value: stats.pendingDrafts,
      icon: FileCheck,
      color: 'text-teal-600',
      bg: 'bg-teal-50',
    },
    {
      label: 'AI Cost This Month',
      value: `$${stats.aiCost.toFixed(2)}`,
      icon: DollarSign,
      color: 'text-gold-600',
      bg: 'bg-gold-50',
    },
  ]

  const quickActions = [
    {
      label: 'View Inbox',
      href: '/agent/inbox',
      icon: Mail,
      description: 'Review incoming inquiries',
    },
    {
      label: 'Check Briefings',
      href: '/intel/briefings',
      icon: Newspaper,
      description: 'Latest intelligence reports',
    },
    {
      label: 'Review Drafts',
      href: '/agent/drafts',
      icon: FileCheck,
      description: 'Approve AI-generated responses',
    },
  ]

  return (
    <div className="space-y-8">
      {/* Welcome */}
      <div>
        <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
          Welcome back
        </h1>
        <p className="text-sage-600 text-lg">
          Here&apos;s what&apos;s happening at <span className="font-medium text-sage-800">{venueName}</span>
        </p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => (
          <div
            key={card.label}
            className="bg-surface border border-border rounded-xl p-5 flex items-start gap-4"
          >
            <div className={`${card.bg} p-2.5 rounded-lg`}>
              <card.icon className={`w-5 h-5 ${card.color}`} />
            </div>
            <div>
              <p className="text-sm text-muted">{card.label}</p>
              <p className="text-2xl font-bold text-sage-900 mt-0.5">
                {loading ? (
                  <span className="inline-block w-10 h-7 bg-sage-100 rounded animate-pulse" />
                ) : (
                  card.value
                )}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Activity */}
        <div className="lg:col-span-2 bg-surface border border-border rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              Recent Activity
            </h2>
            <TrendingUp className="w-4 h-4 text-sage-400" />
          </div>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-sage-50 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : activities.length === 0 ? (
            <p className="text-sm text-muted py-8 text-center">
              No recent activity. Interactions will appear here as they come in.
            </p>
          ) : (
            <ul className="space-y-3">
              {activities.map((a) => (
                <li
                  key={a.id}
                  className="flex items-start gap-3 p-3 rounded-lg bg-sage-50/50"
                >
                  <div className="w-2 h-2 mt-2 rounded-full bg-sage-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-sage-800 line-clamp-1">
                      {a.summary || a.type}
                    </p>
                    <p className="text-xs text-muted mt-0.5">
                      {new Date(a.created_at).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-sage-500 bg-sage-100 px-2 py-0.5 rounded-full shrink-0">
                    {a.type}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Quick Actions */}
        <div className="space-y-3">
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Quick Actions
          </h2>
          {quickActions.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="flex items-center gap-4 p-4 bg-surface border border-border rounded-xl hover:border-sage-300 hover:shadow-sm transition-all group"
            >
              <div className="bg-sage-50 p-2.5 rounded-lg group-hover:bg-sage-100 transition-colors">
                <action.icon className="w-5 h-5 text-sage-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-sage-800">{action.label}</p>
                <p className="text-xs text-muted">{action.description}</p>
              </div>
              <ArrowRight className="w-4 h-4 text-sage-400 group-hover:text-sage-600 transition-colors" />
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
