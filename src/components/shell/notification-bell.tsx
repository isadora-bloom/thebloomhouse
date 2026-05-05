'use client'

import { useEffect, useRef, useState } from 'react'
import { Bell, BellRing, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { formatDistanceToNow } from 'date-fns'

interface BellNotification {
  id: string
  type: string
  title: string
  body: string | null
  priority: 'low' | 'normal' | 'high' | 'urgent' | null
  created_at: string
  read: boolean
}

/**
 * Top-bar notification bell (Phase 1 audit Fix 2).
 *
 * Shows a red badge with the count of unread high/urgent notifications.
 * Clicking opens a small popover with up to 5 recent unread notifications.
 * Uses Supabase realtime to stay current without polling.
 *
 * Mark-read calls go to /api/notifications/read (PATCH) so the server-side
 * RLS policy is applied rather than relying on the anon key alone.
 */
export function NotificationBell({ venueId }: { venueId: string }) {
  const [notifications, setNotifications] = useState<BellNotification[]>([])
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const supabase = createClient()

  async function fetchNotifications() {
    const { data } = await supabase
      .from('admin_notifications')
      .select('id, type, title, body, priority, created_at, read')
      .eq('venue_id', venueId)
      .in('priority', ['high', 'urgent'])
      .eq('read', false)
      .order('created_at', { ascending: false })
      .limit(5)
    setNotifications((data ?? []) as BellNotification[])
  }

  useEffect(() => {
    if (!venueId) return
    fetchNotifications()

    const channel = supabase
      .channel(`notification-bell:${venueId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'admin_notifications',
          filter: `venue_id=eq.${venueId}`,
        },
        () => {
          fetchNotifications()
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId])

  // Close popover on outside click
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  async function markRead(id: string) {
    // Optimistic update
    setNotifications((prev) => prev.filter((n) => n.id !== id))
    try {
      await fetch('/api/notifications/read', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
    } catch {
      // Best-effort — realtime will resync on next event
    }
  }

  const count = notifications.length
  const hasUnread = count > 0

  function typeLabel(type: string): string {
    if (type === 'payment_failed') return 'Payment failed'
    if (type === 'subscription_canceled') return 'Subscription canceled'
    if (type === 'subscription_cancellation_scheduled') return 'Cancellation scheduled'
    if (type === 'subscription_upgraded') return 'Plan upgraded'
    if (type === 'escalation') return 'Escalation'
    if (type === 'auto_send_pending') return 'Auto-send pending'
    if (type === 'sage_uncertain') return 'Needs review'
    return type.replace(/_/g, ' ')
  }

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        aria-label={hasUnread ? `${count} unread urgent notifications` : 'Notifications'}
        className="relative flex items-center justify-center w-8 h-8 rounded-full text-sage-500 hover:bg-sage-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sage-400"
      >
        {hasUnread ? (
          <BellRing className="w-5 h-5 text-sage-600" />
        ) : (
          <Bell className="w-5 h-5" />
        )}
        {hasUnread && (
          <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full mt-2 w-80 bg-white border border-border rounded-xl shadow-lg z-50 overflow-hidden"
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-sage-50">
            <span className="text-sm font-semibold text-sage-800">
              {hasUnread ? `${count} urgent notification${count === 1 ? '' : 's'}` : 'No urgent notifications'}
            </span>
            <button
              onClick={() => setOpen(false)}
              className="text-sage-400 hover:text-sage-600 transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {notifications.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-sage-500">
              All clear — no urgent notifications.
            </div>
          ) : (
            <ul className="max-h-96 overflow-y-auto divide-y divide-border">
              {notifications.map((n) => (
                <li key={n.id} className="flex items-start gap-3 px-4 py-3 hover:bg-sage-50 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span
                        className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                          n.priority === 'urgent' ? 'bg-red-500' : 'bg-amber-400'
                        }`}
                      />
                      <span className="text-[11px] font-medium text-sage-500 uppercase tracking-wide truncate">
                        {typeLabel(n.type)}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-sage-900 leading-snug line-clamp-2">
                      {n.title}
                    </p>
                    {n.body && (
                      <p className="text-xs text-sage-500 mt-0.5 line-clamp-2">{n.body}</p>
                    )}
                    <p className="text-[11px] text-sage-400 mt-1">
                      {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                    </p>
                  </div>
                  <button
                    onClick={() => markRead(n.id)}
                    className="flex-shrink-0 mt-0.5 text-sage-300 hover:text-sage-500 transition-colors"
                    aria-label="Mark as read"
                    title="Mark as read"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="px-4 py-2 border-t border-border bg-sage-50 text-center">
            <a
              href="/pulse"
              className="text-xs text-sage-600 hover:text-sage-800 font-medium transition-colors"
              onClick={() => setOpen(false)}
            >
              View all in Pulse
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
