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


