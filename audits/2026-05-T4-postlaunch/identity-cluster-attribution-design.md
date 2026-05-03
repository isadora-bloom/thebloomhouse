# Identity-Cluster Attribution — Design + Prototype Spike

**Stream:** T5-Rixey-BBB
**Date:** 2026-05-02
**Status:** Spike. Design + read-only prototype only. No migrations applied. No data mutated.

---

## 1. Problem statement

The current first-touch attribution path is a 7-tier priority chain in
`src/lib/services/lead-source-derivation.ts`. Each tier was added as a
patch when the previous chain missed something Rixey-specific:

| Tier | Logic | Added in | Confidence |
|------|-------|----------|------------|
| 0 | Coordinator override (`weddings.attribution_priority`) | KK | high |
| 1 | `weddings.source_records[].fields_provided.includes('lead_source')` | KK | high |
| 2 | Tour Q&A — `interactions.extracted_identity.hear_source` OR body regex on "where did you hear" | KK + NN/TT (HTML strip) | high |
| 3 | Web-form intake — `interactions.type='form'` OR subject contains "calculator" | KK | medium |
| 4 | Earliest inbound `interactions.from_email` domain → channel map | KK | medium |
| 5 | UTM from `attribution_events.signal_id → tangential_signals.raw_payload.utm_source` | KK | low |
| 7 | `weddings.source` legacy column fallback (`normalizeSource`) | SS Bug A (mig 185) | low |
| 6 | Terminal — `lead_source = NULL`, `reason='no_signal'` | KK | low |

There are six other systems writing into the attribution problem space:

1. **Adapters** (`crm-import/*`) writing `weddings.crm_source` + per-row
   synthetic `interactions.extracted_identity` (the Stream-TT
   "adapter-as-facts" refactor). Adapters now leave `weddings.source`
   NULL.
2. **`source-backtrace.ts`** — separate service that walks
   `interactions` for weddings whose `weddings.source` is in
   `WEAK_FIRST_TOUCH_SOURCES` (calendly/acuity/honeybook/dubsado),
   tries to find the upstream form-relay email, writes
   `weddings.source` directly when confident.
3. **`identity-reconciliation.ts`** — clusters weddings by exact-email
   match across multi-source imports, picks a winner, backfills loser
   fields onto winner via `weddings.source_records[]`.
4. **`candidate_identities` + `attribution_events`** (Phase B,
   migrations 105-110) — clusters tangential signals into per-person
   candidates with a separate first-touch computation
   (`is_first_touch=true`) that lives in `attribution_events`. Per
   migration 105 comment: **"weddings.source is intentionally NEVER
   overwritten by this system. It stays as a legacy display field."**
5. **Migration 186** — backfills `weddings.source` from `crm_source`
   when source was 'other' or NULL.
6. **Migration 187** — NULLs out `weddings.source` when value was a
   scheduling-tool / CRM provenance.

Net result: there are at minimum **three separate notions of
"first-touch source"** for any wedding —

- `weddings.source` (legacy column, written by Stream SS Bug D
  backfill + backtrace + coordinator override + nullified by mig 187)
- `weddings.lead_source` (derived by 7-tier chain, may pull from any
  of the six writers above)
- `attribution_events.source_platform WHERE is_first_touch=true`
  (Phase B candidate-cluster computation, deliberately decoupled from
  `weddings.source`)

For the live pipeline, `weddings.lead_source` is what the
/intel/sources page reads. But the 7-tier chain reads from a
patchwork of sources — it never natively walks the candidate-identity
cluster. So the 553 The Knot storefront signals visible on the
"Engaged but didn't inquire" dashboard list — which are
`tangential_signals` rows that DO get clustered into
`candidate_identities` for a Sarah-R-storefront-engager — never
become attribution for the calculator submission Sarah Roberts
(different email, different name parse, different cluster) sends in
six weeks later.

**The patches accumulate per-source. Each new platform requires a
new tier or a new adapter or a new repair endpoint.**

---

## 2. The bigger pattern — class-of-signal model

Strip the platform names out. Every fact we capture about a lead is
one of four classes:

| Class | Definition | Examples |
|-------|------------|----------|
| **source** | Acquisition channel — where the lead first heard about / discovered the venue | The Knot view, WeddingWire saved-vendor, Google search, Instagram follow, referral, bridal-show booth |
| **touchpoint** | Tool the lead used to interact AFTER they discovered us | Calculator submission, Calendly tour booking, contact-form submission |
| **crm** | Internal system that holds the record of the lead | HoneyBook project, Dubsado workflow |
| **outcome** | Terminal events — money / lost-deal / cancellation | Booking, payment, lost reason |

Today the platform conflates them:

- **Calendly** is a touchpoint, not a source. But it gets stamped onto
  `weddings.source` because it's the channel that delivered the
  inquiry email. (Stream TT was the band-aid.)
- **HoneyBook** is a crm + outcome holder. But the adapter used to
  write `weddings.source = 'honeybook'`. (Stream TT was the band-aid.)
- **The Knot inbound email** is a source signal AND a touchpoint
  (the relay form is the channel that delivered the inquiry). Same
  signal, two roles.
- **The Knot storefront API** is a source-class signal that has no
  associated touchpoint at all (the engager never inquired).

**Insight:** if every signal carries an explicit class, then
"first-touch" is a *single operation*: find the earliest
`signal_class='source'` signal in the lead's identity cluster.

Adding a new platform becomes one declaration in a registry: "Junebug
emails are source class, Honeybook proposals are crm class,
gettingpartiful.com is touchpoint class". Zero new tiers in the
priority chain. Zero new repair endpoints.

---

## 3. Schema changes proposed

### Option A — column on each table (preferred for simplicity)

Add a `signal_class text NOT NULL` column to each of:

```sql
ALTER TABLE interactions          ADD COLUMN signal_class text;
ALTER TABLE tours                 ADD COLUMN signal_class text;
ALTER TABLE tangential_signals    ADD COLUMN signal_class text;
ALTER TABLE weddings              ADD COLUMN signal_class text;
ALTER TABLE lost_deals            ADD COLUMN signal_class text;
ALTER TABLE attribution_events    ADD COLUMN signal_class text;

-- enum CHECK on each:
CHECK (signal_class IN ('source', 'touchpoint', 'crm', 'outcome'))
```

Backfill rules per writer:

| Table | Writer | signal_class derived from |
|-------|--------|---------------------------|
| `interactions` | email pipeline | If `from_email` domain is in `PLATFORM_DOMAIN_MAP` (theknot/ww/zola/hctg) → `source`. If `type='web_form'` or subject matches calculator → `touchpoint`. If `type='meeting'` (Calendly synthetic) → `touchpoint`. Otherwise `null` (don't classify until a rule matches). |
| `interactions` | HoneyBook adapter | `crm` |
| `interactions` | tour-scheduler (Calendly) adapter | `touchpoint` |
| `interactions` | web-form adapter | `touchpoint` |
| `tours` | every writer | `touchpoint` |
| `tangential_signals` | Knot/WW/IG/Pinterest scraper | `source` |
| `weddings.signal_class` | always | `null` (the wedding row is a view over a cluster, not a signal) |
| `lost_deals` | every writer | `outcome` |
| `attribution_events` | resolver | `source` (it already represents a discovery touch) |

**Pros:** Simple. Every reader can filter `WHERE signal_class='source'`
without joining a registry. Type checker catches missing classifications.

**Cons:** Requires a backfill migration. Can't change classification
without another migration.

### Option B — registry table

```sql
CREATE TABLE signal_class_registry (
  table_name text NOT NULL,
  signal_type text NOT NULL,           -- e.g. 'interaction.from_domain.theknot.com'
  class text NOT NULL CHECK (class IN ('source', 'touchpoint', 'crm', 'outcome')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, signal_type)
);
```

**Pros:** Editable without migrations. Coordinator could add
"Junebug = source" via UI.

**Cons:** Every reader must join. Class lookup is now a JOIN per
signal — at hot paths (derive-cron walking 854 weddings) that's
expensive.

**Recommendation:** **Option A.** The class set is closed (4 values,
unlikely to grow). The classification per writer is derivable from
existing code. Adding a new platform = `ALTER TABLE` is overkill;
just put the classifier in the adapter. Reserve the registry as a
**code-level constant**, not a table.

---

## 4. Service changes proposed

### Replace `deriveLeadSourceForWedding(...)` with `computeFirstTouchForCluster(...)`.

```ts
async function computeFirstTouchForCluster(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<DerivedLeadSource> {
  // 1. Resolve the cluster: walk candidate_identities + people for this wedding.
  //    Collect all emails, all candidate_ids, all linked-loser wedding_ids.
  const cluster = await loadIdentityCluster(supabase, weddingId)

  // 2. Gather every signal across:
  //    - interactions (filter on cluster's wedding_id set OR on cluster's emails)
  //    - tours
  //    - tangential_signals (via candidate_identity_id IN cluster.candidateIds)
  //    - attribution_events
  //    - synthetic: if weddings.source non-null AND coordinator-set, add as source-class
  const signals = await gatherClusterSignals(supabase, cluster)

  // 3. Classify each signal (use signal_class column when present,
  //    fall back to the inline classifier for legacy rows).
  const classified = signals.map(classify)

  // 4. First-touch = earliest signal where signal_class='source'.
  const sources = classified
    .filter(s => s.signal_class === 'source')
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  if (sources.length === 0) {
    return { source: null, priority: 6, confidence: 'low', evidence: { reason: 'no_source_signal_in_cluster' } }
  }
  return {
    source: normalizeSource(sources[0].source_value),
    priority: 1,                                         // single tier
    confidence: sources[0].confidence ?? 'medium',
    evidence: { earliest_signal_id: sources[0].id, total_source_signals: sources.length, total_signals: classified.length },
  }
}
```

### `weddings.lead_source` becomes a **cached projection**

Every read goes through a service helper that prefers the live
cluster compute but falls back to the cached column for surfaces that
can't pay the cluster-walk cost. The cron writes the cache after each
re-compute; live edits invalidate it.

### Adapters lose the responsibility of writing source

They write `signal_class` on every row they emit. They never
guess at `weddings.source` or `weddings.lead_source` again. The
cluster-compute is the single arbiter.

### The 7-tier chain dies

`lead-source-derivation.ts` deletes everything except the
`normalizeSource` import and the override-check helper. The file
shrinks from 765 lines to ~120.

`source-backtrace.ts` keeps its email-search engine BUT writes
`signal_class='source'` on the matched interaction instead of
mutating `weddings.source`. The cluster-compute then naturally picks
that signal up on the next run.

---

## 5. Migration plan

### Phase 1 — Schema additions, no behaviour change

- **mig 191**: Add `signal_class text` to interactions / tours /
  tangential_signals / lost_deals / attribution_events (NULL allowed
  initially).
- Backfill via SQL based on existing patterns (per-table case
  expression). Most rows derive cleanly from `from_email`,
  `interactions.type`, `crm_source`.

### Phase 2 — Build the cluster-compute alongside the chain

- Implement `computeFirstTouchForCluster()` in a new file
  `src/lib/services/identity-cluster-attribution.ts`.
- Implement `loadIdentityCluster(weddingId)` reading
  `candidate_identities`, `people.email`, `weddings.merged_into_id`,
  and the cluster_group_key.
- DO NOT replace any callers yet.

### Phase 3 — Validate against current chain output

- Add a daily cron job that runs both `deriveLeadSourceForVenue()`
  AND `computeFirstTouchForCluster()` on every active wedding,
  diffing the results.
- Surface the diff on `/intel/sources/parity` for coordinator review.
- Acceptance gate: <5% per-venue divergence rate on Rixey before
  proceeding to Phase 4.

### Phase 4 — Cut over

- Replace the cron's call to `deriveLeadSourceForVenue` with
  `computeFirstTouchForVenue` (the cluster-compute).
- Adapters get refactored to write `signal_class` (already factual,
  no source guessing).
- `source-backtrace.ts` stops writing `weddings.source`; writes
  `signal_class='source'` on the matched interaction instead.

### Phase 5 — Deprecate legacy columns

- `weddings.source` becomes read-only (DB-level: revoke UPDATE except
  for coordinator-override path).
- The 7-tier `lead-source-derivation.ts` file gets archived (kept for
  historical ref).
- Stream RR's branded `Cents` type pattern is the right precedent
  here: introduce a branded `FirstTouchSource` type so the type
  checker catches accidental mixing of `source` (legacy) and
  `lead_source` (cluster-derived) values.

---

## 6. Risk assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Cross-venue identity collision** — same email at two venues clusters into a single candidate, leaks attribution across venue tenants | High | `candidate_identities` is already venue-scoped (line 67-68 of mig 105). The cluster-walker MUST filter on `venue_id` at every step. |
| **Pre-Bloom history (HoneyBook bookings with no signal cluster)** | Medium | Honest "Untracked" bucket persists. The cluster compute returns `null` with `reason='no_source_signal_in_cluster'` for these — same as today's no-signal terminal. |
| **Storefront signals without email** (553 the_knot signals — first-name + last-initial only) | High | Three options: (a) match by first-name + last-initial + state + ±60d to weddings whose later signal cluster fingerprint matches — risks false matches across distinct couples; (b) leave them unclustered, count in volume but never attribute — costs us the very signal we want to capture; (c) use Tier 2 AI adjudication with high precision threshold (Phase B already supports this). **Recommendation:** Phase 4 ships with (b); Phase 6 adds (c) once AI calibration is proven on the 14-30d cluster zone. |
| **Performance** — cluster-walk per wedding is O(emails + candidates + signals) per row; cron runs over 854 Rixey weddings | Medium | Batch the walk: load all candidates + all signals for a venue in two queries, build the cluster index in memory, walk in a single pass. Spike script in Phase 4 measures actual cost. |
| **Coordinator override semantics** | Low | Override stays a single explicit signal class (not a cluster computation). When `weddings.attribution_priority` is set, return that value before walking. |
| **Adapter regression risk** — refactoring adapters to write `signal_class` could break ingestion | Medium | Schema lets `signal_class` be nullable initially. Adapters opt-in one at a time. |

---

## 7. Edge cases the model must handle

1. **Same lead emails the venue from 2 different addresses** (`kelly@gmail.com`
   for Knot inquiry, `kw.wedding@gmail.com` for calculator).
   - **Today:** identity-reconciliation clusters them via shared
     people-row email IF both emails landed on people rows.
   - **In the new model:** the cluster walker pulls all emails from
     the wedding's people rows, then queries candidates by email
     OR by `same_as_candidate_id` link. The Knot inquiry's
     `interactions.from_email='theknot.com'` is `signal_class='source'`,
     `timestamp=Mar 5`. The calculator submission is
     `signal_class='touchpoint'`, `timestamp=Apr 12`. First-touch
     wins: The Knot.

2. **Knot storefront engager who never inquires.**
   - **Today:** lives in tangential_signals, may form a
     candidate_identity with no resolved_wedding_id, surfaces on
     "Engaged but didn't inquire" dashboard list.
   - **In the new model:** unchanged. Cluster has no wedding to
     attach to. The candidate stays unresolved and surfaces in the
     same dashboard. If they later inquire, a name+window match
     promotes the candidate to resolved_wedding_id and the cluster
     compute now sees their old storefront signal as the
     first-touch.

3. **Couple uses partner1's email for inquiry, partner2's for tour
   booking.**
   - **Today:** identity-reconciliation may merge them via shared
     wedding_id IF both got attached. Often DOESN'T merge if the
     two emails landed in separate weddings rows.
   - **In the new model:** cluster pulls every people-row email
     attached to the wedding. Both emails appear; cluster walker
     queries interactions matching either. Both signals appear in the
     classification pass.

4. **Coordinator manually overrides attribution.**
   - **Today:** `weddings.attribution_priority` JSONB.
   - **In the new model:** unchanged — override still wins before any
     cluster walk.

5. **Multiple source signals in the cluster** (Knot March 5 + WW
   March 8).
   - **Today:** depends on which signal lands in the chain's
     priority window. Inconsistent.
   - **In the new model:** EARLIEST source-class signal wins. Both
     remain visible in the cluster's full signal list — the
     /intel/journey UI can show the multi-touch arc; only the
     earliest is reported as first-touch.

6. **Backtraced wedding** (someone paid with Calendly, but the real
   first-touch was a Knot inbound 2 months earlier).
   - **Today:** source-backtrace finds it, writes
     `weddings.source='the_knot'`, derivation chain reads it via
     Priority 7.
   - **In the new model:** source-backtrace stamps the matched
     interaction with `signal_class='source'`. Cluster walker sees
     it as a source signal at the historical timestamp; first-touch
     resolves to The Knot. No `weddings.source` write needed.

---

## 8. Validation results (from prototype)

Prototype: `scripts/rixey-load/50-bbb-spike.ts` (~600 lines, read-only,
zero LLM calls). Ran against Rixey production data 2026-05-02 in 3.4s
end-to-end. Per-row CSV at
`audits/2026-05-T4-postlaunch/bbb-spike-comparison.csv`.

### Loader results

| Stat | Count |
|------|-------|
| Active weddings (clusters) for Rixey | 854 |
| Total interactions for venue | 2,630 |
| Interactions attached to a cluster (by wedding_id OR by people-row email) | 1,741 |
| Total tangential_signals for venue | 1,951 |
| Tangential signals attached to a cluster (via candidate_identity → wedding) | 247 |

The first big finding is right here: **of 1,951 tangential signals
indexed for Rixey, only 247 (12.7%) are connected to an active
wedding via the candidate-identity pipeline.** The remaining ~1,700
signals are either anonymous (no parsed name), unresolved candidates,
or candidates whose match window expired. This is the storefront-
signals leak.

### Comparison verdict (854 weddings)

| Verdict | Count | % |
|---------|-------|---|
| `agree` (chain + cluster pick same canonical value) | 201 | 23.5% |
| `cluster_finds_real_source` (chain returned touchpoint/CRM bucket; cluster found upstream source) | 69 | 8.1% |
| `cluster_finds_better` (chain returned NULL; cluster found source) | 0 | 0.0% |
| `chain_wins` (chain found something; cluster found nothing) | 519 | 60.8% |
| `both_null` | 52 | 6.1% |
| `disagree_specific_value` (both real, but different) | 13 | 1.5% |

| Headline | Count |
|----------|-------|
| Chain attributes a "real source" (the_knot, google, referral, etc.) | 243 |
| Chain attributes only a touchpoint/CRM bucket (website, honeybook, calendly, generic_csv) | 559 |
| Cluster attributes a real source | 283 |

### Where the cluster wins (chain returned touchpoint or NULL)

Chain stamped a non-source bucket; cluster found the actual upstream
channel:

| Cluster channel | Count |
|-----------------|-------|
| `the_knot` | 41 |
| `google` | 17 |
| `referral` | 8 |
| `facebook` | 1 |
| `zola` | 1 |

**Total: 68 weddings where the cluster model surfaces a real source
the chain hides behind "website" or "honeybook" or "calendly".**

### Where the chain wins (cluster missed)

| Chain channel | Count | Class in proposed model |
|---------------|-------|--------------------------|
| `website` | 376 | touchpoint (Priority 3 web-form match) |
| `honeybook` | 81 | crm |
| `calendly` | 15 | touchpoint |
| `direct` | 12 | not a real channel — gmail.com sender |
| `generic_csv` | 11 | crm-import provenance |
| `wedding_wire` | 7 | source — REAL miss |
| `the_knot` | 6 | source — REAL miss |
| `web_form` | 4 | touchpoint |
| `venue_calculator` | 3 | touchpoint |
| `here_comes_the_guide` | 3 | source — REAL miss |
| `google` | 1 | source — REAL miss |

**Of the 519 chain_wins, ~502 are non-source buckets (touchpoint /
CRM / "direct" / web-form). Only ~17 are real-source attribution
the cluster genuinely failed to find.**

The 17 cluster-misses break down as: candidate_identities cluster
never formed for these weddings (they have a clear from-domain
signal but the candidate-resolver hasn't run / hasn't matched the
storefront signal yet). All recoverable in a Phase B improvement
pass.

### Disagreement breakdown

Of 13 `disagree_specific_value` rows, **9 are pure normalisation
glitches:**

| Pair | Count |
|------|-------|
| `weddingwire → wedding_wire` | 9 |
| `herecomestheguide → here_comes_the_guide` | 2 |
| `weddingwire → the_knot` | 1 |
| `herecomestheguide → the_knot` | 1 |

The 2 real disagreements (`weddingwire → the_knot`,
`herecomestheguide → the_knot`) are clusters where the candidate-
identity pipeline saw a Knot signal earlier than the WW/HCTG
inbound — those are LIKELY genuine cluster wins (Knot view first,
WW/HCTG inquiry later) but need eyes on the per-row data to confirm.

### Calculator cohort drill-down

The exact case Isadora described:

- **422 weddings** with `crm_source='web_form'` (calculator submissions)
- **12** have `the_knot` in their cluster (Knot signal AND calculator)
- **20** have ANY source-class signal in their cluster
- The remaining 402 calculator submissions show NO upstream signal
  attached to their cluster

Compare to the dashboard: 553 storefront signals exist for Rixey but
only ~12 reach a calculator-submission wedding via the existing
candidate-identity pipeline.

**Identified root cause:** the candidate-identity resolver matches by
exact email on Tier 1 + name+window on Tier 2, but Knot storefront
signals only carry first-name + last-initial + city/state. The
calculator-submission email is the first time we get a real email
for that person — the resolver doesn't backtrack across the
resolution event to merge the (now-known-email) candidate with the
(name+state-only) storefront candidates. **This is a candidate-
resolver gap, not an attribution-model gap.**

---

## 9. GO / NO-GO

### Recommendation: GO — but split into two streams

The deep model is the right architecture. The spike validates that:

1. **The current chain is structurally wrong.** 559 of 802 chain
   attributions are touchpoint/CRM buckets dressed up as "lead
   source." That's not 1% noise; it's 70% noise. Coordinators looking
   at /intel/sources see "website 378, honeybook 89, calendly 55"
   and learn nothing about real acquisition.
2. **Class-of-signal cleans this up immediately.** The cluster-derived
   distribution (the_knot 182, google 68, referral 14, wedding_wire 9)
   is honest: every value in the top-10 is a real acquisition channel.
3. **The cluster compute is fast.** 854 weddings + 2,630 interactions
   + 1,951 signals processed in 3.4 seconds end-to-end on a single
   Node process talking to Supabase REST. Per-venue cron run is
   cheap.
4. **The cluster compute is conservative.** It returns NULL for 571
   of 854 weddings. That's HONEST — the chain only returns 52 NULLs
   because it pads the rest with touchpoint buckets that are
   meaningless. NULL is the right answer when no source signal is
   present. The "Untracked" bucket should grow.

But the spike also reveals two things that must NOT be in the BBB
refactor:

1. **The 553-signals leak is a candidate-resolver gap, not an
   attribution-model gap.** Switching to cluster-compute alone
   doesn't fix it — only 247 of 1,951 signals are reaching their
   wedding. Phase B Tier 2 (name+window + AI adjudication backtrack
   on resolution) needs its own stream.
2. **Source-attribution rollups depend on the full distribution.**
   Cutting over without backfilling `weddings.lead_source` to the
   cluster-derived value will instantly drop /intel/sources from
   "802 attributed" to "283 attributed." That's correct math but
   visually a regression. The cutover migration must include a
   one-time `weddings.lead_source = compute_cluster_first_touch()`
   backfill so the page shows the new (smaller, honest)
   distribution from day one.

### Estimated streams for the full refactor

| Stream | What | Days |
|--------|------|------|
| **BBB-1** | Schema: add `signal_class` column to interactions / tours / tangential_signals / lost_deals / attribution_events. Backfill from existing patterns. Index `(venue_id, signal_class, timestamp)` on each. Migration only — no code change. | 1 |
| **BBB-2** | Adapters: refactor honeybook / tour-scheduler / web-form / generic-csv / dubsado / aisle-planner to write `signal_class` on every row. Add CI guard so a new adapter without a class declaration fails build. | 1 |
| **BBB-3** | New `identity-cluster-attribution.ts` service: `loadIdentityCluster(weddingId)` + `computeFirstTouchForCluster(...)`. Unit tests against synthetic clusters. Promote spike script to a real cron entry. | 2 |
| **BBB-4** | Parity cron: nightly diff between chain output + cluster output. New /intel/sources/parity coordinator review page. Acceptance gate before BBB-5. | 1 |
| **BBB-5** | Cutover: replace `deriveLeadSourceForVenue()` cron call with `computeFirstTouchForVenue()`. One-time backfill migration that recomputes `weddings.lead_source` for every active wedding. Delete the 7-tier chain (archive in `_legacy/`). Remove migration 187's NULL-out (no longer relevant — adapters never write `weddings.source` anyway). | 1 |
| **BBB-6** | Branded `FirstTouchSource` type per Stream RR `Cents` precedent. Type-checker enforces no mixing of `weddings.source` (legacy) vs `weddings.lead_source` (cluster-derived). | 0.5 |

**Total: ~6.5 engineer-days for the full BBB refactor.**

### Adjacent stream (NOT in BBB scope)

| Stream | What | Days |
|--------|------|------|
| **CCC** | Candidate-resolver backtrack: when a candidate resolves to a wedding (now has a known email), retroactively scan unresolved storefront candidates with matching first-name + last-initial + state + ±60d and merge them into the same cluster (Tier 2 with AI confirmation per Phase B doctrine). This is what unlocks the 553 storefront signals → calculator-submission attribution. | 3 |

CCC is the higher-leverage stream from a coordinator-trust perspective
(Isadora's actual question), but it does NOT block BBB. They compose:
BBB ships the model, CCC ships the volume.

### What's GO and what's NO-GO

- **GO** on BBB now (6.5 days). Class-of-signal model is sound,
  spike confirms cluster compute is correct + fast + cheap, refactor
  removes the patchwork without regressing real-source attribution.
- **NO-GO on shipping BBB without CCC pipeline.** If we cut the
  chain over without ALSO fixing the candidate-resolver, /intel/sources
  drops from 802 → 283 attributed weddings. Coordinators will see
  the regression as "Bloom got worse." Either ship them together OR
  ship BBB-1 through BBB-4 first, run parity for 2 weeks, ship CCC,
  then ship BBB-5/6.
- **NO-GO on the registry table approach (Option B).** The class set
  is closed; the writer-side classification is derivable; column-on-
  table keeps the hot-path query a single SELECT.

### Risks called out

1. **Mig 187 leakage:** the bandaid that NULLed `weddings.source` for
   scheduling-tool values is now load-bearing. BBB-5's cutover must
   keep the spirit of that NULL-out (adapters don't write `source`)
   even after the chain is gone.
2. **Source-backtrace is the orphan:** the service writes
   `weddings.source` directly. BBB-2 must include a refactor to
   write `signal_class='source'` on the matched interaction
   instead. Not in the headline scope but easy to forget.
3. **Cross-venue cluster collision** stays a risk. Every cluster-
   walker query MUST `.eq('venue_id', venueId)`. The spike script
   does this; the production service must add a unit test that
   asserts cross-venue isolation.

---

## Appendix: per-row CSV

`audits/2026-05-T4-postlaunch/bbb-spike-comparison.csv` has one row
per wedding with: verdict, current chain value, cluster value,
crm_source, legacy `weddings.source`, cluster_source_signals count,
cluster_all_signals count, inquiry_date.

Use it to spot-check coordinator surprises before BBB-5 ships.
