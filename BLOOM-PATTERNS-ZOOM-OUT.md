# Bloom architectural patterns — zoom-out audit

After May 11-12 deep-fix session, here's what we shipped, the architectural
patterns those fixes represent, and **where else those same patterns need
to land** but currently don't.

Each pattern is rated by **impact** (size of operator/data benefit) and
**effort** (rough days to ship).

---

## Pattern 1 — Sticky per-couple state (the AI-opt-out architecture)

**What we shipped:** `weddings.ai_opted_out` — once a couple asks for a human,
Sage stops drafting for them forever (until operator clears the flag).
Per-event flag became per-couple sticky.

**Where else this applies (currently NOT sticky, should be):**

| Decision | Current | Should be |
|---|---|---|
| Tour completed → couple's "I've seen it" knowledge | Per-event in tours table | Sticky `weddings.has_toured_in_person` — Sage stops sending "come see us" CTAs forever |
| Couple's stated channel preference ("text me, don't email") | Not captured | Sticky `weddings.preferred_channel` — auto-send respects it |
| Operator-confirmed identity (Justin & Sandy via override) | LLM can re-suggest "Sarah" on next inbound | Sticky operator-confirmed flag on people row — LLM never overrides |
| Operator-confirmed wedding date | Auto-derive can flip the date if a new signal conflicts | Sticky `weddings.date_confirmed_by_operator` — auto-derive flags conflict, doesn't overwrite |
| Lost status | `weddings.status='lost'` but can flip back if a new email arrives | Sticky `weddings.lost_at_operator` — auto re-engagement only fires if operator explicitly re-opens |
| Couple's stated wedding day-of timeline | Each Sage draft can re-propose | Sticky once operator confirms |

**Impact: high. Effort: 1 day for the schema + override-everywhere pattern.**
This is the single most leveraged architectural cleanup — operator authority becomes structurally enforced.

---

## Pattern 2 — Cascade triggers on state change

**What we shipped:** Identity cascade fires when (a) a wedding gets new
identity signals (per-wedding trigger), (b) brain-dump confirms new
anonymous signals (venue-wide trigger), (c) daily cron (safety net).

**Where else cascades are missing:**

| State change | Currently | Should trigger |
|---|---|---|
| Operator imports a Knot CSV via brain-dump | ✅ Cascade fires (just shipped) | Done |
| Operator changes venue pricing | Nothing fires | Re-compute all open inquiry quotes; flag drafts that quoted old prices for review |
| Operator changes AI personality (warmth, tone) | Nothing fires | Re-evaluate recent drafts in pending queue; ask "regenerate?" |
| Operator imports marketing_spend_records | Nothing fires | Recompute CAC + persona-channel rollups + spend-flag detector |
| Operator marks a wedding lost | Sets `weddings.lost_at` | Should also: cancel pending drafts, fire lost-reactivation eligibility (when N days pass), update cohort heat distribution |
| Operator adds a vendor to the venue list | Sets `vendors` row | Should: re-check every active wedding for vendor-discount eligibility, refresh vendor-mention detection on recent inbounds |
| Operator confirms a new tour outcome | Updates `tours.outcome` | Should: fire `tour_completed` engagement event (already done), recompute lead heat, trigger post-tour sequence |
| New inquiry arrives | Email pipeline writes wedding | Should also: query for any matching pre-zero candidate_identities (Justin & Sandy pattern) — currently happens via cron, not synchronously |

**Impact: high. Effort: ~2 days to formalize a `cascade-on-change` pattern
+ wire the top 5.** The general principle: most state changes should trigger
downstream effects via event-driven cascade, not waiting for daily cron.

---

## Pattern 3 — Body extraction parity across channels

**What we shipped:** SMS body-email extraction with joint-handle parser
(Justin & Sandy). Catches "can you email us at justinlovewithsandy@gmail.com".

**Where else body extraction is silent:**

| Channel | Body extraction status |
|---|---|
| Inbound email | ✅ Universal body-identity extractor runs |
| Inbound SMS | ✅ Just shipped (body-email tier) |
| Call transcript | ❌ Nothing — but transcripts often carry "yeah email me at..." |
| Voicemail transcript | ❌ Same |
| Zoom meeting transcript | ❌ Same — couple often shares contact info verbally |
| Brain-dump operator notes | ❌ "Told Sarah about parking" should trigger Sarah-match |
| Web-form free-text fields | ❌ Couples sometimes drop a secondary email in the "questions" field |
| Outbound email/SMS body | ❌ Sage's own drafts mention couple identifiers — could backref-check unmatched recipients |

**Impact: medium-high. Effort: 1 day to extend the existing body-extract
service to run on every interaction insert regardless of type.**

The same `findBodyEmails` + `parseJointEmailHandle` + `resolveIdentity` chain
should run on every body. Cost is regex (free) + identity resolver (cheap)
+ Haiku only when nothing matches (rare).

---

## Pattern 4 — Watermark-based incremental sync (not fixed windows)

**What we shipped:** OpenPhone sync now uses `last_synced_at - 15min`
watermark, falls back to 180-day first-sync window. No more "always last
1h" cron that drops messages.

**Where else fixed-window-syncs likely exist:**

| Service | Likely state | Audit needed |
|---|---|---|
| Gmail polling (`pipeline.ts`) | Wave 9 watermark fix existed | Confirm it's truly watermark not fixed window |
| Zoom polling (`zoom.ts`) | Probably fixed window | Audit + add watermark |
| Calendly webhook | Push-based, but no backfill on first connect | Add first-sync history pull |
| FRED economic data | Daily cron | Should be watermark — re-fetching same 5 years every night is wasteful |
| Cultural moments LLM proposer | Probably fixed window | Should be watermark |
| Various intel rollup crons | Many likely re-process the same data every night | Audit + add watermark |

**Impact: low-medium per service. Effort: half-day per service to audit
+ add watermark.** Mostly a cost-efficiency play; correctness rarely changes.

---

## Pattern 5 — LLM as primitive, regex as fast-path

**What we shipped:** SMS escalation detection (regex fast-path + Haiku
fallback). SMS name extraction (Haiku). Author classification (Haiku).

**Where else heuristics are still in place but LLM should be primitive:**

| Decision | Currently | Should be |
|---|---|---|
| Lost-reason classification | Sage classifies on lost-mark? Need to check | Haiku reads the last inbound + outbound to infer reason; populate `lost_reason_category` |
| Tour outcome derivation | Operator manually sets | Could auto-suggest "completed" vs "cancelled" vs "no_show" from transcript / post-tour text |
| Wedding date extraction from body | Regex-heavy in `body-extract.ts` | Haiku could be more flexible ("the weekend of August 14" → 2026-08-14) |
| Lead source detection from body | Rules-based ("hear about us from") | Already runs `hear_source` extraction — verify LLM-driven |
| Sentiment of couple body | Not measured | Haiku could classify (positive/neutral/concerned/frustrated) — feeds heat |
| Urgency inference ("we need to book ASAP") | Not measured | Haiku → urgency flag → bump heat + flag to operator |
| Family-mentioned signal | Wave 28? probably regex | Should be Haiku — picks up "my mom is gluten-free" without regex hits |

**Impact: medium. Effort: ~half-day per dimension.** Each one is a small
Haiku call wired into the brain pipeline.

---

## Pattern 6 — Routability classifier at send chokepoint

**What we shipped:** `isUnsendableAddress` — gmail.ts refuses to send to
`.invalid` / no-reply / role addresses. `isPerProspectRelay` — knows
WeddingWire `user-{token}@reply.weddingwire.com` is routable.

**Where else this matters:**

| Send path | Currently | Should be |
|---|---|---|
| Gmail send | ✅ Uses isUnsendableAddress | Done |
| /agent/send route | ✅ Uses isUnsendableAddress | Done |
| /agent/reply route | ✅ Uses isUnsendableAddress | Done |
| Auto-send (pipeline) | ✅ Uses isUnsendableAddress | Done |
| Follow-up sequences | Probably ✅ via Gmail chokepoint | Audit |
| SMS outbound (Quo) | ❌ No equivalent — could send to a venue-line, shortcode, invalid number | Add `isUnsendableSmsAddress` (validate E.164, reject shortcodes, reject venue's own line) |
| Transactional emails (Resend) | ❌ Could send a venue invite to noreply@ | Add same guard |
| Couple-portal magic links | ❌ Could mail link to placeholder address | Add same guard |
| Daily digest emails to staff | ❌ Could mail to deactivated user_profiles | Audit |

**Impact: low-medium. Effort: ~half-day.** Mostly defensive belt-and-
suspenders coverage.

---

## Pattern 7 — Idempotent backfill paired with going-forward fix

**What we shipped:** Every architectural fix tonight came with a backfill
script (`rematch-sms`, `enrich-from-body-emails`, `backfill-voice-heat`,
`openphone-historical-sync`, `cascade-for-wedding`).

**Where else backfills are MISSING for fixes already deployed:**

| Fix | Backfill status |
|---|---|
| Wave 27 author_class | ✅ `author_class_backfill` cron exists |
| Wave 28 surface | ✅ Migration 294 rule-based backfill |
| Wave 30 (this session) SMS body-email | ✅ enrich-from-body-emails |
| Wave 30 voice heat | ✅ backfill-voice-heat |
| Migration 300 disclosure_version | ✅ Migration backfilled v1/v2/v3 markers |
| Migration 303 ai_opted_out | ✅ Migration backfilled from escalation_requested |
| Tour outcome classifier (if it exists) | Probably needs backfill against old tours |
| Sentiment / urgency / family-mentioned (if added) | Will need backfill at deploy time |
| Lost-reason classification (if added) | Will need backfill |

**The doctrine:** every new dimension we add to interactions/weddings/
people needs a paired backfill OR a column default that's safe + a slow
reclassification cron.

---

## Pattern 8 — Verify schema before writing SQL (the "made-up names" lesson)

**What we shipped:** Caught 5 made-up column names tonight, plus fixed 4
pre-existing silent failures (calendly webhook + inbox-filters + team
invite + intel-brain coordinator_absences).

**Where else silent failures likely exist:**

| Likely candidate | Why suspect |
|---|---|
| Any feature an operator hasn't tested end-to-end | Pre-existing tech debt surfaces on use, not on read |
| Any old admin page that hits multiple tables | Schema drift over time |
| Any cron job whose `data` field shape changed | Output shape rarely audited |
| Any AI-prompt code that selects columns | Schema knowledge lives in prompts too |
| Cross-table joins via `!fk_name` PostgREST syntax | FK names change/get renamed |

**Action:** systematic audit task — for every `.from('X').select(...)` in
the codebase, verify each named column exists in current schema. Could be
a CI guard (lint rule) or a one-time sweep.

**Impact: high to discover (eliminates silent failures). Effort: 1 day
sweep + ~2 hours per discovered bug.**

---

## Pattern 9 — Voice channel parity with email

**What we shipped:** SMS / calls / voicemail / Zoom now contribute to heat.
SMS LLM name + event-context match works on both directions.

**Where voice channels still aren't at email parity:**

| Feature | Email | SMS / voice |
|---|---|---|
| Heat scoring | ✅ | ✅ (just shipped) |
| Body identity extraction | ✅ universal | Partial (SMS body-email; not call/voicemail/Zoom transcript) |
| Auto-send rules | ✅ via auto_send_rules | ❌ SMS has no auto-reply system |
| Inbox lifecycle folders | ✅ 6 folders | ❌ No SMS folders |
| Sequences (follow-ups) | ✅ post_tour / ghosted etc fire emails | ❌ SMS isn't a sequence action_type |
| Knowledge gap detection | ✅ runs on email drafts | ❌ doesn't run on SMS drafts |
| Draft AI generation | ✅ inquiry-brain + client-brain | ❌ SMS doesn't have a brain — operator types manually |
| Draft learning loop | ✅ Wave 26 send button + LearningToast | ❌ SMS sends are direct, no draft layer |
| Escalation routing | ✅ via knowledge_gaps + admin_notifications | ❌ SMS escalation fires but doesn't queue |

**Impact: very high if you envision Bloom as a multi-channel platform.
Effort: ~1 week per voice surface (SMS auto-reply, SMS sequences, SMS
brain).** Significant. Probably worth doing AFTER more venues are live so
the demand for each is clear.

---

## Pattern 10 — Operator override channel for every auto-derived field

**What we shipped:** AI opt-out has UI banner + Resume button. Wedding
detail panel can override source attribution. Name evidence panel can
override partner names.

**Where overrides are missing or partial:**

| Auto-derived | Operator override |
|---|---|
| Wedding source (the_knot, instagram, etc) | ✅ via source-badge-editable |
| Partner names | ✅ via name-evidence panel |
| Heat score | ❌ no override — purely additive from events |
| Couple's persona label (intel) | ❌ no override |
| Tour outcome | ✅ operator sets directly |
| Wedding date | ✅ operator can edit |
| Lost reason | Probably operator-settable |
| AI opt-out | ✅ banner + Resume |
| First-touch attribution | ❌ no override — auto-elected |
| Author class on interactions | ❌ no override |
| Lifecycle folder (inbox) | Partial — reclassify button maybe |
| Wedding's matched candidate identities | Partial — apply/reject buttons exist via /intel/identity-backtrack |

**Impact: medium. Effort: ~2 days for an "override anywhere" pattern.**
Every Bloom screen with auto-derived values should have a small "I disagree"
button that stamps `<field>_overridden_by` + `<field>_overridden_at` and
makes the LLM/auto-derive layer respect it.

---

## Top 3 recommendations for next session

If you only have a day or two to chip away at these:

| Priority | Pattern | Why |
|---|---|---|
| 1 | **Pattern 2 — Cascade triggers on state change** | Highest leverage. Tonight's identity cascade is the template. Apply to pricing changes, marketing imports, lost-mark, operator overrides. Makes the platform truly event-driven. |
| 2 | **Pattern 1 — Sticky per-couple state** | Closest pattern to the AI opt-out fix. Generalizes operator authority. Catches the "LLM keeps overriding the human" class of bug at every flag. |
| 3 | **Pattern 3 — Body extraction parity across channels** | Quick win. Call transcripts + voicemail transcripts + brain-dump notes all carry identity signals we ignore. Same `findBodyEmails` chain already exists. |

The first two together set up the operator-authority + event-driven
architecture that everything else benefits from.

---

## Anchor commits (this session)

- `b896aab` — SMS LLM name matcher + audio-inbox threading
- `1a4c25c` — Mig 301 TEMP-table fix (Supabase SQL editor compat)
- `799d0ac` — body-email tier + joint-handle parser + Quo watermark
- `138d475` — voice heat + identity cascade per-wedding
- `8153651` — venue-wide cascade cron + brain-dump confirm hook

---

## Doctrine recap from this session

(For next session's grounding — distilled lessons.)

1. Verify schema before writing SQL. Grep `001_shared_tables.sql` for
   every table you reference. Don't trust memory of column names.
2. Knot / Instagram / Pinterest have NO API. They're all manual
   CSV/screenshot uploads through brain-dump.
3. Backfill scripts pair with every architectural fix. The going-
   forward fix doesn't help historical data.
4. Pre-existing tech debt is your problem when surfaced. Don't say
   "not introduced by me" and walk away.
5. LLM is the primitive for ambiguous human signal extraction.
   Regex is a fast-path filter, not the decision boundary.
6. Sticky state > per-event state when the decision concerns the
   relationship, not a specific moment.
7. Event-driven cascade > daily cron when the data dependency is
   strong (one signal directly affects another).
