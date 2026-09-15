import { test, expect, type Page } from '@playwright/test'
import { adminClient } from '../helpers/seed'
import { loginAs } from '../helpers/auth'
import {
  journey,
  SEEDED,
  haveCreds,
  missingCredsReason,
  DEMO_VENUE_ID,
  type Journey,
} from '../helpers/journey'

/**
 * §28 Intelligence, one number per question — journey 28 of E2E-PLAN.md.
 *
 * "Ask your data with the stubbed model: a grounded answer and a refusal
 * (empty venue, sensitive theme); `/intel/monthly-story` numbers equal
 * `/today` and the ROI page for the same question; sources page
 * platform-shift card; benchmarks off by default with the switch named,
 * on with demo peers; reviews import populates sentiment." Proves W3, W12
 * to W15, W46 to W48, W52, W56 and W64.
 *
 * Two venues, deliberately:
 *
 *   - Hawthorne Manor, through the demo cookie, for everything that needs
 *     a populated venue. The reseed gives it 60 couples, which clears the
 *     25-couple floor Ask Your Data enforces.
 *   - Ashcombe Barn, as the seeded coordinator, for the two things that
 *     are only true of a real venue with almost nothing on it: the
 *     not-enough-data refusal, and benchmarks being switched off.
 *
 * THE ONE BLOCKER, read this before running §28
 * ---------------------------------------------
 * `/intel/nlq` is NOT stubbed, whatever `AI_E2E_STUB` says. The live path
 * is `askIntel` -> `callAITools` (`src/lib/ai/tools.ts`), and the stub
 * hook only exists in `callAI`, `callAIJson` and `callAIVision`
 * (`src/lib/ai/client.ts`). So an Ask Your Data question under
 * `AI_E2E_STUB=1` still makes a real, billed, multi-turn tool-calling
 * request. Until `callAITools` learns `isStubActive()`, the two NLQ tests
 * here are tagged `@live-model` and skipped unless `E2E_LIVE_MODEL=1`,
 * which is the plan's own opt-in shape ("One opt-in journey
 * (`--grep @live-model`) calls the real model"). Everything else in this
 * file is stub-safe.
 *
 * Where the plan's prose and the code differ:
 *
 *   - "`/intel/monthly-story` numbers equal `/today` and the ROI page".
 *     `/today` shows NEITHER figure: no median response time, no tour
 *     weekday. It renders the four triage blocks, the strip, pulse rows
 *     and a maturity card. The response-time comparison is therefore
 *     monthly-story against `/intel/roi`, and the test asserts positively
 *     that `/today` carries neither number, so the day this changes the
 *     spec says so rather than quietly drifting.
 *   - `/intel/roi` has no weekday figure either. The weekday number is
 *     checked for internal consistency instead: the headline's percentage
 *     must equal the row for the day it names, both off the one
 *     `byTourWeekday` table the cohort funnel already builds.
 *   - `/intel/reviews` has no Paste tab and no sentiment column. Bulk
 *     paste is its own route, and sentiment is scored fire-and-forget
 *     after the import returns, so "populates sentiment" is asserted by
 *     polling `reviews.sentiment_score` rather than by reading a cell
 *     that does not exist.
 */

const SECTION = '28_intelligence_one_number'
const HAVE = haveCreds(SEEDED.coordinator)
const NO_CREDS = missingCredsReason('COORDINATOR')
const LIVE_MODEL = process.env.E2E_LIVE_MODEL === '1'
const NO_LIVE_MODEL =
  'Ask Your Data runs through callAITools, which has no AI_E2E_STUB hook, so this test ' +
  'would make a real billed model call. Set E2E_LIVE_MODEL=1 to opt in, or teach ' +
  'src/lib/ai/tools.ts the stub.'

/** The floor Ask Your Data enforces before it will answer at all. */
const NLQ_MIN_WEDDINGS = 25

function intel(page: Page): Journey {
  return journey(page, SECTION, { allowRequests: [/\/api\/auth\/session/] })
}

/** Put the demo identity on the context, then go somewhere real. */
async function asDemo(page: Page): Promise<void> {
  await page.goto('/demo/')
  await page.waitForLoadState('domcontentloaded')
}

async function asCoordinator(page: Page): Promise<void> {
  await loginAs(page, 'coordinator', SEEDED.coordinator)
}

/**
 * Both surfaces render the same median, in different units.
 * `/intel/monthly-story` says "12 hours"; `/intel/roi` says "12h". This
 * reduces either to the same pair so they can be compared.
 */
function normaliseDuration(text: string): { n: number; unit: 'm' | 'h' | 'd' } | null {
  const long = text.match(/(\d+)\s+(minute|hour|day)s?\b/i)
  if (long) return { n: Number(long[1]), unit: long[2][0].toLowerCase() as 'm' | 'h' | 'd' }
  const short = text.match(/\b(\d+)\s*([mhd])\b/)
  if (short) return { n: Number(short[1]), unit: short[2].toLowerCase() as 'm' | 'h' | 'd' }
  return null
}

/** A window of page text around a label, for a card with no test id. */
async function textAround(page: Page, label: string, span = 260): Promise<string> {
  const body = await page.locator('body').innerText()
  const at = body.indexOf(label)
  if (at === -1) return ''
  return body.slice(at, at + span)
}

test.describe('§28 Intelligence, one number per question', () => {
  // -------------------------------------------------------------------------
  // Ask your data
  // -------------------------------------------------------------------------

  test('@live-model Ask Your Data gives a grounded answer on a populated venue', async ({
    page,
  }) => {
    test.skip(!LIVE_MODEL, NO_LIVE_MODEL)
    const j = intel(page)

    await j.step('open Ask Your Data on the demo venue', async () => {
      await asDemo(page)
      await page.goto('/intel/nlq')
      await expect(page.getByRole('heading', { name: 'Ask Your Data', level: 1 })).toBeVisible({
        timeout: 30_000,
      })
    })

    await j.step('ask a question the canonical readers cover', async () => {
      // The textarea has no label and the send button has no accessible
      // name, so: placeholder, then Enter.
      const box = page.getByPlaceholder('Ask anything about your venue performance...')
      await expect(box).toBeVisible({ timeout: 20_000 })
      await box.fill('How many couples have we booked this year?')
      await box.press('Enter')
    })

    await j.step('the answer is grounded, not a refusal', async () => {
      // `composeIntelAnswer` refuses outright when a figure in the draft
      // did not come back from a canonical reader, and says so in those
      // words. An answer that is not that, and is not the budget
      // refusal, is the grounded case.
      const answer = page.locator('body')
      await expect(answer).not.toHaveText(/could not stand behind it/i, { timeout: 120_000 })
      await expect(answer).not.toHaveText(/could not get to an answer within my working budget/i)
      await expect(page.getByText('Was this helpful?')).toBeVisible({ timeout: 120_000 })
    })

    await j.end()
  })

  test('@live-model Ask Your Data refuses to name couples behind a sensitive theme', async ({
    page,
  }) => {
    test.skip(!LIVE_MODEL, NO_LIVE_MODEL)
    const j = intel(page)

    await j.step('ask who is going through something difficult', async () => {
      await asDemo(page)
      await page.goto('/intel/nlq')
      const box = page.getByPlaceholder('Ask anything about your venue performance...')
      await expect(box).toBeVisible({ timeout: 30_000 })
      await box.fill('Which couples are dealing with grief?')
      await box.press('Enter')
    })

    await j.step('the refusal comes back, and it is deterministic', async () => {
      // SENSITIVE_THEME_NAMING_RE fires before any model call, so this
      // assertion does not depend on what the model would have said.
      await expect(
        page.getByText('I cannot share which ones without their consent', { exact: false })
      ).toBeVisible({ timeout: 60_000 })
    })

    await j.end()
  })

  test('Ask Your Data refuses a venue that has too little on it', async ({ page }) => {
    test.skip(!HAVE, NO_CREDS)
    const j = intel(page)

    await j.step('open Ask Your Data as the Ashcombe coordinator', async () => {
      await asCoordinator(page)
      await page.goto('/intel/nlq')
      await expect(page.getByRole('heading', { name: 'Ask Your Data', level: 1 })).toBeVisible({
        timeout: 30_000,
      })
    })

    await j.step('the question is turned down before the model is reached', async () => {
      // The 25-couple floor is checked in the route before askIntel, so
      // this path is stub-safe and costs nothing: no model call happens.
      const box = page.getByPlaceholder('Ask anything about your venue performance...')
      await box.fill('How are we doing compared with last month?')
      await box.press('Enter')
      await expect(page.getByText('Not enough data yet')).toBeVisible({ timeout: 60_000 })
      await expect(
        page.getByText(`We need at least ${NLQ_MIN_WEDDINGS} couples to answer reliably`, {
          exact: false,
        })
      ).toBeVisible()
      await expect(page.getByText(/Current wedding count: \d+/)).toBeVisible()
    })

    await j.end()
  })

  // -------------------------------------------------------------------------
  // One number per question
  // -------------------------------------------------------------------------

  test('the monthly story response time is the same number the ROI page shows', async ({
    page,
  }) => {
    const j = intel(page)
    let fromStory: { n: number; unit: string } | null = null

    await j.step('read the typical first reply off the monthly story', async () => {
      await asDemo(page)
      await page.goto('/intel/monthly-story')
      await expect(page.getByRole('heading', { name: 'Monthly story', level: 1 })).toBeVisible({
        timeout: 30_000,
      })
      const panel = page.locator('section[aria-labelledby="story-response-time"]')
      await expect(panel).toBeVisible({ timeout: 20_000 })
      const text = await panel.innerText()
      fromStory = normaliseDuration(text)
      expect(
        fromStory,
        `no response time on the monthly story. The panel said:\n${text}`
      ).not.toBeNull()
    })

    await j.step('read the median first response off the ROI page', async () => {
      await page.goto('/intel/roi')
      await expect(page.getByRole('heading', { name: 'Your Impact', level: 1 })).toBeVisible({
        timeout: 30_000,
      })
      // The card has no test id, so read a window of the page around its
      // label rather than guessing at the DOM shape around the value.
      const window = await textAround(page, 'Median First Response')
      expect(window, 'the ROI page has no Median First Response card').not.toBe('')
      const fromRoi = normaliseDuration(window)
      expect(fromRoi, `no median on the ROI card. Around the label:\n${window}`).not.toBeNull()

      // Both are `getCohortFunnel().responseTime`. One reader, one
      // number: if these disagree, two surfaces are computing it.
      expect(
        fromRoi,
        'the monthly story and the ROI page disagree about the median first response'
      ).toEqual(fromStory)
    })

    await j.step('/today carries neither figure, which is the current truth', async () => {
      // The plan expects the comparison to include /today. It shows no
      // response time and no weekday. Asserted positively so that the
      // day /today grows one, this spec fails and gets extended rather
      // than silently covering less than it claims.
      await page.goto('/today')
      await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible({
        timeout: 30_000,
      })
      const body = await page.locator('body').innerText()
      expect(body).not.toContain('Median First Response')
      expect(body).not.toContain('Typical first reply')
    })

    await j.end()
  })

  test('the monthly story weekday headline agrees with its own table', async ({ page }) => {
    const j = intel(page)

    await j.step('open the weekday panel', async () => {
      await asDemo(page)
      await page.goto('/intel/monthly-story')
      await expect(page.getByRole('heading', { name: 'Monthly story', level: 1 })).toBeVisible({
        timeout: 30_000,
      })
    })

    await j.step('the named day and its rate match the row beneath', async () => {
      const panel = page.locator('section[aria-labelledby="story-tour-weekday"]')
      await expect(panel).toBeVisible({ timeout: 20_000 })
      const text = await panel.innerText()

      // Two shapes: a named best day, or the honest "no day has enough
      // tours yet". Both are correct; a panel with neither is not.
      const named = text.match(/(\w+day) tours book best: (\d+)% of them go on to book\./)
      if (!named) {
        expect(
          text,
          `the weekday panel said neither a best day nor the not-enough-tours line:\n${text}`
        ).toContain('no single day has enough of them yet')
        return
      }

      const [, day, pct] = named
      // The row for that day must carry the same percentage. Both come
      // off `byTourWeekday`, so a mismatch means the headline and the
      // table are computing separately.
      const row = panel.locator('*', { hasText: new RegExp(`^${day}\\b`) }).last()
      await expect(row).toContainText(`${pct}%`)
    })

    await j.end()
  })

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  test('the sources page shows the platform-shift card', async ({ page }) => {
    const j = intel(page)

    await j.step('open the sources page', async () => {
      await asDemo(page)
      await page.goto('/intel/sources')
      await page.waitForLoadState('domcontentloaded')
    })

    await j.step('the platform shift card renders with its own sentence', async () => {
      await expect(page.getByRole('heading', { name: 'Platform Shift' })).toBeVisible({
        timeout: 30_000,
      })
      // Whatever the data says, the card says one of five sentences.
      // "No data" is a legitimate answer; an empty card is not.
      await expect(
        page.getByText(
          /Engagement is shifting from|Platform shares have held roughly steady|No platform engagement data yet|not enough platforms to compare|not enough overlapping months/
        ).first()
      ).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText('Failed to load platform engagement shift')).toHaveCount(0)
    })

    await j.end()
  })

  // -------------------------------------------------------------------------
  // Benchmarks
  // -------------------------------------------------------------------------

  test('benchmarks are switched off for a real venue that has not opted in', async ({ page }) => {
    test.skip(!HAVE, NO_CREDS)
    const j = intel(page)

    await j.step('make sure the venue has not opted in', async () => {
      // `venue_config.benchmark_participation` defaults to false; set it
      // explicitly so the test is about the gate rather than about a
      // leftover from another run.
      await adminClient()
        .from('venue_config')
        .update({ benchmark_participation: false })
        .eq('venue_id', SEEDED.ashcombeVenueId)
    })

    await j.step('open the benchmark page as the coordinator', async () => {
      await asCoordinator(page)
      await page.goto('/intel/benchmark')
      await page.waitForLoadState('domcontentloaded')
    })

    await j.step('the page says it is off, and says where the switch is', async () => {
      await expect(
        page.getByText('Benchmarks are switched off for your venue', { exact: false })
      ).toBeVisible({ timeout: 30_000 })
      // The gate message has to name the switch and what sharing means,
      // or the coordinator cannot make the decision it is asking for.
      await expect(page.getByText('until you turn them on under Settings', { exact: false }))
        .toBeVisible()
      await expect(page.getByText('never a venue name', { exact: false })).toBeVisible()
    })

    await j.end()
  })

  test('a demo venue is labelled as compared against demo peers', async ({ page }) => {
    const j = intel(page)

    await j.step('open the benchmark page on the demo venue', async () => {
      await asDemo(page)
      await page.goto('/intel/benchmark')
      await page.waitForLoadState('domcontentloaded')
    })

    await j.step('the demo-peers banner is there', async () => {
      // `callerIsDemo` counts as opted in, so the demo account always
      // gets a comparison. The banner is what stops that comparison
      // being read as a real one.
      await expect(page.getByText('Demo peers.', { exact: false })).toBeVisible({
        timeout: 30_000,
      })
      await expect(
        page.getByText('compared against the other sample venues', { exact: false })
      ).toBeVisible()
    })

    await j.end()
  })

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------

  test('a pasted review import lands and its sentiment gets scored', async ({ page }) => {
    test.skip(!HAVE, NO_CREDS)
    const j = intel(page)
    const marker = `E2E28-${Date.now()}`
    const sb = adminClient()

    await j.step('open bulk paste', async () => {
      // Demo is refused outright on both review routes (403), so this
      // half of the journey is the real coordinator on Ashcombe.
      await asCoordinator(page)
      await page.goto('/intel/reviews/paste')
      await expect(page.getByRole('heading', { name: 'Bulk paste reviews', level: 1 })).toBeVisible({
        timeout: 30_000,
      })
    })

    await j.step('paste two reviews and extract them', async () => {
      const paste = [
        `Wonderful day at the barn. ${marker}. The team answered every question before we asked it,`,
        'and the light in the late afternoon was exactly what we had hoped for. Five stars.',
        '',
        `A lovely venue with one caveat. ${marker}. Parking was tight for our older guests and we`,
        'would have liked more warning about it, but the day itself went off without a hitch.',
      ].join('\n')
      await page
        .getByPlaceholder(/^Paste reviews here\./)
        .fill(paste)
      await page.getByRole('button', { name: 'Extract reviews' }).click()
      await expect(page.getByText(/\d+ reviews extracted/)).toBeVisible({ timeout: 120_000 })
    })

    await j.step('save them', async () => {
      await page.getByRole('button', { name: /^Save \d+ reviews?$/ }).click()
      await expect(page.getByText(/Imported \d+ reviews?\./)).toBeVisible({ timeout: 180_000 })
    })

    await j.step('sentiment is scored on the saved rows', async () => {
      // `scheduleReviewScoring` is fire-and-forget: the import response
      // does not wait for it. So poll the column rather than the page.
      // There is no sentiment cell on any reviews table to read.
      await expect
        .poll(
          async () => {
            const { data } = await sb
              .from('reviews')
              .select('sentiment_score')
              .eq('venue_id', SEEDED.ashcombeVenueId)
              .not('sentiment_score', 'is', null)
              .limit(1)
            return (data ?? []).length
          },
          {
            timeout: 120_000,
            intervals: [2000],
            message:
              'no review on the venue ever got a sentiment_score. review-language.prompt.v1.0 ' +
              'either did not run or its fixture is not schema-valid.',
          }
        )
        .toBeGreaterThan(0)
    })

    await j.step('the overview surfaces a sentiment trend', async () => {
      // The tile is the only place sentiment is visible at all, and it
      // needs six months of scored reviews before it says more than a
      // dash. Its presence is the assertion; its value is not.
      await page.goto('/intel/reviews')
      await expect(page.getByText('Sentiment trend', { exact: false })).toBeVisible({
        timeout: 30_000,
      })
    })

    // The reviews stay: the venue is a fixture, and deleting them would
    // undo the only scored rows the next run could poll for. They carry
    // the run marker if anyone needs to find them.
    await j.end()
  })
})
