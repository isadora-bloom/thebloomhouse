/**
 * Couple portal seed helpers for §11.
 *
 * These helpers write directly to the DB via the service role client. They
 * all tag rows with a per-run marker (via notes/description/title where
 * possible) so `cleanupCoupleSeed` can wipe them even when the parent
 * wedding row survives the cascade.
 *
 * IMPORTANT: seed.ts owns wedding/venue/user cleanup. Any NEW tables this
 * file writes to must be cleaned up here in `cleanupCoupleSeed` before the
 * base `cleanup(ctx)` runs (the wedding DELETE cascades will usually handle
 * child rows, but we also clear rows on tables that are not wired to the
 * FK cascade chain).
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Page } from '@playwright/test'
import { TestContext } from './seed'

let _admin: SupabaseClient | null = null
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

/**
 * Couple login that tolerates slow dev-mode compiles. The shared
 * `auth.ts#loginAs` issues `page.goto(path)` with the default
 * `waitUntil: 'load'`, which on first-compile of a dev route commonly
 * exceeds the 30s navigationTimeout on Windows. This helper does the same
 * thing but waits only for `domcontentloaded`, which is sufficient for the
 * form fields to be interactable.
 */
export async function loginCoupleResilient(
  page: Page,
  opts: { email: string; password: string; slug: string }
): Promise<void> {
  const path = `/couple/${opts.slug}/login`
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  // The form fields may hydrate a tick later.
  await page.waitForSelector('input[type="email"]', { timeout: 20_000 })
  await page.fill('input[type="email"]', opts.email)
  await page.fill('input[type="password"]', opts.password)
  await Promise.all([
    page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 30_000 }).catch(() => null),
    page.click('button[type="submit"]'),
  ])
}

export async function seedChecklistItem(
  ctx: TestContext,
  opts: { venueId: string; weddingId: string; title?: string; category?: string; isCompleted?: boolean }
): Promise<{ id: string; title: string }> {
  const title = opts.title ?? `E2E Task [e2e:${ctx.testId}]`
  const { data, error } = await admin()
    .from('checklist_items')
    .insert({
      venue_id: opts.venueId,
      wedding_id: opts.weddingId,
      title,
      category: opts.category ?? 'Other',
      is_completed: opts.isCompleted ?? false,
      sort_order: 9999,
      description: `[e2e:${ctx.testId}]`,
    })
    .select('id, title')
    .single()
  if (error) throw new Error(`seedChecklistItem: ${error.message}`)
  return { id: data.id, title: data.title }
}

export async function seedBudgetItem(
  ctx: TestContext,
  opts: { venueId: string; weddingId: string; itemName?: string; category?: string; budgeted?: number }
): Promise<{ id: string; itemName: string }> {
  const itemName = opts.itemName ?? `E2E BudgetRow [e2e:${ctx.testId}]`
  const { data, error } = await admin()
    .from('budget_items')
    .insert({
      venue_id: opts.venueId,
      wedding_id: opts.weddingId,
      category: opts.category ?? 'Other',
      item_name: itemName,
      budgeted: opts.budgeted ?? 1234,
      committed: 0,
      paid: 0,
    })
    .select('id, item_name')
    .single()
  if (error) throw new Error(`seedBudgetItem: ${error.message}`)
  return { id: data.id, itemName: data.item_name }
}

/**
 * Timeline uses a single JSON blob row (see src/app/_couple-pages/timeline/
 * page.tsx line 1308). The couple page reads `config_json` from a single
 * row per wedding. We write one here so the render-path has something to
 * hydrate from.
 */
export async function seedTimeline(
  ctx: TestContext,
  opts: { venueId: string; weddingId: string; markerName?: string }
): Promise<{ id: string; markerName: string }> {
  const markerName = opts.markerName ?? `E2E Event [e2e:${ctx.testId}]`
  const configJson = {
    config: {
      ceremonyTime: '16:00',
      receptionEndTime: '22:00',
      dinnerType: 'buffet',
      doingFirstLook: false,
      offSiteCeremony: false,
      autoCalculate: false,
      formalitiesTiming: 'after',
      weddingDate: null,
      latitude: 38.4,
      longitude: -77.5,
    },
    events: [],
    customEvents: [
      {
        id: `e2e-${ctx.testId}`,
        name: markerName,
        time: '17:30',
        duration: 30,
        notes: `[e2e:${ctx.testId}]`,
        phase: 'reception',
        icon: 'star',
      },
    ],
  }
  const { data, error } = await admin()
    .from('timeline')
    .insert({
      venue_id: opts.venueId,
      wedding_id: opts.weddingId,
      title: markerName,
      config_json: configJson,
    })
    .select('id')
    .single()
  if (error) throw new Error(`seedTimeline: ${error.message}`)
  return { id: data.id, markerName }
}

export async function seedGuest(
  ctx: TestContext,
  opts: { venueId: string; weddingId: string; firstName?: string; lastName?: string }
): Promise<{ id: string; firstName: string; lastName: string }> {
  const firstName = opts.firstName ?? `E2EGuest${ctx.testId}`
  const lastName = opts.lastName ?? 'Tester'
  const { data, error } = await admin()
    .from('guest_list')
    .insert({
      venue_id: opts.venueId,
      wedding_id: opts.weddingId,
      first_name: firstName,
      last_name: lastName,
      rsvp_status: 'pending',
      notes: `[e2e:${ctx.testId}]`,
    })
    .select('id')
    .single()
  if (error) throw new Error(`seedGuest: ${error.message}`)
  return { id: data.id, firstName, lastName }
}

export async function seedContract(
  ctx: TestContext,
  opts: { venueId: string; weddingId: string; filename?: string }
): Promise<{ id: string; filename: string }> {
  const filename = opts.filename ?? `E2E Contract ${ctx.testId}.pdf`
  const { data, error } = await admin()
    .from('contracts')
    .insert({
      venue_id: opts.venueId,
      wedding_id: opts.weddingId,
      filename,
      file_type: 'pdf',
      storage_path: `e2e/${ctx.testId}/placeholder.pdf`,
      status: 'uploaded',
    })
    .select('id, filename')
    .single()
  if (error) throw new Error(`seedContract: ${error.message}`)
  return { id: data.id, filename }
}

/**
 * Best-effort cleanup of rows we seeded on tables outside the wedding
 * cascade path. Safe to call before base `cleanup(ctx)` — the wedding
 * delete cascade usually picks up anything we miss here.
 */
export async function cleanupCoupleSeed(ctx: TestContext): Promise<void> {
  const a = admin()
  try {
    if (ctx.createdWeddingIds.length) {
      await a.from('checklist_items').delete().in('wedding_id', ctx.createdWeddingIds)
      await a.from('budget_items').delete().in('wedding_id', ctx.createdWeddingIds)
      await a.from('timeline').delete().in('wedding_id', ctx.createdWeddingIds)
      await a.from('guest_list').delete().in('wedding_id', ctx.createdWeddingIds)
      await a.from('contracts').delete().in('wedding_id', ctx.createdWeddingIds)
      await a.from('wedding_details').delete().in('wedding_id', ctx.createdWeddingIds)
    }
  } catch {
    /* swallow — base cleanup will follow */
  }
}
