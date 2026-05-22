# Bloom House — Engineering Build Plan

**For:** the senior engineer who will own this end to end.  
**From:** Part I (the spine) + Part II (the body) + the battery audit.  
**Mandate:** every piece writes to the spine, every piece reads from the spine, every signal improves Susan's business this week and the collective business of every venue on the platform next quarter.

---

## 1. Engineering doctrine

Six rules. Every architectural decision is an instance of one of these.

**(R1) The spine is the only commit boundary.** Adapters do not write to anywhere except a single normalize-and-handoff function. The healing crons do not write to anywhere except through the same function. Sage does not write at all. The cascade RPC is the only path that mutates `couples` / `touchpoints` / `fragments` / `couple_progression_events` / `couple_merge_events`. If a code path needs to write a couple-level fact and does not go through that RPC, it is a bug.

**(R2) Every signal carries its full provenance.** Every touchpoint records the adapter that produced it, the external id, the raw payload, the rule that bound it to a couple, the timestamp. Nothing is anonymous after ingestion. You can replay any single decision the system made and explain it without re-running the model.

**(R3) Read paths are dumb and stateless.** Surfaces compute from the spine on each load. There is no "computed_at_save_time" denormalization that the read path trusts. The exception is the **derivation cache** layer (Section 6) which exists for cost, not correctness, and is invalidated by spine writes.

**(R4) Multi-tenant from line zero.** Every table has `venue_id`. Every RLS policy enforces venue scope. Every service function takes a `venueId` parameter. The org-admin role gets cross-venue reads through a single explicit policy, never through a side door. Cross-venue intelligence runs on a separate, pre-aggregated read view that does not expose raw rows.

**(R5) Honesty in the runtime, not just in the prompt.** The honesty rails for Sage are prompt-level (refuse, hedge, evidence-required). The honesty rails for Intel surfaces are data-level: every cell carries `n`, every ratio uses null on zero denominator, every aggregation flags below-threshold samples. Sage prompts and Intel surfaces both refuse the same way for the same reason.

**(R6) Test the loop, not the unit.** Unit tests prove the cascade matcher is correct in isolation. Integration tests prove the loop closes: a touchpoint lands → cascade fires → spine writes → Intel re-derives → Sage's next draft references it. The shipping gate is the battery (`BLOOM-TEST-QUESTIONS.md`) running end-to-end against a seeded venue.

---

## 2. The data architecture in detail

### 2.1 Core spine tables

```sql
-- Tenant boundary
venues (
  id              uuid PRIMARY KEY,
  org_id          uuid REFERENCES orgs(id),
  slug            text UNIQUE NOT NULL,
  timezone        text NOT NULL DEFAULT 'America/New_York',
  capacity_tier   text NOT NULL,          -- pricing tier
  created_at      timestamptz NOT NULL DEFAULT now()
)

-- The unit
couples (
  id                      uuid PRIMARY KEY,
  venue_id                uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  lifecycle_state         text NOT NULL CHECK (lifecycle_state IN (
    'channel_scoped', 'resolved', 'booked', 'completed', 'ghost', 'agent'
  )),
  channel_scope           text,                                -- non-null only when lifecycle_state='channel_scoped'
  primary_contact_name    text,
  primary_contact_email   citext,
  primary_contact_phone   text,
  partner_contact_name    text,
  wedding_date            date,
  heat_score              integer NOT NULL DEFAULT 0,
  last_progression_at     timestamptz,
  source_wedding_id       uuid REFERENCES weddings(id),         -- legacy bridge, drops in Phase F
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
)

-- Every signal
touchpoints (
  id              uuid PRIMARY KEY,
  venue_id        uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  couple_id       uuid REFERENCES couples(id) ON DELETE CASCADE,
  channel         text NOT NULL,                              -- gmail | calendly | knot | instagram | sms | web | honeybook | review | ...
  action_type     text NOT NULL,                              -- channel-specific verb
  occurred_at     timestamptz NOT NULL,
  signal_tier     text NOT NULL CHECK (signal_tier IN ('high','medium','low')),
  confidence_tier text CHECK (confidence_tier IN ('high','medium','low')),
  external_id     text NOT NULL,                              -- per-channel dedup key
  raw_payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  adapter         text NOT NULL,                              -- which adapter produced this
  cascade_stage   text,                                        -- which cascade stage bound it
  cascade_reason  text,                                        -- structured-reason string
  UNIQUE (venue_id, channel, external_id)
)

-- Insufficient-identity signals (cannot anchor yet)
fragments (
  id                      uuid PRIMARY KEY,
  venue_id                uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  channel                 text NOT NULL,
  identity_hint           text,
  external_id             text NOT NULL,
  occurred_at             timestamptz NOT NULL,
  raw_payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  adapter                 text NOT NULL,
  promoted_to_couple_id   uuid REFERENCES couples(id),
  promoted_at             timestamptz,
  UNIQUE (venue_id, channel, external_id)
)

-- Inbound-only progression log (the lifecycle clock)
couple_progression_events (
  couple_id            uuid NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
  occurred_at          timestamptz NOT NULL,
  event_type           text NOT NULL CHECK (event_type IN (
    'email_reply','tour_booked','tour_rescheduled','tour_attended',
    'new_channel_inquiry','portal_click','contract_signed',
    'inbound_followup','fragment_match_returned','review_posted'
  )),
  source_touchpoint_id uuid REFERENCES touchpoints(id),
  PRIMARY KEY (couple_id, occurred_at, event_type)
)

-- The audit log (every identity event is here, recoverable)
couple_merge_events (
  id                  uuid PRIMARY KEY,
  venue_id            uuid NOT NULL,
  event_type          text NOT NULL,                       -- 'fragment_promoted' | 'candidate_confirmed' | 'manual_merge' | ...
  primary_couple_id   uuid REFERENCES couples(id),
  secondary_couple_id uuid REFERENCES couples(id),
  operator_id         uuid REFERENCES auth.users(id),
  rule_triggered      text NOT NULL,                       -- which cascade rule + which adapter
  confidence_tier     text,
  reason              text,
  occurred_at         timestamptz NOT NULL DEFAULT now()
)

-- Borderline matches awaiting operator adjudication
candidate_matches (
  id                  uuid PRIMARY KEY,
  venue_id            uuid NOT NULL,
  primary_record_id   uuid NOT NULL,
  primary_record_type text NOT NULL CHECK (primary_record_type IN ('couple','fragment','touchpoint')),
  secondary_record_id   uuid NOT NULL,
  secondary_record_type text NOT NULL,
  confidence_tier     text NOT NULL,
  matcher_reason      text,
  judge_reason        text,                                -- LLM judge note when fired
  resolution          text,                                -- null | 'confirmed' | 'rejected' | 'deferred'
  resolved_by         uuid REFERENCES auth.users(id),
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, primary_record_id, primary_record_type, secondary_record_id, secondary_record_type)
)
```

### 2.2 First-class entities promoted from the audit gap

```sql
-- Tours (Part II §11)
tours (
  id                      uuid PRIMARY KEY,
  venue_id                uuid NOT NULL REFERENCES venues(id),
  couple_id               uuid NOT NULL REFERENCES couples(id),
  scheduled_at            timestamptz NOT NULL,
  actual_at               timestamptz,
  outcome                 text CHECK (outcome IN ('attended','no_show','cancelled','rescheduled','scheduled')),
  conducted_by            uuid REFERENCES auth.users(id),
  pre_tour_snapshot       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- heat, channel, journey, sage prediction
  post_tour_brief         text,                                  -- coordinator capture
  couple_feedback         jsonb DEFAULT '{}'::jsonb,             -- structured + open-ended
  outcome_attribution     uuid REFERENCES couple_progression_events(occurred_at),  -- which downstream event closed this
  created_at              timestamptz NOT NULL DEFAULT now()
)

-- Reviews (Part II §12)
reviews (
  id                      uuid PRIMARY KEY,
  venue_id                uuid NOT NULL REFERENCES venues(id),
  couple_id               uuid REFERENCES couples(id),            -- null when unbound
  source                  text NOT NULL,                          -- 'google' | 'knot' | 'wedding_wire' | 'yelp' | 'operator_pasted'
  external_id             text,
  rating                  numeric(2,1),
  body                    text NOT NULL,
  posted_at               timestamptz NOT NULL,
  themes                  jsonb DEFAULT '[]'::jsonb,              -- extracted theme tags
  sentiment               numeric(3,2),                            -- -1.00 to +1.00
  bound_via               text,                                    -- how we matched to couple
  ingested_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, source, external_id)
)
```

### 2.3 External context (per audit Q9, Q10, Q12)

```sql
-- Per-venue external context that correlates with cohort behavior
-- (NOT bound to couples; this is the layer the Intel reads alongside the spine)
external_context (
  id              uuid PRIMARY KEY,
  venue_id        uuid NOT NULL,
  context_type    text NOT NULL,         -- 'weather' | 'fred' | 'holiday' | 'competitor_event' | 'cultural_moment'
  occurred_on     date NOT NULL,         -- daily granularity is enough
  value_numeric   numeric,
  value_text      text,
  raw_payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  source          text NOT NULL,         -- provider id
  UNIQUE (venue_id, context_type, occurred_on, source)
)
```

### 2.4 RLS model

```sql
-- One template, applied to every table that has venue_id
CREATE POLICY "venue_scoped_read" ON couples
  FOR SELECT USING (
    venue_id IN (
      SELECT venue_id FROM venue_members
       WHERE user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM org_admins
       WHERE org_id = (SELECT org_id FROM venues WHERE id = couples.venue_id)
         AND user_id = auth.uid()
    )
  );

-- Service-role bypasses RLS; only cascade RPC + crons use service role.
-- Anon role has no access except specific public-CORS endpoints
-- (calculator submission, public review-collection forms).
```

Every table that has `venue_id` gets the same shape policy. There is no exception. Cross-venue reads use the materialized aggregates in Section 8, not raw rows.

---

## 3. The cascade engine

### 3.1 The single RPC

The cascade is one Postgres function. Every adapter calls it. Nothing else writes to the spine.

```sql
CREATE OR REPLACE FUNCTION cascade_resolve_and_attach(
  p_venue_id          uuid,
  p_signal            jsonb,             -- normalized signal shape
  p_adapter           text,
  p_correlation_id    uuid DEFAULT gen_random_uuid()
) RETURNS jsonb               -- { matched: bool, couple_id, stage, reason, touchpoint_id, ... }
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_lock_key      text;
  v_couple_id     uuid;
  v_stage         text;
  v_reason        text;
  v_touchpoint_id uuid;
BEGIN
  -- 1. Compute advisory lock key (email -> phone -> handle: -> signal:floor)
  v_lock_key := compute_lock_key(p_venue_id, p_signal);
  PERFORM pg_advisory_xact_lock(hashtext(v_lock_key));

  -- 2. Run the 8-stage cascade in the same transaction
  SELECT * INTO v_couple_id, v_stage, v_reason
  FROM run_cascade_match(p_venue_id, p_signal);

  -- 3. If cascade matched, attach touchpoint to that couple
  --    If cascade missed AND signal has sufficient identity, mint a channel_scoped couple
  --    If cascade missed AND signal is identity-poor, write a fragment instead
  -- 4. Fire progression event if action_type qualifies
  -- 5. Update couples.last_progression_at + heat_score
  -- 6. Insert couple_merge_events audit row

  RETURN jsonb_build_object(
    'matched',       v_couple_id IS NOT NULL,
    'couple_id',     v_couple_id,
    'stage',         v_stage,
    'reason',        v_reason,
    'touchpoint_id', v_touchpoint_id,
    'correlation_id', p_correlation_id
  );
END;
$$;
```

The advisory lock guarantees the email/phone double-mint race is closed. The transaction guarantees no half-state leaks. The audit row is written in the same transaction so the audit can never disagree with the action.

### 3.2 The cascade as TypeScript

The 8-stage logic lives in TypeScript, not in SQL, because the rules involve string normalization, nickname dictionary lookups, regex over body text, and the LLM judge for ambiguous mid-band scores. TypeScript runs in a Vercel function that the RPC delegates to via a `SECURITY DEFINER` function-as-router pattern OR the cascade runs entirely in TS and the RPC is only the lock + write.

**Decision: cascade logic in TS, RPC is the write contract.** The TS cascade calls the RPC once with `(venue_id, signal, stage_decision)`. The RPC validates the decision, acquires the lock, performs the write, returns the audit row. This keeps the matching code testable in isolation and the write code minimal.

```ts
async function ingestSignal(
  venueId: string,
  signal: NormalizedSignal,
  adapter: string,
): Promise<CascadeResult> {
  // 1. Load the candidate set the cascade will compare against.
  const candidates = await loadCascadeCandidates(venueId, signal)

  // 2. Run the 8-stage cascade.
  const verdict = cascadeMatch(signal, candidates)

  // 3. Hand the decision + the signal to the RPC for the write.
  return supabase.rpc('cascade_attach_signal', {
    p_venue_id: venueId,
    p_signal: signal,
    p_adapter: adapter,
    p_verdict: verdict,  // { matched, coupleId, stage, evidence } or { matched: false }
  })
}
```

### 3.3 The judge band

Scores between 40 and 90 trigger the LLM judge. The judge is a Sonnet call with a tightly-bounded context: the two records, the recent touchpoint timeline of each, the matcher's reason, the venue's identity-resolution preferences. It returns confirm/reject + a one-sentence reason that gets written to `candidate_matches.judge_reason`. The judge never writes to the spine directly; it writes back into the cascade verdict and the cascade decides.

---

## 4. The adapter layer

Every external source has exactly one adapter. Adapters share one interface.

```ts
interface SignalAdapter {
  name: string                                   // 'gmail' | 'calendly' | 'honeybook' | 'knot_csv' | ...
  normalize(raw: unknown): NormalizedSignal[]    // payload → 0..N normalized signals
  externalIdFor(raw: unknown): string            // per-channel dedup key
  contextLookup(signal: NormalizedSignal): ExternalContextRef[]   // weather / FRED / cultural moments
}

interface NormalizedSignal {
  channel: string
  actionType: string
  occurredAt: string                             // ISO
  identityHint?: {
    primaryEmail?: string
    primaryPhone?: string
    firstName?: string
    lastName?: string
    partnerFirstName?: string
    partnerLastName?: string
    weddingDate?: string
    bodyText?: string
    bodyEmails?: string[]
    bodyPhones?: string[]
  }
  signalTier: 'high' | 'medium' | 'low'
  rawPayload: Record<string, unknown>
}
```

Adapters live at `src/lib/adapters/<source>.ts`. They have no side effects outside of returning a list of `NormalizedSignal`. The orchestrator (a single function `processSignal`) takes the normalized signal, hands it to `ingestSignal`, and is done. Adapters that get webhook deliveries run inside an HTTP handler that calls `adapter.normalize(req.body)` → `processSignal(normalized)`. Adapters that poll (Gmail) run inside a cron that fetches a batch, normalizes each, and processes each.

This means adding a new channel is a single file + a webhook route. There is no other place to touch.

---

## 5. The Sage layer

### 5.1 Prompt assembly

Sage prompts share one assembler:

```ts
buildCoordinatorPrompt({
  venueId,
  surface,                  // 'agent_draft' | 'nlq_intel' | 'briefing_weekly' | ...
  taskInstructions,
  honestyRails,             // boolean — true for every operator-facing surface
  coupleContextBlock,       // optional spine context for a single couple
  coupleNotesBlock,         // optional tone-fuel notes
  numbersGuard,             // optional allowlist of facts the LLM may quote
  contentTier               // 1 = per-couple PII, 2 = venue-aggregate
})
```

The assembler glues `UNIVERSAL_RULES + COORDINATOR_RULES + personality + coupleNotesBlock + coupleContextBlock + honestyRailsBlock + numbersGuardBlock + taskBlock`. One canonical order. Every surface uses this. The personality block comes from `loadCoordinatorPersonalityData(venueId)`, which reads the venue's voice DNA + banned phrases + USPs + signoff.

### 5.2 The voice learning loop

Every approved+sent draft writes a `voice_learning_event` row:

```sql
voice_learning_events (
  id              uuid PRIMARY KEY,
  venue_id        uuid NOT NULL,
  surface         text NOT NULL,
  ai_draft        text NOT NULL,
  operator_final  text NOT NULL,
  diff_metadata   jsonb,                  -- structured diff stats (additions, deletions, tone shift)
  approved_by     uuid REFERENCES auth.users(id),
  approved_at     timestamptz NOT NULL DEFAULT now()
)
```

A nightly job reads the last 200 events per venue, asks Sage to extract patterns ("you tend to add a second paragraph that mentions venue logistics; you remove the word 'absolutely' from drafts; you swap 'reach out' for 'get in touch'"), and stores the patterns in `venue_voice_dna`. The next prompt assembly reads the updated voice DNA. Loop 1 closes.

### 5.3 Cost + circuit-breaking

Every `callAI` invocation logs to `api_costs`:

```sql
api_costs (
  id              uuid PRIMARY KEY,
  venue_id        uuid NOT NULL,
  surface         text NOT NULL,
  prompt_version  text NOT NULL,
  task_type       text NOT NULL,
  input_tokens    integer NOT NULL,
  output_tokens   integer NOT NULL,
  cost_cents      integer NOT NULL,
  latency_ms      integer,
  outcome         text CHECK (outcome IN ('ok','error','refusal','timeout')),
  occurred_at     timestamptz NOT NULL DEFAULT now()
)
```

Circuit breaker: a per-venue cap on monthly AI spend reads `api_costs` rolling-30d; over the cap, Sage degrades from Sonnet to Haiku, then to template fallback. The operator is notified before degradation, not after.

---

## 6. The intel computation layer

Two-tier computation: real-time derivations from the spine, batch aggregates for cohort queries.

### 6.1 Real-time (every page load)

Surfaces that show 1-2 couples or one cohort with N < 5,000: load the slice of the spine in one request, derive in TypeScript, render. No caching. This is `/intel/cohort`, `/intel/attribution`, `/intel/heat`, `/intel/source-quality`, the journey ribbon. Page load measured in 100-300ms is acceptable.

### 6.2 Batch aggregates (overnight cron)

Surfaces that need cross-couple or cross-venue rollups: a nightly cron writes pre-aggregated rows to `intel_rollups`:

```sql
intel_rollups (
  id              uuid PRIMARY KEY,
  venue_id        uuid NOT NULL,
  rollup_type     text NOT NULL,         -- 'cohort_funnel_monthly' | 'attribution_quarterly' | 'voice_dna' | ...
  scope_key       text NOT NULL,          -- 'all' | 'spring_2026' | 'channel:knot' | ...
  payload         jsonb NOT NULL,
  computed_at     timestamptz NOT NULL,
  computation_ms  integer,
  UNIQUE (venue_id, rollup_type, scope_key)
)
```

Read paths first check `intel_rollups` for a fresh row; if absent or stale, fall back to live derivation. The cron is the cache filler. Invalidation: any cascade write touches `intel_rollups.computed_at` cache TTL, but does not delete; surfaces decide if stale-is-good-enough based on their use case.

### 6.3 What we never do

We do not denormalize at write time. We do not compute heat at write time and trust the stored value forever. We do not store "computed at" facts that other tables depend on as primary read keys. The spine has the truth. Everything else is cache or derivation.

---

## 7. Healing crons

Every cron is idempotent on rerun. Every cron is per-venue (sharded by `venue_id`) so a slow venue does not stall the rest. Every cron writes a `cron_runs` row with venue_id, run_at, duration_ms, rows_touched, errors.

| Cron | Frequency | Purpose |
|---|---|---|
| `gmail_poll` | every 5 min | Pull new threads for connected venues; route each message to the email adapter. |
| `cascade_drain` | every 2 min | Drain unbound interactions older than 7 days; re-run cascade with fresh candidate set. |
| `decay_sweep` | daily 4 AM venue-local | Flip `resolved` couples quiet > 180d to `ghost`. |
| `post_wedding_sweep` | daily 4 AM venue-local | Flip `booked` couples whose `wedding_date < now` to `completed`. |
| `attendance_sweep` | daily 6 AM venue-local | Flip tours past scheduled time without cancellation to `tour_attended`. |
| `review_ingest` | hourly | Pull Google Places + connected platforms; match incoming reviews to couples. |
| `voice_dna_refresh` | nightly | Re-derive voice patterns from last 200 approved drafts. |
| `intel_rollups_refresh` | nightly | Refill `intel_rollups` for changed venues. |
| `external_context_refresh` | nightly | Pull FRED, weather forecasts, cultural moments. |
| `couple_intel_refresh` | nightly | Re-derive per-couple intelligence: close probability, key signals, look-alike cohort. |
| `lifecycle_audit_sweep` | weekly | Run the lifecycle drift detector across all couples; auto-apply terminal-positive transitions, queue ambiguous ones. |
| `battery_smoketest` | weekly | Run a 6-question subset of the battery against a synthetic seeded venue; alert on score drop. |

Cron infrastructure: Vercel Cron + a `cron_dispatch` endpoint that takes a venue_id, enforces a per-venue execution lock, and runs the named cron. The dispatch endpoint is what gets scheduled; cron names are config.

---

## 8. Multi-venue + cross-venue intelligence

This is the lever that makes Bloom a platform, not a per-venue tool.

### 8.1 Per-venue is the default

By default, every read is venue-scoped. Susan sees Susan's data. Sage's voice DNA is hers. Her attribution numbers are hers. Her heat scores are derived from her cohort.

### 8.2 Cross-venue learning of the model, never the data

The matcher, the LLM judge prompts, the cascade rules, the voice-DNA extraction strategy, the heat scoring algorithm, the prediction model coefficients — these are global. They get better as the platform sees more venues. They are deployed via code, not stored per-venue.

When the matcher learns that "Tim ↔ Timothy" is a real nickname pair, every venue benefits the next deploy. When the judge prompt gets a new honesty rail because one venue caught a confabulation, every venue benefits.

### 8.3 Cross-venue aggregated benchmarks

```sql
platform_benchmarks (
  id              uuid PRIMARY KEY,
  metric_key      text NOT NULL,                  -- 'response_time_median_hours' | 'tour_to_book_rate' | ...
  segment_key     text NOT NULL,                  -- 'all' | 'capacity_tier:growth' | 'region:mid_atlantic' | ...
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  n_venues        integer NOT NULL,
  p10             numeric,
  p25             numeric,
  p50             numeric,
  p75             numeric,
  p90             numeric,
  computed_at     timestamptz NOT NULL,
  UNIQUE (metric_key, segment_key, period_start)
)
```

A nightly job reads `intel_rollups` across every venue, aggregates by capacity tier + region + venue type, writes distribution percentiles to `platform_benchmarks`. Susan sees "Your tour-to-book rate is in the 60th percentile of growth-tier venues in your region." She does not see what any specific other venue did. Other venues are anonymized into a distribution.

This is the only legitimate cross-venue read. No surface ever reads another venue's rows directly.

### 8.4 Federated patterns

The text-pattern extractor surfaces themes per venue ("16 of your last 40 couples mentioned 'climate-control'"). A nightly platform-level job extracts cross-venue themes ("Climate-control mentions are up 38% platform-wide year-over-year, concentrated in southeast venues"). Susan sees both: her own themes + her segment's themes. Her data is not pooled into the segment without her org's consent.

---

## 9. Observability + alerting

Every meaningful event emits a structured log line via `logEvent`:

```ts
logEvent({
  level: 'info' | 'warn' | 'error',
  msg: 'identity.cascade.matched',
  venue_id: '...',
  correlation_id: '...',          // threaded through the request
  actor: 'gmail_adapter',
  event_type: 'cascade_match',
  outcome: 'ok',
  latency_ms: 123,
  data: { stage: 'exact_email', couple_id: '...' }
})
```

These land in Postgres for short-term + S3 for long-term. We do not use a third-party observability vendor for the spine; we own the data path.

### 9.1 What we alert on

- Cascade match rate drops more than 2 standard deviations below the trailing 14-day mean for any venue (signals an adapter break or a data shape change)
- LLM judge band volume drops to zero for >24h (signals the cascade is wrongly auto-deciding)
- Touchpoint write rate drops to zero for any active venue >2h (signals an adapter outage)
- AI cost per venue hits 80% of the monthly cap
- Battery smoketest score drops more than 0.5 (signals a regression)
- Any `lifecycle_state` value the system writes that violates the CHECK constraint (means a migration was applied wrong)

### 9.2 What we measure but do not alert on

Per-venue daily: signals ingested, cascade decisions by stage, candidate_matches resolved by operator, drafts generated, drafts approved-without-edit ratio, voice-DNA stability score, intel rollup freshness, total AI spend.

Per-platform weekly: matcher precision/recall on the labeled fixture set, judge agreement with operator decisions, battery distribution across all venues.

---

## 10. Testing

### 10.1 Unit tests

Every cascade stage. Every adapter `normalize`. Every healing cron's predicate. Every honesty rail's prompt-side and post-call inspector. Every Intel derivation function. Target: 80% line coverage on `src/lib/services/identity/*`, `src/lib/adapters/*`, `src/lib/services/cohort/*`. Vitest. CI gate on PR.

### 10.2 Integration tests

Per-loop integration tests using a seeded test venue:

```
test/loop1_voice.spec.ts        Draft → edit → send → voice DNA updates → next draft matches edit pattern
test/loop2_prediction.spec.ts   Inquiry → tour booked → tour attended → coordinator brief → outcome → prediction model uses brief
test/loop3_attribution.spec.ts  Knot signal → website signal → email signal → booking → attribution credits Knot under first-touch
test/loop4_positioning.spec.ts  Review arrives → theme extracted → Sage draft references theme
test/loop5_capacity.spec.ts     Operator marks high-capacity → auto-send pace slows → follow-ups delay
test/cascade_8stage.spec.ts     Every cascade stage fires correctly on synthetic signals
test/multi_venue_isolation.spec.ts  Venue A user cannot read Venue B rows via any endpoint
test/honesty_rails.spec.ts      Forecast question gets hedged; sensitive-theme question aggregates; false premise gets challenged
```

### 10.3 The battery as ship gate

`BLOOM-TEST-QUESTIONS.md` is the acceptance test. CI runs the battery against a seeded fixture venue on every PR to master. Average score must hold at ≥ +1.0; zero −3 in Tier 4. Below threshold, PR cannot merge.

The battery runner is a script: feeds each of the 36 questions through the NLQ endpoint, captures the answer, scores it against a stored expected-shape (regex + presence of evidence quotes + refusal/hedge detection). It is not perfect, but it catches the most-dangerous regressions.

### 10.4 Synthetic data

A seeding tool produces a fixture venue with 200 couples, 1,500 touchpoints, 80 tours, 40 reviews, distributed across channels, with ground-truth labels for what every metric should return. The seed is committed; tests run against it deterministically.

---

## 11. Deploy + rollback

### 11.1 Infrastructure

- Frontend + API: Next.js 16 on Vercel with Fluid Compute (Node.js 24, default 300s timeout)
- Data: Supabase Postgres (per-org project, eventually shared) + Supabase Storage for uploads
- AI: Anthropic API (Sonnet default, Haiku for classifiers, fallback to OpenAI via circuit breaker)
- Email: Resend for transactional, Gmail OAuth for venue mailbox
- Crons: Vercel Cron triggers + `cron_dispatch` endpoint
- Observability: Postgres + S3 archive

### 11.2 Migrations

Every schema change is a numbered SQL migration. Migrations are idempotent (`IF NOT EXISTS`, `DROP IF EXISTS` first if recreating). Migrations are applied per Supabase project. The `migrations` table tracks applied state. No code deploys until migrations on the target project are at HEAD.

### 11.3 Cascade rule changes

The cascade rules are versioned. A new stage or a tightened guard ships behind a feature flag (`cascade_v2_enabled`) per venue. Roll out: shadow-run the new cascade alongside the live one for 7 days, comparing decisions, then flip the flag. If the new cascade rejects more historical matches than expected, flip back.

### 11.4 Rollback

Every commit on master is a tag. Database migrations are forward-only by design; rollback is a new migration that reverses, never a backward apply. The Supabase persistent-branch feature is used for any migration that is hard to reverse; we test the migration on the branch first, promote when stable.

---

## 12. AI cost discipline

### 12.1 Model selection per surface

| Surface | Model | Why |
|---|---|---|
| Cascade match | none (pure code) | Determinism matters more than smarts |
| LLM judge (cascade band) | Sonnet | Adjudication needs reasoning |
| Inbound classifier | Haiku | Fast + cheap; volume is high |
| Agent draft | Sonnet | Voice fidelity matters |
| Sage NLQ | Sonnet | Reasoning + honesty calibration |
| Voice DNA extraction | Sonnet | Pattern recognition |
| Couple intel (close prob + key signals) | Sonnet | Per-couple, hourly cron, ~$0.02 each |
| Briefing/digest narration | Sonnet | Operator reads these; quality is the cost |
| Identity profile reconstruction | Sonnet | Forensic; one-time per couple |
| Review theme extraction | Haiku | Volume + simple task |

### 12.2 Per-venue monthly target

A `growth` tier venue should sit at ~$35/month of AI cost across all surfaces. A `multi` tier venue should sit at ~$120. The circuit breaker fires at 130% of target; degrades to Haiku at 150%; falls back to templates at 200%. Susan sees a card on her billing page showing actual + projection.

### 12.3 What we cache

Prompts that produce the same output across runs (theme extraction over an unchanged review body; identity profile over an unchanged email set) are cached by content hash for 30 days. Cache key includes the prompt version so a prompt-version bump invalidates cache automatically.

---

## 13. The 90-day build sequence in engineering detail

### Days 1-15: foundation

- Database: spine tables + tours + reviews + external_context + audit + cron infra
- Cascade RPC + TS cascade matcher (8 stages, nickname dict, email-localpart segmenter)
- Adapter interface + Gmail adapter (read only)
- Cron dispatch + first cron (gmail_poll)
- Auth + multi-tenant boundary + RLS policies
- Synthetic fixture venue + seed script

**Deliverable:** pour 12 months of one venue's Gmail through the cascade; couples table is correct; audit row exists for every decision.

### Days 16-30: tours + the spine completeness gate

- Calendly adapter (webhook + API)
- Tours table + tour writer (called from Calendly adapter)
- HoneyBook adapter (CSV + webhook)
- Healing crons: decay_sweep, post_wedding_sweep, attendance_sweep
- Identity audit + drift detection
- Lifecycle audit cron + bulk-apply UI

**Deliverable:** the spine + tours + cleanup heals itself overnight. Day 30 demo: pour 18 months of three sources through, run the audits, surface drift, apply bulk fixes, end with a clean spine.

### Days 31-45: the Agent + Loop 1

- Email pipeline (inbound classification, draft generation, send via Gmail)
- Coordinator inbox UI
- Voice DNA storage + extraction nightly cron
- `voice_learning_events` writes on every approve+send
- Auto-send rules + per-thread + per-day caps
- Sensitive-theme detection + handle-with-care UI

**Deliverable:** Loop 1 closes. Day 45 demo: coordinator's daily inbox is in Bloom; her edits over a week change Sage's drafts visibly toward her voice.

### Days 46-60: Intel surfaces

- Cohort intelligence (funnel, response time, lead time, curve, text patterns, YoY, anomalies, weather × tour)
- Source attribution (four models, per-couple ribbon, content mentions)
- Heat distribution + extremes
- Source quality scorecard
- Journey ribbon
- Identity report (Q6/29/30/36)
- Suspect-merges queue

**Deliverable:** every Intel surface reads from the spine. Day 60 demo: walk the battery question-by-question.

### Days 61-75: the Portal + Loop 4

- Couple portal subdomain routing per venue
- Sage couple-facing chat with couple ribbon context
- Contract + timeline + checklist + vendor list
- Couple-side feedback capture (post-tour, periodic check-in)
- Review ingestion (Google Places + operator paste)
- Review-to-couple binding
- Theme extraction nightly cron

**Deliverable:** Loop 4 closes. A booked couple uses the portal; reviews ingest and bind to couples; Sage's drafts reference review-language themes.

### Days 76-90: prediction, attribution, the rest

- Couple intel cron (close probability, key signals, look-alike cohort)
- Attribution backtrace (post-hoc source recovery for legacy bookings)
- Cross-venue platform_benchmarks rollup
- Battery CI gate
- Cost dashboard + circuit breaker
- Onboarding flow + the 5-day enterprise project guide

**Deliverable:** every loop closes. Battery score ≥ +1.0. First paying venue onboarded end-to-end.

---

## 14. The hard verification gates

Each phase has one gate question that has to answer yes before moving on.

| Phase | Gate question |
|---|---|
| Days 15 | Does every Gmail message in the test fixture land in `touchpoints` with the right `couple_id`, the right `cascade_stage`, and an audit row in `couple_merge_events`? |
| Day 30 | After 24h with no human intervention, is the spine state internally consistent (no lifecycle drift, no orphan touchpoints, no past-wedding-still-booked)? |
| Day 45 | After 7 days of operator use, is the operator's edit distance on drafts measurably lower than day 1? |
| Day 60 | When I ask Sage one of the battery questions, does the answer cite specific evidence from the spine? |
| Day 75 | When a review arrives bound to a couple I drafted to last week, does the next draft I send to a similar couple use the review's language? |
| Day 90 | Battery average ≥ +1.0. Zero −3 in Tier 4. Tier 9 chain succeeds. |

If any gate fails, that phase is not done. Do not move on. The temptation to ship a phase that is "mostly working" is the single most common way Bloom-shaped products fail.

---

That is the engineering plan. Hand it to a senior engineer; they have everything they need to start writing the first migration and not stop until the battery passes.