# Bloom House — Complete Page Audit

**Date:** 2026-04-23
**Scope:** Every `page.tsx` in `src/app/`. Deep, slow, critical. External data
sources only (browser/web APIs, URL params, cookies, user actions) — not
Supabase reads.

**Conventions used:**
- **Purpose** — the one-line intent
- **External inputs** — what enters from outside Supabase (URL, cookies, file
  uploads, browser APIs, fetch to external services, user form input)
- **Surface** — where this data is displayed and why
- **User actions** — what a human can DO on this page
- **Value** — the concrete benefit over "coordinator does this manually"
- **Critical take** — honest assessment: gaps, hidden assumptions, bandaids
  I noticed

---

# 1. Public + auth entry pages

These are everything a user can reach WITHOUT a login + without a demo
cookie. They're the product's front door.

## `/welcome`

- **Purpose:** Unauthed landing page. Three forks: sign in / try demo / sign
  up.
- **External inputs:** `bloom_demo` cookie (read server-side — if set, redirect
  to `/`); Supabase auth session (if logged in, redirect to `/`). No URL
  params.
- **Surface:** Logo + tagline + 3 CTA cards. No data-driven content.
- **User actions:** Click into `/login`, `/demo`, or `/signup`.
- **Value:** Clarity — a first-time visitor knows what to do in 3 seconds.
- **Critical take:** This IS the product's front door but has ~100 words of
  copy explaining nothing about *what* the product does. "Unified wedding
  venue intelligence" is jargon; a venue owner would bounce. The **Try Demo**
  path is the most concrete ("sample data") — lead with a screenshot or
  3-second video of the inbox, not just a button.

## `/login`

- **Purpose:** Sign in existing coordinator/admin.
- **External inputs:** Email + password from form; `supabase.auth.signInWithPassword`;
  URL `?redirect=<path>` (post-login destination from middleware).
- **Surface:** Minimal form, error text on failure.
- **User actions:** Submit creds; link to forgot password.
- **Value:** Standard login. Nothing to critique — exists.
- **Critical take:** No "stay signed in" option visible; no MFA option; no
  social sign-in. Coordinator-side users log in infrequently so this is fine.
  The bigger risk: error messages are generic ("Invalid credentials") which is
  correct for security.

## `/signup`

- **Purpose:** New venue owner creates org + first venue + admin user.
- **External inputs:** Business name, email, password, venue name + address
  from form. Hits `POST /api/auth/signup` which creates the Supabase user +
  org + venue rows, then client-side signs in with the same creds.
- **Surface:** Multi-field form. Validates email format + password strength
  client-side.
- **User actions:** Submit → lands in `/onboarding` for the 6-step wizard.
- **Value:** Self-serve onboarding for new venues. No sales call required.
- **Critical take:** The two-request pattern (API create → client signIn) is
  fragile — if signIn fails after create succeeds, user has an orphan account
  they can't access. Also, there's no email verification step before account
  is usable. That's acceptable for a B2B tool targeting venue owners (unlikely
  to spam) but worth flagging if abuse becomes an issue.

## `/forgot-password`

- **Purpose:** Kick off password reset email.
- **External inputs:** Email from form → `supabase.auth.resetPasswordForEmail`
  with `redirectTo: /reset-password`.
- **Surface:** Form + success banner after submit.
- **User actions:** Submit email.
- **Value:** Standard reset flow.
- **Critical take:** Success message shows regardless of whether the email
  exists (correct — prevents email enumeration). Relies on Supabase's email
  template; worth verifying it's branded rather than the raw Supabase default.

## `/reset-password`

- **Purpose:** Finalize password reset after clicking the email link.
- **External inputs:** Supabase session token (from email-link auth flow) +
  new password from form.
- **Surface:** New-password form; redirects to `/login` on success.
- **User actions:** Enter new password twice, submit.
- **Critical take:** No "password strength" visual indicator — a user could
  set `password1` and succeed. Supabase's built-in constraints apply but
  a UI check is cheap.

## `/demo`

- **Purpose:** Anonymous demo entry point. Two choices: platform view or
  couple portal.
- **External inputs:** Click triggers `document.cookie = 'bloom_demo=true; ...'`
  plus scope cookie. Previously would have brought forward any existing auth
  session; now explicitly calls `supabase.auth.signOut()` first (fixed in
  this session to prevent the data bleed we verified).
- **Surface:** Two big CTA cards + a 4-venue "Crestwood Collection" grid +
  sign-up CTA.
- **User actions:** Pick platform → redirected to `/` as anon + company
  scope; pick couple → redirected to `/couple/hawthorne-manor/`.
- **Value:** A venue owner can see the full product without any account.
  Scope is pinned correctly (company for platform, venue for couple).
- **Critical take:** The demo venues are named "Hawthorne Manor / Crestwood
  Farm / The Glass House / Rose Hill Gardens" (fictional). If a prospect
  visits the demo and then wants to show it to a colleague, they can just
  share the URL — cookie-based means it works cleanly. BUT: the demo cookie
  is set for 24 hours (`max-age=86400`). After 24h, the prospect loses demo
  state silently and lands back on `/welcome` with no breadcrumbs.

## `/pricing`

- **Purpose:** Sell. Tier comparison + Stripe checkout trigger.
- **External inputs:** `?tier=<name>` URL param (can pre-select); click on
  "Start free trial" fires `POST /api/stripe/checkout` which returns a
  Stripe Checkout URL, then `router.push` to it.
- **Surface:** 4 tier cards (probably Starter / Intelligence / Growth /
  Enterprise); FAQ; CTA.
- **User actions:** Compare tiers, click into Stripe, return as a paying
  customer via the Stripe webhook.
- **Value:** Self-serve upgrade. No manual invoicing.
- **Critical take:** No freemium trial visible from the page (might be in
  the checkout flow). Also: the whole payment plumbing isn't wired in
  production per your memory (`bloom-house-progress.md` mentions Stripe
  wiring as pending for one of the apps). Worth verifying the Stripe
  checkout endpoint actually returns a valid session before launch.

## `/join`

- **Purpose:** Team-invite acceptance. A coordinator clicks `/join?token=XYZ`
  from an email and either (a) creates a new account under the inviting org
  OR (b) signs in if the email matches an existing account.
- **External inputs:** `?token=<uuid>` URL param; hits `GET /api/team/accept`
  to validate + fetch the invite shape (org name, venue name, role, expiry);
  then POST on submit.
- **Surface:** Different UI shapes for valid / invalid token / expired /
  already-joined / needs-registration. Invite details shown for context
  ("Sign up to join The Crestwood Collection as a coordinator").
- **User actions:** Enter first/last name + password → creates account → lands
  in `/` scoped to the inviting venue.
- **Value:** Team growth. Owner invites a coordinator; they land exactly
  where they should.
- **Critical take:** Invitation token in URL is a one-time secret — good
  that the acceptance API validates + marks used. Worth checking the
  `expires_at` window is reasonable (memory audit mentioned 7 days default).
  Also, the "existing user" path hinges on email match — if a coordinator
  is invited to a SECOND org under the same email, does the flow cleanly
  add them to both? Doesn't look like multi-org is a supported shape.

---

# 2. Platform root + onboarding + setup

## `/` (platform dashboard)

- **Purpose:** The post-login landing page. Scope-aware: shows venue-specific
  or company-wide view depending on `bloom_scope` cookie / VenueScopeProvider.
- **External inputs:** `bloom_scope` / `bloom_venue` cookies via `useScope()`;
  URL path doesn't carry state. No web APIs fetched here — all data comes from
  Supabase.
- **Surface:**
  - Header with `ScopeIndicator` (MapPin + "Viewing venue: X" or Building2 +
    "Viewing all venues: Y"). Subtitle varies by scope.
  - 4–5 stat cards: Active Inquiries, Upcoming (30d), Pending Drafts, Booked
    Revenue (12mo), optionally Venues count (company scope).
  - `<BrainDumpQueue />` — the big "Tell Sage something" capture component.
    Floating-button equivalent embedded here for prominence.
  - `<MarketContextCard />` — weather, seasonality, search-trend headline.
  - `<InsightFeed limit={5} showViewAll />` — recent intelligence_insights
    rows ranked by priority.
  - Recent activity list (inbound interactions, last 10 or so).
  - Venue breakdown table (company/group scope only): per-venue inquiries /
    booked / revenue, sorted by revenue.
  - Quick Actions grid (varies by scope): View Inbox, Approval Queue, Intel
    Dashboard, Your Impact.
- **User actions:** Click stat card → filtered list view; click activity →
  wedding detail; click quick action → destination page; submit to brain-
  dump inline.
- **Value:** A coordinator's morning check-in — one glance at today's
  numbers, any intel the AI flagged, the last few inbound messages, quick
  jump to the primary workflows. This is the product's daily front page.
- **Critical take:**
  - The bouncy auto-redirect logic (if !venueId → `/setup`; if !onboarding_completed
    → `/onboarding`) is a second check beyond the platform layout. Runs every
    mount; for a user with both done, it's a wasted DB query every visit.
    Minor but noted.
  - 4 stat cards is generous. Only Revenue has a trend (12mo). The other 3
    are point-in-time snapshots. "Active Inquiries" goes up AND down naturally;
    a ∆-vs-last-week indicator would make this more actionable.
  - `BrainDumpQueue` on the dashboard AND the universal floating button →
    redundant surfaces. Not bad but worth knowing.
  - No date filter — the 30-day upcoming / 12mo revenue windows are
    hardcoded. A coordinator preparing for a specific month can't re-scope.

## `/onboarding`

- **Purpose:** 6-step wizard that walks a newly-signed-up venue owner from
  "I just created an account" to "AI can draft on my behalf."
- **External inputs:**
  - Form fields per step (venue basics, Gmail OAuth redirect, voice sliders,
    FAQ rows, test draft preview, Go Live button)
  - Gmail step triggers `/api/gmail/connect` → OAuth redirect to Google →
    callback lands `gmail_connections` row. This IS a web-external input
    (Google Gmail OAuth2).
  - Test draft step fires `/api/admin/test-harness` with a synthetic email
    body + venue config → live Claude call → returns a draft for preview.
  - Ad platform checkboxes (Knot/WeddingWire/Zola/website/direct) seed
    `auto_send_rules`.
- **Surface:** One-at-a-time wizard with step indicator. Fields for
  business details; personality sliders (warmth/formality/playfulness/
  brevity/enthusiasm); FAQ builder; Gmail connection status; test draft
  preview + retry; "Launch" button.
- **User actions:** Enter info, click Next. Can skip some steps (Gmail,
  FAQ). Final "Launch" flips `venues.status='active'` +
  `venue_config.onboarding_completed=true`.
- **Value:** From zero to AI-drafting-emails in ~15 minutes. This is THE
  critical path for new-venue retention — if onboarding is painful, they
  bounce before the product delivers value.
- **Critical take:**
  - Per memory audit + my verification: captures 13 fields (business_name,
    timezone, capacity, base_price, venue_prefix, max_events_per_day,
    ai_name, ad_platforms, + 5 personality dimensions, + FAQ rows). Good
    coverage.
  - Missing: team invitations (no step for "invite your coordinators"),
    Calendly connection (done later from settings), max events defaulting
    from a single venue-level number (Phase 2 will move it per-date).
  - Test draft step is the "aha moment" — a live Claude call ($0.01-ish)
    showing the AI write a reply in YOUR voice. The cost is acceptable but
    NOT metered visibly to the venue owner at this stage.
  - "Go Live" button has no irreversibility warning. If owner clicks, they
    can't easily roll back to trial mode. Minor UX concern.

## `/setup`

- **Purpose:** First-run setup for a user who signed up but hasn't yet
  created a venue. Collects org name + first venue + optional team invites.
- **External inputs:** Form fields (org name, venue name, address, price
  range, team member emails). Team invites fire `POST /api/team/invite`
  which emails an invitation with a join token.
- **Surface:** 3-step wizard: Organization, First Venue, Team.
- **User actions:** Enter org + venue, optionally invite team, hit complete
  → lands in `/onboarding` for the 6-step wizard.
- **Value:** Separates account-level setup (org, first venue, team) from
  venue-specific onboarding (AI voice, Gmail, etc.). Cleaner than one
  12-step monster wizard.
- **Critical take:**
  - Two wizards (setup + onboarding) is a LOT for a brand-new user.
    Consolidated, it's ~9 steps. Splitting reduces each session's weight
    but doubles up "where am I" confusion.
  - Price range is a dropdown (budget/mid/premium/luxury) — not written
    anywhere I can see a reader use it. Verify if it's actually read by
    intel-brain / competitor-set logic or if it's dead.
  - Team invite is optional. Owner can skip and always invite later from
    Settings. Good.
  - If signup lands someone at `/setup`, they don't see intel / portal
    etc. That's correct but there's no "preview of what comes next" — a
    teaser of the dashboard could reduce abandonment.

---

# 3. Agent section — `/agent/*`

The Agent is the email-response half of the product. 15 pages. Organized
as: daily-work (inbox, drafts, leads, pipeline, notifications), analytics
(analytics, learning), configuration (rules, sequences, settings, codes),
and maintenance (errors, knowledge-gaps, relationships, omi-inbox).

## `/agent/inbox` — "Email & leads → Inbox"

- **Purpose:** The coordinator's primary inbox for inbound wedding emails.
  Grouped by thread, shows classification, prior-touch chips, allows reply
  or approval of AI drafts inline.
- **External inputs:**
  - Gmail sync is what POPULATES the data — it's a background cron not
    reached from this page, but the Refresh button fires a re-sync.
  - `POST /api/agent/send` — coordinator-authored manual reply sends through
    Gmail.
  - `POST /api/agent/reply` — approve an AI draft reply (sends via Gmail).
  - `POST /api/agent/thread-lock` — pause AI auto-handling of a thread for
    coordinator override.
  - `POST /api/agent/drafts` — new draft generation from scratch.
  - URL `?thread=<id>` to deep-link a specific thread.
- **Surface:** Split-pane. Thread list on left with tier badges / prior-
  touches chip (warmth indicator — F8/F11 work lit this up) / source badge.
  Right pane shows message thread, any draft, classifier output panel.
  `<InlineInsightBanner category="lead_conversion,team_performance" />`
  runs above the list.
- **User actions:** Reply manually, approve/edit/reject draft, thread-lock,
  archive, reclassify. Open person profile.
- **Value:** This is where the Agent product DELIVERS. Coordinator goes
  from "48 inquiries sitting in Gmail, I don't know which to prioritize"
  to "ranked by heat + warmth, AI draft ready to send."
- **Critical take:**
  - 1,600 lines. This is the heaviest page in the app. Real complexity
    (filtering, grouping, reply-in-place, drag-to-lock) justifies the size
    but there's almost certainly dead code or duplicated patterns that
    would benefit from refactoring.
  - `PriorTouchesChip` (from F8) is the USP made tangible — "this couple
    has been on your Instagram for 3 weeks" before they emailed. If that
    chip is missing or empty, the page reverts to a generic inbox.
  - Inline insight banner can be noisy — shows insights across
    `lead_conversion` + `team_performance` which might not be relevant to
    the specific thread the coordinator is reading.

## `/agent/drafts` — "Email & leads → Approval Queue"

- **Purpose:** Review + approve AI-generated drafts in bulk before they
  send. Separate from Inbox because approval is the review workflow, not
  the live conversation.
- **External inputs:** `POST /api/agent/drafts` on approve/reject/edit
  actions. Each approval triggers `autonomous-sender.checkAutoSendEligible`
  server-side before actually sending via Gmail API.
- **Surface:** List of pending drafts with confidence score, source
  classification, brain used (inquiry/client/sage), draft body, edit
  textarea. `<DraftContextPanel />` shows the original inbound message +
  extracted signals + relevant knowledge-base entries that fed the prompt.
- **User actions:** Approve (sends via Gmail), Reject (marks rejected,
  coordinator writes manually), Edit + Approve (saves edits, learns for
  future drafts).
- **Value:** Coordinator maintains control over what goes out while
  benefiting from AI drafting. Fast lane for obvious cases; edit-then-send
  for partial matches; reject for genuinely off-base ones.
- **Critical take:**
  - Edits fed back into learning? Verify via `learning.ts`. If an edit
    isn't producing training signal, the AI can't improve on this
    venue's voice.
  - Confidence threshold below which drafts don't fire at all — check
    `auto_send_rules.confidence_threshold`. If set to 0.85 but classifier
    routinely returns 0.7, queue stays empty.
  - No bulk-approve shortcut. For a coordinator with 50 confident drafts,
    that's 50 clicks. Opportunity.

## `/agent/leads` — "Email & leads → Leads / Heat map"

- **Purpose:** All inquiries ranked by heat score. Filter by tier
  (hot/warm/cool/cold/frozen), search by name/source, sort.
- **External inputs:** Tier filter, search string, sort field/direction
  (all client-side state, not URL-persisted).
- **Surface:** Heat distribution bar at top (visual breakdown by tier),
  tier filter chips, table of leads with couple name / source badge / heat
  pill / tier / last activity / days since inquiry / status.
- **User actions:** Click into a lead → client detail. Filter + sort. No
  write actions on this page itself.
- **Value:** Daily triage tool. "Who should I call today?" → open Hot
  tier, sort by inquiry_date, reach out to warmest newest leads first.
- **Critical take:**
  - Verified this session: the filter `.gt('heat_score', 0)` hides
    truly-zero leads. Intentional (heat=0 means no engagement).
  - Client-side filter state isn't URL-persisted. Refresh = lose filter.
  - No "batch action" (e.g., "mark these 10 as lost"). For cold-lead
    cleanup, coordinator has to open each.

## `/agent/pipeline` — "Email & leads → Pipeline" (kanban)

- **Purpose:** Stage-based kanban of weddings: inquiry → tour_scheduled →
  tour_completed → proposal_sent → booked. Drag between columns to
  transition.
- **External inputs:** Drag-and-drop from `@dnd-kit/core` (PointerSensor).
  Drop triggers a status UPDATE. Also fires `POST /api/tracking` to record
  the coordinator's action for consultant_metrics.
- **Surface:** 5 column kanban. Each card: couple name / heat pill /
  source / wedding date / days in current stage.
- **User actions:** Drag cards between columns. Click card → open client
  detail.
- **Value:** Visual pipeline. Natural for coordinators coming from
  HoneyBook / Dubsado — familiar metaphor. Stage transitions create an
  audit trail (via `weddings.updated_at` + consultant_metrics events).
- **Critical take:**
  - Status CHECK (migration 001) allows: inquiry, tour_scheduled,
    tour_completed, proposal_sent, booked, completed, lost, cancelled.
    Only 5 columns shown — lost/cancelled/completed hidden. Means a card
    disappearing from the board = state change the coordinator might not
    have expected.
  - No lane-level metrics (value in stage, avg days in stage) — intel
    lives on `/intel/sources`. Could surface a tiny summary per column.
  - Drop zone errors silently on RLS failure. Low-risk but worth a toast.

## `/agent/analytics`

- **Purpose:** Agent-specific metrics: inbox volume, response time, draft
  approval rate, auto-send rate, source mix. Coordinator's "how well is
  the Agent working?" page.
- **External inputs:** Date-range picker (client-side filter against Supabase
  data). No external web APIs.
- **Surface:** 6–8 stat cards + a few trend charts + source breakdown.
- **User actions:** Change date range. No write actions.
- **Value:** Proves the product value. "Auto-send handled 40% of replies,
  coordinator saved 12 hours." This is what a venue owner shows their team
  at quarterly review.
- **Critical take:**
  - Overlaps significantly with `/intel/roi` and `/intel/sources`. A
    venue owner has to hop between 3 pages to get the full story.
  - Without a "last week vs this week" comparison, absolute numbers are
    less meaningful.

## `/agent/codes` — "Email & leads → Client codes"

- **Purpose:** List of client codes (e.g., "HM-0042") — the venue's
  internal reference for each wedding. Useful for quoting references in
  emails / contracts / Slack.
- **External inputs:** None beyond the venue's client_codes table. Copy-
  to-clipboard button.
- **Surface:** Searchable table. Code + couple name + wedding date +
  status.
- **User actions:** Search, copy code to clipboard, click through to
  wedding detail.
- **Value:** Low-value but functional. When a coordinator says "can you
  pull up HM-0042" the ref resolves.
- **Critical take:**
  - Auto-generation trigger (migration 068) means new codes get created
    automatically. Page is mostly a read-only index.
  - Could be a sidebar widget rather than a dedicated page. Real estate
    cost of a top-nav slot for "look up a code".

## `/agent/errors`

- **Purpose:** Surface ingestion errors — classifier failures, Gmail
  auth issues, draft generation failures — so coordinator sees why
  something didn't land.
- **External inputs:** None beyond `error_logs` table writes (from
  pipeline via `logPipelineError`).
- **Surface:** Filterable log. Severity, stage, venue, time, body preview.
- **User actions:** Filter, expand row, click retry where available.
- **Value:** Debugging layer. In a world where the Agent is a black box,
  this is the transparency.
- **Critical take:**
  - Most venue owners will never look here. It's an ops tool. Fine for
    it to exist but shouldn't be in the primary nav; could nest under
    Settings.
  - No "mark resolved" or "snooze" — errors just pile up indefinitely.

## `/agent/knowledge-gaps`

- **Purpose:** Questions the AI couldn't confidently answer. Presented
  to the coordinator as "train me — what's the answer?" so the FAQ grows
  organically from real inbound traffic.
- **External inputs:** None beyond `knowledge_gaps` rows (written by
  `recordKnowledgeGaps` inside the pipeline). Answer submission writes to
  `knowledge_base`.
- **Surface:** Categorized list of unanswered questions (or questions
  with low-confidence extraction). Each row: question, how often asked,
  categories, "provide answer" form.
- **User actions:** Type answer, submit → becomes a new knowledge_base
  row with `source='knowledge_gap_resolution'`. Dismiss if irrelevant.
- **Value:** THE continuous-improvement loop. FAQ grows from real inbox
  traffic, not a-priori guessing.
- **Critical take:**
  - Needs to be discoverable — coordinator has to know this page exists.
    The notifications panel should prompt "3 new unanswered questions"
    (verify).
  - The answers are free-text; no review before they start shaping future
    drafts. A bad/contradictory answer silently poisons the knowledge base.

## `/agent/learning`

- **Purpose:** Voice training games. "Would You Send This?", "Cringe or
  Fine?", "Quick Voice Quiz" — quick rounds that train `venue_ai_config`
  personality + `voice_preferences` rules.
- **External inputs:** Coordinator picks answer per round → writes
  `voice_training_responses` + derived `voice_preferences`. Upload CSV of
  approved past replies = bulk voice training signal.
- **Surface:** Game-picker landing → round-based play surface → results.
- **User actions:** Play, upload CSV, view learned preferences.
- **Value:** Voice tuning without having to write a prompt. 10 minutes of
  gamified training = noticeably improved drafts.
- **Critical take:**
  - Static content in `voice-training-content.ts` — 10+ hardcoded examples
    per game. If the coordinator plays through the full set, replay value
    is zero.
  - No telemetry visible on "how much has Sage learned" — a progress
    meter would make training feel productive.

## `/agent/notifications`

- **Purpose:** Notification center + notification-preference settings.
  Booking confirmation prompts, cooling-warning notifs (F3/F4 work from
  this session), high-priority insights, brain-dump clarifications.
- **External inputs:**
  - `POST /api/agent/confirm-booking` — coordinator confirms / dismisses
    booking_confirmation_prompt.
  - `POST /api/agent/auto-send-cancel` — "undo autosend" before the
    draft goes out.
- **Surface:** Tabs: Notifications (feed), Brain-dump clarifications
  (questions Sage has about imported data), Preferences (email / push /
  in-app toggles per notification type).
- **User actions:** Confirm booking, cancel auto-send, update preferences.
- **Value:** The nudge layer. Coordinator doesn't have to watch every
  channel — Bloom tells them when action is needed.
- **Critical take:**
  - Forever-dedup for `booking_confirmation_prompt` (this session's fix)
    — coordinator needs to DELETE notifications to re-trigger; mark-read
    doesn't. May surprise.
  - Preferences UI probably writes to a table that actually gates any
    emails. Worth confirming email delivery is wired end-to-end.

## `/agent/omi-inbox`

- **Purpose:** Orphan transcripts from Omi wearable that couldn't auto-
  match to a scheduled tour. Coordinator manually picks which tour each
  transcript belongs to.
- **External inputs:** Populated by `/api/omi/webhook` from Omi hardware.
  Attach action writes via `PATCH /api/omi/orphans/:id`.
- **Surface:** List of orphan transcripts with session metadata, per-row
  attach-to-tour dropdown.
- **User actions:** Pick a tour, attach. Or dismiss.
- **Value:** Catches transcripts that arrive out-of-band (no matching
  tour slot). Coordinator can still mine them for voice training.
- **Critical take:**
  - Only 249 lines — clean. Niche page for Omi-wearing venues; most
    venues will never see this populated.
  - If Omi isn't configured, page shows empty state. Good.

## `/agent/relationships`

- **Purpose:** Vendor / referrer graph. "Sarah was referred by Emma who
  is a florist we work with" — surfaces the web of who's connected to
  whom.
- **External inputs:** None beyond `relationships` table writes (user
  creates relationships in-UI).
- **Surface:** Graph or list visualization. Person-to-person edges with
  relationship type (referred_by, works_with, parent_of).
- **User actions:** Add/edit/remove relationships.
- **Value:** Ad-hoc CRM layer for vendor referrals. Probably modest
  actual value today — most coordinators just remember "Emma is the
  florist at Hawthorne" without needing a graph.
- **Critical take:**
  - Good hygiene to track referrals explicitly (they're high-value
    leads) but the UX of clicking through a graph to record "who
    referred whom" is friction-heavy. Could be better as a quick-add
    on each person's detail page.

## `/agent/rules`

- **Purpose:** Auto-send rules configuration. Per (context, source)
  row defines: enabled, confidence_threshold, daily_limit, thread_cap_24h.
- **External inputs:** Form fields → writes `auto_send_rules`.
- **Surface:** Matrix of (context × source). Toggles + number inputs.
- **User actions:** Configure auto-send behaviour per source.
- **Value:** Core coordinator safety control. "I trust Knot auto-replies
  but NOT website calculator replies" — this page gates that.
- **Critical take:**
  - 1267 lines — likely includes rule-testing UI (preview a would-be
    auto-send with current config). Worth confirming.
  - `thread_cap_24h` added in migration 070; `getMatchingRule` in
    autonomous-sender.ts reads it correctly (verified this session).
  - Default off. New venue has no rules until coordinator turns them
    on. Conservative default — correct.

## `/agent/sequences`

- **Purpose:** Configurable follow-up sequences: "If inquiry is X days
  silent, send follow-up email Y." Template builder.
- **External inputs:** None beyond sequence template writes + per-wedding
  enrollment.
- **Surface:** Template library + per-wedding "enroll" / "un-enroll"
  actions. Sequence editor with triggers, delays, templates.
- **User actions:** Create/edit/enable sequences, enroll weddings.
- **Value:** Automation layer for cold-lead nurture. Saves the
  "I need to follow up Monday" mental note.
- **Critical take:**
  - Large file (1198 lines). Sequence builder is inherently complex.
  - Interaction with F3/F4 auto-mark-lost: if a sequence is set to fire
    at day 25 but `lost_auto_mark_days=30`, the wedding gets auto-lost
    5 days after the sequence's last email. Worth auditing overlap.

## `/agent/settings`

- **Purpose:** Gmail connection, auto-send defaults, follow-up defaults,
  scope-specific Agent config.
- **External inputs:**
  - `GET /api/agent/gmail` — check connection status
  - `POST /api/agent/gmail` — connect, set as primary, disable
  - `DELETE /api/agent/gmail` — disconnect
  - `POST /api/auth/gmail/disconnect` — full OAuth revocation
  - OAuth redirect to Google on "Connect Gmail" button.
- **Surface:** Gmail account list with per-account toggles (primary,
  enabled). Auto-send defaults. Follow-up sequence defaults.
- **User actions:** Connect/disconnect Gmail accounts; flip defaults.
- **Value:** Central config for Agent behaviour. First stop for new
  coordinators beyond onboarding.
- **Critical take:**
  - Multi-Gmail support (migration 050) means a venue can attach 2+
    inboxes. Useful for venues with role-based addresses (bookings@,
    hello@).
  - Tokens stored in Supabase. Rotation cadence undocumented — if
    Google revokes a token mid-flight, the coordinator sees an error
    but the re-auth path needs to be obvious.

---

# 4. Intel section — `/intel/*`

26 pages. The intelligence layer is the USP — where Bloom separates from
HoneyBook / Dubsado. Grouped below by role.

## Core intelligence views

### `/intel/dashboard` — "Intelligence Dashboard"

- **Purpose:** The venue's morning intelligence briefing. Top-level view
  aggregating insights, anomalies, health score, market context.
- **External inputs:** `GET /api/intel/anomalies` fetches server-computed
  anomaly rows. Date filter (client-side).
- **Surface:** Hero metric + trend. Priority insights feed. Anomalies
  list. Market-context card (weather + search trends). Health score ring.
  Quick links into sub-pages.
- **User actions:** Dismiss insight, click through to detail pages.
- **Value:** "What changed today?" The dashboard answers it without the
  coordinator having to check 5 separate tools.
- **Critical take:**
  - 767 lines. Lots of composition. A new venue with no data sees a
    mostly-empty page — the empty-state-per-component needs to be
    graceful (verify none show "No data" stacked 6x).
  - No "pin a chart" — whatever's on here is on here. Some venues might
    want to prioritize sources over trends.

### `/intel/briefings` — "Intelligence Briefings"

- **Purpose:** AI-generated narrative briefings (daily / weekly /
  monthly). Each briefing is a 3-5 paragraph Claude-written summary of
  activity + recommendations.
- **External inputs:** `GET /api/intel/briefings` (latest), `?all=true`
  (archive).
- **Surface:** Chronological list of briefings. Each expands to show full
  markdown text.
- **User actions:** Read, mark as read, share (copy link).
- **Value:** A coordinator doesn't have time to scan 20 dashboards every
  morning. The briefing compresses the week into "here's what matters."
- **Critical take:**
  - Claude API calls cost money per generation. Briefings run on cron.
    Budget mentioned at ~$0.02 per briefing — worth auditing if monthly
    is fired for every venue vs. only active ones.
  - Quality depends on data volume. A brand-new venue's first weekly
    briefing will be ~2 paragraphs of "not enough data yet." Good to
    gate on a minimum-data threshold.

### `/intel/insights` — "Intelligence Insights"

- **Purpose:** Filterable feed of all `intelligence_insights` rows
  (correlation, anomaly, prediction, recommendation, benchmark, trend,
  risk, opportunity — per type taxonomy).
- **External inputs:** Category filter (client-side), status filter
  (new/seen/dismissed).
- **Surface:** Card list with priority-tinted borders. Each card: type
  icon, title, body, confidence, data points. Dismiss + mark-resolved
  actions.
- **User actions:** Mark seen/dismissed/resolved, click into related
  wedding.
- **Value:** Central audit trail of EVERY insight the AI has surfaced.
  Compared to the Dashboard (top 5), this is the full archive.
- **Critical take:**
  - Unless actively triaged, this page becomes a landfill. Add pagination
    + a "last 30 days" default.

### `/intel/reach` — "Marketing Reach" (new this audit round)

- **Purpose:** Cross-channel marketing metrics: Instagram followers,
  website visits, Knot profile views, etc. From brain-dump analytics
  shape.
- **External inputs:** `GET /api/intel/reach` serves aggregated
  `engagement_events` where `event_type='marketing_metric'`.
- **Surface:** Trend lines per channel. Source filter. Metric selector
  (followers / impressions / clicks etc).
- **User actions:** Change source + metric filters.
- **Value:** The couple asking "where should we spend our marketing
  budget?" answers here. Feeds attribution math.
- **Critical take:**
  - Only 190 lines — minimal. Shape is young. Real value depends on
    coordinators consistently uploading monthly screenshots of Knot /
    Instagram / Google Business analytics.

## Performance / ROI

### `/intel/roi` — "Your Impact"

- **Purpose:** "How much value has Bloom delivered?" — response-time
  savings, auto-send hours, conversion-rate deltas, estimated $ saved.
- **External inputs:** None external (aggregates from `drafts`,
  `interactions`, `weddings`).
- **Surface:** 4-6 big stat cards + narrative "since signup" stat
  (bookings, revenue, hours saved).
- **User actions:** Read. Share (screenshot) for the "it's working"
  conversation.
- **Value:** Retention / churn prevention. When a venue owner is deciding
  whether to keep Bloom, this page makes the case.
- **Critical take:**
  - Calculations are visible as numbers but not as formulas — if a venue
    owner doesn't trust a stat, there's no "show me how" link.

### `/intel/sources` — "Source Attribution"

- **Purpose:** Which inquiry sources actually produce bookings? Funnel
  per source: inquiries → tours → bookings → revenue. Avg booking value
  per source.
- **External inputs:** Date range filter.
- **Surface:** Table + bar chart of source ROI. Highlight best +
  worst-performing sources.
- **User actions:** Adjust date range, drill into a specific source.
- **Value:** The "kill Knot subscription / double down on Instagram"
  decision is made here.
- **Critical take:**
  - 1027 lines — heavy. Includes multiple views (funnel, cohort, LTV).
  - Source canonical (F2 work) matters here: if 'wedding_wire' and
    'weddingwire' both appear, source looks fragmented. Normalized now.

### `/intel/health` — "Venue Health Score"

- **Purpose:** Composite health score (0-100) with subscores: lead
  quality, response time, conversion, capacity utilization, review
  sentiment. Trendline over time.
- **External inputs:** None external (reads `venue_health_history`).
- **Surface:** Big score ring, subscore breakdown, trend chart, callouts.
- **User actions:** Read.
- **Value:** Single number owner can track. If it drops, something's
  broken.
- **Critical take:**
  - Subscore weights are hardcoded server-side. Different venues might
    weight differently (destination venue cares less about walk-ins).
    Not customizable today.

### `/intel/team` — "Team Performance"

- **Purpose:** Per-coordinator metrics — response time, approval rate,
  bookings.
- **External inputs:** None external.
- **Surface:** Table of coordinators + key stats.
- **User actions:** Drill into a coordinator.
- **Value:** Venue manager sees who's handling lead flow well vs. who's
  slow.
- **Critical take:**
  - Politically sensitive. No "compare yourself to peer" framing;
    leaderboard can be a morale problem. Consider opt-out.

### `/intel/team-compare`

- **Purpose:** Head-to-head of two coordinators on the same metrics.
- **External inputs:** None external.
- **Surface:** Side-by-side charts.
- **User actions:** Pick 2 coordinators, compare.
- **Value:** Coaching tool: "look at Mary's response time — let's
  figure out what she's doing."
- **Critical take:** Same morale risk as /team.

### `/intel/capacity` — "Capacity & Yield"

- **Purpose:** Date-by-date view of bookings vs. capacity. Yield
  (revenue per available date) over time.
- **External inputs:** None external.
- **Surface:** Calendar heatmap, yield-per-date metrics.
- **User actions:** Click a date → see bookings.
- **Value:** "Peak Saturdays in June are 100% booked — can we raise
  prices?" answered here.

## Market / competitive

### `/intel/market-pulse` — "Market Pulse"

- **Purpose:** Broadest external-intel view. Search trends, weather,
  economic indicators, competitor moves, positioning score.
- **External inputs:**
  - `GET /api/intel/positioning` — competitor + market positioning
  - `GET /api/intel/recommendations` — Claude-generated recommendations
  - Reads `search_trends` (seeded by SerpAPI cron)
  - Reads `weather_data` (seeded by NOAA CDO cron)
  - Reads `economic_indicators` (seeded by FRED cron)
- **Surface:** 2261 lines — the biggest intel page. Trend cards, weather
  forecast, econ indicators, AI recommendations, positioning gauge.
- **User actions:** Read. Click into specific trend / competitor.
- **Value:** The "what's happening outside my venue that affects me"
  page. Event venue owners live in local market dynamics.
- **Critical take:**
  - External APIs are cron-synced; if SerpAPI key is wrong (memory
    mentions this was a bug earlier) the page silently shows stale data.
  - 2261 lines is unmaintainable. This deserves to be split into 4
    sub-pages or use lazy-loaded sections.

### `/intel/trends` — "Trends & Recommendations"

- **Purpose:** Search trends specifically (via Google Trends through
  SerpAPI) + actionable recommendations.
- **External inputs:**
  - `GET /api/intel/trends`
  - `GET /api/intel/recommendations`
- **Surface:** Trend lines per keyword, rising-vs-declining table,
  AI-written recs.
- **User actions:** Read recommendations; mark outcome after trying.

### `/intel/benchmark` — "Venue Benchmark"

- **Purpose:** Compare this venue's metrics to peer venues (same
  region + price tier). Uses `industry_benchmarks` table.
- **External inputs:** None (industry benchmarks are seeded).
- **Surface:** Metric-by-metric comparison with "top 25% / median /
  bottom 25%" bands.
- **User actions:** Read.
- **Value:** Context for the venue's own numbers. "Is a 20% tour
  conversion good or bad?" → compared to peers.
- **Critical take:**
  - Industry benchmark data quality is the whole game. If it's stale
    or synthetic, the comparison is misleading. Worth documenting
    source + refresh cadence.

### `/intel/regions` — "Regional Analytics"

- **Purpose:** Census-backed regional intelligence — age demographics,
  income, wedding market size.
- **External inputs:** None (reads `market_intelligence` with
  `age_18_34_pct`, `bachelors_or_higher_pct` from migration 081).
- **Surface:** Regional map or list + key stats per region.
- **User actions:** Read.
- **Value:** For venue owners considering regional expansion OR
  justifying marketing spend by region.

### `/intel/social` — "Social Media Correlation"

- **Purpose:** Does Instagram activity correlate with inquiries?
  Pearson correlation between posting cadence / follower growth / etc.
  and inquiry volume.
- **External inputs:** Reads `engagement_events` of type
  `marketing_metric` for social channels.
- **Surface:** Correlation matrix + lag analysis + "your best posting
  days" callout.
- **User actions:** Read.
- **Value:** Stops the "I post on Instagram and nothing happens" angst.
  Shows 7-day lag from post to inquiry.

## Client data

### `/intel/clients`

- **Purpose:** Cross-venue list of all couples. Filterable by stage,
  source, venue.
- **External inputs:** Search + filter state.
- **Surface:** Table: couple name, wedding date, status, source,
  booking value, venue.
- **User actions:** Click into client → `/intel/clients/[id]`.
- **Value:** One-stop list for "who are all my clients ever."

### `/intel/clients/[id]`

- **Purpose:** Per-client deep-dive. Timeline, emails, tours,
  touchpoints, heat history, Sage conversation log, AI-inferred
  preferences, relationship map.
- **External inputs:** URL `[id]` = wedding_id; pulls everything for
  that wedding.
- **Surface:** Rich multi-section page: profile, timeline, messages,
  extracted signals, prior touches, AI insights.
- **User actions:** View history, reclassify, merge candidates.
- **Value:** When a client calls, coordinator can pull up every
  interaction in one place.

### `/intel/matching` — "Client Deduplication"

- **Purpose:** F1 signal-pair + person-pair queue. Coordinator reviews
  suggested matches and merges or dismisses.
- **External inputs:** `POST /api/agent/match-queue/[id]/resolve` with
  `{action}` on each click (merge/dismiss/snooze/unsnooze/wait_for_signal).
- **Surface:** Two panes post-audit: person↔person matches (merge button)
  + signal↔signal pairs (dismiss only, new this session).
- **User actions:** Merge, dismiss, snooze, wait-for-signal.
- **Value:** Prevents duplicate couples across channels. "Sarah on Knot"
  and "Sarah via website" become one record.
- **Critical take:** Signal-pair pane hides when empty — correct.

### `/intel/tours` — "Tour Tracking"

- **Purpose:** Upcoming + past tours. Log outcome, attach transcript,
  trigger post-tour brief.
- **External inputs:**
  - `POST /api/agent/tour-transcript-extract` — triggers Claude
    extraction on uploaded transcript.
  - `POST /api/agent/post-tour-brief` — triggers brief generation.
  - `POST /api/tracking` — records coordinator action for
    consultant_metrics.
- **Surface:** Upcoming list + past list + per-tour modal for outcome,
  notes, competing venues, attendees.
- **User actions:** Log tour outcome, upload transcript, generate brief.
- **Value:** Tour is the highest-value touchpoint in the sales cycle.
  Capturing what happened there is gold for voice training + conversion
  analysis.

### `/intel/lost-deals` — "Lost Deals"

- **Purpose:** List of lost_deals with reasons (no_response, pricing,
  competitor, date_unavailable, ghosted, etc.).
- **External inputs:** Filter state.
- **Surface:** Table. Per-row: couple, stage lost, reason category,
  competitor name, recovery attempt status.
- **User actions:** Mark recovery attempted/outcome.
- **Value:** Post-mortem data. "60% of losses are pricing — can we
  adjust tiers?" answerable here.
- **Critical take:**
  - Auto-lost rows from F3/F4 land here with reason "auto: no response
    after N days". Correctly categorized as `reason_category='other'`
    per `markAsLost` — might miss the "no_response" bucket. Worth a
    mapping tweak.

## Forecasting / anomalies

### `/intel/forecasts` — "Revenue Forecasts"

- **Purpose:** Projected revenue for the next 30/60/90 days based on
  pipeline + historical conversion rates.
- **External inputs:** None external.
- **Surface:** Projected vs actual chart, scenario toggles (pessimistic
  / expected / optimistic).
- **User actions:** Adjust scenarios, export.

### `/intel/anomalies` — "Anomaly Detection"

- **Purpose:** List of detected anomalies — inquiry volume spike,
  response time drop, conversion cliff, etc.
- **External inputs:** `GET /api/intel/anomalies`.
- **Surface:** Severity-tagged feed. "Confirm" / "Dismiss" / "Ignore"
  per row.
- **User actions:** Act on or dismiss an anomaly.
- **Value:** Early-warning system. Bloom tells the coordinator something
  unusual is happening before they notice themselves.

## Campaigns / reviews / misc

### `/intel/campaigns` — "Campaign ROI"

- **Purpose:** Track paid campaigns (Knot tier, WeddingWire premium,
  Instagram ads). Spend → inquiry → booking ROI.
- **External inputs:** Spend CSV upload fires parsing (possibly
  `/api/intel/campaigns/import` — verify).
- **Surface:** Per-campaign table with spend, inquiries, bookings, ROI%.
- **User actions:** Upload spend, tag inquiries with campaigns.

### `/intel/reviews` — "Reviews"

- **Purpose:** Third-party review aggregator (Google, Knot, WW, Yelp,
  Facebook). Sentiment analysis. Phrase extraction for voice training.
- **External inputs:**
  - `GET /api/intel/reviews` — fetch
  - Upload from CSV / screenshot (via brain-dump).
- **Surface:** Review list, filters, sentiment trend, per-source
  breakdown.
- **User actions:** Mark review for voice training (`approved_for_sage`).

### `/intel/voice-dna` — "Voice DNA"

- **Purpose:** The venue's learned voice patterns — phrases Sage knows
  to use, tone words, forbidden phrases. Fed from reviews + transcripts.
- **External inputs:** None external.
- **Surface:** Phrase library organized by category (opener, closing,
  excitement, etc.). Source badges (review / transcript / manual).
- **User actions:** Approve, reject, edit phrases.
- **Value:** The AI-drafts-in-our-voice USP is visible here. If this is
  empty, drafts will sound generic.

### `/intel/nlq` — "Natural Language Query"

- **Purpose:** Ask questions in plain English. "How many bookings from
  Knot last month?" → Claude parses intent → runs SQL → returns answer.
- **External inputs:** `POST /api/intel/nlq` with the user's question;
  returns answer + underlying SQL + result table.
- **Surface:** Chat-like input + answer display.
- **User actions:** Type questions, copy answer.
- **Value:** Zero-SQL analytics. "Accessibility" for venue owners who
  don't know SQL.

### `/intel/portfolio` — "Portfolio Overview"

- **Purpose:** Multi-venue owners' view. Rolls up metrics across every
  venue they own. Visible only at org/company scope.
- **External inputs:** None external.
- **Surface:** Per-venue table + comparative charts.
- **User actions:** Drill into a specific venue.

### `/intel/company` — "Company Overview"

- **Purpose:** Company-level (organisation) metrics. Similar to
  portfolio but framed as the BUSINESS ENTITY rather than its venues.
- **External inputs:** None external.

### `/intel/dashboard` — already covered

### `/intel/annotations`

- **Purpose:** Calendar of notable events — "hosted charity event",
  "Knot profile refreshed", "hired new DJ" — anchors for future
  correlation analysis.
- **External inputs:** None external.
- **Surface:** Timeline, add-annotation form.
- **User actions:** Add / edit annotations.
- **Value:** Ground-truth for correlation analysis. When Bloom sees a
  spike, annotations explain WHY.
- **Critical take:** Only 325 lines — modest. Discoverability risk — if
  coordinators never add annotations, the correlation engine has less
  signal.

---

# 5. Portal (coordinator-side) — `/portal/*`

The Portal half is the coordinator's view into the Couples experience.
Broken into three sub-areas:
- **Wedding management:** weddings list, [id] detail, quick-add
- **Communication:** messages (with couples), sage-queue (AI messages
  waiting for coordinator approval before couple sees)
- **Config:** 16 config pages that determine what appears in the couple
  portal per-venue (rooms, bar, rehearsal, etc.)

## Wedding management

### `/portal/weddings` — "Weddings"

- **Purpose:** List of all weddings (any stage). Coordinator's primary
  couple-management view.
- **External inputs:**
  - `POST /api/portal/invite-couple` — sends invitation email with
    event-code registration link.
  - `POST /api/tracking` — logs coordinator action (e.g., "invited
    couple" for consultant_metrics).
- **Surface:** Table of weddings with status, date, source, partners,
  invite status, client code. "+ New Wedding" modal for manual entry.
- **User actions:** Create wedding, invite couple, click into detail,
  filter/search.
- **Value:** CRM-like view of the book of business. Every couple from
  inquiry to day-of.
- **Critical take:** 1242 lines — lots of modal + filter UI. Overlaps
  with `/intel/clients` (also a cross-wedding list). Portal is more
  operational (invite, manage), Intel is more analytical (metrics).

### `/portal/weddings/[id]` — per-wedding detail

- **Purpose:** THE deep view of a single wedding. 2342 lines — the
  heaviest non-config page. Tabs for every aspect: overview, timeline,
  guests, vendors, decor, tables, seating, contracts, etc.
- **External inputs:**
  - `POST /api/portal/invite-couple` — re-send invite
  - `POST /api/portal/event-feedback` — post-event feedback capture
- **Surface:** Rich tabs: basics, people, timeline, budget, vendors,
  checklist, contracts, guests, seating, notes, pipeline stage.
- **User actions:** Edit every field, add vendors, approve timeline,
  attach contracts, manage RSVP, etc. Generate Day-of Package (print).
- **Value:** This is where coordinators do most of their planning work
  with a couple.
- **Critical take:**
  - 2342 lines is A LOT. Monolithic page = maintenance burden.
  - Real couple-portal mirror lives at `/portal/weddings/[id]/portal`
    (coordinator sees what couple sees).

### `/portal/weddings/[id]/portal` — couple-portal preview

- **Purpose:** Coordinator previews EXACTLY what the couple sees in their
  portal. Useful for debugging "the couple said they can't find X."
- **External inputs:** None; reads all wedding data server-side.
- **Surface:** Same shell as the couple portal, but with coordinator
  scope overrides.
- **Value:** Support + QA. Saves "can you screenshot your screen?" tickets.

### `/portal/weddings/[id]/print` — Day-of Package

- **Purpose:** Print-optimized PDF-style view of everything needed for
  the wedding day: timeline, vendor contact list, seating chart, allergy
  list, shuttle schedule, ceremony chair count.
- **External inputs:** None.
- **Surface:** No-print banners, full-width timeline, roster, charts.
- **User actions:** Browser print to PDF.
- **Value:** The physical binder the coordinator brings on-site. One
  click from digital to printed.

### `/portal/weddings/[id]/table-map`

- **Purpose:** Canvas-based seating diagram. Drag tables, assign guests.
- **External inputs:** Canvas interactions; no external web APIs.
- **Value:** Visual seating planning. Alternative to the text-based
  seating-config flow.

### `/portal/quick-add`

- **Purpose:** Rapid-entry bulk couple creation — past clients, pre-
  platform bookings. Paste/type multiple weddings at once.
- **External inputs:** `POST /api/portal/quick-add` — parses entry,
  creates weddings + people.
- **Surface:** 1399 lines — powerful bulk form. CSV paste, field
  mapping.
- **User actions:** Paste data, map fields, commit.
- **Value:** Onboarding escape hatch — a venue with 200 historical
  weddings can load them in 10 minutes instead of 200 modals.

## Communication

### `/portal/messages`

- **Purpose:** Coordinator-facing view of couple-portal chat. Not
  real-time chat; reviews Sage's conversations with couples + lets
  coordinator intervene.
- **External inputs:** None direct; reads Sage conversation history.
- **Surface:** Thread list + per-thread reader.
- **Value:** Oversight of Sage-couple conversations. Catches Sage
  hallucinations before they cause issues.

### `/portal/sage-queue`

- **Purpose:** Sage responses to couples that need coordinator approval
  before the couple sees them (for flagged / low-confidence responses).
- **External inputs:** None direct.
- **Surface:** Queue of pending Sage replies with original couple
  question. Approve / edit / reject.
- **Value:** Coordinator maintains control over what Sage tells couples.

## Config pages (16)

These are all coordinator-facing config that shapes what couples see.
They're the "admin panel" for the Couple Portal. Data inputs are entirely
user form fields; no external web APIs. Most are 300-900 lines of CRUD
UI for a specific domain object.

- **`/portal/accommodations-config`** — hotel blocks, partner hotels
  list. Shown to couples under `/couple/stays`.
- **`/portal/availability`** — the venue's calendar (booked dates, hold
  dates, override max_events per date). Coordinator view of what will
  drive `couple/availability` visibility.
- **`/portal/bar-config`** — bar type (in-house / BYOB / hybrid),
  beverage packages, guest-per-bartender ratios.
- **`/portal/checklist-config`** — templates for the per-wedding
  checklist. Couples see their instance of this.
- **`/portal/decor-config`** — decor catalog, rental vs BYO items.
- **`/portal/guest-care-config`** — allergy handling, dietary tags,
  accessibility accommodations.
- **`/portal/kb`** — "Knowledge Base". Venue's FAQ. Couples see
  answers via Sage chat; new Q&As can come from
  /agent/knowledge-gaps auto-learning too.
  - **External inputs:** CSV import for bulk FAQs.
  - 932 lines — quite large. Deserved given it's the single source of
    venue knowledge for Sage.
- **`/portal/rehearsal-config`** — rehearsal slot options, dinner setup,
  rehearsal dinner venue options.
- **`/portal/rooms-config`** — rooms/suites available at the venue. Per-
  room descriptions + photos.
- **`/portal/seating-config`** — table + linen options, default seating
  rules.
- **`/portal/section-settings`** — "which portal sections are shown to
  couples at this venue?" Toggle allergies, bar, beauty, ceremony, etc.
  - **External inputs:** `GET /api/portal/section-config?bulk=true`,
    matching POST.
  - The meta-page. Venues opt out of sections they don't offer (e.g., a
    venue without accommodations hides the Stays tab for couples).
- **`/portal/shuttle-config`** — shuttle schedule templates.
- **`/portal/staffing-config`** — staff roster templates.
- **`/portal/tables-config`** — dup with seating-config for table
  dimensions. Linen size recommendations.
- **`/portal/vendors`** — recommended-vendor directory. Per-category
  lists (DJ, photographer, florist). Feeds couple /preferred-vendors.
- **`/portal/venue-assets-config`** — logo, brand colors, fonts.
- **`/portal/venue-usps-config`** — venue USPs / selling points. Used
  by AI for drafting inquiry replies.
- **`/portal/wedding-details-config`** — what "wedding details" fields
  the venue collects from couples (ceremony start, reception end, etc.).
  - **External inputs:** `GET /api/portal/wedding-detail-config`.

**Value of config pages collectively:** the Couple Portal is per-venue
configured without any code changes. A luxury estate shows rooms; a
daylight-only barn hides them. All surfaced as a wedding-detail /
room/bar/etc config per venue.

**Critical take on config:**
- 16 config pages is a LOT of coordinator training surface. A new venue
  has to visit 10+ of these before their couples see a useful portal.
  An onboarding wizard step could walk through defaults.
- No "reset to defaults" across most — if a coordinator breaks their
  config, they have to manually restore.
- Several configs overlap (seating + tables; rooms + accommodations).
  Probably historical reasons — could be consolidated.

---

# 6. Settings + super-admin

## `/settings` (root)

- **Purpose:** Big single-page settings hub. 1557 lines — likely the
  "everything config" landing page with sections for venue basics,
  branding, policies.
- **External inputs:** Form fields, image upload (for logo).
- **Surface:** Sectioned form: venue profile, branding (colors, fonts),
  policies (cancellation, deposit), contact info.
- **User actions:** Edit anything, save.
- **Value:** Single page for common venue config changes.
- **Critical take:** 1557-line monolith. Real gain from splitting but
  historic reason probably: one big form = one save button.

## `/settings/sage-identity`

- **Purpose:** Configure the venue's AI personality. Name (e.g., "Sage"
  default or custom like "Ivy"), signature, bio.
- **External inputs:** Form fields.
- **Surface:** AI name input, bio editor, signature preview.
- **User actions:** Edit name + bio; save → `venue_ai_config.ai_name`
  + related fields.
- **Value:** Core white-label lever. This is what gives each venue its
  own branded AI assistant instead of everyone getting "Sage".
- **Critical take:**
  - `DEFAULT_AI_NAME = 'Sage'` fallback. If coordinator doesn't set a
    name, couple portal shows "Sage" — a competitor's AI brand name
    would leak if Bloom ever white-labels more aggressively.

## `/settings/personality`

- **Purpose:** Voice sliders (warmth, formality, playfulness, brevity,
  enthusiasm). Sets `venue_ai_config.*_level`.
- **External inputs:** Slider interactions.
- **Surface:** 5 sliders + live-preview of sample draft at current
  settings.
- **User actions:** Adjust sliders, save.
- **Value:** Fast tuning of AI voice without writing a prompt.

## `/settings/voice`

- **Purpose:** Voice training games entry + approved-phrase management.
  Overlaps with `/agent/learning` — likely links out.
- **External inputs:** Same games as `/agent/learning`.
- **Surface:** Game cards + phrase library.

## `/settings/team`

- **Purpose:** Invite + manage teammates, assign roles (venue_manager /
  coordinator / readonly).
- **External inputs:** `POST /api/team/invite` — sends invitation email
  with join token.
- **Surface:** Team roster + role dropdowns + "Invite teammate" form.
- **User actions:** Invite, change role, remove.
- **Value:** Multi-user venues. A solo owner invites their first
  coordinator here.

## `/settings/groups`

- **Purpose:** Manage venue_groups (for multi-venue org admins who want
  to group 3 rural venues as "Rural Portfolio" separate from 2 city
  venues).
- **External inputs:** Form fields.
- **Surface:** Group list, member assignment.
- **User actions:** Create group, assign venues.
- **Value:** Large portfolios only. For 1-venue owners this page is
  dead.

## `/settings/billing`

- **Purpose:** Stripe subscription management.
- **External inputs:**
  - `GET /api/stripe/subscription` — current state
  - `POST /api/stripe/portal` — redirect to Stripe Customer Portal for
    payment-method + cancel + plan changes
- **Surface:** Current plan, next invoice, "Manage subscription" button.
- **User actions:** Open Stripe portal.
- **Value:** Self-serve billing. Stripe-hosted for PCI compliance.

## `/settings/inbox-filters`

- **Purpose:** Manage `venue_email_filters` — rules for "always ignore
  this sender", "always tag with this label".
- **External inputs:** `GET/POST /api/agent/inbox-filters`.
- **Surface:** Filter table (pattern_type, pattern, action, source).
- **User actions:** Add/edit/delete filters.
- **Value:** Coordinator safety valve when Sage keeps auto-responding
  to newsletter emails. One filter rule stops it.
- **Critical take:**
  - Calendly / HoneyBook are seeded by default (verified this audit).

## `/settings/omi`

- **Purpose:** Pair Omi wearable with the venue. Copy webhook URL,
  rotate token, toggle auto-match.
- **External inputs:** `GET /api/omi/token` (read), `POST /api/omi/token`
  (rotate).
- **Surface:** Webhook URL + copy button, rotation UI, auto-match toggle.
- **User actions:** Rotate token, toggle auto-match.
- **Value:** Niche. Venues without Omi never visit.

## `/super-admin`

- **Purpose:** Platform-wide admin. Cross-venue metrics, user
  impersonation, AI cost dashboard.
- **External inputs:** None beyond DB.
- **Surface:** Global stats — total venues, total users, total AI cost
  this month, top venues by activity.
- **User actions:** View. Possibly impersonate user.
- **Value:** Internal tool. Only super_admin role sees it.

## `/super-admin/pipeline-health`

- **Purpose:** Per-venue pipeline health diagnostic — "is email ingest
  working? heat scoring? auto-send?" for every venue at once.
- **External inputs:** None direct; reads + aggregates from all venues.
- **Surface:** Matrix of venues × subsystems with status indicators.
- **User actions:** Click into a failing subsystem for logs.
- **Value:** Ops. When a customer reports "my drafts aren't firing",
  support goes here first.

---

# 7. Couple portal — `/_couple-pages/*` (served via `/couple/[slug]/*`)

~40 pages, ~33k lines total. This is the couple-facing planning portal.
Every couple gets one when they register via event code.

**Universal external inputs across all couple pages:**
- Venue slug in URL (`/couple/[slug]/*`)
- Couple auth session (a 'couple' role user)
- Venue config (white-labeled colors, AI name, visible sections)
- File uploads (photos, inspo, contracts) → Supabase Storage

**Universal shell:** top bar (`CoupleTopBar`) with Ask {aiName} pill + dashboard + print + account. Left sidebar with section
navigation. Floating "Ask {aiName}" button (`FloatingSage`) on every
page.

Grouped by role:

## Shell / navigation

### `/_couple-pages/` (root — couple dashboard)

- **Purpose:** Couple's dashboard. Countdown to wedding, progress
  across every section, "next tasks", AI prompts.
- **External inputs:** `CouplePhotoPrompt` shows if no couple photo
  uploaded yet (file upload flow).
- **Surface:** Hero with countdown, guest summary, budget summary,
  checklist progress, timeline snapshot, upcoming tasks, Ask-AI CTA.
- **User actions:** Navigate into any section, ask AI inline.
- **Value:** A wedding portal that actually loads in one glance. Not
  a 50-page Notion doc.

### `/_couple-pages/login`

- **Purpose:** Couple-specific login (separate from coordinator login).
- **External inputs:** Email/password.
- **Surface:** Simple form.
- **User actions:** Sign in → redirected to their couple portal root.

### `/_couple-pages/getting-started`

- **Purpose:** Onboarding checklist for newly-registered couples.
  Action cards ("upload couple photo", "say hi to {aiName}", etc.)
  + weekly-bucket tips.
- **External inputs:** None external; tracks completion via state.
- **Surface:** Progress cards + tip lists (pre-52 weeks, 26-51, etc.).
- **User actions:** Click through to each action.
- **Value:** First-impression orientation for an overwhelmed couple.
  Reduces "I don't know where to start" bounce.
- **Critical take:** Hardened this session — `replace('Sage',aiName)`
  → `replaceAll(...)` for multi-occurrence safety.

### `/_couple-pages/chat`

- **Purpose:** The couple's primary AI interaction. Sage chat with
  context of their wedding, venue, past conversations, contracts,
  vendor list.
- **External inputs:** `POST /api/couple/sage` (or similar) with
  message → Claude call, streams response. File upload for contract
  reference.
- **Surface:** ChatGPT-style thread. Message history, typing indicator,
  confidence warnings, contract reference chips.
- **User actions:** Type questions, attach contracts, ask follow-ups.
- **Value:** The couple's planning co-pilot. "What time should we
  serve dinner?" gets a venue-specific answer in 3 seconds.
- **Critical take:**
  - Heavy dependency on venue KB + voice-training quality. A venue
    with a thin KB produces generic Sage responses.
  - Low-confidence responses shown with indicator — good transparency.

### `/_couple-pages/messages`

- **Purpose:** Direct chat with coordinator (distinct from Sage AI).
- **External inputs:** None external; server-side messaging.
- **Surface:** Thread with coordinator. Message list + input.
- **User actions:** Send message, mark read.
- **Value:** Human-in-the-loop channel. Couple needs it when Sage
  can't answer and they need the coordinator.

### `/_couple-pages/resources`

- **Purpose:** Venue-provided resources (PDFs, vendor kit, floor
  plans, welcome guide).
- **External inputs:** File downloads from Supabase Storage.
- **Surface:** Link / file list.
- **User actions:** Download.

### `/_couple-pages/downloads`

- **Purpose:** Per-wedding downloads (final seating chart, timeline
  PDF, vendor list).
- **External inputs:** File downloads.
- **Surface:** List of generated PDFs.

### `/_couple-pages/final-review`

- **Purpose:** Pre-wedding final review. Walks the couple through all
  sections to confirm everything's set.
- **External inputs:** None external.
- **Surface:** Checklist of sections with completion indicators.
- **User actions:** Mark each reviewed.
- **Value:** Last-mile sanity check. Prevents wedding-day surprises.

### `/_couple-pages/worksheets`

- **Purpose:** Structured worksheets for specific tasks (seating puzzle,
  shot list, vows prompts).
- **External inputs:** None external.
- **Surface:** Printable worksheet templates.

## Wedding basics

### `/_couple-pages/wedding-details`

- **Purpose:** Core event details — ceremony start, reception end,
  dinner type, music preferences.
- **External inputs:** Form fields.
- **Surface:** Form keyed to venue's `wedding-details-config` (fields
  vary by venue).
- **User actions:** Fill out, save.

### `/_couple-pages/booking`

- **Purpose:** Booking summary — date, package, rate, payment status.
- **External inputs:** None.
- **Surface:** Read-mostly summary.

### `/_couple-pages/couple-photo`

- **Purpose:** Upload the couple's headshot photo — used throughout
  venue's view ("put faces to names").
- **External inputs:** File upload → Supabase Storage.
- **Surface:** Drop-zone + preview.
- **User actions:** Upload / replace.

### `/_couple-pages/contracts`

- **Purpose:** Contract library — venue contract, vendor contracts.
  Couple uploads, Sage can reference in chat.
- **External inputs:** File uploads; `POST /api/couple/contracts` (or
  similar) for upload; possibly Ask-Sage-about-contract action.
- **Surface:** File list + upload + Ask {aiName} button per contract.
- **User actions:** Upload contracts, ask Sage questions about them.
- **Value:** Central contract repo. Makes the "what did I sign?"
  moment answerable.
- **Critical take:** Uses `aiName` everywhere, verified white-label.

## Guests

### `/_couple-pages/guests` (2068 lines — one of the biggest)

- **Purpose:** Full guest list management. Names, emails, table assignments,
  RSVP status, dietary needs, +1 tracking.
- **External inputs:** Form + CSV import.
- **Surface:** Filterable, sortable table with inline editing. RSVP
  status chips. Bulk actions.
- **User actions:** Add/edit/delete guests, bulk import, export,
  assign to tables, track RSVP.
- **Value:** Single source of truth for who's coming. Feeds seating +
  catering.

### `/_couple-pages/seating`, `/tables`, `/table-map`

- **Purpose:** Seating assignment. Three related tools:
  - `/seating` — assign guests to tables (list-based)
  - `/tables` — manage table definitions (size, shape, names)
  - `/table-map` — canvas-based drag seating
- **External inputs:** Canvas interactions for map; form for others.
- **Value:** Different couples prefer different approaches (list vs
  visual). Having all three covers ergonomic preferences.
- **Critical take:** Three pages for one domain concept is likely
  too many. Could collapse to one tool with tabs.

### `/_couple-pages/rsvp-settings`

- **Purpose:** Configure the couple's public RSVP page (via /w/[slug]).
  Cutoff date, meal choices, song requests, accommodations.
- **External inputs:** Form.
- **Surface:** RSVP config + preview.
- **Value:** Couples get a branded RSVP website from the venue.

### `/_couple-pages/ceremony-chairs`

- **Purpose:** Ceremony seating — chair count, layout (rows, aisle),
  reserved sections.
- **External inputs:** Form + visual layout.
- **Surface:** Configurable chair diagram.

## Event flow

### `/_couple-pages/timeline` (2420 lines — LARGEST couple page)

- **Purpose:** Master wedding-day timeline. Ceremony, cocktail,
  dinner, dances, departure. Vendor arrival times. Minute-by-minute.
- **External inputs:** None external.
- **Surface:** Draggable timeline grid. Event blocks with per-event
  notes, vendor assignments, responsible party.
- **User actions:** Add/move/edit events, assign vendors.
- **Value:** THE day-of reference. A well-built timeline means the
  wedding runs itself.
- **Critical take:**
  - 2420 lines is enormous. Drag-and-drop + multi-track timelines are
    inherently complex but still an outlier.

### `/_couple-pages/checklist`

- **Purpose:** Couple's task checklist. From venue template +
  custom additions.
- **External inputs:** None external.
- **Surface:** Categorized checklist with due dates, completion, notes.
- **User actions:** Check off tasks, add custom, reassign.

### `/_couple-pages/ceremony`, `/rehearsal`, `/party`

- **Purpose:** Config for each event block.
  - `ceremony` — ceremony type, order of service, officiant
  - `rehearsal` — rehearsal slot + dinner
  - `party` — reception program
- **External inputs:** Forms.
- **Value:** Couple sets the event details once, coordinator sees them
  in their Day-of Package.

## Vendors / inspiration

### `/_couple-pages/vendors`

- **Purpose:** Couple's own vendor list (beyond venue's recommendations).
  DJ, photographer, florist, officiant. Contact info + contracts.
- **External inputs:** Form fields.
- **Surface:** Per-vendor card grid.

### `/_couple-pages/preferred-vendors`

- **Purpose:** Venue's recommended vendors list (READ-only from venue
  config). Couple picks from here to add to their own vendor list.
- **External inputs:** Form click to add.
- **Surface:** Category-grouped cards.
- **Value:** Venue gets referral credit (implicitly); couple saves
  time on vendor hunt.

### `/_couple-pages/inspo`

- **Purpose:** Inspiration photo upload. Couple curates their vision
  board.
- **External inputs:** File uploads.
- **Surface:** Photo grid + per-photo notes.

### `/_couple-pages/picks`

- **Purpose:** Decor / style picks from a predefined venue catalog.
  (arches, linens, lighting — pick what you want).
- **External inputs:** Click to select from venue's decor-config.
- **Surface:** Category-grouped select + "your picks" summary.

### `/_couple-pages/photos`

- **Purpose:** Photo shot list for the photographer. Family combos,
  must-haves, wedding-party combos.
- **External inputs:** Form.
- **Surface:** Category-grouped list.

## Venue services

### `/_couple-pages/availability`

- **Purpose:** What's available on the couple's wedding date — rooms,
  vendors, etc. Read-mostly.
- **External inputs:** None direct.
- **Surface:** Availability summary.

### `/_couple-pages/bar` (1721 lines — HUGE)

- **Purpose:** Bar/beverage planning. Package selection, guest-specific
  drinks, signature cocktails, alcohol quantities, bartender staffing.
- **External inputs:** Form.
- **Surface:** Deep bar config with cost estimates.
- **Value:** Bar is historically where couples underestimate cost.
  Explicit calculator saves $$ errors.

### `/_couple-pages/rooms`

- **Purpose:** Reserve on-site rooms (suites, cottages) for the couple
  + wedding party + family.
- **External inputs:** Form + check venue rooms-config.
- **Surface:** Rooms list with assignment UI.

### `/_couple-pages/stays`

- **Purpose:** Off-site accommodations (hotels) for guests. Venue's
  partner hotels + room blocks. Couple shares with guests.
- **External inputs:** Form.

### `/_couple-pages/transportation`

- **Purpose:** Transportation planning. Couple's car, vendor vehicles,
  shuttle for guests.
- **External inputs:** Form.
- **Surface:** Multi-track schedule.

### `/_couple-pages/staffing`

- **Purpose:** Wedding-party staffing — who's in the bridal party,
  who's officiating, who's DJing, etc.
- **External inputs:** Form.

### `/_couple-pages/guest-care`

- **Purpose:** Guest-care details — accessibility, elderly transport,
  kid-friendly meals.
- **External inputs:** Form.

### `/_couple-pages/allergies`

- **Purpose:** Allergy + dietary restriction tracking. Per-guest.
- **External inputs:** Form.
- **Surface:** Per-guest allergy rows + summary.
- **Value:** Catering + kitchen brief is built from this.

### `/_couple-pages/venue-inventory`

- **Purpose:** Items the venue provides vs. items the couple brings.
- **External inputs:** Form.

## Appearance / output

### `/_couple-pages/decor`

- **Purpose:** Decor plan — arches, florals, linens, signage.
- **External inputs:** Form + photo uploads.

### `/_couple-pages/beauty`

- **Purpose:** Hair & makeup schedule + vendor.
- **External inputs:** Form.

### `/_couple-pages/website`

- **Purpose:** Configure the public wedding website at /w/[slug]. Hero
  photo, story, rsvp, schedule, travel, registry.
- **External inputs:** File uploads for hero, form for content.
- **Surface:** Website editor + preview.
- **Value:** Couple doesn't need to pay for Zola/Minted — gets a
  venue-branded wedding site free.

### `/_couple-pages/budget`

- **Purpose:** Budget tracking. Categories, budgeted vs committed vs
  paid. Vendor-level line items.
- **External inputs:** Form.
- **Surface:** Categorized budget with totals.
- **Value:** The "are we on track?" math.

---

**Critical take on the couple portal as a whole:**

- **Strengths:**
  - White-labeled per venue (aiName, colors, visible sections). Venue
    brand is preserved end-to-end.
  - Sage chat is the unique feature no other wedding planner offers.
  - The Day-of Package print export is useful + tangible.

- **Weaknesses:**
  - 40+ pages is an enormous feature set. Most couples will only
    touch 10-15. Discoverability requires either a strong onboarding
    or Sage proactively prompting them.
  - Overlap across seating/tables/table-map; rooms/stays. Could
    consolidate.
  - Timeline (2420 lines) + guests (2068) + bar (1721) + transportation
    (1325) are behemoth pages. Maintenance debt.
  - Brain-dump queue exists on coordinator side; no equivalent on
    couple side for "I want to tell Sage something I noticed but don't
    know where it fits."

---

# 8. Public-facing pages

These are the pages reachable without any auth or couple-portal session.
They're how Bloom-powered venues expose themselves to the open web.

## `/w/[slug]` — Public wedding website

- **Purpose:** The couple's wedding website. Publicly accessible by URL
  (no login). Contains story, schedule, venue info, travel, RSVP,
  registry, photo gallery.
- **External inputs:**
  - Slug in URL
  - Public RSVP form submissions (written to rsvp table)
  - Guest search (guest finds their name by partial match)
- **Surface:** Theme-templated site (classic / modern / garden / romantic
  / rustic). Hero banner with couple names + date + venue. Section
  anchors: story, schedule, travel, gifts, FAQs, RSVP.
- **User actions:**
  - Read content, view photos
  - Search for their name in guest list
  - Submit RSVP (meal choice, song requests, plus-one info)
  - External links (registry, Google Maps, hotel blocks)
- **Value:** Free branded wedding site. Competing products (Zola /
  Minted) charge for this. Bonus: sections are configured from the
  couple's venue portal, so the venue's brand is preserved.
- **Critical take:**
  - 1774 lines — theme-switching UI is complex but enumerable.
  - No back-end validation I can see from the client code that the
    RSVP form token matches the couple. If a spammer guesses a slug,
    could they spam the RSVP table? Rate-limited probably, but worth
    confirming server-side.
  - Guest search by name is a cute UX but also a PII leak surface
    — a stranger could enumerate attendees by trying names.

## `/vendor/[token]` — Vendor self-service (token-gated)

- **Purpose:** Vendors update their own contact info / arrival time /
  notes via a token-link sent by the coordinator. No login — the token
  IS the auth.
- **External inputs:**
  - Token in URL
  - Form field updates
- **Surface:** Form with vendor details.
- **User actions:** Update their own fields, save.
- **Value:** Coordinator doesn't chase vendors for arrival times. Vendor
  self-serves.
- **Critical take:**
  - Token is long-lived — once shared in a Slack DM it's permanent until
    rotated. No rotation UI visible.
  - Only 150 lines — minimal. The newer replacement for `/vendor-portal/[token]`?

## `/vendor-portal/[token]` — Legacy vendor portal

- **Purpose:** Older / richer vendor portal with more data. Probably
  being replaced by `/vendor/[token]`.
- **External inputs:** `GET /api/public/vendor-portal`.
- **Surface:** Fuller vendor view — their role in the wedding, contact
  info, arrival time, notes from coordinator.
- **User actions:** View + edit limited fields.
- **Critical take:**
  - 474 lines vs 150 for `/vendor/[token]` — the two paths coexisting
    is a refactor in progress. Worth confirming which one is canonical.

## `/preview/[slug]` — Public venue preview (with Sage chat)

- **Purpose:** Public-facing venue preview for prospects who haven't
  inquired yet. Features a "try chatting with Sage" widget — prospects
  can ask questions and see the AI answer before any commitment.
- **External inputs:**
  - Slug in URL
  - `POST /api/public/sage-preview` — anonymous Sage chat
    (rate-limited, max-message cap so prospects can't abuse).
- **Surface:** Venue hero + brief info + chat widget (limited messages).
- **User actions:** Read, chat with Sage, click through to tour-booking
  link.
- **Value:** **Top-of-funnel demo.** A prospect on Knot clicks a
  "chat with our AI assistant" link, sees Sage in action, books a tour.
  Turns the AI from an internal tool into a lead-generation channel.
- **Critical take:**
  - Rate limit + max-message cap are critical — without them, Claude
    costs go exponential from bots. Verify both are tight.
  - If preview/tourBookingUrl isn't set on the venue, the CTA is a
    dead link.

## `/couple/[slug]/register` — Couple event-code registration

- **Purpose:** The OTHER end of the couple invite flow. Coordinator
  invites from /portal, sends an event code (e.g., "HM-0042"). Couple
  visits `/couple/<venue-slug>/register`, enters their event code +
  email + password. That creates the couple auth user + links them to
  their wedding.
- **External inputs:**
  - Venue slug in URL
  - Event code from form
  - `POST /api/couple/register` — creates user, marks
    `weddings.couple_registered_at`, returns session
- **Surface:** Form: event code, email, password.
- **User actions:** Register → redirected into couple portal.
- **Value:** Secure but simple onboarding. No email-verification link
  required (event code is the verifier).
- **Critical take:**
  - Event code is the auth factor. If a wedding's code leaks, a
    stranger could register as that couple. Code is short (e.g., HM-042)
    — relies on low probability of correct guess. A brute-force attacker
    would get blocked by rate limits (verify).
  - One-time use: `couple_registered_at` timestamp prevents re-registration.
  - No "forgot event code" flow visible — if the couple loses the code,
    coordinator has to dig up `weddings.event_code` manually.

---

# Cross-cutting findings

## External data touchpoints — the complete list

Every page that hits an external service or takes user-uploaded
data (not Supabase reads):

| Surface | External source | Purpose |
|---|---|---|
| /signup | Supabase Auth email verification (if enabled) | Account creation |
| /login | Supabase Auth password check | Sign in |
| /forgot-password | Supabase Auth email (reset link) | Password reset |
| /reset-password | Supabase Auth token (from email) | Complete reset |
| /demo | document.cookie + Supabase sign-out | Demo session |
| /pricing | Stripe Checkout redirect | Billing |
| /join | `GET /api/team/accept` (validates token) | Team invite |
| /onboarding | Gmail OAuth (Google) + Claude (test draft) | New venue setup |
| /setup | `POST /api/team/invite` (emails invitation) | Team seeding |
| /agent/inbox | Gmail API via `/api/agent/send`, `/api/agent/reply` | Send emails |
| /agent/drafts | Claude (regenerate), Gmail (send) | Draft review |
| /agent/settings | Gmail OAuth (connect) | Inbox pairing |
| /intel/market-pulse | SerpAPI, NOAA, FRED (all cron-synced) | External intel |
| /intel/trends | SerpAPI (via trends cron) | Search trends |
| /intel/reviews | CSV / image uploads for reviews | Review aggregation |
| /intel/tours | Claude (transcript extraction + brief gen) | Tour follow-up |
| /intel/nlq | Claude (natural-language → SQL) | NLQ |
| /intel/reach | Brain-dump image uploads (analytics screenshots) | Marketing reach |
| /portal/weddings | `POST /api/portal/invite-couple` (email) | Invite couple |
| /portal/messages | Couple ↔ coordinator messages | Human channel |
| /portal/quick-add | Pasted text / CSV | Bulk import |
| /portal/kb | CSV import | Bulk FAQ seed |
| /settings/billing | Stripe Customer Portal redirect | Self-serve billing |
| /settings/team | `POST /api/team/invite` | Team growth |
| /settings/omi | Omi wearable webhook (pairing) | Transcription source |
| /_couple-pages/chat | Claude (Sage chat) | Couple AI |
| /_couple-pages/contracts | File uploads | Contract repo |
| /_couple-pages/couple-photo | File upload | Profile photo |
| /_couple-pages/inspo | File uploads | Vision board |
| /_couple-pages/photos | File uploads | Shot list |
| /_couple-pages/decor | File uploads | Decor moodboard |
| /_couple-pages/website | File upload (hero) | Website builder |
| /w/[slug] | RSVP form from open web (public) | Guest response |
| /vendor/[token] | Vendor self-service form | Vendor info |
| /vendor-portal/[token] | Token auth + vendor form | Vendor portal |
| /preview/[slug] | Public Sage chat (rate-limited) | Lead gen |
| /couple/[slug]/register | Event code + account creation | Couple onboarding |

## Scope problems I'd flag

1. **Sprawl** — 160 pages. Most venues use ~30. The rest is either
   niche (Omi) or one-time setup (/setup, /onboarding) or power-user
   territory (/intel/nlq, /super-admin). Onboarding should surface the
   30 that matter.

2. **Overlap** — `/intel/clients` and `/portal/weddings` are TWO lists
   of every wedding. `/agent/analytics` and `/intel/roi` are TWO views
   of similar stats. `/seating`, `/tables`, `/table-map` are THREE
   tools for one concept. Consolidation would reduce maintenance + user
   confusion.

3. **Maintenance-heavy pages** — files > 1500 lines: agent/inbox (1599),
   agent/rules (1267), agent/sequences (1198), agent/settings (1051),
   agent/learning (1237), agent/notifications (953), intel/tours
   (1239), intel/sources (1027), intel/market-pulse (2261), portal/
   weddings (1242), portal/kb (932), portal/weddings/[id] (2342),
   portal/quick-add (1399), couple timeline (2420), couple guests
   (2068), couple bar (1721), couple transportation (1325), couple
   tables (1302), couple website (1091), couple rehearsal (1096),
   couple rooms (983), couple checklist (837), w/[slug] (1774).

4. **Page-level external dependencies that silently fail** — /intel/
   market-pulse depends on SerpAPI/NOAA/FRED; if any key is bad, the
   page looks empty without a "your integration is broken" banner.

5. **Pages behind feature/role gates without clear UX** — /super-admin,
   /super-admin/pipeline-health, /settings/groups, /agent/omi-inbox
   hide from users who don't have access. But there's no "learn more
   about this feature" path — they just don't see the nav item.

6. **No "search the whole app"** — coordinator hunting for "bar config"
   has to remember whether it's in Settings, Portal, or Agent. A
   command palette (Cmd-K) would save time.

## Surfaces that are GENUINELY unique

The pages that differentiate Bloom from HoneyBook / Dubsado / Aisle
Planner:

- **`/preview/[slug]` with Sage chat** — no other wedding platform
  offers a public AI that can answer venue-specific questions to
  prospects without a login.
- **`/intel/market-pulse` + `/intel/trends`** — weather + search-
  trend + econ + census, cross-referenced. No competitor ingests
  this breadth.
- **`/intel/nlq`** — natural-language SQL for venue data. Democratizes
  analytics.
- **`/intel/matching` (F1 signal-pair)** — cross-channel identity
  resolution. "Your Instagram follower + Knot inquirer + website
  visitor are the same person." Unique.
- **`/_couple-pages/chat` (Sage)** — venue-specific AI trained on the
  venue's KB + voice. Other couples get generic chatbots; Bloom
  couples get a venue-specific one.
- **`/intel/voice-dna`** — learned venue voice, visible + tunable.
- **`/agent/learning` games** — gamified voice training.

These ~7 surfaces are the moat. Everything else is table stakes that
every wedding platform has.








