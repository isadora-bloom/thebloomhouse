# Onboarding Chain Audit — Full End-to-End Trace

**Date:** 2026-04-07
**Auditor:** Claude Code
**Scope:** Every user journey from signup to fully operational

---

## Journey 1: New Venue Owner Signs Up

### Step 1.1 — Signup Form (`src/app/(auth)/signup/page.tsx`)
- **Status:** WORKS
- Collects: first name, last name, email, password, confirm password, role (coordinator/couple)
- Calls `POST /api/auth/signup` with `{email, password, role, fullName}`
- On success, immediately signs in with `supabase.auth.signInWithPassword()`
- Clears demo cookies (`bloom_demo`, `bloom_scope`)
- If `data.needsSetup === true` → redirects to `/setup`; otherwise to `/`

### Step 1.2 — Signup API (`src/app/api/auth/signup/route.ts`)
- **Status:** WORKS
- Creates auth user via `supabase.auth.admin.createUser()` with `email_confirm: true`
- For `coordinator` / `venue_manager` role:
  - Creates `organisations` row (`name = "<fullName>'s Company"`, `owner_id`, `is_demo: false`)
  - Creates `user_profiles` row (`id = user.id`, `venue_id: null`, `org_id`, `role: 'org_admin'`)
  - Returns `{ success: true, orgId, needsSetup: true }`
- For `couple` role: only creates auth user, no org, no profile. Returns `{ success: true }` with `needsSetup` **undefined** (falsy).
- **Issue (MINOR):** Couple signup creates auth user but NO `user_profiles` row. The comment says "Couple flow creates profile via event code registration" — this is correct *if* couples always come through the event code flow. But the signup page allows couples to sign up directly. After direct signup, the couple has no profile and will land on `/` (dashboard), where `useScope` will find no profile, no venue, and the page will be blank or misbehave.
  - **BUG (line 67):** Direct couple signup creates an orphan auth user with no profile, no wedding link, no way forward. They'll see the dashboard but with no scope resolved — they get stuck.

### Step 1.3 — Post-Signup Redirect
- **Status:** WORKS (for coordinators)
- Coordinator: `needsSetup: true` → `router.push('/setup')` ✓
- Couple: `needsSetup` is undefined → `router.push('/')` → lands on dashboard with no context → **BROKEN for direct couple signup**

### Step 1.4 — Dashboard Redirect Logic (`src/app/(platform)/page.tsx`)
- **Status:** WORKS (for coordinators)
- Lines 47-68: If `scope.venueId` is falsy:
  - Verifies via DB that user truly has no venue
  - If `profile.venue_id` is null → `router.push('/setup')` ✓
- Lines 70-81: If user has venue but `venue_config.onboarding_completed === false`:
  - → `router.push('/onboarding')` ✓
- **No circular redirect risk:** Dashboard → `/setup` only when no venue; `/setup` → `/onboarding` only after venue is created; `/onboarding` → `/` only on "Go Live".

### Step 1.5 — Setup Wizard (`src/app/(platform)/setup/page.tsx`)
- **Status:** WORKS
- **Auth guard (lines 99-106):** Loads user, if no user → `/login`
- **Already-done guard (lines 126-129):** If `profile.venue_id` exists → `/onboarding` (skip setup)
- **Step 1 — Company (lines 150-176):** Updates `organisations.name` where `id = orgId` ✓
  - Org DOES exist from signup ✓
  - Also captures single vs. multi venue intent (informational only)
- **Step 2 — Venue (lines 181-274):**
  - Creates `venues` row (name, slug, org_id, city, state, status='trial', is_demo=false) ✓
  - Creates `venue_config` row (venue_id, business_name, timezone, capacity, base_price, onboarding_completed=false) ✓
  - Updates `user_profiles.venue_id` for current user ✓
  - Sets `bloom_scope` cookie with venueId, orgId, venueName, companyName ✓
  - Sets `bloom_venue` cookie ✓
- **Step 3 — Team Invites (lines 296-336):**
  - For each team member, calls `POST /api/team/invite` with email, role, venueId, orgId
  - After invites or skip → `router.push('/onboarding')` ✓

### Step 1.6 — Setup → Onboarding Transition
- **Status:** WORKS
- Setup always navigates to `/onboarding` after step 3 (or skip)
- The scope cookie was set in step 2 with the venueId
- No circular redirect: setup checks `profile.venue_id` on mount; if already has one, skips to onboarding

### Step 1.7 — Onboarding Wizard (`src/app/(platform)/onboarding/page.tsx`)
- **Status:** WORKS (with one issue)
- `useScope()` resolves venueId from the cookie set during setup ✓
- Shows spinner until `scopeReady` (line 719-728) ✓
- Loads existing venue data, AI config, KB entries, Gmail status on mount ✓
- **6 steps:** Basics → Gmail → Voice → Knowledge Base → Test Draft → Go Live
- **Step 0 (Basics):** Saves to `venues` and `venue_config` (upsert) ✓
- **Step 1 (Gmail):** OAuth flow via `/api/agent/gmail`, handled entirely client-side ✓
- **Step 2 (Voice):** Saves to `venue_ai_config` (upsert) ✓
- **Step 3 (Knowledge):** Saves to `knowledge_base` (delete-and-reinsert) ✓
- **Step 4 (Test Draft):** Calls `/api/onboarding/test-draft`, no save needed ✓
- **Step 5 (Go Live, lines 524-538):**
  - Sets `venues.status = 'active'` ✓
  - Sets `venue_config.onboarding_completed = true` ✓
  - After success, `window.location.href = '/'` ✓ (full page reload, clears any stale state)
- **Issue (MINOR, line 417-418):** If `VENUE_ID` is null when `saveStep` runs, it shows an error "No venue selected" but doesn't redirect the user anywhere. The user would need to manually navigate or refresh. The `scopeReady` guard (line 719) should prevent this in practice.

### Step 1.8 — Post-Onboarding Dashboard Landing
- **Status:** WORKS
- After Go Live: `onboarding_completed = true`, status = 'active'
- Dashboard checks `venue_config.onboarding_completed` — finds `true` — no redirect ✓
- Dashboard loads stats with the resolved scope ✓

### Journey 1 Summary
| Step | Status | Notes |
|------|--------|-------|
| Signup form | WORKS | |
| Signup API | WORKS (coordinator) / **BUG (couple)** | Direct couple signup creates orphan auth user |
| Post-signup redirect | WORKS | |
| Dashboard redirect | WORKS | |
| Setup Step 1 (Company) | WORKS | |
| Setup Step 2 (Venue) | WORKS | Creates venue + config + updates profile + sets cookies |
| Setup Step 3 (Team) | WORKS | |
| Setup → Onboarding | WORKS | |
| Onboarding (all 6 steps) | WORKS | |
| Go Live → Dashboard | WORKS | |

---

## Journey 2: Invited Team Member Joins

### Step 2.1 — Invite Sent (`src/app/api/team/invite/route.ts`)
- **Status:** WORKS (no email actually sent)
- Validates: email, role, orgId required
- Checks for duplicate pending invite ✓
- Checks if user already in org ✓
- Creates `team_invitations` row (org_id, venue_id, email, role, token, status='pending', expires_at=7 days) ✓
- Generates invite link: `{baseUrl}/join?token={uuid}` ✓
- **GAP (line 111):** Only logs the invite link to console. No email is actually sent. Comment says "email sending is a future enhancement". The coordinator would need to manually copy/share the link.
- **Issue (line 44):** `supabase.auth.admin.listUsers()` to check for existing users fetches ALL users. This is O(n) and will be slow/break at scale. Not a blocker now.

### Step 2.2 — Join Page (`src/app/join/page.tsx`)
- **Status:** WORKS
- Reads `token` from URL search params ✓
- Validates token via `GET /api/team/accept?token=xxx` ✓
- Shows invitation details (org name, venue name, role) ✓
- Two paths:
  - **Existing user (logged in):** Shows "Accept" button ✓
  - **New user:** Shows registration form (first name, last name, password) ✓

### Step 2.3 — Accept API (`src/app/api/team/accept/route.ts`)
- **Status:** WORKS
- GET handler validates token (checks pending, not expired) ✓
- POST handler:
  - Validates invitation ✓
  - If existing auth user → gets their ID; if new → creates auth user with `email_confirm: true` ✓
  - If profile exists in org → updates role + venue_id ✓
  - If no profile → creates `user_profiles` (id, org_id, venue_id, role, first_name, last_name) ✓
  - Marks invitation as `accepted` ✓
  - Returns `{ success: true, venueId, orgId, role }` ✓
- **Issue (line 157):** When updating existing profile, uses `venue_id: invitation.venue_id || undefined`. The `undefined` means the field is NOT included in the update payload (Supabase ignores undefined), so if the invitation has no venue_id, the existing venue_id is preserved. This is fine.

### Step 2.4 — Post-Accept Flow
- **Status:** WORKS
- Join page sets `bloom_scope` cookie with venue/org info ✓
- New user: signs in with `supabase.auth.signInWithPassword()` ✓
- Clears `bloom_demo` cookie ✓
- Redirects to `/` after 2 seconds ✓
- Dashboard loads with scope resolved from cookie ✓

### Step 2.5 — Does Team Member Need Onboarding?
- **Status:** WORKS — they skip it
- Dashboard checks `venue_config.onboarding_completed` for their venue
- If the venue was already onboarded → no redirect to `/onboarding` ✓
- If the venue hasn't been onboarded (edge case: invited before onboarding is done) → they'll see the onboarding wizard. This is acceptable behavior.

### Step 2.6 — Scope Cookie
- **Status:** WORKS
- Set in `acceptAsExistingUser()` (line 119-127) and `acceptAsNewUser()` (line 193-201)
- Both set `bloom_scope` with level, venueId, orgId, venueName, companyName ✓

### Journey 2 Issues
| Issue | Severity | Location |
|-------|----------|----------|
| **No actual email sent** — invite link only logged | GAP | `api/team/invite/route.ts:111` |
| `listUsers()` fetches ALL auth users | LOW | `api/team/invite/route.ts:44`, `api/team/accept/route.ts:102` |
| `readonly` role excluded from middleware `platformRoles` | **BUG** | `middleware.ts:227` |

**CRITICAL BUG: `readonly` role blocked by middleware.**
- `platformRoles = ['super_admin', 'org_admin', 'venue_manager', 'coordinator']` (line 227)
- The `readonly` role is NOT in this list.
- A team member invited with `readonly` role will be created successfully, but when they try to access ANY platform route (`/agent/*`, `/intel/*`, `/portal/*`, `/settings/*`, `/onboarding`, `/setup`), the middleware will redirect them to `/login`.
- They can sign in, but then get redirected back to `/login` in a loop. **BROKEN.**

---

## Journey 3: Couple Gets Invited

### Step 3.1 — New Booking Modal (`src/app/(platform)/portal/weddings/page.tsx`)
- **Status:** WORKS
- Coordinator fills out: partner names, emails, phones, date, guest count, source, value, notes
- Checkbox `sendInvite` defaults to `true`
- Creates:
  1. `weddings` row (venue_id, status='booked', event_code=auto-generated, etc.) ✓
  2. `people` rows (partner1 + optional partner2, linked to wedding_id) ✓
  3. If `sendInvite` checked: calls `POST /api/portal/invite-couple` ✓

### Step 3.2 — Invite Couple API (`src/app/api/portal/invite-couple/route.ts`)
- **Status:** WORKS (no actual email sent)
- Looks up venue by ID ✓
- Builds registration URL: `{baseUrl}/couple/{venue.slug}/register?code={eventCode}` ✓
- Generates HTML email content with portal features ✓
- **GAP (line 60):** Only `console.log`s the email. No email service wired. Comment: "TODO: Wire real email service (Resend/SendGrid)"
- Updates `wedding.couple_invited_at` ✓

### Step 3.3 — Couple Registration Page (`src/app/couple/[slug]/register/page.tsx`)

**CRITICAL BUG: Registration page is blocked by middleware.**

- The middleware (line 169-207) enforces auth on ALL `/couple/*` routes.
- Only `/couple/login` and `/couple/[slug]/login` are exempted (lines 171-173).
- `/couple/[slug]/register` is NOT exempted.
- An unauthenticated couple visiting the registration link will be **redirected to `/couple/login`**, which makes no sense since they don't have an account yet.
- **This completely breaks the couple registration flow.**

If middleware were not blocking:
- Loads venue branding from `venues` + `venue_config` ✓
- Pre-fills event code from `?code=XXX` URL param ✓
- Submits to `POST /api/couple/register` ✓
- On success, signs in and redirects to `/couple/{slug}` ✓

### Step 3.4 — Couple Register API (`src/app/api/couple/register/route.ts`)
- **Status:** WORKS (if reachable)
- Validates event code against `weddings.event_code` ✓
- Verifies venue slug matches the wedding's venue ✓
- Checks `couple_registered_at` to prevent double-registration ✓
- Creates auth user with `email_confirm: true` ✓
- Creates `user_profiles` row: `{id, venue_id: wedding.venue_id, role: 'couple'}` ✓
- **Issue (line 84-88):** `user_profiles` insert does NOT include `org_id`. The couple profile will have `org_id = NULL`. This is probably fine for couples (they only need venue_id for their portal), but it's inconsistent.
- Updates `wedding.couple_registered_at` ✓
- Links auth user to `people` record by email (or updates partner1 email) ✓

### Step 3.5 — Post-Registration Couple Portal
- **Status:** WORKS (if registration succeeds)
- Redirects to `/couple/{slug}` ✓
- `useCoupleContext` resolves:
  1. Venue from slug → `venues.id` ✓
  2. Wedding from `people.email` matching auth user's email, with `role in ('partner1', 'partner2')` ✓
- This correctly finds the wedding because the register API either matched an existing `people.email` or updated partner1's email ✓

### Journey 3 Issues
| Issue | Severity | Location |
|-------|----------|----------|
| **Registration page blocked by middleware** | **CRITICAL BUG** | `middleware.ts:169-180` |
| No actual email sent to couple | GAP | `api/portal/invite-couple/route.ts:60` |
| Couple `user_profiles.org_id` is NULL | LOW | `api/couple/register/route.ts:84-88` |

---

## Journey 4: Adding a Second Venue (Multi-Venue Expansion)

### Assessment
- **Status:** GAP — No UI to add a second venue exists.
- The setup wizard creates exactly one venue and then redirects to onboarding.
- The settings page (`/settings`) has no "Add Venue" button or flow.
- The scope selector (`src/components/shell/scope-selector.tsx`) shows existing venues but has no "Add" action.
- The super-admin page may have some venue management, but it's not a user-facing flow.

### What would be needed:
1. A way to create a new venue under the same org (likely in Settings or from the scope selector)
2. The new venue would need its own `venue_config` (with `onboarding_completed: false`)
3. Switching scope to the new venue should trigger onboarding for that venue
4. The scope selector already handles multiple venues, so it would appear there once created

### Journey 4 Summary
| Issue | Severity | Location |
|-------|----------|----------|
| **No UI to add second venue** | **GAP** | No file — feature doesn't exist |
| No per-venue onboarding trigger for additional venues | GAP | `src/app/(platform)/page.tsx` only checks current scope |

---

## Journey 5: Stat Tracking for Team Members

### Step 5.1 — Consultant Tracking Service (`src/lib/services/consultant-tracking.ts`)
- **Status:** WORKS (service layer is solid)
- Tracks 5 actions: `inquiry_handled`, `tour_booked`, `booking_closed`, `draft_approved`, `draft_rejected`
- `draft_approved` and `draft_rejected` both map to `inquiries_handled` column (reasonable: handling = processing)
- Uses `consultant_metrics` table with monthly periods
- Upserts by (venue_id, consultant_id, period_start, period_end)
- Recalculates `conversion_rate` on each increment ✓
- `trackResponseTime()` maintains running average ✓

### Step 5.2 — Where Tracking Is Wired (`src/lib/services/email-pipeline.ts`)
- **Draft approved** (line 746): `trackCoordinatorAction(venueId, userId, 'draft_approved')` ✓
- **Draft rejected** (line 813): `trackCoordinatorAction(venueId, userId, 'draft_rejected')` ✓
- **Draft edited & approved** (line 869): `trackCoordinatorAction(venueId, userId, 'draft_approved')` ✓
- **Response time** tracked on approve (lines 748-758) and edit-approve (lines 871-882) ✓

### Step 5.3 — What IS and ISN'T tracked
| Action | Tracked? | Where |
|--------|----------|-------|
| Draft approved | YES | `email-pipeline.ts:746` |
| Draft rejected | YES | `email-pipeline.ts:813` |
| Draft edited & approved | YES | `email-pipeline.ts:869` |
| Response time | YES | `email-pipeline.ts:748-758, 871-882` |
| Tour booked | **PARTIALLY** | Calendly webhook (`api/webhooks/calendly/route.ts`) creates `engagement_events` but does NOT call `trackCoordinatorAction('tour_booked')` |
| Booking closed | **NOT TRACKED** | No code anywhere calls `trackCoordinatorAction('booking_closed')` |
| Avg booking value | **NOT TRACKED** | No code updates `avg_booking_value` in `consultant_metrics` |

### Step 5.4 — `/intel/team` Page (`src/app/(platform)/intel/team/page.tsx`)
- **Status:** WORKS (shows real data from `consultant_metrics`)
- Fetches `consultant_metrics` filtered by scope + period
- Fetches `user_profiles` for names
- Shows per-consultant cards with: inquiries, tours booked, bookings closed, conversion rate, avg response time, avg booking value
- Shows comparison bar chart
- **Issue:** Tours booked, bookings closed, and avg booking value will always show 0 because the tracking functions for these actions are never called (see above). The UI renders these fields but they're always empty.
- Gated by `UpgradeGate` component (plan gating)

### Step 5.5 — `/settings/team` Page (`src/app/(platform)/settings/team/page.tsx`)
- **Status:** WORKS (but shows different data)
- Shows team MEMBERS (from `user_profiles`) and pending INVITATIONS
- Does NOT show consultant metrics — it's a team management page, not a performance page
- Allows: inviting new members, changing roles, changing venue assignments, removing members
- Different purpose from `/intel/team` (management vs. performance)

### Journey 5 Summary
| Issue | Severity | Location |
|-------|----------|----------|
| `tour_booked` not tracked to consultant_metrics | **GAP** | Calendly webhook doesn't call tracking |
| `booking_closed` never tracked | **GAP** | No wiring anywhere |
| `avg_booking_value` never updated | **GAP** | No wiring anywhere |
| `/intel/team` shows 0 for tours, bookings, avg value | **COSMETIC BUG** | `intel/team/page.tsx` — renders zeros |

---

## Circular Redirect Analysis

### Potential Loops Checked

1. **Dashboard ↔ Setup:**
   - Dashboard → `/setup` when `profile.venue_id` is null
   - Setup → `/onboarding` when `profile.venue_id` exists (line 127)
   - Setup does NOT redirect to dashboard. No loop. ✓

2. **Dashboard ↔ Onboarding:**
   - Dashboard → `/onboarding` when `venue_config.onboarding_completed === false`
   - Onboarding → `/` when Go Live completes (sets `onboarding_completed = true`)
   - No loop: onboarding doesn't redirect back to dashboard unless Go Live runs. ✓

3. **Setup ↔ Onboarding:**
   - Setup → `/onboarding` on complete
   - Onboarding shows a spinner if no `scope.venueId`, but does NOT redirect to `/setup`
   - No loop. ✓

4. **Login → Dashboard → Login:**
   - Dashboard at `/` requires auth (middleware line 241-248). Unauthenticated → `/welcome`
   - Platform routes require auth + platform role (middleware line 212-233). Unauthenticated → `/login`
   - Login redirects to `/` on success
   - Possible loop for `readonly` users: login → `/` → middleware blocks platform routes → `/login`. **YES, this is a loop for readonly role users attempting to access platform routes.** For the dashboard `/`, they pass middleware (it only checks auth at `/`), but the dashboard useScope + redirect might push them to `/setup` if they have no venue.

5. **Demo bypass:**
   - Middleware line 74-77: If `bloom_demo=true` cookie → skip ALL auth checks. ✓
   - Demo page sets the cookie correctly. ✓
   - No loop risk for demo users. ✓

### Verdict
- **No circular redirect loops for normal coordinator flow.** ✓
- **`readonly` users get stuck** — middleware blocks them from platform routes (line 227-233), redirecting to `/login`, where they can sign in again and end up back at `/login`. This is a BUG.

---

## Demo Mode Verification

### `/demo` Page (`src/app/demo/page.tsx`)
- **Status:** WORKS
- Two buttons: "Platform" → `launchDemo('/')` and "Couple Portal" → `launchDemo('/couple/hawthorne-manor/')`
- `launchDemo()` sets three cookies:
  - `bloom_demo=true` (1 day) ✓
  - `bloom_venue=22222222-2222-2222-2222-222222222201` (1 day) ✓
  - `bloom_scope` with Hawthorne Manor / Crestwood Collection (1 day) ✓
- Then `router.push(destination)` ✓

### Middleware Demo Handling
- **Demo rewrite (lines 39-68):** `/demo/*` paths get rewritten to real paths with demo cookies injected into both request and response. This enables crawlable demo pages. ✓
- **Demo bypass (lines 74-77):** If `bloom_demo=true` cookie exists, skip ALL auth checks. ✓

### `useScope` Demo Handling
- Line 69: If `isDemoMode()` → returns `DEMO_SCOPE` (Hawthorne Manor, Crestwood Collection) ✓
- No async resolution needed — immediate return ✓

### Demo User Clicking "Platform"
1. Cookie `bloom_demo=true` set ✓
2. Navigate to `/` ✓
3. Middleware sees demo cookie → passes through ✓
4. Dashboard `useScope()` returns DEMO_SCOPE immediately ✓
5. Dashboard redirect logic: `scope.venueId` is set (demo venue) → does NOT redirect to `/setup` ✓
6. Dashboard checks `venue_config.onboarding_completed` for demo venue → demo seed data should have this `true` ✓
7. Dashboard loads with demo data ✓

### Verdict
- **Demo mode works correctly.** All bypass logic is solid.

---

## Overall Summary

### Critical Issues (Must Fix)

| # | Issue | Journey | File | Line |
|---|-------|---------|------|------|
| 1 | **Couple registration page blocked by middleware** — unauthenticated couples visiting `/couple/{slug}/register` are redirected to `/couple/login` | J3 | `src/middleware.ts` | 169-180 |
| 2 | **`readonly` role blocked by middleware** — team members with readonly role can't access any platform page, stuck in login loop | J2 | `src/middleware.ts` | 227 |

### Important Issues (Should Fix)

| # | Issue | Journey | File | Line |
|---|-------|---------|------|------|
| 3 | **Direct couple signup creates orphan user** — no profile, no wedding link, no way forward | J1 | `src/app/api/auth/signup/route.ts` | 67 |
| 4 | **No UI to add second venue** — multi-venue expansion is impossible after initial setup | J4 | N/A | N/A |
| 5 | **`booking_closed` and `tour_booked` never tracked to consultant_metrics** — /intel/team shows zeros | J5 | `src/lib/services/consultant-tracking.ts` | N/A |

### Minor/Low Issues

| # | Issue | Journey | File | Line |
|---|-------|---------|------|------|
| 6 | No actual invite email sent (team invites) | J2 | `src/app/api/team/invite/route.ts` | 111 |
| 7 | No actual invite email sent (couple invites) | J3 | `src/app/api/portal/invite-couple/route.ts` | 60 |
| 8 | Couple profile missing `org_id` | J3 | `src/app/api/couple/register/route.ts` | 84-88 |
| 9 | `listUsers()` fetches all auth users (O(n) perf issue) | J2 | `api/team/invite/route.ts:44`, `api/team/accept/route.ts:102` |
| 10 | Auth callback redirects to `/agent/inbox` instead of `/` | J1 | `src/app/api/auth/callback/route.ts` | 13 |
| 11 | `avg_booking_value` never populated in consultant_metrics | J5 | N/A | N/A |

### Gaps (Features Not Built)

| # | Gap | Journey |
|---|-----|---------|
| G1 | No email service wired (team invites, couple invites) | J2, J3 |
| G2 | No "Add Second Venue" UI or flow | J4 |
| G3 | No per-venue onboarding for additional venues | J4 |
| G4 | Tour tracking not wired from Calendly webhook to consultant_metrics | J5 |
| G5 | Booking closure not tracked anywhere | J5 |

### What Works Well

- **Coordinator signup → setup → onboarding → dashboard** is a clean, complete flow ✓
- **Team invite → join → accept** flow is well-built (aside from readonly role bug and no email) ✓
- **Scope/cookie system** is consistent and well-designed ✓
- **Demo mode** is bulletproof — cookies, middleware bypass, and useScope all aligned ✓
- **No circular redirects** in the happy path ✓
- **Onboarding saves progress incrementally** — users can leave and come back ✓
- **Draft approval/rejection tracking** is properly wired with learning feedback loop ✓

---

## Recommended Fix Priority

1. **IMMEDIATE:** Add `/couple/[slug]/register` to middleware public route exceptions (1-line fix)
2. **IMMEDIATE:** Add `readonly` to `platformRoles` in middleware (1-line fix)
3. **HIGH:** Either hide "Couple" option from signup form OR create a proper couple-direct-signup flow
4. **MEDIUM:** Build "Add Venue" UI in Settings
5. **MEDIUM:** Wire `trackCoordinatorAction('tour_booked')` in Calendly webhook
6. **MEDIUM:** Wire `trackCoordinatorAction('booking_closed')` when wedding status changes to booked
7. **LOW:** Integrate an email service (Resend/SendGrid) for team and couple invites
