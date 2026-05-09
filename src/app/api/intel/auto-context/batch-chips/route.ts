/**
 * POST /api/intel/auto-context/batch-chips
 *
 * Wave 1C (2026-05-09). Batch read of the highest-priority auto-context
 * chip for a list of wedding IDs. Used by /agent/inbox + /agent/leads to
 * render a single chip per row WITHOUT N+1 fetches.
 *
 * Doctrine — aggregate ≠ disclose:
 *   - Sensitive notes (sensitive=true OR category in
 *     {health, grief, financial_stress, family_conflict, mental_health})
 *     are redacted to category-only ("(sensitive note)"). The note body
 *     is never returned over the wire for sensitive rows.
 *   - The chip ALWAYS surfaces a label, even when sensitive — coordinator
 *     wants to know "this couple has a sensitive note pinned" without
 *     reading the body in a row chip.
 *   - One chip per wedding (the highest-priority pinned note, falling
 *     back to the most-recent active note).
 *
 * Body: { weddingIds: string[] } — capped at MAX_BATCH (100).
 * Response: { chips: { [weddingId]: ChipSummary | null } }
 *
 * Auth: getPlatformAuth — coordinator's venueId scopes the query so a
 * coordinator can't read another venue's notes even if they pass another
 * venue's wedding IDs.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, isDemoMode, isDemoVenueAllowed } from '@/lib/api/auth-helpers'
import { redact } from '@/lib/observability/redact'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

const MAX_BATCH = 100
const UUID_RE = /^[0-9a-f-]{36}$/i

const SENSITIVE_CATEGORIES = new Set<string>([
  'health',
  'grief',
  'financial_stress',
  'family_conflict',
  'mental_health',
])

// Display labels for chips. Mirrors components/intel/auto-context-panel.tsx
// CATEGORY_LABELS so chip + panel feel like one surface.
const CATEGORY_LABELS: Record<string, string> = {
  life_context: 'Life',
  family: 'Family',
  vendors: 'Vendors',
  budget: 'Budget',
  health: 'Health',
  grief: 'Grief',
  financial_stress: 'Financial',
  family_conflict: 'Family',
  mental_health: 'Wellness',
  dietary: 'Dietary',
  timeline: 'Timeline',
  cultural: 'Cultural',
  preferences: 'Preferences',
  logistics: 'Logistics',
  misc: 'Note',
}

export interface AutoContextChip {
  weddingId: string
  /** Category label rendered on the chip ("Family", "Cultural", etc.). */
  label: string
  /** Short body preview. For sensitive notes this is "(sensitive note)" —
   *  the actual body is NEVER returned over the wire for sensitive rows. */
  body: string
  /** True when the underlying note is sensitive (chip uses muted styling
   *  + does not expose body on hover). */
  sensitive: boolean
  /** True when the underlying note is pinned. UI surfaces a small pin
   *  icon on the chip when so. */
  pinned: boolean
}

const TRUNCATE_BODY = 90

export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  let body: { weddingIds?: unknown }
  try {
    body = (await request.json()) as { weddingIds?: unknown }
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!Array.isArray(body.weddingIds)) {
    return NextResponse.json({ error: 'weddingIds must be an array' }, { status: 400 })
  }

  const seen = new Set<string>()
  const weddingIds: string[] = []
  for (const raw of body.weddingIds) {
    if (typeof raw !== 'string') continue
    if (!UUID_RE.test(raw)) continue
    if (seen.has(raw)) continue
    seen.add(raw)
    weddingIds.push(raw)
    if (weddingIds.length >= MAX_BATCH) break
  }

  if (weddingIds.length === 0) {
    return NextResponse.json({ chips: {} })
  }

  const supabase = createServiceClient()
  const demo = await isDemoMode()

  let venueId: string | null = null
  if (demo) {
    venueId = request.nextUrl.searchParams.get('venueId')
    if (!venueId) {
      return NextResponse.json({ error: 'venueId required in demo' }, { status: 400 })
    }
    if (!isDemoVenueAllowed(venueId)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  } else {
    const platform = await getPlatformAuth()
    if (!platform) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    venueId = platform.venueId
  }

  // One query — pinned-first then most-recent. We pull more than we need
  // (5 per wedding) and pick the top one in JS so we can prefer pinned
  // even if it isn't the most recent.
  type Row = {
    wedding_id: string
    body: string
    category: string | null
    sensitive: boolean | null
    pinned: boolean
    created_at: string
  }
  let rows: Row[] = []
  try {
    const res = await supabase
      .from('wedding_auto_context')
      .select('wedding_id, body, category, sensitive, pinned, created_at')
      .eq('venue_id', venueId)
      .eq('is_active', true)
      .in('wedding_id', weddingIds)
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false })
    if (res.error) {
      const message = (res.error as { message?: string }).message ?? ''
      if (/column .* does not exist/i.test(message)) {
        // Pre-mig-255 fallback — no `sensitive` column.
        const legacy = await supabase
          .from('wedding_auto_context')
          .select('wedding_id, body, category, pinned, created_at')
          .eq('venue_id', venueId)
          .eq('is_active', true)
          .in('wedding_id', weddingIds)
          .order('pinned', { ascending: false })
          .order('created_at', { ascending: false })
        rows = ((legacy.data ?? []) as Array<Omit<Row, 'sensitive'>>).map(
          (r) => ({ ...r, sensitive: null }),
        )
      } else {
        console.error('[auto-context/batch-chips] query failed:', redact(message))
        return NextResponse.json({ error: 'query_failed' }, { status: 500 })
      }
    } else {
      rows = (res.data ?? []) as Row[]
    }
  } catch (err) {
    console.error('[auto-context/batch-chips] unexpected error:', err)
    return NextResponse.json({ chips: {} })
  }

  // Pick best chip per wedding: pinned first, then most-recent.
  const chips: Record<string, AutoContextChip | null> = {}
  for (const wid of weddingIds) chips[wid] = null

  for (const r of rows) {
    if (chips[r.wedding_id]) continue
    const cat = (r.category && r.category.trim().length > 0 ? r.category : 'misc')
    const sensitive = r.sensitive === true || SENSITIVE_CATEGORIES.has(cat)
    const label = CATEGORY_LABELS[cat] ?? 'Note'
    const safeBody = sensitive
      ? '(sensitive note)'
      : truncateBody(r.body)
    chips[r.wedding_id] = {
      weddingId: r.wedding_id,
      label,
      body: safeBody,
      sensitive,
      pinned: r.pinned === true,
    }
  }

  return NextResponse.json({ chips })
}

function truncateBody(body: string): string {
  const cleaned = body.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= TRUNCATE_BODY) return cleaned
  return cleaned.slice(0, TRUNCATE_BODY - 3) + '...'
}
