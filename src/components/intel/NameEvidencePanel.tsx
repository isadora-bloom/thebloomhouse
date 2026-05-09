'use client'

/**
 * Name-evidence audit panel + manual override + handle collection.
 *
 * Wave 2D (2026-05-09) — Phase 5 UI polish for the identity-capture
 * redesign (mig 255). Renders on /intel/clients/[id] near the contacts
 * panel.
 *
 * What it shows
 * -------------
 *  - Display name (large) per partner with confidence badge
 *  - "(unverified)" tag when name_confidence < 40
 *  - Confidence chip showing score + source label ("95 — calculator form")
 *  - Evidence chain (collapsed by default) — every name claim observed,
 *    color-coded by source class. Picked vs superseded tag per row.
 *  - Manual override dialog — types into a confidence-100 evidence row
 *    tagged `manual_override` and immediately re-projects the columns.
 *    Telemetry fired server-side so analytics counts coordinator
 *    interventions per venue.
 *  - "Found across platforms" handle collection, clickable through to
 *    the actual platform URL when known.
 *
 * Phase-2 backfill not shipped yet — most rows have an empty evidence
 * array. The panel renders gracefully ("No evidence chain yet — Phase 2
 * backfill will populate.") and the override flow still works on a
 * pristine row.
 */

import { useEffect, useState, useCallback } from 'react'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Edit3,
  ExternalLink,
  ShieldCheck,
  X,
  AtSign,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface NameEvidenceEntry {
  source?: string
  value?: { first?: string | null; last?: string | null } | null
  raw?: string
  confidence?: number | null
  captured_at?: string | null
  interaction_id?: string | null
  pinned?: boolean
  superseded?: boolean
}

interface PartnerOut {
  id: string
  role: string
  first_name: string | null
  last_name: string | null
  display_handle: string | null
  name_confidence: number | null
  name_picked_source: string | null
  email: string | null
  phone: string | null
  platform_handles: Record<string, string | null>
  name_evidence: NameEvidenceEntry[]
}

interface ApiResponse {
  partners: PartnerOut[]
  partnerCount: number | null
}

// ---------------------------------------------------------------------------
// Source classification — color-codes the evidence-chain rows. Mirrors
// the confidence rubric in IDENTITY-CAPTURE-DESIGN.md §4b.
// ---------------------------------------------------------------------------

type SourceClass = 'contract' | 'transcript' | 'fromName' | 'handle' | 'manual' | 'other'

function sourceClass(source: string | undefined | null): SourceClass {
  const s = (source ?? '').toLowerCase()
  if (s === 'manual_override' || s === 'coordinator_typed') return 'manual'
  if (s === 'contract_signer' || s === 'calculator_form' || s === 'web_form_other') return 'contract'
  if (s === 'tour_transcript' || s.startsWith('brain_dump') || s === 'email_extracted_identity_direct' || s === 'email_signature_extraction')
    return 'transcript'
  if (s.startsWith('gmail_from_name') || s === 'partner_mention_in_body') return 'fromName'
  if (s === 'pinterest_scraper' || s === 'email_handle' || s === 'gmail_from_name_username_shaped' || s === 'relay_proxy_id')
    return 'handle'
  return 'other'
}

const SOURCE_CHIP: Record<SourceClass, string> = {
  manual: 'bg-emerald-100 text-emerald-800 border border-emerald-300',
  contract: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  transcript: 'bg-blue-50 text-blue-700 border border-blue-200',
  fromName: 'bg-amber-50 text-amber-700 border border-amber-200',
  handle: 'bg-slate-100 text-slate-600 border border-slate-200',
  other: 'bg-sage-50 text-sage-700 border border-sage-200',
}

const SOURCE_LABEL: Record<string, string> = {
  manual_override: 'Coordinator override',
  coordinator_typed: 'Coordinator typed',
  contract_signer: 'Contract signer',
  calculator_form: 'Calculator form',
  web_form_other: 'Web form',
  brain_dump_note: 'Brain dump',
  brain_dump: 'Brain dump',
  tour_transcript: 'Tour transcript',
  email_signature_extraction: 'Email signature',
  email_extracted_identity_direct: 'Email body',
  partner_mention_in_body: 'Body mention',
  gmail_from_name_full: 'Gmail From (full)',
  gmail_from_name_first_initial: 'Gmail From (first + initial)',
  gmail_from_name_all_caps: 'Gmail From (all caps)',
  gmail_from_name_single: 'Gmail From (single)',
  gmail_from_name_username_shaped: 'Gmail From (handle-shaped)',
  pinterest_scraper: 'Pinterest scrape',
  email_handle: 'Email handle',
  relay_proxy_id: 'Relay proxy ID',
}

function labelFor(source: string | undefined | null): string {
  const s = source ?? ''
  return SOURCE_LABEL[s] ?? s.replace(/_/g, ' ') ?? 'Unknown'
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// ---------------------------------------------------------------------------
// Platform URL builders. NULL = no canonical URL pattern, render as
// non-clickable chip.
// ---------------------------------------------------------------------------

function platformUrl(platform: string, handle: string): string | null {
  const safe = encodeURIComponent(handle.replace(/^@/, ''))
  switch (platform.toLowerCase()) {
    case 'pinterest':
      return `https://pinterest.com/${safe}/`
    case 'instagram':
      return `https://instagram.com/${safe}/`
    case 'tiktok':
      return `https://tiktok.com/@${safe}`
    case 'twitter':
    case 'x':
      return `https://x.com/${safe}`
    case 'facebook':
      return `https://facebook.com/${safe}`
    case 'knot':
    case 'the_knot':
    case 'theknot':
      // Knot member URLs aren't browsable; render as chip-only.
      return null
    case 'weddingwire':
      return null
    default:
      return null
  }
}

const PLATFORM_LABEL: Record<string, string> = {
  pinterest: 'Pinterest',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  twitter: 'Twitter',
  x: 'X',
  facebook: 'Facebook',
  knot: 'The Knot',
  the_knot: 'The Knot',
  theknot: 'The Knot',
  weddingwire: 'WeddingWire',
}

function platformLabel(p: string): string {
  return PLATFORM_LABEL[p.toLowerCase()] ?? p.charAt(0).toUpperCase() + p.slice(1)
}

// ---------------------------------------------------------------------------
// Override dialog
// ---------------------------------------------------------------------------

function OverrideDialog({
  partner,
  onCancel,
  onSubmit,
  busy,
}: {
  partner: PartnerOut
  onCancel: () => void
  onSubmit: (first: string, last: string) => void
  busy: boolean
}) {
  const [first, setFirst] = useState(partner.first_name ?? '')
  const [last, setLast] = useState(partner.last_name ?? '')

  return (
    <div className="mt-2 rounded-lg border border-sage-200 bg-warm-white p-3 space-y-2">
      <div className="text-xs font-medium text-sage-700">
        Override the picked name. Coordinator entry stamps confidence 100.
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          value={first}
          onChange={(e) => setFirst(e.target.value)}
          placeholder="First name"
          maxLength={80}
          className="text-sm rounded border border-sage-200 bg-white px-2 py-1.5 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-400"
        />
        <input
          value={last}
          onChange={(e) => setLast(e.target.value)}
          placeholder="Last name"
          maxLength={80}
          className="text-sm rounded border border-sage-200 bg-white px-2 py-1.5 placeholder:text-sage-400 focus:outline-none focus:ring-2 focus:ring-sage-400"
        />
      </div>
      <div className="flex items-center gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs rounded-md border border-sage-200 text-sage-700 px-3 py-1.5 hover:bg-sage-50 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSubmit(first.trim(), last.trim())}
          disabled={busy || (!first.trim() && !last.trim())}
          className="text-xs rounded-md bg-sage-700 text-white px-3 py-1.5 hover:bg-sage-800 disabled:opacity-50 inline-flex items-center gap-1"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
          Save override
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-partner block
// ---------------------------------------------------------------------------

function PartnerEvidenceBlock({
  partner,
  onOverride,
  busyId,
}: {
  partner: PartnerOut
  onOverride: (personId: string, first: string, last: string) => void
  busyId: string | null
}) {
  const [showEvidence, setShowEvidence] = useState(false)
  const [showDialog, setShowDialog] = useState(false)

  const display = [partner.first_name, partner.last_name].filter(Boolean).join(' ')
  const hasName = !!display
  const conf = partner.name_confidence
  const unverified = typeof conf === 'number' && conf < 40
  const handles = Object.entries(partner.platform_handles ?? {}).filter(
    ([, v]) => typeof v === 'string' && v.length > 0,
  ) as Array<[string, string]>
  const evidence = partner.name_evidence ?? []
  const pickedTs = evidence.find((e) => e.source === partner.name_picked_source)?.captured_at

  return (
    <div className="border-b border-sage-100 last:border-0 pb-4 last:pb-0 mb-4 last:mb-0">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-lg font-semibold text-sage-900">
              {hasName ? display : <span className="italic text-sage-400">(name unknown)</span>}
            </p>
            <span className="text-[11px] text-sage-400 capitalize">
              {partner.role.replace('_', ' ')}
            </span>
            {unverified && (
              <span className="text-[10px] uppercase tracking-wide font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                unverified
              </span>
            )}
          </div>
          {partner.display_handle && (
            <p className="text-[11px] text-sage-500 mt-0.5 inline-flex items-center gap-1">
              <AtSign className="w-3 h-3" />
              <span className="font-mono">{partner.display_handle}</span>
            </p>
          )}
          {/* Confidence chip */}
          {typeof conf === 'number' && (
            <div className="mt-1.5 inline-flex items-center gap-2">
              <span
                className={cn(
                  'text-[11px] font-medium px-1.5 py-0.5 rounded border',
                  conf >= 90
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                    : conf >= 60
                      ? 'bg-sage-50 text-sage-700 border-sage-200'
                      : conf >= 40
                        ? 'bg-amber-50 text-amber-800 border-amber-200'
                        : 'bg-slate-50 text-slate-600 border-slate-200',
                )}
              >
                <ShieldCheck className="inline w-3 h-3 mr-0.5" />
                {conf} — {labelFor(partner.name_picked_source)}
                {pickedTs && (
                  <span className="text-sage-400 font-normal ml-1">· {fmtDate(pickedTs)}</span>
                )}
              </span>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowDialog((s) => !s)}
          className="text-xs rounded border border-sage-200 text-sage-700 px-2.5 py-1 hover:bg-sage-50 inline-flex items-center gap-1 shrink-0"
        >
          <Edit3 className="w-3 h-3" /> Override
        </button>
      </div>

      {showDialog && (
        <OverrideDialog
          partner={partner}
          busy={busyId === partner.id}
          onCancel={() => setShowDialog(false)}
          onSubmit={(f, l) => onOverride(partner.id, f, l)}
        />
      )}

      {/* Evidence chain — collapsed by default */}
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowEvidence((s) => !s)}
          className="text-[11px] text-sage-600 hover:text-sage-900 inline-flex items-center gap-1"
        >
          {showEvidence ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          Evidence chain ({evidence.length})
        </button>
        {showEvidence && (
          <div className="mt-2 space-y-1.5">
            {evidence.length === 0 ? (
              <p className="text-[11px] italic text-sage-400">
                No evidence chain yet — Phase 2 backfill will populate.
              </p>
            ) : (
              evidence.map((e, i) => {
                const isPicked =
                  partner.name_picked_source && e.source === partner.name_picked_source
                const cls = sourceClass(e.source)
                const valStr = e.value
                  ? [e.value.first, e.value.last].filter(Boolean).join(' ') ||
                    e.raw ||
                    '(empty)'
                  : e.raw ?? '(empty)'
                return (
                  <div
                    key={`${e.source}-${e.captured_at}-${i}`}
                    className="flex items-center gap-2 text-[11px] flex-wrap"
                  >
                    <span
                      className={cn(
                        'px-1.5 py-0.5 rounded font-medium',
                        SOURCE_CHIP[cls],
                      )}
                    >
                      {labelFor(e.source)}
                    </span>
                    <span className="font-mono text-sage-800 truncate max-w-[220px]">{valStr}</span>
                    {typeof e.confidence === 'number' && (
                      <span className="text-sage-500">· {e.confidence}</span>
                    )}
                    {e.captured_at && (
                      <span className="text-sage-400">· {fmtDate(e.captured_at)}</span>
                    )}
                    {isPicked && (
                      <span className="text-[10px] text-emerald-700 font-medium">(picked)</span>
                    )}
                    {!isPicked && partner.name_picked_source && (
                      <span className="text-[10px] text-sage-400 italic">(superseded)</span>
                    )}
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* Found across platforms — hide when empty */}
      {handles.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-medium text-sage-700 mb-1.5">Found across platforms</p>
          <div className="flex items-center gap-1.5 flex-wrap">
            {handles.map(([platform, handle]) => {
              const url = platformUrl(platform, handle)
              const label = platformLabel(platform)
              const inner = (
                <>
                  <span className="text-sage-500 mr-1">{label}:</span>
                  <span className="font-mono">{handle}</span>
                  {url && <ExternalLink className="w-2.5 h-2.5 ml-1 opacity-70" />}
                </>
              )
              return url ? (
                <a
                  key={platform}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] inline-flex items-center px-2 py-0.5 rounded bg-sage-50 text-sage-700 border border-sage-200 hover:bg-sage-100"
                >
                  {inner}
                </a>
              ) : (
                <span
                  key={platform}
                  className="text-[11px] inline-flex items-center px-2 py-0.5 rounded bg-sage-50 text-sage-700 border border-sage-200"
                >
                  {inner}
                </span>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function NameEvidencePanel({ weddingId }: { weddingId: string }) {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setErr(null)
    try {
      const res = await fetch(`/api/intel/name-evidence/${weddingId}`)
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText)
        throw new Error(errText || `HTTP ${res.status}`)
      }
      const body = (await res.json()) as ApiResponse
      setData(body)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [weddingId])

  useEffect(() => {
    setLoading(true)
    void refresh()
  }, [refresh])

  async function override(personId: string, first: string, last: string) {
    setBusyId(personId)
    setErr(null)
    try {
      const res = await fetch(`/api/intel/name-evidence/${weddingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId, firstName: first, lastName: last }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(text || `HTTP ${res.status}`)
      }
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">Name evidence</h2>
        </div>
        <div className="flex items-center gap-2 text-sage-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading evidence chain...
        </div>
      </div>
    )
  }

  const partners = data?.partners ?? []

  return (
    <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">Name evidence</h2>
        </div>
        {data?.partnerCount === 1 && (
          <span
            title="Phantom-partner detector flagged this couple as a single decision-maker. Sage prompts will use a singular salutation."
            className="text-[10px] uppercase tracking-wide font-medium text-sage-700 bg-sage-50 border border-sage-200 px-1.5 py-0.5 rounded"
          >
            Single decision-maker
          </span>
        )}
      </div>
      <p className="text-xs text-sage-500 mb-4">
        Forensic record of every name claim observed. The picked display is the highest-confidence
        evidence; coordinator override stamps confidence 100 and re-projects.
      </p>

      {err && (
        <div className="flex items-start gap-2 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 mb-3">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1">{err}</div>
          <button
            type="button"
            onClick={() => setErr(null)}
            className="text-red-500 hover:text-red-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {partners.length === 0 ? (
        <p className="text-sm text-sage-400 italic">No partners on this wedding yet.</p>
      ) : (
        partners.map((p) => (
          <PartnerEvidenceBlock
            key={p.id}
            partner={p}
            onOverride={override}
            busyId={busyId}
          />
        ))
      )}
    </div>
  )
}
