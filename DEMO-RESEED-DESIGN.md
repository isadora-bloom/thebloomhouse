# Demo reseed through linkSignal — design

Written 2026-09-08 as part of NOVEMBER-PLAN.md workstream W4 (demo repair).
**Design only — no code in this document, and none written for it.** Week 6
(Oct 13-19) of the plan is "Demo venue reseeded through linkSignal with a
live clock" — this is the design for that week's build.

## 1. The problem this solves

Two related findings from the 2026-09-08 live walk, neither fixable with a
data patch:

- **Finding 4 (spine empty, legacy full).** The demo venues have rows in
  `weddings`, `people`, `interactions` (legacy tables) but effectively
  nothing in `couples` / `touchpoints` (the identity-first spine, migration
  346). Coordinator surfaces that read the spine — the couples list, Sage's
  "who is this" identity summaries — show blank or garbage (relay addresses
  like `projects@honeybook.com` standing in for a couple's contact,
  diagnostic test rows). Legacy surfaces that read `weddings`/`interactions`
  directly show real-looking numbers. Same product, two different answers
  to "how many couples do we have" depending which page you're on.
- **Finding 5 (heat is dead).** All 61 demo leads read Frozen at heat 0-1.
  `src/lib/services/heat-mapping.ts` applies `daily_decay: -1` per day since
  the last heat event (`getTier`: below 20 points = frozen). The seed's
  event dates are fixed calendar dates in March-May 2026
  (`supabase/seed.sql`, `supabase/seed-demo-rich.ts`). Today is 2026-09-08 —
  120-190 days of decay at -1/day zeroes out any starting score regardless
  of what it was. A demo run any time after the seed dates will show this;
  a demo run a year from now will show it worse.

**Root cause of both, confirmed in code:** `scripts/seed-demo-rich.ts`
(the richest existing demo seed, "Stream VVV") writes directly to
`wedding_touchpoints`, `interactions`, `weddings`, `people` with plain
`INSERT ... ON CONFLICT DO NOTHING`. It never calls `linkSignal`. Every
other demo seed file in `supabase/` does the same — they were all written
before the identity-first spine (migration 346, later) existed, or written
after it but not updated to route through it. Migration 392 (this
workstream) and `scripts/demo-repair.mjs` patch the three worst *symptoms*
of this (wrong business name, leaked real email, diagnostic test rows) —
they do not and cannot fix the underlying "spine is empty" / "dates are
static" problem. That needs a reseed that writes through the cascade, with
dates computed at run time.

## 2. Goals / non-goals

**Goals**
- Every demo couple exists as a `couples` row with `touchpoints` behind it,
  not just a `weddings`/`interactions` row.
- Heat is alive: `weddings.heat_score` / `temperature_tier` (and, once
  Phase D's `couples.heat_score` is live — see §6 open question — that too)
  reflect a plausible spread (some hot, some warm, some genuinely frozen —
  not all frozen) computed from event dates that are relative to whenever
  the reseed last ran, not fixed calendar dates.
- No relay addresses standing in for a couple's contact. Every synthetic
  signal carries a real (fictional) participant email/name pair, the same
  discipline `emailToNormalizedSignal` already applies in
  `scripts/reprocess-knot-orphan-inquiries.ts` (`rawFromEmail: null` when
  the relay address ≠ the subject name — the matcher is never handed a
  relay address as if it were a person).
- Re-runnable on a schedule (a cron, or an operator command before a demo)
  without accumulating duplicate couples or ever-growing row counts.

**Non-goals**
- Does not touch real venues. Scoped to the four Crestwood ids
  (`22222222-2222-2222-2222-222222222201..204`) exactly like migration 392.
- Does not replace `supabase/seed.sql` (venue/venue_config/venue_ai_config
  scaffolding, the fictional Crestwood portfolio itself). Only the
  *activity* — inquiries, tours, messages, bookings — moves to the cascade.
- Does not attempt to also reseed the couple-portal detail tables (budget
  items, checklist, guest list, etc. — the 54 tables migration 392 covers).
  Those stay as direct seed inserts (`seed-couple-portal.sql` /
  `seed-chloe-ryan-fill.sql` style) keyed to a small number of "hero"
  bookled weddings the reseed script mints. Wiring the whole couple-portal
  breadth through the cascade is a much bigger job than heat + identity.

## 3. Story data model

A small, versioned "story" per venue: a roster of synthetic couples, each
with a channel journey. Not procedurally generated — handwritten, in the
same spirit as the existing fictional Chloe & Ryan / Hannah Kate Photography
detail in `PASTE-COUPLE-PORTAL-SEED.sql`, so names, dates and channel mix
read as a real venue's funnel rather than obviously synthetic data.

```
type DemoCoupleStory = {
  id: string                 // stable slug, e.g. 'hawthorne-chloe-ryan'
  venueId: string
  primaryName: string
  partnerName: string | null
  primaryEmail: string       // @example fictional domain, never a real one
  partnerEmail: string | null
  targetTier: 'hot' | 'warm' | 'cool' | 'cold' | 'frozen'
  outcome: 'inquiry' | 'tour_scheduled' | 'tour_completed' | 'booked' | 'lost'
  timeline: DemoSignalStep[]
}

type DemoSignalStep = {
  daysAgo: number             // RELATIVE to run time — the whole point
  channel: 'gmail' | 'knot' | 'instagram' | 'website' | 'calendly' | 'weddingwire'
  actionType: string          // 'reply' | 'tour_booked' | 'tour_attended' | 'knot_message' | ...
  signalTier: NormalizedSignal['signal_tier']
  bodyText?: string           // short, human, venue-flavoured — feeds fragments/touchpoints raw_payload
}
```

`daysAgo` is the mechanism that keeps heat alive across time: a `hot`
couple's last step is `daysAgo: 1-3`; `frozen` is `daysAgo: 150+`. Recompute
`occurred_at = now - daysAgo` at run time, every run — never bake in a
calendar date. This one property is why the finding says "reseeded ... with
a live clock": run the script today, heat looks like today; run it again in
three months, same story, same *relative* freshness.

Roster size: enough to make the coordinator surfaces look populated without
ballooning LLM-judge spend (see §5) — roughly the ~60 the current seed
already implies is the right ballpark, spread across the 4 venues weighted
toward Hawthorne (matching `seed-demo-rich.ts`'s existing "heaviest on
Hawthorne" convention).

## 4. Execution flow

For each `DemoCoupleStory`, in timeline order (oldest `daysAgo` first —
matters, because `linkSignal` mints on the *first* signal and matches every
later one against what it already knows):

1. Build a `NormalizedSignal` per `DemoSignalStep` via the same
   `emailToNormalizedSignal`-style adapter helpers the real ingestion
   pipeline uses (reuse, don't reinvent — `src/lib/services/identity/
   sources/*` already has per-channel builders). Always populate
   `primary_email`/`primary_name` (and `partner_*` once the story is far
   enough along) directly from the story — never derive them from a subject
   line or a relay header the way live ingestion sometimes has to.
2. Call `linkSignal({ supabase, venueId, signal, source: 'demo-reseed',
   bypassCache: true })` (import from `@/lib/spine/cascade`, the one
   allowed writer surface — see `CASCADE-CANONICAL-WRITER.md`). First call
   per couple mints (`action: 'minted'` or `'cold_start'` for the venue's
   very first couple); later calls attach to the same couple by identity
   match.
3. When a story's `outcome` reaches `tour_completed` or `booked`, call
   `mintWedding` (also from `@/lib/spine/cascade`) so a legacy `weddings`
   row exists with `couples.source_wedding_id` pointing at it. This is the
   bridge to §6 (heat still lives on `weddings` today, not `couples`).
4. After each signal that should move the needle on heat (replies, tour
   bookings, proposal views — the same event types
   `src/lib/services/heat-mapping.ts` already scores), call
   `recordEngagementEventsBatch(venueId, weddingId, [...], direction,
   occurredAt)` against the `weddings.id` from step 3, with the SAME
   `occurred_at` the signal used. This is a second write, deliberately
   separate from `linkSignal` — confirmed by reading
   `src/lib/services/email/pipeline.ts`, which calls `linkSignal` and
   `recordEngagementEventsBatch` as two independent steps, not one wrapping
   the other.
5. For `outcome: 'booked'` stories, seed the couple-portal detail tables
   (budget, checklist, guest list, vendors...) the way
   `PASTE-COUPLE-PORTAL-SEED.sql` already does, keyed to the `weddings.id`
   minted in step 3. Only for a small number of "hero" bookings per venue —
   this is what a demo visitor actually clicks into, doesn't need to be all
   60.

## 5. Cost and safety

- `linkSignal` can invoke an LLM judge for medium/low-confidence matches
  (`judgeBudget`, default 5 per call per `LinkSignalArgs`). A reseed with
  clean, always-populated `primary_email` per story should score high-tier
  on structured fields alone for nearly every signal after the first
  (matching an existing couple by exact email is a high-confidence
  structured match, no judge needed) — the judge only fires on genuinely
  ambiguous signals, which a handwritten story shouldn't produce. Still:
  pass an explicit low `judgeBudget` (e.g. 1) and treat any judge
  invocation during a reseed run as a signal the story data is too vague,
  not as expected behaviour to budget for.
- Reseeding must never touch a real venue. Hard-fail (not skip) if
  `venueId` isn't one of the four Crestwood ids — same posture as
  `phase2-remerge-operator-columns.mjs`'s venue triple-check.
- Reseeding is a database-writing operation. Like every other script in
  this workstream's remit, this workstream (W4) does not build or run it —
  it's Week 6 (Oct 13-19), a separate pass, likely by whichever agent
  Fable assigns identity/cascade work to (the workstreams table's model
  rule reserves "anything that touches identity, the brain, or
  cross-cutting reads" for Opus).

## 6. Open questions for whoever builds this

1. **Two heat systems.** `weddings.heat_score`/`temperature_tier` (legacy,
   what finding 5 actually observed as "Frozen") and `couples.heat_score`
   (identity-first, per migration 346's comment: "Recomputed by D1 in Phase
   D; NULL while couples is a write-shadow") are different columns on
   different tables. This design targets the legacy one because that's what
   is currently visibly broken and currently read by the UI. Confirm
   whether Phase D's `couples.heat_score` writer exists yet by the time W6
   starts; if it does, the reseed needs to feed both, not just one.
2. **Idempotency strategy.** Two options, not resolved here:
   - **(a) Wipe-and-reseed**: delete every `couples`/`touchpoints`/
     `weddings`/`people` row scoped to the four demo venue ids, then run
     the full story fresh. Simple, guarantees no drift, but "moving heat"
     stops the moment the wipe-reseed cron isn't running (a fresh reseed at
     time T always looks the same relative-freshness at time T, but doesn't
     accumulate real day-to-day movement between runs).
   - **(b) Rolling top-up**: keep existing couples, only append new signals
     near `daysAgo: 0-3` on a schedule (e.g. daily), so heat genuinely moves
     day over day the way a real venue's would, and let old couples age
     into `frozen` naturally over months the way `daily_decay` intends.
     More realistic, more code (needs to track which couples already exist
     across runs, avoid re-minting), and needs its own decay-sweep call
     (`decayStaleCouples`) rather than relying on a full reseed to reset
     state.
   Recommend (b) for the actual Week 6 build — it's the only one that
   delivers on "demo shows moving heat" as an ongoing property rather than
   a one-time fresh coat of paint — but (a) is a legitimate fallback if (b)
   proves too fiddly under the November deadline.
3. **Relationship to migration 392 / `scripts/demo-repair.mjs`.** Once this
   reseed exists and runs on a schedule, the three data fixes those two
   artifacts apply (business_name, escalation_email, DIAG-row cleanup)
   become unnecessary going forward for a properly-reseeded venue — a clean
   reseed won't reintroduce a wrong business name or a real email address.
   They stay useful as a one-time cleanup for whatever's in prod *right
   now*, and as a safety net if a future seed script regresses the same way
   `seed-demo-rich.ts` did (direct INSERT instead of the cascade). Don't
   delete them when the reseed ships; they're cheap insurance.
4. **Which channels.** The story model above lists `gmail | knot |
   instagram | website | calendly | weddingwire` because those are the
   channels the existing per-channel `NormalizedSignal` builders under
   `src/lib/services/identity/sources/` already support. Confirm the full
   adapter list at build time rather than assuming this one is exhaustive.
