/**
 * The shared spine of journeys 26 to 32.
 *
 * E2E-PLAN.md, "Journeys": "Each journey is one spec file, screenshots at
 * every named step, and a final assertion on the console (no errors) and
 * the network (no 4xx or 5xx that the step does not expect)."
 *
 * Three jobs, so that each spec can be about the product rather than
 * about bookkeeping:
 *
 *   1. `step(name, fn?)` runs a named piece of the journey and drops a
 *      screenshot for it. The name is the caption in the report.
 *   2. Console errors and failing responses are collected from the moment
 *      the journey starts, with an allow-list for the refusals a step is
 *      deliberately provoking (a 403 you asked for is not a defect).
 *   3. `end()` writes the `issues` annotation that `e2e/generate-report.ts`
 *      already reads — `{ type, detail }[]` under annotation type
 *      `issues` — and then fails the test if anything unexpected landed.
 *
 * Where the screenshots go
 * ------------------------
 * `e2e/report/screens/<section>/<step>.png`, as the journey brief asks.
 *
 * Two things to know about that path:
 *
 *   - `playwright.config.ts` points the HTML reporter at `e2e/report`,
 *     and the HTML reporter DELETES its output folder in `onEnd`, after
 *     the last test. So on a default run the screenshots exist for the
 *     whole run and are then wiped with the rest of the folder when the
 *     report is written. Set `E2E_SCREENSHOT_DIR` to somewhere outside
 *     `e2e/report` (say `e2e/screens`) to keep them, or move the HTML
 *     reporter's `outputFolder`. This is called out rather than worked
 *     around because `playwright.config.ts` is not this workstream's to
 *     edit.
 *   - The suite runs two projects. `chromium-desktop` writes to the
 *     documented path; any other project gets its name appended to the
 *     section folder so the mobile run does not silently overwrite the
 *     desktop shots.
 */

import { expect, test, type Page, type Response } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Exactly the shape `e2e/generate-report.ts` parses out of the annotation. */
export interface JourneyIssue {
  type: 'console-error' | 'bad-text' | 'failed-request' | 'broken-image' | 'empty-page'
  detail: string
}

/** The project whose screenshots land on the documented path. */
const PRIMARY_PROJECT = 'chromium-desktop'

/** Screenshot root. Overridable so a run can keep them past the HTML report. */
export function screenshotRoot(): string {
  return process.env.E2E_SCREENSHOT_DIR?.trim() || join('e2e', 'report', 'screens')
}

/**
 * Console noise that is not a product defect.
 *
 * Kept short on purpose. Every entry here is a hole in the console
 * assertion, so it has to earn its place: a dev-server artefact, or a
 * browser-emitted warning that no application code can suppress.
 */
const CONSOLE_IGNORE: RegExp[] = [
  // Next's dev overlay and fast refresh chatter.
  /\[Fast Refresh\]/i,
  /webpack-hmr/i,
  /react-devtools/i,
  // Chromium's own autofill and permissions-policy grumbles.
  /Permissions-Policy header:/i,
  /Error with Permissions-Policy/i,
  // The favicon a dev server does not serve.
  /favicon\.ico/i,
  // Third-party font preloads the app does not control.
  /was preloaded using link preload but not used/i,
]

/** Requests whose failure is never the journey's business. */
const REQUEST_IGNORE: RegExp[] = [
  /\/favicon\.ico/i,
  /\/__nextjs/i,
  /\/_next\/webpack-hmr/i,
  /\/_next\/static\/.*\.hot-update\./i,
  // Telemetry and analytics beacons, which fail on a branch env by design.
  /\/api\/telemetry/i,
]

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'step'
  )
}

export interface JourneyOptions {
  /**
   * Extra console patterns this journey tolerates. Use it for a message
   * a step is deliberately causing, and say why in the spec.
   */
  allowConsole?: RegExp[]
  /** Extra request patterns this journey tolerates, same rule. */
  allowRequests?: RegExp[]
  /** Full-page screenshots. On by default; a long board is worth seeing. */
  fullPage?: boolean
}

export class Journey {
  readonly section: string
  private readonly page: Page
  private readonly consoleErrors: string[] = []
  private readonly failedRequests: string[] = []
  private readonly allowConsole: RegExp[]
  private readonly allowRequests: RegExp[]
  private readonly fullPage: boolean
  private readonly taken: string[] = []
  private index = 0

  constructor(page: Page, section: string, opts: JourneyOptions = {}) {
    this.page = page
    this.section = section
    this.allowConsole = [...CONSOLE_IGNORE, ...(opts.allowConsole ?? [])]
    this.allowRequests = [...REQUEST_IGNORE, ...(opts.allowRequests ?? [])]
    this.fullPage = opts.fullPage ?? true

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      if (this.allowConsole.some((re) => re.test(text))) return
      this.consoleErrors.push(text)
    })

    page.on('pageerror', (err) => {
      const text = `pageerror: ${err.message}`
      if (this.allowConsole.some((re) => re.test(text))) return
      this.consoleErrors.push(text)
    })

    page.on('response', (res: Response) => {
      const status = res.status()
      if (status < 400) return
      const line = `${status} ${res.request().method()} ${res.url()}`
      if (this.allowRequests.some((re) => re.test(res.url()))) return
      this.failedRequests.push(line)
    })

    page.on('requestfailed', (req) => {
      const line = `failed ${req.method()} ${req.url()} (${req.failure()?.errorText ?? 'unknown'})`
      if (this.allowRequests.some((re) => re.test(req.url()))) return
      this.failedRequests.push(line)
    })
  }

  /** Tolerate a refusal a later step is about to provoke on purpose. */
  allowRequest(...patterns: RegExp[]): void {
    this.allowRequests.push(...patterns)
  }

  /** Tolerate a console line a later step is about to provoke on purpose. */
  allowConsoleLine(...patterns: RegExp[]): void {
    this.allowConsole.push(...patterns)
  }

  /** Where a given step's screenshot lands. */
  screenshotPath(name: string): string {
    const projectName = test.info().project.name
    const folder =
      projectName === PRIMARY_PROJECT ? this.section : `${this.section}__${slug(projectName)}`
    const n = String(++this.index).padStart(2, '0')
    return join(screenshotRoot(), folder, `${n}-${slug(name)}.png`)
  }

  /** Screenshot only. Prefer `step()`; this is for a mid-step capture. */
  async shot(name: string): Promise<string> {
    const path = this.screenshotPath(name)
    mkdirSync(dirname(path), { recursive: true })
    // A screenshot is evidence, never the reason a journey fails: a page
    // that is still settling should not turn a passing step red.
    await this.page.screenshot({ path, fullPage: this.fullPage }).catch(async () => {
      await this.page.screenshot({ path }).catch(() => undefined)
    })
    this.taken.push(path)
    return path
  }

  /**
   * One named step of the journey: run the work, then capture the page.
   * The step name is what the report shows, so name it in the plan's
   * words ("the strip renders four blocks"), not in selector terms.
   */
  async step<T>(name: string, fn?: () => Promise<T>): Promise<T | undefined> {
    let out: T | undefined
    try {
      if (fn) out = await fn()
    } finally {
      await this.shot(name)
    }
    return out
  }

  /** Everything seen so far, in the report's own shape. */
  issues(): JourneyIssue[] {
    return [
      ...this.consoleErrors.map((detail): JourneyIssue => ({ type: 'console-error', detail })),
      ...this.failedRequests.map((detail): JourneyIssue => ({ type: 'failed-request', detail })),
    ]
  }

  /** The screenshots this journey produced, for a report row per step. */
  screenshots(): string[] {
    return [...this.taken]
  }

  /**
   * The end of every test: annotate for the report, then assert.
   *
   * The annotation goes on whether or not anything was found, so a clean
   * journey still records its screenshots. The assertions come after, so
   * the report keeps the detail even when the test goes red.
   */
  async end(): Promise<void> {
    const found = this.issues()
    const info = test.info()
    info.annotations.push({ type: 'issues', description: JSON.stringify(found) })
    info.annotations.push({
      type: 'screenshots',
      description: JSON.stringify(this.screenshots()),
    })

    expect(
      this.consoleErrors,
      `console errors during §${this.section}:\n  ${this.consoleErrors.join('\n  ')}`
    ).toEqual([])
    expect(
      this.failedRequests,
      `unexpected 4xx/5xx during §${this.section}:\n  ${this.failedRequests.join('\n  ')}`
    ).toEqual([])
  }
}

/** Start a journey on a page. One per test. */
export function journey(page: Page, section: string, opts: JourneyOptions = {}): Journey {
  return new Journey(page, section, opts)
}

/**
 * Credentials the seed prints. `scripts/e2e-seed.ts --apply` ends with a
 * block of `E2E_*` lines; these are the names in it.
 *
 * A missing credential is a skip with a reason, never a silent pass — a
 * journey that "passed" because it could not log in is worse than no
 * journey at all (the rule §29 already follows).
 */
export const SEEDED = {
  orgAdmin: {
    email: process.env.E2E_ORG_ADMIN_EMAIL ?? '',
    password: process.env.E2E_ORG_ADMIN_PASSWORD ?? '',
  },
  manager: {
    email: process.env.E2E_MANAGER_EMAIL ?? '',
    password: process.env.E2E_MANAGER_PASSWORD ?? '',
  },
  coordinator: {
    email: process.env.E2E_COORDINATOR_EMAIL ?? '',
    password: process.env.E2E_COORDINATOR_PASSWORD ?? '',
  },
  ashcombeVenueId:
    process.env.E2E_ASHCOMBE_VENUE_ID ?? 'a5c0b0e0-0000-4000-8000-000000000010',
  ashcombeWeddingId:
    process.env.E2E_ASHCOMBE_WEDDING_ID ?? 'a5c0b0e0-0000-4000-8000-000000000020',
  coupleInviteToken:
    process.env.E2E_COUPLE_INVITE_TOKEN ?? 'e2e-ashcombe-couple-invite-0001',
  coupleInviteEmail: process.env.E2E_COUPLE_INVITE_EMAIL ?? 'e2e-couple@ashcombe.test',
  ashcombeSlug: process.env.E2E_ASHCOMBE_SLUG ?? 'ashcombe-barn',
} as const

/** Hawthorne Manor, from `supabase/seed.sql`. The fixed demo venue. */
export const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201'
export const DEMO_VENUE_SLUG = 'hawthorne-manor'

/** Crestwood Farm, the demo venue the contract seed hangs off. */
export const DEMO_VENUE_2_ID = '22222222-2222-2222-2222-222222222202'

export function haveCreds(c: { email: string; password: string }): boolean {
  return Boolean(c.email && c.password)
}

export function missingCredsReason(name: string): string {
  return (
    `E2E_${name}_EMAIL / E2E_${name}_PASSWORD are not set. Run ` +
    '`npx tsx scripts/e2e-seed.ts --apply` and paste the printed env lines into the branch env.'
  )
}
