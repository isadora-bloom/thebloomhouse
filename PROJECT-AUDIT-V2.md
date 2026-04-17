# PROJECT AUDIT — V2 (corrected)

_Date: 2026-04-16. Supersedes `PROJECT-AUDIT.md` (2026-04-07)._
_V1 is retained on disk for traceability. Do not treat V1 as current._

This document replaces the April 7 audit after a line-by-line re-verification
found material false negatives. Every BUG-\*\* and GAP-\*\* claim in V1 was
re-checked against current code. Where V1 was wrong, V2 reclassifies with
evidence. Where V1 was right, V2 restates with a current line number.

---

## 1. Why the original audit was wrong

The April 7 audit produced at least eleven false negatives (see §3). Four root
causes explain them:

1. **Grep-only verification with too-narrow patterns.** The original auditor
   grepped for one exact symbol (e.g. `plan_tier`, `RSVPForm`, `exportCsv`) and
   treated zero hits as "not built". Several features WERE built but under
   different names — `usePlanTier`, `RSVPSection` (inline in `/w/[slug]`),
   `exportToCsv` — and all were missed.

2. **UI layer vs API layer conflated.** GAP-12 ("plan_tier is stored but never
   checked") is half-true. The UI layer IS wired (`use-plan-tier.ts`,
   `UpgradeGate`, sidebar filtering). API routes do NOT enforce it. V1 called
   the whole thing unbuilt instead of splitting into §8a (UI, built) and §8
   (API, pending).

3. **Inline implementations missed.** Several large features live inside page
   files rather than dedicated components. `RSVPSection` is ~400 lines inside
   `src/app/w/[slug]/page.tsx`. `exportCsv()` is defined inline in
   `src/app/_couple-pages/guests/page.tsx`. Grepping for a component filename
   returned nothing and V1 inferred absence.

4. **No differentiation between "endpoint" and "flow".** GAP-01 ("no email
   sending infra") was marked missing because there was no
   `/api/send-email/route.ts`. The infra actually lives in
   `src/lib/services/email.ts` (Resend wrapper) and is called from
   auth/password-reset flows. The endpoint-shaped grep hid the service layer.

A smaller fifth factor: V1 was written before migrations 051 and 052 landed,
which closed eight of the twelve BUG-\*\* items by themselves. V1's bug list
is mostly stale, not wrong-at-time-of-writing.

---

## 2. Corrections — where V1 got it wrong

Every row in this table is an item V1 classified incorrectly. Evidence column
is a live path+line pointer as of the April 16 sweep.

| ID     | V1 said    | V2 says      | Evidence |
|--------|------------|--------------|----------|
| BUG-01 | TRUE (open) | **FIXED**    | `src/app/api/webhooks/stripe/route.ts:157,200` default plan is `'starter'`, not `'free'` |
| BUG-02 | TRUE (open) | **FIXED**    | `supabase/migrations/051_schema_fixes.sql` adds `stripe_subscription_id`, `stripe_customer_id` to `venues` |
| BUG-03 | TRUE (open) | **FIXED**    | `051_schema_fixes.sql` adds unique index on `weather_data(venue_id, weather_date)` |
| BUG-04 | TRUE (open) | **FIXED**    | `051_schema_fixes.sql` adds unique index on `search_trends(venue_id, trend_date, keyword)` |
| BUG-05 | TRUE (open) | **FIXED**    | `051_schema_fixes.sql` adds unique index on `economic_indicators(indicator, indicator_date)` |
| BUG-06 | TRUE (open) | **FIXED**    | `supabase/migrations/052_consolidate_budget.sql` copies `budget` → `budget_items`, deprecates `budget` via COMMENT |
| BUG-07 | TRUE (open) | **FIXED**    | `supabase/functions/email-poll/index.ts` now reads from `venue_config` + `gmail_connections`, not the `venues` column that no longer exists |
| BUG-08 | TRUE (open) | **FIXED**    | `src/app/_couple-pages/staffing/page.tsx:272` has `useCallback(..., [supabase, weddingId])` — the empty-deps bug is gone |
| BUG-09 | TRUE (open) | **FIXED**    | `051_schema_fixes.sql` adds `'readonly'` to the `user_profiles.role` CHECK constraint |
| BUG-10 | TRUE (open) | **FIXED**    | `src/lib/ai/client.ts` sets `CLAUDE_TIMEOUT_MS = 30_000` with AbortController |
| BUG-11 | TRUE (open) | **FIXED**    | `src/lib/ai/client.ts` throws if `ANTHROPIC_API_KEY` is missing instead of silently falling back |
| GAP-01 | TRUE (unbuilt) | **FIXED** | `src/lib/services/email.ts` — Resend wrapper, console.log fallback in dev, used by `/auth/forgot-password` |
| GAP-10 | TRUE (unbuilt) | **PARTIAL — guest CSV BUILT, budget/timeline still missing** | Built: `src/lib/utils/csv-export.ts` + `src/app/_couple-pages/guests/page.tsx:755` (`exportToCsv('guest-list.csv', …)`). Unbuilt: budget page + timeline page have no export controls |
| GAP-11 | TRUE (unbuilt) | **BUILT**    | `src/app/w/[slug]/page.tsx:719` `RSVPSection` (search → confirm → form → success). API: `src/app/api/public/wedding-website/route.ts` GET `?action=search_guest`, POST `?action=rsvp`. Writes `guest_list` + `rsvp_responses` |
| GAP-12 | TRUE (unbuilt) | **PARTIAL — UI layer BUILT, API layer still missing** | Built: `src/lib/hooks/use-plan-tier.ts`, `src/components/ui/upgrade-gate.tsx`, `src/app/(platform)/intel/layout.tsx` wraps with `<UpgradeGate requiredTier="intelligence">`, sidebar hides `Intelligence` section for starter. Unbuilt: no API route under `src/app/api/` checks `plan_tier` — a starter coordinator can still POST `/api/intel/nlq` directly |
| GAP-14 | TRUE (unbuilt) | **FIXED**    | `src/app/(auth)/forgot-password/page.tsx` + `src/app/(auth)/reset-password/page.tsx` exist and wire `resetPasswordForEmail` + update flow |

Totals: 11 bugs moved to FIXED, 3 gaps moved to FIXED/BUILT, 2 gaps moved to
PARTIAL with a narrower remaining scope.

---

## 3. Verified unbuilt — the real to-do

These items V1 flagged and V2 confirms as still open. Scope is narrower in
some cases than V1 stated — re-read before planning work.

| ID     | Scope still open |
|--------|-------------------|
| BUG-12 | In-memory rate limiters in `/api/sage` family. Survives a single process only. Replace with `upstash/ratelimit` or DB-backed counter before horizontal scale |
| GAP-02 | Stripe Checkout UI + customer-portal UI. The webhook writer is done; the "Upgrade" button on `UpgradeGate` has no wired href/click. Needs `/api/billing/checkout` route + redirect + `/billing/success` handler |
| GAP-03 | Push notifications / web push. No service worker registration, no `push_subscriptions` table, no `/api/push/send` route |
| GAP-06 | Staffing — generator + scheduler tool. Staffing page reads/writes `wedding_staffing` but there's no AI shift-generator, no conflict checker, no broadcast-to-staff flow |
| GAP-07 | NLQ "need more data" guard. `/api/intel/nlq` does not refuse or soft-fail when the venue has < N weddings |
| GAP-10 (remainder) | Budget CSV export from `/couple/{slug}/budget`. Timeline CSV/PDF export from `/couple/{slug}/timeline`. Coordinator-side wedding export from `/portal/weddings/[id]`. Self-serve GDPR export for couples |
| GAP-12 (remainder) | API-layer plan_tier enforcement. `/api/intel/*` routes need a `requireTier('intelligence')` guard; `/api/intel/portfolio/*` needs `requireTier('enterprise')`. UI hides these today but a scripted fetch bypasses that |
| GAP-13 | Gmail OAuth connect UI. `gmail_connections` table + `email-poll` edge function both exist and work. What's missing is the `/settings/integrations` "Connect Gmail" button + OAuth callback at `/api/integrations/gmail/callback` |
| GAP-09 | Scope-selector race. `useVenueId` reads `bloom_venue` cookie with empty-deps `useEffect` and doesn't re-run when the scope-selector writes it on first paint. Visible in the new 08a test suite — we work around it by explicitly setting the cookie before reload. Real fix: subscribe to a `'bloom:scope-change'` custom event or use a cookie-aware SWR key |

V1 ideas IDEA-01 through IDEA-07 are not re-scored here — they are future
ideas, not gaps, and V1's classification stands.

---

## 4. Verified built — remove from V1's to-do

Stop tracking these. They are implemented and covered by tests landed in the
April 16 sweep. Remove them from the P1/P2/P3 list before the next planning
cycle.

| ID     | Where |
|--------|-------|
| GAP-01 | `src/lib/services/email.ts`. Covered indirectly by auth tests |
| GAP-11 | `src/app/w/[slug]/page.tsx` + `src/app/api/public/wedding-website/route.ts`. Covered by `e2e/sections/11b_public_rsvp.spec.ts` — 3 tests passing, 1 environmental-skip |
| GAP-14 | `src/app/(auth)/forgot-password/page.tsx`, `src/app/(auth)/reset-password/page.tsx` |
| GAP-10 (guest CSV slice) | `src/lib/utils/csv-export.ts` + `guests/page.tsx`. Covered by `e2e/sections/14a_guest_csv_export.spec.ts` — 1 test passing, 1 skipped (food-mode modal race) |
| GAP-12 (UI slice) | `src/lib/hooks/use-plan-tier.ts` + `src/components/ui/upgrade-gate.tsx` + intel layout + sidebar filter. Covered by `e2e/sections/08a_plan_gating_ui.spec.ts` — 3 tests passing, 1 skipped |

---

## 5. Fixed since V1 (April 16 sweep)

| Migration / file | Closed items |
|------------------|---------------|
| `supabase/migrations/051_schema_fixes.sql` | BUG-02, BUG-03, BUG-04, BUG-05, BUG-09 |
| `supabase/migrations/052_consolidate_budget.sql` | BUG-06 |
| `supabase/functions/email-poll/index.ts` rewrite | BUG-07 |
| `src/app/api/webhooks/stripe/route.ts` — `'starter'` default | BUG-01 |
| `src/lib/ai/client.ts` — timeout + env check | BUG-10, BUG-11 |
| `src/app/_couple-pages/staffing/page.tsx` — `useCallback` deps fix | BUG-08 |

Net: all twelve BUG-\*\* items are closed except BUG-12 (rate limiter).

---

## 6. Updated priorities — replaces V1's P1/P2/P3 table

Re-prioritized against the true state, not V1's stale list. Estimates assume
one engineer-day = one working day of focused work.

### P1 — must-ship before paid launch

| Item | Est | Why P1 |
|------|-----|--------|
| GAP-02 — Stripe Checkout + portal UI | 1.5d | Every other paid-tier feature is dark code until a user can actually pay |
| GAP-12 (API) — plan_tier guard on `/api/intel/*` and `/api/intel/portfolio/*` | 0.5d | UI gate is trivial to bypass with a scripted fetch. Revenue risk |
| GAP-13 — Gmail OAuth UI (connect button + callback) | 1d | The agent pipeline exists but a real venue can't turn it on |
| BUG-12 — persistent rate limiter for `/api/sage` | 0.5d | Blocks horizontal scale and is an easy cost-runaway vector |
| GAP-07 — NLQ need-more-data guard | 0.25d | Tiny fix, prevents nonsense answers on early-life venues |

### P2 — launch-quality, next week

| Item | Est | Why P2 |
|------|-----|--------|
| GAP-10 (budget + timeline CSV) | 0.5d | Parity with guest CSV; table-stakes for the couple portal |
| GAP-10 (coordinator portal export) | 0.5d | Parity with the couple side; expected by any B2B buyer |
| GAP-09 — scope-selector race (cookie propagation) | 0.25d | Currently papered over in tests; causes transient wrong-venue reads in prod |
| GAP-06 — staffing AI generator + scheduler | 2d | Real differentiator but not blocking revenue |

### P3 — after launch

| Item | Est | Why P3 |
|------|-----|--------|
| GAP-03 — push notifications | 2d | Nice-to-have; email + in-app covers launch scope |
| GAP-10 (GDPR self-serve export) | 1d | Legally reasonable to handle manually for first N customers |
| V1 IDEA-01..07 | N/A | Defer entirely |

Total remaining P1+P2: ≈ 7 engineer-days. V1 estimated ≈ 22 engineer-days of
open work; roughly two-thirds of that is already done.

---

## 7. New findings from the re-audit

Issues that V1 did not list at all, surfaced while re-verifying. These are
small but worth tracking.

1. **`useCoupleContext` + `useEffect` empty-deps race (couple portal).**
   `src/app/_couple-pages/guests/page.tsx:~353` fetches `wedding_config` with
   `useEffect(…, [])`. `useCoupleContext` resolves `weddingId` asynchronously.
   First paint can fire the fetch with `weddingId === null`, triggering the
   food-mode onboarding modal even when a config row exists. Observed in test
   — worked around with `test.skip`. Same pattern likely exists on budget and
   timeline pages (unverified).

2. **`usePlanTier` defaults to `'enterprise'` before the Supabase query
   resolves.** `src/lib/hooks/use-plan-tier.ts`. Safe-fail from a UX angle
   (content visible, then locks) but causes a brief "unlocked" flash on
   starter accounts on slow networks. Low priority.

3. **Sidebar section filtering is name-matched, not id-matched.**
   `buildSections()` in the sidebar component skips the section whose label
   equals `'Intelligence'`. Rename the section label and gating silently
   stops working. Should be a stable id.

4. **Duplicate slug guard not verified on `wedding_website_settings`.**
   E2E seed inserts a unique-per-test slug so conflicts don't surface. Worth
   checking that there's a DB-level UNIQUE on `slug` — not confirmed in this
   pass.

5. **`/api/public/wedding-website` POST `?action=rsvp` does not verify the
   guest's wedding matches the website slug.** In theory a guest id from a
   different wedding could be submitted. Low severity (attackers would need
   a guest UUID) but worth tightening.

None of these rise to P1. Items 1 and 3 are worth folding into the GAP-09 /
GAP-12 work when those are picked up.

---

## 8. Test coverage delta

The re-audit also replaced three stubbed Playwright specs with real tests:

| Moved file | From | To | Status |
|------------|------|----|--------|
| Public RSVP | `e2e/pending/11_public_rsvp.spec.ts` (stub, deleted) | `e2e/sections/11b_public_rsvp.spec.ts` | 3 pass, 1 env-skip |
| Guest CSV | covered by V1 stub `e2e/pending/14_data_export.spec.ts` | `e2e/sections/14a_guest_csv_export.spec.ts` + updated pending stub | 1 pass, 1 skip |
| Plan gating UI | `e2e/pending/08_plan_gating_and_nlq.spec.ts` (stub, deleted) | `e2e/sections/08a_plan_gating_ui.spec.ts` + new `e2e/pending/08_plan_gating_api.spec.ts` for API layer | 3 pass, 1 skip |

The `e2e/pending/` directory now only contains genuinely-unbuilt items:
`02_gmail_oauth`, `05_stripe_checkout`, `08_plan_gating_api`,
`09_sage_rate_limiter`, `13_push_notifications`, `14_data_export` (budget +
timeline + portal export remainder).

---

## 9. How to treat V1 going forward

`PROJECT-AUDIT.md` (V1) is kept on disk for traceability. It should not be
used as the current to-do list. Link to V2 from any planning doc that pointed
at V1. Do not delete V1; re-reading it is the fastest way to understand what
the April 7 snapshot looked like and why the corrections in §2 exist.
