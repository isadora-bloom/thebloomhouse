'use client'

/**
 * Phase E core surface: per-couple journey ribbon.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §5 (Journey Ribbon — every
 * confirmed touch for one identity rendered as a single cross-channel
 * timeline). This is the surface that turns "Susan uploaded her HoneyBook
 * CSV and connected Gmail" into "look, here's every time Emma &amp; Jake
 * touched us, in order, across every channel, from first Knot view to
 * booking signature."
 *
 * Sections (top to bottom)
 * ------------------------
 *  - Couple header (name, partner, lifecycle, primary contact)
 *  - Identity-profile card (when couple_identity_profile row exists)
 *  - Journey ribbon: every touchpoint by occurred_at, channel-grouped
 *  - Candidate matches (medium / low confidence pending review)
 *  - Linked fragments (cross-channel signals not yet promoted)
 *
 * Read-only. Operator actions on candidate matches happen on
 * /intel/identity-review; this page is the "what do we know about
 * this couple" view.
 */

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  ArrowLeft,
  Mail,
  Phone,
  Calendar,
  Activity,
  AlertTriangle,
  Sparkles,
  Inbox,
  Globe,
  Hash,
  Pin,
  Heart,
  Camera,
  Users as UsersIcon,
  HelpCircle,
} from 'lucide-react'

type LifecycleState = 'channel_scoped' | 'booked' | 'resolved' | 'ghost' | 'agent'

interface CoupleDetail {
  id: string
  venue_id: string
  primary_contact_name: string | null
  primary_contact_email: string | null
  primary_contact_phone: string | null
  partner_contact_name: string | null
  partner_contact_email: string | null
  partner_contact_phone: string | null
  lifecycle_state: LifecycleState | null
  wedding_date: string | null
  source_wedding_id: string | null
  updated_at: string
  created_at: string
}

interface Touchpoint {
  id: string
  channel: string
  signal_tier: string
  action_type: string
  external_id: string
  occurred_at: string
  raw_payload: Record<string, unknown> | null
  confidence_tier: string | null
}

interface CandidateMatch {
  id: string
  primary_record_id: string
  primary_record_type: string
  secondary_record_id: string
  secondary_record_type: string
  confidence_tier: string
  matcher_reason: string | null
  resolution: string | null
  occurred_at: string
}

interface Fragment {
  id: string
  channel: string
  identity_hint: string | null
  external_id: string
  occurred_at: string
  raw_payload: Record<string, unknown> | null
}

interface IdentityProfile {
  couple_id: string
  primary_first_name: string | null
  primary_last_name: string | null
  partner_first_name: string | null
  partner_last_name: string | null
  primary_occupation: string | null
  partner_occupation: string | null
  primary_city: string | null
  primary_state: string | null
  emotional_themes: string[] | null
  family_dynamics_summary: string | null
  updated_at: string
}

function channelIcon(channel: string) {
  const c = channel.toLowerCase()
  if (c === 'gmail' || c.includes('email'))
    return <Mail className="h-4 w-4 text-rose-600" />
  if (c === 'calendly') return <Calendar className="h-4 w-4 text-sky-600" />
  if (c === 'knot' || c === 'theknot')
    return <Heart className="h-4 w-4 text-pink-600" />
  if (c === 'weddingwire') return <Heart className="h-4 w-4 text-amber-600" />
  if (c === 'instagram') return <Hash className="h-4 w-4 text-violet-600" />
  if (c === 'pinterest') return <Pin className="h-4 w-4 text-red-600" />
  if (c === 'website') return <Globe className="h-4 w-4 text-emerald-600" />
  if (c === 'phone' || c === 'openphone' || c === 'sms')
    return <Phone className="h-4 w-4 text-emerald-700" />
  if (c === 'photo' || c === 'tour') return <Camera className="h-4 w-4 text-stone-600" />
  return <Activity className="h-4 w-4 text-stone-500" />
}

function tierColor(tier: string) {
  if (tier === 'highest' || tier === 'high')
    return 'bg-emerald-50 border-emerald-200 text-emerald-800'
  if (tier === 'medium_high' || tier === 'medium')
    return 'bg-amber-50 border-amber-200 text-amber-800'
  return 'bg-stone-50 border-stone-200 text-stone-700'
}

function actionLabel(action: string): string {
  return action.replace(/_/g, ' ')
}

function groupByDay(events: Array<{ occurred_at: string }>): Map<string, number[]> {
  const map = new Map<string, number[]>()
  events.forEach((e, idx) => {
    const day = (e.occurred_at ?? '').slice(0, 10)
    const arr = map.get(day) ?? []
    arr.push(idx)
    map.set(day, arr)
  })
  return map
}

export default function CoupleDetailPage() {
  const params = useParams()
  const router = useRouter()
  const coupleId = String(params?.id ?? '')
  const supabase = useMemo(() => createClient(), [])

  const [couple, setCouple] = useState<CoupleDetail | null>(null)
  const [touchpoints, setTouchpoints] = useState<Touchpoint[]>([])
  const [candidates, setCandidates] = useState<CandidateMatch[]>([])
  const [fragments, setFragments] = useState<Fragment[]>([])
  const [profile, setProfile] = useState<IdentityProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!coupleId) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      // 1. Couple
      const { data: c, error: cErr } = await supabase
        .from('couples')
        .select(
          'id, venue_id, primary_contact_name, primary_contact_email, primary_contact_phone, partner_contact_name, partner_contact_email, partner_contact_phone, lifecycle_state, wedding_date, source_wedding_id, updated_at, created_at',
        )
        .eq('id', coupleId)
        .maybeSingle()
      if (cancelled) return
      if (cErr || !c) {
        setError(cErr?.message ?? 'Couple not found')
        setLoading(false)
        return
      }
      setCouple(c as CoupleDetail)

      // 2. Touchpoints + candidates + identity profile in parallel.
      const [tpRes, candRes, profRes] = await Promise.all([
        supabase
          .from('touchpoints')
          .select(
            'id, channel, signal_tier, action_type, external_id, occurred_at, raw_payload, confidence_tier',
          )
          .eq('couple_id', coupleId)
          .order('occurred_at', { ascending: true })
          .limit(500),
        supabase
          .from('candidate_matches')
          .select(
            'id, primary_record_id, primary_record_type, secondary_record_id, secondary_record_type, confidence_tier, matcher_reason, resolution, occurred_at',
          )
          .or(`primary_record_id.eq.${coupleId},secondary_record_id.eq.${coupleId}`)
          .is('resolution', null)
          .order('occurred_at', { ascending: false })
          .limit(50),
        supabase
          .from('couple_identity_profile')
          .select('*')
          .eq('couple_id', coupleId)
          .maybeSingle(),
      ])
      if (cancelled) return

      setTouchpoints(((tpRes.data ?? []) as Touchpoint[]))
      setCandidates(((candRes.data ?? []) as CandidateMatch[]))
      const prof = profRes.data as IdentityProfile | null
      setProfile(prof)

      // 3. Pull fragments + orphan touchpoints referenced by open
      //    candidate_matches for this couple. Post-migration 347 a
      //    candidate references either a fragment or a touchpoint
      //    record_type; older rows may still mislabel touchpoints
      //    as 'fragment'. Try both tables for safety.
      const candidateRows = (candRes.data ?? []) as CandidateMatch[]
      const referencedIds = candidateRows
        .flatMap((m) => {
          const out: string[] = []
          if (m.primary_record_type === 'fragment' || m.primary_record_type === 'touchpoint')
            out.push(m.primary_record_id)
          if (m.secondary_record_type === 'fragment' || m.secondary_record_type === 'touchpoint')
            out.push(m.secondary_record_id)
          return out
        })
      if (referencedIds.length > 0) {
        const [fRes, tRes] = await Promise.all([
          supabase
            .from('fragments')
            .select('id, channel, identity_hint, external_id, occurred_at, raw_payload')
            .in('id', referencedIds),
          supabase
            .from('touchpoints')
            .select('id, channel, action_type, external_id, occurred_at, raw_payload')
            .in('id', referencedIds),
        ])
        if (cancelled) return
        // Touchpoints have action_type instead of identity_hint; coerce
        // into the Fragment shape so the candidate card renders
        // consistently regardless of underlying record kind.
        const fragRows = ((fRes.data ?? []) as Fragment[])
        const tpRows = ((tRes.data ?? []) as Array<{
          id: string
          channel: string
          action_type: string
          external_id: string
          occurred_at: string
          raw_payload: Record<string, unknown> | null
        }>).map((t) => ({
          id: t.id,
          channel: t.channel,
          identity_hint: t.action_type,
          external_id: t.external_id,
          occurred_at: t.occurred_at,
          raw_payload: t.raw_payload,
        }))
        setFragments([...fragRows, ...tpRows])
      }
      setLoading(false)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [coupleId, supabase])

  const byDay = useMemo(() => groupByDay(touchpoints), [touchpoints])

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl p-8 text-sm text-stone-500">
        Loading couple...
      </div>
    )
  }

  if (error || !couple) {
    return (
      <div className="mx-auto max-w-5xl p-8">
        <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>
            <strong>Couldn't load couple.</strong> {error ?? 'Not found.'}
          </div>
        </div>
      </div>
    )
  }

  const displayName =
    couple.primary_contact_name ?? couple.primary_contact_email ?? '(unnamed couple)'
  const partner = couple.partner_contact_name
  const firstTouch = touchpoints[0]?.occurred_at
  const lastTouch = touchpoints[touchpoints.length - 1]?.occurred_at
  const channelSet = new Set(touchpoints.map((t) => t.channel))

  return (
    <div className="mx-auto max-w-5xl p-8">
      <button
        onClick={() => router.push('/intel/couples')}
        className="mb-4 flex items-center gap-1 text-sm text-stone-500 hover:text-stone-900"
      >
        <ArrowLeft className="h-4 w-4" /> All couples
      </button>

      <div className="mb-6">
        <h1 className="font-serif text-3xl text-stone-900">
          {displayName}
          {partner && <span className="text-stone-500"> &amp; {partner}</span>}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-stone-600">
          {couple.primary_contact_email && (
            <span className="flex items-center gap-1">
              <Mail className="h-3 w-3" /> {couple.primary_contact_email}
            </span>
          )}
          {couple.primary_contact_phone && (
            <span className="flex items-center gap-1">
              <Phone className="h-3 w-3" /> {couple.primary_contact_phone}
            </span>
          )}
          {couple.wedding_date && (
            <span className="flex items-center gap-1">
              <Calendar className="h-3 w-3" />{' '}
              {new Date(couple.wedding_date).toLocaleDateString()}
            </span>
          )}
          <span className="inline-flex items-center rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 text-xs text-stone-600">
            {couple.lifecycle_state ?? 'unknown'}
          </span>
          <span className="text-xs text-stone-400">
            {channelSet.size} channels · {touchpoints.length} touchpoints
          </span>
        </div>
      </div>

      {profile && (
        <div className="mb-8 rounded-lg border border-violet-200 bg-violet-50/50 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-700" />
            <h2 className="text-sm font-semibold text-violet-900">
              Identity profile
            </h2>
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm text-stone-700">
            {(profile.primary_first_name || profile.primary_last_name) && (
              <div>
                <span className="text-xs uppercase text-stone-500">Primary</span>
                <div>
                  {[profile.primary_first_name, profile.primary_last_name]
                    .filter(Boolean)
                    .join(' ')}
                  {profile.primary_occupation && (
                    <span className="text-stone-500">
                      {' · '}
                      {profile.primary_occupation}
                    </span>
                  )}
                </div>
              </div>
            )}
            {(profile.partner_first_name || profile.partner_last_name) && (
              <div>
                <span className="text-xs uppercase text-stone-500">Partner</span>
                <div>
                  {[profile.partner_first_name, profile.partner_last_name]
                    .filter(Boolean)
                    .join(' ')}
                  {profile.partner_occupation && (
                    <span className="text-stone-500">
                      {' · '}
                      {profile.partner_occupation}
                    </span>
                  )}
                </div>
              </div>
            )}
            {(profile.primary_city || profile.primary_state) && (
              <div>
                <span className="text-xs uppercase text-stone-500">Location</span>
                <div>
                  {[profile.primary_city, profile.primary_state]
                    .filter(Boolean)
                    .join(', ')}
                </div>
              </div>
            )}
            {profile.emotional_themes && profile.emotional_themes.length > 0 && (
              <div className="col-span-2">
                <span className="text-xs uppercase text-stone-500">Themes</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {profile.emotional_themes.map((t) => (
                    <span
                      key={t}
                      className="rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-800"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {profile.family_dynamics_summary && (
              <div className="col-span-2 text-sm italic text-stone-700">
                "{profile.family_dynamics_summary}"
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-700">
          Journey ribbon
        </h2>
        {firstTouch && lastTouch && (
          <span className="text-xs text-stone-500">
            {new Date(firstTouch).toLocaleDateString()} →{' '}
            {new Date(lastTouch).toLocaleDateString()}
          </span>
        )}
      </div>

      <div className="rounded-lg border border-stone-200 bg-white">
        {touchpoints.length === 0 ? (
          <div className="p-8 text-center text-sm text-stone-500">
            No touchpoints recorded yet. The Tracer or Forwards Linker will
            populate this view as signals arrive.
          </div>
        ) : (
          <div className="divide-y divide-stone-100">
            {Array.from(byDay.entries()).map(([day, indices]) => (
              <div key={day} className="px-4 py-3">
                <div className="mb-2 text-xs uppercase tracking-wide text-stone-500">
                  {new Date(day).toLocaleDateString(undefined, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </div>
                <ol className="space-y-2 border-l-2 border-stone-200 pl-4">
                  {indices.map((i) => {
                    const t = touchpoints[i]!
                    const time = new Date(t.occurred_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                    return (
                      <li
                        key={t.id}
                        className={`relative -ml-4 flex items-start gap-3 rounded-md border bg-white pl-3 pr-3 py-2 ${tierColor(
                          t.signal_tier,
                        )}`}
                      >
                        <span className="mt-0.5">{channelIcon(t.channel)}</span>
                        <div className="flex-1">
                          <div className="text-sm font-medium">
                            {actionLabel(t.action_type)}
                            <span className="text-xs text-stone-500">
                              {' '}
                              via {t.channel}
                            </span>
                          </div>
                          {t.raw_payload && (
                            <div className="mt-0.5 line-clamp-1 text-xs text-stone-600">
                              {String(
                                (t.raw_payload as Record<string, unknown>).subject ??
                                  (t.raw_payload as Record<string, unknown>).note ??
                                  '',
                              )}
                            </div>
                          )}
                        </div>
                        <span className="shrink-0 text-xs text-stone-500">{time}</span>
                      </li>
                    )
                  })}
                </ol>
              </div>
            ))}
          </div>
        )}
      </div>

      {candidates.length > 0 && (
        <div className="mt-8">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-700">
              Pending candidate matches ({candidates.length})
            </h2>
            <a
              href="/intel/identity-review"
              className="text-xs text-stone-600 hover:text-stone-900"
            >
              Open review queue →
            </a>
          </div>
          <div className="space-y-2">
            {candidates.map((m) => {
              const candidateId =
                m.primary_record_type === 'fragment' || m.primary_record_type === 'touchpoint'
                  ? m.primary_record_id
                  : m.secondary_record_type === 'fragment' || m.secondary_record_type === 'touchpoint'
                    ? m.secondary_record_id
                    : null
              const fragment = candidateId
                ? fragments.find((f) => f.id === candidateId)
                : null
              return (
                <div
                  key={m.id}
                  className="rounded-md border border-amber-200 bg-amber-50/30 p-3 text-sm"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <HelpCircle className="h-4 w-4 text-amber-700" />
                      <span className="font-medium text-stone-800">
                        {fragment
                          ? `${fragment.channel} fragment: ${fragment.identity_hint ?? fragment.external_id}`
                          : `${m.primary_record_type} ↔ ${m.secondary_record_type}`}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${
                          m.confidence_tier === 'medium'
                            ? 'border-amber-300 bg-amber-100 text-amber-800'
                            : 'border-stone-300 bg-stone-100 text-stone-700'
                        }`}
                      >
                        {m.confidence_tier}
                      </span>
                    </div>
                    <span className="text-xs text-stone-500">
                      {new Date(m.occurred_at).toLocaleDateString()}
                    </span>
                  </div>
                  {m.matcher_reason && (
                    <div className="mt-1 line-clamp-2 text-xs text-stone-600">
                      {m.matcher_reason}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <p className="mt-8 text-xs text-stone-400">
        Identity reconstruction is continuous. The Phase B Tracer
        rebuilds nightly, and the Phase C Forwards Linker writes new
        touchpoints in shadow mode the moment they arrive.
      </p>

      {/* Channel constellation summary at bottom */}
      {channelSet.size > 1 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-stone-600">
          <UsersIcon className="h-3 w-3 text-stone-400" />
          <span className="text-stone-400">Channels:</span>
          {Array.from(channelSet).map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-white px-2 py-0.5"
            >
              {channelIcon(c)} {c}
            </span>
          ))}
        </div>
      )}

      {/* Placeholder for Inbox/related action surface */}
      <div className="mt-12 flex items-center gap-2 text-xs text-stone-300">
        <Inbox className="h-3 w-3" />
        <span>Couple ID: {couple.id}</span>
      </div>
    </div>
  )
}
