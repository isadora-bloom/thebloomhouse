'use client'

/**
 * ReconstructedIdentityPanel — Wave 4 Phase 3 read surface for the
 * couple_identity_profile.
 *
 * Anchor docs:
 *   - bloom-constitution.md (the panel is the coordinator-facing
 *     view of the forensic record — names, occupations, residence,
 *     emotional truths, family dynamics, vendor preferences,
 *     handles, accessibility, cultural signals, decision dynamics,
 *     all with verbatim evidence quotes pulled at reconstruction
 *     time)
 *   - bloom-wave4-identity-reconstruction.md (Phase 3 reads from
 *     couple_identity_profile; never re-extracts from raw bodies)
 *
 * Sensitivity gating
 * ------------------
 * Emotional truths flagged sensitive=true are GATED by default.
 * The panel renders a "[N sensitive themes — click to reveal]"
 * placeholder. Click reveals only when the venue has opted in
 * via venue_config.feature_flags.reveal_sensitive_themes=true.
 * NEVER echo a sensitive evidence_quote in coordinator-facing
 * surfaces unless the flag is on. Same doctrine as
 * universal-rules SOFT-CONTEXT NOTES POLICY.
 *
 * Empty state
 * -----------
 * When the profile row does not yet exist, the panel renders
 * "Reconstruction pending — queued for background processing"
 * plus a manual "Reconstruct now" button that POSTs to
 * /api/admin/identity/reconstruct.
 *
 * Footer
 * ------
 * "Last reconstructed N ago" + a "Rebuild" button (force=true).
 */

import { useEffect, useState, useCallback } from 'react'
import {
  Sparkles,
  Lock,
  RefreshCw,
  AlertCircle,
  Briefcase,
  MapPin,
  Users,
  HeartHandshake,
  Hash,
  Accessibility,
  Globe,
  Brain,
  Loader2,
  ChevronDown,
  ChevronUp,
  Quote,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface NameClaim {
  first: string | null
  last: string | null
  confidence_0_100: number
  evidence_quote: string | null
}

interface NamesBlock {
  partner1: NameClaim | null
  partner2: NameClaim | null
  is_phantom_partner_relationship: boolean
  name_quality: 'high' | 'medium' | 'low' | 'unknown'
}

interface EmotionalTruth {
  theme: string
  evidence_quote: string
  confidence_0_100: number
  sensitive: boolean
}

interface OccupationClaim {
  partner_role: 'partner1' | 'partner2'
  occupation: string
  evidence_quote: string
}

interface ResidenceClaim {
  city: string | null
  state: string | null
  evidence_quote: string
}

interface FamilyDynamicClaim {
  relationship: string
  signal: string
  evidence_quote: string
}

interface VendorPreferenceClaim {
  vendor_type: string
  preference: string
  evidence_quote: string
}

interface HandleClaim {
  platform: string
  handle: string
  evidence_quote: string
}

interface AccessibilityClaim {
  need: string
  evidence_quote: string
}

interface CulturalSignalClaim {
  signal: string
  evidence_quote: string
}

interface DecisionDynamicsBlock {
  who_decides: string | null
  who_questions: string | null
  who_negotiates: string | null
}

interface CoupleIdentityProfile {
  names: NamesBlock
  emotional_truths: EmotionalTruth[]
  occupations: OccupationClaim[]
  residence: ResidenceClaim | null
  family_dynamics: FamilyDynamicClaim[]
  vendor_preferences: VendorPreferenceClaim[]
  handles: HandleClaim[]
  accessibility_needs: AccessibilityClaim[]
  cultural_signals: CulturalSignalClaim[]
  decision_dynamics: DecisionDynamicsBlock | null
  refusals: Array<{ field: string; reason: string }>
}

interface EvidenceSummary {
  interactions_count: number
  calculator_count: number
  honeybook_present: boolean
  calendar_count: number
  reviews_count: number
  contracts_count: number
  tangentials_count: number
  payments_count: number
}

interface ProfileResponse {
  ok: boolean
  weddingId?: string
  venueId?: string
  profile?: CoupleIdentityProfile
  evidenceSummary?: EvidenceSummary
  promptVersion?: string
  reconstructionCount?: number
  lastReconstructedAt?: string
  lastSignalAt?: string | null
  cumulativeCostCents?: number
  error?: string
}

interface VenueConfigFlags {
  reveal_sensitive_themes?: boolean
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'unknown'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'unknown'
  const diffMs = Date.now() - t
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function formatName(claim: NameClaim | null): string {
  if (!claim) return '(no claim)'
  const parts = [claim.first, claim.last].filter((s) => s && s.trim())
  return parts.length > 0 ? parts.join(' ') : '(unnamed)'
}

function nameQualityBadge(q: NamesBlock['name_quality']): {
  bg: string
  text: string
  label: string
} {
  switch (q) {
    case 'high':
      return { bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700', label: 'high quality' }
    case 'medium':
      return { bg: 'bg-blue-50 border-blue-200', text: 'text-blue-700', label: 'medium quality' }
    case 'low':
      return { bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700', label: 'low quality' }
    default:
      return { bg: 'bg-rose-50 border-rose-200', text: 'text-rose-700', label: 'unknown' }
  }
}

function EvidenceQuote({ text }: { text: string | null | undefined }) {
  if (!text) return null
  return (
    <div className="mt-1 text-xs text-sage-500 italic flex gap-1.5 items-start">
      <Quote className="w-3 h-3 mt-0.5 shrink-0 text-sage-300" />
      <span className="leading-snug break-words">{text.length > 220 ? text.slice(0, 220) + '...' : text}</span>
    </div>
  )
}

interface SectionShellProps {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
  empty?: boolean
}

function Section({ icon, title, children, empty }: SectionShellProps) {
  if (empty) return null
  return (
    <div className="px-6 py-4 border-b border-border last:border-b-0">
      <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-wide font-semibold text-sage-700">
        {icon}
        {title}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

export function ReconstructedIdentityPanel({
  weddingId,
}: {
  weddingId: string
}) {
  const [data, setData] = useState<ProfileResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [revealSensitive, setRevealSensitive] = useState(false)
  const [venueRevealFlag, setVenueRevealFlag] = useState(false)
  const [showNames, setShowNames] = useState(true)
  const [unlockOpen, setUnlockOpen] = useState(false)

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/admin/identity/reconstruct?weddingId=${encodeURIComponent(weddingId)}`,
        { cache: 'no-store' },
      )
      if (res.status === 404) {
        // No profile row yet — empty state.
        setData({ ok: false, error: 'no-profile' })
        setError(null)
        return
      }
      const body = (await res.json()) as ProfileResponse
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`)
        setData(null)
        return
      }
      setData(body)
      setError(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error'
      setError(msg)
    }
  }, [weddingId])

  const fetchVenueFlags = useCallback(async () => {
    try {
      // Pull venue_config feature_flags via a tiny server endpoint that
      // already exists for the couple-portal config bundle. Falls back
      // to false on any error — sensitive themes stay gated.
      const res = await fetch('/api/agent/venue-config/feature-flags', {
        cache: 'no-store',
      })
      if (!res.ok) return
      const body = (await res.json()) as { flags?: VenueConfigFlags }
      const flag = body?.flags?.reveal_sensitive_themes === true
      setVenueRevealFlag(flag)
    } catch {
      // Best-effort. Keep gated when we can't read the flag.
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([fetchProfile(), fetchVenueFlags()]).finally(() =>
      setLoading(false),
    )
  }, [fetchProfile, fetchVenueFlags])

  async function rebuild(force: boolean) {
    setRebuilding(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/identity/reconstruct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weddingId, force }),
      })
      const body = (await res.json()) as ProfileResponse
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`)
        return
      }
      setData(body)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error'
      setError(msg)
    } finally {
      setRebuilding(false)
    }
  }

  // ---- Loading -----------------------------------------------------
  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Reconstructed identity
          </h2>
          <Loader2 className="w-3.5 h-3.5 ml-auto text-sage-400 animate-spin" />
        </div>
        <div className="p-6 text-sm text-sage-500">Loading forensic record...</div>
      </div>
    )
  }

  // ---- Empty (profile row missing) --------------------------------
  if (!data || (!data.profile && data.error === 'no-profile')) {
    return (
      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Reconstructed identity
          </h2>
        </div>
        <div className="p-6">
          <p className="text-sm text-sage-600 mb-3">
            Reconstruction pending — queued for background processing.
          </p>
          <button
            type="button"
            onClick={() => rebuild(false)}
            disabled={rebuilding}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-sage-500 text-white rounded-md hover:bg-sage-600 disabled:opacity-50"
          >
            {rebuilding ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            {rebuilding ? 'Reconstructing...' : 'Reconstruct now'}
          </button>
          {error && (
            <p className="mt-3 text-xs text-rose-600 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> {error}
            </p>
          )}
        </div>
      </div>
    )
  }

  // ---- Error (profile load failed) -------------------------------
  if (error && !data.profile) {
    return (
      <div className="bg-surface border border-rose-200 rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-500" />
          <h2 className="font-heading text-base font-semibold text-rose-700">
            Reconstructed identity — failed to load
          </h2>
        </div>
        <div className="p-6">
          <p className="text-sm text-rose-700">{error}</p>
        </div>
      </div>
    )
  }

  const profile = data.profile!
  const evidenceSummary = data.evidenceSummary

  const sensitiveTruths = profile.emotional_truths.filter((t) => t.sensitive)
  const nonSensitiveTruths = profile.emotional_truths.filter((t) => !t.sensitive)
  const canReveal = venueRevealFlag

  const nameQuality = nameQualityBadge(profile.names.name_quality)

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-6 py-4 border-b border-border flex items-center gap-2 flex-wrap">
        <Sparkles className="w-4 h-4 text-sage-500" />
        <h2 className="font-heading text-base font-semibold text-sage-900">
          Reconstructed identity
        </h2>
        <span
          className={cn(
            'inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium border',
            nameQuality.bg,
            nameQuality.text,
          )}
          title="LLM judge's assessment of overall name-evidence quality."
        >
          {nameQuality.label}
        </span>
        {profile.names.is_phantom_partner_relationship && (
          <span
            className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-sage-50 text-sage-700 border border-sage-200"
            title="Phantom-partner relationship: only one decision-maker."
          >
            Single decision-maker
          </span>
        )}
        {evidenceSummary && (
          <span
            className="ml-auto text-[10px] text-sage-500 hidden md:inline"
            title="Evidence used by the Sonnet judge for this reconstruction."
          >
            {evidenceSummary.interactions_count} emails
            {evidenceSummary.calculator_count > 0
              ? ` · ${evidenceSummary.calculator_count} calc`
              : ''}
            {evidenceSummary.honeybook_present ? ' · HoneyBook' : ''}
            {evidenceSummary.contracts_count > 0
              ? ` · ${evidenceSummary.contracts_count} contracts`
              : ''}
            {evidenceSummary.calendar_count > 0
              ? ` · ${evidenceSummary.calendar_count} calendar`
              : ''}
            {evidenceSummary.reviews_count > 0
              ? ` · ${evidenceSummary.reviews_count} reviews`
              : ''}
          </span>
        )}
      </div>

      {/* Names */}
      <Section icon={<Users className="w-3.5 h-3.5" />} title="Names">
        <button
          type="button"
          onClick={() => setShowNames((v) => !v)}
          className="text-xs text-sage-600 hover:text-sage-900 inline-flex items-center gap-1 mb-1"
        >
          {showNames ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {showNames ? 'Hide evidence' : 'Show evidence'}
        </button>
        <div className="space-y-2">
          {(['partner1', 'partner2'] as const).map((role) => {
            const claim = role === 'partner1' ? profile.names.partner1 : profile.names.partner2
            if (!claim && profile.names.is_phantom_partner_relationship && role === 'partner2') {
              return (
                <div key={role} className="text-xs text-sage-400 italic">
                  partner2: phantom (resolved as single decision-maker)
                </div>
              )
            }
            if (!claim) {
              return (
                <div key={role} className="text-xs text-sage-400 italic">
                  {role}: (no claim)
                </div>
              )
            }
            return (
              <div key={role} className="text-sm">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sage-900">{formatName(claim)}</span>
                  <span className="text-[10px] text-sage-500 uppercase">{role}</span>
                  <span className="text-[10px] bg-sage-50 text-sage-700 px-1.5 py-0.5 rounded">
                    {claim.confidence_0_100}% confidence
                  </span>
                </div>
                {showNames && claim.evidence_quote && (
                  <EvidenceQuote text={claim.evidence_quote} />
                )}
              </div>
            )
          })}
        </div>
      </Section>

      {/* Persona placeholder (Wave 5A) */}
      <Section icon={<Brain className="w-3.5 h-3.5" />} title="Persona">
        <div className="text-xs text-sage-400 italic">
          Wave 5A will fill this — persona derivation reads from this
          forensic profile.
        </div>
      </Section>

      {/* Emotional truths */}
      <Section
        icon={<HeartHandshake className="w-3.5 h-3.5" />}
        title="Emotional truths"
        empty={
          nonSensitiveTruths.length === 0 && sensitiveTruths.length === 0
        }
      >
        {nonSensitiveTruths.map((t, i) => (
          <div key={`et-${i}`} className="text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sage-900">{t.theme}</span>
              <span className="text-[10px] text-sage-500">{t.confidence_0_100}%</span>
            </div>
            <EvidenceQuote text={t.evidence_quote} />
          </div>
        ))}
        {sensitiveTruths.length > 0 && (
          <div className="rounded-md border border-sage-200 bg-sage-50/40 p-2">
            <div className="flex items-center gap-2 text-xs text-sage-700">
              <Lock className="w-3 h-3" />
              <span>
                {sensitiveTruths.length} sensitive theme
                {sensitiveTruths.length === 1 ? '' : 's'}
                {' '} — click to reveal
              </span>
              {canReveal ? (
                <button
                  type="button"
                  onClick={() => setUnlockOpen((v) => !v)}
                  className="ml-auto text-[10px] underline hover:no-underline"
                >
                  {unlockOpen ? 'Hide' : 'Reveal'}
                </button>
              ) : (
                <span
                  className="ml-auto text-[10px] text-sage-400"
                  title="Sensitive themes are gated until the venue opts in via venue_config.feature_flags.reveal_sensitive_themes."
                >
                  gated
                </span>
              )}
            </div>
            {canReveal && unlockOpen && (
              <div className="mt-2 space-y-2 pl-1 border-l-2 border-sage-200">
                {sensitiveTruths.map((t, i) => (
                  <div key={`st-${i}`} className="text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sage-900">{t.theme}</span>
                      <span className="text-[10px] text-sage-500">
                        {t.confidence_0_100}%
                      </span>
                      <span className="inline-flex items-center text-[10px] text-rose-600 bg-rose-50 border border-rose-100 px-1 rounded">
                        sensitive
                      </span>
                    </div>
                    <EvidenceQuote text={t.evidence_quote} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {/* Always show count, even when 0 sensitive */}
        {sensitiveTruths.length === 0 && nonSensitiveTruths.length === 0 && (
          <div className="text-xs text-sage-400 italic">No emotional truths reconstructed yet.</div>
        )}
      </Section>

      {/* Occupations */}
      <Section
        icon={<Briefcase className="w-3.5 h-3.5" />}
        title="Occupations"
        empty={profile.occupations.length === 0}
      >
        {profile.occupations.map((o, i) => (
          <div key={`occ-${i}`} className="text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sage-900">{o.occupation}</span>
              <span className="text-[10px] text-sage-500 uppercase">
                {o.partner_role}
              </span>
            </div>
            <EvidenceQuote text={o.evidence_quote} />
          </div>
        ))}
      </Section>

      {/* Residence */}
      {profile.residence && (
        <Section icon={<MapPin className="w-3.5 h-3.5" />} title="Residence">
          <div className="text-sm">
            <span className="font-medium text-sage-900">
              {[profile.residence.city, profile.residence.state]
                .filter((s) => s && s.trim())
                .join(', ') || '(no city/state)'}
            </span>
            <EvidenceQuote text={profile.residence.evidence_quote} />
          </div>
        </Section>
      )}

      {/* Family dynamics */}
      <Section
        icon={<Users className="w-3.5 h-3.5" />}
        title="Family dynamics"
        empty={profile.family_dynamics.length === 0}
      >
        {profile.family_dynamics.map((f, i) => (
          <div key={`fd-${i}`} className="text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sage-900">{f.relationship}</span>
              <span className="text-xs text-sage-600">{f.signal}</span>
            </div>
            <EvidenceQuote text={f.evidence_quote} />
          </div>
        ))}
      </Section>

      {/* Vendor preferences */}
      <Section
        icon={<HeartHandshake className="w-3.5 h-3.5" />}
        title="Vendor preferences"
        empty={profile.vendor_preferences.length === 0}
      >
        {profile.vendor_preferences.map((v, i) => (
          <div key={`vp-${i}`} className="text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sage-900">{v.vendor_type}</span>
              <span className="text-xs text-sage-600">{v.preference}</span>
            </div>
            <EvidenceQuote text={v.evidence_quote} />
          </div>
        ))}
      </Section>

      {/* Handles */}
      <Section
        icon={<Hash className="w-3.5 h-3.5" />}
        title="Cross-platform handles"
        empty={profile.handles.length === 0}
      >
        <div className="flex flex-wrap gap-2">
          {profile.handles.map((h, i) => (
            <div
              key={`h-${i}`}
              className="text-xs bg-sage-50 border border-sage-100 px-2 py-1 rounded"
              title={h.evidence_quote}
            >
              <span className="font-mono">{h.platform}:</span> {h.handle}
            </div>
          ))}
        </div>
      </Section>

      {/* Accessibility needs */}
      <Section
        icon={<Accessibility className="w-3.5 h-3.5" />}
        title="Accessibility needs"
        empty={profile.accessibility_needs.length === 0}
      >
        {profile.accessibility_needs.map((a, i) => (
          <div key={`acc-${i}`} className="text-sm">
            <span className="font-medium text-sage-900">{a.need}</span>
            <EvidenceQuote text={a.evidence_quote} />
          </div>
        ))}
      </Section>

      {/* Cultural signals */}
      <Section
        icon={<Globe className="w-3.5 h-3.5" />}
        title="Cultural signals"
        empty={profile.cultural_signals.length === 0}
      >
        {profile.cultural_signals.map((c, i) => (
          <div key={`cs-${i}`} className="text-sm">
            <span className="font-medium text-sage-900">{c.signal}</span>
            <EvidenceQuote text={c.evidence_quote} />
          </div>
        ))}
      </Section>

      {/* Decision dynamics */}
      {profile.decision_dynamics &&
        (profile.decision_dynamics.who_decides ||
          profile.decision_dynamics.who_questions ||
          profile.decision_dynamics.who_negotiates) && (
          <Section icon={<Brain className="w-3.5 h-3.5" />} title="Decision dynamics">
            <div className="text-sm space-y-1">
              {profile.decision_dynamics.who_decides && (
                <div>
                  <span className="text-xs text-sage-500">decides: </span>
                  <span className="text-sage-900">
                    {profile.decision_dynamics.who_decides}
                  </span>
                </div>
              )}
              {profile.decision_dynamics.who_questions && (
                <div>
                  <span className="text-xs text-sage-500">questions: </span>
                  <span className="text-sage-900">
                    {profile.decision_dynamics.who_questions}
                  </span>
                </div>
              )}
              {profile.decision_dynamics.who_negotiates && (
                <div>
                  <span className="text-xs text-sage-500">negotiates: </span>
                  <span className="text-sage-900">
                    {profile.decision_dynamics.who_negotiates}
                  </span>
                </div>
              )}
            </div>
          </Section>
        )}

      {/* Footer */}
      <div className="px-6 py-3 border-t border-border bg-sage-50/30 flex items-center gap-3 text-[11px] text-sage-500">
        <span>Last reconstructed {relativeTime(data.lastReconstructedAt)}</span>
        {typeof data.reconstructionCount === 'number' && (
          <span>· {data.reconstructionCount} run{data.reconstructionCount === 1 ? '' : 's'}</span>
        )}
        {data.promptVersion && (
          <span className="font-mono text-sage-400">{data.promptVersion}</span>
        )}
        <button
          type="button"
          onClick={() => rebuild(true)}
          disabled={rebuilding}
          className="ml-auto inline-flex items-center gap-1.5 px-2 py-1 text-[11px] border border-sage-300 text-sage-700 rounded hover:bg-sage-50 disabled:opacity-50"
          title="Force a fresh Sonnet reconstruction. Only do this when new signals have landed since the last run."
        >
          {rebuilding ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Rebuild
        </button>
      </div>
      {error && (
        <div className="px-6 py-2 text-xs text-rose-600 border-t border-rose-100 bg-rose-50/40 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> {error}
        </div>
      )}
    </div>
  )
}
