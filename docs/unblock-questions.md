# Unblock questions

**Date:** 2026-05-08
**Owner:** Isadora Martin-Dye

Every open item across Tier-B, Tier-C, and Tier-D that's blocked on
your input. Grouped by what your answer unlocks, sorted within each
group by leverage.

Reply inline with one-line answers (or "skip" / "not now"). Any
group A or B answer unblocks 30-60 min of code I can ship in the
next session.

---

## Group A: UX decisions that unlock concrete code (9 items)

These each ship in 30-60 min once you decide. From `sarah-portal-ux-deferred.md`.

**A1.** Final Review badge currently shows `42d`. Audit said "confusing." Pick one:
- (a) `T-42` (countdown convention)
- (b) `42 days` (verbose, takes more sidebar room)
- (c) Keep `42d` text, add color cue (green > 21d / amber 8-21d / red ≤ 7d)
- (d) Tooltip on hover only, no badge

**A2.** Mom-52 accessibility: do you want me to ship a generic AA-contrast + 16px-base + 200%-zoom-tested pass on the couple portal? Or do you have a specific gap to fix?

**A3.** "Picks" / "Venue Inventory" / "Inspo" — these three sidebar items overlap. Pick one:
- (a) Keep all three, just rename for clarity (give me the new names)
- (b) Merge into one section called `___`
- (c) Defer until first real couple complains

**A4.** Emotional-reaction copy: open `/couple/hawthorne-manor` and quote the 3-5 phrases that feel wrong. I'll fix them inline.

**A5.** "Weeknight-9pm-couch" design: pick the philosophy:
- (a) "Every primary action reachable in one tap from What's Next, no >2-line paragraphs in the default view, all animations under 150ms"
- (b) Something else (one line)
- (c) Skip — not a real bar yet

**A6.** David-friendly partner views: pick one:
- (a) Build per-partner home with filtered task list
- (b) Just add an "assigned to <name>" notification filter
- (c) Skip — defer until both-partner-active is a real customer ask

**A7.** Progressive disclosure: ship site-wide pass, or pick 1-2 surfaces?

**A8.** One-task-at-a-time mode: pick one:
- (a) Distraction-free overlay on existing checklist
- (b) Reorder existing list with "focus on this" affordance
- (c) Separate `/focus` route
- (d) Skip — record a Loom of what you envision

**A9.** First-time onboarding skip: when a couple has completed all 5 getting-started items and visits `/getting-started` directly, pick one:
- (a) Redirect to `/whats-next`
- (b) Show a "Welcome back" different layout
- (c) Skip — current state fine

---

## Group B: One-line backend / ops decisions (8 items)

**B1.** Quote-to-book delta writer (#161): the column ships; how does the value get populated?
- (a) Manual coordinator entry on wedding detail page
- (b) Auto-extract from contracts on signing
- (c) Auto-extract from operator's last outbound dollar amount before booked transition
- (d) Skip the writer, leave column for future

**B2.** Guest demographics writer (#163): same shape:
- (a) Manual entry on guest list
- (b) Brain-dump-driven (operator paste prose, AI extracts)
- (c) Skip the writer

**B3.** Reviews scrape (#167): no scrape exists today. Pick one:
- (a) Build a SerpAPI-backed scrape that pulls Knot + WeddingWire + Google reviews weekly. Cost: ~$10/mo per venue. I scope + ship.
- (b) Stay coordinator-upload-only via brain dump screenshots
- (c) Skip — reviews are too low-volume to scrape

**B4.** Final Review 42-day badge color cue (separate from A1 — even if you keep `42d` text, do you want urgency colors?). Y/N.

**B5.** Cron count is at the 40-limit per Vercel Pro. To add new crons we need to either prune existing (#158) or upgrade Vercel plan. Decide:
- (a) Stay at 40 — I do a prune sweep when needed
- (b) Approve upgrade to Vercel Enterprise tier (≈$3.5K/mo)
- (c) Continue current pattern (consolidating crons into prune_maintenance bundle)

**B6.** Voice DNA Gmail backfill (#176): do we have a Rixey Gmail with 6-12 months of historical email I should backfill into voice training samples? Y/N.

**B7.** intelligence_extractions structuring (#162) requires re-classifying every existing row. Decide:
- (a) Ship the schema; backfill nothing; new rows opt in
- (b) Schedule a backfill cron (~1 day Claude inference cost: ~$50)
- (c) Skip — current `value jsonb` works fine

**B8.** Demo/prod Supabase split (#112-115): when does this become urgent?
- (a) When first prospect asks in writing — currently skipped per our 2026-05-08 reframe
- (b) Now — I should pre-build the playbook
- (c) Never — RLS hardening is the actual fix

---

## Group C: Strategic / fundraise decisions (15 items, longer-form)

These don't unblock code I can ship, but they unblock business decisions. I can DRAFT each as a starting template if you want.

**C1.** TAM / SAM / SOM rebuild with sources — want a draft template?
**C2.** Moat-economics analysis (LTV/CAC math) — draft?
**C3.** Platform vs point product decision — your call; I won't guess
**C4.** B2B2C distribution model at $1M / $5M / $20M ARR — draft?
**C5.** Fund-returner math vs realistic ceiling — draft?
**C6.** "Kill case" obituary — write your own; I can give you the template
**C7.** HoneyBook acqui-hire vs build defense doc — draft?
**C8.** Competitive landscape teardown (Aisle Planner, HoneyBook, BrideBook) — draft?
**C9.** Aisle Planner UX bake-off — needs you to spend 2 hours in their product
**C10.** Series A org chart — your call
**C11.** Financial model with runway scenarios — draft skeleton with placeholders?
**C12.** Expansion-vertical deep dive (corporate / B&B / retreat) — draft?
**C13.** Enterprise pricing for Wedgewood — your call when prospect surfaces
**C14.** Second roll-up pipeline (alternative to Wedgewood) — your call
**C15.** Investor-readiness checklist — draft?

**Verdict needed:** which of these (if any) do you want me to draft a template for?

---

## Group D: Pricing / GTM decisions (10 items)

**D1.** Founding Member terms beyond the 50%-off headline — what are the locked-in terms? (length of discount, transfer rights, refund policy)

**D2.** Annual prepay precise % — what discount on annual vs monthly? (industry standard is 15-20%)

**D3.** Payment failure / dunning escalation — current implementation:
- Day 0: Stripe retries automatically
- Day 1-7: notification fires, no email
- Day 7+: ?
What should happen at day 7, 14, 21, 30?

**D4.** Cancellation policy:
- (a) Cancel anytime, lose access end of billing period
- (b) 30-day notice required
- (c) Pro-rate refund
- (d) Other

**D5.** Per-seat vs flat pricing — within a venue, do additional coordinators cost extra? Y/N.

**D6.** Per-email pricing — does email volume matter, or all-you-can-eat? Y/N.

**D7.** Tier-naming — current: pre_opening / solo / growth / multi / enterprise. Audit said "reconsider." Keep, or rename?

**D8.** Demo→signup conversion measurement — install Mixpanel / PostHog? Y/N + which.

**D9.** Sales-assisted vs self-serve gating — at what tier does someone have to talk to you to sign up?

**D10.** Founder-led GTM ceiling — at what ARR does this break? Trigger to start hiring sales?

---

## Group E: Hiring + project transfers (4 items, all your call)

**E1.** Engineer #1 JD draft — should I draft a starting JD?

**E2.** Solo-founder full-time commitment date — when do you go full-time on Bloom (vs Rixey + the others)?

**E3.** Project pause/transfer plan for the other four (Threadline, Presshouse, ContractHouse, Ground). Each one:
- Threadline: pause / transfer / kill?
- Presshouse: pause / transfer / kill? (note: it's absorbed Bloom internal ops)
- ContractHouse: pause / transfer / kill? (note: live with paying customer Rixey)
- Ground: pause / transfer / kill?

**E4.** Co-founder / CTO target shortlist — your call on people.

---

## Group F: Customer-pull triggers (questions about reality)

These don't need answers now; they're future signals that unpark items.

**F1.** First non-Rixey paying customer signed — who, when?
- Unblocks: real-customer onboarding bugs, multi-venue issues, anonymized testimonial

**F2.** First Wedgewood-tier prospect call — who, when?
- Unblocks: #112-115 demo/prod split, #133-137 multi-venue features, SLA negotiation

**F3.** First EU venue interest — who, when?
- Unblocks: SCC paperwork, region pinning playbook, GDPR DSAR pathway

**F4.** First customer that demands physical Supabase separation in writing — who?
- Unblocks: #112-115 (currently parked)

**F5.** First customer that demands a native API integration (HoneyBook / Tripleseat / etc.) — who, which platform?
- Unblocks: #142-146 (currently replaced by universal ingest)

**F6.** First SEV1 incident — date, what failed?
- Unblocks: real on-call rotation, INCIDENT.md revision with actual data

---

## Group G: Trust / proof items (4 items, marketing-driven)

These are the Tier-B items that have been waiting since April. All need you, none need me.

**G1.** Real testimonial — from Rixey couples or coordinators?

**G2.** P&L disclosure on the marketing site — yes / no / partial?

**G3.** Loom demo — does one exist? (memory had this as Tier-B)

**G4.** Money-back guarantee — offered? what terms?

---

## Recommended answering order

If you want maximum code-shipped per minute of your time:

1. **Group A** (9 quick decisions = ~6-8 hours of shipped code)
2. **Group B** (8 decisions = ~4-6 hours shipped)
3. **Group D** (pricing / dunning specifics = ~2 hours shipped)
4. **Group E1** (engineer JD draft, if you want me to draft one)
5. **Group F** (no decisions, just status — but useful for me to know)
6. **Groups C, E2-E4, G** — these are your judgment calls; I can't help much

Skip any item with "skip" and I'll never ask again. If you want me
to draft the templates in group C, just say which numbers.
