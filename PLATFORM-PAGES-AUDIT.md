# Platform pages audit — Wave 5 W39

Date: 2026-09-12. Every `page.tsx` under `src/app/(platform)` (185 files) opened
and checked against `src/components/shell/nav-config.ts`, the November client
path in NOVEMBER-PLAN.md, and what actually links to it in the rest of `src/`.

## Method

For each page: does a nav entry (a `NavItem`/`GearItem` href, or a
`matchPrefix`) reach it directly; if not, does a real `<Link>`/`href=`/
`router.push` from a page that IS on the client path reach it; if neither,
open the file and read what it does. Verdict is on that evidence, not the
route name.

**Client path** (per the brief): `/today`, the agent daily surfaces
(`/agent/inbox`, `/agent/drafts`, `/agent/pipeline`, `/agent/leads`,
`/agent/audio-inbox`), `/intel/dashboard`, `/intel/sources`,
`/intel/attribution`, `/intel/couples/**`, `/intel/tours`,
`/intel/social-integration/**`, Ask your data (`/intel/nlq`), `/settings/**`,
`/onboarding/**`, `/portal/weddings/**`, the couple portal, the demo. Read
literally this excludes the rest of Agent's "Daily" nav section
(`/agent/inbox`/`/agent/drafts` are both nav-daily AND named explicitly, so
no ambiguity there) — see "Keep beyond the narrow list" below for how the
wider nav-reachable surface was treated.

**Four verdicts**

- **keep** — on the client path, or reachable from a page that is (nav entry
  or a real in-app link), or load-bearing infrastructure (redirect hubs,
  auth gates).
- **hide (scaffold)** — built, works, but no nav entry and no link from
  anywhere reachable. Gated behind `assertNotScaffold()` this wave.
- **redirect** — a legacy route with a replacement. All seven found were
  already implemented (the W9 pattern); none needed new code.
- **delete** — nothing reads it and it duplicates a kept page. Recorded for
  the integrator; not deleted this wave.

**Keep beyond the narrow list.** The brief's client-path list names the
handful of surfaces the November plan leans on daily. It does not relist
every settings sub-page, every admin dashboard the gear menu already serves,
or every "Sources & ROI" / "Reviews" / "Sequences" style nav item that
existed before this wave and has a real nav entry today. Hiding a page that
already has a working sidebar or gear-menu entry is a much bigger, riskier
change than this wave's remit ("pages with **no nav entry** and no client
purpose") — the plan line under W39 says exactly that. So: nav-reachable
pages keep their nav-reachable "keep" verdict regardless of whether the
brief's short list happened to name them, and this audit's real work is the
28 pages that had **no** nav entry at all.

## Counts

| Verdict | Count |
|---|---|
| keep | 167 |
| hide (scaffold) | 9 |
| redirect (already implemented) | 7 |
| delete (recorded, not deleted) | 2 |
| **Total** | **185** |

Orphans found (no nav href and no nav `matchPrefix` reaches them): 29,
including the root index — within the 2026-09-08 audit's 23–44 range. Of the
29: 2 are load-bearing infrastructure that a nav item doesn't apply to
(root, `/setup`), 10 turned out to be reachable via a real link from a kept
page or (for `/intel/marketing-spend`, `/pulse`, `/portal/pixel-config`) got
one added this wave, 9 are truly dead ends (hide), 2 mirror data
`nav-config.ts` already exposes elsewhere and are never linked (delete), and
6 already redirect to their replacement. A 7th redirect (`/settings/omi`)
was found separately — it matches the `/settings` nav prefix, so the
algorithmic orphan sweep correctly did not flag it, but it is the same
legacy-rename pattern as the other six and is listed with them.

## The orphans, one by one

No nav entry (direct href or `matchPrefix`) reaches these 29 routes (root
index included). Each was opened; the verdict follows from what was found,
not the filename. `/settings/omi` is not in this table — see the note under
the table.

| Route | What it is | Reachable how | Verdict |
|---|---|---|---|
| `/` (root) | Post-login redirect hub: no scope → `/setup`, onboarding incomplete → `/onboarding`, else → `/today` | Every login hits it | **keep** — infrastructure, not a nav destination |
| `/setup` | Company/venue/team creation wizard | `redirect('/setup')` from the platform layout, `/page.tsx`, `/today` when no scope; signup's `router.push('/setup')` | **keep** — mandatory first-run gate, nav doesn't apply pre-scope |
| `/agent/cohort` | Free-text cohort retrieval + bulk follow-up drafting (`POST /api/agent/cohort`) | `href="/agent/cohort"` in `agent/inbox/page.tsx:2353` | **keep** — reachable from a kept page |
| `/agent/omi-inbox` | — | `redirect('/agent/audio-inbox')` | **redirect** — already implemented (T2-E rename) |
| `/intel/campaigns` | — | `redirect('/intel/sources')` | **redirect** — already implemented (Stream ZZZ) |
| `/intel/candidates` | — | `redirect('/intel/identity-review')` | **redirect** — already implemented (W9) |
| `/intel/capacity` | — | `redirect('/intel/portfolio')` | **redirect** — already implemented (Stream ZZZ) |
| `/intel/matching` | — | `redirect('/intel/identity-review')` | **redirect** — already implemented (Wave 3 W24) |
| `/intel/clients` (list) | — | `redirect('/intel/couples')` | **redirect** — already implemented (W9) |
| `/intel/clients/[id]` | Full couple/lead detail (1674 lines): timeline, drafts, journey, actions | Linked from `agent/leads`, `agent/pipeline`, `agent/inbox`, `agent/audio-inbox`, `agent/drafts`, `agent/notifications`, `admin/identity`, `admin/identity/handle-merges`, `intel/couples/[id]`, `intel/weather`, `intel/reviews/solicitations`, `intel/agencies/[id]/leads` and more (33 files reference `/intel/clients/`) | **keep** — this is where most of the app still sends you for lead detail, even though the *list* redirects to `/intel/couples`. W40 owns moving these reads onto the canonical surface; W39 does not rewrite links |
| `/intel/clients/[id]/timeline` | Full touchpoint timeline for a couple | Linked from `intel/clients/[id]` | **keep** — subroute of the above |
| `/intel/channels` | Channel Intelligence Hub comparison page ("supersedes the UX of `/intel/sources` but does not delete it") | `href="/intel/channels"` in `intel/sources/page.tsx:1851` | **keep** — reachable from `/intel/sources`, which is explicitly on the client path |
| `/intel/channels/[channel_slug]` | Per-channel forensic deep-dive | Linked from `/intel/channels` cards | **keep** — subroute |
| `/intel/marketing-roi` | Persona × channel ROI heatmap dashboard | `href="/intel/channels"` link is one hop from `/intel/sources`; `intel/channels/page.tsx:150` links to `/intel/marketing-roi` | **keep** — two hops from a client-path page, still a real click path |
| `/intel/marketing-roi/digest` | Weekly digest narrative (top flags + recs + WoW deltas) | Nothing — `MarketingDigest.tsx` panel is imported nowhere; only the digest page's own fetches | **hide (scaffold)** |
| `/intel/marketing-roi/flags` | Auto-flag triage (critical/warning/info) | Nothing — `SpendFlagPanel.tsx` imported only by this page itself | **hide (scaffold)** |
| `/intel/marketing-roi/recommendations` | Reallocation recommendations, full status list | Nothing — `MarketingRecommendationsPanel.tsx` imported only by this page itself; `MarketingRoiDashboard.tsx` (the actual content of `/intel/marketing-roi`) links only back to `/intel/channels`, never forward to these three | **keep** (revised 2026-09-14: nav entry added under Intel, it is a working analyst that lacked a door) |
| `/intel/marketing-spend` | Manual marketing-spend entry form feeding the ROI heatmap | Nothing clickable — only mentioned in plain-text error strings ("Add spend at /intel/marketing-spend") in `couple-attribution.ts` and `yoy.ts` | **keep, but was unreachable** — added a nav entry (see Nav changes) because the ROI dashboard it feeds is already kept |
| `/intel/discoveries` | Wave 7A pattern-discovery dashboard | Nothing — `DiscoveriesPanel.tsx` imported nowhere; `recommendation-routing.ts` only offers the link when an LLM recommendation's text happens to contain "discovery"/"hypothesis"/"pattern", which is not a real path a coordinator can rely on | **hide (scaffold)** |
| `/intel/matches` | Wave 5C external-signal matches dashboard | Nothing — `IntelMatchesPanel.tsx` imported nowhere | **hide (scaffold)** |
| `/intel/alumni` | Wave 14 alumni-archetype dashboard (aggregate-only) | Nothing — populated by a cron sweep (`runAlumniSweep`) but no page links to the dashboard | **hide (scaffold)** |
| `/intel/referrals` | Wave 14 referral-attribution review queue | Nothing — populated by `runReferralSweep`; no page links here | **hide (scaffold)** |
| `/intel/forecasts` | Revenue-forecast chart | Nothing — nav-config.ts's own comment says it was deliberately pulled from nav 2026-05-04 (mislabelled hockey-stick projection) and left "reachable via direct URL" | **hide (scaffold)** — direct-URL-only was never actually safe; now actually gated |
| `/intel/external-signals` | Status of the 8 external-signal feeds (weather, FRED, cultural moments, etc.) | `href="/intel/external-signals"` in `settings/venue-info/page.tsx:488` | **keep** — reachable from a `/settings/**` page |
| `/portal/pixel-config` | Install/rotate the Bloom site-visitor pixel; closes the cross-session attribution gap the TBH Report calls its biggest coverage hole | Nothing — not even the TBH Report page (`intel/agencies/[id]/tbh-report`), which shows the pixel's coverage status, links to where you'd go install it | **keep, but was unreachable** — added a nav entry (see Nav changes) |
| `/org` | Full-page mirror of `GEAR_GROUPS` (same data the gear-menu dropdown renders) | Nothing — the gear icon links straight to each leaf item's href, never to `/org` itself | **delete** — duplicates the gear menu; zero inbound links anywhere in `src/` |
| `/sage` | Full-page mirror of `MODE_SAGE.sections` (same data the sidebar renders) | Nothing — `mode-strip.tsx` links `defaultHref` (`/settings/sage-identity`) directly, bypassing this index | **delete** — duplicates the Sage's Brain sidebar; zero inbound links |
| `/pulse` | "Coordinator's single inbox for things that need attention" | Only the bell icon (`notification-bell.tsx:234`) and `/today`'s "Anything wrong" card — no sidebar entry (UX-AUDIT-NON-TECHNICAL.md finding 14) | **keep, but under-reachable** — added a nav entry (see Nav changes) |
| `/system/consolidation-status` | Static snapshot of the May 2026 "Batch 1/2" migration rollout | Only `ConsolidationChip` in the top bar (org_admin/super_admin only) | **hide (scaffold)** — the snapshot (`SNAPSHOT_AS_OF = '2026-05-26'`) is four months stale and describes a rollout NOVEMBER-PLAN.md has long superseded; the chip that pointed at it is switched off (`CONSOLIDATION_IN_FLIGHT = false`) so no kept surface links to a hidden page |

`/settings/omi` is not in this table: it matches the `/settings` nav prefix
(the algorithmic sweep only flags routes with zero nav href/prefix match),
so it was found by the separate `redirect(` sweep instead. It is the same
T2-E rename pattern as `/agent/omi-inbox` — `redirect('/settings/audio-capture')`,
already implemented — and is counted in the 7 "redirect" verdicts.

## Everything else (156 pages) — nav-reachable, kept

These all resolve through a direct `NavItem`/`GearItem` href or a mode
`matchPrefix`, confirmed programmatically against `nav-config.ts` and then
spot-checked by opening each file's header/body to confirm the page still
does what its nav label says (no page in this set turned out to be a stub
behind a live-sounding label).

| Segment | Pages | Nav surface |
|---|---|---|
| `agent` (22 of 24 — `/agent/cohort` and `/agent/omi-inbox` covered above) | analytics, audio-inbox, auto-send-shadow, brain-dump (+grants), classification-health, codes, drafts, errors, forbidden-topics, identity-windows, inbox, knowledge-gaps, leads, learning (+recent-edits), notifications, pipeline, relationships, rules, sequences, settings | Agent mode Daily/Reach/Quality/System sections |
| `intel` (46 of 66 — 20 covered above) | agencies (+ new/[id]/edit/leads/tbh-report), anomalies, attribution, benchmark, channel-truth, cohort, company, couples (+[id]/[id]/journey), cultural-moments, dashboard, data-fields, health, heat, identity-review, insights (+weather-tours), lost-deals, macro-correlations, market-pulse, nlq, portfolio (+structure), pricing-history, reach, reengagement, regions, reviews (+paste/solicitations), roi, social-integration (+captures/[id]), source-quality, sources (+track), team, tours, trends, weather | Intel mode Daily/Demand/Conversion/Voice-of-customer/People/Tools sections + Gear "Portfolio analytics" |
| `portal` (32 of 33 — `/portal/pixel-config` covered above) | absences-config, accommodations-config, availability, bar-config, borrow-catalog-config, checklist-config, decor-config, guest-care-config, kb, marketing-channels-config, messages, property-state-config, quick-add, rehearsal-config, rooms-config, sage-queue, seating-config, section-settings, shuttle-config, staffing-config, storefront-config, tables-config, vendors, venue-assets-config, venue-resources-config, venue-usps-config, wedding-details-config, weddings (list + [id]/[id]/portal/[id]/print/[id]/table-map) | Weddings mode + Sage's Brain "Portal experience" sections |
| `settings` (27 of 28 — `/settings/omi` covered above) | audio-capture, billing, brain-dump-log, data-sources, digest-preferences, essentials-org, gmail, groups, inbox-filters, integrations (+calendly/google-ads/instagram/twilio), openphone, page (root), personality, privacy, pulse-snoozes, sage-identity, seasonal-content, sources, team, vendor-domains, venue-info, voice, zoom | Sage's Brain sections + Gear "Org admin"/"Personal"; all under `/settings/**`, explicitly on the client path |
| `admin` (13) | attribution/roles, calibration, disagreements, identity-divergence, identity-telemetry, identity (+decisions/handle-merges/wedding/[id]/overrides), imports, integrity, onboarding/thesis, sources-parity | Gear "Admin" |
| `onboarding` (8) | crm-import, extract-packages, identity-reconciliation, page (root), pricing-history, project, tour-scheduler-import, web-form-import | Sage's Brain "Onboarding"; all under `/onboarding/**`, explicitly on the client path |
| `super-admin` (4) | page (root), consumer-requests, observability, pipeline-health | Gear "Super admin" |
| `dashboard`, `today` | 1 each | Intel Daily ("Venue dashboard"), Agent Daily ("Today") |
| `sage/voice-dna` | 1 | Sage's Brain "Voice DNA" |

None of these were stub pages wearing a real label — each was opened far
enough (header comment plus, for anything without one, the render body) to
confirm the page does what its nav entry claims.

## Nav changes made

1. **`/pulse`** — added to Agent mode's Daily section (`Bell` icon,
   `daily: true`), and `/pulse` added to `MODE_AGENT.matchPrefixes` so the
   sidebar highlights correctly when a coordinator is on the page. It was
   previously reachable only through the bell icon and (since W8) the
   `/today` "Anything wrong" card — both real, but the plan called this out
   by name as the thing to fix.
2. **`/intel/marketing-spend`** — added to Intel mode's Conversion section
   (`DollarSign` icon), next to Marketing Agencies. It had zero clickable
   path anywhere in the product even though it is the data-entry surface
   the (kept, reachable) `/intel/marketing-roi` heatmap depends on.
3. **`/portal/pixel-config`** — added to Intel mode's Conversion section
   (`ScanLine` icon), next to Marketing Spend. Same shape of gap: the TBH
   Report shows the pixel's coverage status but never links to where a
   coordinator would go turn it on.

No nav entries were removed: none of the nine "hide" pages, nor the two
"delete" pages, had a nav entry to begin with (that is exactly why they
qualified). `nav-config.ts`'s doc comments were updated to record the new
"gated behind SCAFFOLD_PAGES" list and the "delete" candidates so the next
person reading the file doesn't have to re-derive this audit.

## Collateral: the consolidation chip

`/system/consolidation-status` got a hide verdict, but
`src/components/shell/consolidation-chip.tsx` renders a persistent top-bar
link to it for every org_admin/super_admin on every page. A kept page
cannot link to a hidden one (task rule), so `CONSOLIDATION_IN_FLIGHT` was
flipped from `true` to `false` — the chip is a no-op now, matching what its
own header comment says to do "when the phased rollout completes" (it did,
several waves ago). This is the one file outside the stated ownership list
(`nav-config.ts`, `SITEMAP.md`, `scripts/gen-sitemap.mjs`,
`src/lib/scaffold-gate.ts`, the orphan pages) touched this wave; it was
necessary collateral, recorded here as the patch note the shared rules ask
for.

## Known pre-existing bugs found, not fixed (out of scope for W39)

- `src/lib/utils/recommendation-routing.ts` has two dead hrefs baked into
  its keyword table: `/intel/re-engagement` (real route is
  `/intel/reengagement`, no hyphen) and `/intel/pricing` (real route is
  `/intel/pricing-history`). Neither is caught by
  `scripts/check-internal-links.mjs` because the strings are inside a data
  object (`href: '...'`), not an `href=`/`fetch(`/`router.push(` call the
  regex-based checker looks for. Not touched — the file is not owned by
  W39 and fixing it is a one-line job for whoever owns that table next.
