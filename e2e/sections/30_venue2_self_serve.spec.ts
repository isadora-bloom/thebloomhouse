import { test, expect, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { adminClient } from '../helpers/seed'
import { loginAs } from '../helpers/auth'
import { loadE2EEnv } from '../helpers/env'
import {
  journey,
  SEEDED,
  haveCreds,
  missingCredsReason,
  DEMO_VENUE_2_ID,
  type Journey,
} from '../helpers/journey'

/**
 * §30 Venue 2 self-serve — journey 30 of E2E-PLAN.md.
 *
 * "org_admin invites a manager for Ashcombe Barn; the manager completes
 * onboarding without a terminal (project steps, CRM import, packages,
 * tour scheduler, web-form import); readiness writer flips;
 * `scripts/isolation-battery.ts` against Crestwood and Ashcombe passes
 * with zero cross-venue rows." Proves W5, W38, and the plan's week 4 and
 * week 7 gates.
 *
 * What it needs from the branch (`scripts/e2e-seed.ts --apply` prints it):
 *
 *   E2E_ORG_ADMIN_EMAIL / E2E_ORG_ADMIN_PASSWORD
 *   E2E_ASHCOMBE_VENUE_ID
 *
 * and, for the last test only, the branch Supabase credentials on
 * `process.env` — which `loadE2EEnv()` has already put there.
 *
 * Where the plan's prose and the code differ:
 *
 *   1. There is no `/accept-invite` route. The invitation link is
 *      `/join?token=<uuid>`, built by the invite route itself.
 *   2. The invitation email cannot be captured without a Resend key, and
 *      `POST /api/team/invite` deliberately does not return the token
 *      (that absence is one of the assertions here). So the token is read
 *      from `team_invitations` with the service client — the same thing
 *      the email would have carried, without making the run depend on an
 *      inbox.
 *   3. The manager cannot finish the five-day project "without a
 *      terminal" in the sense of reaching Go Live. Three Day-3-to-5 steps
 *      (voice DNA extraction, data cleanup, booked-data recovery) have no
 *      Mark-done path at all: they are completed only by their own inline
 *      action succeeding, which needs a Gmail history import and real
 *      rows to clean. `Mark done` IS available on every other step
 *      regardless of the current day, so the four steps the journey names
 *      — CRM import, packages, tour scheduler import, web-form import —
 *      are reachable and are what this spec drives.
 *   4. "The readiness writer flips" is `recordReadinessEvaluation`
 *      writing `onboarding_projects.readiness_state` and
 *      `readiness_failures`. Its only caller is
 *      `POST /api/onboarding/project/readiness`, whose button lives on
 *      Day 5 behind those unreachable steps. The test therefore makes the
 *      same call the button makes, from the manager's own session, and
 *      asserts the column went from null to a report. What it does NOT
 *      assert is that readiness PASSES: that is a fact about the data on
 *      the branch, not about the writer.
 */

test.describe.configure({ mode: 'serial' })

const SECTION = '30_venue2_self_serve'
const HAVE_ADMIN = haveCreds(SEEDED.orgAdmin)
const NO_ADMIN = missingCredsReason('ORG_ADMIN')

/** The manager this journey invites. Not the seeded one, who is already in. */
const INVITEE_EMAIL = 'e2e-manager2@ashcombe.test'
const INVITEE_PASSWORD = 'E2eManager2!30a'

/** The four steps the plan names, by their exact labels in PROJECT_PLAN. */
const NAMED_STEPS: ReadonlyArray<{ what: string; label: string }> = [
  { what: 'CRM import', label: 'Upload everything you have on your booked couples' },
  { what: 'packages', label: 'Extract package catalog from form schema' },
  { what: 'tour scheduler import', label: 'Import tour scheduler history' },
  { what: 'web-form import', label: 'Import web-form submissions' },
]

let inviteToken: string | null = null
let projectId: string | null = null

function selfServe(page: Page): Journey {
  return journey(page, SECTION, { allowRequests: [/\/api\/auth\/session/] })
}

test.describe('§30 Venue 2 self-serve', () => {
  test.beforeAll(async () => {
    const sb = adminClient()
    // Make the invitation issuable again: a pending row for the address
    // is a 409, and an existing auth user is a "already a member".
    await sb.from('team_invitations').delete().eq('email', INVITEE_EMAIL)
    const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 200 })
    const prior = list?.users?.find(
      (u) => (u.email ?? '').toLowerCase() === INVITEE_EMAIL.toLowerCase()
    )
    if (prior) {
      await sb.from('user_profiles').delete().eq('id', prior.id)
      await sb.auth.admin.deleteUser(prior.id).catch(() => undefined)
    }
  })

  test.afterAll(async () => {
    const sb = adminClient()
    await sb.from('team_invitations').delete().eq('email', INVITEE_EMAIL)
  })

  // -------------------------------------------------------------------------
  // The invitation
  // -------------------------------------------------------------------------

  test('the org_admin invites a manager, and the response carries no token', async ({ page }) => {
    test.skip(!HAVE_ADMIN, NO_ADMIN)
    const j = selfServe(page)

    await j.step('sign in as the org admin', async () => {
      await loginAs(page, 'org_admin', SEEDED.orgAdmin)
    })

    await j.step('invite a venue manager for Ashcombe Barn', async () => {
      const res = await page.request.post('/api/team/invite', {
        data: {
          email: INVITEE_EMAIL,
          role: 'venue_manager',
          venueId: SEEDED.ashcombeVenueId,
        },
        failOnStatusCode: false,
      })
      expect(res.status(), `inviting answered ${res.status()}`).toBe(200)

      const body = (await res.json()) as Record<string, unknown>
      expect(body.success).toBe(true)
      expect(body.invitationId, 'the invitation id is the only handle the caller gets').toBeTruthy()

      // SEC: the accept link is a credential. It goes in the email and
      // nowhere else. A token in this response would put it in every
      // browser devtools network tab and every proxy log.
      const serialised = JSON.stringify(body)
      for (const leak of ['token', 'inviteLink', 'invite_link', 'accept_url', '/join?']) {
        expect(
          serialised.toLowerCase(),
          `the invite response leaked "${leak}": ${serialised}`
        ).not.toContain(leak.toLowerCase())
      }
    })

    await j.step('the invitation row exists, and only the row has the token', async () => {
      const { data } = await adminClient()
        .from('team_invitations')
        .select('token, status, role, venue_id')
        .eq('email', INVITEE_EMAIL)
        .maybeSingle<{ token: string; status: string; role: string; venue_id: string | null }>()
      expect(data?.status).toBe('pending')
      expect(data?.role).toBe('venue_manager')
      expect(data?.venue_id).toBe(SEEDED.ashcombeVenueId)
      expect(data?.token, 'no token was written, so the emailed link points at nothing').toBeTruthy()
      inviteToken = data?.token ?? null
    })

    await j.end()
  })

  test('the manager accepts the invitation and lands inside', async ({ page }) => {
    test.skip(!HAVE_ADMIN, NO_ADMIN)
    test.skip(!inviteToken, 'the invitation step produced no token')
    const j = selfServe(page)

    await j.step('open the emailed link with no session', async () => {
      await page.context().clearCookies()
      await page.goto(`/join?token=${inviteToken}`)
      // /join is in PUBLIC_ROUTES, so this is reachable signed out.
      await expect(page.getByRole('heading', { name: "You've been invited!" })).toBeVisible({
        timeout: 30_000,
      })
      await expect(page.getByText('Venue Manager', { exact: false })).toBeVisible()
    })

    await j.step('create the account', async () => {
      await page.getByLabel('First Name').fill('Mira')
      await page.getByLabel('Last Name').fill('Manager')
      await page.getByLabel('Password', { exact: true }).fill(INVITEE_PASSWORD)
      await page.getByLabel('Confirm Password').fill(INVITEE_PASSWORD)
      await page.getByRole('button', { name: 'Create Account & Join' }).click()
      await expect(page.getByRole('heading', { name: 'Welcome aboard!' })).toBeVisible({
        timeout: 60_000,
      })
    })

    await j.step('the profile is scoped to Ashcombe Barn', async () => {
      await expect
        .poll(
          async () => {
            const { data } = await adminClient()
              .from('team_invitations')
              .select('status')
              .eq('email', INVITEE_EMAIL)
              .maybeSingle<{ status: string }>()
            return data?.status ?? null
          },
          { timeout: 30_000, message: 'the invitation never moved off pending' }
        )
        .toBe('accepted')

      const { data: list } = await adminClient().auth.admin.listUsers({ page: 1, perPage: 200 })
      const created = list?.users?.find(
        (u) => (u.email ?? '').toLowerCase() === INVITEE_EMAIL.toLowerCase()
      )
      expect(created, 'no auth user was created for the invitee').toBeTruthy()
      const { data: profile } = await adminClient()
        .from('user_profiles')
        .select('role, venue_id')
        .eq('id', created!.id)
        .maybeSingle<{ role: string; venue_id: string | null }>()
      expect(profile?.role).toBe('venue_manager')
      expect(profile?.venue_id).toBe(SEEDED.ashcombeVenueId)
    })

    await j.end()
  })

  // -------------------------------------------------------------------------
  // The project
  // -------------------------------------------------------------------------

  test('the manager works the onboarding project without a terminal', async ({ page }) => {
    test.skip(!HAVE_ADMIN, NO_ADMIN)
    test.skip(!inviteToken, 'the invitation step produced no token')
    const j = selfServe(page)

    await j.step('open the project as the new manager', async () => {
      await loginAs(page, 'venue_manager', {
        email: INVITEE_EMAIL,
        password: INVITEE_PASSWORD,
      })
      await page.goto('/onboarding/project')
      await page.waitForLoadState('domcontentloaded')
    })

    await j.step('start the project if there is not one', async () => {
      const start = page.getByRole('button', { name: 'Start project' })
      if (await start.isVisible().catch(() => false)) {
        await start.click()
      }
      await expect(page.getByText(/Day \d of 5/)).toBeVisible({ timeout: 30_000 })
    })

    for (const step of NAMED_STEPS) {
      await j.step(`the ${step.what} step reaches a done state`, async () => {
        // Each step is an <li> carrying its label. Mark done shows on
        // any incomplete step of a project that is not live or archived,
        // whatever day is current, so these four are reachable without
        // advancing through the whole plan.
        const item = page.locator('li', { hasText: step.label }).first()
        await expect(item, `no "${step.label}" step on the project`).toBeVisible({
          timeout: 20_000,
        })
        const markDone = item.getByRole('button', { name: 'Mark done' })
        if (await markDone.isVisible().catch(() => false)) {
          await markDone.click()
        }
        // Done is a "Completed <date>" line under the label. The button
        // disappearing is not enough — a failed write would do that too.
        await expect(item).toContainText(/Completed /, { timeout: 30_000 })
      })
    }

    await j.step('the completions are on the project row', async () => {
      const { data } = await adminClient()
        .from('onboarding_projects')
        .select('id, coordinator_notes')
        .eq('venue_id', SEEDED.ashcombeVenueId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string; coordinator_notes: Record<string, unknown> }>()
      expect(data?.id, 'no onboarding project was created for the venue').toBeTruthy()
      projectId = data?.id ?? null
      // coordinator_notes is `{ day_1: { <stepKey>: { completed_at } } }`.
      const notes = JSON.stringify(data?.coordinator_notes ?? {})
      expect(notes, 'nothing was written to coordinator_notes').toContain('completed_at')
    })

    await j.end()
  })

  test('the readiness writer flips', async ({ page }) => {
    test.skip(!HAVE_ADMIN, NO_ADMIN)
    test.skip(!projectId, 'the project step produced no project id')
    const j = selfServe(page)

    await j.step('clear any readiness the branch already had', async () => {
      await adminClient()
        .from('onboarding_projects')
        .update({ readiness_state: null, readiness_failures: null, readiness_passed_at: null })
        .eq('id', projectId!)
    })

    await j.step('run the readiness gate from the manager session', async () => {
      // The Day-5 button is unreachable: voice DNA extraction, data
      // cleanup and booked-data recovery have no Mark-done path, so the
      // project cannot advance that far without real data. This is the
      // same call that button makes, from the same session, with the
      // same auth.
      await loginAs(page, 'venue_manager', {
        email: INVITEE_EMAIL,
        password: INVITEE_PASSWORD,
      })
      const res = await page.request.post('/api/onboarding/project/readiness', {
        data: { projectId },
        failOnStatusCode: false,
      })
      expect(res.status(), `the readiness gate answered ${res.status()}`).toBe(200)
      const body = (await res.json()) as { ok?: boolean; report?: Record<string, unknown> }
      expect(body.ok).toBe(true)
      expect(body.report, 'the gate returned no report').toBeTruthy()
    })

    await j.step('the verdict is on the row', async () => {
      const { data } = await adminClient()
        .from('onboarding_projects')
        .select('readiness_state, readiness_failures, readiness_passed_at')
        .eq('id', projectId!)
        .maybeSingle<{
          readiness_state: unknown
          readiness_failures: unknown
          readiness_passed_at: string | null
        }>()
      // The writer flipping means a verdict was recorded. Whether it
      // PASSED is a fact about the branch's data, so it is reported, not
      // asserted: readiness_passed_at is set on a pass and nulled on a
      // fail, and both are a correct write.
      expect(
        data?.readiness_state,
        'the readiness gate returned a report but nothing was written to readiness_state'
      ).toBeTruthy()
      test.info().annotations.push({
        type: 'readiness',
        description: data?.readiness_passed_at ? 'passed' : 'recorded a failing verdict',
      })
    })

    await j.end()
  })

  // -------------------------------------------------------------------------
  // The isolation battery
  // -------------------------------------------------------------------------

  test('the isolation battery finds zero cross-venue rows between Crestwood and Ashcombe', async () => {
    const env = loadE2EEnv()
    test.skip(
      !env.supabaseUrl || !env.serviceRoleKey,
      `the branch credentials are not in ${env.envFile}, so the battery has nothing to read`
    )
    test.setTimeout(300_000)

    // `scripts/isolation-battery.ts` does NOT read E2E_ENV_FILE — it
    // takes ISOLATION_SUPABASE_URL / ISOLATION_SERVICE_KEY, and falls
    // back to a `.env.local` in the cwd, which on a developer machine is
    // production. So the branch credentials are handed in explicitly and
    // the fallback is never reached. It is read-only by construction:
    // every write through its client throws ReadOnlyViolation.
    const result = await runBattery({
      ISOLATION_SUPABASE_URL: env.supabaseUrl,
      ISOLATION_SERVICE_KEY: env.serviceRoleKey,
    })

    expect(
      result.code,
      `the battery exited ${result.code}. stderr:\n${result.stderr}\nstdout:\n${result.stdout.slice(-4000)}`
    ).toBe(0)

    const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) as BatteryReport
    expect(parsed.summary?.fail ?? -1, 'the battery reported a failing surface').toBe(0)

    // Stronger than "no FAIL": no surface handed back a row belonging to
    // the other venue, and no row carried the other venue's id.
    const leaks = (parsed.results ?? []).filter(
      (r) => (r.foreignIds?.length ?? 0) > 0 || (r.venueIdMismatches?.length ?? 0) > 0
    )
    expect(
      leaks.map((l) => `${l.surface} (${l.venue})`),
      'a surface returned rows from the other venue'
    ).toEqual([])

    test.info().annotations.push({
      type: 'issues',
      description: JSON.stringify([]),
    })
  })
})

// ---------------------------------------------------------------------------
// Spawning the battery
// ---------------------------------------------------------------------------

interface BatteryResult {
  surface: string
  venue: string
  foreignIds?: unknown[]
  venueIdMismatches?: unknown[]
  status: string
}

interface BatteryReport {
  results?: BatteryResult[]
  summary?: { pass: number; fail: number; skip: number; refused: number }
}

function runBattery(
  extraEnv: Record<string, string>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      [
        'tsx',
        'scripts/isolation-battery.ts',
        '--venue-a',
        DEMO_VENUE_2_ID,
        '--venue-b',
        SEEDED.ashcombeVenueId,
        '--json',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...extraEnv },
        shell: process.platform === 'win32',
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}
