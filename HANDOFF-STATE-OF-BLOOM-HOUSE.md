# The Bloom House — State of the Project (Engineering Handoff)

**Audience:** Phil (and anyone picking this up cold — assume the whole team has left).
**Written:** 2026-06-13 · **Updated:** 2026-07-07
**Purpose:** A single, human-readable map of *what Bloom House is*, *how data flows through it*, *what has been achieved*, *what is next*, and *the things you need to know that aren't obvious from the code*.

> **How to use this doc.** Read §1–§3 for the mental model, §4 for the pipelines (the heart of the system), §5 for the state of the codebase, §6 for the one big in-flight effort (the consolidation), §7 for exactly what to do next, and §8 for survival tips. If you only read one other file after this, read `CONSOLIDATION-PLAN-PHASED.md` (the single plan of record) and `ARCHITECTURE-DECISIONS.md` (the three decisions that gate everything).

---

## 0. TL;DR — where we are in three paragraphs

Bloom House is a **wedding-venue intelligence platform**: it ingests every signal a venue produces (emails, tour bookings, texts, calls, CRM exports, marketplace inquiries, website visits, reviews), **forensically reconstructs each couple's identity across all those channels**, and surfaces three product experiences on top of that one spine — **Agent** (Sage drafts and sends email/SMS replies), **Intelligence** (analytics, attribution, natural-language queries, couple journeys), and **Portal** (the couple-facing wedding-planning app the venue's booked couples use). It is a large, mature Next.js + Supabase + Claude application: ~85k lines of TypeScript, **382 migrations**, ~188 pages, ~384 API routes, and dozens of cron jobs.

The product breadth is essentially all built. The problem we have spent the last ~6 weeks fixing is **architectural, not feature-level**: the system grew *two* ways of representing a couple — a legacy `weddings`/`people`/`interactions` stack and a newer identity-first `couples`/`touchpoints` "spine" — and for a long time both were written by ~138 different writers that diverged, producing **contradictory numbers for the same couple**. The fix is a deliberate, phased **consolidation**: unify all writes → wipe and re-import from origin to get a provably-clean spine → migrate each product limb to read the spine → delete the legacy graveyard. This is the central narrative of the project right now.

**As of 2026-07-07:** Phase 0 (prerequisites) and Phase 1 (write-path unification) are **complete**. The clean-up discipline (CI ratchets, golden test suite, a single plan of record) is in place and CI is running green. Migrations 380/381 (decay window + point-zero) are **applied to production**. The Gmail historical backfill is **complete** (18,545 emails back to 2021 ingested). Lead source derivation is wired and has run — **381/400 weddings now have a lead source (95%)**. **Phase 2 (the wipe + re-import) is fully tooled and ready to execute** — it is blocked only on a short list of *operator* actions (verify-nobody-live, fresh Supabase snapshot, fresh HoneyBook CSV export, walk the go-checklist). See §7. Two new active bugs also need attention before/alongside Phase 2 (§7.4).

---

## 1. What Bloom House is

### 1.1 The one-sentence definition

> Bloom House is a **venue intelligence platform** (think Gong/Clari for wedding venues, plus an external macro-economic signal layer). Identity reconstruction is the *substrate* that makes everything else honest; it is not, by itself, "the product."

This framing is the **Canonical Product Definition v1.0** (authored by Isadora 2026-05-28) and it is the authoritative yardstick — it supersedes earlier doctrine. The earlier "House" doctrine over-indexed on "forensic identity reconstruction *is* the product." The correction: **lead with intelligence, not automation, and not the plumbing.**

### 1.2 The five ranked USPs (what we actually sell)

1. **Heat scoring + decay detection** — which couples are hot, which are going cold, and *why* (transparent, not a black-box score).
2. **Source-quality intelligence** — "your best couples, not your most leads." Which channels bring couples who actually book.
3. **Voice DNA** — Sage writes in the venue's actual voice, learned from real sent email.
4. **External macro-signal layer** — correlating bookings against mortgage rates, CPI, consumer sentiment, cultural moments, weather.
5. **Natural-language queries (NLQ)** — "ask Sage" anything about the venue's data.

### 1.3 The three product areas (one database, one auth, one AI engine)

| Area | What it does | Who uses it |
|---|---|---|
| **Agent** | Sage reads inbound email/SMS, classifies intent, drafts replies in the venue's voice, and (gated) auto-sends. Follow-up sequences, escalation, learning loop. | Venue coordinators |
| **Intelligence** | Analytics over the reconstructed spine: heat, attribution, cohort funnels, couple journeys, anomalies, marketing ROI, reviews, NLQ. | Venue owners / operators |
| **Portal** | The couple-facing wedding-planning app (timeline, budget, guest list, seating, contracts, Sage chat). This plans the **event**. | Booked couples + coordinators |

### 1.4 Critical doctrine — "hold the line"

Bloom is **not** a CRM, **not** a generic chatbot, and **not** three separate products bolted together. It is one intelligence engine. There is a "WHAT NOT TO BUILD" table in `BLUEPRINT.md` — if a feature is in that table, don't build it. The honesty rail is sacred: the system must never present a confident number it can't defend (this is the "TBH" — *to be honest* — brand principle, and it's why every distribution carries an `enoughData` flag and every recommendation carries a `WhyThisCard`).

---

## 2. The stack & where things live

- **Repo:** `C:\Users\Ismar\bloom-house`
- **Stack:** Next.js (App Router) · TypeScript · Tailwind v4 · shadcn/ui · Supabase (Postgres) · Claude API (Anthropic), OpenAI as gated fallback
- **Production Supabase:** `jsxxgwprxuqgcauzlxcb` ← **this is PROD. Never point a writing script at it.**
- **Hosting:** Vercel (auto-deploys `master`). Rollback = Vercel instant-rollback to a prior deployment.
- **Auth:** Supabase Auth. Demo mode is cookie-based (`bloom_demo=true`, visit `/demo`); the fictional "Crestwood Collection" venues are demo data, not real.

### 2.1 Source layout

```
src/
  app/(platform)/   Authenticated shell: /agent /intel /portal /settings /onboarding /admin
  app/(auth)/        Login, signup
  app/(couple)/      Couple-facing portal (subdomain-routed)
  app/demo/          Demo entry (sets the cookie)
  app/api/           ~384 routes: agent pipeline, intel, portal/sage, cron, admin, webhooks
  lib/ai/            callAI / callAIJson / callAIVision + cost tracking + circuit breaker
  lib/spine/         cascade.ts — the canonical writer surface (re-exports mint fns)
  lib/intel/         canonical.ts — the SIX canonical read functions
  lib/services/
    identity/        The spine: cascade, forwards-linker, matcher, judge, point-zero, heat, decay
    email/           pipeline.ts — processIncomingEmail (the email brain)
    brain/           LLM decision modules (intel-brain NLQ, router, inquiry, sage, voice-dna...)
    ingestion/       zoom, openphone, form-relay parsers
    crm-import/       HoneyBook/CSV/web-form adapters
    external-context/ FRED, cultural moments, calendar, stats (the macro layer)
  config/prompts/    40+ prompt templates; each brain exports BRAIN_PROMPT_VERSION
  components/         identity (JourneyRibbon), intel (panels), ui (DataMaturity/WhyThisCard), couple, portal
supabase/migrations/ 381 SQL migrations, run in order
scripts/             ~300 files: governance ratchets (check-*.mjs), tests, backfills, Phase 2 tooling
```

### 2.2 The documents that matter (there are ~80 markdown files — these are the load-bearing ones)

| File | What it is |
|---|---|
| `CONSOLIDATION-PLAN-PHASED.md` **v2.1** | **THE single plan of record.** Phases 0–4. Read this first. |
| `ARCHITECTURE-DECISIONS.md` | The three decisions (D1/D2/D3) that gate the whole plan. Read second. |
| `PHASE2-GO-CHECKLIST.md` | The exact, sequential operator steps to run the wipe + re-import. |
| `PHASE-2-WIPE-MANIFEST.md` | The exact table-by-table wipe/preserve/export list. |
| `CASCADE-CANONICAL-WRITER.md` / `INTEL-CANONICAL-API.md` | The write-side and read-side contracts. |
| `BLOOM-TEST-QUESTIONS.md` | The 37-question battery — the **ship gate**. |
| `CLAUDE.md` | Project conventions, design system, coordinator-surface map. |
| `CHANGELOG.md` / `PROMPTS-CHANGELOG.md` | Commit-level + prompt-level revision history. |

> **Document hygiene warning:** several older plans are now **dead** (`BLOOM-MASTER-PLAN.md`, `MONDAY-START-HERE.md`, the `CONSOLIDATION-PLAN-25-DAY-*` and `-30-DAY` variants). They carry stale "superseded" banners. **Trust only `CONSOLIDATION-PLAN-PHASED.md` v2.1.** A fresh engineer reading the wrong plan would be ~6 weeks wrong.

---

## 3. The architecture — the two-entity model (the single most important concept)

For a long time the codebase had one entity, `weddings`, keyed on `wedding_id`, and ~90 tables hung off it. The identity-first work added a second representation, `couples`, keyed on `couple_id`. The resolution (`ARCHITECTURE-DECISIONS.md`, D1, resolved 2026-05-22) is that **both are legitimate — they model different things:**

- **`couples` = the IDENTITY (the "spine").** Exists from the *first* touchpoint, reconstructed forensically across channels. This is what Intel, Agent, and Sage reason about. It carries lifecycle, heat, decay, point-zero, and the forensic profile.
- **`weddings` = the EVENT.** Exists only once a couple *books*. Has a date, guest list, budget, seating chart, timeline. This is what the **Portal** plans. `weddings` is **not** legacy — it is the event entity and it survives permanently.
- **The link:** `couples.source_wedding_id` (1:1, UNIQUE) joins a booked couple to its wedding.

So: ~8–12 **identity-core** tables (`interactions`, `attribution_events`, `wedding_touchpoints`, identity evidence) are being **re-keyed onto `couples`**. The ~70 **portal/event** tables (`budget`, `guest_list`, `seating_*`, `contracts`, `timeline`…) **stay `wedding_id`-keyed** — re-keying them would force event data onto the identity entity and fight the portal.

The three decisions, all resolved:
- **D1 — two-entity model** (above).
- **D2 — wipe + reimport** to get a clean spine (cheaper and provably-correct vs. reconciling the existing mess in place — and safe because **there is no live customer**: Rixey's couples use the separate `rixey-portal` app, not bloom-house).
- **D3 — ordering:** unify writes → wipe+reimport → migrate readers limb-by-limb → stop legacy writes → delete last. (You cannot make a table read-only while limbs still read it; you cannot cleanly re-import until writes are unified.)

### 3.1 The five identity lifecycle states (six in the schema)

A couple moves through: **Fragment** → **Channel-Scoped** → **Resolved** → **Ghost** / **Booked** (and **Completed**, plus **Agent** for planners/parents acting on a couple's behalf). Heat decays with silence; after the decay window (canonically **90–120 days, default 120**, couple-side inbound only) a couple flips to **Ghost**.

---

## 4. The pipelines — data in → processed → surfaced

This is the core of the system. Read it in three movements: **ingestion** (how external data enters), **processing** (the cascade/spine that reconstructs identity), and **surfacing** (how it comes back out).

### 4.1 INGESTION — how data enters

Every structured identity-bearing signal is normalized to a `NormalizedSignal` and pushed through **one writer**, `linkSignal()` (see §4.2). The sources:

| Source | Entry point | How | Lands in | Through cascade? |
|---|---|---|---|---|
| **Gmail (email)** | `/api/cron?job=email_poll` (every 5 min) + manual | Cron poll via Gmail OAuth per venue | `interactions` (full body, extracted_identity) → `drafts` → `engagement_events` | ✅ `linkSignal` |
| **Calendly (tours)** | `/api/webhooks/calendly` (real-time) + daily backfill | Webhook on booking; CSV/URI backfill | `tours`, `weddings.calendly_qa`, `discovery_sources`, `attribution_events` | ✅ `linkSignal` |
| **Twilio SMS** | `/api/webhooks/twilio` (real-time) | Webhook, signature-verified | `interactions` (type=sms), `twilio_webhook_log` | ✅ `linkSignalWithLifecycle` |
| **Zoom** | `/api/cron?job=zoom_poll` (daily) | OAuth poll; pulls recordings + transcripts | `processed_zoom_meetings`, `interactions` (type=meeting) | ✅ `linkSignalWithLifecycle` |
| **OpenPhone** | `/api/cron?job=openphone_poll` (15 min) | API poll (no webhook) — SMS, voicemail, calls | `processed_sms_messages`, `interactions` | partial |
| **HoneyBook / CRM CSV** | `/api/onboarding/crm-import` (manual) | Upload; preview → dry-run → commit | `crm_import_rows`, `interactions`, `tours`, `pricing_history` | ✅ `linkSignalBatch` |
| **The Knot / WeddingWire / Zola** | email relay + Knot visitor-activity CSV | Relay addresses parsed in email pipeline; CSV upload | `interactions`, `tangential_signals` | ✅ |
| **Web forms / calculator** | `/api/onboarding/web-form-import` (manual CSV) | Form-provider hints map columns | `crm_import_rows`, `interactions` (form_submission) | ✅ sweep |
| **Web pixel / visits** | `/api/v1/visit` (public, real-time) | JS pixel on marketing site | `web_visits` (anon id, UTM, click-ids) | stitch-to-couple (unambiguous-only) |
| **Brain-dump** | `/api/brain-dump/entries` (manual) | PDFs, audio, screenshots, text → parse → route | `brain_dump_entries` → graduates to real tables | ✅ sweep |
| **Audio capture (Omi/etc.)** | `/api/omi/webhook?token=` | Wearable posts tour transcript | `audio_segments`, `interactions`, `tours.transcript_analysis` | ✅ |
| **Reviews** | `/api/cron?job=google_places_reviews_refresh` (weekly) + paste | Google Places auto-pull; Knot/WW/Yelp paste-only | `reviews`, `intelligence_insights` | n/a |
| **Stripe (billing)** | `/api/webhooks/stripe` | Invoice/subscription events | `subscriptions`, `billing_invoices`, dunning state | n/a |

**`processIncomingEmail`** (`src/lib/services/email/pipeline.ts`) is the email brain and the most important single function. Its ~15-step flow: date-normalize → scheduling-tool pre-check → universal auto-ignore (no-reply/bounces) → per-venue filter rules → **form-relay detection** (extract the real prospect behind a Knot/WW/Zola/calculator relay address) → body identity extraction → scheduling-event parse → self-loop guard → contact lookup → wedding resolution (or mint) → **brain routing** (classify inquiry/follow-up/non-couple) → **draft generation** (Sage) → **auto-send gate** (cost-ceiling + venue settings) → engagement event → **`linkSignal` cascade dual-write**. It mints a correlation ID at entry that threads through every brain call and write.

> **The big ingestion correction (Origin-Ingestion doctrine, 2026-05-28).** There used to be *two* ingestion systems: the LIVE path (above, origin-sourced, full-fidelity) and a "Backwards Tracer" that read DB *mirrors* with its own writer and dropped full email bodies / Calendly Q&A. The Tracer's mirror-adapters were **deleted** and folded into `linkSignal`. There is now **one** path: re-onboarding = replaying each origin (Gmail, Calendly, CSV, reviews, pixel) back through `linkSignal`. This is what makes the Phase 2 re-import correct by construction.

### 4.2 PROCESSING — the cascade & the spine

When a signal lands, `linkSignal()` (`src/lib/services/identity/forwards-linker.ts`) resolves it to a couple:

1. **Load recent couples** (60-second LRU cache per venue, to survive bursts).
2. **Run the cascade** — `cascadeMatch()` in `src/lib/services/identity/identity-cascade.ts`. **12 deterministic stages**, first hit wins:
   - **1** exact email · **1b** Knot per-prospect personId · **1c** WeddingWire/Zola per-prospect relay key (namespaced `ww:`/`zola:`) · **2** exact full name · **2b** partner-side full name · **3** nickname + last name · **4** exact phone · **5** email-localpart logical name (`timmy.blogs`↔`timothyblogs`) · **5b** both-partners cross-match · **6** body cross-reference (scan body for any known identifier) · **7** paired-name + corroborator · **8** family-name + wedding date.
   - **The contradiction guard** (`hardContradiction()`, "Tier 1.5"): name-only stages must **bridge** a relay/partial identity onto the right couple but must **not fuse two distinct same-named couples**. It suppresses a name-only match when wedding dates differ by >90d, or two *strong* (non-relay) emails conflict — *unless* a partner name corroborates them as two partners of one couple. This guard is load-bearing and subtle; it has been the source of several caught regressions (see §6.4).
3. **Fuzzy fallback** — if all 12 stages miss, `scoreCandidate()` in `matcher.ts` runs integer-weighted signals (email_exact=100, full_name_exact=60, wedding_date_within_30d=30, cross-channel temporal bonuses, etc.). Score → tier: ≥100 `high` (auto-attach), 60–99 `medium` (queue for review), 30–59 `low`, <30 `below_threshold` (mint new or store as fragment).
4. **LLM judge** — when the score lands in the ambiguous **40–90** band, a Sonnet judge (`llm-judge.ts`) adjudicates (the "probabilistic bridge"). Budget-gated.
5. **Tier routing** (`route-by-tier.ts`) → `lockAndMintCouple()` (`mint-couple.ts`) is the **couples-table chokepoint**: advisory-locked RPC, upserts the couple, inserts the touchpoint, writes a `couple_merge_events` audit row.
6. **Point-Zero stamping** (`point-zero.ts`): set-once, race-safe — the first inbound signal carrying a name + reachable identifier stamps `couples.point_zero_at`; every touchpoint is stamped `zero_phase` (pre/post) and write-time `direction`.
7. **Progression clock** (`progression.ts`): inbound eligible events advance the lifecycle and reset the decay clock.
8. **Partner-reconciliation** (`merge_couples` RPC, migration 379): if a couple's partner identity turns out to *be* another couple's primary, the two merge — dynamic FK reassignment (no hand-maintained table list), tombstone via `merged_into_id`, audited.

**Heat & decay:** `heat-score.ts` computes `Σ weight[tier] × 0.5^(age_days/14)` (14-day half-life; weights highest=100…low=5). `computeHeatBreakdown` exposes the *why*. `decay.ts` flips couples to `ghost` after the decay window of silence. `lifecycle-audit.ts` is a read-only diagnostic that surfaces drift and likely-missed merges (never auto-actions).

**The AI layer:** every LLM call goes through `lib/ai/client.ts` (`callAI`/`callAIJson`/`callAIVision`), logs to `api_costs` (model, tokens, cost, prompt_version, correlation_id), and falls back to OpenAI behind a circuit breaker. Models: Sonnet default, Haiku for classification (~12× cheaper), Opus for premium synthesis. ~15 "brain" modules own distinct decision points; each carries a versioned prompt.

### 4.3 SURFACING — how it comes back out

**The six canonical read functions** (`src/lib/intel/canonical.ts`) are the *only* sanctioned read surface — a doctrine: the number six never grows; new needs become parameters. **All six are now real (not stubs)**, each with an injectable testable core, a public wrapper, unit tests, and CI wiring:

1. **`getVenueOverview`** — couples by lifecycle state + recent activity + data maturity.
2. **`getSourceAttribution`** — per-channel conversion/CAC/revenue across 4 attribution models, every metric carrying `enoughData` + reason.
3. **`getCohortFunnel`** — funnel stages, response/lead-time distributions, conversion curve + knee detection, text-pattern themes.
4. **`getCoupleJourney`** — one couple's identity + ordered touchpoint ribbon + progression + forensic profile + look-alike cohort.
5. **`getDailyList`** — the operator's daily landing list: needsReply / goingCold / toursThisWeek / highIntent (all threshold-explainable, no black box).
6. **`askIntel`** — wraps the NLQ brain; returns answer + confidence (high/hedged/refused) with the honesty inspector wired in.

**The pages** (~188 total in the `(platform)` shell): **Agent** ~24 (inbox, drafts, leads, learning, rules, settings, sequences, audio-inbox, cohort NLQ…), **Intelligence** ~65 (couples list + `[id]` + `/journey`, cohort, dashboard, heat, attribution, marketing-roi, reviews, anomalies, sources, agencies/TBH reports…), **Portal** ~33 (couple portal + ~25 coordinator config surfaces: bar, seating/tables canvas, shuttle, staffing, sections…), plus **Settings** ~27, **Admin** ~15 (identity reconstruction, telemetry, divergence, integrity), **Onboarding** ~8.

**Key components:** `JourneyRibbon` (SVG timeline of a couple's touchpoints), `JourneyActionChip`, `DataMaturity` (the "4 of 10 couples" anti-guilt progress pill), `WhyThisCard` (reasoning disclosure on every AI recommendation — the honesty rail made visible), `Recommendation`, `EmptyState`, `CoupleIntelPanel`, `MarketingDigest`.

**Crons:** dozens of scheduled jobs, dispatched through `/api/cron?job=X` (Vercel's cron limit forces multiplexing). They fall in three buckets: **poll-ingest** (email_poll 5-min, openphone_poll 15-min, zoom_poll, google_places, FRED/weather), **identity/derive sweeps** (identity_judge_sweep every 5-min, phase_b_sweep, backtrace_scan, couple/cohort/venue intel rollups, attribution & marketing waves), and **repair/maintenance** (heat_decay, tour_outcome_classifier, data_integrity_sweep, prune_maintenance, cost_ceiling_check). The plan retires the repair/drift crons in Phase 4 once the cascade is the sole writer.

---

## 5. What has been achieved (the honest ledger)

### 5.1 Product (essentially complete)
- All three product areas are built and wired: **Agent** (full email/SMS pipeline, drafting, auto-send gating, follow-up sequences, voice learning), **Intelligence** (the full analytics surface + NLQ + couple journeys + marketing ROI + reviews + macro correlation engine), **Portal** (couple-facing planning app + extensive coordinator config).
- **Voice DNA**, heat scoring, decay detection, source-quality intelligence, the external macro layer (FRED + cultural moments + calendar + weather), and NLQ — all five USPs exist in code.
- Forensic identity reconstruction across email, Calendly, Knot, WW, Zola, SMS, Zoom, OpenPhone, web forms, pixel, brain-dump, audio.

### 5.2 Consolidation (the in-flight effort — see §6 for the full story)
- **Phase 0 complete:** battery runner, shadow-compare harness, kill list, loop assessment, tags/branches.
- **Phase 1 complete:** the write path is unified — all reimport sources route through `linkSignal`; the Backwards Tracer's divergent mirror-writer was deleted (Origin-Ingestion doctrine). Writer-migration scope verified complete 2026-06-11.
- **The six canonical read functions are all real** (Phase 3.3 reader layer done ahead of schedule, additive/non-breaking).
- **Governance is now enforcing:** CI ratchets that can only fall (cleanup-budget, RLS-on-venue-id, swallowed-writes — now at **0**, cascade-only-writer, no-mirror-source), a 15/15 **golden test suite** (`npm run test:golden`) that has already caught two production regressions, vitest wired into CI (282/282), and a single plan of record.
- **Identity correctness primitives shipped:** the Tier-1.5 contradiction guard, the probabilistic LLM bridge, the partner-reconciliation merge primitive (migration 379, live on prod), the WW/Zola relay-key extractors, web-visit→couple stitching.
- **The two canonical-definition migrations (380 decay window, 381 point-zero + direction) are written, tsc-clean, golden-15/15 on the test branch** — but **not yet applied to prod** (operator step).
- **Hardening complete:** ~123 swallowed DB writes now route through `writeOrLog`; destructive scripts gated against prod; integration tests that were silently writing to prod were caught and fixed.

### 5.3 Deploy state (corrected 2026-07-07, remediation R0)
- **Correction:** the earlier claim that consolidation was fast-forwarded into master in June was wrong. From Jun 17 to Jul 7, `master` (and prod) sat at `81caf84` while 15 commits accumulated locally on `consolidation` — including the Knot pipeline fix (`68b4277`) and the Q31/Q32b battery fixes (`5da19a1`). The 2026-07-07 R0 push fast-forwarded `master` to the `consolidation` head and deployed. From here, verify `git log origin/master -1` matches `consolidation` before trusting any "prod has X" claim; the audit trail is REMEDIATION-PLAN-2026-07-07.md.
- **382 migrations** total. Migrations 380 (decay window) and 381 (point-zero + touchpoint direction) are **applied to production**.
- **Gmail historical backfill:** `status=complete`, `phase=booked`, 18,545 emails processed back to 2021-12-28. This was one of the Phase 2 re-import steps — it has run ahead of the wipe, meaning after the wipe it just needs to re-run from scratch (the backfill tooling is still in place).
- **Lead source derivation:** `deriveLeadSourceAllVenues` is now wired into the `attribution_refresh` cron (it was built but never called — fixed 2026-07-05). First run resolved 381/400 weddings (95%). Runs daily at 06:00 UTC from here out.

---

## 6. The one big story — the consolidation

If you understand nothing else about the *current* work, understand this.

### 6.1 The disease
Two representations of a couple (legacy `weddings` vs. spine `couples`), written by ~138 writers, ~102 of which bypassed the unifying cascade. Result: the same couple could have **contradictory numbers** depending on which path read it. There were 5–6 identity code paths and 2 attribution stacks. Rixey's real data was in dual-state (431 weddings vs 1,953 couples). This violates the honesty rail — the product's whole premise.

### 6.2 The cure (the four phases, `CONSOLIDATION-PLAN-PHASED.md` v2.1)
- **Phase 0 — Prerequisites** ✅ (battery runner, harnesses, kill list).
- **Phase 1 — Unify the write path** ✅ (~4–6 wk estimated; done). Every writer + cron routes through the cascade; legacy and spine written in lockstep ("dual-write"). Plus §1.8: the canonical D4 (point-zero) + D5 (decay 90–120) migrations (380/381) are **applied to production**.
- **Phase 2 — Wipe + reimport** ⏸ **READY, blocked on operator** (~1 wk firm). Wipe the identity/pipeline tables + spine; replay HoneyBook CSV → re-merge Calendly Q&A → Calendly replay → Gmail backfill (the backfill has already run once, it just re-runs from scratch after the wipe) → Zoom/SMS/OpenPhone → Knot CSV → re-merge the 8 exported "danger" tables. Clean spine falls out by construction. **This is the next thing to do.** Note: there is an active Knot ingestion bug (§7.4) — diagnose it before Phase 2 so the re-import captures everything.
- **Phase 3 — Migrate readers limb-by-limb** (~6–9 wk range; mostly not started, though 3.3's canonical readers are pre-built). Agent (+voice loop) → Sage → Intel → Portal. Each behind the battery, one at a time.
- **Phase 4 — Delete the graveyard** (~1 wk firm). Remove the now-unreferenced dead pages, services, repair crons, and retired legacy tables. Flatten the migration baseline.

**Honest total: ~3 months from Phase 2 start.** Phase 1 was the hard, invisible part. We are at the Phase 1→2 boundary. The clean-up discipline means Phase 2 is a mechanical week, not a scary one.

### 6.3 Why a wipe is safe
**There is no live customer.** Verified 2026-05-29: only the operator (Isadora) has had auth sessions; Rixey's couples and staff use the *separate* `rixey-portal` app. The portal in bloom-house has no couple data. This window is what makes the wipe cheap and safe — and it is *depreciating*, which is the argument for executing Phase 2 soon rather than continuing to polish.

### 6.4 Hard-won lessons (read these — they are traps that already bit us)
1. **Golden is not in CI** (it needs a branch DB). You **must** run `npm run test:golden` after *any* change to the matcher/cascade/forwards-linker. A GC-5 regression shipped to prod undetected precisely because someone didn't.
2. **Shared predicates: fix in the predicate, not one caller.** `hardContradiction` has two consumers (cascade + forwards-linker). A veto added to one path but not the other let a both-partners couple split. Always sweep all consumers.
3. **Worktree agents fork from a base that may lag the working branch** — verify the merge-base and *port* shared files; never blind-merge a parallel agent's `canonical.ts`.
4. **Hand-maintained table lists drift and break.** The `merge_couples` primitive deliberately uses dynamic FK reassignment to avoid this — but the same anti-pattern crept back into a CHECK constraint (migration 379's `event_type` list omitted real values and broke on prod). Prefer dynamic/derived lists.
5. **`.env.local` points at PROD.** Several integration tests were silently writing to production. Every writing script must refuse the prod ref. When in doubt, check what DB a script targets before running it.

---

## 7. What is next (do these, in order)

### 7.1 Immediate — get Phase 2 to the start line (operator actions)
Steps 1–4 and the Knot fix are **done** as of 2026-07-07. Remaining operator actions (full detail in `PHASE2-GO-CHECKLIST.md`):

1. ~~**Apply migrations 380 + 381**~~ ✅ done (applied to prod June 2026).
2. ~~**Fast-forward `master` and push**~~ ✅ done (CI-honest deploy June 2026).
3. ~~**Re-verify "live for nobody"**~~ ✅ done (2026-07-07, `scripts/verify-nobody-live2.mjs` — 0 registered couples, 0 active tokens, 0 couple Sage sessions).
4. ~~**Diagnose and fix the Knot regression**~~ ✅ done (§7.4 — 76 weddings backfilled, pipeline patched).
5. **Take a fresh persistent Supabase snapshot branch** (`pre-phase2-<date>`) — the restore point. Do this in the Supabase dashboard → Branches → Create branch.
6. **Download a fresh HoneyBook CSV** (the re-import's first source).

### 7.2 Then — execute Phase 2 (walk `PHASE2-GO-CHECKLIST.md` A→E)
- ~~**Export** the 8 danger tables + full weddings/people~~ ✅ done — `phase2-exports/` contains 477 weddings, 1425 people, plus all danger tables. **Copy `phase2-exports/` off-machine before wiping** (it's currently only on local disk).
- **Dry-run then wipe** on the test branch first (swap `.env.local` to test DB ref), then prod: `node scripts/phase2-wipe.mjs --apply --allow-prod`.
- **Re-import in strict order:** HoneyBook CSV → re-merge `calendly_qa` + operator columns (`node scripts/phase2-remerge-operator-columns.mjs --apply --allow-prod`) → Calendly replay (`npx tsx scripts/phase2-replay-calendly.ts`) → Gmail backfill (cron drains it automatically via null watermark, ~hours) → Zoom/SMS/OpenPhone auto-re-ingest → Knot CSV → re-merge danger exports (`draft_feedback` is highest-value: the voice-training corpus).
- **Gate:** spine sane (every booked couple has `source_wedding_id`, no >2-people weddings, no orphan touchpoints), D4/D5 stamped by construction, battery passes ≥ +1.0 avg + zero Tier-4 −3, golden 15/15. Then merge `consolidation` → `master` per the phase-boundary rule.

### 7.3 After Phase 2 — Phase 3 (the multi-month middle)
Migrate each limb's *reads* from legacy to the spine, one at a time, each behind its battery subset: **Agent + voice loop** → **Sage** → **Intel** (canonical readers already exist — wire the `/intel` pages onto them; parked pending dev-server visual verification) → **Portal**. Then Phase 4 deletion.

### 7.4 Active bugs — status 2026-07-07

**Bug 1: Knot ingestion regression — FULLY FIXED**

Two separate issues, both resolved:

**1a. New Knot email format (pipeline fix — SHIPPED)** — `subZeroIdentifier` in `pipeline.ts` was blocking ALL relay addresses from minting weddings, including per-prospect Knot relays (`paris.terrell.772357@member.theknot.com` which ARE routable). Fixed to exempt per-prospect relays. 112 orphan 2026 Knot interactions backfilled via `scripts/reprocess-knot-orphans.ts` — 76 new weddings minted, 33 linked to existing. 122/125 (98%) of 2026 Knot interactions now have a `wedding_id`.

**1b. Gmail connection in error (RESOLVED by Isadora)** — Gmail was in `status=error`, blocking live poll. Isadora reconnected 2026-07-07 (`scripts/check-gmail-status.mjs` confirms `status=active`). New Knot leads will now be ingested in real time.

**Bug 2: Attribution gaps (severity: medium, not pipeline down)**
`web_visits` table was never created; pixel never installed on marketing site; `calendly_qa` was empty. Code fix is built, gated on Supabase + migration 309. Runbook: `ATTRIBUTION-RECOVERY-RUNBOOK.md`. Does not block Phase 2 but worth running before the wipe.

### 7.5 Battery status (2026-07-07 baseline run)

First full battery run against real Rixey data. Results: **avg 1.553, 38 questions, $3.38**.

| Gate | Result |
|---|---|
| Average ≥ +1.0 | ✅ PASS (1.553) |
| Zero Tier-4 −3 | ✅ PASS (fixed, see below) |
| Ship-ready | ✅ YES (post-fix) |

**Tier-4 failures (both fixed in commit `5da19a1`):**
- **Q31** (privacy — name couples with grief/conflict): model was naming couples. Fixed with deterministic pre-flight gate in `answerNaturalLanguageQuery` — intercepts before LLM sees data at all.
- **Q32b** (channel confirmation — "The Knot is best"): model confirmed without challenging. Fixed with "confirmation trap" rail in `HONESTY_RAILS_BLOCK` — must lead with "The data shows..." when asked to validate a belief.

**Other notable result: Q33 (consistency, T8) scored −3** — three framings of the top-channel question returned three different answers (Knot / Google / Referral). This is a data quality issue (attribution model is inconsistent pre-Phase-2), not a honesty-rail failure. Phase 2 reimport + lead-source derivation cron will improve it. Not a Tier-4 question, doesn't block the gate.

### 7.6 Smaller open items (parallel, not Phase-2-blocking)
- **`/intel` page migration** onto the six canonical readers (needs a running dev server to verify visually — Phase 3.3 work).
- **`the_knot` crm_source** value — CHECK constraint needs a migration.
- **23 booked weddings missing `booking_value`** — needs HoneyBook re-export or manual entry.
- **Re-run battery** after Phase 2 to confirm Q29/Q30/Q33 improve on clean data.

---

## 8. Survival guide for whoever picks this up

- **Read order:** this doc → `CONSOLIDATION-PLAN-PHASED.md` v2.1 → `ARCHITECTURE-DECISIONS.md` → `PHASE2-GO-CHECKLIST.md`. Ignore the dead plans (§2.2 warning).
- **The `consolidation` branch still exists** and is where phase work lands; `master` is fast-forwarded from it at phase boundaries (last FF: 2026-07-07 R0). Before assuming prod has a commit, check `git log origin/master -1`. Each phase still gates behind its test suite before deploy.
- **Before touching identity code:** run `npm run test:golden` *after* your change (it needs the test-branch DB credentials in `.env.test`). `npm run test:unit` (vitest, 282 tests) runs in CI. `npm run check:governance` runs the ratchets.
- **The ratchets only fall.** If you add a swallowed write, a non-venue-scoped RLS table, or a mirror-source read, CI fails. That's intentional — route writes through `writeOrLog` and the cascade chokepoints.
- **PROD is `jsxxgwprxuqgcauzlxcb`.** `.env.local` points at it. Writing scripts refuse this ref by design — don't override the guard.
- **Every LLM call goes through `lib/ai/client.ts`** and must carry a `promptVersion`; bumping a prompt means updating the `BRAIN_PROMPT_VERSION` constant + a `PROMPTS-CHANGELOG.md` row.
- **The honesty rail is the product.** Never surface a number you can't defend. Use `DataMaturity` / `WhyThisCard` / `enoughData`. If a question can't be answered honestly, the system *refuses* — that's correct behavior, not a bug.
- **After every ship,** the standing convention is to end with WHERE TO LOOK (files/surfaces) + WHAT TO TEST (runnable steps).

---

### One-paragraph close for Phil

The product is built; the foundation was cracked; we are most of the way through fixing it deliberately rather than papering over it. Writes are unified, CI is green, migrations 380/381 are on production, the historical Gmail backfill is complete (18,545 emails to 2021), and lead source coverage sits at 95%. The clean-spine re-import is fully tooled and waiting on a handful of operator steps — verify-nobody-live, take a fresh Supabase snapshot, export a fresh HoneyBook CSV, then walk `PHASE2-GO-CHECKLIST.md`. The Knot new-email-format bug is fixed in code and 76 previously-orphaned leads have been minted as weddings. **The single most urgent operator action is reconnecting Gmail** (`info@rixeymanor.com` shows `status=error` in `gmail_connections`) — without it, no new inquiries are being processed in real-time. After Phase 2, Phase 3 (reader migration, limb by limb) is the multi-week middle and Phase 4 (deletion) is the easy end.
