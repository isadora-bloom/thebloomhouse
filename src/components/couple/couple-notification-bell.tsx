'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Bell } from 'lucide-react'

interface CoupleNotification {
  id: string
  type: string
  title: string
  body: string | null
  link: string | null
  read: boolean
  created_at: string
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

/**
 * Notification bell for the couple top bar. Polls the unread count and, when
 * opened, lists recent notifications and marks them read. `base` is the couple
 * portal base path (e.g. /couple/hawthorne-manor) used to resolve item links.
 */
export function CoupleNotificationBell({ base }: { base: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [items, setItems] = useState<CoupleNotification[]>([])
  const [loading, setLoading] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const fetchUnread = useCallback(async () => {
    try {
      const res = await fetch('/api/couple/notifications?unread=true')
      if (!res.ok) return
      const json = await res.json()
      setUnread(json.data?.unread ?? 0)
    } catch {
      // Non-fatal — the bell just won't update this cycle.
    }
  }, [])

  // Poll unread count on mount and every 60s.
  useEffect(() => {
    fetchUnread()
    const t = setInterval(fetchUnread, 60000)
    return () => clearInterval(t)
  }, [fetchUnread])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  async function openPanel() {
    setOpen((v) => !v)
    if (open) return // was open, now closing
    setLoading(true)
    try {
      const res = await fetch('/api/couple/notifications')
      const json = await res.json()
      const list: CoupleNotification[] = json.data ?? []
      setItems(list)
      // Mark all read once the panel is viewed.
      if (list.some((n) => !n.read)) {
        await fetch('/api/couple/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true }),
        })
        setUnread(0)
      }
    } catch {
      // Non-fatal.
    } finally {
      setLoading(false)
    }
  }

  function handleClick(n: CoupleNotification) {
    setOpen(false)
    if (n.link) router.push(`${base}/${n.link.replace(/^\/+/, '')}`)
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={openPanel}
        className="relative flex items-center justify-center w-9 h-9 rounded-full text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
        title="Notifications"
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-bold text-white flex items-center justify-center"
            style={{ backgroundColor: 'var(--couple-accent, #A6894A)' }}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[90vw] bg-white rounded-xl shadow-lg border border-gray-100 z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-800">Notifications</p>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <div className="px-4 py-6 text-center text-sm text-gray-400">Loading…</div>
            ) : items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                You&apos;re all caught up.
              </div>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => handleClick(n)}
                  className="w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors flex gap-2"
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 mt-1.5 ${n.read ? 'bg-gray-200' : ''}`}
                    style={!n.read ? { backgroundColor: 'var(--couple-accent, #A6894A)' } : undefined}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-gray-800 leading-tight">{n.title}</span>
                    {n.body && <span className="block text-xs text-gray-500 mt-0.5 line-clamp-2">{n.body}</span>}
                    <span className="block text-[11px] text-gray-400 mt-0.5">{timeAgo(n.created_at)}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
