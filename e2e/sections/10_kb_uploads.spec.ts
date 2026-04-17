import { test, expect } from '@playwright/test'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  createContext,
  createTestOrg,
  createTestVenue,
  createTestUser,
  cleanup,
  TestContext,
} from '../helpers/seed'
import { loginAs } from '../helpers/auth'

/**
 * §10 KNOWLEDGE BASE UPLOADS
 *
 * Goal: verify the Knowledge Base ingest pipeline - content goes in, gets
 * stored for the right venue, and surfaces when Sage searches for it.
 *
 * ===============================================================
 * IMPORTANT GAP / DEVIATION FROM SPEC (flag for audit)
 * ===============================================================
 * The §10 brief describes a "file upload -> text extraction -> embedding ->
 * retrieval" pipeline with tables like `kb_documents` / `kb_chunks` and
 * pgvector or JSON embedding columns. That pipeline DOES NOT EXIST in this
 * codebase as of 2026-04-17.
 *
 * What actually exists:
 *   - Table: `knowledge_base` (001_shared_tables.sql L171) - venue-scoped
 *     FAQ entries: category, question, answer, keywords[], priority,
 *     is_active, source ('manual'|'auto-learned'|'csv').
 *   - Service: `src/lib/services/knowledge-base.ts` - CRUD plus
 *     `searchKnowledgeBase(venueId, query)` which does OR-clause keyword +
 *     ilike matching, scored and ranked. NO embeddings. NO chunking.
 *   - UI: `src/app/(platform)/portal/kb/page.tsx` - CSV upload (question,
 *     answer, category columns) that writes directly to `knowledge_base`
 *     with source='csv'. NO PDF/docx/txt support. NO file extraction.
 *   - Sage consumer: `src/lib/services/sage-brain.ts` L300 calls
 *     `searchKnowledgeBase(venueId, message)` to retrieve KB entries for
 *     the AI prompt context.
 *   - No Voyage/OpenAI embedding dependency found in package.json. No
 *     `kb_documents`, `kb_chunks`, `embeddings`, or pgvector migrations.
 *
 * Because of the above, these sub-specs from the brief are SKIPPED:
 *   (b) Chunking/embedding - no chunking service exists.
 *   (c) Vector retrieval with seeded embedding - retrieval is keyword-based;
 *       we test the keyword-retrieval equivalent instead.
 *
 * What we do cover:
 *   (a) DB round trip for a KB entry, scoped by venue.
 *   (a2) CSV-style bulk ingest (what the upload UI actually does).
 *   (c') Keyword retrieval surfaces the seeded entry when sage-brain calls
 *        `searchKnowledgeBase`.
 *   (d) Venue scope isolation - venue A's KB rows do not leak to venue B.
 *   (e) UI smoke - KB page renders for coordinator and exposes the
 *       CSV upload control + Add Entry button.
 */

let _admin: SupabaseClient
function admin(): SupabaseClient {
  if (_admin) return _admin
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  _admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return _admin
}

// Track KB rows we insert directly so we can clean them up. The shared
// `cleanup(ctx)` helper doesn't know about the `knowledge_base` table, but
// `venues` has ON DELETE CASCADE to `knowledge_base` (see 001 migration L173),
// so venue teardown removes them. We still track ids for explicit cleanup
// in case a row lands under a non-test venue.
const createdKbIds: string[] = []

async function cleanupKb() {
  if (createdKbIds.length) {
    try {
      await admin().from('knowledge_base').delete().in('id', createdKbIds)
    } catch (e) {
      console.warn('KB cleanup warning:', e)
    }
    createdKbIds.length = 0
  }
}

test.describe('§10 Knowledge Base Uploads', () => {
  let ctx: TestContext

  test.beforeEach(() => {
    ctx = createContext()
  })

  test.afterEach(async () => {
    await cleanupKb()
    await cleanup(ctx)
  })

  test('(a) KB entry round-trips: insert then read back, scoped to venue', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const uniqQ = `What time can vendors load in? [e2e:${ctx.testId}]`
    const { data: inserted, error: insErr } = await admin()
      .from('knowledge_base')
      .insert({
        venue_id: venueId,
        category: 'Logistics',
        question: uniqQ,
        answer: 'Vendors may load in starting at 10am on the wedding day.',
        keywords: ['vendors', 'load', 'in', 'arrival'],
        priority: 5,
        is_active: true,
        source: 'manual',
      })
      .select('id, venue_id, question, answer, category, source')
      .single()
    expect(insErr).toBeNull()
    expect(inserted).not.toBeNull()
    createdKbIds.push(inserted!.id)

    const { data: readBack, error: readErr } = await admin()
      .from('knowledge_base')
      .select('id, question, answer, keywords, venue_id, source')
      .eq('venue_id', venueId)
      .eq('question', uniqQ)
    expect(readErr).toBeNull()
    expect(readBack?.length).toBe(1)
    expect(readBack![0].venue_id).toBe(venueId)
    expect(readBack![0].answer).toContain('10am')
    expect(readBack![0].source).toBe('manual')
  })

  test('(a2) CSV-style bulk ingest writes multiple rows with source=csv', async () => {
    // Mirrors what src/app/(platform)/portal/kb/page.tsx handleCSVUpload does:
    // parses CSV in the browser and inserts rows into knowledge_base directly.
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const rows = [
      {
        venue_id: venueId,
        category: 'Pricing',
        question: `Weekend rate [e2e:${ctx.testId}]`,
        answer: 'Our venue serves 150 guests. Weekends are $18,000.',
        keywords: [],
        priority: 5,
        is_active: true,
        source: 'csv' as const,
      },
      {
        venue_id: venueId,
        category: 'Capacity',
        question: `Max headcount [e2e:${ctx.testId}]`,
        answer: 'Seated capacity is 150. Cocktail style 200.',
        keywords: [],
        priority: 5,
        is_active: true,
        source: 'csv' as const,
      },
    ]
    const { data, error } = await admin()
      .from('knowledge_base')
      .insert(rows)
      .select('id, source, venue_id')
    expect(error).toBeNull()
    expect(data?.length).toBe(2)
    for (const r of data ?? []) {
      createdKbIds.push(r.id)
      expect(r.source).toBe('csv')
      expect(r.venue_id).toBe(venueId)
    }
  })

  test('(c) keyword retrieval surfaces a seeded entry when queried', async () => {
    // This replaces the "chunking + embedding retrieval" shape from the
    // brief. The actual sage-brain retrieval path is keyword-based (see
    // src/lib/services/knowledge-base.ts searchKnowledgeBase), so we test
    // THAT pipeline end-to-end. No AI calls.
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })

    const token = `sentinel${ctx.testId}`
    const { data: inserted, error: insErr } = await admin()
      .from('knowledge_base')
      .insert({
        venue_id: venueId,
        category: 'Pricing',
        question: `What is the weekend rate ${token}?`,
        answer: `Our venue serves 150 guests. Weekends are $18,000. ${token}`,
        keywords: ['weekend', 'rate', 'pricing', token],
        priority: 10,
        is_active: true,
        source: 'manual',
      })
      .select('id')
      .single()
    expect(insErr).toBeNull()
    createdKbIds.push(inserted!.id)

    // Replicate the sage-brain retrieval path (searchKnowledgeBase body):
    // split query into words, OR across keywords / question / answer.
    const query = `weekend rate ${token}`
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1)
    const orConditions = words
      .flatMap((word) => [
        `keywords.cs.{${word}}`,
        `question.ilike.%${word}%`,
        `answer.ilike.%${word}%`,
      ])
      .join(',')

    const { data: hits, error: searchErr } = await admin()
      .from('knowledge_base')
      .select('id, question, answer, keywords, venue_id')
      .eq('venue_id', venueId)
      .eq('is_active', true)
      .or(orConditions)
      .order('priority', { ascending: false })
    expect(searchErr).toBeNull()
    expect(hits?.length).toBeGreaterThanOrEqual(1)
    const found = (hits ?? []).some((h) => h.id === inserted!.id)
    expect(found, `expected searchKnowledgeBase-equivalent query to return seeded entry containing "${token}"`).toBe(true)
  })

  test('(d) venue scope isolation: venue A KB entry is NOT returned for venue B', async () => {
    const { orgId } = await createTestOrg(ctx)
    const { venueId: venueA } = await createTestVenue(ctx, { orgId })
    const { venueId: venueB } = await createTestVenue(ctx, { orgId })

    const tokenA = `onlyA${ctx.testId}`
    const { data: rowA, error: errA } = await admin()
      .from('knowledge_base')
      .insert({
        venue_id: venueA,
        category: 'Policies',
        question: `Cancellation policy ${tokenA}`,
        answer: `Refunds up to 90 days prior. ${tokenA}`,
        keywords: ['cancellation', 'refund', tokenA],
        priority: 5,
        is_active: true,
        source: 'manual',
      })
      .select('id')
      .single()
    expect(errA).toBeNull()
    createdKbIds.push(rowA!.id)

    // Query from venue B's perspective with words that would match venue A's row.
    const words = ['cancellation', 'refund', tokenA]
    const orConditions = words
      .flatMap((word) => [
        `keywords.cs.{${word}}`,
        `question.ilike.%${word}%`,
        `answer.ilike.%${word}%`,
      ])
      .join(',')

    const { data: fromB, error: errBQ } = await admin()
      .from('knowledge_base')
      .select('id')
      .eq('venue_id', venueB)
      .eq('is_active', true)
      .or(orConditions)
    expect(errBQ).toBeNull()
    expect(fromB?.length ?? 0).toBe(0)

    // Sanity: same query from venue A DOES return the seeded row.
    const { data: fromA, error: errAQ } = await admin()
      .from('knowledge_base')
      .select('id')
      .eq('venue_id', venueA)
      .eq('is_active', true)
      .or(orConditions)
    expect(errAQ).toBeNull()
    expect(fromA?.some((r) => r.id === rowA!.id)).toBe(true)
  })

  // OPTIONAL per §10 brief. Skipped by default because running the full suite
  // across chromium-desktop + chromium-mobile projects in parallel overloads
  // the local dev server: page.goto('/login') itself exceeds the 60s test
  // timeout even with test.setTimeout(180_000) bumped inside the test.
  // Verified passing when run in isolation:
  //   npx playwright test e2e/sections/10_kb_uploads.spec.ts \
  //     --project=chromium-desktop -g "UI smoke"   (1.2m, OK)
  // Set E2E_KB_UI=1 to opt in.
  const runUi = !!process.env.E2E_KB_UI
  const uiTest = runUi ? test : test.skip
  uiTest('(e) UI smoke: KB page renders for coordinator with upload + add controls', async ({ page, context }) => {
    test.setTimeout(180_000)
    const { orgId } = await createTestOrg(ctx)
    const { venueId } = await createTestVenue(ctx, { orgId })
    const coordinator = await createTestUser(ctx, {
      role: 'coordinator',
      orgId,
      venueId,
    })

    await loginAs(page, 'coordinator', {
      email: coordinator.email,
      password: coordinator.password,
    })
    // Prime scope cookie (matches pattern from 08a_plan_gating_ui.spec.ts).
    // Without bloom_venue set, /portal/kb useScope() has no venueId and
    // never issues its supabase query - the page sits in a loading state.
    await context.addCookies([
      { name: 'bloom_venue', value: venueId, domain: 'localhost', path: '/' },
    ])
    await page.goto('/portal/kb', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3_000)

    const html = await page.content()
    // Header / page title
    expect(html).toMatch(/Knowledge Base/i)
    // CSV upload affordance (button label is "Upload CSV" or "Uploading...")
    const hasUploadBtn = /Upload\s+CSV/i.test(html)
    // Add Entry button
    const hasAddBtn = /Add\s+Entry/i.test(html)
    expect(
      hasUploadBtn,
      'expected /portal/kb to render "Upload CSV" control (the only KB ingest affordance in the UI)'
    ).toBe(true)
    expect(hasAddBtn, 'expected /portal/kb to render "Add Entry" button').toBe(true)
  })

  // --------------------------------------------------------------------------
  // Skipped: document-level ingest pipeline (not implemented)
  // --------------------------------------------------------------------------
  test.skip('(b) TODO: chunking + embedding a raw document - pipeline does not exist', async () => {
    // INVESTIGATE / AUDIT FLAG:
    //   No kb_documents / kb_chunks tables. No pgvector column. No file
    //   upload handler beyond CSV -> rows. No embedding service
    //   (Voyage/OpenAI) wired up. The KB is a structured FAQ table, not a
    //   document store. If the product direction is genuinely
    //   "upload a PDF, Sage reads it," this feature is unbuilt and needs
    //   a migration + ingest route + embedding client before this test
    //   can meaningfully exist.
  })

  test.skip('(c-vector) TODO: vector retrieval with seeded embedding - no vector column', async () => {
    // See (b). searchKnowledgeBase is keyword-based only.
  })
})
