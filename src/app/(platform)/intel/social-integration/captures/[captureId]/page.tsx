'use client'

/**
 * /intel/social-integration/captures/[captureId] — one capture's detail.
 *
 * Wave 4 (W31), follow-up from the Wave 3 report: "`/api/intel/social-
 * integration/captures/[captureId]` has no page; the modal link was
 * removed." Reads the existing GET route (W23) and renders per-handle
 * outcome — attached to a couple you can click through to, a fragment
 * still awaiting identity, a candidate in review, or a row the linker
 * has not resolved, with its reason. Read-only: this page writes
 * nothing.
 */

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, ExternalLink, Loader2, AlertCircle } from 'lucide-react'

interface CaptureRow {
  id: string
  venue_id: string
  platform: string
  metric_type: string
  captured_at: string
  captured_by: string | null
  total_handles: number | null
  matched_count: number | null
  unmatched_count: number | null
  parse_result: { parsed_count?: number; unique_count?: number; parser_version?: string; errors?: string[] } | null
}

interface EngagementRow {
  id: string
  handle: string
  display_name: string | null
  engagement_at: string | null
  match_status: string
  couple_id: string | null
  match_method: string | null
  match_confidence: number | null
  matched_at: string | null
  couple_name: string | null
  lifecycle_state: string | null
  spine_outcome: string
}

interface CaptureDetailResponse {
  capture: CaptureRow
  engagements: EngagementRow[]
}

function dateTimeLabel(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Bucket a hydrated engagement row the way the coordinator thinks about
 *  it, not by the raw `match_method` string. A couple_id means it landed
 *  on the spine; a fragment or candidate is genuinely still open; and
 *  anything else (pending, no method, a duplicate re-fire) has not been
 *  resolved to a couple, which is the honest label for it. */
type OutcomeBucket = 'attached' | 'fragment' | 'candidate' | 'unresolved'

function bucketFor(e: EngagementRow): OutcomeBucket {
  if (e.couple_id) return 'attached'
  if (e.match_method === 'spine_fragment') return 'fragment'
  if (e.match_method === 'spine_candidate') return 'candidate'
  return 'unresolved'
}

const BUCKET_META: Record<OutcomeBucket, { label: string; hint: string; tone: string }> = {
  attached: {
    label: 'Attached to a couple',
    hint: 'The spine already knew whose handle this was.',
    tone: 'border-sage-200 bg-sage-50',
  },
  candidate: {
    label: 'In review',
    hint: 'Close but not certain — sits in the candidate queue until an operator confirms it.',
    tone: 'border-gold-200 bg-gold-50',
  },
  fragment: {
    label: 'Fragment awaiting identity',
    hint: 'On the spine, but nothing ties it to a known couple yet.',
    tone: 'border-stone-200 bg-stone-50',
  },
  unresolved: {
    label: 'Not yet resolved',
    hint: 'Skipped before a signal was built, or the linker has not run over it — see the reason on each row.',
    tone: 'border-rose-200 bg-rose-50',
  },
}

const BUCKET_ORDER: OutcomeBucket[] = ['attached', 'candidate', 'fragment', 'unresolved']

export default function CaptureDetailPage() {
  const router = useRouter()
  const params = useParams<{ captureId: string }>()
  const captureId = params?.captureId ?? null

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<CaptureDetailResponse | null>(null)

  const load = useCallback(async () => {
    if (!captureId) return
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch(`/api/intel/social-integration/captures/${captureId}`)
      if (!resp.ok) {
        const j = (await resp.json().catch(() => null)) as { message?: string; error?: string } | null
        setError(j?.message ?? j?.error ?? `Capture not found (${resp.status}).`)
        setData(null)
        return
      }
      const j = (await resp.json()) as CaptureDetailResponse
      setData(j)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [captureId])

  useEffect(() => {
    void load()
  }, [load])

  if (!captureId) return null

  const grouped: Record<OutcomeBucket, EngagementRow[]> = {
    attached: [],
    candidate: [],
    fragment: [],
    unresolved: [],
  }
  for (const e of data?.engagements ?? []) {
    grouped[bucketFor(e)].push(e)
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <button
          type="button"
          onClick={() => router.push('/intel/social-integration')}
          className="inline-flex items-center gap-1.5 text-sm text-stone-500 hover:text-stone-800"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to social integration
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 px-2 py-8 text-stone-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading capture…
        </div>
      ) : error || !data ? (
        <div className="flex items-center gap-2 rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error ?? 'Capture not found.'}
        </div>
      ) : (
        <>
          <header className="rounded-lg border border-stone-200 bg-white p-4">
            <h1 className="font-serif text-xl capitalize text-stone-900">
              {data.capture.platform} · {data.capture.metric_type.replace(/_/g, ' ')}
            </h1>
            <p className="mt-1 text-sm text-stone-500">
              Captured {dateTimeLabel(data.capture.captured_at)}
              {data.capture.parse_result?.parser_version
                ? ` · parser ${data.capture.parse_result.parser_version}`
                : ''}
            </p>
            <div className="mt-3 flex flex-wrap gap-4 text-sm text-stone-700">
              <span>
                <strong className="font-semibold">{data.capture.total_handles ?? 0}</strong> handles captured
              </span>
              <span>
                <strong className="font-semibold text-sage-700">{data.capture.matched_count ?? 0}</strong> attached to a couple
              </span>
              <span>
                <strong className="font-semibold text-stone-600">{data.capture.unmatched_count ?? 0}</strong> not yet attached
              </span>
            </div>
            {data.capture.parse_result?.errors && data.capture.parse_result.errors.length > 0 ? (
              <ul className="mt-3 space-y-0.5 text-xs text-rose-600">
                {data.capture.parse_result.errors.map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
            ) : null}
          </header>

          {data.engagements.length === 0 ? (
            <p className="text-sm text-stone-400">No handles on this capture.</p>
          ) : (
            <div className="space-y-5">
              {BUCKET_ORDER.map((bucket) => {
                const rows = grouped[bucket]
                if (rows.length === 0) return null
                const meta = BUCKET_META[bucket]
                return (
                  <section key={bucket} className={`rounded-lg border p-4 ${meta.tone}`}>
                    <div className="mb-2 flex items-baseline gap-2">
                      <h2 className="text-sm font-semibold text-stone-800">{meta.label}</h2>
                      <span className="text-xs text-stone-500">({rows.length})</span>
                    </div>
                    <p className="mb-3 text-xs text-stone-500">{meta.hint}</p>
                    <ul className="divide-y divide-stone-100 overflow-hidden rounded-md border border-stone-200 bg-white">
                      {rows.map((e) => (
                        <li
                          key={e.id}
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                        >
                          <div className="min-w-0">
                            {e.couple_id ? (
                              <a
                                href={`/intel/couples/${e.couple_id}`}
                                className="inline-flex items-center gap-1 font-medium text-sage-700 hover:underline"
                              >
                                {e.couple_name ?? 'View couple'}
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : (
                              <span className="font-medium text-stone-800">
                                {e.display_name ?? `@${e.handle}`}
                              </span>
                            )}
                            <div className="truncate text-xs text-stone-500">
                              @{e.handle}
                              {e.display_name && e.couple_id ? ` · ${e.display_name}` : ''}
                            </div>
                          </div>
                          <span className="shrink-0 text-right text-xs text-stone-500">
                            {e.spine_outcome}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
