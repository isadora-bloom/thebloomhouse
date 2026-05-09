# LLM Call Inventory

Snapshot 2026-05-09. Repo: `C:\Users\Ismar\bloom-house`.

All calls go through `src/lib/ai/client.ts` (`callAI`, `callAIJson`, `callAIVision`). Anthropic primary, OpenAI `gpt-4o-mini` fallback. Sonnet model = `claude-sonnet-4-20250514`, Haiku = `claude-haiku-4-5-20251001`, Opus declared but unused. Vision is hardwired to Sonnet (no tier param).

## TL;DR

- **Total call sites: 50**, defined in 38 files. (`callAI` 21, `callAIJson` 24, `callAIVision` 5; plus one direct `anthropic.messages.create` for PDF document blocks in bar-recipe-extract.)
- **Distinct prompt-version constants: 36** (see "Prompt versions" at bottom).
- **Personality identity issues found: 7 distinct drift patterns** — see "Personality drift".
- **Tier-mismatch flags: 4 likely Sonnet→Haiku candidates, 2 likely Haiku→Sonnet candidates**.
- **Opus is declared (`OPUS_MODEL`) but never invoked anywhere in the codebase.**

---

## Couple-facing surfaces (need consistent Sage voice)

| File | Function | Surface | Tier | maxTokens / temp | Personality identity | promptVersion | Output | Fallback |
|---|---|---|---|---|---|---|---|---|
| `src/lib/services/brain/sage.ts:629` | `generateSageResponse` | Couple portal chat (Sage) | sonnet (default) | 1500 / 0.4, contentTier 1 | UNIVERSAL_RULES + venue personality (ai_name required, throws on missing) + SAGE_BASE_PERSONA + KB + intel + wedding context | `sage-brain.prompt.v1.2` | freeform text + chat sign-off appended | none — error returned |
| `src/lib/services/brain/inquiry.ts:714` | `generateInquiryDraft` (first response) | Coordinator-reviewed first-response email draft | sonnet | 1500 / 0.4 | UNIVERSAL_RULES + buildPersonalityPrompt + inquiry task prompt + learning block | `inquiry-brain.prompt.v1.2` | freeform email body | none |
| `src/lib/services/brain/inquiry.ts:961` | `generateFollowUp` | 3-day / 7-day / final follow-up draft | sonnet | 800 / 0.4 | same 4-layer stack | `inquiry-brain.prompt.v1.2` | freeform | none |
| `src/lib/services/brain/client.ts:475` | `generateClientDraft` | Booked-couple email reply | sonnet | 1200 / 0.3 | UNIVERSAL_RULES + CLIENT_RULES + buildPersonalityPrompt + client task prompt + learning | `client-brain.prompt.v1.1` | freeform | none |
| `src/lib/services/brain/client.ts:668` | `generateOnboardingEmail` | Welcome email after booking | sonnet | 1200 / 0.4 | same | `client-brain.prompt.v1.1` | freeform | none |
| `src/lib/services/brain/post-tour-brief.ts:362` | post-tour follow-up draft | Coordinator-reviewed post-tour draft | sonnet | 700 / 0.5, tier-1 | inline `You are ${aiName}, composing a personalised follow-up email from ${venueName}` + voice anchors from review_language | `post-tour-brief.prompt.v1.0` | freeform or `NO_DRAFT` | null on error |
| `src/lib/services/brain/re-engagement-drafter.ts:147` | `draftReEngagementMessage` | Coordinator drafts to candidate identities (email + manual_paste) | sonnet (default) | 200–400 / 0.4 | inline SYSTEM_PROMPT + venue.ai_name (`requireAiName`) | `re-engagement-drafter.prompt.v1.0` | freeform | null |
| `src/lib/services/brain/review-response.ts:167` | `generateReviewResponse` | Public reply to a venue review | sonnet (explicit) | 500 / 0.7 | UNIVERSAL_RULES + buildPersonalityPrompt + tone-pivot-by-rating task prompt | `review-response.prompt.v1` | freeform 2-4 sentences | none |
| `src/app/api/portal/sage/route.ts:243` | Sage file extraction (vision) | OCR for couple-uploaded contracts/screenshots | vision (Sonnet hardwired) | 4000 | inline "document text extraction specialist" — generic, no Sage identity | none | text | non-blocking warn |
| `src/app/api/couple/contracts/route.ts:214/242/260/284/418` | Contract analysis suite | Couple-portal contract analysis (vision OCR + analyzer + Q&A) | vision (sonnet) / sonnet | 500–4000 / default | five inline prompts: "document text extraction specialist", "wedding contract analysis specialist", planning-extraction "Extract key planning details", "wedding planning assistant" Q&A. **No ai_name, no venue voice, no SAGE_BASE_PERSONA** | none | freeform / JSON | error response |
| `src/app/api/couple/contracts/route.ts:324` | Contract planning extraction | Pulls vendor/cost/date items from contract | sonnet (default) | 1500 | inline "Extract key planning details" — extractor, no personality | none | JSON array | empty array |
| `src/app/api/portal/event-feedback/route.ts:157` | proactive review-response draft | Coordinator-side draft before couple posts public review | sonnet (default) | 1000 / 0.5 | inline "You are a professional wedding venue coordinator" — **no ai_name, no UNIVERSAL_RULES** | none | freeform | error |
| `src/app/api/public/sage-preview/route.ts:178` | Public marketing-site Sage preview | Pre-signup chat (no DB save) | sonnet (default) | 300 / 0.4 | inline `## YOUR IDENTITY: ${aiName} ${aiEmoji}` + warmth dial + USPs. **Does NOT include UNIVERSAL_RULES or SAGE_BASE_PERSONA** | none | freeform | error |
| `src/app/api/onboarding/test-draft/route.ts:108` | Onboarding "test draft" preview | Onboarding wizard sample reply | sonnet (default) | 800 / 0.6 | inline `You are an AI assistant for "${venueName}"` + warmth/formality/energy/brevity/play dials + KB. **No UNIVERSAL_RULES, no AI-disclosure** | none | freeform | error |
| `src/app/api/settings/personality/preview/route.ts:193` | Personality settings preview | Coordinator "preview my voice" surface | sonnet (explicit) | 600 / 0.6, contentTier 2 | UNIVERSAL_RULES + personality prompt + inline preview task prompt + banned/approved phrases | `personality-preview.prompt.v1` | freeform | error |

### Couple-facing observation

13 surfaces talk to or near couples. **Five different prompt assemblies**:

1. The 4-layer stack (UNIVERSAL_RULES + personality + task + learning) — the canonical Sage. Used by `inquiry.ts`, `client.ts`, `review-response.ts`, `settings/personality/preview/route.ts`.
2. The Sage-chat stack (UNIVERSAL_RULES + personality + Sage task + KB + intel + wedding) — `sage.ts`.
3. Inline ad-hoc prompts that DO use `ai_name` but skip UNIVERSAL_RULES and SAGE_BASE_PERSONA — `sage-preview/route.ts`, `re-engagement-drafter.ts`, `post-tour-brief.ts`.
4. Inline prompts that have **no venue identity at all** — `couple/contracts/route.ts` (5 calls), `portal/event-feedback/route.ts`, `portal/sage/route.ts:243` (vision OCR).
5. Inline prompt with a partial dial-only personality but no name — `onboarding/test-draft/route.ts`.

---

## Coordinator-facing intelligence narrators

These compose plain-English explanations from deterministic detectors. Most output `{title, body, action}` JSON.

| File | Function | Surface | Tier | Personality identity | promptVersion |
|---|---|---|---|---|---|
| `src/lib/services/insights/heat-narration.ts:462` | heat-score explainer | Lead-detail / inbox heat tile | sonnet | `You are ${aiName}, a wedding-venue concierge` | `heat-narration.prompt.v1.2` |
| `src/lib/services/insights/correlation-narration.ts:646` | cross-channel correlation narration | `/intel/macro-correlations` | sonnet | nameless: `You are explaining a statistical correlation` | `correlation-narration.prompt.v1` |
| `src/lib/services/insights/cohort-match.ts:555` | look-alike cohort diagnostic | Lead detail | sonnet | `You are ${aiName}, helping a wedding-venue coordinator` | `cohort-match.prompt.v1.0` |
| `src/lib/services/insights/decay-re-engagement.ts:361` | decay diagnosis + re-engagement plan | Lead detail | sonnet | `You are ${aiName}, diagnosing why a wedding-venue lead has gone quiet` | `decay-re-engagement.prompt.v1.0` |
| `src/lib/services/insights/negotiation-state.ts:268` | negotiation phase classifier | Lead detail | sonnet | `You are ${aiName}, a wedding-venue concierge classifying a couple's negotiation phase` | `negotiation-state.prompt.v1.0` |
| `src/lib/services/insights/risk-flags.ts:487` | risk-flags summary | Lead detail | sonnet | `You are ${aiName}, summarising a couple's risk flags` | `risk-flags.prompt.v1.0` |
| `src/lib/services/insights/risk-flags.ts:346` | sentiment scan over inbound emails | Lead detail (input to risk flags) | haiku | `You are ${aiName}, classifying whether a couple's recent inbound messages contain NEGATIVE OR HESITANT sentiment` | `risk-flags.prompt.v1.0` |
| `src/lib/services/insights/pricing-elasticity.ts:577` | pricing-elasticity diagnostic | `/intel/pricing` | sonnet | `You are ${aiName}, helping a wedding-venue coordinator` | `pricing-elasticity.prompt.v1.0` |
| `src/lib/services/insights/source-mix-counterfactual.ts:401` | source-mix counterfactual | `/intel/sources` | sonnet | `You are ${aiName}, helping a wedding-venue coordinator` | `source-mix-counterfactual.prompt.v1.0` |
| `src/lib/services/insights/strength-area-cohort.ts:298` | strength-area cohort diagnostic | `/intel/sources` | sonnet | `You are ${aiName}, helping a wedding-venue coordinator` | `strength-area-cohort.prompt.v1.0` |
| `src/lib/services/insights/coordinator-override-pattern.ts:357` | draft override audit | `/agent/learning` | sonnet | `You are ${aiName}, helping the venue coordinator audit how their AI-drafted email collaboration is going` | `coordinator-override-pattern.prompt.v1.0` |
| `src/lib/services/insights/weather-cancellation.ts:240` | weather-cancellation narration | `/intel/anomalies` | sonnet | nameless: `You are explaining a weather-driven tour-cancellation pattern` | `weather-cancellation-narration.prompt.v1.0` |
| `src/lib/services/intel/anomaly-detection.ts:750` | metric anomaly explainer | `/intel/anomalies` | sonnet (default) | nameless: `You are a wedding venue operations analyst` | `anomaly-detection.prompt.v1.0` |
| `src/lib/services/intel/anomaly-detection.ts:1046` | availability-anomaly explainer | `/intel/anomalies` | sonnet | nameless: `You are a wedding venue operations analyst writing a short explanation of an availability anomaly` | `availability-anomaly-explanation.prompt.v1.0` |
| `src/lib/services/intel/intelligence-engine-narration.ts:255` | generic insight narrator | various intelligence_insights rows | sonnet | nameless: `You are narrating a venue-intelligence insight` | (`BRAIN_INTEL_ENGINE_PROMPT_VERSION`) |
| `src/lib/services/intel/briefings.ts:679` | weekly briefing | `/intel/briefings` + email | sonnet (default) | `You are the intelligence analyst for a wedding venue` | `briefings.prompt.v1.1` |
| `src/lib/services/intel/briefings.ts:872` | monthly briefing | `/intel/briefings` + email | sonnet (default) | same | `briefings.monthly.v1.1` |
| `src/lib/services/intel/daily-digest.ts:443` | morning digest summary | morning email | sonnet (default) | nameless: `concise morning briefing assistant` | `daily-digest.prompt.v1.0` |
| `src/lib/services/intel/weekly-digest.ts:650` | weekly digest summary | weekly email | sonnet (default) | nameless: `the intelligence analyst for a wedding venue` | none |
| `src/lib/services/intel/weekly-learned.ts:643` | "what we learned this week" panel | dashboard | sonnet | `You are ${aiName}, the wedding-venue coordinator's intelligence assistant` | `weekly-learned.v1` |
| `src/lib/services/brain/intel-brain.ts:1666` | NLQ on `/intel/sage` | natural-language-query chat | sonnet (default) | `You are the intelligence analyst for ${venueName}` (no ai_name) | `intel-brain.prompt.v1.2` |
| `src/lib/services/brain/intel-brain.ts:1805` | positioning suggestions | `/intel/positioning` | sonnet (default) | nameless: `wedding venue marketing strategist` | `intel-brain.prompt.v1.2` |
| `src/lib/services/brain/journey-narrative.ts:254` | wedding journey narrative | lead detail | sonnet (default) | nameless: 1-2 sentence narrative writer | `journey-narrative.prompt.v1.0` |
| `src/lib/services/tour/attendee-intelligence.ts:273` | attendee-mix outlier insight | tour-prep surface | sonnet | nameless: `intelligence assistant for a wedding-venue coordinator` | `attendee-intel.v1` |

### Coordinator-narrator observation

24 narrators, **at least three different identity patterns**:

- **`You are ${aiName}` group (10)** — heat, cohort, decay, negotiation, risk-flags (×2), pricing-elasticity, source-mix, strength-area, coordinator-override, weekly-learned. These read as the venue's AI concierge talking to its own coordinator.
- **Nameless analyst group (10)** — correlation-narration, weather-cancellation, anomaly explainers (×2), generic insight narrator, briefings (×2), daily/weekly digest, journey-narrative, attendee-intelligence, NLQ-positioning, intel-brain NLQ. These read as a generic "intelligence analyst" voice with no Bloom or Sage identity.
- **`You are the intelligence analyst for ${venueName}` group (1)** — NLQ chat. Uses venue name but not ai_name.

---

## Internal pipeline classifiers (Haiku tier — emit enums)

| File | Function | Output | Tier | promptVersion |
|---|---|---|---|---|
| `src/lib/services/brain/router.ts:306` | `classifyEmail` — 7-class routing + structured extraction | enum + extractedData | haiku | `router-brain.prompt.v1.1` |
| `src/lib/services/lifecycle/signal-detector.ts:245` | lifecycle signal (declined / silent_close / tour_cancelled / contract_signed / deposit_paid / null) | enum | haiku | `lifecycle.signal.v1.0` |
| `src/lib/services/inbox/folder-ai-classifier.ts:194` | inbox folder classification | enum | haiku | `inbox-folder-ai.prompt.v1.0` |
| `src/lib/services/extraction.ts:355` | inquiry signal extraction (24-field schema: stress, excitement, vendors, etc.) | structured JSON | haiku | `extraction.prompt.v1.0` |
| `src/lib/services/data-detection.ts:311` | 24-class CSV classifier | enum + confidence | haiku | `data-detection.prompt.v1.0` |
| `src/lib/services/data-detection.ts:472` | column-mapping (source-name → target-name) | dict | haiku | `data-detection.prompt.v1.0` |
| `src/lib/services/identity/candidate-ai-adjudicator.ts:166` | Tier-2 candidate adjudication | match_wedding_id + confidence + reasoning | haiku | `candidate-ai-adjudicator.prompt.v1.0` |
| `src/lib/services/intel/asset-matcher.ts:220` | brand-asset email attachment picker | array of asset IDs | haiku | `asset-matcher.prompt.v1.0` |
| `src/lib/services/voice\gmail-backfill.ts:128` | review-language extraction from outbound emails | array of phrases | haiku | `voice.gmail-backfill.v1` |
| `src/lib/services/brain-dump\index.ts:282` | brain-dump intent classifier (8-class + structured fields) | enum + nested extraction | haiku, contentTier 1 | `brain-dump.prompt.v1.1` |
| `src/lib/services/brain-dump\help.ts:409` | brain-dump help-question router | body + links | haiku, contentTier 3 | `brain-dump-help.prompt.v1.0` |

---

## Vision / extraction (no personality needed)

| File | Function | Surface | Tier |
|---|---|---|---|
| `src/app/api/brain-dump/route.ts:373` | screenshot classifier (reviews / analytics / identity / lead inquiry / calendar / invoice / contract / venue photo) | brain-dump capture | vision |
| `src/lib/services/bar-recipe-extract.ts:396` | image cocktail recipe extract | bar planner | vision |
| `src/lib/services/bar-recipe-extract.ts:442` | PDF cocktail recipe extract (direct `anthropic.messages.create` document block) | bar planner | sonnet (PDF) |
| `src/app/api/portal/sage/route.ts:243` | couple-uploaded image OCR | Sage chat | vision |
| `src/app/api/portal/quick-add/route.ts:308` | quick-add document → CSV vision extract | quick-add | vision |
| `src/app/api/portal/quick-add/route.ts:284` | docx → CSV (text-tier helper) | quick-add | sonnet (default) |
| `src/app/api/couple/contracts/route.ts:214/242` | couple contract OCR (vision) | couple portal contract upload | vision |

---

## Tour-specific extractors (tier-1 transcripts)

| File | Function | Output | Tier | contentTier |
|---|---|---|---|---|
| `src/lib/services/tour/transcript-extract.ts:201` | tour transcript JSON extraction | attendee_types / questions / emotional_signals / interests / dates / summary | sonnet (default), `You are ${aiName}` | 1 |
| `src/lib/services/tour/transcript-voice-learning.ts:109` | review-language phrases from tour transcripts | array | sonnet (default), nameless | 1 |
| `src/lib/services/tour/cancellation-reason.ts:85` | tour cancellation bucket | enum | sonnet (default), nameless | 1 |
| `src/lib/services/brain/cancellation-classifier.ts:371` | post-hoc cancellation reason from coordinator free-text | enum + confidence | sonnet (default), nameless | 1 |
| `src/lib/services/brain/voice-dna-extract.ts:332` | coordinator voice-DNA extraction | greetings/signoffs/pet_phrases/punctuation_tics/rules/sentence_rhythm | sonnet (explicit) | 1 |
| `src/lib/services/brain/post-tour-brief.ts:326` | coordinator-facing tour brief markdown | freeform with H3 sections | sonnet (default), `You are ${aiName}, the AI assistant for ${venueName}` | 1 |

---

## Proposers + extractors (operational tier)

| File | Function | Surface | Tier |
|---|---|---|---|
| `src/lib/services/insights/cultural-moments-llm-propose.ts:278` | propose cultural moments for coordinator confirm | `/intel/cultural-moments` | sonnet, **`You are an analyst for Bloom House`** (only call to actually self-identify as Bloom) |
| `src/lib/services/intel/trends.ts:429` | trend-based recommendations | `/intel/trends` | sonnet (default), nameless analyst |
| `src/lib/services/intel/planning-extraction.ts:279` | extract planning notes from couple chat | Sage chat side-effect | sonnet (default), no system "You are" — direct task instruction |
| `src/lib/services/intel/marketing-spend.ts:201` | extract spend rows from free-text | brain-dump / paste | sonnet (default), nameless |
| `src/lib/services/intel/review-language.ts:99` | extract phrases from a single review | reviews import | sonnet (default), nameless |
| `src/app/api/intel/reviews/extract-from-text/route.ts:93` | bulk-paste review extraction | reviews paste | sonnet (explicit), nameless |
| `src/app/api/brain-dump/route.ts:373` (vision, listed above) | screenshot classifier | — | — |

---

## Personality drift

1. **Couple-facing surfaces have inconsistent venue identity.** Five different prompt assemblies serve couples (see "Couple-facing observation"). Three carry no `ai_name` at all: `app/api/couple/contracts/route.ts:215/243/261/285/325/418`, `app/api/portal/event-feedback/route.ts:115`, `app/api/portal/sage/route.ts:244`. A couple chatting with Sage in `/portal/sage`, then asking Sage to analyse a contract in `/portal/contracts`, gets two different voices — Sage in chat, anonymous "wedding contract analysis specialist" in contract Q&A.

2. **Public sage-preview ignores UNIVERSAL_RULES.** `src/app/api/public/sage-preview/route.ts:134` builds an inline prompt that uses `ai_name` and `ai_emoji` but skips the AI-transparency block, the banned-phrases list, and SAGE_BASE_PERSONA. This means the marketing-site preview can use phrases banned everywhere else (`circle back`, `unfortunately`, etc.) and is the only Sage that doesn't enforce the hard "ARE YOU AN AI?" rule.

3. **Onboarding test-draft is stripped of all venue identity.** `src/app/api/onboarding/test-draft/route.ts:91` opens with `You are an AI assistant for "${venueName}"` — no `ai_name`, no `requireAiName`, no UNIVERSAL_RULES. A coordinator previewing in onboarding sees output that doesn't match what production Sage will produce.

4. **Coordinator-narrator group is split 10/10/1 between `${aiName}`, nameless analyst, and `${venueName}`.** Briefings (`briefings.ts`), digests (`daily-digest.ts`, `weekly-digest.ts`), correlation/weather/anomaly narrations, journey-narrative, attendee-intelligence, NLQ positioning, and intel-brain NLQ all sound like a generic external analyst. Heat, cohort, decay, negotiation, risk-flags, pricing, source-mix, strength-area, override-pattern, and weekly-learned all sound like the venue's named AI concierge. Same coordinator reading their `/intel` dashboard hears two different voices on adjacent tiles.

5. **`Bloom House` is mentioned by name in only two prompts.** `src/lib/services/insights/cultural-moments-llm-propose.ts:80` (`You are an analyst for Bloom House`) and `src/lib/services/brain-dump/help.ts:390` (`questions about The Bloom House`). Every other narrator either uses `${aiName}` (the per-venue concierge) or anonymous "intelligence analyst" framing — there is no consistent "this is Bloom" coordinator voice.

6. **Sage's couple-portal sign-off is appended in code, not in the prompt.** `src/lib/services/brain/sage.ts:653` calls `buildChatSignoff` and concatenates the escalation reminder onto the response. The model is never told to write it. Means edits to the sign-off don't go through prompt-version bumps.

7. **Re-engagement drafter and post-tour-brief use `requireAiName` correctly, but their prompts are inline (not using `buildPersonalityPrompt`)** — they get the name but not the warmth/formality dials, banned phrases, or USPs. So an inquiry-brain reply and a re-engagement message from the same venue can sound calibrated differently.

---

## Tier mismatches

Sonnet calls that are bounded structured-output tasks Haiku could handle:

1. **`src/lib/services/brain/cancellation-classifier.ts:371`** — coordinator free-text → 9-bucket enum + 3-level confidence. Mirror sibling `src/lib/services/tour/cancellation-reason.ts:85` does the SAME job on inbound email body, also defaulted to Sonnet (no `tier:` set). Both should be Haiku per the same OPS-21.4.2 reasoning the router-brain (line 316) and lifecycle signal-detector (line 250) already follow. Files even comment `Sonnet was overkill` for adjacent classifiers.
2. **`src/lib/services/tour/transcript-voice-learning.ts:109`** — bounded extraction (phrase / theme / sentiment) with a closed `REVIEW_THEMES` enum. Same shape as `src/lib/services/voice/gmail-backfill.ts:128` which IS Haiku. Voice-learning runs once per tour transcript so volume is moderate, but the schema is identical.
3. **`src/lib/services/intel/review-language.ts:99`** — same review-language extraction with the same closed theme enum. Defaulted to Sonnet (no `tier:` set). Sibling `voice/gmail-backfill.ts` uses Haiku for the same job.
4. **`src/lib/services/intel/marketing-spend.ts:201`** — extract `(source, month, amount)` rows from free-text. Bounded structured output with strict format. Defaulted to Sonnet.

Calls that are likely Haiku→Sonnet candidates (judgement, not classification):

1. **`src/lib/services/insights/risk-flags.ts:346`** — sentiment scan on the last 3 inbound messages, classified `negative: true | false`. Set to Haiku, but the prompt asks the model to weigh stress, hesitation, comparison-shopping signals across multiple emails. The companion narration call below (line 487) is Sonnet. The Haiku classification is the load-bearing input — if it's wrong, the narration is wrong.
2. **`src/lib/services/identity/candidate-ai-adjudicator.ts:166`** — Tier-2 candidate adjudication. Set to Haiku per a `Sonnet was overkill` comment, but the call is asked to weigh first-name + last-initial + state + timing + funnel-depth + `recent_email_subjects` text patterns ("saw you on The Knot") to pick one of 2+ weddings. Could justify Sonnet given the qualitative inputs and the cost of a wrong attribution.

---

## Prompt-version constants (36)

Pattern is `<surface>.prompt.v<major>.<minor>` (with two outliers using `.v1` only). All threaded into `api_costs.prompt_version` via the standard `callAI` wrapper.

`router-brain.prompt.v1.1`, `inquiry-brain.prompt.v1.2`, `client-brain.prompt.v1.1`, `sage-brain.prompt.v1.2`, `intel-brain.prompt.v1.2`, `post-tour-brief.prompt.v1.0`, `voice-dna-extract.prompt.v1.0`, `journey-narrative.prompt.v1.0`, `re-engagement-drafter.prompt.v1.0`, `cancellation-classifier.prompt.v1.0`, `review-response.prompt.v1`, `lifecycle.signal.v1.0`, `inbox-folder-ai.prompt.v1.0`, `extraction.prompt.v1.0`, `data-detection.prompt.v1.0`, `candidate-ai-adjudicator.prompt.v1.0`, `asset-matcher.prompt.v1.0`, `voice.gmail-backfill.v1`, `brain-dump.prompt.v1.1`, `brain-dump-help.prompt.v1.0`, `bar-recipe-extract.prompt.v1.0`, `attendee-intel.v1`, `weekly-learned.v1`, `briefings.prompt.v1.1`, `briefings.monthly.v1.1`, `daily-digest.prompt.v1.0`, `anomaly-detection.prompt.v1.0`, `availability-anomaly-explanation.prompt.v1.0`, `BRAIN_INTEL_ENGINE_PROMPT_VERSION` (intelligence-engine-narration), `planning-extraction.prompt.v1.0`, `marketing-spend.prompt.v1.0`, `heat-narration.prompt.v1.2`, `correlation-narration.prompt.v1`, `weather-cancellation-narration.prompt.v1.0`, `cohort-match.prompt.v1.0`, `decay-re-engagement.prompt.v1.0`, `negotiation-state.prompt.v1.0`, `pricing-elasticity.prompt.v1.0`, `source-mix-counterfactual.prompt.v1.0`, `strength-area-cohort.prompt.v1.0`, `coordinator-override-pattern.prompt.v1.0`, `risk-flags.prompt.v1.0`, `personality-preview.prompt.v1`, `reviews.paste.v1` (inline at `app/api/intel/reviews/extract-from-text/route.ts:102`), `cultural-moments-llm-propose.v1`.

Bumps mean either system-prompt rewrites or task-prompt structural changes (per repo-root `PROMPTS-CHANGELOG.md` referenced in every brain's docstring). `inquiry-brain` v1.2 bump explicitly notes "added explicit Headcount status line"; `intel-brain` v1.2 added correlation-narration block to NLQ data context; `sage-brain` v1.2 carried prompt-injection sanitization; `heat-narration` v1.2 for cohort-damping language.

Several call sites pass NO promptVersion at all: `app/api/couple/contracts/route.ts` (5 calls), `app/api/portal/event-feedback/route.ts:157`, `app/api/public/sage-preview/route.ts:178`, `app/api/onboarding/test-draft/route.ts:108`, `app/api/portal/quick-add/route.ts` (2 calls), `app/api/portal/sage/route.ts:243`, `lib/services/intel/weekly-digest.ts:650`, `lib/services/intel/review-language.ts:99`. These are unaudited — `api_costs.prompt_version IS NULL` rows.

---

## Cross-cutting recommendations

- **Couple-facing surface unification.** Move `app/api/couple/contracts/*` and `app/api/portal/event-feedback` to use `loadPersonalityDataCached + buildPersonalityPrompt + UNIVERSAL_RULES` so they speak as Sage. Same for `public/sage-preview` (loses banned-phrases enforcement today) and `onboarding/test-draft` (loses ai_name today).
- **Coordinator-narrator base prompt.** Extract a `BLOOM_NARRATOR_BASE` constant similar to `SAGE_BASE_PERSONA` and prepend it to every analyst-tier prompt. Today's split (10 named-Sage / 10 nameless / 1 named-venue) makes the `/intel` dashboard read like four authors.
- **Identity block standardization.** Two ways venues currently get identified: `${aiName}` and `${venueName}`. NLQ uses venue, narrators use ai_name. Pick one anchor and document the discipline.
- **Tier audit pass.** Drop Sonnet → Haiku on the four bounded-extraction calls listed above; consider Haiku → Sonnet on candidate adjudication and the risk sentiment scan.
- **promptVersion plug-in for the 9 untagged call sites.** They burn tokens without the audit trail every other brain has.
- **Opus is dead code.** `OPUS_MODEL` is exported but no caller passes `tier: 'opus'`. Either retire the constant or wire it to the high-stakes voice-DNA corpus pass / cross-domain synthesis the comment promises.
- **Sage chat sign-off lives in code, not prompt.** Move it into the prompt or document why it's in the response post-processor — it currently bypasses promptVersion review.
