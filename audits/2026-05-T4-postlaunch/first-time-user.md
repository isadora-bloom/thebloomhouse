# Bloom T0-T4 Audit — Character 2: The First-Time User

Date: 2026-05-02
Venue persona: Hawthorn Hall (60 couples/year, upstate NY)
Scope: Cold-start, white-label leaks, onboarding promise vs reality

## Summary

A fresh-signup coordinator at Hawthorn Hall encounters a Day-1 experience riddled with white-label leakage: the literal string "Sage" appears in roughly 60+ user-facing places where the venue's `ai_name` should be substituted, and the personality engine's seed-data-driven default is `'Sage'` + `sage@hawthornemanor.com`. Cold-start empty states are, generally, honest in the obvious places (inbox, leads, sage queue, voice DNA hero) but the Voice DNA dimensions block fakes a "Friendly 7/10" scorecard for venues with literally zero phrases or training, and the personality preview / personality settings show "Sage" placeholders. The 5-day onboarding project is solid in intent but Days 1, 4 and 5 punt their "actual work" to other surfaces with the parenthetical "(Programmatic trigger landing as part of the T2-A follow-up...)" — meaning a coordinator marking steps complete is largely doing busywork. The B-39 confidence_flag column exists in the DB on five tables and is **never displayed in any UI surface**.

Severity counts: 4 CRITICAL, 11 HIGH, 6 MEDIUM, 3 LOW.

## Findings

### CRITICAL 1. Personality engine default name + email is literally "Sage" / "sage@hawthornemanor.com"
**Surface:** AI prompt assembly used by every brain (`src/lib/ai/personality-builder.ts:136-159`)
**Playbook reference:** INV-4.4-A / Anti-Pattern 6 / Part 7 white-label
**What this proves:** The single shared `DEFAULT_PERSONALITY` constant ships `ai_name: 'Sage'` and **`ai_email: 'sage@hawthornemanor.com'`**. `buildPersonalityPrompt()` spreads `{ ...DEFAULT_PERSONALITY, ...data.config }`, so any venue that hasn't filled every field (and there's no enforcement that they do — Day-1 onboarding only collects `ai_name`, not `ai_email`) inherits these. Lines 196 + 206 then read `aiName = config.ai_name ?? 'Sage'` again as a belt-and-suspenders fallback. Result: Hawthorn Hall's personality prompt to Claude says **"You are Sage. Your email address is: sage@hawthornemanor.com"** unless the coordinator manually wired both.
**Would experience this as:** "I named my AI 'Hawthorn' in onboarding. Why does the test draft sign off as 'sage@hawthornemanor.com'?"

### CRITICAL 2. Couple portal dev fallback is hardcoded to 'hawthorne-manor'
**Surface:** `src/app/_couple-pages/layout.tsx:18`
**Playbook reference:** Anti-Pattern 6
**What this proves:** `resolveVenueSlug()` returns the literal string `'hawthorne-manor'` when neither the `venue-slug` cookie nor the URL param resolves. In any non-prod environment (and any prod environment hitting the bare `/couple/...` path without subdomain), every couple lands on whatever venue happens to use that slug. Hawthorn Hall couples will see Hawthorne Manor's branding/data.
**Would experience this as:** "I sent my couple a portal link in dev/staging and they got a different venue's dashboard."

### CRITICAL 3. confidence_flag (B-39) stored but invisible everywhere
**Surface:** Schema in `supabase/migrations/137_confidence_flags.sql` (5 tables); zero readers.
**Playbook reference:** T2-A B-39
**What this proves:** Migration 137 adds `confidence_flag` to weddings/people/interactions/engagement_events/marketing_spend with values `live | imported_high | imported_medium | imported_low | manual`. Grep across `src/components/**` and `src/app/**` for `confidence_flag|imported_low|imported_high` returns zero hits. The /agent/leads table (`src/app/(platform)/agent/leads/page.tsx:330-348`) doesn't select it; the lead-detail panels don't render it; the inbox doesn't badge "imported" interactions; the analytics anomaly detector doesn't down-weight them. The Day-1 onboarding-project step at `src/lib/services/onboarding-project.ts:78` literally tells the coordinator "Pull the last 12 months of inquiry messages, classify, and stamp confidence_flag=imported_low so downstream surfaces know these are backfilled" — but no downstream surface actually knows.
**Would experience this as:** "Day 1 promised that backfilled emails would be marked differently from live ones. I can't tell the difference anywhere."

### CRITICAL 4. sage-brain.ts injects literal "Sage:" into the conversation transcript fed back to Claude
**Surface:** `src/lib/services/sage-brain.ts:416`
**Playbook reference:** INV-4.4-A
**What this proves:** `messages = conversationHistory.map((msg) => '${msg.role === "user" ? "Couple" : "Sage"}: ${msg.content}')`. So even if Hawthorn Hall renamed their AI to "Hawthorn", the model sees `Sage: <previous answer>` for every prior assistant turn. The system prompt says "you are Hawthorn", the conversation history says "Sage: ...". The model follows whichever it picks; either way the white-label promise is a lie at the prompt level.
**Would experience this as:** "On the third reply, the AI started referring to itself as Sage. I never typed that name anywhere."

### HIGH 5. /sage page (Sage's Brain mode landing) is brand-locked
**Surface:** `src/app/(platform)/sage/page.tsx:18-21`
**Playbook reference:** AP-6
**What this proves:** Three hardcoded "Sage" references in user-visible h1/p copy: `<h1>Sage's Brain</h1>` and `Everything that shapes how Sage talks, what Sage knows, and how Sage behaves`. This is the landing page when the coordinator clicks the "Sage's Brain" mode in the top nav. No `ai_name` lookup. Same for the mode label in `src/components/shell/nav-config.ts:292`: `label: "Sage's Brain"`.
**Would experience this as:** "I named my AI 'Hawthorn' but the entire mode in the nav is 'Sage's Brain' and the landing says 'Everything that shapes how Sage talks'."

### HIGH 6. Sage Queue page hardcodes "Sage" in title, body, empty state, and error copy
**Surface:** `src/app/(platform)/portal/sage-queue/page.tsx:181, 407, 415, 447`
**Playbook reference:** AP-6
**What this proves:** Page title `<h1>Sage Queue</h1>`. Helper text `Questions Sage wasn't confident enough to answer on her own ... so she learns for next time` (gendered too). Empty state `When Sage encounters a question it can't answer confidently, it will appear here`. Per-card label `Sage's Uncertain Answer`. Zero references to `venue_ai_config.ai_name`. Plus the nav label is `Sage Queue` (`nav-config.ts:183`).
**Would experience this as:** "Every escalation card refers to my AI as 'Sage' even though I named it 'Hawthorn'."

### HIGH 7. Settings → Personality preview block hardcodes "Sage"
**Surface:** `src/app/(platform)/settings/personality/page.tsx:224, 429, 638, 720`
**Playbook reference:** AP-6
**What this proves:** Line 224 `const name = config.ai_name || 'Sage'` is fine. But the placeholder on the input (line 429) is literal `placeholder="Sage"`, the hint text (line 638) `Default greeting. Sage will also use the client's first name when available...` is hardcoded, and the preview line 720 `<span>{config.ai_name || 'Sage'} {config.ai_emoji || ''}</span>` falls back to "Sage" rather than to the venue name. So a fresh venue's personality preview literally says "Sage" with no edit.
**Would experience this as:** "The placeholder in the AI name field is 'Sage' so I can't tell whether 'Sage' is my data or the placeholder."

### HIGH 8. Voice DNA dimensions card shows fake "Friendly 7/10" for a brand-new venue
**Surface:** `src/app/api/intel/voice-dna/route.ts:219-225` + `src/app/(platform)/intel/voice-dna/page.tsx:336-377` (gate) and lines 404-419 (dimensions render)
**Playbook reference:** Cold-start honesty / B-42
**What this proves:** The hero gate at `intel/voice-dna/page.tsx:329-377` correctly shows "{aiName} hasn't collected enough of your voice yet" when `sampleCount + trainingSessionCount + editPairs + phrasesByTheme + marketingByTheme === 0`. BUT the API route always returns hardcoded defaults `warmth: 7, formality: 4, playfulness: 5, brevity: 6, enthusiasm: 6` (lines 219-225) when `venue_ai_config` is empty. If the page DID render dimensions for a venue with 0 phrases (e.g., the empty-state condition fails by 1 row of data — say one approved phrase exists), the dimensions block would show "Warmth: Friendly 7/10" + "Formality: Casual 4/10" with no marker that those numbers are unmeasured defaults rather than learned values. The same defaults are imported into `personality-builder.ts:218-224` and labelled to Claude as "Tone: friendly and approachable, casual and relaxed" — a false claim about the venue's voice.
**Would experience this as:** "Voice DNA is showing precise scores like 'Warmth 7/10 — Friendly' but I haven't taught it anything yet."

### HIGH 9. Sage Identity settings page hardcodes "Sage" in headers and helper text
**Surface:** `src/app/(platform)/settings/sage-identity/page.tsx:197-209, 260, 303, 359, 419`
**Playbook reference:** AP-6
**What this proves:** This page lets you rename the AI but its OWN h1 is `<h1>Sage Identity</h1>` (line 206), the loading text is `Loading Sage identity…` (line 197), the section headers (260, 303) say `What Sage is here for`, `The structural pattern of Sage's first message`, and the gendered pronoun appears at line 208 `How Sage introduces herself`. Coordinator at Hawthorn Hall arrives to rename their AI and the page is plastered with the name they're trying to change.
**Would experience this as:** "I'm on the page where I'm supposed to rename my AI, and the page itself is called 'Sage Identity'."

### HIGH 10. Day 1 onboarding-project punts every step to other surfaces
**Surface:** `src/lib/services/onboarding-project.ts:78, 103, 119, 144, 178`
**Playbook reference:** T2-A Part 18 / Promise vs reality
**What this proves:** Five out of seven steps in Days 1–5 carry parenthetical disclaimers:
  - Day 1 backfill (line 78): "(Programmatic trigger landing as part of the T2-A follow-up; coordinator runs the legacy backfill button on the Gmail settings page for now.)"
  - Day 2 pricing (line 103): "calculator-config or tier-restructure changes need manual entry until the coordinator UI lands"
  - Day 3 CRM (line 119): "Adapter templates handle HoneyBook / Dubsado / Aisle Planner — coming as part of the T2-A follow-up; until they land, use the existing CSV importer."
  - Day 4 Voice DNA (line 144): "Bulk extraction trigger landing in T2-A follow-up; for now use the existing voice training games to seed."
  - Day 5 readiness gate (line 178): "Library-side runner landing in T2-A follow-up; for now run scripts/onboarding-readiness.ts manually and paste the verdict into a coordinator note."

The page is therefore a project tracker for work the platform doesn't actually orchestrate yet. Coordinator marks steps "Mark done" at `src/app/(platform)/onboarding/project/page.tsx:478-486` purely as confirmation; nothing is actually connected. Worse: `activateLive()` then enforces `MIN_BACKFILL_SCORE_FOR_PAID = 80` (`onboarding-project.ts:375, 415`) which can't be met without those broken auto-triggers — so a paid venue genuinely can't Go Live without running CLI scripts.
**Would experience this as:** "Day 5 told me to run a CLI script and paste the verdict into a note. I'm not technical."

### HIGH 11. inquiry-brain falls back to "Sage" in two separate places, plus signoff
**Surface:** `src/lib/services/inquiry-brain.ts:166, 169, 375, 604`
**Playbook reference:** INV-4.4-A
**What this proves:** Line 166: `aiName = (aiConfig.ai_name as string) ?? 'Sage'`. Line 169 then builds the email signoff: `signoff = `${aiEmoji ? aiEmoji + ' ' : ''}${aiName}\n${venueName}`` — so a venue whose `venue_ai_config` row is missing or whose `ai_name` is null literally signs every outbound email "Sage / Hawthorn Hall". The same fallback repeats at line 375 inside the prompt building and at line 604 in the client-brain path. Each is a separate lever; if one is forgotten in a refactor the leak comes back.
**Would experience this as:** "My inquiry replies are signed 'Sage' with my venue name underneath, even though I never said yes to that name."

### HIGH 12. Onboarding `/setup` does NOT create a venue_ai_config row
**Surface:** `src/app/(platform)/setup/page.tsx:243-313` (createVenue)
**Playbook reference:** Onboarding contract
**What this proves:** `createVenue()` inserts into `venues` and `venue_config` (lines 244, 266). It never inserts into `venue_ai_config`. The DB DEFAULTs (`migrations/001_shared_tables.sql:63`) then materialise `ai_name = 'Sage'` and `ai_email = NULL` the first time anything UPSERTs the row. Combined with finding #1, between hitting `/setup` and finishing the 15-min wizard at `/onboarding`, every brain that fires (inquiry-brain, sage-brain, post-tour-brief) reads `ai_name = NULL` from the missing row → falls back to literal `'Sage'`. Any inbound email that lands during onboarding gets a draft signed "Sage".
**Would experience this as:** "An inquiry came in 5 minutes after I created my account. The draft is signed 'Sage'."

### HIGH 13. Couple-portal contracts page hardcodes "Sage" in CTA + system message text
**Surface:** `src/app/_couple-pages/contracts/page.tsx:150, 157, 337, 624, 870` plus the `Ask Sage` button label is from couple-top-bar but the cards on this page reference "Ask Sage" via `onAskSage` prop
**Playbook reference:** AP-6
**What this proves:** The page passes `aiName` through the prop (line 159 `aiName: string`) but the card's button handler is wired to a function literally named `handleAskSage` (line 624) and the inline log is `console.error('Sage chat error', err)`. The visible CTA label uses `aiName` correctly when rendered (couple-top-bar.tsx line 108: `Ask {aiName}`), but the legacy contracts CTA at line 337 `onClick={() => onAskSage(contract.id)}` produces a button whose text is dynamic but the comment trail and developer signal still calls it "Sage". Combined with the chat page (`src/app/_couple-pages/chat/page.tsx:482` `console.error('Sage chat error:', err)`) and lines 668, 736, 779 (Sage avatar / Confidence indicator for Sage messages / shown after Sage responses) — the couples whose venue renamed see error messages and screen-reader labels referring to "Sage".
**Would experience this as:** "My couple's screen reader read out 'Sage avatar' when looking at messages from Hawthorn."

### HIGH 14. Onboarding `15-min` wizard does NOT collect ai_email or owner email
**Surface:** `src/app/(platform)/onboarding/page.tsx:39-64` (VenueBasics interface), then save logic at lines 565-618
**Playbook reference:** Part 7 white-label
**What this proves:** The wizard captures `ai_name` (good), `venue_prefix`, `max_events_per_day`, `ad_platforms`. It never captures `ai_email`. So even after a complete onboarding, the personality prompt (finding #1) still includes the literal `'sage@hawthornemanor.com'` from the DEFAULT_PERSONALITY constant when downstream code spreads defaults — or `''` when no spread happens. Either way, a venue that wants `hawthorn@hawthornhall.com` to be the from-address has no UI to set it during onboarding. Migration 090 (`090_venue_config_automation_emails.sql`) added the column but the wizard skipped it.
**Would experience this as:** "I have no idea what email address Hawthorn will send from. There's no field for it in setup."

### HIGH 15. Knowledge-gaps page hardcodes "Sage couldn't confidently answer" copy
**Surface:** `src/app/(platform)/agent/knowledge-gaps/page.tsx:337, 487`
**Playbook reference:** AP-6
**What this proves:** Page subtitle (337): `Questions that Sage couldn't confidently answer. Resolve each gap by adding the correct answer — it gets saved to your Knowledge Base so Sage never misses it again.` Empty state (487): `When Sage encounters questions it cannot answer, they appear here for resolution.` Same pattern in /agent/forbidden-topics:135 (`Sage chat. A match skips automation`) and /agent/notifications:92, 862. None resolve `ai_name`.
**Would experience this as:** "Every page that's supposed to be about my AI calls it Sage."

### MEDIUM 16. /agent/learning bottom panels hardcode "What Sage Has Learned" header
**Surface:** `src/app/(platform)/agent/learning/page.tsx:546, 1047, 1104`
**Playbook reference:** AP-6
**What this proves:** Line 546 correctly resolves `aiName = aiConfig?.ai_name || 'Sage'` — but the right-column panel headers at lines 1047 (`{/* RIGHT: What Sage Has Learned + Voice Profile */}`) and 1104 (`{/* ---- What Sage Has Learned ---- */}`) and the rendered text are hardcoded. The `aiName` variable is loaded but not interpolated into those headers.
**Would experience this as:** "The page header uses my AI's name correctly but a sub-panel says 'What Sage Has Learned'."

### MEDIUM 17. /portal/availability hardcodes "Sage" in business-rule descriptions
**Surface:** `src/app/(platform)/portal/availability/page.tsx:108`
**Playbook reference:** AP-6
**What this proves:** A status descriptor: `description: 'Tentative — a couple is about to sign. Sage will not confirm to others.'` This is actual business behaviour copy, not a comment, and it will display verbatim to a non-Sage venue's coordinator.
**Would experience this as:** "Why does this status say 'Sage will not confirm' when my AI is named Hawthorn?"

### MEDIUM 18. /portal/venue-usps-config hardcodes "Sage's voice" multiple times
**Surface:** `src/app/(platform)/portal/venue-usps-config/page.tsx:149, 151, 161`
**Playbook reference:** AP-6
**What this proves:** Subtitle `Short statements Sage weaves into inquiry and client replies. Keep ... the order here is the order Sage cycles through.` Empty state (161): `No USPs yet. Add one to start shaping Sage's voice.` All hardcoded.
**Would experience this as:** "I'm trying to add my venue's USPs and the page tells me to 'shape Sage's voice'."

### MEDIUM 19. /intel/anomalies column header is literally "Sage Action"
**Surface:** `src/app/(platform)/intel/anomalies/page.tsx:383, 491`
**Playbook reference:** AP-6
**What this proves:** Anomaly table column at line 383: `<th>Sage Action</th>`. The cell content at line 491 says `<span>Sage suggests:</span>`. No aiName resolution.
**Would experience this as:** "The anomalies table has a column called 'Sage Action' that shows 'Sage suggests: ...'."

### MEDIUM 20. /portal/messages tab label is hardcoded "Sage AI"
**Surface:** `src/app/(platform)/portal/messages/page.tsx:147`
**Playbook reference:** AP-6
**What this proves:** Tab/option list: `label: 'Sage AI'`.
**Would experience this as:** "The messages filter has an option labelled 'Sage AI' even though my AI isn't called Sage."

### MEDIUM 21. /portal/sage-queue route itself is "/portal/sage-queue"
**Surface:** Route folder + nav (`src/components/shell/nav-config.ts:183`)
**Playbook reference:** AP-6 (cosmetic / URL leak)
**What this proves:** The URL slug is `/portal/sage-queue`. Other route names with "sage" in the path: `/portal/sage-queue`, `/settings/sage-identity`, `/api/portal/sage`, `/api/public/sage-preview`, `/sage` (mode root). Coordinator who screen-shares or copy-pastes a URL will reveal the brand-default name.
**Would experience this as:** "When I share my screen the URL says /sage — but I named my AI Hawthorn."

### LOW 22. Brain-dump button alt-text falls back to 'Sage' but is at least dynamic
**Surface:** `src/components/shell/floating-brain-dump.tsx:91, 271-292, 414, 486`
**Playbook reference:** N/A (this one is OK — included for contrast)
**What this proves:** This component does the right thing: fetches `ai_name` from `venue_ai_config` on mount (line 121-130) and uses `Tell {aiName} something` everywhere, with `'Sage'` only as the initial useState default before the fetch resolves. There's a brief flash of "Tell Sage something" on first paint before the venue's name loads (line 91), but otherwise this is the model the rest of the codebase should follow. Cmd+K wiring (101-115) works Day 1.
**Would experience this as:** "The brain-dump button says 'Tell Sage something' for half a second then changes to 'Tell Hawthorn something'."

### LOW 23. Setup wizard pre-fills the venue-name field with placeholder "Hawthorne Manor"
**Surface:** `src/app/(platform)/setup/page.tsx:599`
**Playbook reference:** Cold-start UX
**What this proves:** `placeholder="e.g. Hawthorne Manor"` — fine for an example, but combined with the couple-layout fallback (Critical 2) and the `personality-builder.ts:139` literal `sage@hawthornemanor.com`, "Hawthorne" is the canonical demo venue baked everywhere. A coordinator at "Hawthorn Hall" might find their typo'd entries auto-completing to "Hawthorne".
**Would experience this as:** "Why are there so many references to a venue called 'Hawthorne Manor' when my venue is 'Hawthorn Hall'?"

### LOW 24. Cold-start /pulse, /agent/leads, /sage-queue, /agent/inbox empty states are honest
**Surface:** `src/app/(platform)/pulse/page.tsx:186-191`, `src/app/(platform)/agent/leads/page.tsx:564-579`, `src/app/(platform)/portal/sage-queue/page.tsx:441-450`, `src/app/(platform)/agent/inbox/page.tsx:2069-2092`
**Playbook reference:** N/A (PASS — included for completeness)
**What this proves:** All four use proper empty states with grey icons and text like "All clear. Nothing demands your attention right now" / "No scored leads yet. Lead scores are calculated automatically based on engagement events." / "Queue is clear. No uncertain questions right now." / "Inbox is empty. Click 'Sync Emails' to pull in the latest from Gmail." None show fake placeholder data. The DashboardPage at `src/app/(platform)/page.tsx:226-235` similarly renders real `0` for Active Inquiries / Pending Drafts / Booked Revenue. **This is good.**
**Would experience this as:** "On Day 1 these pages honestly say 'nothing yet' rather than faking activity."

### LOW 25. Auto-send rules default to disabled — Day 1 sliders are conservative (PASS)
**Surface:** `supabase/migrations/002_agent_tables.sql:114` (`enabled boolean DEFAULT false`); `src/app/(platform)/onboarding/page.tsx:601-608` (rule seed) sets `enabled: false`
**Playbook reference:** AP-12 / AP-17 / Part 7 sliders
**What this proves:** The schema defaults `auto_send_rules.enabled = false`, and the wizard explicitly seeds new rows with `enabled: false`. So a brand-new Hawthorn Hall starts in proposal-only mode with no sources auto-sending. **This is good.** However: the wizard does NOT show the coordinator the 5 sliders themselves (autonomy, voice gate, etc.) and only collects the personality-axis dimensions (warmth/formality/playfulness/brevity/enthusiasm) at lines 358-364 — those sliders default to 7/4/5/6/6, the same hardcoded values the personality-builder uses, so when the coordinator skips the voice step they ship with "moderate-friendly" as if they'd chosen it.

## What's solid

The auto-send default is genuinely off (#25) and the dashboard / inbox / leads / pulse / sage-queue cold-start empty states are honest — they don't fake activity (#24). The brain-dump button (#22) demonstrates the correct white-label pattern and Cmd+K works Day 1. `inquiry-brain.ts` correctly differentiates "marketplace relay" vs "website calculator" vs "direct email" via `sourceGuidance` (lines 422-433) — that part of the "already sold vs needs selling" split is real, even if the fallback name leaks. The personality-builder's tour-booking-link rendering correctly handles 0 / 1 / N links per migration 074. The 5-day onboarding project's Go Live gate (`activateLive`, lines 385-438) properly enforces the readiness verdict + paid backfill score before flipping the venue live, and persists missing categories back to the UI for display. The `confidence_flag` schema itself is well-designed — the gap is purely the missing UI consumers.
