# Verification — The Two Big Architectural Things

Companion to `BLOOM-TEST-FINDINGS.md` (Round 1 walkthrough by Isadora + Claude proper).
Date: 2026-05-11.
Method: critical verification against actual code in `C:\Users\Ismar\bloom-house\src`.

This document addresses ONLY the two architectural patterns that crosscut the most findings.
The other 32 individual findings are deferred to a follow-up verification.

---

## Big Thing #1 — Direction-blind ingestion (Novel Pattern A)

### Claude proper's diagnosis (recap)
The whole stack treats inbound and outbound as the same shape. Cited findings:
- **F1** — "3 prior touchpoints" badge counts Sage's outbound nurture as couple touchpoints
- **F21** — Knowledge Gaps captures operator's Calendly Q&A fields as "questions the couple is asking"
- Plus inferred contamination of training signals, classifier, and draft performance metrics

### Code reality

**F1 — already fixed, diagnosis is wrong.**

`src/lib/services/intel/prior-touches.ts:77-87` explicitly filters `direction='inbound'`:
```ts
// Prior interactions (excluding today's — the caller is usually the
// inquiry that triggered the lookup). Restricted to direction =
// 'inbound' so the count represents times the LEAD touched us, not
// times we sent them a nurture email. A 12-step Sage sequence going
// out had been counted as 12 touchpoints, which made every cold
// followup look like a hot lead.
.eq('direction', 'inbound')
```

The comment is verbatim the bug Claude proper diagnosed. It was already fixed (matches the `feedback_inbox_lifecycle_inbound_only.md` memory from 2026-05-08). The "3 prior touchpoints" badge Isadora saw on real leads is correct — it's counting tangential_signals (Instagram, Knot views) + inbound interactions + tours. Not Sage's outbound.

**Confidence:** high. The chip's batch fetcher `useBatchPartnerCounts` and the service it calls both filter inbound.

**Wave 9 — already fixed at the write site too.**

`src/lib/services/email/pipeline.ts:1337-1364` adds a second guard: even if upstream marks something inbound, if the final `from_email` is in `venueOwnEmails`, it flips to outbound BEFORE persisting. Plus `src/lib/services/data-integrity/remediation/direction-from-venue-own.ts` cleans historical residue (355 rows on Rixey were flipped).

**F21 — diagnosis is half right. Root cause is upstream, not in the detector.**

`src/lib/services/knowledge-gaps/detect-from-draft.ts:70-104` is designed to read Sage's outbound draft for hedges. The "inbound" is paired with the draft. The detector itself is fine.

What's NOT fine: WHAT counts as "the inbound." The pipeline at `pipeline.ts:1317-1335` classifies inbound `signal_class` by from-domain:
- `theknot.com` → source
- `calendly.com` → touchpoint
- `honeybook.com` → crm

But that's signal_class for ATTRIBUTION. It doesn't change `direction` or `type`. A Calendly system email ("Tour scheduled — Sarah Smith") still enters as `type='email'` `direction='inbound'`. Sage's brain reads that email, generates a draft ("I'll need to check what time works for the venue tour"), the detector reads:
- inbound_body = Calendly's system message with form Q&A
- draft_body = Sage's hedged reply
- Output: "Sarah is asking about timing" → captured as a knowledge gap

The couple never asked anything. It was Calendly's auto-notification.

**Where the fix needs to go:**

Three layers, deepest first:

1. **Pipeline classifier (root):** `pipeline.ts` line ~1320 needs a third dimension besides `direction` and `signal_class`: **author_class** ∈ `{couple, operator, sage, platform_system, vendor, unknown}`. Calendly notifications, Knot lead alerts, HoneyBook system emails, autoresponders, OOO replies are all `platform_system`. They enter direction=inbound (they ARE inbound to the venue's inbox) but author_class=platform_system, so downstream consumers can skip them.

2. **Knowledge Gap Detector:** filter `author_class IN ('couple', 'vendor')` before running. Skip platform_system entirely.

3. **Same author_class gate** for: draft training (don't learn from autoresponder threads), classifier health metrics (don't count system emails in the 18% null), heat scoring (Calendly notifications shouldn't bump warmth).

### Recommendation

Open a Wave for it. Call it Wave 27 — Author-class classification. ONE migration adds `interactions.author_class` enum + backfill. ONE pipeline change classifies at write time using a small Haiku call ("is this email from a person OR an automated system?"). N consumer changes filter on it where direction-blindness matters.

**Cost:** ~1 day. ~$2 on Rixey backfill. ~$0.0005 per future email.

**Why it's worth it now:** The Wedding MBA talk will quote knowledge_gaps stats (Wave 19). If those numbers are inflated by Calendly form questions appearing as gaps, the talk's credibility is at risk.

---

## Big Thing #2 — Channels-as-inboxes (Novel Pattern B)

### Claude proper's diagnosis (recap)
HoneyBook CSV rows, Calendly forms, and audio transcripts enter the system through the email pipeline as if they were emails. Cited findings:
- **F3** — HoneyBook records appearing as inbox emails
- **F8** — Calendly tours as emails, no workflow
- **F25** — Audio Inbox needs SMS/Zoom architecture

### Code reality

**CRM adapter architecture is actually clean.**

`src/lib/services/crm-import/index.ts:182-208` defines `NormalisedInteractionRow` with `type: 'email' | 'call' | 'voicemail' | 'sms' | 'meeting' | 'web_form'`. HoneyBook adapter (`honeybook.ts:458-485`) writes a synthetic interaction:
```ts
body: `provider:honeybook\nlead_source_raw:${sourceRaw ?? '(empty)'}`,
extracted_identity: { provider: 'honeybook', hear_source_raw, hear_source }
signal_class: 'source' or 'crm'
```

It doesn't write the body as if it were an email from the couple. Architecturally separate.

**But two real problems exist:**

**Problem 2a — HoneyBook synthetic interactions get `type='email'` by default.**

Check `crm-import/index.ts:720-742` — interactions are inserted with `type: i.type` from the adapter's normalised row. If the HoneyBook adapter doesn't set `type` (it doesn't in the snippet above — it sets `direction`, `signal_class`, `body`, `extracted_identity` but NOT type), the field is undefined and the DB's CHECK constraint may default it to 'email' (need to verify the migration).

The inbox page filters by `type='email'`, so a HoneyBook synthetic source-attribution row shows up in /agent/inbox as if it were a real email. This is F3.

**Problem 2b — Calendly system emails enter the email pipeline as type='email'.**

When Calendly emails the operator ("Sarah Smith booked a tour"), the pipeline at `pipeline.ts:1365-1370` writes:
```ts
type: 'email',
direction: 'inbound',
```

It uses `signal_class='touchpoint'` to mark them, but the inbox page doesn't filter by signal_class — only by type+direction. So Calendly emails clutter the inbox alongside real couple emails. This is F8.

**Problem 2c — Audio Inbox separation has been started but is incomplete.**

`/agent/audio-inbox` exists for Omi transcripts (per CLAUDE.md). But SMS doesn't go through it — SMS interactions get `type='sms'` and live in the same interactions table. Zoom transcripts don't exist as a type yet. F25 is correctly identifying that the audio-inbox model is right but needs to extend to SMS/Zoom/voicemail.

### Where the fix needs to go

The architectural rule is: **inbox = couple-facing email thread**. Anything else that looks like an email but isn't a couple-to-venue conversation needs a different surface.

Three changes:

1. **Add `interactions.surface` enum:** `{inbox, system_notification, crm_attribution, voice_capture, sms_thread, integration_event}`. Set at write time by pipeline + each adapter. Inbox page filters `surface='inbox'`.

2. **HoneyBook + Dubsado + Aisle Planner synthetic interactions:** `surface='crm_attribution'`. They surface on the lead detail page's source-attribution panel, not in /agent/inbox.

3. **Calendly system emails:** detect by from-domain (`calendly.com`, `acuityscheduling.com`, `theknot.com` for lead notifications, `honeybook.com` for HoneyBook auto-replies). Set `surface='system_notification'`. They surface on a new `/agent/system-feed` page or are folded into the lead detail's timeline, NOT in the main inbox.

4. **SMS + Zoom + voicemail:** extend `/agent/audio-inbox` to `/agent/multi-channel-inbox` with surface filtering. Or keep three separate surfaces if that maps better to operator workflow.

### Recommendation

Wave 28 — Surface classification. ONE migration adds `surface` enum + backfill by deriving from existing `type` + `crm_source` + from-domain. Inbox query gets `.eq('surface', 'inbox')`. New routing.

**Cost:** ~half-day for the migration + inbox filter. SMS/Zoom architecture is a separate, larger wave (call it Wave 29 — Multi-channel inbox).

**Why it's worth it now:** F8 specifically — every Calendly tour-confirmation showing in the operator's inbox is friction. The operator processes them as if they need a reply. They don't. The 6-folder inbox lifecycle (mig 246) won't help here because all six folders still show Calendly notifications.

---

## Cross-cutting observation

Both Big Things share a structural shape: **Bloom currently has TWO dimensions on interactions (`type`, `direction`) when three are needed:**

1. **type** — what shape is this signal? (email, sms, meeting, web_form)
2. **direction** — who sent it? (inbound to venue, outbound from venue)
3. **author_class** — who AUTHORED it? (couple, operator, sage, platform_system, vendor)
4. **surface** — where should it appear? (inbox, system_notification, crm_attribution, ...)

Adding the two missing dimensions (#3 and #4) unblocks both architectural patterns at once.

If you want to bundle: **Wave 27+28 combined** could ship as one migration adding both columns, one pipeline change classifying at write time, two consumer changes (Knowledge Gap Detector filter + Inbox filter). ~1.5 days of work. Closes both Novel patterns plus several individual findings.

---

## What this verification does NOT cover

- The other 32 individual findings (F2, F4-F7, F9-F20, F22-F34) — separate verification pass needed
- The two SMALLER Novel patterns (Surface-siloed identity, Agent autonomy ambiguity) — separate verification
- Whether existing knowledge_gaps rows on Rixey are contaminated (need a SQL query against `knowledge_gaps.captured_at`)

## Suggested next step

Ship Wave 27+28 bundled as **Wave 27 — Author + Surface classification**. After it lands:
- Re-test F21 (Calendly form fields as gaps) — should disappear
- Re-test F3 / F8 (HoneyBook + Calendly in inbox) — should disappear
- Re-count the 18% null classification (F32) — should drop because system emails were inflating it
- Wedding MBA talk's knowledge_gaps stats become trustworthy
