import { test, expect, type Page } from '@playwright/test'
import { adminClient } from '../helpers/seed'
import { loginAs } from '../helpers/auth'
import {
  journey,
  SEEDED,
  haveCreds,
  missingCredsReason,
  type Journey,
} from '../helpers/journey'

/**
 * §26 A coordinator's Monday — journey 26 of E2E-PLAN.md.
 *
 * "login; `/` lands on `/today`; the 'since you were last here' strip;
 * four blocks with links; 'Import a file' on leads; upload the Dubsado
 * fixture through `/admin/imports/upload`; the couple appears on leads
 * and pipeline with a handle and a stage from the vocabulary; open the
 * wedding page; the five collapsed sections (story, contracts, timeline,
 * commitments, contract); assign a guest from the table map and see it on
 * the guest list." Proves W8, W35, W37, W42 to W45, W50, W53, W57, W61 to
 * W63.
 *
 * What it needs from the branch (`scripts/e2e-seed.ts --apply` prints it):
 *
 *   E2E_COORDINATOR_EMAIL / E2E_COORDINATOR_PASSWORD  — Cora, Ashcombe Barn
 *   E2E_ASHCOMBE_VENUE_ID / E2E_ASHCOMBE_WEDDING_ID
 *
 * Two places where the code is not what the plan's prose says, written
 * against the code and noted here so a reader is not left wondering:
 *
 *   1. The plan says "a handle". `/agent/leads` has no handle chip.
 *      Social handles only render on `/intel/social-integration/**` and
 *      the Instagram settings page. What sits beside the couple name in
 *      mono on both leads and pipeline is the Bloom number
 *      (`formatBloomNumber`, e.g. `AB-0001`). The journey asserts that,
 *      because that is the identifier the coordinator actually reads.
 *   2. The plan says "the Guests tab" on the table map. The tab is
 *      labelled `Guests & Seating`; `Guests` on its own is a tab on the
 *      parent wedding page. Both are asserted, each by its real name.
 *
 * Serial: this is one morning, not eight independent facts. A failed
 * import makes every later step meaningless, so they skip rather than
 * cascade into noise.
 */

test.describe.configure({ mode: 'serial' })

const SECTION = '26_coordinators_monday'
const HAVE = haveCreds(SEEDED.coordinator)
const NO_CREDS = missingCredsReason('COORDINATOR')

/** The fixture the plan names, and the first couple in it. */
const DUBSADO_FIXTURE = 'src/lib/services/crm-import/__tests__/fixtures/dubsado-projects.csv'
const IMPORTED_COUPLE_FIRST = 'Rosalind'
const IMPORTED_COUPLE_LAST = 'Fairweather'
/**
 * The fixture's "Lead" row. Rosalind's project is Active with a booked
 * date, so the import lands her as `booked`, and /agent/leads shows only
 * the unbooked stages (LEAD_LIST_STAGES in lead-board-view.ts) — she is
 * on the pipeline, by design, not on leads. The leads half of the journey
 * therefore looks for the couple the import leaves unbooked (2026-09-15;
 * the old assertion matched the "No leads match" copy instead).
 */
const LEAD_COUPLE_LAST = 'Nair'

/** The four blocks of the strip, and where each one goes deeper. */
const STRIP_BLOCKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'Inquiries arrived', href: '/agent/leads' },
  { label: 'Auto-sent', href: '/agent/drafts' },
  { label: 'Waiting for a reply', href: '/agent/inbox' },
  { label: 'Send failures', href: '/pulse' },
]

/** The five sections the wedding page collapses by default. */
const COLLAPSED_SECTIONS: ReadonlyArray<{ key: string; heading: RegExp }> = [
  { key: 'story', heading: /Who they are, in their own words/i },
  { key: 'contracts', heading: /Signed paperwork/i },
  { key: 'timeline', heading: /Running order for the day/i },
  { key: 'commitments', heading: /Things they told you/i },
  { key: 'contract', heading: /Your contract/i },
]

/** Set by the import step, read by the steps after it. */
let importedWeddingId: string | null = null

/** Rows this spec puts on the branch for the table map, removed after. */
const TABLE_NAME = 'E2E Table 26'
const GUEST_LAST = `E2E26-${Date.now()}`
let seededGuestId: string | null = null
let seededTableId: string | null = null

async function signIn(page: Page): Promise<void> {
  await loginAs(page, 'coordinator', SEEDED.coordinator)
}

/** Every journey in this file tolerates the same background noise. */
function monday(page: Page): Journey {
  return journey(page, SECTION, {
    // The venue selector polls for scope while a page settles; a 401 on
    // that poll before the session cookie is read is not a defect the
    // journey is about. Nothing else is forgiven.
    allowRequests: [/\/api\/auth\/session/],
  })
}

test.describe("§26 A coordinator's Monday", () => {
  test.beforeAll(async () => {
    test.skip(!HAVE, NO_CREDS)
    const sb = adminClient()

    // The table map needs a table and a guest. The Ashcombe fixture is a
    // booked wedding with neither, so the journey seeds exactly the two
    // rows it is going to move and deletes them afterwards. Named, not
    // random, so a half-finished run is obvious in the database.
    const { data: table } = await sb
      .from('seating_tables')
      .insert({
        venue_id: SEEDED.ashcombeVenueId,
        wedding_id: SEEDED.ashcombeWeddingId,
        table_name: TABLE_NAME,
        table_type: 'round',
        capacity: 8,
      })
      .select('id')
      .maybeSingle<{ id: string }>()
    seededTableId = table?.id ?? null

    const { data: guest } = await sb
      .from('guest_list')
      .insert({
        venue_id: SEEDED.ashcombeVenueId,
        wedding_id: SEEDED.ashcombeWeddingId,
        first_name: 'Wynn',
        last_name: GUEST_LAST,
        rsvp_status: 'attending',
      })
      .select('id')
      .maybeSingle<{ id: string }>()
    seededGuestId = guest?.id ?? null
  })

  test.afterAll(async () => {
    const sb = adminClient()
    if (seededGuestId) await sb.from('guest_list').delete().eq('id', seededGuestId)
    if (seededTableId) await sb.from('seating_tables').delete().eq('id', seededTableId)
    // The imported couple is this journey's own rubbish, not the fixture's.
    if (importedWeddingId) {
      await sb.from('people').delete().eq('wedding_id', importedWeddingId)
      await sb.from('weddings').delete().eq('id', importedWeddingId)
    }
  })

  // -------------------------------------------------------------------------
  // Landing
  // -------------------------------------------------------------------------

  test('login, and / lands on /today', async ({ page }) => {
    test.skip(!HAVE, NO_CREDS)
    const j = monday(page)

    await j.step('login', async () => {
      await signIn(page)
    })

    await j.step('root redirects to today', async () => {
      await page.goto('/')
      // `src/app/(platform)/page.tsx` redirects: no scope to /setup,
      // onboarding_completed false to /onboarding, otherwise /today. The
      // fixture venue has onboarding_completed true, so a coordinator who
      // lands anywhere else is a W8 regression.
      await page.waitForURL(/\/today\b/, { timeout: 30_000 })
      await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible()
    })

    await j.end()
  })

  // -------------------------------------------------------------------------
  // The strip
  // -------------------------------------------------------------------------

  test('the "since you were last here" strip renders four blocks, and each deeper link resolves', async ({
    page,
  }) => {
    test.skip(!HAVE, NO_CREDS)
    const j = monday(page)

    await j.step('sign in for the strip', async () => {
      await signIn(page)
      await page.goto('/today')
      await page.waitForLoadState('domcontentloaded')
    })

    const strip = page.locator('section[aria-labelledby="since-last-here-title"]')

    await j.step('the strip is on the page', async () => {
      await expect(strip).toBeVisible({ timeout: 20_000 })
      await expect(
        page.getByRole('heading', { name: 'Since you were last here', level: 2 })
      ).toBeVisible()
    })

    await j.step('four blocks, each with its label and its href', async () => {
      // The strip renders nothing at all when every count is zero, and
      // says so. That is a correct product behaviour and a WRONG branch
      // for this journey, so the message names the fix rather than the
      // symptom: the coordinator's venue needs activity in the window.
      const quiet = strip.getByText('Nothing landed in that window', { exact: false })
      const isQuiet = await quiet.isVisible().catch(() => false)
      expect(
        isQuiet,
        'The strip rendered its all-zero state, so there are no blocks to check. ' +
          'Ashcombe Barn has no inquiries, drafts or sends in the window. Seed ' +
          'recent activity for E2E_ASHCOMBE_VENUE_ID before running §26.'
      ).toBe(false)

      for (const block of STRIP_BLOCKS) {
        const link = strip.getByRole('link', { name: new RegExp(block.label, 'i') })
        await expect(link, `the strip is missing the "${block.label}" block`).toBeVisible()
        await expect(link).toHaveAttribute('href', new RegExp(`^${block.href}(\\?|$)`))
      }
    })

    for (const block of STRIP_BLOCKS) {
      await j.step(`${block.label} opens ${block.href}`, async () => {
        await page.goto(block.href)
        await page.waitForLoadState('domcontentloaded')
        // "Resolves" means the route renders its own page, not that it
        // bounced to login and not that the error boundary caught it.
        expect(new URL(page.url()).pathname, `${block.href} did not stay put`).toBe(block.href)
        await expect(page.locator('body')).not.toContainText(
          /Application error|This page could not be found/i
        )
      })
    }

    await j.end()
  })

  // -------------------------------------------------------------------------
  // The import
  // -------------------------------------------------------------------------

  test('"Import a file" on /agent/leads opens /admin/imports/upload', async ({ page }) => {
    test.skip(!HAVE, NO_CREDS)
    const j = monday(page)

    await j.step('open the leads board', async () => {
      await signIn(page)
      await page.goto('/agent/leads')
      await expect(page.getByRole('heading', { name: 'Lead Scoring', level: 1 })).toBeVisible({
        timeout: 20_000,
      })
    })

    await j.step('follow "Import a file"', async () => {
      const link = page.getByRole('link', { name: 'Import a file' })
      await expect(link).toBeVisible()
      await link.click()
      await page.waitForURL(/\/admin\/imports\/upload$/, { timeout: 20_000 })
      await expect(page.getByRole('heading', { name: 'Import venue data' })).toBeVisible()
    })

    await j.end()
  })

  test('the Dubsado fixture uploads through the form and the summary confirms it', async ({
    page,
  }) => {
    test.skip(!HAVE, NO_CREDS)
    const j = monday(page)

    await j.step('open the import form', async () => {
      await signIn(page)
      await page.goto('/admin/imports/upload')
      await expect(page.getByRole('heading', { name: 'Import venue data' })).toBeVisible({
        timeout: 20_000,
      })
    })

    await j.step('choose the Dubsado adapter', async () => {
      // The provider picker is a grid of buttons fed by
      // GET /api/onboarding/crm-import, not a select. The default is
      // generic_csv, so this click is load-bearing.
      const dubsado = page.getByRole('button', { name: /^Dubsado/ })
      await expect(dubsado).toBeVisible({ timeout: 20_000 })
      await dubsado.click()
    })

    await j.step('attach the fixture', async () => {
      // The input is visually hidden inside its label, so set the files
      // on the input rather than clicking through a file chooser.
      //
      // The fixture on disk opens with a block of '#' provenance lines
      // that only the unit tests strip (loadFixtureCsv). A real Dubsado
      // export has no such lines, the shared CSV parser treats the first
      // line as the header, and the adapter correctly refused the raw
      // file ("missing required column(s)", 2026-09-15). Upload what a
      // coordinator would: the export without the test-only preamble.
      const fs = await import('node:fs')
      const raw = fs.readFileSync(DUBSADO_FIXTURE, 'utf8')
      const csv = raw
        .split(/\r?\n/)
        .filter((line) => !line.startsWith('#'))
        .join('\n')
      await page.locator('input[type="file"]').first().setInputFiles({
        name: 'dubsado-projects.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(csv, 'utf8'),
      })
    })

    await j.step('check before import shows the pre-flight diff', async () => {
      await page.getByRole('button', { name: 'Check before import' }).click()
      await expect(
        page.getByText('Pre-flight diff — no rows imported yet', { exact: false })
      ).toBeVisible({ timeout: 60_000 })
      // The diff counts rows and imports none of them. That is the whole
      // point of the step, so assert the tiles are there before commit.
      await expect(page.getByText('Total rows', { exact: false })).toBeVisible()
      await expect(page.getByText('New couples', { exact: false })).toBeVisible()
    })

    await j.step('confirm the import and read the summary', async () => {
      await page.getByRole('button', { name: 'Confirm & import' }).click()
      // buildImportMessage: "Imported all {n} rows." on a clean run, or
      // "Processed {handled} of {total}." when some rows did not validate.
      // Either is a summary; a page with neither means the commit never
      // came back.
      await expect(
        page.getByText(/Imported all \d+ rows\.|Processed \d+ of \d+\./)
      ).toBeVisible({ timeout: 90_000 })
      await expect(page.getByText(/\d+ new · \d+ matched existing/)).toBeVisible()
    })

    await j.step('the couple is on the branch', async () => {
      const sb = adminClient()
      const { data } = await sb
        .from('people')
        .select('wedding_id, first_name, last_name')
        .eq('venue_id', SEEDED.ashcombeVenueId)
        .eq('last_name', IMPORTED_COUPLE_LAST)
        .limit(1)
        .maybeSingle<{ wedding_id: string }>()
      expect(
        data?.wedding_id,
        `the import reported success but no ${IMPORTED_COUPLE_FIRST} ${IMPORTED_COUPLE_LAST} landed for the venue`
      ).toBeTruthy()
      importedWeddingId = data?.wedding_id ?? null
    })

    await j.end()
  })

  // -------------------------------------------------------------------------
  // The imported couple, on the two boards
  // -------------------------------------------------------------------------

  test('the imported couple appears on leads and pipeline with a stage pill and a Bloom number', async ({
    page,
  }) => {
    test.skip(!HAVE, NO_CREDS)
    test.skip(!importedWeddingId, 'the import step did not produce a couple')
    const j = monday(page)

    await j.step('sign in for the boards', async () => {
      await signIn(page)
    })

    await j.step('the couple is on /agent/leads', async () => {
      await page.goto('/agent/leads')
      await expect(page.getByRole('heading', { name: 'Lead Scoring', level: 1 })).toBeVisible({
        timeout: 20_000,
      })
      // The board paginates and filters; search for the couple rather
      // than hoping the first page holds them.
      const search = page.getByPlaceholder('Search leads...')
      if (await search.isVisible().catch(() => false)) {
        await search.fill(LEAD_COUPLE_LAST)
      }
      // A card, not any text: `No leads match "Nair".` contains the name
      // too and used to satisfy this assertion while the board was empty.
      await expect(page.getByText(/No leads match/)).toHaveCount(0, { timeout: 20_000 })
      await expect(page.getByText(LEAD_COUPLE_LAST, { exact: false }).first()).toBeVisible({
        timeout: 20_000,
      })
    })

    await j.step('the row carries a LifecyclePill from the stage vocabulary', async () => {
      // LifecyclePill stamps data-stage + data-agreement; the visible
      // text is OPERATOR_STAGE_LABEL. Assert the attribute, because the
      // label is the thing most likely to be reworded.
      const pill = page.locator('[data-stage]').first()
      await expect(pill).toBeVisible({ timeout: 20_000 })
      const stage = await pill.getAttribute('data-stage')
      expect(stage, 'the pill rendered with no stage').toBeTruthy()
      await expect(pill).not.toHaveText('')
    })

    await j.step('the row carries a Bloom number', async () => {
      // The plan says "a handle"; the leads board shows the Bloom number
      // (`AB-0847`, or `AB-0847.B` once a code extension exists). That is
      // the identifier a coordinator reads on this surface.
      await expect(page.getByText(/\b[A-Z]{2}-\d{3,}(\.[A-Z])?\b/).first()).toBeVisible({
        timeout: 20_000,
      })
    })

    await j.step('the couple is on /agent/pipeline', async () => {
      await page.goto('/agent/pipeline')
      await expect(page.getByRole('heading', { name: 'Pipeline', level: 1 })).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.getByText(IMPORTED_COUPLE_LAST, { exact: false }).first()).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.locator('[data-stage]').first()).toBeVisible()
    })

    await j.end()
  })

  // -------------------------------------------------------------------------
  // The wedding page
  // -------------------------------------------------------------------------

  test('the wedding page opens and all five collapsed sections expand', async ({ page }) => {
    test.skip(!HAVE, NO_CREDS)
    test.skip(!importedWeddingId, 'the import step did not produce a couple')
    const j = monday(page)

    await j.step('open the wedding page', async () => {
      await signIn(page)
      await page.goto(`/portal/weddings/${importedWeddingId}`)
      await page.waitForLoadState('domcontentloaded')
      await expect(page.getByRole('tab', { name: 'Overview' }).or(
        page.getByRole('button', { name: 'Overview' })
      ).first()).toBeVisible({ timeout: 30_000 })
    })

    for (const section of COLLAPSED_SECTIONS) {
      await j.step(`expand the ${section.key} section`, async () => {
        // CollapsibleSection is a <button aria-expanded> whose accessible
        // name is heading + subheading, and its children are not mounted
        // until it opens. So: find it closed, click, assert it opened.
        const toggle = page.getByRole('button', { name: section.heading }).first()
        await expect(
          toggle,
          `no collapsed section headed ${section.heading}`
        ).toBeVisible({ timeout: 20_000 })
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
        await toggle.scrollIntoViewIfNeeded()
        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      })
    }

    await j.end()
  })

  // -------------------------------------------------------------------------
  // The table map
  // -------------------------------------------------------------------------

  test('a guest assigned on the table map shows on the guest list', async ({ page }) => {
    test.skip(!HAVE, NO_CREDS)
    test.skip(
      !seededGuestId || !seededTableId,
      'the guest and table rows for the table map could not be seeded'
    )
    const j = monday(page)

    await j.step('open the table map', async () => {
      await signIn(page)
      await page.goto(`/portal/weddings/${SEEDED.ashcombeWeddingId}/table-map`)
      await expect(page.getByRole('heading', { name: 'Table Map', level: 1 })).toBeVisible({
        timeout: 30_000,
      })
    })

    await j.step('switch to the Guests & Seating tab', async () => {
      // Labelled `Guests & Seating (seated/total)`, not `Guests`. The
      // plain `Guests` tab lives on the parent wedding page.
      await page.getByRole('button', { name: /Guests & Seating/ }).click()
      await expect(page.locator('[data-testid="seating-tables"]')).toBeVisible({
        timeout: 20_000,
      })
    })

    await j.step('seat the guest at the table', async () => {
      // Three controls, all with real aria-labels: open the picker,
      // search, seat. No drag anywhere in this flow — dragging on this
      // page only moves table shapes on the Layout canvas.
      await page.getByRole('button', { name: `Add a guest to ${TABLE_NAME}` }).click()
      await page
        .getByRole('textbox', { name: `Search guests to seat at ${TABLE_NAME}` })
        .fill(GUEST_LAST)
      await page
        .getByRole('button', { name: new RegExp(`^Seat .*${GUEST_LAST}.* at ${TABLE_NAME}$`) })
        .click()
      await expect(
        page.getByRole('button', { name: new RegExp(`^Remove .* from ${TABLE_NAME}$`) })
      ).toBeVisible({ timeout: 20_000 })
    })

    await j.step('the assignment is the authoritative column', async () => {
      const sb = adminClient()
      const { data } = await sb
        .from('guest_list')
        .select('table_assignment')
        .eq('id', seededGuestId!)
        .maybeSingle<{ table_assignment: string | null }>()
      expect(
        data?.table_assignment,
        'seating wrote nothing to guest_list.table_assignment'
      ).toBe(TABLE_NAME)
    })

    await j.step('the guest list shows the table', async () => {
      // The coordinator's own guest list with a per-guest table value is
      // the portal preview; the wedding page's Guests tab only counts
      // them (`Table assigned: n/total`).
      await page.goto(`/portal/weddings/${SEEDED.ashcombeWeddingId}/portal`)
      await page.waitForLoadState('domcontentloaded')
      // The preview is one accordion per configured section and only the
      // first opens by default; the guest table sits inside "Guest List &
      // RSVP", which has to be expanded before its rows exist on the page.
      const guestsSection = page.getByRole('button', { name: /Guest List & RSVP/ })
      await expect(guestsSection).toBeVisible({ timeout: 30_000 })
      await guestsSection.click()
      const row = page.locator('tr', { hasText: GUEST_LAST }).first()
      await expect(row).toBeVisible({ timeout: 30_000 })
      await expect(row).toContainText(TABLE_NAME)
    })

    await j.end()
  })
})
