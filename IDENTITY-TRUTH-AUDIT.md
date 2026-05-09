# Identity Truth Audit — does Bloom House live the two tenants?

Anchor: `bloom-constitution.md` (forensic identity reconstruction). Snapshot 2026-05-09. Read-only audit; no code or migrations changed. Migration 255 (`255_identity_evidence_phase1.sql`) sits **uncommitted on disk** and is referenced as a future-state lever, not a current capability.

---

## 1. TL;DR

**Tenant 1 (identity is more than facts) is half-realized.** The plumbing exists end-to-end for emails: `enrichProfileFromTouchpoints` (`src/lib/services/identity/profile-enrichment.ts:454`) extracts a structured stream (phone/employer/hometown/dietary/family_context) and a soft-signal stream (life_context/family/health/grief/preferences) on every inbound email and tour transcript. Those notes are read by `sage.ts` (couple chat), `client.ts` (booked drafts), and the follow-up branch of `inquiry.ts`. **Two failure points break the tenant in practice:** (a) the FIRST-touch inquiry draft (the one that earns the lead) does NOT load `wedding_auto_context` — `inquiry.ts:398` `generateInquiryDraft` skips the read; only `generateFollowUp` at `inquiry.ts:893` loads it. By the time soft-context starts feeding Sage, two or three replies have already gone out cold. (b) Coordinator-side intel never sees soft-context: weekly briefings, daily digests, anomaly detection, source-quality scorecard, correlation engine, journey narrative, post-tour brief, review response — none load `wedding_auto_context`. So Sage knows the bride is grieving, but the venue's business-decision layer treats every couple as a flat row.

**Tenant 2 (handles as first-class evidence) is barely realized.** Platform detectors capture handles into `tangential_signals.extracted_identity.username` (`platform-detectors/instagram.ts:85`, `pinterest.ts:69`, etc.) and the candidate-resolver does cross-reference via `people.external_ids[platform]` (`candidate-resolver.ts:198-217`). But: (i) clustering is **per-platform** (`candidate-clusterer.ts:563` keys on `(venue, platform, fingerprint)`), so the same handle on Pinterest + Knot + IG cannot merge into one candidate identity until the candidate-resolver lands all three on the same wedding via separate paths. (ii) **No coordinator UI surfaces the handle collection** — search confirms `external_ids` is only ever read by identity services, never rendered in any component. (iii) Handle-shape values like `Erinhorrigan`, `User 89436314x...` land in `people.first_name` because no shape-detector sits in front of `findOrCreateContact` (see `IDENTITY-CAPTURE-DESIGN.md` §3a). (iv) `handle → name inference` (`rosaliehoyle` → "Rosalie Hoyle" at confidence ~25) **is not implemented anywhere**. Migration 255 introduces `people.platform_handles` + `display_handle` to fix all four, but is uncommitted and zero code reads/writes it.

**Highest-leverage gap:** wire `enrichProfileFromTouchpoints` into the new-inquiry draft path (one import + one read in `inquiry.ts:398-770`) and hook `wedding_auto_context` into `briefings.ts` + `weekly-digest.ts` so the venue's decisions get the same emotional truths Sage gets. That alone closes the biggest delta between tenant promise and tenant reality without shipping mig 255.

---

## 2. Tenant 1 audit table — emotional truths captured + used

`Captures` = does the ingest site write to `wedding_auto_context` / structured profile fields. `Sage uses` = does the brain prompt for that phase load auto-context. `Coord UI` = does a coordinator surface render the notes. `Intel narrators` = do briefings/digests/scorecard read them.

| Phase | Input source | Captures emotional truths? | Sage uses them in output? | Coord UI shows? | Intel narrators? | Gaps |
|---|---|---|---|---|---|---|
| 1. First touch (Knot/Zola/direct/Calendly/WW/brain-dump) | `pipeline.ts:2036-2048` fires `enrichProfileFromTouchpoints` AFTER the inquiry interaction lands; brain-dump confirm route at `api/brain-dump/[id]/resolve/route.ts:279-283` also fires it | **Partially.** Email pipeline runs LLM extractor on every inbound email (`profile-enrichment.ts:411-438` system prompt explicitly enumerates "stressful job mentions, mood, vendor preferences, cultural traditions, health, family illness"). Form-relay first-touches (Knot/WW/Zola) usually contain ZERO body content (relay strips couple's note), so first signal is empty. | **No.** `inquiry.ts:398 generateInquiryDraft` does NOT load `wedding_auto_context` — only the follow-up branch (`inquiry.ts:893-916`) does. First-touch reply is cold. | **Partial.** AutoContextPanel renders only at `intel/clients/[id]` (booked client). NO surface on agent inbox, lead row, or `agent/leads/page.tsx`. | **No.** No briefing / digest / scorecard service queries `wedding_auto_context` (grep across `src/lib/services/intel` returns zero matches). | (a) inquiry-brain new-inquiry path skips notes. (b) form relays carry no body so notes empty until reply 2. (c) no agent-side UI. |
| 2. Inquiry phase / replies (inquiry-brain, re-engagement-drafter) | Reply emails arrive with body content; `pipeline.ts:2036-2048` fires enrichment | **Yes** — full body to LLM extractor. | **Mixed.** `generateInquiryDraft` (the next reply Sage drafts) still skips `wedding_auto_context`. Only `generateFollowUp` loads it. So a couple replying with grief context gets a cold AI reply unless 3+ days lapse and the follow-up path fires. `re-engagement-drafter.ts` (Phase D nurture) deliberately writes from candidate-only signals (`source_platform`, `first_name`, `last_initial`, `state`) — it explicitly does NOT load notes (`re-engagement-drafter.ts:64-83`) because the candidate isn't yet a wedding. | No agent UI. | No. | Same as phase 1 plus: Phase D re-engagement messages cannot reflect emotional truths even when they exist for the underlying candidate. |
| 3. Tour scheduled | Calendly answers / scheduling-tool extras land in `pipeline.ts:2398-2449` | Mostly fields (date, names, partner). No soft-signal extraction at scheduling time — those columns are structured. | n/a (no draft fires off scheduling alone) | Some fields visible in lead detail (date, partner). | No. | No emotional capture from "I'm scheduling around chemo" answers in Calendly long-form questions. |
| 4. Tour completed | Tour transcript → `tour/transcript-extract.ts:257-271` calls `enrichProfileFromTouchpoints(weddingId, { trigger: 'tour_transcript' })` AFTER the structured extraction (key_questions, emotional_signals, specific_interests). | **Yes** — emotional_signals are explicitly extracted (`post-tour-brief.ts:139, 164`) and persisted; tour transcript triggers full LLM enrichment that adds soft-signal notes. | **Coordinator brief** at `post-tour-brief.ts:152-169` references emotional_signals. **Couple follow-up draft** (post-tour) does NOT load `wedding_auto_context` (`post-tour-brief.ts:171-191`). It anchors on review-language phrases instead. | Brief is rendered on tours page + lead detail (`post-tour-brief.ts:413-427` persists to `tours.tour_brief_text`). AutoContext only on `intel/clients/[id]`. | No narrator. | post-tour follow-up draft pulls review_language but ignores the soft-context the same transcript just produced. |
| 5. Proposal sent (contract draft, pricing) | Outbound email — pipeline fires enrichment but extractor sees venue's own message + KB content. | Low value — outbound bodies are AI-authored, so re-extracting from them is noise. | n/a | No. | No. | Profile-enrichment cost-burn on outbound emails (no direction guard at `pipeline.ts:2036`); harmless for content but wastes API tokens. |
| 6. Booked (onboarding email, KB sharing, couple Sage chat) | `client.ts` and `sage.ts` are the two relevant brains | n/a here (capture happens upstream) | **Yes.** `client.ts:268-299` AND `sage.ts:288-330` both load `wedding_auto_context` (pinned-first, last 10) AND `sage_context_notes` (last 14d). Brain prompts include "do NOT quote verbatim" instruction. | `intel/clients/[id]` shows full feed via `AutoContextPanel`. | No narrator. | Strongest realization of tenant 1. The verbatim guard is per-prompt inline, not in `UNIVERSAL_RULES` / `COUPLE_RULES`, so a future brain that forgets to add it leaks the bride's grandmother's death into a draft. |
| 7. Pre-wedding (vendor referrals, day-of memories, brain-dump confirms, calendar/payment reminders) | Coordinator brain-dump → `brain-dump/[id]/resolve/route.ts:279` fires enrichment; coordinator-typed note → `api/intel/auto-context/[weddingId]:130-178` POST | **Yes** — coordinator brain-dump notes route through profile-enrichment. POST endpoint accepts coordinator-typed notes (source='coordinator_added'). | client.ts + sage.ts use them; vendor-referral / payment-reminder paths do not load `wedding_auto_context`. | AutoContextPanel only on `intel/clients/[id]`. No surface for vendor-referral coordinator UI. | No. | Coordinator types "the bride is anxious about the menu" → it lands but only Sage-chat / client-reply read it. The vendor-referral email Sage drafts ignores it. |
| 8. Wedding day (engagement events, real-time) | Day-of comms run through `client.ts` | (capture upstream) | **Yes** — client.ts loads notes, including a 7-day proximity flag (`client.ts:307-312`). | AutoContext renders; pinned notes float. | No. | None at the brain level. |
| 9. Post-wedding (review request, review response drafting) | `review-response.ts` | n/a here | **No.** `review-response.ts:112-187` does NOT load `wedding_auto_context`. The reply uses approved review language + voice prefs only. | No. | No. | A couple with a sensitive grief context who left a review gets a public reply with no awareness — could land tone-deaf. |
| 10. Marketing intel rollup (heat narrations, briefings, weekly digest, source ROI, anomaly detection, cohort cards, journey narrative) | Read-side surfaces | n/a | **No.** Grep across `src/lib/services/intel` and `src/lib/services/insights` for `wedding_auto_context` returns ZERO matches. `briefings.ts`, `daily-digest.ts`, `weekly-digest.ts`, `source-quality.ts`, `anomaly-detection.ts`, `correlation-engine.ts`, `intelligence-engine.ts`, `intelligence-engine-narration.ts`, `journey-narrative.ts`, `heat-narration.ts` — none consume soft-context. | Coordinator UI gap continues. | **Hard NO.** Every row treated as flat. Source-quality scorecard cannot say "Knot couples skew toward emotional planning context that we under-serve." | Biggest tenant-1 hole. The intelligence loop is the venue's USP per `CLAUDE.md`; soft-context truths never reach it. |

---

## 3. Tenant 2 audit table — handles as first-class evidence

| Phase | Handles captured? | Handle → name inference? | Cross-platform match? | Surfaced in coord UI? | Gaps |
|---|---|---|---|---|---|
| 1. First touch | **Per platform yes:** Pinterest pinner → `tangential_signals.extracted_identity.username` (`pinterest.ts:69-90`); Instagram username (`instagram.ts:85-127`); Knot leaves username null but parses `first_name`/`last_initial` (`the-knot.ts:144-178`); WeddingWire same. **Email pipeline NO:** `Erinhorrigan` from a Knot relay `From:` lands in `people.first_name`, not in any handle field (`pipeline.ts:620-633` per IDENTITY-CAPTURE-DESIGN.md §3a). | **No.** No code anywhere splits a smushed handle into "First Last" with low confidence. The closest analogue is the form-relay parsers' `looksLikePersonName` rejector (CSV side only). | **No.** Clustering keys on `(venue, platform, first_name|last_initial)` (`candidate-clusterer.ts:563` — `${s.venue_id}|${s.source_platform}`). Same handle on Pinterest + IG = two candidate rows. | **No.** Search across `src/components` for `external_ids` / `platform_handles` / `username` / `display_handle` returns zero render sites. The handle exists in `tangential_signals.extracted_identity.username` and is read by the candidate-resolver at `candidate-resolver.ts:198-217`, but the lead-profile UI shows nothing. | All four pieces of tenant 2 are partially missing. |
| 2. Inquiry phase | Email body scanner extracts emails / phones / names / dates / guest-count via regex (`body-extract.ts:24-52`) but does NOT extract platform usernames / handles. | No. | No. | No. | The same body that says "I'm @rosaliehoyle on Insta" gets the email + phone but throws away the handle. |
| 3. Tour scheduled | Calendly may carry a handle in long-form answers; not extracted. | No. | No. | No. | n/a |
| 4. Tour completed | Tour-transcript LLM (`tour/transcript-extract.ts`) extracts emotional_signals, key_questions; does not extract platform handles. | No. | No. | No. | n/a |
| 5. Proposal | n/a | n/a | n/a | n/a | n/a |
| 6. Booked | n/a | n/a | n/a | n/a | n/a |
| 7. Pre-wedding | n/a — coordinator brain-dump LLM may surface a handle in `wedding_auto_context.body` as free text but it does not promote to `external_ids`. | No. | No. | No. | A coordinator brain-dump saying "the bride keeps DMing us at @rosaliehoyle" produces a `wedding_auto_context` note but no machine-readable handle. |
| 8. Wedding day | n/a | n/a | n/a | n/a | n/a |
| 9. Post-wedding | Review platform handles captured in `review_language` rows / review records but not promoted to person handle. | No. | No. | No. | n/a |
| 10. Marketing intel | Briefings consume `candidate_identities` (`briefings.ts:164, 198`) which carries one `username` per candidate, per platform. Cross-platform handle convergence is invisible: same person on three platforms = three candidate rows, three candidate cards, no merge. | No. | No. | No. | The "three independent handle signals converging on the same identity = forensic" promise is the most-undelivered promise in the entire codebase. |

---

## 4. Forensic-reconstruction continuity check — Rosalie Hoyle's hypothetical journey

**T-90: Pinterest scrape.** Coordinator imports a Pinterest CSV. Detector (`pinterest.ts:54-92`) extracts `username='rosaliehoyle'`, `name_raw='Rosalie Hoyle'` is null because Pinterest CSVs only show pinners. Lands in `tangential_signals.extracted_identity.username='rosaliehoyle'`. Cluster fingerprint (`candidate-clusterer.ts:153-158`) keys on `(venue|pinterest|first_name|last_initial|state)` — `first_name` and `last_initial` are both null, so `clusterer.ts:559` skips this row as anonymous. **No candidate is created.** The signal exists in the database, attached to no one.

**T-60: Knot view.** Knot CSV lands `first_name='Rosalie'`, `last_initial='H'` (`the-knot.ts:144-178`). Clusterer creates a candidate `(venue|the_knot|rosalie|h)`. The Pinterest row is still orphaned because clustering is per-platform — `(venue|pinterest|...)` and `(venue|the_knot|rosalie|h)` are different keys.

**T-30: Knot inquiry email.** Pipeline (`pipeline.ts:620-633`) extracts `from_name='Rosalie H.'` from a Knot relay `From:`, mints `people.first_name='Rosalie'`, `last_name='H.'` (or `H` after the dot strip). `findOrCreateContact` runs; no `external_ids['the_knot']` write site exists in the inquiry path (search confirms zero writers). The Knot candidate has `username=null` (Knot CSVs don't carry it). Cross-platform link not formed.

**T-25: Calculator submission.** Body extractor (`body-extract.ts:127-193`) extracts `emails=['rosalie.hoyle@gmail.com']`, names=['Rosalie Hoyle']. `extracted_identity` lands on the interaction. `name-upgrade.ts` later promotes `last_name='H'` → `last_name='Hoyle'` (strict-prefix rule, single-letter under 2-char threshold). **Tenant 1 here works:** `enrichProfileFromTouchpoints` runs, surfaces calculator soft signals if any are in body. Tenant 2: still no Pinterest match.

**T-20: Tour booked.** Calendly extras may carry "I follow you on Instagram @rosie.hoyle" in a long-form answer. Not extracted today (no IG-handle regex on Calendly answers).

**T-15: Tour completed.** Transcript LLM (`tour/transcript-extract.ts`) extracts emotional signals: "anxious about flowers because grandmother passed last month." Lands as `wedding_auto_context` note with `category='grief'` (the LLM picks one of `life_context|family|vendors|budget|health|dietary|timeline|cultural|preferences|logistics|misc` — `grief` is NOT in that allowlist `profile-enrichment.ts:287-299`, so it normalizes to `misc`). Tour brief surfaces emotional signal. **Tenant 1 here works (almost) — but the category enum is too narrow.**

**T-10: Booking.** Onboarding email via `client.ts:574+`. Wedding-context loader at `client.ts:226-336` includes auto-context. Sage's onboarding email can soften tone for grief. **Tenant 1 reads cleanly.**

**T+30: Review.** Couple leaves a review on The Knot. `review-response.ts:112-187` drafts reply from `review_language` + `voice_preferences` only. The grandmother grief note exists, but the public review reply is unaware. **Tenant 1 breaks at the very last step of the journey.**

**Where the trail is broken:**
- Pinterest signal at T-90 is forever orphaned (anonymous fingerprint).
- The Knot candidate at T-60 never auto-merges with the Pinterest signal (per-platform clustering, no shared handle field).
- The inquiry-brain reply at T-30 cannot reference the soft context because `inquiry.ts:398-770` doesn't load auto-context.
- The review-response brain at T+30 cannot reference grief context.
- Coordinator UI never displays "rosaliehoyle on Pinterest, rosalie_hoyle_92 on Knot, rosalie.hoyle@gmail.com" as a handle collection. Coordinator sees three rows.

**What Sage cites correctly:** booked-client and couple-portal chat. Everything else is partial.

---

## 5. Marketing intel integration check — does the business-decisions layer see the truth?

| Surface | Reads `wedding_auto_context`? | Reads `external_ids` / `platform_handles`? | Reads `candidate_identities` cross-platform? |
|---|---|---|---|
| `briefings.ts` (weekly + monthly) | No | No (counts candidates by platform but never cross-references handles) | Yes — `briefings.ts:164, 198` query candidate_identities for new_candidates / platforms_active rollups |
| `daily-digest.ts` | No | No | Reads inquiries / tours / lost — flat |
| `weekly-digest.ts` | No | No | Reads weddings + interactions — flat |
| `source-quality.ts` (Phase C scorecard) | No | No | Yes — uses attribution_events (which inherit from candidates) but never says "this candidate also showed up under a different handle" |
| `anomaly-detection.ts` | No | No | No |
| `correlation-engine.ts` | No (reads `extracted_identity.utm_*` for UTMs only — `correlation-engine.ts:357-362`) | No | No |
| `intelligence-engine.ts` (14 detectors, narrator_facts) | No — search across the file confirms zero `wedding_auto_context` reads | No | Reads weddings, attribution_events, source-mix counterfactuals; flat per-row |
| `journey-narrative.ts` | No | No | Yes — composes the per-couple journey from candidates, but each candidate is opaque. Same person across platforms still reads as separate rows in the narration |
| `heat-narration.ts` | No | No | Heat is volume-of-touchpoints; doesn't peek at the soft-context that says "this couple is grieving and won't be ready to book this week" |
| `cohort-match.ts`, `pricing-elasticity.ts`, `weather-cancellation.ts` | No | No | No |

**The tenants meet the venue's business decisions in two places only:** (a) candidate-attribution rollups (Phase B/C numerics) and (b) the journey-narrative paragraph that gets fed back into Sage's draft prompt. **Neither carries emotional truths.** The source-quality scorecard cannot say "Knot couples come in with more financial-stress markers but convert at higher LTV"; it cannot say that because it never reads the markers.

This is the largest gap between Bloom Constitution ("every feature is a view over a single forensic record") and current behavior. The forensic record HAS soft signals on it; the views don't read them.

---

## 6. Constitution alignment

The Constitution names Bloom as a **forensic identity-reconstruction system** with Point Zero dividing pre-zero attribution from post-zero tracking, and every feature collapsing into "a view over the record."

**Where the code lives up to the thesis:**
- The point-zero schema is real: `candidate_identities` (pre-zero) + `attribution_events` (resolution) + `weddings` (post-zero) is implemented and consistently treated.
- The continuous profile-enrichment service (`profile-enrichment.ts`) is the soft-signal half of the forensic record. It runs on every email, every brain-dump confirm, every tour transcript. Coordinator-override invariants are respected (`field_source['xyz']==='coordinator_typed'` blocks AI overwrite — `profile-enrichment.ts:603-655`).
- Identity merge is one chokepoint (`resolver.ts`) with one match chain (email exact → email canonical → phone → name+date → create). No scattered findOrCreate sites.
- Universal body-extraction runs on every inbound email (`body-extract.ts`).

**Where the code falls short:**

1. **First-touch reply is cold.** `inquiry.ts:398 generateInquiryDraft` does not consume the forensic record's soft layer. The Constitution says every feature is a view; the most-customer-facing feature isn't. Sister `generateFollowUp` does it; the inconsistency reads like an oversight, not a design.

2. **Intel narrators ignore soft-context.** Per the Constitution, "Heat scoring = movement velocity + recency over post-zero record." But heat-narration cannot say "this couple is grieving — heat 78 looks high but they're stalled by emotional bandwidth, not by us." That insight is sitting in `wedding_auto_context.category='grief'` and no narrator reads it. Same for source-quality, correlation, journey narrative, anomaly detection.

3. **Handles are not first-class.** The Constitution explicitly calls out: "the same human appears as `madison.bryant@gmail.com` AND `Madison B.` on Knot AND `@madisonb` on IG…All five are one lead." The code captures handles per-platform but neither (a) merges across platforms via shared handle nor (b) renders the handle collection on the lead profile. `IDENTITY-CAPTURE-DESIGN.md` explicitly identifies the gap; mig 255 is the proposed schema fix; nothing reads/writes the new columns yet.

4. **Sensitive-truth prompt rule is per-brain inline, not universal.** A coordinator-facing brain that forgets the inline "do NOT quote verbatim" instruction will leak. `UNIVERSAL_RULES` / `COUPLE_RULES` / `CLIENT_RULES` (`src/config/prompts/`) do not contain a sensitive-content rule. Mig 255 introduces `wedding_auto_context.sensitive` boolean which is the structural fix, but no prompt currently checks it.

5. **Wedding-relationships table missing.** Family / planner / mom mentions land as `partner2` (per IDENTITY-CAPTURE-DESIGN.md §3e). Mig 255 introduces `wedding_relationships`; no code reads/writes it yet. So when a coordinator brain-dump says "Carolynn is the bride's mom," she becomes Brett's partner.

---

## 7. Top 5 gap-fixes ranked by user-visible impact

### #1 — Wire `wedding_auto_context` into `inquiry.ts:generateInquiryDraft`

**File / line:** `src/lib/services/brain/inquiry.ts:398-770`. Mirror the pattern at `inquiry.ts:893-916` (the follow-up branch already does this).

**Change:** add a wedding lookup + auto-context fetch before line 522 where `contextBlock` starts; append the soft-context block in the same shape as `client.ts:268-299` and `sage.ts:609-617`.

**Expected outcome:** the FIRST reply Sage sends to a couple already reflects what the email said. A couple who writes "we're stressed about my mum's chemo" gets a reply that doesn't open with "Excited to hear about your celebration!"

**Note:** unblocked today, no migration needed. Does not depend on mig 255.

### #2 — Hook auto-context into the intel narrators

**Files / lines:** `briefings.ts:117+` (build briefing context), `weekly-digest.ts`, `daily-digest.ts`, `source-quality.ts`, `intelligence-engine.ts` (the 14 detectors), `journey-narrative.ts:79-120` (fetchContext).

**Change:** add an auto-context aggregate query — counts by category, top recurring categories — to the briefing/digest context blocks. Surface in the LLM prompts so weekly digests can say "8 couples this week mentioned financial-stress markers; 3 mentioned family illness" without quoting verbatim.

**Expected outcome:** the venue's marketing decisions (which channels, which time windows, which messages) consume the soft truths. The intelligence loop USP from `CLAUDE.md` actually loops.

**Note:** unblocked today. Largest tenant-1 leverage.

### #3 — Ship migration 255 and wire `platform_handles` write-side

**Files / lines:** `pipeline.ts:620-633` (findOrCreateContact), `platform-detectors/*.ts` (per-platform write to `platform_handles`), `candidate-clusterer.ts:563` (extend cluster fingerprint to include cross-platform handle).

**Change:** apply mig 255; add a username-shape detector at the email pipeline so `Erinhorrigan` lands in `display_handle` not `first_name`; teach the clusterer that two candidates sharing a handle are one cluster regardless of platform.

**Expected outcome:** `Mconn`, `Erinhorrigan`, `User 89436314x...` stop appearing as first names. Pinterest + Knot + IG signals from the same handle merge into one candidate row, surface as one journey narrative, count as one lead in source-quality.

**Note:** mig 255 sits uncommitted. The user's audit-pending decision. Phase 1 of the design doc is schema-only — no behavior change ships with the migration alone.

### #4 — Render `platform_handles` + `display_handle` on the lead profile

**Files / lines:** `src/app/(platform)/agent/leads/page.tsx` (list), and a new `src/app/(platform)/agent/leads/[id]/page.tsx` (detail page does not exist today — the lead-list page is the only surface). Also `src/components/agent/` — add a HandleCollection component.

**Change:** display `Knot: rosaliehoyle · Pinterest: rosaliehoyle · IG: rosie.hoyle · Email: rosalie.hoyle@gmail.com` as small print under the picked name on every lead surface. Search-by-handle filter on the leads list.

**Expected outcome:** coordinator can pattern-match "I've seen this handle on three platforms" without code. The forensic-reconstruction promise becomes visible to the user.

**Note:** depends on mig 255 being applied. UI is straightforward once the column exists.

### #5 — Add a hard sensitive-content rule to `UNIVERSAL_RULES` / `COUPLE_RULES`

**Files / lines:** `src/config/prompts/universal-rules.ts`, `src/config/prompts/couple-rules.ts`. Today there's a per-prompt inline "do NOT quote verbatim" string at `sage.ts:614`, `client.ts:293`, `inquiry.ts:907`.

**Change:** promote the rule to UNIVERSAL_RULES so every brain inherits it. Once mig 255 ships `wedding_auto_context.sensitive`, gate the rule on the flag — coordinator-typed dietary preferences ("we hate DJs") can be quoted; AI-extracted health context cannot.

**Expected outcome:** review-response, post-tour follow-up, vendor-referral, and any future brain that loads soft-context cannot accidentally leak grief / health / financial-stress markers into a draft.

**Note:** the universal-rules half is unblocked today (text edit). The category-aware gating waits for mig 255 + a `sensitive` boolean writer.

---

## 8. Open questions for Isadora

1. **Migration 255 — ship now or after a usage cycle?** The design doc is committed; the schema is additive and idempotent; no code reads/writes it yet. Shipping the schema ahead of capture-site refactor doesn't break anything but burns a slot. Do you want it merged this week so the column is queryable in production, or held until Phase 2 (capture refactor) is staged?

2. **Soft-context category enum — extend or normalize?** `profile-enrichment.ts:287-299` allows only `life_context | family | vendors | budget | health | dietary | timeline | cultural | preferences | logistics | misc`. "Grief" / "financial_stress" / "family_conflict" / "mental_health" (mentioned in mig 255 step 6 as auto-flag-sensitive categories) all fall into `misc` today. Should the enum extend, or should a separate `tags: string[]` column carry richer semantics?

3. **Handle-shape detector — heuristic or LLM?** `Erinhorrigan` vs `Erin Horrigan` is decidable by simple rules (single token, length > 11, no vowels-after-consonants in expected pattern). `Mconn` is harder — it's a name shape but it's smushed. `User 89436314x...` is trivial. Do you want a tiered detector (cheap regex first, LLM only on ambiguous shapes) or a single LLM pass with low-confidence boundary?

4. **Re-engagement drafter privacy posture — relax or tighten?** The drafter at `re-engagement-drafter.ts:90-116` deliberately bans specific signal counts ("you saved us 3 times"). Now that the soft-signal infrastructure exists, do you want re-engagement messages to be allowed to reflect EMOTIONAL truths (e.g. "if it's still a hard time, totally no rush") when the candidate's pre-zero signals carry that context — or stay generic to prevent surveillance feel even when the data exists?

5. **Review-response awareness of soft-context — do you want it?** A review reply that knows the bride's mum was sick during planning could land beautifully — or could be gross. Tenant 1 says yes; product instinct may say no for public-facing surfaces. Decision needed before #5 in the gap fixes ships.

---

End of audit. ~3,950 words. All citations are file:line against the working tree as of 2026-05-09.
