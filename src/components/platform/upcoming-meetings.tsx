'use client'

/**
 * Upcoming Calendly Meetings — coordinator dashboard widget.
 *
 * Calls GET /api/calendly/events and renders the next 5 events with date,
 * time, attendee, and event-type label. Handles three states:
 *   - notConfigured → prompt to connect under Settings
 *   - reconnect     → token expired, link to Settings
 *   - happy path    → list (or empty-state when no upcoming events)
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Calendar, ArrowRight, AlertCircle, Plug } from 'lucide-react'

interface CalendlyInvitee {
  name: string | null
  email: string | null
}

interface CalendlyEvent {
  uuid: string
  name: string | null
  start_time: string
  end_time: string
  location: string | null
  status: string
  event_type: string | null
  invitees: CalendlyInvitee[]
}

interface ApiResponse {
  events: CalendlyEvent[]
  notConfigured?: boolean
  reconnect?: boolean
  message?: string
}

const PAGE_SIZE = 5

function formatDate(iso: string): { day: string; time: string } {
  const d = new Date(iso)
  const day = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
  return { day, time }
}

export function UpcomingMeetings({ limit = PAGE_SIZE }: { limit?: number }) {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/calendly/events?limit=${limit + 5}`, {
          cache: 'no-store',
        })
        if (!res.ok) {
          throw new Error(`Request failed (${res.status})`)
        }
        const json = (await res.json()) as ApiResponse
        if (!cancelled) setData(json)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [limit])

  return (
    <div className="bg-surface border border-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Calendar className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Upcoming Meetings
          </h2>
        </div>
        <Link
          href="/settings"
          className="text-xs text-sage-600 hover:text-sage-800 flex items-center gap-1"
        >
          Settings <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 bg-sage-50 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <p className="text-sm text-red-600 py-4">{error}</p>
      ) : data?.notConfigured ? (
        <div className="py-4 flex items-start gap-3">
          <Plug className="w-4 h-4 text-sage-400 mt-0.5 shrink-0" />
          <div className="text-sm text-sage-700">
            Connect Calendly under{' '}
            <Link href="/settings" className="text-sage-800 underline hover:text-sage-900">
              Settings &rarr; Integrations
            </Link>{' '}
            to see upcoming tours and consultations here.
          </div>
        </div>
      ) : data?.reconnect ? (
        <div className="py-4 flex items-start gap-3">
          <AlertCircle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
          <div className="text-sm text-sage-700">
            Calendly access expired. Reconnect under{' '}
            <Link href="/settings" className="text-sage-800 underline hover:text-sage-900">
              Settings
            </Link>
            .
          </div>
        </div>
      ) : !data?.events || data.events.length === 0 ? (
        <p className="text-sm text-muted py-6 text-center">
          No upcoming Calendly events.
        </p>
      ) : (
        <ul className="space-y-3">
          {data.events.slice(0, limit).map((ev) => {
            const { day, time } = formatDate(ev.start_time)
            const attendee = ev.invitees[0]
            const attendeeLabel =
              attendee?.name || attendee?.email || 'Pending invitee'
            return (
              <li
                key={ev.uuid}
                className="flex items-start gap-3 p-3 rounded-lg bg-sage-50/50"
              >
                <div className="flex flex-col items-center justify-center bg-sage-100 text-sage-700 rounded-lg px-2 py-1 shrink-0 min-w-[64px]">
                  <span className="text-[10px] uppercase tracking-wider font-semibold leading-tight">
                    {day.split(',')[0]}
                  </span>
                  <span className="text-xs font-medium leading-tight">
                    {day.split(',')[1]?.trim()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-sage-800 line-clamp-1">
                    {ev.name || 'Calendly event'}
                  </p>
                  <p className="text-xs text-muted mt-0.5 line-clamp-1">
                    {time} &middot; {attendeeLabel}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default UpcomingMeetings
