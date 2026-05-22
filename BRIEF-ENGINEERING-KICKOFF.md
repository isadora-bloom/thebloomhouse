# Bloom House — Engineering Kickoff Brief

**For:** a new top engineering team starting from a green field.  
**From:** the CEO, after building the wrong thing twice and learning what's actually true.  
**Time to read:** 8 minutes. Read it twice before you write any code.

---

## 1. What we are building, in one sentence

Bloom House is the system of record for **every signal a couple sends to a wedding venue**, unified into a single identity per couple, so the venue operator can finally answer the questions every existing CRM in this industry refuses to answer truthfully.

That's it. We are not building a CRM. We are not building a chatbot. We are not building a marketing tool. Every time someone in the room thinks of one of those, they will try to build one, and the result will be a worse version of HoneyBook or HubSpot. Do not do that.

---

## 2. The thesis (this is the only part you cannot get wrong)

Wedding venues lose money because their CRM treats every inquiry as a new record. The truth in the data is that one couple touches the venue many times across many channels before they book. They view the venue on The Knot, save it on Instagram, fill the website calculator, get forwarded by a friend, email the coordinator from one address, schedule a Calendly tour from another address, sign a HoneyBook contract under a third. Today each of those touches creates a new "lead" in the venue's CRM and the original story dissolves.

Bloom's only job is to undissolve that story.

We do this by reconstructing the **couple** as the unit of truth. Not the inquiry. Not the email thread. Not the booking. The couple is what we model. Every touchpoint is bound to the couple it belongs to, and only the couple. The couple has one identity, one journey, one heat score, one set of progression events, one outcome.

When that identity is reconstructed correctly, the operator can finally answer:

- Where did this couple actually come from (not where did HoneyBook stamp it)
- Why did they book us over the venue down the road
- Which of my marketing channels actually produces couples that close, not just couples that inquire
- Of the couples in my pipeline today, which ones are going cold and why
- Of the past six months of booked weddings, what did they have in common that I should be seeking out next

No CRM in the wedding industry answers any of those questions truthfully today. That is the entire commercial opportunity.

---

## 3. The user

The operator is **Susan**. She runs a wedding venue. She is not technical. She is in her email all day. She does not read documentation. She uses Bloom for fifteen minutes every morning over coffee and then again at the end of the day. She has been burned by every CRM she has ever paid for because they all promised to make her job easier and all made it harder.

Two rules about Susan:

**Susan must trust the numbers.** If Bloom tells her that 80% of her bookings come from The Knot, she will spend $10,000 next month on The Knot. If that number is wrong, she goes broke. Every number Bloom shows Susan must either be correct, or refuse to be a number at all. We would rather show "not enough data yet, here is the n" than show a confident wrong number. This is non-negotiable. We will lose users to softer competitors before we lose this principle.

**Susan needs Bloom to do the boring work.** She is not going to click through 137 duplicate candidates one at a time. She is not going to remember to run a cron once a week. The system should be self-healing wherever possible, surface the small number of cases that need her judgment, and never present a "here is a problem with your data" without also presenting "and here is what I am going to do about it." A backlog that grows is a backlog that gets ignored.

---

## 4. The hard product principles

These are the rules. If a decision looks unclear, the right answer is always the one that respects these.

**(a) The couple is the unit. The inquiry is not.**  
Every model, every table, every UI surface, every metric, every report, every export, every Sage prompt, every cron is keyed on a couple identifier. Inquiries are signals; signals are bound to couples; nothing in the system pretends an inquiry is a first-class thing. The day someone reaches for `weddings.id` or `inquiries.id` as a primary read, the abstraction has leaked and we have lost ground.

**(b) One source of truth. One spine. No parallel reads.**  
There is exactly one place each fact lives. The couple's lifecycle state. The couple's touchpoints. The couple's progression. The couple's heat. The couple's wedding date. If two surfaces show different numbers for the same couple, exactly one of them is wrong, and we fix it at the data layer not the display layer. Surfaces are dumb readers. They never re-derive facts. The legacy `weddings` table, the legacy `attribution_events` table, anything else that smells like a parallel claim about the same fact gets retired before the new system ships, not after.

**(c) Identity resolution is deterministic first.**  
Email matches email. Phone matches phone. Exact name plus exact last name. Nickname plus exact last name. Email localpart logical match. Then body cross-reference. Then paired-name with corroborator. Then family name with date. Fuzzy distance and machine learning are last-resort fallback, and they are gated by guards that catch the known failure shapes (substring traps, short-name typos, common-name collisions). Bloom merges two records as the same couple only when it has at least one deterministic anchor. When it does not, it leaves them separate and shows the operator both.

**(d) Honesty over confidence.**  
Every distribution carries its own n. Every rate uses a safe ratio that returns null on zero denominator. Every cell below the minimum sample size renders the raw count, not a percentage. When Bloom does not know an answer, Bloom says so out loud. When the data is missing for some couples, Bloom says how many and why. When a forecast is being made past the data window, Bloom hedges and names the confounds. When a sensitive question is asked, Bloom refuses by aggregating rather than naming. The product is an instrument for truth, not a confident-sounding assistant.

**(e) Self-healing first, dashboards second.**  
When the system detects a problem with its own data, the first move is to fix the data, not surface a dashboard about the problem. Drift between spine state and signals heals on a cron. Mirror-backfilled couples without touchpoints get their touchpoints backfilled automatically. Past-wedding-date booked couples flip to completed automatically. Operator dashboards exist only for cases the system genuinely cannot decide without human judgment. The day Bloom is mostly a dashboard about itself, it is no longer a product.

---

## 5. The data architecture

This is the spine. Every other table either feeds it or reads from it. There are no exceptions.

```
        EXTERNAL SIGNALS                 IDENTITY RESOLUTION              SPINE                   READ SURFACES
        ───────────────                  ─────────────────────            ─────                   ──────────────
        Gmail (inbound + outbound)
        Calendly (webhooks + API)
        HoneyBook (CSV + webhook)        ┌─────────────────────┐         ┌──────────────┐         /intel/cohort
        The Knot CSV / screenshot   →    │  the cascade        │   →     │ couples      │   →     /intel/attribution
        WeddingWire CSV                  │  8 stages,          │         │ touchpoints  │         /intel/heat
        Instagram screenshot             │  deterministic-first│         │ fragments    │         /intel/source-quality
        Pinterest screenshot             │  fallback to        │         │ candidate_   │         /intel/identity-review
        Website form                     │  fuzzy scoring      │         │   matches    │         /intel/couples/[id]/journey
        SMS                              │  with guards        │         │ couple_      │         couple portal
        Brain-dump CSV / paste           └─────────────────────┘         │   merge_     │         coordinator briefings
        Calculator submission                                            │   events     │         Sage operator NLQ
        Phone calls (transcribed)                                        │ couple_      │
        Reviews (operator-pasted)                                        │   progression│
                                                                         └──────────────┘
```

A signal arrives on any channel. The cascade runs against the existing couples in the venue. Eight stages, deterministic first. If a stage fires, the signal becomes a touchpoint bound to the matched couple. If no stage fires, the signal mints a new channel-scoped couple (un-acknowledged) or stays as an un-promoted fragment (insufficient identity to commit). The cascade is the only path. Nothing else writes to `couples` or `touchpoints` outside of it.

Three categories of writers and only three:

- **Adapters.** One per external source (Gmail, Calendly, HoneyBook, Knot CSV, IG screenshot, etc.). An adapter's only job is to normalize an inbound payload into the standard signal shape (channel, action_type, occurred_at, identity hint, raw_payload) and hand it to the cascade. An adapter does not know about couples. It does not write to the spine. It hands the cascade a normalized signal and stops.

- **The cascade.** Reads the existing spine, decides which couple the signal belongs to, writes the touchpoint, fires the progression event if the signal qualifies, updates last_progression_at, fires the heat update. One code path. Idempotent on rerun. Every decision logged in `couple_merge_events` with the rule that triggered it so it is auditable.

- **Healing crons.** Walk the spine on a schedule, detect drift between state and signals, repair. Lifecycle audit, post-wedding sweep, decay sweep, Tracer rebind, attendance sweep. These never invent data; they only correct state to match what signals say.

Readers are dumb. They read from the spine, derive presentation facts (status pill, heat band, journey ribbon, attribution credit), and render. A reader never writes. A reader never re-derives an identity decision. A reader never reaches around the spine to a legacy table for a "more accurate" answer because there is no legacy table.

---

## 6. Integration surface

These are the external systems Bloom talks to. None of them are sources of truth for Bloom; they are signal feeds and downstream effects.

**Read-from (signal feeds):**
- Gmail (OAuth per venue, polling + webhook)
- Calendly (webhook + API)
- HoneyBook (CSV upload + webhook)
- Instagram, Pinterest, TikTok, The Knot, WeddingWire (operator-uploaded screenshots / CSVs; no public API exists for engagement data on these surfaces)
- Twilio / OpenPhone (SMS + call transcription)
- Zoom (call transcription)
- A wearable / audio-capture provider (Omi or similar, for in-person notes the operator dictates)

**Write-to (downstream effects):**
- Gmail (drafted and sent replies)
- HoneyBook (contract initiation, optional, via API)
- The couple portal (custom domain per venue, hosted by us)
- Operator daily/weekly briefing emails (Resend)

The integration surface is the thinnest possible. Adapters normalize in. Effects fire out. Nothing in between is allowed to import or export raw external shapes.

---

## 7. The non-goals (every one of these has tempted a team before us)

We are **not** building a contract platform. There is a separate product (Contract House) that handles contracts. Bloom integrates with it like any other downstream effect.

We are **not** building a payment processor. Stripe handles payment, with the small slice we need (capacity-tier billing for the venue's Bloom subscription).

We are **not** building a marketing automation tool. Bloom tells the venue which channels work. The venue (or its agency) decides where to spend. We do not buy ads. We do not schedule social posts. We do not generate marketing copy.

We are **not** building a website builder. The venue has its own website. Bloom embeds a calculator widget on it. That is the entire surface area.

We are **not** building a chatbot. Sage is the AI personality that drafts the operator's replies and runs the couple portal concierge. Sage is grounded in the spine. Sage is not a general chat product. Susan does not "talk to Sage." Susan reviews what Sage has drafted on her behalf, and edits it.

We are **not** building a generic CRM. There is no notion of "lead" that is not a touchpoint, "deal" that is not a couple, "stage" that is not a lifecycle state. If the data model starts to feel like Salesforce, the abstraction has leaked.

---

## 8. What "done" looks like

We will know we shipped the right thing when Susan can sit down for fifteen minutes and answer all of the following truthfully:

- Of the 47 bookings I closed in the last 12 months, where did each one come from. Show me the journey of any one of them.
- Of the couples currently in my pipeline, which 3 are most likely to book this month, why, and what do you suggest I send each of them.
- Of the inquiries I declined to reply to in the last 30 days, which ones did I probably mis-triage.
- Did Instagram drive my June bookings or was it Knot, controlling for the fact that I changed my Instagram strategy in April.
- Is bad weather hurting my tour conversion. By how much.
- How many couples are dealing with sensitive themes I should be careful about in my drafts. (She gets a count, never a list.)
- What is the next single action I should take right now, and on which couple.

The day Susan answers all seven of those without leaving Bloom and without doubting any number she sees, we have shipped the product. The day someone in a planning meeting argues that we should add a feature that doesn't help Susan answer one of those questions better, we have lost focus.

---

## 9. The first 90 days

Do not start with a feature. Start with the spine.

**Days 1-30.** Build the spine and the cascade. Nothing else. No surfaces. No Sage. No integrations except Gmail one-way read. The deliverable at day 30 is: pour 12 months of one real venue's Gmail history through the system and produce a clean couples table with correct identity resolution. Operator validates: are these the right couples, in the right state, with the right touchpoints? If yes, the spine works.

**Days 31-60.** Add the second and third adapters (Calendly, HoneyBook). Add the journey ribbon and the couples list. Add lifecycle audit + the healing crons. The deliverable at day 60 is: the operator can open Bloom and recognize her own pipeline, and the numbers match her gut.

**Days 61-90.** Add Sage (operator-facing first, couple-facing second). Add the attribution surface. Add heat. The deliverable at day 90 is: the operator wants to use Bloom every day because it tells her things she does not already know, in language she trusts.

If you find yourself building dashboards before the spine works, stop. If you find yourself adding a feature because a customer asked, but you cannot map that feature back to one of Susan's seven questions, stop. If you find yourself reaching for a parallel data path because the spine is missing something, fix the spine.

---

That's the brief. If the new team reads this and thinks Bloom is "just a CRM with better identity matching," they have missed the point and will build the wrong thing. If they read it and realize the entire product is the identity reconstruction, and every surface is downstream of that one capability, they will build the right thing.

---

# Bloom House — Engineering Kickoff Brief (Part II)

**Addendum to the original.** The first brief described the spine. It said nothing about how a body actually works. The brief was correct as far as it went, and incomplete in a way that matters: a spine without limbs is just a memory of what happened. The product is the living system that learns and acts. Picking up where Part I stopped.

---

## 10. The body has four limbs. They share one spine.

The product has exactly four user-visible parts. Every line of code belongs to one of them. If it does not, we have a fifth thing and we have lost focus.

**The Agent.** The arm that handles inbound communication with prospective couples. Email pipeline, draft generation, auto-send, follow-up scheduling, the inbox triage view, the human-escalation routing. The Agent is the part of the body that reaches out and touches the world. It is also the densest sensor: most signals enter Bloom through the Agent.

**The Portal.** The arm that handles ongoing communication with booked couples. Custom subdomain per venue. Couples log in, see their contract status, their timeline, their checklist, their vendor list, their tour notes, the answers to questions they have asked. They talk to Sage. They upload files. They invite their family. The Portal is the other reaching arm, and it is the second-densest sensor in the system, because booked couples generate signals continuously between booking and wedding date (eight to eighteen months of behavior we currently throw away).

**The Intel.** The eyes. Cohort, attribution, heat, source quality, journey ribbon, identity report, suspect merges, weekly briefings. The operator does not perform actions through Intel; she sees. Every surface here reads the spine and renders it back as patterns Susan could not have seen by scrolling her inbox. The Intel is also a sensor in one subtle way: when Susan opens a surface, dwells on a row, marks a row as "noted," that engagement IS a signal about what matters to her, which Sage uses to know what to push to her tomorrow morning.

**Sage.** The brain. Sage is not a surface. Sage is the AI personality that powers all three limbs. Sage drafts in the Agent. Sage talks to couples in the Portal. Sage narrates patterns in the Intel. Sage answers natural-language operator questions. Sage learns the venue's voice from the operator's edits and approvals. Sage does not exist in any one place; Sage is the brain stem that connects everything.

The four parts share one bloodstream: the spine. Every touchpoint a couple generates, regardless of which limb captured it, lands in the same `touchpoints` table bound to the same `couple`. Every surface, regardless of which limb is rendering it, reads from that single source. There is no Agent-only data, no Portal-only data, no Intel-only data, no Sage-only data. Everything is on the spine.

---

## 11. Tours are a first-class entity. The previous brief failed to name them.

A tour is not just a touchpoint. It is the most expensive thing the venue does and the single highest-conversion event in the funnel. It deserves its own structure on the spine.

For every tour we record:

- **Who conducted it.** Coordinator A and coordinator B do not have the same close rate, do not have the same tour style, do not have the same review-language profile from couples they toured. The intel layer cannot answer "who is my best tour-giver" without this. Most CRMs do not capture it. We must.
- **When.** Scheduled time + actual time. The two often differ.
- **Outcome.** Attended / no-show / cancelled. (Calendly cannot tell us this directly; the coordinator marks it.)
- **Pre-tour state.** What did Bloom know about this couple before they walked in. What did Sage suggest. What was their heat score, their channel, their journey-to-date.
- **Operator post-tour brief.** Five-minute capture, voice or text, after the tour. "I felt they were going to book. They responded strongly to the willow tree. The mother was the decision-maker, not the bride. They mentioned three other venues by name." This is gold for prediction and for Sage's future drafts to that couple.
- **Couple post-tour signal.** A short structured survey, sent through the Agent, asking what stood out. Open-ended plus three scaled questions. Optional but powerful.
- **Outcome attribution.** When this couple eventually books or ghosts, the tour gets credit (or not) based on the multi-touch attribution model. Tours where the couple booked are the venue's playbook; tours where the couple ghosted despite high heat are the venue's learning corpus.

The spine carries a `tours` table joined to `couples`. Every tour has a record. Every record has a coordinator, an outcome, a pre-tour snapshot, a post-tour brief, and a downstream-outcome reference. Without this, the entire prediction loop is hobbled.

---

## 12. Reviews are a first-class entity. The previous brief failed to name them too.

Reviews are not just sentiment data for a chart. They are the highest-value language signal the venue has, and they enter the system from the couple's perspective after the wedding has happened. The right way to model them:

- **Reviews bind to couples.** When a review arrives, it gets matched to a couple (sometimes via the name on the review, sometimes via the date of the wedding). If we cannot match, it stays as a fragment until we can.
- **Review text feeds voice DNA.** The way real couples describe the venue in unsolicited language is the most authentic voice signal Bloom has. Sage's drafts should be tuned to match the language couples actually use, not the language the coordinator THINKS they use.
- **Review themes feed positioning.** "Sixteen of the last forty couples mentioned the willow tree unprompted" is a marketing position. The Intel layer surfaces these as themes per venue.
- **Review sentiment per coordinator.** When a review is matched to a couple, and the couple's tour is in the spine, and the tour has a coordinator, the review sentiment closes the loop. Some coordinators consistently produce reviews that mention warmth; others consistently produce reviews that mention efficiency. Both are valid; Susan should be able to see the pattern.
- **Solicitation gap.** Bloom should know which booked couples did not leave a review, when their wedding was, and which platform they have the highest probability of reviewing on. The Agent prompts them at the right moment in the right channel.
- **Review responses.** When the operator responds to a review, the response is a draft Sage prepares, the operator edits, and the edit becomes another voice-learning signal.

Reviews are not a sidebar feature. They are the closing of the longest feedback loop in the system. The couple's wedding happened. They had an experience. They wrote about it. That language now teaches the system how to talk to the next couple. Without reviews wired through, the loop breaks open at the most important moment.

---

## 13. The closed loops are the product

This is the part I missed entirely the first time. The product is not a database with rendering on top. The product is a set of closed feedback loops where each part of the body teaches the other parts.

Five core loops. Every one of them should compound.

**Loop 1: Voice.** Coordinator receives an Agent-drafted reply. Edits it. Sends it. The edit (the diff between draft and sent) trains Sage's voice model for this venue. Next draft is closer to what she would have written. Over months, Sage drafts what she would have written, and she approves with minimal editing. Time spent on inbox drops by half. The voice loop runs continuously, silently, every email.

**Loop 2: Prediction.** Couple inquires. Sage assigns a heat score. Couple progresses. Couple tours. Coordinator gives post-tour brief. Couple eventually books or ghosts. The pre-tour heat + post-tour brief + outcome trains the close-probability model. Six months in, Sage can tell Susan with calibrated confidence which of her in-pipeline couples will book this month. The prediction loop runs on every tour and every outcome.

**Loop 3: Attribution.** Couple arrives via a channel. Touchpoints accumulate across other channels. Couple books. Backtrace recovers the real first-touch from email history. Attribution credit lands on the right channel under all four models. Marketing spend gets compared to revenue per channel. The venue reallocates spend. The next quarter's couples arrive via the better-performing channels. Attribution gets cleaner. CAC drops. The attribution loop runs on every booking.

**Loop 4: Positioning.** Couples write reviews. Reviews reveal what couples actually loved. Themes per venue emerge. Sage uses themes in drafts to new couples (where appropriate and honest). New couples who resonate with those themes are more likely to inquire and book. Reviews of the next cohort reflect the same themes. The positioning loop runs on every review and every draft.

**Loop 5: Capacity.** Operator marks how busy she is. Sage learns when she is at capacity. Auto-send fires at the right pace. Follow-ups schedule for when she will be free. Tour scheduling respects her actual availability, not the Calendly defaults. The capacity loop runs continuously and silently.

These five loops are the entire product. Build them and Bloom becomes irreplaceable. Skip any of them and Bloom is a CRM with better identity matching, which is not interesting.

Each loop is a closed cycle: spine writes data, limb reads data, limb produces an action, action creates new data, new data lands on spine. The system gets smarter by running. A new venue onboards with a cold Sage; a venue at month six has a Sage tuned to its voice, calibrated to its conversion patterns, and pointed at its highest-yield channels. That compounding is what we are selling. Not the dashboards.

---

## 14. The nervous system: how the limbs talk to each other

The four limbs do not talk directly. They all talk through the spine. This is not pedantic; it is architectural law. Every cross-limb communication is a spine write followed by a spine read.

A few canonical paths to make this concrete:

- Couple sends email → **Agent** writes touchpoint to spine → **Sage** reads spine to draft reply → Coordinator approves → Agent sends → spine records outbound + the diff between draft and sent → Sage updates voice model.

- Couple tours → coordinator gives post-tour brief in the **Agent** inbox view → spine records the tour with brief → **Intel** updates the couple's prediction → **Sage** uses the brief in the next draft to this couple → **Portal** surfaces the timeline progression to the couple.

- Couple books → **Agent** routes to **Portal** → spine records the booking touchpoint → **Intel** attribution credits the channel → **Sage** drafts the welcome-to-the-portal message → Couple logs in → Portal records the login as a touchpoint → spine continues to accumulate.

- Wedding happens → review arrives via any channel → spine binds review to couple → **Intel** updates voice DNA + themes → **Sage** uses new language in future drafts → solicitation gap closes for couples who have not reviewed → next review arrives.

The nervous system rule is simple: nothing goes around the spine. If the Portal needs something from the Agent, it reads it from the spine. If Sage needs something the Intel computed, it reads it from the spine. Direct limb-to-limb dependencies are forbidden. This is what makes the system rebuildable, observable, and reasonably testable.

---

## 15. What "done" looks like, updated

The original brief had seven questions Susan should be able to answer. Two more belong on the list, because they test the loops:

- Among my coordinators, who closes tours at the highest rate, what is their tour style according to past couples' reviews, and is there a way to teach the others.
- Which of my booked couples in their portal right now are at risk of disengaging, and what is the next action to take with each.

When Susan can answer those two, she is feeling the loops working. Until she can, the limbs are connected to the spine but the system is not yet thinking.

---

## 16. The 90 days, revised

**Days 1-30. Spine + cascade + tours.** Same as the original 30, but with tours as a first-class table from day one. Pour 12 months of Gmail + Calendly + the operator's historical tour log through. Deliverable: couples table is correct, AND every tour has a who/when/outcome.

**Days 31-60. Two limbs and the first loop.** Stand up the Agent (drafting + send) and Sage (the brain). Wire Loop 1 (voice) end to end. Deliverable: the coordinator's inbox runs through Bloom; her edits are training Sage; the second week's drafts are visibly closer to her voice.

**Days 61-90. Portal + reviews + the rest of the loops.** Stand up the Portal for booked couples. Ingest reviews. Wire Loops 2-5. Deliverable: a booked couple has logged in to her portal at least once, a review has been bound to a couple and used by Sage in a future draft, the operator's first attribution decision has been backtraced and applied, the close-probability model has predicted a tour outcome that the coordinator confirmed.

Build a limb. Wire the loop. Confirm the loop is closing. Move to the next limb. Do not build all four limbs in parallel; nothing learns and you cannot tell what is broken.

---

That is the body. The spine alone is a memory system; the limbs alone are a chat product. Bloom is the closed-loop organism that compounds every signal back into smarter actions. If the new team understands that the loops are the product and the surfaces are just where the loops surface, they will build the right thing.