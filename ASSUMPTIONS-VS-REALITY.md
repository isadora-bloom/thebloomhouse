# Assumptions vs Reality — Audit of the Consolidation Plan

**Date:** 2026-05-21  
**Cause:** the consolidation plan was built on guesses. The most concrete one ("Gmail backfill probably 90 days") was wrong by a factor of 12 (it is 1095 days for booked couples and already exists). If one cornerstone claim is wrong, every claim has to be re-verified before any consolidation work begins.

This document is the result of grep + read + count against the actual codebase. Every line is sourced.

---

## Counted reality

| Claim in the plan | Verified reality | Verdict |
|---|---|---|
| "~111,457 lines of TS/TSX in src/" | **85,877** | Overstated 30%. Deletion target (-40k) means deleting nearly **half** the codebase, not a third. |
| "365 migrations" | **363** | Close enough. |
| "30-40+ intel surfaces" | **65 page.tsx files under `src/app/(platform)/intel`** | **Understated.** Surface graveyard is bigger than I claimed. |
| "100+ intel sub-services" | **80 files in `src/lib/services/intel/`** | Slightly overstated. |
| "12 brain files" | **14** in `src/lib/services/brain/` | Close. |
| "5 identity resolution paths" | **70 files in `src/lib/services/identity/`** | **Drastically understated.** "Five paths" was rhetorical convenience. The actual sprawl is an order of magnitude bigger. |
| "Gmail backfill is probably 90 days" | **1095 days (3 years) for booked + completed couples, already built at `src/lib/services/email/historical-backfill.ts`** | **WRONG.** Off by 12x. The service I "specced" already exists end-to-end including the Backwards Tracer trigger when both phases complete. |
| "12 healing crons" | **47 cron paths in `vercel.json`** | Way understated. Cron sprawl is 4x what I claimed. |

---

## The most damning new number

**596 references to `.from('weddings')`, `.from('people')`, or `.from('interactions')` across `src/lib`** vs **~30 references to `.from('couples')` or `.from('touchpoints')`**.

The legacy stack is overwhelmingly where the system lives. The spine is a 5% presence in the codebase. My phrase "the cascade is supposed to be canonical, it actually is not" was right but the magnitude is worse than implied: the cascade has **two real call sites** (`matcher.ts:364`, `resolution.ts:548`) and the rest of the code (literally hundreds of call sites) writes and reads the legacy tables directly.

The doctrine "all things feed the spine" is aspirational, not actual. Not in any meaningful sense.

---

## Specific claims I should verify line-by-line

### Claim: "The orphan-sweep at `pipeline.ts:2248` re-parents interactions to new wedding."

**Verified.** Line 2249-2257 reads:
```ts
await supabase
  .from('interactions')
  .update({ wedding_id: weddingId })
  .eq('person_id', personId)
  .is('wedding_id', null)
```
This is exactly what I described. Comment block 2240-2247 explains it was added 2026-04-30 for the Ryan Schubert calculator orphan case. Confirmed.

### Claim: "The deep-Gmail backfill needs to be 2-3 years; just for booked clients."

**Already built.** `src/lib/services/email/historical-backfill.ts` constants:
- `LOOKBACK_DAYS_BOOKED = 1095` (3 years)
- `MAX_MSGS_PER_COUPLE = 80`
- `MAX_MSGS_PER_WEEK = 400` for the general phase

Two-phase service: a 12-month general inbox sweep, then a per-booked-couple 3-year search by email + quoted full name. Triggers Backwards Tracer when both phases finish.

State lives on `venues.gmail_backfill_status / _phase / _cursor / _emails / _updated_at`. Cron drains one venue per tick in `src/app/api/cron/route.ts:500`.

**I do not know whether this has actually been run on Rixey.** That is a one-row read I cannot do without operator help (or service-role DB query). The right next step is to check `gmail_backfill_status` on the Rixey venue row before specifying any new backfill work.

### Claim: "The LLM judge band adds cost; could be deleted."

**Partly verified.** `llmJudgeFired` appears in `src/lib/services/attribution-roles/intent-classifier.ts` (~5 references) and `src/lib/services/identity/decision-clustering/cluster-proposals.ts`. The judge IS wired. My critique that the cost is real stands; the conclusion (delete it) needs more careful analysis because the judge is doing real work in attribution role classification, not only in identity matching.

**Self-correction:** my consolidation plan said "drop the judge call entirely." That was a guess. The judge is in at least two systems (intent-classifier + cluster-proposals), and I have no measurement of how often it fires or what its accuracy is on production. Removing it without that measurement could damage classification quality.

### Claim: "~25 writer call sites to weddings/people/interactions to migrate."

**Not verified accurately.** My initial grep returned only 2 (with too-narrow pattern). A re-grep returned 596 total references across reads + writes. The actual writer count is somewhere between those two extremes; I would need to filter properly with an AST-aware tool or careful multi-pattern grep, not a regex that requires writers + tables on the same line.

**The honest answer:** I do not know the writer count. The consolidation plan's "Days 7-9: migrate the high-volume writers" cannot be sized without first producing a real count.

---

## What this means for the plan

Three concrete updates needed before any code moves:

1. **The deep-Gmail backfill task is wrong.** It is already built. The real task is: run it (or verify it has been run) on Rixey, then look at the `gmail_backfill_emails` count vs the booked-couple count to know whether it actually pulled history. If it hasn't been triggered, trigger it. If it has run and the 63 Untracked bookings still have no source, the failure mode is downstream of backfill (backtrace not finding the right emails, or the recovered source not propagating into attribution_events). That changes the diagnostic completely.

2. **The "~25 writer call sites to migrate" estimate is unsupported.** The real number is between 2 (my too-narrow grep) and ~hundreds (the broad grep). Before sizing the migration sprint, an actual AST-aware audit needs to run. Day 1's parallel-agent audit should target this specifically rather than vague "find every writer."

3. **The "delete ~40,000 lines" target was scaled against an inflated 111k LOC base.** The real base is 85,877. A 40k delete is closer to 47% of the codebase, not the 36% the plan implied. This is more aggressive than I framed it. Possibly correct — most of the surface area IS dead — but worth saying out loud.

---

## The rule going forward

**Every claim in any future plan must be grep-verified or read-verified before it is written.**

That includes line counts, file counts, route counts, behavior of named functions, lookback windows, cron schedules, environment-variable defaults, whether a code path is wired up, and whether a service has actually been run on production data.

I will not write "probably," "I expect," "I assume," "I think the existing code does" in any consolidation plan again. If I cannot verify, the verification IS the first task in the plan, not an assumption underneath the plan.

The 30-day consolidation plan is paused until task #44 (this audit) is signed off and a refined plan based on real numbers is produced.

---

## Open questions only the operator can answer

These I genuinely cannot verify without operator help:

1. **What is the value of `venues.gmail_backfill_status` on the Rixey venue right now?** If null/never_started → backfill has never run. If `complete` → backfill has run; the 63 Untracked is a downstream failure. If `running` or `pending` → backfill is in progress; let it finish before doing anything else.

2. **Of the 63 Untracked bookings, how many have any interactions row at all in the local table?** If most have zero → backfill never reached them. If most have several → backfill worked, backtrace is the broken link.

3. **What does `gmail_backfill_emails` show for Rixey?** A number near zero means the backfill cron is not running or is failing silently. A number in the thousands means it has ingested but the binding step is the broken link.

Three SQL queries, executable in the Supabase SQL editor, would resolve all three. Once those answer, the consolidation plan can be honestly redrawn.
