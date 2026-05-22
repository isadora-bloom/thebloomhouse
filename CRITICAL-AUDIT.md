# Critical Audit — Why It Isn't Working

You're not crazy. You're not going in circles because you're slow. You're going in circles because the system has become structurally circular. Let me be honest about why, what's overengineered, what to wipe, and how to simplify.

## The honest diagnosis

You're running two products that disagree with each other, neither of which is finished. Every page you open is the union of three or four parallel attempts to model the same data. Every new surface added a new opinion about what's true. The user (you, today) opens any page and sees a number that doesn't match another page, and there is no way to tell which number is correct. That is the user experience of the actual product right now.

The original thesis is right. The body metaphor is right. The cascade I shipped today is genuinely a step forward. None of those are the problem. The problem is that we never deleted anything. Every new doctrine got layered on top of the previous one, and the result is a 111,000-line codebase where five different services claim to be the canonical source of "which channel acquired this couple" and they all disagree.

Below is the brutal version. I'll critique my plan first because it's still fresh, then the actual built code.

---

## What's overengineered in the plan I just wrote

**Five loops.** Susan doesn't need five. She needs one: the draft loop. The other four (prediction, attribution, positioning, capacity) are nice analyst features, not survival features. A wedding venue runs without those four; it does not run without an inbox. The plan implied parity. There is no parity. The Agent + the voice loop is 70% of the product value. Everything else is 30%.

**Four "limbs."** Agent and Sage are real. Portal is future (post-booking is months of behavior; the venue can survive the first year using HoneyBook for booked-couple comms). Intel as a "limb" is the wrong framing — Intel is the OUTPUT of the spine + Sage, not a peer organ. Calling it a limb implies it deserves equal engineering investment. It doesn't. Intel should be one page, not forty.

**Twelve crons.** Most of them exist to repair things the spine should never have broken. If the cascade is the only writer, you do not need a lifecycle drift detector. If touchpoints carry occurred_at + direction, you do not need a separate decay sweep — decay is a computed property at read time. The healing crons are tax on broken architecture.

**Four attribution models.** First-touch, last-touch, linear, time-decay. Susan asks "where did they come from." She means first-touch. The other three are answers to questions she does not ask, surfaced because the analyst in me thought it was elegant to support all four. Elegance is not product value.

**The LLM judge band.** I specced a Sonnet call to adjudicate mid-confidence cascade matches. At scale that is a real per-couple cost ($0.01-0.03 each) and a real latency hit, AND it's still going to wedge ambiguous matches that need a human. Drop the judge call entirely. Mid-band matches go straight to `candidate_matches` for operator review. Human-in-the-loop is cheaper, more honest, and one fewer thing to break.

**Twelve tables.** The actual minimum spine is six: `couples`, `touchpoints`, `tours`, `reviews`, `couple_merge_events`, `candidate_matches`. Everything else is either an optimization (`intel_rollups`, `voice_learning_events`) or a research artifact (`fragments`, `couple_progression_events`, `external_context`). Fragments are particularly suspicious — they're touchpoints that didn't anchor, which is just a `couple_id` of null. Same with progression events — they're a special case of touchpoints with a stricter set of action_types.

**The 90-day plan.** Six phases in 90 days is a six-month plan. A real team delivers 60% of it on time. Plan honestly: 120 days, three deliverables, each one provably correct before the next starts.

---

## What's overengineered in what's actually been built

I went through the actual repo. Naming names.

**Wave 4-8 entire stack.** Wave 4 forensic identity reconstruction (couple_identity_profile keyed on wedding_id), Wave 5A persona overlays, Wave 5B emerging themes, Wave 5D venue archetype thesis, Wave 6E agency tracker, Wave 7B forensic channel-role classifier, Wave 8 weather × tour outcomes. Each of these was its own multi-week build, each produced its own table, each produced its own surface, each is read by maybe two operators total. They are research projects shipped as production features. The thinking in each is impressive. The product surface area they created is the swamp.

**Three parallel "brain" modules.** `src/lib/services/brain/sage.ts` (couple-facing), `intel-brain.ts` (NLQ + positioning), `client.ts` (a third brain), `inquiry.ts` (a fourth), plus `review-response.ts`, `journey-narrative.ts`, `post-tour-brief.ts`, `re-engagement-drafter.ts`, `cancellation-classifier.ts`, `voice-dna-extract.ts`, `physical-presence-guard.ts`, `ai-disclosure.ts`, `intel-brain.ts`, `sage-identity.ts`. That's twelve brain files. The doctrine of "one Sage brain that powers all surfaces" was violated long ago. Each brain has its own prompt assembly, its own context loader, its own personality stack. They drift.

**Five identity resolution paths.** `resolver.ts` (writer), `resolution.ts` (reader), `matcher.ts` (pair scorer), `candidate-resolver.ts` (Wave 10 tier-based), `identity-cascade.ts` (today's new path), `tracer.ts` (the spine Tracer), `binder-cron.ts` (deferred binder). Plus the email pipeline has its own inline match chain that calls resolveIdentity directly. The cascade I shipped today is supposed to be canonical. It actually is not — it routes through `findIdentityMatches`, and the OTHER writers still write directly to weddings/people without going through it. Today's commit didn't fix that; it added a sixth path.

**Two attribution stacks.** `attribution/index.ts` reads wedding_touchpoints + attribution_events + weddings.source (legacy). `attribution/couple-attribution.ts` reads spine touchpoints (today). These show different numbers for the same couple. The legacy one is what /intel/sources renders. The new one is what /intel/attribution renders. The fact that you opened /intel/sources today and saw 63 Untracked while the new D3 surface would show different numbers is not a bug, it's the architecture.

**Forty-plus Intel surfaces.** `/intel/sources`, `/intel/roi`, `/intel/cohort`, `/intel/attribution`, `/intel/heat`, `/intel/source-quality`, `/intel/identity-review`, `/intel/agencies`, `/intel/alumni`, `/intel/anomalies`, `/intel/cultural-moments`, `/intel/discoveries`, `/intel/external-signals`, `/intel/forecasts`, `/intel/market-pulse`, `/intel/macro-correlations`, `/intel/matches`, `/intel/lost-deals`, `/intel/pricing-history`, `/intel/social-integration`, `/intel/weather`, `/intel/channel-truth`, `/intel/clients`, `/intel/marketing-spend`, `/intel/marketing-roi`, `/intel/insights`, `/intel/health`, plus per-couple drill-downs. Each one was a real PR with real intent. Together they are the surface graveyard. Susan opens one, doesn't see what she needs, never returns.

**The 365 migrations.** No team ever needs 365 migrations. Each migration is a moment when the schema changed because a doctrine changed. Migration count is a perfect proxy for how many times we contradicted ourselves.

**The healing cron stack.** `cohort-damping-refresh`, `cohort-rollup-sweep`, `cohort-rollup`, `couple-intel-sweep`, `enqueue-cohort-rollup`, `enqueue-couple-intel`, `enqueue-external-match`, `external-match-sweep`, `external-match`, `fred-demand`, `friction-score`, `inbound-haiku-classifier`, `inbound-haiku-drain`, `inbound-intent-classifier`, `inbound-intent-drain`, `insight-tracking`. These are operational debt. Each one exists because some other system writes inconsistent data and this cron repairs it. The repair tax is permanent because the writers are permanent.

**Two LLM classifiers for the same input.** Looking at `bloom-classifier-unification` memory: there used to be three Haiku classifiers (`classifyEmail` + `classifyInboundIntent` + `classifyFolderAI`) for every inbound message. We collapsed three to one. Good. But the doctrine that produced three in the first place — let's add another classifier for this new angle — is still the dominant pattern. The next wave will probably add a fourth.

**The judge-cron, the binder-cron, the tracer, the cascade.** Four overlapping mechanisms for the same job (decide which couple a signal belongs to). They each handle a different edge case the others miss. None of them is the canonical writer. That's the bug.

---

## What should be wiped and started over

I'll order these by leverage. Top of the list = biggest unlock.

**1. The legacy weddings/people/interactions/attribution_events stack.** Phase F sunset, properly executed this time. Today the spine (couples/touchpoints) is the future, but every legacy code path still writes to weddings/people. Every read path still falls back to weddings.source. The dual state is the problem. Pick a freeze date. After the date, the only valid writes are spine writes. Migrate every reader to read the spine. Delete weddings table writes. Keep weddings as a frozen audit log if you need history. The bookings page reads the spine. The attribution page reads the spine. There is no parallel attribution table.

The cost of this is one painful migration sprint (probably three weeks of focused engineering). The cost of NOT doing it is what you experienced this afternoon: opening a page, seeing a number you don't trust, with no way to know which subsystem produced it.

**2. The 40-page Intel module.** Wipe everything except a single landing surface (the daily list, see below). Move the rest to "deep dive" routes accessible via natural-language query. Each surface lives behind a Sage question, not a sidebar entry. If Susan asks "which channel is most expensive per booking" she gets a one-page answer; she does not need a dedicated `/intel/cac` route. The page is generated on-demand from one canonical Intel function.

This wipes ~30 routes and ~20 services. The underlying data is preserved. The surfaces go away because they were never earning their own UI real estate.

**3. The brain proliferation.** Twelve brain files collapse to two: an Agent brain (drafting + classifying) and an Intel brain (answering operator questions). Both go through the same canonical assembler. Both share the same per-venue voice + honesty rails. The journey-narrative, post-tour-brief, re-engagement-drafter, etc. become task-mode variants of the Agent brain with different task instructions, not separate brains. Delete ~8 files. The voice stays consistent because there is one prompt stack.

**4. The healing cron stack.** Most of these exist because writers are inconsistent. With one canonical writer (the cascade RPC), most of these go away. The decay sweep becomes a computed property (you don't store ghost; you compute it from last_progression_at at read time). The lifecycle audit goes away because the cascade writes the right state in the first place. The cohort-rollup crons collapse into one nightly rollup. Net delete: 10-12 cron files.

**5. The judge band LLM call.** Drop it. Mid-confidence matches queue for human review. Save the cost. Reduce the surface area.

**6. The Wave 4-8 surfaces.** Keep the underlying data extractions where useful (review-language themes feeding voice DNA is real). Wipe the dedicated dashboards (persona overlays, venue thesis, channel-role classifier presentation). Move what survives into the one Intel landing surface.

**7. The 365 migrations.** When you do the Phase F migration, also do a schema flatten: collapse the 365 migration files into a single fresh-baseline migration that creates the post-wipe spine. The migration history is preserved in git; the runtime migrations table is reset to one baseline + forward changes. This is cosmetic but it signals discipline to the next engineer.

---

## How to simplify dashboards

**One landing page.** Replaces /intel/sources, /intel/cohort, /intel/attribution, /intel/heat, /intel/source-quality, /intel/marketing-roi, /intel/dashboard, /intel/insights, and probably half the others.

Susan's daily list. The page has five blocks and nothing else:

**Block 1: Today.** Three couples to reply to. Each row: couple name, what they last said (one line), Sage's drafted reply (collapsed), heat score, last touched. Click a row, see the draft. Approve, edit, send. Done.

**Block 2: This week's tours.** One line per tour: couple name, date/time, who's conducting, pre-tour brief link. Click for the briefing.

**Block 3: At risk.** Three couples whose heat is dropping. Each row: couple, days since last inbound, what to do (Sage's suggestion). One click to send the suggested follow-up.

**Block 4: This week's one pattern.** A single Sage-generated insight written in plain English. Not a chart. Not a number table. One paragraph. "Your Knot inquiries dropped 30% but Knot conversions are up 50%. The Knot leads you're getting are higher quality. Don't cut Knot spend, but consider why the volume drop happened." The pattern rotates weekly.

**Block 5: Ask me anything.** A text box. Sage answers operator questions in natural language with cited evidence. Today's /intel pages become questions Sage can answer when asked. "What's my response time?" produces the response-time analysis inline. "Who booked last quarter and where did they come from?" produces the attribution table inline. The deep dives are demand-driven, not always-present.

Five blocks. One page. The other 40 routes are gone or accessible only via "see all" affordances inside the blocks.

The radical idea: **dashboards are demand-driven, not supply-driven.** Today, Bloom shows 40 dashboards Susan didn't ask for. Tomorrow, Bloom shows the five things she needs every day and answers her questions on demand for everything else.

---

## Why this happened (the root cause)

Three patterns produced the swamp.

**Pattern 1: every doctrine update added a new layer instead of replacing the old one.** Wave 4 didn't replace Wave 3; it sat alongside. The cascade didn't replace the resolver; it sat alongside. /intel/attribution didn't replace /intel/sources; it sat alongside. The discipline "delete the old thing when you ship the new thing" was never enforced.

**Pattern 2: each new surface was easier to build than to delete.** Shipping a new /intel route is one PR. Deleting an existing one is a conversation, a migration, a deprecation banner, a question about who's reading it. So new surfaces shipped and old ones never died. The graveyard grew.

**Pattern 3: research masqueraded as product.** Persona overlays, venue archetype thesis, forensic channel-role classification, agency tracker — each of these was someone's thinking about what wedding venue intelligence COULD be. They shipped as features because shipping was the celebration. None of them passed the test "does Susan use this every day."

The fix is a single rule: **every new surface ships with a deprecation of an old one.** If you cannot find an existing surface to delete when you ship a new one, the new one is probably not needed.

---

## The path forward

I won't write a 90-day plan again. I'll write a 30-day plan.

**Days 1-10: pick one writer, kill the others.** The cascade RPC becomes the only thing that writes to spine + legacy. Every other writer (mintWedding, mirror-couple, the email pipeline's inline path, backtrace's apply, the orphan-sweep, the Calendly inline path) gets refactored to route through it. After day 10, there is exactly one place in the codebase where couples get written.

**Days 11-20: kill the legacy reads.** Every /intel surface reads the spine. The legacy /intel/sources page is deprecated; its data joins /intel/attribution into one canonical page. weddings.source is no longer read by any production code. After day 20, you can delete weddings, people, attribution_events, wedding_touchpoints — they remain as frozen tables only.

**Days 21-30: collapse the dashboard surface.** Build the one landing page above. Mark every /intel route except the landing + the journey ribbon as deprecated with a banner. After 30 days, when Susan opens Bloom, she sees one page. Everything else lives behind Sage's "ask me anything" or via direct URL for power-user deep-dives.

After 30 days you should have: one writer, one set of canonical data, one daily-list landing page, and 40 fewer routes. That is when Bloom starts feeling like a product.

You will not ship new features in those 30 days. You will delete code and consolidate. That is exactly what the codebase needs right now. The build energy is the wrong tool when the disease is sprawl.

---

## What's actually working and should not be touched

To be fair, not everything is broken.

The 8-stage cascade is a clean piece of code. The nickname dictionary + email-localpart extractor + the deterministic-first ordering is the right doctrine. Keep it.

The honesty rails (refuse, hedge, evidence-required) are a real product differentiator. The post-call inspector is overengineering, but the prompt-level rails should stay.

The journey ribbon is the right surface metaphor. The 400-line SVG component does what the doctrine said. Keep it.

The body metaphor (Agent / Portal / Intel / Sage as limbs around a spine) is the right framework. The execution missed but the framework is correct.

The constitution memory ("Bloom is forensic identity reconstruction") is the right thesis. Every piece of the swamp violated it; the thesis itself is sound.

---

## The hardest thing to do next

The hardest single decision in front of you is whether to declare a freeze and spend 30 days deleting. Every product instinct says ship a feature. Every code instinct says fix the bug in front of you. The correct move is to do neither for 30 days and consolidate the foundation under the cascade I shipped today.

If you cannot do that, the alternative is the wipe-and-start-over you mentioned. Starting over has a real argument: the codebase is 111,000 lines of context, 40+ surfaces, 365 migrations, 12 brain files, 5 identity resolution paths. A clean rebuild is maybe 15,000 lines and would reach feature parity with what Susan actually uses in eight weeks. That is a real option, not a melodramatic one.

The third option is the worst: keep shipping. Keep adding waves, surfaces, healing crons, parallel writers. That option ends with you opening Bloom every morning and not trusting any number you see, which is where you are today.

Pick consolidation or pick wipe. Do not pick keep-shipping. That's the honest engineering answer.