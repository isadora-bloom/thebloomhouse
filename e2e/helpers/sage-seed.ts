/**
 * Sage-specific helpers for the §9 Sage E2E spec.
 *
 * The Sage endpoint lives at /api/portal/sage (no couple-scoped variant exists
 * at the time this was written). Transcripts are persisted to the
 * `sage_conversations` table (role in ('user','assistant')), rate limiting is
 * keyed by `sage:<weddingId-or-venueId>` with 20 / 15min via the
 * `increment_rate_limit` RPC from migration 053.
 *
 * These helpers let the spec:
 *   - seed budget / checklist / timeline rows that getWeddingContext() reads
 *   - clean up any rate_limits rows created under a test prefix
 *   - clean up sage_conversations rows created during the test
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { TestContext } from './seed'

let _admin: SupabaseClient | null = null
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('sage-seed: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing')
  }
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

/**
 * A per-test prefix for rate_limits keys so cleanup can scope safely without
 * touching any real/other-test rows in the shared Supabase project.
 */
export function testRateLimitPrefix(ctx: TestContext): string {
  return `e2e-sage-${ctx.testId}:`
}

export async function clearRateLimitKey(key: string): Promise<void> {
  try {
    await admin().from('rate_limits').delete().eq('key', key)
  } catch {
    /* ignore */
  }
}

/**
 * Cleans up every rate_limits row whose key starts with our per-test prefix.
 * Also cleans specific keys that the Sage endpoint itself would have created
 * (sage:<weddingId>) when running the end-to-end enforcement test.
 */
export async function cleanupRateLimits(ctx: TestContext, extraKeys: string[] = []): Promise<void> {
  try {
    const prefix = testRateLimitPrefix(ctx)
    await admin().from('rate_limits').delete().like('key', `${prefix}%`)
    for (const k of extraKeys) {
      await admin().from('rate_limits').delete().eq('key', k)
    }
  } catch (e) {
    console.warn('cleanupRateLimits warning:', e)
  }
}

/**
 * Cleans up sage_conversations rows for the given wedding ids (optional).
 * The main seed `cleanup()` already cascades via wedding FK in most cases,
 * but sage_conversations uses ON DELETE SET NULL for wedding_id, so we wipe
 * explicitly to avoid orphans accumulating across runs.
 */
export async function cleanupSageConversations(weddingIds: string[]): Promise<void> {
  if (!weddingIds.length) return
  try {
    await admin().from('sage_conversations').delete().in('wedding_id', weddingIds)
  } catch {
    /* ignore */
  }
}

/**
 * Seeds the three context buckets Sage's getWeddingContext reads:
 *   - wedding_config.total_budget  (-> budgetTotal)
 *   - budget_items with paid sums  (-> budgetSpent)
 *   - checklist_items total + completed
 *   - timeline rows (count only)
 */
export async function seedSageContext(
  venueId: string,
  weddingId: string,
  opts: {
    totalBudget?: number
    paidAmounts?: number[]
    checklistCount?: number
    checklistCompleteCount?: number
    timelineCount?: number
  } = {}
): Promise<void> {
  const totalBudget = opts.totalBudget ?? 50000
  const paids = opts.paidAmounts ?? [1500, 500]
  const checklistCount = opts.checklistCount ?? 4
  const checklistComplete = opts.checklistCompleteCount ?? 2
  const timelineCount = opts.timelineCount ?? 3

  const a = admin()

  await a.from('wedding_config').upsert(
    { venue_id: venueId, wedding_id: weddingId, total_budget: totalBudget },
    { onConflict: 'venue_id,wedding_id' }
  )

  if (paids.length) {
    await a.from('budget_items').insert(
      paids.map((paid, i) => ({
        venue_id: venueId,
        wedding_id: weddingId,
        category: 'Photography',
        item_name: `SageCtxItem-${i}-${weddingId.slice(0, 6)}`,
        budgeted: paid,
        committed: 0,
        paid,
      }))
    )
  }

  // Checklist items (best-effort — skip if table schema differs)
  const checklistRows: Array<Record<string, unknown>> = []
  for (let i = 0; i < checklistCount; i++) {
    checklistRows.push({
      venue_id: venueId,
      wedding_id: weddingId,
      title: `SageCtxChecklist-${i}`,
      is_completed: i < checklistComplete,
    })
  }
  const { error: checklistErr } = await a.from('checklist_items').insert(checklistRows)
  if (checklistErr) console.warn('seedSageContext checklist:', checklistErr.message)

  // Timeline items (best-effort)
  const timelineRows: Array<Record<string, unknown>> = []
  for (let i = 0; i < timelineCount; i++) {
    timelineRows.push({
      venue_id: venueId,
      wedding_id: weddingId,
      title: `SageCtxTimeline-${i}`,
      sort_order: i,
    })
  }
  const { error: timelineErr } = await a.from('timeline').insert(timelineRows)
  if (timelineErr) console.warn('seedSageContext timeline:', timelineErr.message)
}
