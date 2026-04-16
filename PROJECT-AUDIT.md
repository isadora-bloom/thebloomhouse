# The Bloom House -- Production Readiness Audit

**Date:** 2026-04-07
**Auditor:** Claude Opus 4.6
**Codebase:** 296 TypeScript files, 50 migrations, 33 services, 42 API routes, 4 edge functions

---

## SCOPE

### File categories reviewed
- **Schema:** All 50 SQL migrations (001-050), RLS policies, constraints, indexes
- **Services:** All 33 services in `src/lib/services/`
- **API Routes:** All 42 routes in `src/app/api/`
- **Platform Pages:** Agent (12 pages), Intel (18 pages), Portal (18 pages), Settings (3 pages)
- **Couple Portal:** 38 page directories in `src/app/_couple-pages/` mirrored to `src/app/couple/[slug]/`
- **Edge Functions:** 4 Supabase edge functions (daily-digest, email-poll, heat-decay, sequence-processor)
- **Auth/Middleware:** `middleware.ts`, signup/login flows, couple registration
- **AI System:** `lib/ai/client.ts`, personality builder, prompt templates
- **Configuration:** `vercel.json` (cron), `package.json`, `tsconfig.json`

### Schema tables reviewed (by migration file)
001: organisations, venues, venue_config, venue_ai_config, user_profiles, weddings, people, contacts, knowledge_base, booked_dates |
002: interactions, drafts, engagement_events, lead_score_history, heat_score_config, draft_feedback, learned_preferences, auto_send_rules, intelligence_extractions, email_sync_state, api_costs |
003: marketing_spend, source_attribution, search_trends, trend_recommendations, ai_briefings, anomaly_alerts, consultant_metrics, review_language, weather_data, economic_indicators, natural_language_queries |
004: guest_list, timeline, budget, seating_tables, seating_assignments, sage_conversations, sage_uncertain_queue, planning_notes, contracts, checklist_items, messages, vendor_recommendations, inspo_gallery |
005: venue_usps, venue_seasonal_content, phrase_usage, voice_training_sessions, voice_training_responses, voice_preferences |
009+: tours, client_codes, wedding_website_settings, budget_items, staffing_assignments, + 25 more tables from migrations 010-050

---

## 1. BUGS & GLITCHES

### BUG-01: Stripe webhook writes `plan_tier: 'free'` which violates the CHECK constraint
**File:** `src/app/api/webhooks/stripe/route.ts` lines 154, 194
**Schema:** `supabase/migrations/001_shared_tables.sql` line 23

The venues table has `CHECK (plan_tier IN ('starter', 'intelligence', 'enterprise'))`. The Stripe webhook sets `plan_tier: 'free'` on subscription deletion (line 154) and as fallback (line 194). This will throw a Postgres constraint violation at runtime.

### BUG-02: Stripe webhook writes `stripe_subscription_id` column that does not exist in migrations
**File:** `src/app/api/webhooks/stripe/route.ts` lines 125, 155
**Schema:** No migration adds `stripe_subscription_id` to the `venues` table. It only exists in the `run-all-safe.sql` bundle files, which may or may not have been applied.

### BUG-03: Missing unique constraint for weather_data upsert
**File:** `src/lib/services/weather.ts` line 372
The code does `.upsert(records, { onConflict: 'venue_id,date,source' })` but no migration creates a `UNIQUE(venue_id, date, source)` constraint on `weather_data`. The upsert will insert duplicates instead of updating.

### BUG-04: Missing unique constraint for search_trends upsert
**File:** `src/lib/services/trends.ts` line 208
The code does `.upsert(rows, { onConflict: 'metro,term,week' })` but no migration creates a `UNIQUE(metro, term, week)` constraint on `search_trends`. Same issue as BUG-03.

### BUG-05: Missing unique constraint for economic_indicators upsert
**File:** `src/lib/services/economics.ts` line 124
The code does `.upsert(rows, { onConflict: 'indicator_name,date' })` but no unique constraint exists on those columns. Same issue.

### BUG-06: Budget table split -- platform queries `budget`, couple pages query `budget_items`
**Files:**
- `src/app/(platform)/portal/weddings/[id]/page.tsx` line 1825: `.from('budget')` with columns `estimated_cost, actual_cost, paid_amount`
- `src/app/(platform)/portal/weddings/[id]/portal/page.tsx` line 688: `.from('budget')` with `*`
- `src/app/_couple-pages/budget/page.tsx` line 202: `.from('budget_items')` with columns `budgeted, committed, paid`
- `src/lib/services/sage-brain.ts` line 118: `.from('budget_items')`

These are TWO DIFFERENT tables with different column names (004 created `budget` with `estimated_cost/actual_cost/paid_amount`; 017 created `budget_items` with `budgeted/committed/paid`). Data entered by couples in `budget_items` will never appear in the platform portal's budget view, and vice versa.

### BUG-07: Edge function `email-poll` queries wrong table for Gmail tokens
**File:** `supabase/functions/email-poll/index.ts` line 35
Queries `.from('venues').not('gmail_tokens', 'is', null)` -- but `gmail_tokens` is on `venue_config`, not `venues`. The edge function will never find any venues. The cron route at `src/app/api/cron/route.ts` line 106 correctly queries `venue_config`.

### BUG-08: Staffing `loadData` callback missing `weddingId` dependency
**File:** `src/app/_couple-pages/staffing/page.tsx` lines 250-272
The `useCallback` for `loadData` lists `[supabase]` as its dependency but uses `weddingId` inside the function body. If `weddingId` changes (e.g., from `null` to an actual ID once the couple context resolves), the callback won't re-fire.

### BUG-09: `readonly` role accepted by middleware but not defined in schema
**File:** `src/middleware.ts` line 227 -- `platformRoles` includes `'readonly'`
**File:** `src/app/(platform)/setup/page.tsx` line 48 -- `'readonly'` used in team member roles
**Schema:** `supabase/migrations/001_shared_tables.sql` line 111 -- CHECK constraint is `('super_admin', 'org_admin', 'venue_manager', 'coordinator', 'couple')`. Inserting a `readonly` profile will fail.

### BUG-10: AI client has 10-second timeout that is too short for complex calls
**File:** `src/lib/ai/client.ts` line 11
`CLAUDE_TIMEOUT_MS = 10_000` (10 seconds). For complex prompts (NLQ with data context, Sage chat with KB search + wedding context, briefing generation), 10 seconds is tight. The system will frequently fall back to OpenAI gpt-4o-mini (lower quality) or fail entirely if `OPENAI_API_KEY` is unset.

### BUG-11: `ANTHROPIC_API_KEY` used with non-null assertion, no guard
**File:** `src/lib/ai/client.ts` line 15
`new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })` -- If the env var is missing, this creates a client with `undefined` API key. It will fail on first call with an opaque error rather than a clear "missing API key" message. Compare with OpenAI on line 22-24 which has a proper guard.

### BUG-12: In-memory rate limiters reset on every serverless cold start
**Files:** `src/app/api/portal/sage/route.ts` lines 15-34, `src/app/api/intel/nlq/route.ts` lines 10-32
Vercel serverless functions are stateless. The `Map`-based rate limiters lose state on every cold start and across instances. Under load, rate limits are effectively not enforced.

---

## 2. GAPS

### GAP-01: No transactional email service -- emails are logged to console
**Files:**
- `src/app/api/portal/invite-couple/route.ts` line 60: `console.log('[INVITE EMAIL]', ...)`
- `src/lib/services/daily-digest.ts` line 9: `"For now, 'sending' logs the HTML to console"`
- No Resend, SendGrid, Postmark, or SES package in `package.json`

**Impact:** Couple invitations, daily digests, weekly briefings -- none of these actually reach anyone's inbox. The invite-couple flow appears to work (returns success) but the couple never receives the email.

### GAP-02: Stripe integration is a webhook receiver only -- no checkout, no billing UI
- `src/app/api/webhooks/stripe/route.ts` exists to receive events
- No Stripe SDK in `package.json`
- No checkout flow, subscription management page, or billing settings anywhere in the app
- `mapSubscriptionToTier()` has TODO comments with commented-out price ID mapping (line 202-209)
- No way for a venue to upgrade, downgrade, or enter payment information

### GAP-03: Push notifications are not implemented
- `src/app/(platform)/agent/notifications/page.tsx` has a settings UI with `in_app`, `email`, and `push` toggle columns
- No service worker, no Firebase/FCM, no WebPush subscription anywhere in the codebase
- The `push` toggle is purely cosmetic

### GAP-04: Edge functions are not deployed
- 4 edge functions exist in `supabase/functions/` but there is no deployment mechanism or `supabase.toml` configuration
- The `vercel.json` already defines equivalent cron jobs hitting `/api/cron` directly, making the edge functions redundant

### GAP-05: Couple portal auth flow is incomplete
- Couples register via event code at `/couple/[slug]/register`
- But the `signup/route.ts` line 66-70 actively REJECTS couple signups: "Couples register through their venue invitation link"
- The invitation email that contains the link is never actually sent (GAP-01)
- So a real couple has no way to discover or access their portal without manual URL sharing

### GAP-06: Staffing page is a calculator only, not a staffing management tool
**File:** `src/app/_couple-pages/staffing/page.tsx`
This is a Friday/Saturday staffing calculator that outputs bartender/extra hands counts. It does NOT:
- Let venues assign specific staff members to events
- Track staff availability or scheduling
- Show staff contact info or roles
- Integrate with the platform's staffing configuration (`src/app/(platform)/portal/staffing-config/page.tsx`)
The calculator stores results by cramming JSON into a `staffing_assignments` row with `role='_calculator'`.

### GAP-07: NLQ (Natural Language Query) works but depends on data that may not exist
**Files:** `src/app/api/intel/nlq/route.ts`, `src/lib/services/intel-brain.ts`
The NLQ is fully implemented with rate limiting, feedback logging, and history. However, it pulls context from 8+ tables (weddings, source_attribution, search_trends, weather_data, consultant_metrics, etc.). For a new venue with no data, answers will be empty/unhelpful. There is no "not enough data yet" guard.

### GAP-08: Weather and trends services are real but require env vars that likely aren't set
- Weather: requires `NOAA_CDO_TOKEN` (historical) -- gracefully degrades
- Weather: uses Open-Meteo (forecast) -- free, no key needed, works
- Trends: requires `SERPAPI_KEY` -- gracefully degrades but returns nothing
- Economics: requires `FRED_API_KEY` -- gracefully degrades
All services have proper guards and warn in logs. But without these keys, the Market Pulse and Trends pages show empty state.

### GAP-09: No mobile-specific testing or responsive breakpoints in many pages
- The couple portal pages use Tailwind responsive classes (`sm:`, `md:`, etc.) inconsistently
- Several large data tables and multi-step wizards (staffing calculator, seating chart, timeline builder) likely break on mobile
- No Playwright mobile viewport tests exist in `e2e/`
- No PWA manifest or mobile app shell

### GAP-10: No data export functionality
- No CSV/PDF export for guest lists, budgets, timelines, or vendor lists
- No "print view" beyond `src/app/(platform)/portal/weddings/[id]/print/`
- Couples entering significant data have no way to take it with them

### GAP-11: Wedding website (`/w/[slug]`) has no RSVP collection
- The wedding website builder exists and renders pages
- But RSVP responses from guests have no public-facing form
- The `rsvp_config` and `rsvp_responses` tables exist but there's no guest-facing RSVP submission page

### GAP-12: Demo user sees everything a real user can -- there is no feature gating
- Demo mode is a cookie-based bypass that shows the full platform
- No plan tier enforcement exists anywhere -- `plan_tier` is stored but never checked
- A "starter" venue sees the same features as "enterprise"
- Intelligence features, NLQ, Sage -- all available regardless of plan

### GAP-13: Onboarding creates an org but setup wizard has no Gmail OAuth flow
- `src/app/(platform)/onboarding/page.tsx` has a "Connect Gmail" step
- But connecting Gmail requires OAuth2 redirect flow (Google consent screen)
- The onboarding page references this but there's no `/api/auth/gmail/callback` or OAuth redirect handler
- Gmail connection requires manually setting tokens in `venue_config.gmail_tokens`

### GAP-14: No password reset flow
- Login and signup exist
- No "forgot password" link or password reset page
- Users who forget their password have no recovery path

---

## 3. IDEAS

### IDEA-01: First 5 minutes -- instant value without data
The biggest first-impression problem: a new venue signs up, goes through setup, and lands on a dashboard with zero data. Every chart is empty, every insight says "no data."

**Fix:** Pre-populate "getting started" insights (e.g., "Connect Gmail to start seeing leads", "Add your first 5 FAQs to train Sage"). Show a sample briefing with real anonymized industry data. Let them try Sage immediately with their KB entries.

### IDEA-02: "I can't go back" feature -- the intelligence flywheel
The feature that creates lock-in: **the Learned Preferences + Voice Training accumulating over time**. After 3 months, the system has learned that this venue never uses exclamation points, prefers "y'all" over "you all," and always mentions the barn before the garden. No competitor has this data.

Surface it: show a "Voice DNA" page that visualizes what Bloom has learned. "Bloom has processed 847 emails and learned 23 writing preferences. Your voice score is 94% consistent." Make it feel like losing institutional knowledge to leave.

### IDEA-03: Data no competitor has
- **Response time vs. booking correlation**: "Venues that respond within 2 hours book 3.2x more than those responding in 24 hours. You responded in 4.1 hours last week."
- **Seasonal booking curves by metro**: "Engagement ring searches in Richmond are up 31% -- expect an inquiry surge in 3-6 months."
- **Lost deal pattern analysis**: "67% of your lost deals mentioned 'budget' -- consider a mid-range package."

Some of this exists in the intelligence engine. The gap is surfacing it at the right moment (in the daily digest, on the dashboard, before a tour).

### IDEA-04: HoneyBook migration friction
The biggest friction: data migration. HoneyBook has contracts, invoices, contact lists, timelines.

**Fix:** Build a CSV/Excel importer (partially exists in `data-import.ts`) and a "Switch from HoneyBook" landing page with a step-by-step guide. Parse HoneyBook export formats. Let them see their data in Bloom before they cancel HoneyBook.

### IDEA-05: Premium couple portal experience
The couple portal is extensive (38 pages) but feels utilitarian. To feel premium:
- Animated transitions between sections
- Personalized greeting with the couple's names and a countdown ("Sarah & James -- 47 days to go!")
- A "Your Week" section on the dashboard showing what's due, what Sage recommends
- Professional-grade PDF timeline/budget that couples can share with their wedding party
- "Share with wedding party" feature for guest-facing pages

### IDEA-06: Investor demo gaps
For a convincing demo, you need:
1. A clear "before/after" -- show an inquiry email arriving, Bloom drafting a response, coordinator approving, email going out. The flow works but the email never actually sends.
2. Intelligence surfacing a non-obvious insight -- "You lost 4 deals to Venue X this month. Their price point is $2K lower. Consider a 'value add' package."
3. Sage answering a couple's question using venue-specific knowledge -- "Your ceremony site fits 180 chairs in a garden layout. If weather is bad, we have a tent plan."
4. The reactive loop: a trend deviation triggers a recommendation that changes the agent's behavior. This exists in code but the connection between detection and action is not visible in the UI.

### IDEA-07: Weekly digest as indispensable tool
Current digest structure is solid (6 sections, AI-generated). To make it indispensable:
- Add "This week vs. same week last year" comparison
- Add "What your competitors are doing" (review volume, new photos, pricing changes)
- Add "Sage handled X questions this week, saving you Y hours"
- Add one-click action buttons: "Respond to stale lead" directly from the digest
- Let coordinators reply to the digest email with instructions ("follow up with the Chen wedding")

---

## 4. PRIORITISED TO-DO LIST

### P1 -- BLOCKING / CRITICAL (must fix before any real venue uses the product)

| # | Item | Type | Effort |
|---|------|------|--------|
| 1 | **Fix Stripe plan_tier 'free' constraint violation** (BUG-01) -- either add 'free' to the CHECK or use 'starter' as fallback | Bug | 30 min |
| 2 | **Add `stripe_subscription_id` column to venues** (BUG-02) -- add migration 051 | Bug | 15 min |
| 3 | **Add unique constraints for weather, trends, economics upserts** (BUG-03/04/05) -- add migration with `CREATE UNIQUE INDEX` | Bug | 30 min |
| 4 | **Consolidate budget tables** (BUG-06) -- portal pages should query `budget_items`, not `budget`. Drop or alias the old `budget` table | Bug | 2 hrs |
| 5 | **Fix edge function email-poll querying wrong table** (BUG-07) -- query `venue_config` not `venues` | Bug | 15 min |
| 6 | **Add `readonly` to user_profiles role CHECK constraint** (BUG-09) -- add to migration | Bug | 15 min |
| 7 | **Wire a real email service** (GAP-01) -- Resend is $0 for first 100 emails/day, 30-min integration. Without this, couple invitations and digests are dead | Gap | 3 hrs |
| 8 | **Build password reset flow** (GAP-14) -- Supabase has built-in `resetPasswordForEmail()`. Need a /reset-password page | Gap | 2 hrs |
| 9 | **Fix couple portal auth flow** (GAP-05) -- the invitation email must actually send, or provide an alternative path for coordinators to share the registration link | Gap | 1 hr |
| 10 | **Add ANTHROPIC_API_KEY guard** (BUG-11) -- throw a clear error if env var is missing instead of silently failing | Bug | 15 min |
| 11 | **Increase Claude timeout to 30s** (BUG-10) -- 10s causes unnecessary fallback to gpt-4o-mini, degrading quality | Bug | 5 min |

### P2 -- IMPORTANT (should fix before showing to investors)

| # | Item | Type | Effort |
|---|------|------|--------|
| 12 | **Build Stripe checkout flow** (GAP-02) -- pricing page, Stripe Checkout redirect, subscription management. Without this, no revenue | Gap | 2 days |
| 13 | **Add plan tier enforcement** (GAP-12) -- check `plan_tier` in middleware or at feature level. Gate intelligence, NLQ, and advanced Sage features behind higher tiers | Gap | 1 day |
| 14 | **Fix staffing loadData dependency** (BUG-08) -- add `weddingId` to useCallback deps | Bug | 5 min |
| 15 | **Build Gmail OAuth redirect flow** (GAP-13) -- `/api/auth/gmail/callback` handler, store tokens in `gmail_connections` | Gap | 1 day |
| 16 | **Add "empty state" intelligence** (IDEA-01) -- pre-populate getting-started insights, show sample data for new venues | Idea | 1 day |
| 17 | **Remove or deploy edge functions** (GAP-04) -- vercel.json crons already handle all jobs. Delete supabase/functions/ to avoid confusion, or deploy them and remove the vercel.json crons | Gap | 1 hr |
| 18 | **NLQ empty data guard** (GAP-07) -- if venue has <10 weddings, show "Need more data" instead of asking AI to reason over nothing | Gap | 2 hrs |
| 19 | **Rate limiters need persistent storage** (BUG-12) -- use Vercel KV or Supabase for rate limiting, not in-memory Maps | Bug | 3 hrs |
| 20 | **Responsive audit for couple portal** (GAP-09) -- test and fix all 38 couple pages at 375px width. Staffing calculator, seating chart, and timeline builder are likely broken | Gap | 2 days |

### P3 -- NICE TO HAVE (can wait but should be planned)

| # | Item | Type | Effort |
|---|------|------|--------|
| 21 | **Data export** (GAP-10) -- CSV export for guest lists, budgets, timelines | Gap | 1 day |
| 22 | **Guest RSVP submission page** (GAP-11) -- public form at `/w/[slug]/rsvp` | Gap | 1 day |
| 23 | **Push notifications** (GAP-03) -- Web Push for urgent alerts (new inquiry, draft approved) | Gap | 2 days |
| 24 | **Voice DNA visualization** (IDEA-02) -- page showing what Bloom has learned about the venue's voice | Idea | 1 day |
| 25 | **HoneyBook migration wizard** (IDEA-04) -- CSV import with mapping UI | Idea | 3 days |
| 26 | **Couple portal animations and countdown** (IDEA-05) -- polish the first-impression experience | Idea | 2 days |
| 27 | **Weekly digest enhancements** (IDEA-07) -- year-over-year comparison, one-click actions | Idea | 2 days |
| 28 | **Intelligence loop visibility** (IDEA-06 #4) -- show how a trend triggers a recommendation that changes agent behavior | Idea | 2 days |
| 29 | **Mobile PWA shell** (GAP-09 extension) -- manifest.json, offline fallback, install prompt | Gap | 1 day |
| 30 | **Staffing management tool** (GAP-06) -- replace calculator-only with real staff scheduling | Gap | 3 days |

---

## SUMMARY

**TypeScript build:** Clean (zero errors)
**Architecture:** Sound -- three-product split with shared auth, AI, and schema is well-designed
**Schema:** Comprehensive (50 migrations, 80+ tables) but has 5 constraint/upsert bugs that will cause runtime failures
**AI System:** Robust with cost tracking, fallback, and rate limiting. The 10s Claude timeout is too aggressive.
**Critical blockers:** The top 3 are (1) no email delivery = dead couple invitation flow, (2) Stripe constraint violations = crash on subscription events, (3) budget table split = data appears to vanish for coordinators.

The codebase is impressively thorough for a pre-launch product. The intelligence engine, voice training system, and couple portal are genuine differentiators. The main gaps are in the "last mile" of production readiness: billing, email delivery, auth flows, and data consistency.
