# IDENTITY-FIRST ARCHITECTURE — MIGRATION BRIEF v3

**Status:** New doctrine, revision 3 (2026-05-14). Supersedes inquiry-first data foundation across T0–T4. Wins over BLOOM-PLAYBOOK.md and bloom-constitution.md on identity, lifecycle, and touchpoint handling until those are rewritten to absorb it.

**Audience:** Three readers must succeed:
1. An engineer implementing this (Claude Code or human).
2. A venue owner onboarding to Bloom for the first time. Call her Susan.
3. Future-me reviewing the work to catch shortcuts.

**Reading instructions:** Every operational section bundles four parts in this order: **Doctrine** (the rule), **Build** (concrete spec), **Don't skip** (the corner I will be tempted to cut, and the test that proves I didn't), **Susan** (what she sees, does, or trusts here). Read all four for the section you're implementing.

**Changes from v2:** Onboarding reframed as the center of gravity, with Forwards Linker explicitly asymmetric to Backwards Tracer. Matcher algorithm specified (hybrid structured signals + LLM judge). Schema, concurrency, indexes, and RLS made concrete. Anti-shortcut guards added inline. Susan's experience scripted, with the full narrative in Appendix A. Stop conditions in Appendix B.

---

## 0. WHY THIS EXISTS

### Doctrine

Bloom currently treats the inquiry as the primary entity. T0 = form submission. Heat scoring, decay detection, source attribution, voice DNA, and the entire intelligence layer key off inquiry rows. Every couple is reduced to a row in an inquiries table.

This is wrong. Inquiries are the noisiest entity in the venue data exhaust: bots, spam, duplicates, typos, partial names, planners-on-behalf, parents-on-behalf, multi-email same-couple. Meanwhile the venue's highest-trust entities (booked clients in HoneyBook) sit outside the intelligence layer with full identity.

The new architecture inverts this. Bloom's data foundation is the couple, not the inquiry. Couples are discovered by walking from known ground truth (bookings, attended tours, confirmed Calendly events) outward into the messy upstream signal, resolving identity backward through every touchpoint Bloom can find.

**The couple is the unit of intelligence. Inquiries are signal, not entities.**

### Why inversion, not a layer on top

A defensible alternative is to keep inquiry-as-row and add an identity-resolution layer that derives Person records on top. Strictly less invasive. We reject that path because every intelligence feature would still be inquiry-keyed under the hood, leaking the noisy entity into every join and every metric. The seam between "real entity" and "computed entity" would surface in every product UI, including the journey ribbon. The inversion is more expensive once and cheaper forever.

### Onboarding is the center of gravity

The hard problem is onboarding: reconstructing a venue's history from messy archival data so that on Day 1 the venue sees their business as a graph of human relationships, not a list of inquiries. Live inbound after Day 1 is comparatively easy: emails arrive with full identity, Calendly bookings carry name and email, contracts attach to known Persons. The Backwards Tracer carries 80% of the architectural ambition. The Forwards Linker is a thin attach-or-create layer with full entity-class machinery reserved for the partial-identity channels (Knot, Instagram, anonymous web) that never get easier.

---

## 1. THE ENTITY MODEL

### Doctrine

Six entity classes. Promotion is unidirectional unless explicit operator action says otherwise.

| Class | Definition | Where surfaced |
|---|---|---|
| **Fragment** | Touchpoint with insufficient identity to anchor to any specific human | Aggregate counts only, never individually |
| **Channel-Scoped Person** | Confirmed real human within one channel via 2+ engagement actions; not bridged cross-channel | That channel's view only |
| **Person (Resolved)** | The couple. Full primary contact name plus one of: partner name, email, phone, unique context | Primary operator surfaces |
| **Agent** | Real human acting on behalf of one or more couples (planner, parent, coordinator) | Operator surfaces, separate from couple list |
| **Ghost** | Person past decay window with no real progression. Hashed identifiers preserved | Macro intel only, drill-down from aggregates |
| **Booked Person** | Person with signed contract. Never decays. Alumni | Booked clients view |

One Person record represents the couple, not an individual. Both partners attach via primary_contact and partner_contact. Name changes and partner emails merge into the couple-Person.

Agents are a separate class because they have higher value than most single-couple Persons (a planner with 12 weddings a year), and reducing them to Fragments destroys that signal.

### Build

```sql
-- Core entity table
persons (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  primary_contact_name text not null,
  primary_contact_email text,
  primary_contact_phone text,
  partner_contact_name text,
  partner_contact_email text,
  partner_contact_phone text,
  wedding_date date,
  lifecycle_state text not null check (lifecycle_state in (
    'channel_scoped','resolved','booked','ghost','agent'
  )),
  channel_scope text, -- which channel for channel_scoped state
  decay_window_days int not null default 180,
  last_progression_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Agent → Person link (one Agent represents many Persons)
agent_person_links (
  agent_id uuid references persons(id) on delete cascade,
  person_id uuid references persons(id) on delete cascade,
  established_at timestamptz default now(),
  source text not null,  -- 'self_identified' | 'multi_couple_inferred' | 'operator_confirmed'
  primary key (agent_id, person_id),
  check (agent_id <> person_id)
);

-- Unified touchpoint table
touchpoints (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  person_id uuid references persons(id) on delete set null,
  agent_id uuid references persons(id) on delete set null,
  channel text not null, -- 'gmail' | 'knot' | 'calendly' | 'instagram' | 'sms' | 'web' | 'honeybook'
  signal_tier text not null check (signal_tier in (
    'highest','high','medium_high','medium','low','aggregate_only'
  )),
  action_type text not null,
  external_id text not null, -- channel-specific dedup key
  occurred_at timestamptz not null,
  confidence_tier text check (confidence_tier in ('high','medium','low')),
  raw_payload jsonb,
  unique (channel, external_id)
);

-- Fragments (unanchored touchpoints)
fragments (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  channel text not null,
  identity_hint text, -- 'Sarah R.', '@sarahross', null
  external_id text not null,
  occurred_at timestamptz not null,
  raw_payload jsonb,
  promoted_to_person_id uuid references persons(id) on delete set null,
  promoted_at timestamptz,
  unique (channel, external_id)
);

-- Merge / unmerge audit
person_merge_events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null,
  event_type text not null check (event_type in (
    'fragment_promoted','channel_scoped_bridged','candidate_confirmed',
    'candidate_rejected','manual_merge','manual_unmerge','resurrection',
    'resurrection_rejected'
  )),
  primary_person_id uuid references persons(id) on delete set null,
  secondary_person_id uuid references persons(id) on delete set null,
  operator_id uuid,
  rule_triggered text,
  confidence_tier text,
  reason text,
  occurred_at timestamptz default now()
);
```

Indexes required:
- `persons (venue_id, lifecycle_state)` for list views
- `persons (venue_id, primary_contact_email)` and `(venue_id, partner_contact_email)` for Linker lookups
- `persons (venue_id, primary_contact_phone)` and `(venue_id, partner_contact_phone)` similarly
- `touchpoints (person_id, occurred_at desc)` for ribbon rendering
- `touchpoints (venue_id, channel, external_id)` for idempotent inserts
- `fragments (venue_id, channel, identity_hint, occurred_at)` for promotion scans
- GIN on `touchpoints.raw_payload` for ad-hoc inspection

RLS:
- All five tables RLS-enabled, venue_id-scoped, mirroring existing `interactions` policy
- `auth.uid()` membership check via `venue_members` (existing pattern)
- Demo-anon read policies if applicable, gated by `is_demo_company()` (existing pattern, see migration 064)

### Don't skip

The schema is the single most likely place I cut corners. Specifically:
1. **Indexes.** I will create the tables and skip the indexes, and the first Tracer run will time out. The indexes above are not optional.
2. **RLS.** I will write policies but forget the demo-anon variants. Migration 056 footgun applies. Reference the 056 footgun memory and demo-RLS memory before merging.
3. **Foreign key cascade behavior.** Wrong cascade behavior on unmerge corrupts the audit trail. The spec above uses `on delete set null` for touchpoint → person, never `cascade`, because deleting a Person must not orphan its touchpoints.
4. **Unique constraints.** `(channel, external_id)` on touchpoints and fragments prevents Tracer reruns from duplicating ingest. Without these, every Tracer rerun balloons the table.

Gate before merging Phase A: a migration test that runs Phase A migration twice in a row and verifies no row duplication, plus RLS smoke test verifying venue isolation and demo-anon read paths.

### Susan

Susan never sees the entity-class names. The product UI translates:
- "Person (Resolved)" → "Couple"
- "Channel-Scoped Person" → "Lead on [The Knot / Instagram]"
- "Agent" → "Planner" or "Family contact"
- "Ghost" → does not appear in her primary surfaces. Shows up only in macro intel as aggregate counts and in resurrection notifications.
- "Fragment" → does not appear at all. Aggregated as "184 anonymous saves this month."

---

## 2. PROMOTION RULES

### Doctrine

**Fragment → Channel-Scoped Person:** two engagement signals on the same channel sharing the same identity hint within a reasonable window.

**Fragment → Person (skip Channel-Scoped):** a single high-confidence event arrives with full identity. Calendly with email, inquiry form with partner-name-or-email-or-phone, contract, tour check-in, email reply with signature.

**Channel-Scoped Person → Resolved Person:** a cross-channel bridge event. Knot Channel-Scoped matches by name plus temporal proximity to a Calendly booking. Instagram DM revealing email. Same name on Knot Message and inbound form within 72 hours.

**Promotion to Agent:** explicit self-identification, multi-couple linking observed over time, signature with planner title, or operator confirmation.

**Ghost → Resurrected Person:** hashed identifier matches new inbound signal. Surfaces as candidate, not silent revival. Operator confirms or rejects.

**Fragments never resurrect.** Identity was never sufficient to confidently be the same entity returning.

### Build

The matcher is a hybrid: deterministic structured-signal scoring for the easy cases, Sonnet judge for the hard cases. Never pure-LLM (too slow, too expensive at Tracer scale) and never pure-heuristic (misses real matches).

**Structured signal scoring:**

```typescript
// scoring is on the candidate match between two records (e.g., Fragment + Person)
type SignalScore = {
  email_exact_match: 100,
  phone_exact_match: 100,
  partner_email_match: 95,
  full_name_exact_match: 60,
  first_name_match_plus_last_initial: 25,
  name_levenshtein_within_2: 40,
  wedding_date_within_30d: 30,
  same_ip_in_session: 20,
  same_browser_fingerprint: 25,
  cross_channel_temporal_match_lt_6h: 35,
  cross_channel_temporal_match_lt_48h: 20,
  cross_channel_temporal_match_lt_2w: 10,
};

// summed score determines tier
// 100+ → high (auto-promote on Tracer, auto-attach on Linker)
// 60-99 → medium (surface candidate for operator confirm)
// 30-59 → low (surface only on operator request, store as related)
// <30 → below threshold (do not surface, store as unlinked)
```

**LLM judge:** invoked when structured score is 40-90 (the ambiguous middle). One Sonnet call per candidate with full context (both records' touchpoint histories, surrounding emails, source channel). Returns a tier (high / medium / low / reject) plus reasoning. The reasoning is stored in `person_merge_events.reason` for audit.

LLM judge is rate-limited per venue per day to cap cost. Default budget: 200 judge calls per Tracer run, 50 per day in steady state. Beyond budget, ambiguous candidates fall to manual review queue.

### Don't skip

1. **The LLM judge prompt.** I will write a one-shot prompt and ship it. The prompt needs structured output (tier + reasoning), few-shot examples drawn from real Rixey data, and explicit "when uncertain, return medium" framing. Reference the unified classifier doctrine: LLM judges, structured signals decide.
2. **Calibration loop.** I will skip wiring confirm/reject events back to the scoring weights. Then thresholds stay static forever. The loop must write to `person_merge_events` and a periodic job recomputes per-venue tier thresholds when N>=100 confirmed/rejected events exist.
3. **Pure-heuristic shortcut.** I will be tempted to skip the LLM judge entirely and ship structured scoring only. That ships a faster system that misses real matches in the 40-90 zone, which is the zone that matters most for the holy-shit moment. Don't skip.

Gate before merging matcher: 50 hand-labeled candidate pairs from Rixey historical data with expected tier. Matcher must hit 90% agreement before shipping.

### Susan

Susan sees promotion as "we found a possible match" notifications. Examples:
- "Sarah & Mike (booked May 2025) matched to a Knot lead from January 2025. Confirm?"
- "Madeline E. on The Knot looks like the same person as madeline.evans@gmail.com who replied yesterday. Confirm?"

Each notification has one-click Confirm / Reject / Not Sure. "Not Sure" defers the decision and keeps both records separate until more signal arrives.

---

## 3. THE LIFECYCLE CLOCK

### Doctrine

Persons decay to Ghosts after **180 days** of no real progression by default. Tunable downward per venue once observed sales-cycle length is established. Never below 90.

Rationale for 180: Knot data shows individuals shopping over 33+ days within one channel alone. High-end venue sales cycles regularly hit 6-12 months. 90-day default kills living couples.

**Real progression** (resets the clock):
- Replied to a venue email
- Booked, rescheduled, or attended a tour
- Sent an inquiry via a new channel (cross-channel match)
- Opened a portal link (verified click, not just open)
- Signed a contract
- Sent a follow-up question via any inbound channel
- Was matched against a returning Fragment that promoted them

**Not progression:**
- Venue sent them a marketing email
- Venue logged a manual "follow-up sent" note
- They appeared in a passive bulk dump (Knot CSV refresh, GA4 cookie)
- They opened (but did not click) an email
- They appeared in an audience-level metric

The clock measures the couple's progression, not the venue's outbound effort.

### Build

```sql
-- progression event log (write-once, audit)
person_progression_events (
  person_id uuid references persons(id) on delete cascade,
  occurred_at timestamptz not null,
  event_type text not null check (event_type in (
    'email_reply','tour_booked','tour_rescheduled','tour_attended',
    'new_channel_inquiry','portal_click','contract_signed',
    'inbound_followup','fragment_match_returned'
  )),
  source_touchpoint_id uuid references touchpoints(id),
  primary key (person_id, occurred_at, event_type)
);

-- decay sweep runs nightly per venue
-- updates persons.lifecycle_state to 'ghost' where:
--   lifecycle_state in ('resolved','channel_scoped')
--   AND last_progression_at < now() - (decay_window_days * interval '1 day')
--   AND NOT EXISTS (select 1 from person_progression_events
--                   where person_id = persons.id
--                   and occurred_at > now() - (decay_window_days * interval '1 day'))
```

Decay sweep is a cron job, daily, idempotent, batched per venue.

### Don't skip

1. **Outbound activity resetting the clock.** I will be tempted to count "sent email to person" as progression because it's simpler. It's not. Only inbound events from the enumerated list count. The progression-event writer must not be wired from outbound code paths.
2. **The 180-day default.** I will be tempted to default to 90 because it matches existing decay code. Don't. 180.

Gate: a Tracer dry-run on Rixey data must produce a Ghost count consistent with operator expectation (no more than 10% of historically-booked couples should appear as Ghosts in a 12-month window).

### Susan

Susan sees lifecycle as **status pills** on the couple list:
- **Active** (live Person with recent progression)
- **Cooling** (live Person, no progression in 45+ days, decay tail visible)
- **Lost** (live Person, no progression in 120+ days, near death)
- **Past** (Ghost)
- **Booked** (Booked Person, never decays)

She never sees the 180-day number directly. She sees "no activity in 4 months."

---

## 4. THE TWO INGESTION PIPELINES (asymmetric)

### Doctrine

Bloom has two ingest pipelines that share one Person store, but **they are not symmetric.**

**Backwards Tracer** carries the architectural ambition. It runs at onboarding, on bulk CRM imports, on Knot CSV refresh, on Instagram dumps, and **on-demand whenever a new data source is connected** to an existing venue. Anchors on known ground truth (booked clients, completed events, confirmed tour attendees) and walks backward attaching touchpoints by name, email, phone, and temporal proximity.

**Forwards Linker** runs on every new inbound event after onboarding. For most channels (Gmail, Calendly, contracts, SMS with signature) it is a thin attach-or-create against the Person store: lookup by email/phone, attach if match, create new Person if not. For partial-identity channels (Knot, Instagram, anonymous web) it runs the full entity-class machinery (Fragment / Channel-Scoped Person promotion) at lower volume than Tracer.

**Cold-start mode:** venues with no ground-truth anchor (no HoneyBook, paper contracts, decade of unstructured Gmail) run Forwards Linker only until the operator manually identifies 5-10 booked couples to seed ground truth. Tracer becomes available after seed identification.

### Build

**Backwards Tracer architecture:**

```
1. Anchor discovery: pull booked clients from CRM (HoneyBook, Aisle Planner, etc.)
   → create Person records for each, lifecycle_state='booked'
2. Touchpoint sweep: for each connected channel, pull historical data
   → for each touchpoint, evaluate against existing Persons using matcher (§2)
   → high tier: attach silently
   → medium tier: attach with confidence_tier='medium', queue candidate review
   → low tier: store as fragment, link via fragments.promoted_to_person_id only if confirmed
3. Cross-channel coalescence: scan fragments for promotion candidates (§5)
4. Agent inference: scan for multi-couple identity patterns, propose Agent records
5. Decay sweep: mark Persons as Ghost where appropriate
6. Validation: emit per-venue metrics (Persons created, Fragments promoted, Ghosts created)
```

Tracer runs as a **Vercel cron-triggered background job** with checkpointing per stage. Each stage emits structured events to `tracer_run_events` table for operator-visible progress. Stage failures are recoverable: a restart resumes from last checkpoint, not from scratch.

**Forwards Linker architecture:**

```typescript
// For full-identity channels (Gmail, Calendly, SMS-with-sig, contract)
function linkInboundEvent(event: InboundEvent) {
  const person = await findPersonByIdentifier(event); // email/phone lookup
  if (person) {
    attachTouchpoint(person.id, event);
    maybeRecordProgression(person.id, event);
    maybeFlipLifecycleState(person.id);
  } else {
    const newPerson = createPerson(event);
    attachTouchpoint(newPerson.id, event);
  }
}

// For partial-identity channels (Knot, Instagram, anonymous web)
function linkPartialIdentityEvent(event: PartialEvent) {
  const fragment = createFragment(event);
  await tryPromoteFragment(fragment.id); // checks for sibling fragments, runs matcher
}
```

**Reconciliation between pipelines:**

```sql
-- Advisory lock for Person creation to prevent race
-- Locks namespace: hash of (venue_id, normalized_email_or_phone)
SELECT pg_try_advisory_xact_lock(hashtext(venue_id || ':' || identifier));
```

Tracer and Linker both acquire the advisory lock before creating a Person for a given identifier. If lock contention occurs, the loser re-reads the Person store and attaches to the existing Person.

Conflicting field values (Tracer finds older partner name, Linker has newer one) emit a `person_merge_events` row with `event_type='candidate_confirmed'` if the resolution rule is automatic (newer wins for partner_contact_name), or queue for operator review if not.

### Don't skip

1. **The advisory lock.** I will be tempted to skip it because "race conditions are rare." They will happen on the first Tracer-during-active-venue scenario and corrupt the Person store. Don't skip.
2. **Tracer checkpointing.** I will write Tracer as a single long-running function. It will time out, partial-write, and the rerun will duplicate work. Tracer must checkpoint per stage and per batch.
3. **The partial-identity channel machinery on Linker.** Now that the brief says Linker is simpler, I will be tempted to skip the full Fragment/Channel-Scoped machinery on the Linker side entirely. Knot and Instagram will lose the Channel-Scoped tier in steady state and degrade to "every Knot row = a new Person." Don't skip. Linker is simpler for full-identity channels only.
4. **Cold-start mode.** I will assume every venue has HoneyBook. They don't. The cold-start path must exist and be exercised in tests.

Gate: Tracer must be re-runnable end-to-end against the same venue's data and produce zero new rows on the second run.

### Susan

**Susan's Day 0 experience** depends on which mode applies:

**Standard mode (Susan has HoneyBook + Gmail + Calendly):**
1. OAuth connects: HoneyBook (30 sec), Gmail (30 sec), Calendly (30 sec)
2. Knot: she's prompted to upload a CSV export, with a 2-minute video showing how
3. Instagram: she's prompted to upload follower-list export, optional
4. "We're reconstructing your last 5 years of client history. This usually takes 4-8 hours. We'll email you when it's ready."
5. Live progress page shows: "Found 23 couples so far, processing Gmail (24% complete)..."
6. Email arrives when done: "Your business is ready to explore."

**Cold-start mode (Susan has paper contracts):**
1. OAuth connects what she has (Gmail, Calendly likely)
2. "We don't see a CRM. Let's start with your 5 most recent booked weddings. Enter the couple names and wedding dates."
3. After 5 seeded couples, Tracer becomes available and runs against the connected channels using those anchors.
4. The holy-shit moment is smaller on Day 1 (less historical reach) and grows over weeks as more couples seed.

Both modes: Susan never waits more than 5 seconds on a click. The 4-8 hour wait happens asynchronously with email notification on completion.

---

## 5. TEMPORAL COALESCENCE

### Doctrine

Couples shop in bursts. Fragments and identifying signals arriving within a tight temporal window on related dimensions can coalesce into a candidate Person.

Related dimensions (at least one required):
- Name similarity (first name match across channels)
- Behavioral fingerprint (same wedding date, guest count range, budget signal)
- Geographic signal (same IP, same metro)
- Session signal (anonymous calculator into named inquiry from same browser)
- Direct reference ("I saw you on The Knot" in email body)

Three discrete confidence tiers, no decimals (decimals invite fake precision):

| Window | Tier | Behavior |
|---|---|---|
| <6h with name + corroborating signal | High | Auto-coalesce |
| 6–48h with name + corroborating signal | Medium | Coalesce, surface confidence tag, one-click reject |
| 48h–2 weeks with name + corroborating | Low | Surface as candidate in review queue, do not auto-coalesce |
| >2 weeks, or name only without corroboration | Below threshold | Store as related-but-unlinked, do not surface |

Calibration loop: operator confirm/reject events on Medium and Low candidates feed rolling per-venue accuracy. After 100+ events, per-venue tier thresholds may be tuned.

### Build

Coalescence runs both at Tracer time (batch) and Linker time (per-event). The matcher from §2 is the same engine in both cases. Coalescence is the matcher's *application to fragment-pairs*, not a separate algorithm.

Candidate review queue is a table:

```sql
candidate_matches (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null,
  primary_record_id uuid not null,
  primary_record_type text check (primary_record_type in ('person','fragment','channel_scoped')),
  secondary_record_id uuid not null,
  secondary_record_type text,
  confidence_tier text not null,
  matcher_reason text,
  created_at timestamptz default now(),
  resolved_at timestamptz,
  resolution text check (resolution in ('confirmed','rejected','not_sure'))
);
```

Operator UI for review queue lives at `/intel/identity-review`. Notifications surface candidates inline on the relevant lead pages (passive surfacing), with a digest count in the nav.

### Don't skip

1. **Decimal confidence.** I will reach for a 0-1 float because it feels rigorous. It isn't. Three tiers.
2. **Passive surfacing.** I will build the review queue page and call it done. Susan won't visit it. Candidates must also appear inline on the lead detail and inline on the inbox where the relevant signal is, with a tiny dot or banner. Both surfaces required.
3. **The "Not Sure" option.** I will build Confirm/Reject and skip Not Sure. Operators need a defer option or they'll mash Reject to clear the queue.

Gate: candidate review queue page exists AND inline surfacing on lead detail AND inline surfacing on inbox before Phase B is declared complete.

### Susan

Susan rarely visits the review queue page directly. She sees candidates where she's already working:
- Opening a lead detail: small "1 possible match" chip near the name. Click to expand inline.
- Reading the inbox: a thread with a candidate-match flag shows a subtle banner.
- Daily digest email: "3 possible matches this week, click to review."

She has 10 minutes a day max for identity confirmation. The work has to be where she already is.

---

## 6. THE JOURNEY RIBBON

### Doctrine

Every Person profile renders as a single horizontal ribbon timeline. All touchpoints are dots, spaced proportionally to actual elapsed time. Touchpoint type encoded in icon shape or color. Confidence tier encoded in fill style: High = solid, Medium = ring, Low = dashed ring (hidden behind a toggle by default).

Density safety valve: auto-cluster adjacent touchpoints into burst markers with count badges ("12 touches in 48h"), expandable inline. Never rescale time logarithmically. Honesty about pace beats visual balance.

Ribbon is not decoration. Operators take action from it. Above every live ribbon: a top-line action chip based on Person state. "Reply now (last touch 8 days ago)" / "Offer tour" / "Send pricing" / "Re-engage" / "Refer to alumni." Hover any touchpoint to see source signal and a "Draft reply referencing this" action. Hover any gap to see silence duration and a "mark as cooling" affordance.

Bloom shows its work. Every heat score, source claim, or decay alert points back to a visible touchpoint location on this ribbon.

### Build

Component: `<JourneyRibbon person={person} touchpoints={touchpoints} />` rendered as SVG (not a list with timestamps, not a table).

Layout algorithm:
1. Compute total time span: earliest touchpoint to latest, with right-padding for live decay tail.
2. Map time to x-coordinate linearly. Width is responsive.
3. For each touchpoint, compute x-pixel. Check for overlap with prior touchpoints (within 6px). If overlap, cluster.
4. Render dots with icon-by-type and fill-by-confidence.
5. Render gap labels on hover only (avoid visual clutter).
6. Render action chip above ribbon, derived from Person state machine.

Performance: ribbons with >500 touchpoints (rare but possible for Rixey-class venues with 5 years history) must render under 200ms. Use virtualization for the touchpoint list backing the ribbon, but render the SVG fully (visual continuity matters more than DOM efficiency at this scale).

Data dependency: ribbon component reads from a view, not from raw tables:

```sql
create view person_journey_v1 as
select
  p.id as person_id,
  p.venue_id,
  t.id as touchpoint_id,
  t.channel,
  t.action_type,
  t.signal_tier,
  t.confidence_tier,
  t.occurred_at,
  t.raw_payload
from persons p
left join touchpoints t on t.person_id = p.id
order by p.id, t.occurred_at;
```

### Don't skip

1. **Rendering as a list.** I will render touchpoints as a vertical list with timestamps and call it "ribbon-style." That is not a ribbon. It is a list. Build the SVG.
2. **Logarithmic time.** I will be tempted to compress long quiet periods to make the ribbon look balanced. The ribbon is *supposed* to look unbalanced when quiet periods are long. That's the information.
3. **The action chip.** I will skip the top-line action chip because "it can come later." It can't. Without action affordance, the ribbon is decoration. Build the chip in Phase E.
4. **Confidence styling.** I will skip the High/Medium/Low fill styling because all touchpoints "look real." They aren't. Without visible confidence, Susan can't recover from over-merging.

Gate: ribbon component renders proportional spacing AND density clustering AND confidence styling AND action chip AND hover-on-gap-and-dot before Phase E is declared complete.

### Susan

Susan looks at the ribbon for her booked client and sees:
- A wide span from January 2024 (her first Knot view) through May 2025 (wedding date).
- A cluster of 8 dots in the first week of February 2024 (Knot Save, calculator, IG follow, second view, third view, save again, inquiry form, Calendly booking). Cluster shows "8 touches in 6 days."
- A long quiet stretch from March 2024 through July 2024 with "4 month gap."
- Email replies starting in August 2024 leading to contract sign in October 2024.
- Tour attended in November 2024.
- Final touch chip: "Booked. Wedding May 18, 2025."

She hovers the cluster: it expands inline showing the 8 touches with icons and timestamps. She hovers the gap: "4 months. They went quiet after their first inquiry. Likely shopping other venues."

The action chip above the ribbon: "Anniversary in 12 days. Send touchpoint?"

She says "I never knew they touched us that many times in February." The architecture worked.

---

## 7. SIGNAL HIERARCHY

### Doctrine

Action types carry different weights in promotion calculation, heat scoring, and engagement assessment.

| Tier | Examples |
|---|---|
| **Highest** | Contract signed, Tour attended, Calendly booked |
| **High** | Message sent (any channel), Inquiry form, Email reply |
| **Medium-high** | Storefront Save, Calculator completion, Portal access |
| **Medium** | Click to website/social, Email open with click |
| **Low** | Storefront view (single), Page view, Instagram follow |
| **Aggregate-only** | Impression, ad view, anonymous session |

Weights apply to promotion thresholds (Save + Message reaches Channel-Scoped Person bar; two Views does not), heat scoring (weight per signal type, decay per signal age), source attribution (high-tier signals carry more weight than low-tier).

### Build

Signal tier is a column on `touchpoints`, set at ingest time by the channel adapter. Heat scoring is a function over the Person's touchpoint history:

```typescript
function computeHeatScore(person: Person, touchpoints: Touchpoint[]) {
  const weights = { highest: 100, high: 60, medium_high: 30, medium: 15, low: 5 };
  const halfLifeDays = 14;
  return touchpoints
    .filter(t => t.signal_tier !== 'aggregate_only')
    .reduce((sum, t) => {
      const ageDays = daysSince(t.occurred_at);
      const decay = Math.pow(0.5, ageDays / halfLifeDays);
      return sum + weights[t.signal_tier] * decay;
    }, 0);
}
```

Heat score is cached on `persons.heat_score` column, recomputed nightly or on new-touchpoint write (whichever is cheaper).

### Don't skip

1. **The aggregate-only tier.** I will be tempted to treat impressions as Low instead of Aggregate-only. Don't. Impressions are not attributable.
2. **Half-life decay.** I will use a linear decay or no decay. Half-life models the real shopping cycle better.

### Susan

Susan sees heat as a temperature gradient on the couple card: cool blue, warming yellow, hot orange, on-fire red. She doesn't see the number.

---

## 8. MIGRATION PHASES A–F

### Doctrine

The migration is additive and incremental. Code continues to function throughout. The legacy inquiry model degrades from "source of truth" to "audit log" as the new model proves itself.

### Build (with sequencing)

**Phase A: Schema dual-write.** Tables created, every existing inquiry mirrored to Person/Fragment as appropriate, dual-write hooks on every inquiry-touching code path. **Includes:** divergence dashboard that compares inquiry-derived metrics to person-derived metrics nightly and alerts on drift > 5%. **Does not include:** any reader migration. Legacy code reads from inquiries.

**Phase B: Backwards Tracer.** Implementation, matcher, LLM judge, cold-start mode, checkpointing. Run once against Rixey production data with operator validation before any other venue.

**Phase C: Forwards Linker.** Full-identity attach-or-create path, partial-identity full-machinery path, advisory locks, idempotent inserts. New events dual-write to inquiries (legacy compat) and Person model.

**Phase D: Intelligence layer migration.** Per-feature audit and refactor. **Each item is its own PR with its own gate:**

- D1 Heat scoring: Person-keyed, derived from journey ribbon
- D2 Decay detection: Person-keyed, 180d default
- D3 Source attribution: Person-keyed multi-touch over journey ribbon
- D4 Voice DNA personalization: per-Person, per-Agent when applicable
- D5 Email pipeline: outbound classification keys off Person state
- D6 Sage / brain surfacing: context built from Person ribbon
- D7 Couple portal: keyed to Person, portal links migrated
- D8 Source quality scorecards: Person-keyed cohort
- D9 Cohort intel: Person-keyed funnel, anomaly detection
- D10 Audit/cron sweeps: every writer audited for Person-equivalent writes

**Phase E: Journey ribbon and operator surfaces.** Replace inquiry-list with Person-list, build ribbon component, build merge/unmerge/dispute UI, build candidate review queue and inline surfacing.

**Phase F: Sunset.** Deprecate inquiries table to write-only audit log. Inquiries remain as raw touchpoint records under parent Person but no longer act as primary entity.

Phase D must complete in full before Phase F. Phase F before Phase D leaves the codebase in a dual-state purgatory permanently.

### Don't skip

1. **The divergence dashboard in Phase A.** I will skip it because "dual-write is straightforward." It isn't, and the only way to catch drift is to measure. Required deliverable for Phase A close.
2. **Per-feature audit in Phase D.** I will bundle multiple D-items into one PR to move fast. Each item gets its own PR or you can't roll back individually.
3. **Phase F before Phase D.** I will be tempted to deprecate inquiries because "the new code works now." Don't. Sunset only after every read path is migrated.

Gate per phase: see individual sections. Phase A also requires migration-rerun safety. Phase B also requires the 90% matcher-accuracy gate (§2). Phase E also requires the ribbon completeness gate (§6).

### Susan

Susan doesn't see phases. She sees:
- During Phase A-C build: nothing changes. Bloom still works on inquiries.
- During Phase D rollout: she may see new operator surfaces (heat scoring, source attribution) update one at a time over weeks.
- After Phase E: her primary navigation switches from "Inquiries" to "Couples." This is the visible product change.
- After Phase F: no change. Internal cleanup.

---

## 9. OBSERVABILITY, MERGE, UNMERGE

### Doctrine

An identity system without unmerge is a one-way door to corruption. Unmerge is first-class, not an afterthought.

Every Person record carries a merge audit trail: touchpoints attached with source signal and confidence at time of attachment, merge events with timestamps and triggering rules, operator confirmations and rejections, last calibration check timestamp.

Operator-facing dispute affordances: resurrection dispute, coalescence dispute, agent misclassification.

Telemetry the system watches itself: per-venue auto-promotion rate, operator rejection rate, unmerge rate. Trends trigger system alerts.

### Build

Unmerge UI on Person profile:

```
[Split this Person]
  → modal opens with checkboxes per touchpoint
  → operator selects touchpoints belonging to a different couple
  → choose: form a new Person | attach to existing Person | demote to Fragment
  → reason field (free text, required)
  → confirm → split executes, person_merge_events row written with event_type='manual_unmerge'
```

Resurrection dispute flow:
- Ghost candidate-resurrects on new inbound signal
- Inline banner on the new lead detail: "This looks like Sarah & Mike from January 2024. Confirm?"
- Confirm → Ghost restored to Person, new signal appended
- Reject → reason field ("recycled email" / "different couple same name" / "phone number reassigned") → hash blacklisted for this Ghost

Telemetry dashboard at `/admin/identity-telemetry` (Isadora-visible only, not per-venue):
- Per-venue auto-promotion rate, rejection rate, unmerge rate
- Trend alerts: if rejection rate > 10%, matcher is over-merging
- Per-venue calibration status: tier thresholds, last calibration event

### Don't skip

1. **Audit trail.** I will skip the merge events log because "we can look at git history." We can't. Required deliverable in Phase A.
2. **Reason field on unmerge.** I will make it optional. It must be required. The reasons feed the calibration loop.
3. **Blacklist on resurrection reject.** I will skip the blacklist. Then the same Ghost re-resurrects every week and Susan rejects it every week and loses trust.

Gate: unmerge UI functional in Phase E. Telemetry dashboard functional in Phase D.

### Susan

Susan sees the unmerge button as "Split this couple" on the Person profile. She doesn't see telemetry. She does see:
- "This is a possible match" inline (covered in §5)
- "Sarah & Mike from January 2024 may be back. Confirm?" inline banner on new leads
- Soft notification when Bloom corrects itself: "We split the [name] record because two touchpoints didn't fit."

---

## 10. MULTI-TENANT BOUNDARY

### Doctrine

Person records are scoped per venue. Bloom is multi-tenant. No Person record spans venue boundaries. Touchpoints, ribbons, Ghosts, and Agents all venue-scoped.

Cross-venue intelligence ("this couple inquired at Rixey AND Oakwood") is a product question, not an architectural one. Until that feature exists, same human couple inquiring at two venues creates two independent Persons.

### Build

Every table in §1 has a `venue_id` column with RLS-enforced isolation. Existing `venue_members` membership table determines who can read which venue's data. Demo company gets special anon-read policies (existing pattern).

No service-role bypass for cross-venue queries except in Bloom-admin paths (telemetry dashboard).

### Don't skip

1. **RLS testing.** I will write RLS policies and skip the cross-venue isolation test. Then Venue B sees Venue A's data on the first edge case.

Gate: cross-venue isolation test in CI for every table touched by this brief.

### Susan

Susan sees only her venue. Cross-venue features do not exist.

---

## 11. INVARIANTS

1. Couples are the unit of intelligence. One Person = one couple. Agents are a separate class.
2. The clock measures couple progression, not venue outbound effort.
3. Confidence is preserved through every transformation.
4. Bloom shows its work. Every claim traces back to a visible touchpoint.
5. Fragments do not resurrect. Only Persons can revive from Ghost, operator-confirmed.
6. The journey ribbon does not lie about time. Proportional spacing, density via clustering.
7. HoneyBook Lead Source is untrusted. Attribution from upstream raw signals.
8. Channel-scoped identity is real. Don't flatten Channel-Scoped Persons into Fragments.
9. Bulk data dumps respect the entity model. Knot CSV does not create 1,500 Persons.
10. Death is demotion, not deletion. Ghosts retain hashed IDs and aggregate metadata.
11. Auto-promotion above High tier only. Medium and Low surface for review. No silent merge.
12. Unmerge is a first-class operation. Every merge can be reversed with a logged reason.
13. Venue is the tenancy boundary. Person identity does not leak across.

---

## 12. ANTI-PATTERNS

- Auto-promote every form to Person
- Use decimal confidence scores to drive automation
- Merge two same-first-name same-last-initial entities without corroborating signals
- Reset death clocks on outbound activity
- Render journey ribbons with logarithmic time compression
- Render journey ribbons as vertical lists with timestamps
- Treat HoneyBook Lead Source as truth
- Let Medium-tier links contaminate operator surfaces silently
- Run Backwards Tracer as a continuous background job (Tracer is event-triggered: onboarding, bulk import, new source connection)
- Skip Tracer checkpointing
- Expose Fragments as if they were Persons
- Conflate Person death with deletion
- Flatten Agents into Persons or Fragments
- Silently overwrite conflicting fields when pipelines disagree
- Build Forwards Linker as if it has the same problem space as Tracer (full-identity channels are simple, partial-identity channels still need full machinery)
- Skip the matcher LLM judge in favor of pure heuristics
- Skip the calibration loop
- Skip the divergence dashboard in Phase A
- Bundle Phase D items into one PR
- Sunset inquiries (Phase F) before Phase D completes

---

## 13. TEST OF SUCCESS (two-axis)

**Test 1, Revelation.** A venue owner looks at a Resolved Person profile and says: "I never knew they touched us that many times."

**Test 2, Precision.** That same venue owner reviews 50 random Resolved Person profiles and confirms each is one actual couple. Operator rejection rate stays below 5%.

If both pass, the architecture works.
If Test 1 passes but Test 2 fails, the matcher is over-merging. High recall, low precision, the "wow" is a hallucination.
If Test 2 passes but Test 1 fails, the system is correct but under-revealing. Operators see what they already knew.

Both axes matter. Single-axis "wow" testing is a trap.

---

## APPENDIX A: SUSAN'S FIRST 24 HOURS

A scripted narrative of what a venue owner experiences. Engineering acceptance criteria derive from this script. If the script breaks, the engineering missed something.

**Hour 0: signup.**
Susan creates an account at thebloomhouse.ai. She enters her venue name (Rosewood Estate), capacity, location. She lands on a "Connect your tools" page.

**Hour 0-0:15: OAuth.**
HoneyBook connect button. She clicks. OAuth flow. Returns. Green check. (30 seconds.)
Gmail connect button. OAuth. Returns. Green check. (30 seconds.)
Calendly connect button. OAuth. Returns. Green check. (30 seconds.)
The Knot section: "We don't have a direct integration. Upload your storefront data export. [Watch 2-min video]." She watches the video. Logs into Knot in a new tab. Exports CSV. Returns. Uploads. Green check. (5 minutes.)
Instagram section: "Optional. Export your follower list and DM archive. [Watch video]." She skips for now. (0 minutes.)

**Hour 0:15-0:20: confirmation page.**
"We're reconstructing the last 5 years of your business. This takes 4-8 hours. We'll email you when it's ready. You can close this tab."

A live status page is visible if she keeps the tab open: "Stage 1: anchor discovery from HoneyBook (12% complete). Found 187 booked clients so far."

**Hour 0:20-6:00: Susan does other things.**
She runs her venue. She has a wedding tomorrow.

**Hour 6: email arrives.**
Subject: "Your business is ready."
Body: "We reconstructed 3 years of history. 312 couples found. 187 booked, 89 lost, 36 active. Tap to explore."

**Hour 6:05: Susan opens Bloom.**
Default view is "Couples" list, sorted by recent activity. Active couples at top. Filter chips: Active / Cooling / Lost / Booked / Past.

She filters to Booked. Sees her recent weddings. Opens "Anna & Jordan, married Apr 2025" (her last big wedding).

**Hour 6:06: the holy-shit moment.**

The ribbon spans Jan 2024 (their first Knot view) through Apr 2025 (wedding date) and forward to today.

She sees a cluster: "8 touches, Jan 14-19, 2024."

She hovers. The cluster expands: Knot Save, Knot view, IG follow, second Knot view, third Knot view, Knot Save again, calculator session, inquiry form. All within 5 days.

She says out loud: "I had no idea they looked at us that many times before they inquired."

A second cluster: "3 emails from Anna's mom, Feb 2024."

She hovers. Three emails from a different address, signed by Anna's mom. The system has classified this address as an Agent ("Mother of bride") and linked it to Anna & Jordan's Person record.

She says: "I forgot her mom emailed us first."

The action chip above the ribbon: "Anniversary in 18 days. Send touchpoint?"

She clicks. A pre-drafted email opens, referencing the wedding date and a specific detail from her notes. She tweaks and sends.

**Hour 6:30: she explores more.**

Active couples list. She opens a current lead: "Madeline E. (active on The Knot)."

The profile shows a Channel-Scoped Person. The ribbon has 4 touches, all on Knot. Confidence chip: "Channel-scoped: confirmed real on The Knot, not yet bridged to email or phone."

Inline banner: "Possible match: madeline.evans@gmail.com replied yesterday. Confirm?"

She clicks Confirm. The Channel-Scoped Person promotes to Resolved Person. The ribbon updates. Email reply attaches.

She says: "Oh, that's the same person."

**Hour 6:45: she reviews the queue.**

Dashboard shows "3 possible matches this week" with a small banner. She clicks. Three candidates, each with confidence tier (one High, two Medium). She confirms High silently. Confirms one Medium. Rejects one Medium with reason "different couple, both named Sarah."

The rejection feeds calibration. She doesn't know that. She just feels like the system listened.

**End of session, Hour 7:00.**

She's invested. She'll come back tomorrow.

If any of these moments fails (no progress page, no holy-shit cluster, ribbon as a vertical list, candidate review in a separate page she has to find, no Agent recognition, no anniversary action chip), the architecture failed. These are acceptance criteria, not nice-to-haves.

---

## APPENDIX B: STOP CONDITIONS (proves I cut corners)

If any of the following ship to production, the implementation is incomplete and triggers rework before further phases proceed.

1. **Phase A merged without divergence dashboard.** Stop. Build it.
2. **Phase B merged with matcher pass-rate below 90% on the 50-pair Rixey fixture.** Stop. Tune.
3. **Phase B merged without LLM judge wired.** Stop. Wire it.
4. **Phase B merged with Tracer non-rerunnable (second run duplicates rows).** Stop. Fix idempotency.
5. **Phase C merged without advisory lock on Person creation.** Stop. Add it.
6. **Phase C merged with partial-identity channels skipping Channel-Scoped tier.** Stop. Add the machinery.
7. **Phase D items bundled into one PR.** Stop. Split.
8. **Phase D5 (email pipeline) shipped with personalization still keyed to inquiry.** Stop. Refactor.
9. **Phase E ribbon shipped as vertical list, log-time compression, or no action chip.** Stop. Build the SVG with proportional spacing and action affordance.
10. **Phase E shipped without unmerge UI.** Stop. Add it. Unmerge is Phase E, not "later."
11. **Phase F shipped before Phase D complete.** Stop. Roll back Phase F.
12. **Any phase shipped without RLS isolation test in CI.** Stop. Add the test.
13. **Operator rejection rate exceeds 10% sustained for 7 days post-launch.** Stop. The matcher is over-merging. Retune.
14. **Susan's first-24-hour script (Appendix A) fails on a real onboarding session.** Stop. The architecture missed something.

---

**End of brief.**
