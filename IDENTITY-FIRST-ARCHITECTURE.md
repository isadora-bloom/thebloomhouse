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

---

# APPENDIX C — TIER 8 EXECUTION PLAN (2026-05-18)

## C.0 Why this appendix exists

Tier 8 is the execution arm of this doctrine. Phases A and B have *shipped code* (migrations 346–350, the `src/lib/services/identity/*` tree, the `identity_first_tracer` cron job). This appendix records a verify-before-plan audit of that code, reconciles the doctrine with the "Point Zero = the booked wedding" framing, maps the 36-question test battery (`BLOOM-TEST-QUESTIONS.md`) onto the spine, and sequences the remaining work.

Read order for an implementer: C.1 (what's real) → C.2 (the doctrine reconciliation) → C.3 (the orchestrator) → C.4 (battery matrix) → C.5 (work breakdown) → C.6 (stop conditions).

## C.1 Verified state of shipped code (audit 2026-05-18)

Audited against this brief's §1–§9. Every claim below was confirmed by reading the file.

### Genuinely works (do not rebuild)

| Component | File | Note |
|---|---|---|
| Structured matcher | `matcher.ts` | Every weight from §2 implemented as integers; capped Damerau-Levenshtein; `needs_judge` = score 40–90; `__test` export wired for the 50-pair fixture. Production-grade. |
| LLM judge | `llm-judge.ts` | Sonnet, structured output, per-run budget 200 + per-day budget 50 (queries `tracer_run_events`). Doctrine §2 compliant. |
| Decay sweep | `decay.ts` | `resolved`/`channel_scoped` only, per-row `decay_window_days` default 180, mid-sweep `couple_progression_events` re-check, idempotent. |
| Progression log | `progression.ts` | Excludes outbound (§3 "Don't skip #1"); never rolls the clock backward. |
| Resurrection | `resurrection.ts` | Blacklist on reject (§9 "Don't skip #3"); migration 349. |
| Cron wiring | `cron/route.ts:147,803` | `identity_first_tracer` registered; piggyback drain on `identity_judge_sweep` with an 8-min in-progress guard. |

### Stubbed, partial, or broken (Tier 8 must fix)

| Defect | Evidence | Severity |
|---|---|---|
| **The Tracer mints zero couples.** `anchor_discovery` is a no-op `count` query (`anchors.ts:14` admits "does NOT create anything"); `state.totals.couples_minted` is initialised 0 and never incremented. | `tracer.ts:224,808` | **Blocker** — the Tracer cannot reconstruct identity. It sweeps touchpoints and queues `candidate_matches` but never creates a Couple from them. |
| **No advisory lock.** The `tracer.ts` header describes `pg_try_advisory_xact_lock` + a `lockAndUpsertCouple` helper "see below". The helper does not exist anywhere in the repo. | `tracer.ts:41-46` | **Blocker** — Stop condition #5. Tracer-during-active-venue will corrupt the couple store. |
| **Judge runs context-blind.** Both call sites pass `context: { primary_touchpoints: [], secondary_touchpoints: [] }`. The judge prompt is built around timelines as "the tiebreaker" — they are always empty. | `tracer.ts:484`, `forwards-linker.ts:306` | High — judge decides on structured signals alone, defeating the §2 hybrid. |
| **`candidate_matches` duplicates on every rerun.** No unique constraint in mig 346 (only a plain index). `insertCandidateMatch` swallows a `23505` that can never fire. | `tracer.ts:374`, mig 346 §7 | High — violates Stop condition #4 ("zero new rows on second run"). |
| **`cross_channel_coalesce` is coarse v1.** Header: "v1 implementation: identity_hint exact match within 14 days." Never promotes a fragment, never mints a channel-scoped couple. | `tracer.ts:597` | High — §5 coalescence not implemented. |
| **Cold-start has no entry point.** Detection works (`anchors.ts:235` trips `coldStart`, runner notifies). No endpoint takes operator-entered couples and creates anchors. | `tracer-runner.ts:155` | Medium — §4 cold-start path dead-ends. |
| **Not a layered orchestrator.** `runTracer` runs six stages once against a single `loadRecentCouples` snapshot taken at sweep start. No certainty-layered passes, no tombstoning of consumed candidates. | `tracer.ts:794,525` | Medium — see C.3. |
| `agent_infer` partial — never writes `agent_couple_links`. Resume-from-checkpoint is dead code (`getResumeFrom` only runs when `opts.runId` is passed; the runner never passes one). | `tracer.ts:673,186,831` | Low — defer. |

**Resolved, not a defect:** the `tracer_run_events.run_id` uuid-vs-text drift was fixed by migration `347` (`ALTER COLUMN run_id TYPE text`). Confirm 347 is applied to prod before relying on Forwards Linker telemetry.

### Schema (migration 346) — naming note

The brief's §1 calls the core table `persons`; the shipped migration named it **`couples`**, with `agent_couple_links`, `couple_merge_events`, `couple_progression_events`. The rest match. This appendix uses the shipped names. The brief's prose has not been retro-fitted; **`couples` is canonical.**

## C.2 The reconciliation — "Point Zero = the booked wedding"

The constitution (`bloom-constitution.md`) defined **Point Zero** as the first interaction carrying a name + a reachable identifier — a mid-funnel event. That definition is retired. Tier 8 anchors on the **booked wedding**: the end of the funnel, the venue's highest-trust ground truth.

This is the same inversion §0 of this brief already describes ("walk from known ground truth outward"). Naming it "Point Zero = the booked wedding" sharpens one rule that the rest of Tier 8 depends on:

> **"Inquiries are signal, not entities" does NOT mean "inquiries are noise."**
> It means the inquiry *row* is not the entity — the *couple* is. The Tracer walks backward from a booked anchor and, for every upstream inquiry it reaches:
> - inquiry **with sufficient identity** (real name + one reachable identifier) → minted/attached as a **Couple** (`lifecycle_state` `resolved`, or `booked` if it backtraces to an anchor)
> - inquiry **without** sufficient identity (anonymous Knot view, "Madison B." with no identifier) → a **Fragment**, surfaced only as an aggregate count
>
> A residual inquiry that never connects to an anchor is **not a failed record** — if it has identity it is a `resolved` Couple in its own right; if it does not, it is a Fragment. Either way it is no longer a broken half-entity demanding individual repair. This is what dissolves the "201 Unknown weddings" class.

**Why this is load-bearing for the battery (C.4):** ~25 of the 36 test questions need *non-booked* couples as queryable, dedup-able entities — ghoster response times (Q2), which inquiries will ghost (Q19), stalled follow-ups (Q23), unique-couple counts and merge precision (Q6/Q29/Q36). A literal reading of "inquiries are noise" would fail all of them. The Couple/Fragment split is the reconciliation that keeps the battery answerable.

**Entity-model decision (DECISION 1):** Tier 8 commits to the `couples` spine. The alternative — keep `weddings` and add an anchor flag — is rejected: an anchor flag labels rows, it does not resolve identity or produce merge-confidence, so Tiers 7 and 11 of the battery would force the merge-audit substrate to be built anyway. The spine is also already shipped (mig 346 + the Tracer cron); the flag model would mean abandoning cron-running code.

## C.3 The orchestrator — layered backtrace

The shipped Tracer is a single-pass, single-snapshot sweep (C.1). Tier 8 replaces stage 1 + stage 2 with a **certainty-layered backtrace**. This is not a contradiction of the brief's §4 — it is the concrete implementation of "anchor discovery → touchpoint sweep," reorganised so the most certain anchors resolve first and *consume* their candidates before less certain layers run.

```
Pass 1 — BOOKED anchor.    Anchor couples = signed/booked weddings (a signed
                           contract is "contracted"; ContractHouse is a
                           separate product, so booked ≡ contracted here).
                           Mint lifecycle_state='booked'. Backtrace touchpoints.
Pass 2 — COMPLETED anchor. Past weddings with no surviving booked row. Same.
Pass 3 — TOURED anchor.    tour_completed / tour_attended couples not already
                           anchored. Mint lifecycle_state='resolved'.
Pass 4 — INQUIRY TRIAGE.   Residual inquiry signal. NOT a 4th anchor type — it
                           is the Couple/Fragment split from C.2. Identity-
                           sufficient residuals → 'resolved' Couples; the rest
                           → Fragments.
```

**Tombstoning:** after each pass, every `candidate_matches` row and every `touchpoint` consumed by a minted couple is marked resolved so the next pass's matcher snapshot excludes it. This is what "anchor-down per-layer tombstoning" means and it is what makes the passes ordered rather than independent.

**Non-negotiable properties (each is a Tier 8 gate):**
- **Idempotent** — second full run produces zero new `couples`/`touchpoints`/`fragments`/`candidate_matches`. Requires the missing `candidate_matches` unique constraint (C.5 T8.0).
- **Advisory-locked** — `pg_try_advisory_xact_lock(hashtext(venue_id||':'||identifier))` around every couple mint; loser re-reads and attaches. Build the `lockAndUpsertCouple` helper the header already promises.
- **Checkpointed** — wire `getResumeFrom` to a persisted `run_id` so a timeout resumes per-pass, not from scratch.
- **Matcher + judge with real context** — the judge must receive populated `primary_touchpoints`/`secondary_touchpoints`; build the `JudgeContext` producer.

**DECISION 2 (flag for confirmation):** Passes 1–3 collapse to effectively *two* anchor statuses in Rixey's current data — `anchors.ts` has `['booked','completed','tour_completed']` and migration 346 collapsed everything else into `resolved`. The 4-layer framing is kept for clarity and future CRMs, but the implementer should not invent a "contracted" status that has no rows behind it.

**Implementation note — what the orchestrator code actually layers (added 2026-05-18, T8.1a design pass).** The four passes above describe the *conceptual* certainty ordering. They are not four code branches. Verified against the shipped code: `mirror-couple.ts` (Phase A dual-write) already mints a `couples` row for **every** wedding regardless of status — `booked`/`completed` → `lifecycle_state='booked'`, everything else → `'resolved'`. So passes 1–3 and the identity-sufficient half of pass 4 are *already minted before the Tracer runs*; `anchor_discovery` correctly stays a count (C.1). The work the orchestrator code does is the **non-wedding channel sweep** — Knot saves, Instagram DMs, Calendly events without a `legacy_wedding_id`, calculator runs, SMS — none of which `mirror-couple` touches. Within that sweep the certainty layering is **by `signal_tier`**, not by wedding status: process `highest`/`high` signals first (they carry full contact identity and *mint* channel-scoped couples), then `medium`/`low` (they *attach* to couples the earlier tiers established, or drop to Fragments). That tier-ordered sweep, with tombstoning between tiers, is the concrete form of the layered backtrace. The booked-anchor framing remains the correct mental model for *why* the order matters; the `signal_tier` sort is how it is coded.

## C.4 Battery traceability matrix

`BLOOM-TEST-QUESTIONS.md` is the **acceptance test for Tier 8**. Each question maps to spine tables + the Phase D item that surfaces the answer. "Gap" = what is missing today.

| Q | Needs | Phase D item | Gap today |
|---|---|---|---|
| 1 first-reply median + 12mo delta | `touchpoints` (first inbound vs first venue reply, direction-tagged) | D9 | touchpoints unpopulated; direction tag |
| 2 response-time dist: bookers vs ghosters | `couples` segmented by lifecycle | D9 | ghosters must exist as Couples |
| 3 knee in response→tour curve | same + non-linear analysis | D9 | analysis surface |
| 4 response time × channel | `touchpoints.channel` + timing | D9 | — |
| 5 multi-platform attribution + *show the logic* | couple-keyed multi-touch + journey ribbon | D3 + ribbon (E) | attribution couple-keyed; ribbon |
| 6 % cross-surface dupes + merge confidence | `candidate_matches`, `couple_merge_events.confidence_tier` | Identity Report | matcher must run + write tiers |
| 7 holiday inquiry spike + conversion | touchpoint counts by date + couple outcome | D9 | — |
| 8 weekend vs weekday tour conversion | tour touchpoints + booked outcome | D9 | — |
| 9 competitor-event correlation | external context + touchpoint volume | D9 | operator-supplied data |
| 10 bad weather × tour no-show | Wave 8 weather ⨝ tour touchpoints | D9 | join |
| 11 booking lead-time distribution | `couples.wedding_date` − first touchpoint | D9 | — |
| 12 June YoY controlling for marketing | touchpoint volume + confound reasoning | D9 + correlation engine | — |
| 13 climate-control mentions over time | `touchpoints.raw_payload` text extract | D9 | text-pattern extractor |
| 14 inquiry→tour ratio, summer | segmented funnel over couples | D9 | — |
| 15 budget-mention shift + correlation | touchpoint text extract | D9 | extractor |
| 16 emerging repeat questions | Wave 5B theme detection over couple corpus | D9 | couple corpus |
| 17 why chose us over Stone Tower | refuse — no data | D6 Sage | calibration |
| 18 forecast next June | hedge | D6 | calibration |
| 19 which inquiries will ghost + features | active Couples + Wave 5A close-prob + key_signals | D6 + D9 | per-couple prediction couple-keyed |
| 20 IG launch causation | correlation engine, correlation≠causation | D6 | — |
| 21 pricing too high | ask clarifying | D6 | — |
| 22 response speed by time of day | venue-reply touchpoint timing | D9 | — |
| 23 replied-to but never followed up | `couples` + `couple_progression_events` stuck-state | D2/D9 | — |
| 24 inquiries I shouldn't have replied to | retrospective qualification over couples | D9 | — |
| 25 pre-tour signals predicting signing | pre-tour touchpoints + couple outcome | D9 | feature-importance surface |
| 26 highest-conversion surface vs highest-volume | couple-keyed first-touch attribution (Wave 7B) | D3/D8 | couple-keyed |
| 27 first-message language shift | touchpoint text over time | D9 | extractor |
| 28 blog/reel/pin mention → conversion | touchpoint content attribution | D3/D8 | content tagging |
| 29 unique-couple count + top/bottom 20 merges | `couples` count + `candidate_matches`/`couple_merge_events` confidence | Identity Report | report surface |
| 30 % inquiries complete vs partial records | Couples vs Fragments + gap analysis (Wave 9) | Identity Report | report surface |
| 31 sensitivity refusal | aggregate-only; never name (Wave 4 tags on couple) | D6 | couple-keyed sensitive tags |
| 32 false-premise challenge | reliable touchpoint volume history | D6 | — |
| 33 channel-reasoning consistency | D3/D8 + Sage | D3/D6 | — |
| 34 find 3 likely-to-book + draft + explain | Couples + heat/close-prob + Sage draft + journey | D1 + D6 + ribbon (E) | full chain |
| 35 conversion by cultural cohort | Couples + Wave 4/5D cultural tags + outcomes | D9 | couple-keyed tags |
| 36 5 false-merge + 5 missed-merge w/ evidence | `candidate_matches` + `couple_merge_events` + matcher precision/recall | Identity Report | report surface |

**Reading of the matrix:** the battery is answered by **four surfaces** — D9 (cohort intel, ~20 questions), D3 (source attribution, ~5), D6 (Sage honesty/calibration, ~7), and a new **Identity Report** (Q6/29/30/36). The journey ribbon (Phase E) is needed for Q5 and Q34. Every cell depends first on `couples` + `touchpoints` being correctly populated — which is exactly what C.1 says does not happen today.

## C.5 Tier 8 work breakdown

Ordered by dependency. Each numbered item is its own PR (Phase D items must not be bundled — §8 "Don't skip #2", Stop #7).

**T8.0 — Foundations.** Only one item is a clean standalone foundation; the rest were re-cut into T8.1 after a verify-as-built pass (2026-05-18) showed they cannot precede the mint path.
- T8.0a ✅ **DONE** (migration 358, commit `12ca122`) — unique index `uq_candidate_matches_pair` on `(venue_id, primary_record_id, primary_record_type, secondary_record_id, secondary_record_type)`. De-dups existing rows first. Idempotency floor.
- ~~T8.0b advisory lock~~ → **folded into T8.1.** `pg_advisory_xact_lock` is transaction-scoped (Supabase pools connections, so session-scoped locks leak); the lock must live in the same RPC as the couple upsert, which T8.1 builds. Cannot precede the mint path.
- ~~T8.0d checkpointing~~ → **folded into T8.1.** `getResumeFrom` wires into the stage loop that T8.1 rewrites into the 4-pass orchestrator.
- T8.0c ✅ **DONE** — `judge-context.ts` builds real touchpoint timelines (the signal as its own one-event timeline; the couple's `touchpoints` rows for the other side) and is wired into both judge call sites. The judge is no longer context-blind.

**T8.1 — The layered-backtrace orchestrator.** Make `touchpoint_sweep` + `cross_channel_coalesce` actually mint couples. Wedding-status anchors are already minted by `mirror-couple.ts` (see the §C.3 implementation note); the real work is the non-wedding channel sweep, `signal_tier`-layered, with the matcher + judge + a race-safe mint. Five PRs:

- T8.1a ✅ **DONE** — the advisory-locked mint primitive. Migration 359 ships `lock_and_mint_couple(...)`: a `SECURITY DEFINER` plpgsql function that acquires `pg_advisory_xact_lock(hash(venue_id||':'||lock_key))`, re-checks for an existing couple by email/phone, mints a `channel_scoped` couple if none, and attaches the touchpoint — all in one transaction so the xact-scoped lock genuinely guards the mint. `src/lib/services/identity/mint-couple.ts` is the TS caller: `computeLockKey` (email → phone → `handle:` → `signal:` floor), `hasSufficientIdentity` (the §C.2 Couple/Fragment line — email/phone OR a 2-token name), and `lockAndMintCouple`. This is the `lockAndUpsertCouple` the `tracer.ts` header promised. Not yet wired into the sweep (that is T8.1b) — the primitive ships first so it can be unit-tested in isolation.
- T8.1b — wire the mint into `touchpoint_sweep`. In `processSignal`, when the matcher returns `below_threshold` (no couple matched) and `hasSufficientIdentity(signal)` is true, call `lockAndMintCouple` instead of dropping the signal to a Fragment via `applyTierRouting`. Sort the adapter sweep by `signal_tier` descending so high-tier mints precede low-tier attaches. Increment `state.totals.couples_minted`.
- T8.1c — rebuild `cross_channel_coalesce`. Today it only queues `candidate_matches` for fragment-pairs sharing an `identity_hint`. Run the real matcher on those pairs; on a `high`-tier result, promote the fragment-pair into a channel-scoped couple (`fragments.promoted_to_couple_id` + a `couple_merge_events` `fragment_promoted` row).
- T8.1d — tombstoning between tiers. After each `signal_tier` layer, mark every `candidate_matches` row consumed by a minted couple `resolved` so the next layer's matcher snapshot excludes it. Re-load the couples snapshot between layers (today it is taken once at sweep start).
- T8.1e — checkpointing. Wire `getResumeFrom` to a persisted `run_id` so a stage timeout resumes per-layer, not from scratch. (Folded in from the retired T8.0d.)

- **Gate:** 90% on the 50-pair Rixey fixture (Stop #2); idempotent rerun = zero new rows (Stop #4); ghost count ≤ 10% of historically-booked couples (§3 gate). Run end-to-end on re-imported Rixey data with operator validation before any other venue.

**T8.2 — Phase D, battery-prioritised.** One PR per item, in this order (highest battery coverage first):
- D9 cohort intel (couple-keyed funnel, anomaly, text-pattern extractors) — unlocks ~20 questions.
- D3 source attribution (couple-keyed multi-touch over the journey) — Q5/26/28/33.
- D6 Sage / brain (context from the couple ribbon; honesty calibration) — Q17–21/31/32/34.
- **Identity Report** — new surface at `/intel/identity-review` extended with the Q6/29/30/36 read: unique-couple count, top/bottom-20 merges by confidence, complete-vs-partial record %.
- D1 heat, D2 decay surfacing, D8 source-quality scorecards — remaining cells.

**T8.3 — Phase E journey ribbon** for Q5 ("show the logic") and Q34, plus the Appendix-A holy-shit moment. Ribbon completeness gate (§6).

**Deferred past Tier 8:** D4 voice DNA, D5 email-pipeline rekey, D7 portal, D10 cron audit, Phase F sunset, `agent_infer` auto-promotion. None block the battery.

## C.6 Stop conditions for Tier 8

All of Appendix B applies. Tier 8 adds one explicit ship gate:

> **The battery is the gate.** Run `BLOOM-TEST-QUESTIONS.md` against the Rixey instance after T8.2. Tier 8 is not done until the average score is ≥ **+1.0** across all 36 questions AND there are **zero −3 scores in Tier 4** (honesty checks). A single confident confabulation on an honesty question means not ready — fix the failure mode, do not ship around it.

Re-run the battery after every D-item PR; the score should climb monotonically as surfaces migrate onto the spine.
