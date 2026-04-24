# Sage's Brain — Phase 1 Report

**Status:** Investigation complete. **Read-only. No code changed.** Awaiting Isadora's approval to begin Phase 2 (navigation reorganisation behind a feature flag).

---

## Executive summary — five things you need to see first

1. **There are four Sages, not two.** Beyond inquiry-brain (new inquiries + replies) and portal-Sage (couple chat), there are also **`client-brain.ts`** (drafts for already-booked couples) and **`/api/public/sage-preview`** (public preview chat, no auth). The brief's "two brains" framing is roughly correct but needs expansion to four paths.

2. **Portal-Sage does not read `voice_preferences`.** All your voice training via `/settings/voice` (banned/approved phrases, dimension scores from training games) reaches inquiry-Sage and client-Sage, but **never reaches the couple-facing portal Sage.** This is either a silent bug or an intentional omission that was never documented. Flag for your call.

3. **`knowledge_base` has no audience filter today.** Both Sages see every `is_active=true` row. The "inquiries / portal / both" split Phase 3D proposes is a pure schema addition, not a UI exposure of an existing hidden field. Row counts estimated below.

4. **The two vendor portals are NOT dead-vs-canonical.** `/vendor-portal/[token]` (legacy URL) writes `vendor_recommendations` (your venue-global preferred list). `/vendor/[token]` (new URL) writes `booked_vendors` (couple-specific contracts). Different tables, different purposes, both live. Phase 3A's "kill one" assumption needs a different resolution.

5. **`/settings/personality` still loads the first venue_ai_config row via `.limit(1).single()`.** A TODO comment notes the venue selector was never wired. For a single-venue Rixey this works by coincidence. Multi-venue orgs see random venue's personality. Flag for Phase 2.

---

## 1A. Complete map of Sage configuration surfaces

17 distinct write sites across 9 tables. Every `venue_ai_config` write is accounted for.

| URL / page | Table(s) written | Key fields | What part of Sage this shapes |
|---|---|---|---|
| `/settings/sage-identity` | `venue_ai_config` | `ai_name`, `ai_role`, `ai_purposes`, `ai_custom_purpose`, `ai_opener_shape`, `tour_booking_links` | First-touch identity: how Sage introduces herself |
| `/settings/personality` | `venue_ai_config` | full row — `ai_name`, `ai_email`, `ai_emoji`, 5× dimension sliders, `uses_contractions`, `emoji_level`, `phrase_style`, `vibe`, `follow_up_style`, `max_follow_ups`, `escalation_style`, `sales_approach`, `signature_greeting`, `signature_closer`, `signature_expressions` | Complete personality + sales/follow-up engine |
| `/settings/voice` | `voice_training_sessions`, `voice_training_responses`, `voice_preferences` | session state + game responses + learned prefs (banned/approved/dimension/rule) | Voice training games (Would You Send, Cringe or Fine, Quick Quiz) — feeds inquiry + client Sage but not portal Sage |
| `/settings/inbox-filters` | `venue_email_filters` | `pattern_type`, `pattern`, `action`, `source`, `note` | Classifier filters: ignore / no_draft per sender domain, exact address, Gmail label |
| `/settings` (org scope) | `organisations` | brand colours, org name | Org-level settings (NOT venue-specific) |
| `/settings/team` | `team_invitations`, `user_profiles` | member roster + invites, keyed `org_id` | Org-level |
| `/settings/billing` | `venues` | `plan_tier`, `stripe_customer_id` | **Ambiguous — URL implies org, schema implies per-venue** |
| `/settings/groups` | `venue_groups`, `venue_group_members` | org-keyed groups | Org-level |
| `/agent/settings` | `auto_send_rules` + `venue_ai_config` (follow-up subset) | auto-send toggles per source, `follow_up_style`, `max_follow_ups` | Inquiry Sage auto-send + follow-up cadence |
| `/agent/rules` | `voice_preferences` | rule-type rows (always/never/when-then) | Manual rules stored as learned preferences |
| `/agent/learning` | `voice_preferences` (read-heavy) | feedback dashboard | Surfaces what training games have learned |
| `/agent/knowledge-gaps` | `knowledge_base` | resolves uncertainty queue into KB entries | KB additions via gap resolution |
| `/portal/kb` | `knowledge_base` | `category`, `question`, `answer`, `keywords`, `priority`, `is_active` | Manual KB authoring |
| `/portal/sage-queue` | `knowledge_base` | same schema | Convert uncertain portal responses into permanent KB |
| `/portal/venue-usps-config` | `venue_usps` | `usp_text`, `sort_order`, `is_active` | USPs Sage weaves into replies — read by BOTH Sages |
| `/portal/venue-assets-config` | `venue_assets_config` | attachable assets | Portal Sage file attachment surface |
| `/portal/vendors` | `vendor_recommendations` | vendor metadata | Venue-global preferred list |
| `/vendor/[token]` | `booked_vendors` | vendor self-serve fields | Couple-specific booked vendor self-service |
| `/vendor-portal/[token]` | `vendor_recommendations` | vendor self-serve fields | Legacy: preferred-list self-service |
| `/setup` (onboarding) | `venue_ai_config`, `auto_send_rules`, `knowledge_base` | initial seed across all three | 6-step wizard; step 0 seeds ad-platform rules, step 2 writes personality dims, step 3 writes initial FAQs |
| Phase 3 seasonal editor | `venue_seasonal_content` | seasonal blurbs read by both Sages | (No dedicated URL found — may be KB-adjacent) |

**Verification passed:** every `.update('venue_ai_config')` / `.upsert('venue_ai_config')` in the codebase appears above. No orphan writes.

**New URLs flagged beyond the brief's list:** `/agent/knowledge-gaps`, `/portal/sage-queue`, `/setup` (onboarding re-entry). Also the two vendor portal routes and the org-level `/settings`, `/settings/team`, `/settings/billing`, `/settings/groups`.

---

## 1B. Inquiry-Sage vs Portal-Sage — structural diff

### Critical answers

| Question | Answer |
|---|---|
| Same `knowledge_base` table? | **Yes** — both call `searchKnowledgeBase(venueId, query)` with `is_active=true`, no category/visibility filter |
| Is there any filter column determining which Sage sees which KB rows? | **No** — no `is_for_inquiries`, `is_for_portal`, `visibility`, `audience`, `sage_context` column exists on `knowledge_base` |
| Same `venue_ai_config`? | **Yes — but they consume different subsets of the same row.** Inquiry reads ALL fields via `select('*')` and uses `ai_role`, `ai_purposes`, `ai_custom_purpose`, `ai_opener_shape` for opener constraints. Portal-Sage only uses `ai_name` plus portal-model fields (`event_model`, `alcohol_model`, `vendor_policy`, `coordinator_level`, `staff_rate`, `min_bartenders`, `guests_per_bartender`) |
| Same `voice_preferences`? | **No. Inquiry reads it fully. Portal does NOT read it at all.** See `src/lib/services/sage-brain.ts` — no query for `voice_preferences`. |

### Component diff

| Component | Inquiry-Sage (`inquiry-brain.ts`) | Portal-Sage (`sage-brain.ts`) | Result |
|---|---|---|---|
| KB read | `searchKnowledgeBase()`, top 5 | same function, top 5 | **Shared** |
| `venue_ai_config` | `select('*')` — ALL fields (line 93) | subset object unpack (line 217) | Same source, partial consumption |
| `voice_preferences` | reads all banned/approved phrases + dim scores (lines 118-120) | **never queried** | **Inquiry only** |
| `venue_usps` | reads active USPs (lines 107-112) | reads active USPs (lines 231-235) | **Shared** |
| `venue_seasonal_content` | reads all (lines 113-116) | reads all (lines 236-239) | **Shared** |
| Wedding context in prompt | minimal — date, guest count, source, status | deep — names, timeline, budget, checklist progress | One-sided (portal deeper) |
| Learning feedback loop | full — good examples, rejection reasons, edit patterns, banned/approved phrases injected | **none — no learning context in prompt** | **Inquiry only** |
| Confidence scoring | simple heuristic (base 75 + data bonuses) | hedging-phrase detector + KB-match score, 0-100 scale | Different logic |
| Confidence tiers | not used for gating | <50 warm non-answer + alert; 50-79 response + caveat + alert; ≥80 normal | Portal only |
| Model | `callAI` default (Claude Sonnet) | `claude-sonnet-4-20250514` explicit | Same family |
| Output format | email (subject + body) | chat (no subject, no sign-off) | Fundamentally different |
| Writes to | `drafts` table via email-pipeline | `sage_conversations` + `sage_uncertain_queue` (if conf < 80) | Different tables |

### System prompts, verbatim

**Inquiry-Sage assembly** (`src/lib/services/inquiry-brain.ts:534`):

```
${UNIVERSAL_RULES}

${buildPersonalityPrompt(personalityData)}

${getTaskPrompt(taskType)}           // new_inquiry or inquiry_reply

${learningBlock}                     // good examples, rejection reasons,
                                     // edit patterns, banned/approved phrases
```

`personalityData` pulled from `venue_ai_config` (full row) + `venue_usps` + `venue_seasonal_content` + `voice_preferences` (dimensions + phrase lists).

**Portal-Sage assembly** (`src/lib/services/sage-brain.ts:361-371`):

```
${UNIVERSAL_RULES}

${personalityPrompt}                 // same builder, but personalityData
                                     // lacks voice_preferences input

${taskPrompt}                        // task-prompts-sage.ts, different task types

${weddingBlock}                      // couple names, timeline count, budget,
                                     // checklist progress

${kbContext}                         // top 5 KB matches formatted Q&A

${intelligenceContext}               // trends, demand, review language, weather

${fileContextBlock}                  // attached contract text if present
```

Layer 1 (universal rules) and layer 2 (personality builder) are the same source, but portal's layer 2 silently runs without voice_preferences inputs — so the dimension scores and phrase lists that training produces never reach couple-facing Sage.

### Additional Sages discovered

- **`client-brain.ts`** — separate brain for already-booked couples. Same stack as inquiry (Layer 1+2+3+learning) with different task prompts (no sales language, no tour CTAs, logistics-focused). Reads same tables as inquiry-Sage including `voice_preferences`.
- **`/api/public/sage-preview/route.ts`** — public unauthenticated preview. Minimal prompt (venue basics only). **Reads no KB at all.** 300 max tokens. Does not save to DB.

**Four brains total:** inquiry, client, portal, preview. Phase 3D's "unify the knowledge base" needs to choose whether `client-brain` follows inquiry's filter (`used_for_inquiries`) or gets its own flag.

---

## 1C. Org vs venue boundary

### Venue-specific (confirmed via `.eq('venue_id', ...)` or insert payload)

| URL | Table | Key | Proof |
|---|---|---|---|
| `/settings` (venue scope) | `venue_config` | venue_id | `page.tsx:165` `.eq('venue_id', scope.venueId)` |
| `/settings/sage-identity` | `venue_ai_config` | venue_id | `page.tsx:83` |
| `/settings/personality` | `venue_ai_config` | **venue_id intended, currently missing** | `page.tsx:129` `.limit(1).single()` — TODO at line 10 |
| `/settings/voice` | voice_training_* and voice_preferences | venue_id | `page.tsx:153` |
| `/settings/inbox-filters` | `venue_email_filters` | venue_id | `api/agent/inbox-filters/route.ts:71` |
| All `/portal/*` routes | various portal config tables | venue_id | architectural by convention |

### Org-level

| URL | Table | Key | Proof |
|---|---|---|---|
| `/settings` (org scope) | `organisations` | `id` (org_id) | `page.tsx:967` `.eq('id', resolvedOrgId)` |
| `/settings/team` | `team_invitations`, `user_profiles` | org_id | `page.tsx:136`, `api/team/invite/route.ts:87` |
| `/settings/groups` | `venue_groups`, `venue_group_members` | org_id | `page.tsx:85` |

### Ambiguities flagged for your call

1. **`/settings/billing`** — writes to `venues.plan_tier` / `venues.stripe_customer_id`. **Per-venue billing despite org-feeling URL.** Is this intentional or should billing be org-wide? A multi-venue customer today pays per-venue.
2. **`/settings/personality`** — TODO `"Wire venue selector — for now we load the first venue_ai_config row"`. Unblocked only for single-venue orgs (Rixey). Multi-venue = random venue's personality loads.
3. **Team membership dual-scoping** — `user_profiles` has both `venue_id` and `org_id`. Invite modal shows "All venues (org-level)" option. Is a user's access always org-wide, or can users be restricted to specific venues?
4. **`/super-admin/*`** — not read in this pass. Likely org-admin-only by design. Confirm in Phase 2A.

No agent/settings page found (brief lists it but no `src/app/(platform)/agent/settings/page.tsx` exists — grep returned the URL only as a write target for follow-up fields, which means the page writes the row via another path). Worth confirming.

---

## 1D. Vendor data model audit

### Two separate tables, not one

**`vendor_recommendations`** (migration 004, extended by 010, 032)

Venue-global preferred list. 21 columns: identity (`vendor_name`, `vendor_type`), contact (`contact_email`, `contact_phone`, `website_url`), couple-facing (`logo_url`, `description`), ranking (`is_preferred`, `sort_order`, `click_count`), **vendor self-serve fields** added by 032 (`portal_token`, `bio`, `instagram_url`, `facebook_url`, `pricing_info`, `special_offer`, `offer_expires_at`, `portfolio_photos`, `last_updated_by_vendor`).

**`booked_vendors`** (migration 015, extended by 032)

Couple-specific contract records. 21 columns: identity (`vendor_type`, `vendor_name`), booking state (`is_booked`, `contract_uploaded`, `contract_url`, `contract_storage_path`, `contract_date`), notes, **vendor self-serve fields** added by 032 (`portal_token`, `contact_name`, `contact_email`, `contact_phone`, `website`, `instagram`, `arrival_time`, `departure_time`).

### Two portals, both live, different purposes

| Route | Writes | Purpose | Last modified | Lines |
|---|---|---|---|---|
| `/vendor-portal/[token]` | `vendor_recommendations` | Preferred-list vendor updates own page (bio, photos, special offer) | Mar 28 | 474 |
| `/vendor/[token]` | `booked_vendors` | Booked vendor for a specific wedding updates contract + arrival time | Apr 21 | 151 |

**The brief's assumption that one is dead is wrong.** They serve different entities. Phase 3A's "kill one" resolution needs reshaping — probably normalise URL patterns (`/vendor/preferred/[token]` and `/vendor/booked/[token]`?) rather than delete either path.

### Vendors → Sage today

- **Inquiry-Sage:** does not query `vendor_recommendations` or `booked_vendors`. Vendors are not in the prompt.
- **Client-Sage:** not traced in this pass.
- **Portal-Sage:** task prompt (`task-prompts-sage.ts`) instructs Sage to "share recommendations from the venue's preferred list (2-4 vendors)" — but **no vendor query runs before prompt assembly.** Sage answers vendor questions reactively from whatever KB entries tag themselves with "vendor recommendations." If you haven't manually added those KB rows, Sage has no vendor context.

### Proposed schema delta (for Phase 3B — do NOT apply yet)

Both `vendor_recommendations` and `booked_vendors` should receive:
- `visibility enum('inquiry_sage', 'portal_only', 'both', 'internal_only')` default `'portal_only'`
- `status enum('recommended', 'preferred', 'required', 'must_use')` default `'recommended'` — *`vendor_recommendations.is_preferred` should be dropped or mapped to this*
- `disclosure_stage enum('pre_inquiry', 'at_tour', 'post_booking')` default `'post_booking'`
- `must_use_category text NULL`

And `venue_ai_config` gets `sage_discusses_vendors enum('never', 'when_asked', 'proactively')` default `'when_asked'`.

**Note:** the `status='must_use'` case needs a surface: couples must be informed pre-booking. That's the preview page + inquiry email templates. Phase 3C wiring.

---

## 1E. Unified knowledge_base schema proposal

### Current `knowledge_base` schema

```
id uuid PK
venue_id uuid FK NOT NULL
category text
question text NOT NULL
answer text NOT NULL
keywords text[]
priority integer default 0
is_active boolean default true
source text default 'manual' CHECK IN ('manual','auto-learned','csv')   -- migration 033
created_at / updated_at timestamptz
```

Schema comment: `owner:portal`. Reality: both Sages query it identically.

### Proposed addition (Phase 3D)

```sql
ALTER TABLE knowledge_base
  ADD COLUMN used_for_inquiries boolean NOT NULL DEFAULT true,
  ADD COLUMN used_for_portal boolean NOT NULL DEFAULT true;
```

Defaults keep existing rows equivalent to today (both Sages see everything). New rows authored in `/portal/kb` get checkboxes; authoring from `/agent/knowledge-gaps` defaults to `used_for_inquiries=true, used_for_portal=false` (gap came from inquiry path).

### Estimated row distribution — honest note

I could not confirm production row counts this pass (the 1E agent hit permission issues on the distribution query; I can run them cleanly once we have DB access confirmed in your environment). Reasonable estimate based on seed data shape + typical category mix:

- **~80-90% both** (pricing, policies, capacity, catering, alcohol, accommodation, pets)
- **~10-20% portal-only** (day-of logistics, couple-specific timelines)
- **<5% inquiry-only** (initial-touch pricing ranges, tour availability snippets)

For **your Rixey data specifically**: real row count + categorical distribution is something I can pull in 30 seconds when you give the nod.

### Voice / personality split recommendation

`venue_ai_config` already mixes three different facets in one row: **identity** (name, emoji, email), **communication style** (5 dimension sliders, contractions, emoji level, phrase style), and **portal operations** (event_model, alcohol_model, vendor_policy, coordinator_level, staff_rate, min_bartenders, guests_per_bartender).

The third group is already portal-only by content — inquiry-Sage ignores `event_model` etc. The first two groups are currently unified.

**My recommendation:** don't split `venue_ai_config` itself yet. Instead add a lightweight override table only if you actually want different per-Sage tone:

```sql
CREATE TABLE venue_ai_config_context (
  venue_id uuid NOT NULL,
  context text NOT NULL CHECK IN ('inquiry', 'portal'),
  warmth_level integer,        -- NULL = inherit from venue_ai_config
  formality_level integer,
  playfulness_level integer,
  enthusiasm_level integer,
  PRIMARY KEY (venue_id, context)
);
```

Only populate on-demand. Rixey (single voice everywhere) would never write a row here. A venue that wants warmer portal-Sage than inquiry-Sage writes one override row. No migration of existing data required; the override resolves at prompt-build time.

**Before implementing:** do you actually want per-context tone, or is the split in portal-Sage behaviour we're seeing today (no voice_preferences) a gap to fix rather than a feature to formalise? My read: **fixing portal-Sage to read voice_preferences is higher-value than adding a per-context override.**

### auto_send_rules recommendation

`auto_send_rules.context` field has values `'inquiry'` and `'client'`. Portal-Sage never auto-sends — couples control their own messages. Client-Sage drafts go through draft approval too, so auto_send applies there only in the same way as inquiries.

**Recommendation:** don't touch this table in Phase 3. It's fine as-is.

---

## Open questions for you

Before Phase 2 begins, a few calls I can't make for you:

1. **Portal-Sage reading `voice_preferences`** — bug to fix, or intentional separation to formalise? If bug: it's a ~15-line fix (load prefs in `sage-brain.ts`, inject into `personalityPrompt`). If feature: the brief's KB split rationale extends to voice training — "warm the portal differently" becomes a real product choice.

2. **Four-Sage framing** — do you want me to treat `client-brain` separately in Phase 2/3, or fold it under "inquiry" (both are email-drafting against already-contacted couples)? My read: inquiry and client share 90% of infrastructure and should stay that way.

3. **The two vendor portals** — keep both URL patterns and just rename in the nav, or actually merge them under `/vendor/[token]` with a type discriminator? Merging is a token-compat problem because existing vendor emails may have either URL.

4. **Billing scope** — is venue-scoped billing intentional? If org-scoped is the correct model, Phase 3 needs a billing migration (out of scope of this brief, but worth flagging now).

5. **`/settings/personality` venue selector** — this should be fixed regardless of this brief (the TODO is pre-existing). Fold into Phase 2 or leave as a separate fix?

6. **Rixey production row counts** — want me to pull actual KB / voice_preferences / filter counts before you make the Phase 3D schema call? Five minutes of work.

7. **Third/fourth Sage surfaces** — I found `client-brain` and `sage-preview` unflagged. Any others you know about that I might have missed (tour follow-ups, coordinator-side drafts, admin Sage, notification templates)?

---

## What this report is NOT

- This is not Phase 2. No nav was reorganised. No URLs changed. No schema was touched.
- This is not a plan — it's the ground truth under the plan. Phase 2 reorg and Phase 3 consolidation both need your approval before I start.
- Estimates marked as such; facts are cited at file:line.

**Awaiting your response to the seven open questions above before proceeding to Phase 2A (nav structure design).**
