'use client'

/**
 * Tier-D #197 - bookmark-able "what's next" landing.
 *
 * Sarah-portal feedback: couples want a single screen they can tab-back-to
 * that says "do this next." The dashboard tries to do everything (stats +
 * owner note + recent messages + photo prompt + cards). This page does
 * one thing: surface the next 3-5 actions in a stack of big cards.
 *
 * Sources, ranked:
 *   1. The next overdue checklist item (red urgency)
 *   2. The next checklist item due in 14 days
 *   3. The next budget payment due in 30 days
 *   4. Most recent coordinator message (if last 7 days)
 *   5. Day-of view link if wedding is in the next 7 days
 *
 * If a couple has nothing next (everything done, wedding far away), we
 * say so plainly rather than padding with low-value items.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useCoupleContext } from '@/lib/hooks/use-couple-context'
import {
  CheckSquare,
  DollarSign,
  MessageCircle,
  Calendar,
  AlertTriangle,
  ArrowRight,
  Loader2,
  Sparkles,
} from 'lucide-react'

interface NextCard {
  key: string
  Icon: typeof CheckSquare
  urgency: 'overdue' | 'soon' | 'normal' | 'info'
  label: string
  body: string
  cta: string
  href: string
}

const URGENCY_STYLE = {
  overdue: { ring: 'ring-rose-200', bg: 'bg-rose-50', icon: 'text-rose-600', text: 'text-rose-700' },
  soon: { ring: 'ring-amber-200', bg: 'bg-amber-50', icon: 'text-amber-600', text: 'text-amber-700' },
  normal: { ring: 'ring-sage-100', bg: 'bg-warm-white', icon: 'text-sage-600', text: 'text-sage-700' },
  info: { ring: 'ring-teal-100', bg: 'bg-warm-white', icon: 'text-teal-600', text: 'text-sage-700' },
}

function daysUntil(iso: string | null): number | null {
  // Round 12 #d (2026-05-08): pin both sides to local-midnight to avoid
  // off-by-one drift around the couple's TZ midnight. ISO date-only
  // strings parse as UTC midnight; without local pinning, "due tomorrow"
  // could read as "due today" for couples east of UTC.
  if (!iso) return null
  const datePart = iso.slice(0, 10)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart)
  if (!m) return null
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
}

function fmtUntil(d: number): string {
  if (d < 0) return `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} overdue`
  if (d === 0) return 'Due today'
  if (d === 1) return 'Due tomorrow'
  if (d <= 14) return `In ${d} days`
  return `In ${d} days`
}

export default function WhatsNextPage() {
  const ctx = useCoupleContext()
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [cards, setCards] = useState<NextCard[]>([])

  useEffect(() => {
    // Round 12 fix #2 (2026-05-08): if the context has resolved but
    // there's no weddingId (coordinator viewing the URL, couple whose
    // people row hasn't been seeded), the page used to spin forever.
    // Now we resolve loading=false on the empty path so the empty
    // state can render.
    if (ctx.loading) return
    if (!ctx.weddingId) {
      setLoading(false)
      setCards([])
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createClient()
        const wid = ctx.weddingId
        const slug = ctx.slug
        const todayIso = new Date().toISOString().split('T')[0]
        const fourteenDaysOut = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        const thirtyDaysOut = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

        const [overdueRes, upcomingRes, paymentRes, msgRes] = await Promise.all([
          supabase
            .from('checklist_items')
            .select('id, title, due_date')
            .eq('wedding_id', wid)
            .eq('is_completed', false)
            .lt('due_date', todayIso)
            .not('due_date', 'is', null)
            .order('due_date', { ascending: true })
            .limit(1),
          supabase
            .from('checklist_items')
            .select('id, title, due_date')
            .eq('wedding_id', wid)
            .eq('is_completed', false)
            .gte('due_date', todayIso)
            .lte('due_date', fourteenDaysOut)
            .order('due_date', { ascending: true })
            .limit(1),
          supabase
            .from('budget_items')
            .select('item_name, payment_due_date, budgeted, paid, committed')
            .eq('wedding_id', wid)
            .gte('payment_due_date', todayIso)
            .lte('payment_due_date', thirtyDaysOut)
            .order('payment_due_date', { ascending: true })
            .limit(1),
          supabase
            .from('interactions')
            .select('id, subject, body_preview, timestamp, direction')
            .eq('wedding_id', wid)
            .eq('direction', 'outbound')
            .gte('timestamp', sevenDaysAgo)
            .order('timestamp', { ascending: false })
            .limit(1),
        ])

        if (cancelled) return

        const next: NextCard[] = []

        const overdue = (overdueRes.data ?? [])[0] as { id: string; title: string; due_date: string } | undefined
        if (overdue) {
          const d = daysUntil(overdue.due_date) ?? 0
          next.push({
            key: `cl-overdue-${overdue.id}`,
            Icon: AlertTriangle,
            urgency: 'overdue',
            label: 'Overdue checklist item',
            body: overdue.title,
            cta: fmtUntil(d),
            href: `/couple/${slug}/checklist`,
          })
        }

        const upcoming = (upcomingRes.data ?? [])[0] as { id: string; title: string; due_date: string } | undefined
        if (upcoming) {
          const d = daysUntil(upcoming.due_date) ?? 0
          next.push({
            key: `cl-up-${upcoming.id}`,
            Icon: CheckSquare,
            urgency: d <= 3 ? 'soon' : 'normal',
            label: 'Next checklist item',
            body: upcoming.title,
            cta: fmtUntil(d),
            href: `/couple/${slug}/checklist`,
          })
        }

        const payment = (paymentRes.data ?? [])[0] as { item_name: string; payment_due_date: string; budgeted: number | null; paid: number | null; committed: number | null } | undefined
        if (payment) {
          const d = daysUntil(payment.payment_due_date) ?? 0
          const owe = (Number(payment.budgeted ?? payment.committed ?? 0) - Number(payment.paid ?? 0))
          next.push({
            key: `pay-${payment.item_name}`,
            Icon: DollarSign,
            urgency: d <= 7 ? 'soon' : 'normal',
            label: `Next payment${owe > 0 ? ` ($${owe.toLocaleString()})` : ''}`,
            body: payment.item_name,
            cta: fmtUntil(d),
            href: `/couple/${slug}/budget`,
          })
        }

        const msg = (msgRes.data ?? [])[0] as { id: string; subject: string | null; body_preview: string | null; timestamp: string } | undefined
        if (msg) {
          const ageHours = Math.round((Date.now() - new Date(msg.timestamp).getTime()) / 36e5)
          next.push({
            key: `msg-${msg.id}`,
            Icon: MessageCircle,
            urgency: 'info',
            label: 'Recent message from your venue',
            body: msg.subject || msg.body_preview?.slice(0, 80) || '(no subject)',
            cta: ageHours < 24 ? `${ageHours}h ago` : `${Math.floor(ageHours / 24)}d ago`,
            href: `/couple/${slug}/messages`,
          })
        }

        if (ctx.weddingDate) {
          const d = daysUntil(ctx.weddingDate)
          if (d != null && d >= 0 && d <= 7) {
            next.push({
              key: 'day-of',
              Icon: Calendar,
              urgency: 'soon',
              label: 'Your day is almost here',
              body: 'Open the day-of view for everything in one tap-friendly screen.',
              cta: d === 0 ? 'Today' : `In ${d} day${d === 1 ? '' : 's'}`,
              href: `/couple/${slug}/day-of`,
            })
          }
        }

        setCards(next)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [ctx.weddingId, ctx.slug, ctx.weddingDate, ctx.loading])

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="w-6 h-6 animate-spin text-sage-400" />
      </div>
    )
  }

  if (err) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-700">
          Could not load: {err}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-serif text-sage-900">What's next</h1>
        <p className="text-sm text-sage-500">
          The few things that matter right now. Bookmark this page.
        </p>
      </div>

      {cards.length === 0 ? (
        <div className="bg-warm-white border border-border rounded-2xl p-10 text-center space-y-3">
          <Sparkles className="w-10 h-10 text-sage-300 mx-auto" />
          <h3 className="text-base font-medium text-sage-800">You're caught up</h3>
          <p className="text-sm text-sage-500">
            No overdue items, no payments due in the next 30 days, and no recent messages waiting. Take the evening off.
          </p>
        </div>
      ) : (
        cards.map((c) => {
          const sty = URGENCY_STYLE[c.urgency]
          const Icon = c.Icon
          return (
            <Link
              key={c.key}
              href={c.href}
              className={`flex items-start gap-4 p-5 rounded-2xl ring-1 ${sty.ring} ${sty.bg} hover:shadow-sm transition-shadow`}
            >
              <Icon className={`w-6 h-6 ${sty.icon} flex-shrink-0 mt-1`} />
              <div className="flex-1 min-w-0">
                <p className="text-xs uppercase tracking-wider text-sage-500 mb-1">{c.label}</p>
                <p className="text-base font-medium text-sage-900 truncate">{c.body}</p>
                <p className={`text-sm mt-1 ${sty.text}`}>{c.cta}</p>
              </div>
              <ArrowRight className="w-5 h-5 text-sage-400 flex-shrink-0 mt-2" />
            </Link>
          )
        })
      )}
    </div>
  )
}
