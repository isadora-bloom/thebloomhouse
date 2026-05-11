/**
 * Settings → Integrations → Calendly  (Stream 8)
 *
 * Honest read-only summary of Calendly configuration today. Calendly
 * tour booking is wired through tour_booking_links on venue_ai_config,
 * which is edited at /settings/sage-identity. The webhook handler at
 * /api/webhooks/calendly is always live (env-var-guarded by
 * CALENDLY_WEBHOOK_SECRET) and writes engagement events when an
 * invitee is created.
 *
 * Long-term we want a proper Calendly OAuth connection table + sync
 * state; for now the operator just sees their configured booking links
 * with a clear "Edit links" jump.
 */

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import {
  Calendar,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
} from 'lucide-react'

export const dynamic = 'force-dynamic'

interface TourLink {
  label: string
  url: string
  isDefault: boolean
  isCalendly: boolean
}

export default async function CalendlyIntegrationPage() {
  const auth = await getPlatformAuth()
  if (!auth) redirect('/login?redirect=/settings/integrations/calendly')

  const supabase = createServiceClient()
  const { data } = await supabase
    .from('venue_ai_config')
    .select('tour_booking_links')
    .eq('venue_id', auth.venueId)
    .maybeSingle()

  const rawLinks = (data as { tour_booking_links?: unknown } | null)?.tour_booking_links
  const links: TourLink[] = Array.isArray(rawLinks)
    ? rawLinks
        .filter((l): l is { label?: unknown; url?: unknown; is_default?: unknown } =>
          l !== null && typeof l === 'object',
        )
        .map((l) => {
          const url = typeof l.url === 'string' ? l.url : ''
          return {
            label: typeof l.label === 'string' && l.label.trim() ? l.label : 'Book a tour',
            url,
            isDefault: Boolean(l.is_default),
            isCalendly: url.toLowerCase().includes('calendly.com'),
          }
        })
        .filter((l) => l.url.length > 0)
    : []

  const calendlyLinks = links.filter((l) => l.isCalendly)
  const otherLinks = links.filter((l) => !l.isCalendly)
  const connected = calendlyLinks.length > 0

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <Link
          href="/settings/integrations"
          className="inline-flex items-center gap-1 text-xs text-sage-600 hover:text-sage-900"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Integrations
        </Link>
      </div>

      <header className="flex items-start gap-3">
        <Calendar className="w-6 h-6 text-sage-600 mt-1" />
        <div>
          <h1 className="text-2xl font-serif text-sage-900">Calendly</h1>
          <p className="text-sm text-sage-600 mt-1">
            When a couple books through your Calendly link, the booking lands
            as a tour touchpoint on their lead timeline.
          </p>
        </div>
      </header>

      <section className="border border-border rounded-lg bg-warm-white p-4 space-y-3">
        <div className="flex items-center gap-2">
          {connected ? (
            <>
              <CheckCircle2 className="w-5 h-5 text-sage-600" />
              <span className="text-sm font-medium text-sage-900">
                {calendlyLinks.length} Calendly link{calendlyLinks.length === 1 ? '' : 's'} configured
              </span>
            </>
          ) : (
            <>
              <AlertTriangle className="w-5 h-5 text-amber-600" />
              <span className="text-sm font-medium text-sage-900">
                No Calendly link configured
              </span>
            </>
          )}
        </div>
        <p className="text-xs text-sage-600">
          Tour booking links are edited at Sage Identity. Sage offers the
          default link by default when a couple asks for a tour.
        </p>
        <div>
          <Link
            href="/settings/sage-identity"
            className="inline-flex items-center gap-1 text-xs font-medium text-sage-700 hover:text-sage-900"
          >
            Edit tour links
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </section>

      {calendlyLinks.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-sage-800">Calendly links</h2>
          <ul className="space-y-2">
            {calendlyLinks.map((link, idx) => (
              <li
                key={`${link.url}-${idx}`}
                className="flex items-center justify-between gap-3 border border-sage-200 rounded-lg px-3 py-2 bg-sage-50/40"
              >
                <div className="min-w-0">
                  <div className="text-sm text-sage-900 truncate">
                    {link.label}
                    {link.isDefault && (
                      <span className="ml-2 text-[10px] uppercase tracking-wide bg-sage-100 text-sage-700 px-1.5 py-0.5 rounded">
                        Default
                      </span>
                    )}
                  </div>
                  <code className="text-xs text-sage-600 truncate block">{link.url}</code>
                </div>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="shrink-0 text-sage-600 hover:text-sage-900"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {otherLinks.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-sage-800">Other booking links</h2>
          <p className="text-xs text-sage-500">
            Non-Calendly links Sage may also offer (e.g. HoneyBook scheduler,
            direct email-for-tour). They don&apos;t flow through the Calendly
            webhook.
          </p>
          <ul className="space-y-2">
            {otherLinks.map((link, idx) => (
              <li
                key={`${link.url}-${idx}`}
                className="flex items-center justify-between gap-3 border border-border rounded-lg px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="text-sm text-sage-900 truncate">{link.label}</div>
                  <code className="text-xs text-sage-600 truncate block">{link.url}</code>
                </div>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="shrink-0 text-sage-600 hover:text-sage-900"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="border border-sage-200 bg-sage-50/40 rounded-lg p-4 space-y-2">
        <h3 className="text-sm font-medium text-sage-800">Webhook</h3>
        <p className="text-xs text-sage-600">
          Calendly is wired up via webhook on the Calendly side — there is
          no per-venue secret to manage here today. Bookings land
          automatically the moment your link is configured. A dedicated
          Calendly OAuth + sync surface is on the roadmap.
        </p>
      </section>
    </div>
  )
}
