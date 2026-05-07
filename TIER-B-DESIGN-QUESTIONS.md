# Tier-B remaining items: design questions + options

State as of 2026-05-07. The Tier-B items below are the ones I deferred this session because they need a design call before I can build. For each: the question, the options I see, and which one I'd pick if you didn't say otherwise. You answer, I build.

## #57 — Second-partner signup

**Background.** The /api/couple/register flow creates one auth user + one user_profiles row per event_code. A second partner has no path to log in today. You said you don't want magic links; you want sign-in + a code.

**Question.** When James (Sarah's partner) wants to log into the portal, what does that look like?

**Options.**
- **A. Single shared login.** Sarah's email + password is the household login. James uses it on his phone. Simplest; zero schema work.
- **B. Both partners sign up with the same event_code.** Each partner does the existing register flow with their own email. We allow multiple user_profiles rows pointing at the same wedding_id (already supported by mig 226's RLS — wedding_id matches, role='couple', that's all the gate cares about). Each partner has their own auth account, sees the same wedding data.
- **C. Lead-partner invites second.** Sarah registers first; from the dashboard she clicks "Add my partner" which mints a one-shot invite code (separate column on weddings) and emails it to James. James uses sign-up + the new code.

**My pick: B.** No new schema beyond what 226 already does. event_code stays the only secret. The "couple_registered_at" check in register would need to soften from "block re-registration" to "first one is fine, second is also fine if it's a new email" — small change. C is clearly cleaner UX but the moment you have two codes you also have to handle "what if she shares the partner code with her bridesmaid by mistake."

---

## #58 — Coordinator Gmail → portal Messages full sync

**Background.** The dashboard currently shows a merged "Recent Messages" stream pulling from `messages` (in-portal DMs) + `interactions` (outbound coordinator emails via Gmail). One-way, display-only.

**Question.** Should couples be able to reply in the portal Messages page, and if yes, where do those replies go?

**Options.**
- **A. Read-only mirror (status quo).** Couples see their email history. Replies happen in their actual email client.
- **B. Bidirectional Gmail bridge.** Couple replies in portal → backend sends as outbound Gmail from coordinator's mailbox in the original thread. Coordinator's reply (also from Gmail) shows back in the portal feed via the existing Gmail polling. Threads stay unified across both surfaces.
- **C. In-portal-only chat channel.** Couples reply in portal → message lands in agent inbox as an in-portal interaction (not Gmail). Coordinators can answer from /agent or from Gmail; if they answer from Gmail, the email gets mirrored back into the portal thread but it stays a separate channel from "real" emails. Two channels, both feeding the same coordinator inbox.

**My pick: C.** B sounds nicer but Gmail OAuth + sending-as on every couple message is a brittle integration and a real revenue risk if the OAuth token drops mid-thread. C uses what already works (the agent inbox), keeps the in-portal channel distinct, and gives you a "couple wrote in the portal" filter coordinators can use to triage.

---

## #59 — Simplified day-of view

**Background.** The audit said the existing portal is too dense for the wedding day itself. Couple is at the venue with no laptop, just a phone, hands full, asking "where do I go right now?"

**Question.** What's the "simplified" version?

**Options.**
- **A. New page `/couple/[slug]/day-of`.** Mobile-first. Big type. Just shows: today's timeline, day-of contact phone (tap-to-call), venue address (open in Maps), weather forecast, the 3 next checklist items. Hidden by default; surfaces in the sidebar only when wedding_date − today ≤ 3.
- **B. Layout-mode toggle.** Existing portal gains a "kiosk mode" the couple flips on the morning of, which strips down every page to one card + next-action.
- **C. Printable PDF.** Server-renders the timeline + key contacts to PDF; couple prints + brings to venue.

**My pick: A.** Lowest surgery, fastest to ship, easiest to test. PDF is a separate item once A is real. B is a 2-week refactor across every couple page.

---

## #60/#61/#62 — CSS audits (iOS tap targets, sidebar contrast, top-bar small-screen)

**Background.** These came in as discrete complaints but I can't run them headlessly — they need device testing.

**Question.** How do we want to triage CSS work?

**Options.**
- **A. Lighthouse + axe-core sweep.** Automated. Catches WCAG 2.1 AA issues. Misleading on real-feel issues like "this button is hard to tap on the train."
- **B. Manual one-afternoon test pass on iPhone + iPad + older laptop.** You drive; I write down what breaks; we batch fixes.
- **C. Defer until a real couple complains.** Sarah is the first non-Isadora user; her phone is the test target.

**My pick: B before any non-demo couple lands.** Lighthouse is fine but it doesn't catch "the sidebar is unreadable in bright sun." A real device pass with the actual portal beats automated tooling for this surface. Half-day max.

---

## #64/#65 — Display-only intel → apply/dismiss workflow

**Background.** Intel pages today show "Tour cancellation rate is 34% this month — investigate" with no action button. Coordinator reads it, does nothing, sees the same insight a week later.

**Question.** What should "do something about this" mean?

**Options.**
- **A. Acknowledge + dismiss.** Each insight gets a "Got it, working on it" button. Inserts a row in `intel_acknowledgments`; the insight is suppressed for the venue for N days. No actual config change.
- **B. Apply (config write-back).** Each insight type maps to a specific config change. "Tour cancellation rate elevated" → button "Enable 24h tour reminder." Click writes to config + acknowledges. Heavy: each insight type needs a curated action mapping.
- **C. Sage handoff.** Each insight gets "Ask Sage about this." Clicks open the agent chat with the insight pre-loaded as context. Coordinator asks follow-ups; Sage proposes specific changes; coordinator confirms.

**My pick: A first, C as the next layer.** A is the obviously-missing piece (acknowledged tracking) and 1 day to build. B is wrong — pre-mapping every insight to a single config change is brittle and patronising. C is the right long-term answer (it's literally what an in-house analyst would do) and dovetails with the existing Sage chat infrastructure.

---

## #67 — Productize shadow → graduate auto-send

**Background.** auto_send_rules.enabled is binary. Coordinators flip it on with no track record; if Sage misfires once they panic and turn it off forever.

**Question.** Do we want a "shadow mode" where the AI computes the eligibility decision but doesn't actually send, builds a track record, then promotes itself when the coordinator approves?

**Options.**
- **A. Add `shadow_mode` flag on auto_send_rules.** While shadow, eligibility decisions land in a `shadow_decisions` log instead of firing. Coordinator reviews the log on `/agent/auto-send-shadow`; if N consecutive decisions look right, the page surfaces a "Promote to live" button.
- **B. Keep binary on/off; add a "review what would have fired" page.** Same UI surface as A but no new state — just retrospective analysis on existing decisions. Coordinator decides without a separate shadow run.
- **C. Don't productise.** Coordinator flips when ready. Trust comes from manually-approved drafts before that.

**My pick: A.** It's the exact pattern Phil used in bloom-agent-main and the workflow Sarah's onboarding playbook implies. Schema cost is small (one flag + a log table). Trust-building value is large because the coordinator gets to watch the system make N correct calls before betting their inbox on it.

---

## #69 — Template inheritance for portal/*-config

**Background.** A venue-group org with 4 venues has to fill in marketing-channels-config + absences-config + property-state-config + venue-info etc. for each venue from scratch. New venue onboarding is hours of identical config.

**Question.** Should config flow from a higher level down?

**Options.**
- **A. Per-row template_id FK.** Each config row points at a "template" row. Venues inherit; overrides save as venue-specific overrides. Generic but invasive (every config table grows a column).
- **B. Org-level config tables that mirror venue-level.** When the venue row is null/empty, COALESCE up to the org row. Two-table read overhead per page; org-level edits ripple automatically.
- **C. "Copy from another venue" button.** New venue's config page has a dropdown of sister venues to clone from. One-shot; coordinator edits afterward.

**My pick: C.** Simplest. Most multi-venue orgs only do this at onboarding once per venue. A and B both bring inheritance complexity (cache invalidation, override semantics, "what does empty mean?") that pays off when you have 50 venues, not 4.

---

## #70/#71 — Architecture refactors (extract `components/shared/`, cluster `lib/services/` by domain)

**Background.** `lib/services/` is ~80 flat files. `components/` mixes shared and feature-specific. The audit flagged both as future-tax.

**Question.** Refactor before launch or after?

**Options.**
- **A. Defer.** Flat-but-working is fine while it's just me. Refactor when team grows.
- **B. Do it now.** Faster alone than with a team having to relearn the new layout.
- **C. Partial.** Cluster only the most coupled families (heat-mapping, identity-resolution, candidate clustering) and leave the rest flat.

**My pick: A.** Refactoring without a concrete pain point creates bugs. The audit findings around dead code (#79, #80) are higher-value cleanup before the structural shuffle.

---

## #80 — Delete `services/economics.ts`

**Background.** The legacy economics service was supposed to retire in favour of FRED via `external-context/`, but 4 importers still call the old API. Round-3 audit flagged the @deprecated marker as dead.

**Question.** Migrate the call sites or write a shim?

**Options.**
- **A. Per-call-site migration.** Each importer (briefings, draft-context-summary, sage-intelligence, intel/dashboard) gets rewritten to read FRED directly. Idiomatic but 4-file change.
- **B. economics-shim.ts.** Re-export FRED equivalents under the old function names. Delete economics.ts. No caller touches anything.

**My pick: B.** Preserves caller stability with one new ~80-line file. Removes the @deprecated marker from #79's audit list. Migrate call sites later when the FRED interface is the canonical one and the shim is the thing that looks redundant.

---

## What's NOT in this doc

These are open items I think we should NOT touch:

- **#49 Sage persona reframe.** Closed by Tier-A #3 above (rixey-portal port). No further work needed unless a couple complains.
- **#108-111 trust/proof gaps (real testimonial, P&L disclosure, Loom).** These are Isadora-content work, not engineering.
- **#99-107 marketing site copy.** Separate repo, you've been doing it directly.
- **Tier-A #2b — already shipped (mig 226 above).**
- **Tier-A #3 — already shipped (sage-brain.prompt.v1.2 above).**

---

## Order I'd build them in (if you said "go down the list")

1. **#57 Option B** (second-partner signup) — small fix on /api/couple/register, immediate value.
2. **#67 Option A** (shadow → graduate) — onboarding pain killer.
3. **#59 Option A** (day-of view) — small surface, ships before the first wedding day under Bloom.
4. **#64/#65 Option A** (acknowledge + dismiss) — coordinator quality-of-life.
5. **#80 Option B** (economics shim) — clears @deprecated noise.
6. **#58 Option C** (in-portal channel) — unlocks the Messages page properly.
7. **#69 Option C** (copy-from-venue) — multi-venue onboarding speedup, only matters when second org venue lands.
8. **CSS audit (#60-62)** — half-day with you on a real iPhone.

Pick what you want first. Or rearrange.
