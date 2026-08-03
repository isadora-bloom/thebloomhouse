# Ingestion & Intel-File Doctrine — Phil's Starting Brief

**Author:** Isadora + Claude, 2026-07-17
**Audience:** Phil, picking up ingestion and intel-file construction.
**Status:** Working doctrine. Reconciled against code and against the freshest
state docs (`HANDOFF-STATE-OF-BLOOM-HOUSE.md`, `REMEDIATION-PLAN-2026-07-07.md`,
both July 2026). Where a doc in the repo contradicts the code, this brief says so.

---

## Read this first, in one line

The ingestion machine and the intel-file machine are **already built and mature**
(382 migrations, a live cascade writer, a per-couple forensic profile). Your job is
not to build them. It is to **understand the one write path, verify it end to end,
and help execute the clean re-import (Phase 2) that has been tooled and is waiting on
operator steps.** Most of what feels like a roadblock is operational, not missing code.

---

## 1. The mental model: two ways in, one way written

Isadora framed it correctly. There are two ingestion paths:

- **Looking back** — everything that already happened. Reconstructed by *replaying*
  each origin source (HoneyBook CSV, Calendly, Gmail history, Knot, reviews, pixel)
  back through the writer.
- **Real time** — new signal arriving now. Live crons and webhooks feed the same writer.

The important correction to hold onto: **both paths write through the same function.**
There is exactly one writer: `linkSignal` in `src/lib/spine/cascade.ts` (it re-exports
the mint functions and does the dual-write). "Re-onboarding a venue" is defined as
replaying each origin back through `linkSignal`. Live ingestion is the same call from a
webhook or cron instead of a replay script.

> **Stale idea to discard.** Older docs and older memory describe a separate
> "Backwards Tracer" that read database *mirrors* with its own writer. That system was
> **deleted** (the Origin-Ingestion doctrine, 2026-05-28) precisely because two writers
> meant two sources of truth. If you see "Backwards Tracer" as a live component, treat
> it as historical. One writer now. This is what makes the re-import correct by
> construction.

---

## 2. How ingestion works (the spine)

Signal flows: **origin source → adapter → `linkSignal` → identity resolution →
couple spine + event log.**

**Where raw messages land:**
- `interactions` (migration `002_agent_tables.sql`) — the message corpus. `type` in
  (`email`, `call`, `voicemail`, `sms`, `meeting`). Sender/recipient identity lives in
  `from_email`, `from_name`, `to_email` (mig `063`), indexed. Full body in `full_body`.
- `touchpoints` (migration `346_identity_first_phase_a.sql`) — the unified, identity-first
  event log, dual-written alongside `interactions`. Keyed to `couple_id`, one row per
  channel event, `UNIQUE(venue_id, channel, external_id)`.

**The identity entities:**
- `couples` (mig 346) — one row = one couple. **This is the spine.** Carries
  `primary_contact_{name,email,phone}`, `partner_contact_{...}`, `wedding_date`,
  `lifecycle_state`, `heat_score`, `source_wedding_id`. Indexed on lower(email) and
  phone for fast lookup.
- `people` (mig `001`) — individual humans. Has `email`, `phone`, and
  `alias_emails text[]` (GIN-indexed, for proxy addresses like `@member.theknot.com`).

**Identity resolution (match-first mint).** Given an inbound signal, the resolver runs
a match chain (email exact → email canonical → phone → name+date → mint new). Code:
- `src/lib/services/identity/resolver.ts` — `resolveIdentity`, `resolvePersonOnly`.
- `matcher.ts` (scoring), `llm-judge.ts` (LLM tie-break), mint fns `mint-person.ts`,
  `mint-couple.ts`, `mint-wedding.ts`, DB primitive `359_lock_and_mint_couple.sql`.
- Merge/dedup: `merge-people.ts`, `auto-merge-duplicates.ts`, `379_couple_merge_primitive.sql`.

**Proof it's queryable by identity:** the live Twilio SMS webhook
(`src/app/api/webhooks/twilio/route.ts`) already resolves every inbound text by phone
number, then hydrates the wedding. So "look up all messages for this phone / email /
couple" is a solved, exercised path, not a theory.

**The source adapters (all built):**
| Source | Entry point |
|--------|-------------|
| Gmail (live) | `src/lib/services/email/gmail.ts` + edge fn `email-poll` (5-min cron) |
| Gmail (history) | `src/lib/services/email/historical-backfill.ts` |
| SMS — Twilio | `src/app/api/webhooks/twilio/route.ts` |
| SMS/calls — OpenPhone | `src/lib/services/ingestion/openphone.ts` |
| Calendly | `src/app/api/webhooks/calendly/route.ts` + `ingestion/calendly.ts` |
| HoneyBook CSV | `src/lib/services/crm-import/honeybook.ts` (real, ~840 lines) |
| Calculator / web form | `ingestion/scheduling-tool-parsers.ts`, `crm-import/web-form.ts` |
| Zoom, Omi audio, Knot, reviews | `src/lib/services/ingestion/*` |

> **Stale comment to ignore.** The header of `src/lib/services/crm-import/index.ts`
> still says HoneyBook is "SCAFFOLD ONLY … throws not yet implemented." That is out of
> date. `honeybook.ts` is a real, promoted implementation. Trust the code, not the header.

---

## 3. How the intel file is built (the "per-couple file")

The intel file Isadora means is realised as two tables plus an assembler:

- **`couple_identity_profile`** (mig `260`) — one row per couple, a jsonb `profile`
  holding names, emotional truths, occupations, residence, family dynamics, vendor
  preferences, accessibility needs, cultural signals, decision dynamics. **Every claim
  carries a verbatim `evidence_quote`.** This is the forensic dossier.
- **`couple_intel`** (mig `261`) — the per-couple intel rollup on top of the profile.

**The assembler:** `src/lib/services/identity/reconstruct.ts`. It gathers *every* signal
for a couple (interactions, calculator evidence, HoneyBook, calendar, Calendly, reviews,
contracts, payments, tangential handles), runs one Sonnet call, and upserts the profile.
Queue: `identity_reconstruction_jobs` (mig 260). Endpoint: `POST /api/admin/identity/reconstruct`.

**Reading it back out:** the only sanctioned read surface is the **six canonical read
functions** in `src/lib/intel/canonical.ts` (`getVenueOverview`, `getSourceAttribution`,
`getCohortFunnel`, `getCoupleJourney`, `getDailyList`, `askIntel`). Doctrine: that number
never grows; new needs become parameters, never a seventh function.

> **Verify this yourself (docs disagree).** The header of `canonical.ts` still says
> "STATUS: STUB … implementations return honest-empty." But `HANDOFF` §5 and the
> remediation plan both state all six are now real, tested, and CI-wired, just **not yet
> wired to the `/intel` pages** (parked since June). So: the read functions are probably
> live, the header is probably stale, and the page-wiring is genuinely still open. Open
> the file, check the function bodies, and settle it before relying on either claim.

---

## 4. Step one, in the code's terms

Isadora's step one — *"HoneyBook CSV of booked clients, work back, then Calendly, then
calculator, using emails and text to build a file"* — is already a tooled procedure. It
is the **Phase 2 clean re-import**, and the order she described is the order the runbook
uses, for the same reason: **process highest-confidence anchors first.**

- **Booked (HoneyBook CSV)** = ground truth. Known couple, known outcome, known date.
- **Calendly** = met/toured, outcome open.
- **Calculator / web form** = inquiry only.

Because a booked couple also submitted the calculator and also had a Calendly call,
running them in confidence order means each later source mostly *enriches* couples
already minted (match-first mint). What is *left over* at the calculator tier, the ones
who never progressed, is the clean lost-lead set. You get reconstruction and a "why
didn't they book" population from the same pass.

The runbook and exact command order live in **`PHASE2-GO-CHECKLIST.md`** (walk A→E). The
re-import sequence:

```
HoneyBook CSV
  → re-merge calendly_qa + operator columns   (scripts/phase2-remerge-operator-columns.mjs)
  → Calendly replay                            (scripts/phase2-replay-calendly.ts)
  → Gmail backfill                             (cron drains automatically, ~hours)
  → Zoom / SMS / OpenPhone                     (auto re-ingest)
  → Knot CSV
  → re-merge the 8 danger exports              (draft_feedback is the voice-training corpus)
```

A clean spine falls out by construction, because everything replays through the one writer.

---

## 5. Where things actually stand (the honest roadblock list)

**Done and verified:**
- Phase 0 (prereqs) and Phase 1 (write-path unification) complete. Every writer routes
  through `linkSignal`. CI green.
- Gmail historical backfill complete: 18,545 emails back to 2021.
- Gmail live connection reconnected 2026-07-07 (`status=active`). Real-time inquiries flow.
- Knot ingestion regression fixed; 76 orphan weddings minted, 98% of 2026 Knot linked.
- Lead-source derivation run: 381/400 weddings have a source (95%).

**Blocked / open (this is the real work):**
1. **Phase 2 is fully tooled but not executed.** It waits on operator steps: take a fresh
   Supabase snapshot branch (`pre-phase2-<date>`), export a fresh HoneyBook CSV, then walk
   the checklist. **Safety:** `phase2-exports/` (477 weddings, 1425 people, all danger
   tables) currently lives only on local disk. Copy it off-machine before any wipe.
2. **The six canonical readers aren't wired to the `/intel` pages** (built, parked, needs
   a dev server for visual verification). Phase 3.3 work.
3. **Attribution gaps:** `web_visits` table never created, marketing pixel never installed,
   `calendly_qa` was empty. Fix built, gated on Supabase + migration 309. See
   `ATTRIBUTION-RECOVERY-RUNBOOK.md`. Worth running before the wipe, doesn't block it.
4. **Smaller:** 23 booked weddings missing `booking_value`; `the_knot` crm_source needs a
   CHECK-constraint migration.

---

## 6. Phil, start here

**Read, in this order:**
1. `CLAUDE.md` — repo orientation.
2. This file.
3. `HANDOFF-STATE-OF-BLOOM-HOUSE.md` — the freshest full state. §7 is the do-next list.
4. `IDENTITY-FIRST-ARCHITECTURE.md` — why the couple is the unit of intelligence.
5. `PHASE2-GO-CHECKLIST.md` — the operational runbook for step one.

**Trace one signal end to end before changing anything.** Pick a real booked couple and
follow it: origin adapter → `linkSignal` (`src/lib/spine/cascade.ts`) → resolver
(`src/lib/services/identity/resolver.ts`) → `interactions` + `touchpoints` + `couples` →
`reconstruct.ts` → `couple_identity_profile`. When you can narrate that path from memory,
you understand the system.

**Safe read-only commands to orient (never `--apply` without operator sign-off):**
```bash
npm run dev                              # http://localhost:3000
node scripts/check-gmail-status.mjs      # confirm live connection is active
node scripts/verify-nobody-live2.mjs     # confirm safe-to-wipe state
node diag-honeybook-import.mjs           # inspect the HoneyBook adapter's behaviour
```
The wipe/re-import scripts (`phase2-wipe.mjs --apply`, the replay scripts) are
**operator-gated and destructive.** Understand them, dry-run them against the test DB,
but do not run them against prod without walking the checklist with Isadora.

**Your first deliverable back to us:** a short written confirmation of the actual state
of two things the docs are unsure about — (a) are the six `canonical.ts` read functions
really implemented or still stubbed, and (b) does a full trace of one couple hold up in
the live data. That tells us whether the roadblock is "wire the readers and run Phase 2"
or something deeper. Verify against code and data, not against the docs.

---

Related, narrower doc already in the repo: `IDENTITY-BACKFILL-PLAN.md` (the operational
contract for replaying historical *name* signals through the capture chokepoint). This
brief is the wider orientation around it.
