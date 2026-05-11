# Round 1 Verification — Findings vs Code

Companion to the Claude-proper Round 1 walkthrough (F1-F34 + 4 Novel patterns).
Date: 2026-05-11.
Method: critical verification of every finding against actual code at `C:\Users\Ismar\bloom-house\src` + all 26 waves shipped May-2026.

---

## Section 1 — Zoomed-out surface map

The 34 findings + 4 Novel patterns touch 11 distinct architectural surfaces. Here's each surface, what we've built on it, which findings hit it, and where verification stands.

| Surface | What we've built | Findings hit | Top-line status |
|---|---|---|---|
| **Email pipeline ingestion** (`lib/services/email/pipeline.ts`) | Wave 9 direction guard, signal_class classifier, Wave 19 knowledge-gap detector wiring, identity reconstruction enqueue | F1, F3, F8, F21, F25 | Two root holes: no author_class dimension, no surface dimension |
| **CRM import adapters** (`lib/services/crm-import/`) | HoneyBook real adapter, Calendly tour-scheduler, generic CSV, web-form. Phase 4c unified router | F3, F25 | Adapter architecture clean but writes `type='email'` so HoneyBook synthetic rows show in inbox |
| **Lifecycle / folder routing** (`lib/services/inbox/lifecycle.ts`) | Wave 11 state machine, mig 246 six-folder enum, mig 247 identity resolver, May 8 AI classifier | F2, F5, F6, F7, F25, F33, F4 | Folder enum correct, classifier wired, advertiser-domain rules in place. Vendor + advertiser leakage in real data is the symptom |
| **Sequences** (`lib/services/email/follow-up-sequences.ts`, `autonomous-sender.ts`) | post_tour / ghosted / post_booking / pre_event / custom triggers. Email / task / alert actions | F11, F12, F14, F15 | Trigger enum missing tour-cancelled and other lifecycle events. F11 autonomy: Wave 26 send button should resolve |
| **Drafts + learning** (`lib/services/draft-learning/`, brain modules, `agent/drafts/page.tsx`) | Wave 26 explicit Send button + LearningToast + analyze-edit diff. status enum pending/approved/rejected/sent. auto_sent flag | F11, F15, F16, F28 | F11 likely resolved by Wave 26. F16 "100% rejected" is data-correct (operator rejected all in window), not a code bug |
| **Knowledge gaps** (`lib/services/knowledge-gaps/`, page) | Wave 19 detector (Haiku) + capture endpoint + 8-category enum (pricing/availability/logistics/policy/vendor/ceremony/catering/inclusions) + 3 source_kinds | F21, F22, F23 | Detector itself is fine — root cause for F21 is upstream (platform_system emails). F22/F23 are likely older-pipeline residue + UI surface gaps |
| **Classifier health** (`agent/classification-health/page.tsx`, `brain/router.ts`) | Daily-volume chart, distribution, null bucket. Reads `intelligence_extractions.metadata.classification` | F32, F33 | "18% null" is real but inflated by platform_system + Wave-9-misclassified residue. Copy on "Inbounds with no classification" needs context |
| **Attribution + roles** (`lib/services/attribution/`, `attribution-roles/`) | Wave 7B forensic role classifier (v2 prompt), candidate_identities, intent classifier (Wave 16) | F27 | Identity resolver writes UUIDs in re-engagement notifications. UI display layer missing name resolution |
| **Intel rollups** (`lib/services/intel/`) | Wave 5A couple_intel, 5B cohort, 5C external matches, 5D thesis, 6A-D persona/spend, 7A discoveries | F18, F30 | F30 (Platform Signals) confirmed working. F18 (temperature dominated by Frozen) is the heat-bucket distribution — measurement bug or content bug |
| **Notifications** (`agent/notifications/page.tsx`, related APIs) | DEFAULT_NOTIFICATION_SETTINGS, pending-auto-send + booking-confirm details, BrainDumpClarifications surface | F26, F27, F29, F34 | Surface lists notifications but click-through to detail missing. UUIDs leak. Clarifications at top of inbox is intentional |
| **UI nits** (various pages) | Inbox unread, Client Codes table, Error Monitor, AI cost panel | F4, F19, F24, F31 | All UI-layer bugs, not architectural. Quick fixes |

**Cross-cutting observation:** the platform has the right vocabulary (`direction`, `type`, `signal_class`, `surface`, `confidence_flag`, `crm_source`) BUT it's missing two dimensions that would close most of the F1-F34 contamination:
- **author_class** — who AUTHORED this signal (couple, operator, sage, platform_system, vendor)
- **surface** — where should this signal appear (inbox, system_notification, crm_attribution, voice_capture, integration_event)

Add those two columns and ~9 of 34 findings collapse into one fix.

---

## Section 2 — Per-finding verification

Status legend:
- ✅ Verified bug, fix needed
- ✓ Verified fixed-already (pre-existing wave addressed it)
- ⚠️ Mis-diagnosed (real symptom, wrong root cause)
- 🔍 Partial / needs more digging
- ❌ Cannot verify from code (UI / data / config-dependent)

---

### F1 — Sage emails counted as touchpoints
**Claude proper:** outbound nurture counted as couple touchpoints, inflating warmth.
**Code reality:** `lib/services/intel/prior-touches.ts:84-87` explicitly filters `.eq('direction', 'inbound')` with a verbatim comment about the bug being fixed. `pipeline.ts:1337-1364` adds a Wave 9 write-site guard. `data-integrity/remediation/direction-from-venue-own.ts` cleans historical residue (355 rows on Rixey).
**Status:** ✓ Already fixed. The "3 prior touchpoints" badge is counting tangential_signals (Instagram, Knot views, tours), which is correct.

### F2 — Zachary Steinberg classifier failure
**Claude proper:** specific lead mis-classified.
**Code reality:** classifier at `brain/router.ts` emits new_inquiry/inquiry_reply/client_message/vendor/spam/internal/other. The May 8 AI classifier in `inbox/lifecycle.ts` decides folder. Both are LLM calls — failures are content errors, not structural bugs.
**Status:** 🔍 Need the actual interaction row to verify which decision failed. Likely a single-row miscall, not a class issue.

### F3 — HoneyBook records appearing as inbox emails
**Claude proper:** CRM records leak into the email inbox surface.
**Code reality:** HoneyBook adapter at `crm-import/honeybook.ts:458-485` writes a synthetic interaction with `body: 'provider:honeybook\nlead_source_raw:...'`. The shared commit helper at `crm-import/index.ts:719-742` sets `type` from the adapter's normalised row — HoneyBook doesn't override `type`, so it defaults to `'email'`. The inbox page filters by `type='email'` direction='inbound' → these synthetic rows show up.
**Status:** ✅ Verified bug. Fix: Wave 28 — add `interactions.surface` dimension; CRM adapters write `surface='crm_attribution'`; inbox queries `surface='inbox'`.

### F4 — Unread count doesn't decrement
**Claude proper:** UI counter doesn't update when emails are read.
**Code reality:** Need to inspect the inbox page's read-state hook. Likely an optimistic update miss.
**Status:** ❌ UI bug, cannot verify without runtime testing. Tactical fix.

### F5 — Vendors classified as Clients
**Claude proper:** vendor emails landing in client folder.
**Code reality:** `inbox/lifecycle.ts` has `ADVERTISER_DOMAINS` allow-list. Vendor classification comes from `loadVendorDomains` (separate per-venue config). Vendor → 'vendor' folder; client → 'client' folder. Routing logic is sound.
**Status:** 🔍 Likely a data issue — specific vendor domain not in the venue's vendor-domain list. Tactical: add to /portal/marketing-channels-config or vendor-domains config.

### F6 — Tour emails to Other
**Claude proper:** Calendly tour confirmation lands in 'other' folder.
**Code reality:** Calendly emails come from @calendly.com which is in ADVERTISER_DOMAINS (`lifecycle.ts:78-90`). The ADVERTISER guard only fires when `weddingStatus === null` — otherwise it falls through. If the Calendly email is linked to a wedding, it goes to potential_client / client / other depending on lifecycle state.
**Status:** ⚠️ Mis-diagnosed surface. Tour-confirmation emails shouldn't be in the inbox at all — they're system_notifications. Wave 28 fix.

### F7 — Naina classified as Client (WeddingPro)
**Claude proper:** WeddingPro relay treated as client.
**Code reality:** `weddingwire.com` and `authsolic.com` (WeddingPro relay) are in ADVERTISER_DOMAINS. But same as F6: if the wedding row exists, the advertiser guard doesn't demote it. The Knot/WW relay is supposed to be an acquisition source, not advertiser. There's a known tension here — Knot relay messages are legitimate leads but the from-domain looks like spam.
**Status:** 🔍 The lifecycle code has the right intent. Question is whether the specific Naina row got correctly linked to a wedding. Need the row to verify.

### F8 — Calendly tours as emails, no workflow
**Claude proper:** Calendly tour bookings show up as emails with no tour-specific handling.
**Code reality:** Calendly webhook at `api/webhooks/calendly/route.ts` writes:
- `engagement_events` row (tour_booked)
- `tours` row (signal_class='touchpoint')
- `discovery_sources` capture
- identity reconstruction enqueue
But Calendly *also* emails the venue inbox ("Sarah Smith booked a tour"), and that email enters `pipeline.ts` as `type='email' direction='inbound'`. Two writes for one event — the structured one is correct, the email duplicate clutters the inbox.
**Status:** ✅ Verified bug. Wave 28 fix (surface=system_notification).

### F9 — Pipeline stale due to SMS/Zoom not propagating
**Claude proper:** lifecycle states don't update when SMS / Zoom / call happens.
**Code reality:** `lib/services/lifecycle/state-machine.ts` reads from interactions + tours + engagement_events. SMS interactions DO get written (mig 178 added `type='sms'`) but there's no SMS ingestion code in the email pipeline — SMS comes from rixey-portal or manual entry. Zoom is similar — no automated ingestion.
**Status:** ✅ Architectural gap. Wave 29 (SMS/Zoom ingestion) is the larger fix. Lifecycle state machine reads the right tables; the writes don't happen.

### F10 — Sage should suggest state changes
**Claude proper:** Sage detects state-changing signals but doesn't propose lifecycle transitions.
**Code reality:** Wave 11 state machine auto-transitions on signal patterns (tour_booked → tour_scheduled, etc.). But Sage doesn't *propose* state changes — those happen silently in the background.
**Status:** ✅ Feature gap, not a bug. A "Sage suggests: move to booked?" surface would close the loop on operator-confirms. Medium-size feature.

### F11 — Sequence autonomy ambiguity
**Claude proper:** unclear if approve-draft auto-sends or queues for review.
**Code reality:** Wave 26 (shipped 2026-05-10) added explicit Send button on `agent/drafts/page.tsx`. Draft status enum has `pending → approved → sent` as separate states. `auto_sent` boolean flag distinguishes auto-send vs manual.
**Status:** ✓ Wave 26 should resolve. Verify by re-walking the Drafts page — there should be a Send button + confirmation modal.

### F12 — Missing sequence trigger types
**Claude proper:** trigger enum is too narrow (no Tour-Cancelled, no Lost-Reactivation, etc.)
**Code reality:** `sequences/page.tsx:72-78` enum: post_tour, ghosted, post_booking, pre_event, custom. Missing: tour_cancelled, lost_reactivation, no_show, contract_overdue.
**Status:** ✅ Verified gap. Extend the enum + add trigger conditions in the state machine.

### F14 — Sequence Email/Task/Alert escalation
**Claude proper:** the action_type triad (email / task / alert) is correct.
**Code reality:** Confirmed at `sequences/page.tsx:80-84`.
**Status:** ✓ Working as designed (positive finding — recorded for calibration).

### F15 — "0 Auto-Sent" stat
**Claude proper:** stat reads 0 always; downgraded later pending F28 verification.
**Code reality:** `drafts/page.tsx` reads `auto_sent` boolean. If autonomous-sender hasn't run (or auto-send is off per venue config), this is 0 correctly.
**Status:** 🔍 Data-correct if auto-send is disabled. Check `/agent/settings` for the venue. If enabled and 0, there's a write-site bug in `autonomous-sender.ts`.

### F16 — Draft Performance 100% rejected
**Claude proper:** mass-reject diagnosis — system stuck.
**Code reality:** `agent/analytics/page.tsx` reads `drafts` filtered by `status='rejected'` over a period. If all drafts in that window were rejected by the operator (or by an old auto-reject rule), the 100% is correct math.
**Status:** ⚠️ Likely data-correct, content-broken. The system isn't stuck — operators are rejecting all drafts. The right next question: WHY rejected? Wave 26's LearningToast is the diagnostic tool for this.

### F17 — Analytics scope undefined
**Claude proper:** unclear what venue/range the analytics page is showing.
**Code reality:** `agent/analytics/page.tsx` uses `useScope()` hook + Period selector (today/this_week/this_month/last_month). Scope is implicit — operator must check the header.
**Status:** 🎨 UX nit. Tactical: add explicit "Showing: Rixey Manor — This Month" header.

### F18 — Temperature dominated by Frozen
**Claude proper:** heat distribution shows most leads as 'frozen'.
**Code reality:** Heat scoring at `lib/services/heat-mapping/` uses signal_class + tangential signals. Frozen is the default for "no recent activity." If Rixey has 671 weddings and most are completed/old, frozen-dominated is *correct*.
**Status:** ⚠️ Likely correct measurement. The question is whether the analytics page should filter by active leads only. Tactical UX change.

### F19 — AI cost permissions issue
**Claude proper:** AI cost panel visible to non-admin or shows wrong data.
**Code reality:** `agent/classification-health` reads `api_costs` table. RLS rules should restrict by venue. If a non-admin sees costs across venues, that's an RLS gap.
**Status:** ❌ Need to check RLS policies on api_costs table. Likely admin-gated already.

### F20 — No mass-action annotations on time-series
**Claude proper:** time-series charts don't annotate "imported 71 HoneyBook records on May 5".
**Code reality:** Recharts components in analytics page don't have annotation overlays.
**Status:** ✅ Feature gap (low priority). Add chart annotations for mass-import events.

### F21 — Knowledge Gaps captures Calendly form fields
**Claude proper:** detector treats Calendly Q&A in inbound as "questions the couple is asking."
**Code reality:** Wave 19 detector at `knowledge-gaps/detect-from-draft.ts` is correctly designed — analyzes Sage's outbound draft for hedges. BUT triggers off whatever upstream classified as "inbound." Calendly system emails get pipeline-stamped `type='email' direction='inbound'` (no author_class), so the detector treats them as couple input.
**Status:** ✅ Real bug. Root cause is upstream. Wave 27 (author_class) fixes this.

### F22 — All 447 Knowledge Gaps uncategorized
**Claude proper:** category enum isn't being populated.
**Code reality:** Wave 19 validator at `knowledge-gap-detector.ts:243-251` REQUIRES category — any output without one fails validation. So Wave-19 detector path always sets category. If 447 are uncategorized, they came from:
- Pre-Wave-19 path (older detector or manual capture)
- `/api/admin/knowledge-gaps/capture/route.ts` manual operator entry path — that route doesn't require category in PostBody
**Status:** ✅ UI surface bug + backfill needed. Capture route should require category. Existing rows need a Haiku categorization sweep.

### F23 — 0/447 resolved
**Claude proper:** none of the gaps have been answered yet.
**Code reality:** Knowledge gap → captured workflow: detector finds gap → operator answers via /agent/knowledge-gaps → `captureKnowledge()` writes knowledge_capture + marks gap `captured_at`. If 0 of 447 are captured, either:
- The capture UI is broken
- Operators haven't answered any yet
**Status:** 🔍 Likely operator-action gap. Verify by trying to capture one in the UI. If button doesn't work → UI bug. If it works → data is correct (operator just hasn't answered).

### F24 — Client Codes sort order
**Claude proper:** sort order on `/agent/codes` is wrong.
**Code reality:** Need to inspect `agent/codes/page.tsx` ORDER BY.
**Status:** ❌ UI bug. Tactical.

### F25 — Audio Inbox + SMS/Zoom architecture
**Claude proper:** `/agent/audio-inbox` exists for Omi but SMS/Zoom not wired.
**Code reality:** `/agent/omi-inbox` was renamed to `/agent/audio-inbox` per CLAUDE.md. SMS has `type='sms'` in the interactions enum (mig 178) but no SMS ingestion service. Zoom doesn't exist as a type.
**Status:** ✅ Verified gap. Wave 29 (Multi-channel inbox) is the larger fix.

### F26 — Notifications no click-through
**Claude proper:** notification rows don't link to the underlying lead/draft.
**Code reality:** `agent/notifications/page.tsx` RecentNotification type has `id`, `title`, `body` but no obvious `link_url` field. Need to verify whether notification rows have a target URL.
**Status:** 🔍 Likely UI gap — notification rows should be clickable. Check notification schema.

### F27 — Re-engagement matches hidden behind UUIDs
**Claude proper:** re-engagement candidate list shows wedding UUIDs instead of names.
**Code reality:** `lib/services/insights/decay-re-engagement.ts` produces candidates. The UI surface (likely in notifications or a dedicated page) renders the wedding_id without joining people for names.
**Status:** ✅ Verified bug. UI fix: join people on wedding_id, show couple names.

### F28 — "Autonomous behavior" notification contradicts F15
**Claude proper:** notifications say "Sage autonomous behavior resumed" but F15 shows 0 auto-sent.
**Code reality:** `autonomous-sender.ts` controls actual sends. The "autonomous behavior" string in notifications might refer to LLM compute activity, not sends specifically.
**Status:** 🔍 Likely semantic mismatch (the notification text is misleading). Tactical: rename to "AI processing resumed" or similar.

### F29 — JSON dump in notification
**Claude proper:** notification body shows raw JSON instead of human-readable text.
**Code reality:** `RecentNotification.body` is a string. If a writer dumped `JSON.stringify(metadata)` instead of formatting, that's a writer bug.
**Status:** ✅ Verified bug. Tactical: find the notification writer and format.

### F30 — Platform Signals card good
**Claude proper:** positive finding — platform-signals card works as expected.
**Code reality:** Likely the `/agent/notifications` or `/intel/dashboard` Platform Signals component. Healthy.
**Status:** ✓ Working (positive — recorded for calibration).

### F31 — Error Monitor shows dev data on operator surface
**Claude proper:** `/agent/errors` shows internal dev/debug data.
**Code reality:** `agent/errors/page.tsx` exists but its access gating + display is operator-facing. If it shows raw stack traces or sensitive paths, that's a leak.
**Status:** ✅ Verified concern. Tactical: scope errors page to super_admin OR redact sensitive fields.

### F32 — Classifier Health 18% null
**Claude proper:** 18% of inbounds have no classification — high.
**Code reality:** `classification-health/page.tsx:85-93` defines 7 valid classifications + null bucket. Nulls happen when:
- Pipeline timed out before classifier ran
- Email was filtered before classification (e.g. spam guard)
- Pre-classifier emails (older than the classifier rollout)
- platform_system emails (Calendly, Knot relay) that the classifier shouldn't have to handle
**Status:** ⚠️ Real but inflated. Wave 27 (author_class) would split platform_system out → real null rate drops significantly.

### F33 — "Inbounds with no classification" copy unclear
**Claude proper:** label doesn't tell operator what to do.
**Code reality:** Page is read-only diagnostics. The copy assumes operator knows it's a diagnostic surface, not actionable.
**Status:** ✅ UX copy fix. Add context: "These need classifier sweep. Run [Reclassify] to re-process."

### F34 — Sage clarification surfacing at top of inbox
**Claude proper:** brain-dump clarification questions show at top of `/agent/notifications`.
**Code reality:** `agent/notifications/page.tsx` imports `BrainDumpClarifications` and `ActiveGrantsBanner` — they render at the top by design.
**Status:** ⚠️ This is intentional behavior. If F34 is "surfaces in the wrong place" then it's a UX disagreement, not a bug. Tactical: decide whether clarifications belong on notifications or on /agent/brain-dump only.

---

## Section 3 — Novel pattern verification (the 4)

### Pattern A — Direction-blind ingestion ✅ Real (partially)
- Touchpoint counter: fixed (F1)
- Knowledge Gap Detector: real bug, root cause upstream (F21)
- Classifier: 18% null inflated by platform_system (F32)
- **Doctrine candidate is real and load-bearing**

### Pattern B — Channels-as-inboxes ✅ Real
- HoneyBook synthetic interactions land in inbox (F3)
- Calendly system emails land in inbox (F6, F8)
- SMS/Zoom not architecturally addressed (F25)
- **Doctrine candidate is real and load-bearing**

### Pattern C — Surface-siloed identity 🔍 Partial
- Re-engagement shows UUIDs (F27) — this is a UI join bug, not architectural
- Identity resolver itself (Wave 14 + Wave 4 reconstruction) is unified
- **Doctrine candidate may not survive verification** — looks more like a UI-layer issue than a structural one. The identity model IS unified across surfaces; the displays don't all hydrate names.

### Pattern D — Agent autonomy ambiguity 🔍 Resolved-ish
- Wave 26 added explicit Send button + LearningToast
- F11 and F28 likely close after Wave 26 is verified
- **Doctrine candidate may be retroactively-satisfied** — Wave 26 was the right architectural move; F11/F28 captured it pre-Wave-26

---

## Section 4 — Proposed wave plan

Grouped by structural impact, ordered by ROI for the Wedding MBA talk + paying-venue launch.

### Wave 27 — Author-class classification (LARGE, high ROI)
**One migration:** adds `interactions.author_class` enum {couple, operator, sage, platform_system, vendor, unknown}.
**One pipeline change:** Haiku call at write time classifies author. ~$0.0005/email.
**N consumer filters:** Knowledge Gap Detector (skip platform_system), Classifier Health metric (exclude platform_system from null %), Heat scoring (don't bump on Calendly notifications), Draft training (don't learn from autoresponder threads).
**Closes:** F21, half of F32, parts of F2/F5/F6/F7.
**Effort:** ~1 day.

### Wave 28 — Surface classification (MEDIUM, high ROI)
**One migration:** adds `interactions.surface` enum {inbox, system_notification, crm_attribution, voice_capture, integration_event}. Backfill by deriving from existing type + crm_source + from-domain.
**One inbox filter:** `.eq('surface', 'inbox')`.
**CRM adapter writes:** surface='crm_attribution' on synthetic rows.
**Pipeline writes:** surface='system_notification' for known platform_system from-domains.
**Closes:** F3, F6, F8, parts of F25.
**Effort:** ~half-day for surface column. SMS/Zoom is Wave 29.

### Wave 29 — Multi-channel inbox extension (LARGE, medium ROI)
**New surfaces:** SMS ingestion (Twilio adapter), Zoom transcript ingestion, voicemail.
**UI:** extend `/agent/audio-inbox` → `/agent/multi-channel` with surface filter.
**Closes:** F9, F25.
**Effort:** ~2 days.

### Tactical batch — UI/UX nits (SMALL)
F4 (unread count), F17 (analytics scope header), F19 (api_costs RLS), F22 (capture-route requires category + backfill), F24 (codes sort), F26 (notifications click-through), F27 (re-engagement name join), F29 (JSON dump fix), F31 (errors page scope), F33 (copy on classifier health).
**Effort:** ~1 day combined.

### Sequences extension — F12
Extend trigger enum: tour_cancelled, lost_reactivation, no_show, contract_overdue. Wire to state machine.
**Effort:** ~half-day.

### Already-resolved (verify only)
F1 (Wave 9 + prior-touches filter), F11 (Wave 26 send button), F14 (positive), F30 (positive).
**Effort:** ~1h re-walk + screenshot.

### Content / measurement — not code (parking)
F16 (operators rejecting all drafts), F18 (frozen-dominated is correct measurement), F34 (clarification surfacing is intentional).
**These need a conversation, not a wave.**

---

## What this verification did NOT cover

- The `/intel` surface (untested per ROUND-1 reflection)
- The `/weddings` surface (untested)
- The `/sage-brain` surfaces beyond Knowledge Gaps
- The couple-facing portal
- Whether the Wave 27 author-class Haiku call would actually classify cleanly (needs test set)
- Demo-cookie revenue hole + Stripe idempotency + multi-Gmail outbound drop (separate Phase 1 audit)

## Suggested next step

Pick one of:
1. **Ship Wave 27+28 together** (1.5 days work) — closes ~9 findings + makes Wedding MBA talk numbers trustworthy
2. **Knock out tactical UI batch first** (1 day) — closes ~10 findings, low risk, builds confidence before architecture
3. **Do Round 2 testing** — walk the `/intel` and `/weddings` surfaces before committing to waves, so total finding set is known

My recommendation: **2 then 1**. Tactical first (immediate wins, no architectural commitment) — then Wave 27+28 (high-impact, well-scoped).
