# Phase 2A — Nav Structure Design

**Status:** Design document. No code changes. Reviews the two nav rails, the full old-URL → new-nav mapping, the transition plan, and open product questions. Approval here unblocks Phase 2B (build behind feature flag).

---

## Decisions locked in from Phase 1

1. Four brains remain (inquiry / client / portal / preview)
2. Portal-Sage now reads `voice_preferences` (shipped as `a6e0d21`)
3. `/settings/personality` now filters by `venue_id` (shipped as `27c3ab1`)
4. `knowledge_base` will get `used_for_inquiries` + `used_for_portal` booleans in Phase 3D
5. Both vendor tables (`vendor_recommendations` + `booked_vendors`) get visibility/status/disclosure schema in Phase 3B
6. Vendors self-serve on both portals; coordinator surfaces visibility per-vendor

---

## Top-level navigation

**Old top nav:** `Inbox  ·  Pipeline  ·  Intel  ·  Portal  ·  Settings`

**New top nav:**
```
Inbox  ·  Pipeline  ·  Intel  ·  Sage's Brain  ·  Org admin
```

- `Portal` disappears as a top-level slot — its contents move under **Sage's Brain → Portal experience** because every portal config item is venue-scoped and venue-owned.
- `Settings` disappears as a top-level slot — venue-scoped items move under **Sage's Brain**, org-scoped items move under **Org admin**.
- `Org admin` only appears for users with `org_admin` or `super_admin` role. Venue-only users see `Sage's Brain` where `Org admin` would be.

---

## Sage's Brain (per venue) — rail

Entry point: `/sage` (index page; shows rail items with one-line descriptions). Every rail item navigates to the existing URL — no route changes.

```
Sage's Brain
├── Identity              → /settings/sage-identity
├── Voice & Personality   → /settings/personality + /settings/voice + /agent/learning
├── Knowledge             → /portal/kb  (+ /agent/knowledge-gaps, /portal/sage-queue)
├── Inquiry behaviour     → /agent/settings + /agent/rules + /settings/inbox-filters + /portal/venue-usps-config
├── Portal experience     → /portal/* (16 portal config pages)
├── Vendors               → /portal/vendors
├── Connections           → /agent/settings (Gmail section) + /settings/omi + /settings/calendly
└── Onboarding            → /onboarding  (re-enter any step)
```

### Rail item detail

| Rail item | Description shown on `/sage` index | Primary URL | Secondary URLs surfaced inside |
|---|---|---|---|
| **Identity** | Sage's name, role, email, what she introduces herself as. | `/settings/sage-identity` | (nothing) |
| **Voice & Personality** | Tone, warmth, play style, voice-training games, learned phrases. | `/settings/personality` | `/settings/voice` (training games), `/agent/learning` (feedback dashboard), `/agent/rules` (always/never rules) |
| **Knowledge** | Everything Sage knows about your venue. Filter per Sage context (inquiries / portal / both) after Phase 3D. | `/portal/kb` | `/agent/knowledge-gaps` (resolve uncertainty queue), `/portal/sage-queue` (convert uncertain portal answers) |
| **Inquiry behaviour** | Auto-send rules, per-source confidence thresholds, reply filters, USPs to weave in. | `/agent/settings` | `/settings/inbox-filters`, `/portal/venue-usps-config` |
| **Portal experience** | What your booked couples see in their portal — spaces, bar, shuttles, timeline config, decor rules, etc. Section blanks if portal disabled for venue. | `/portal` (new index sub-page) | All 16 `/portal/*` config routes grouped by domain |
| **Vendors** | Preferred list + per-vendor visibility/status/disclosure (Phase 3B ships the metadata). | `/portal/vendors` | `/vendor-portal/*` (legacy self-serve URL lives on during transition) |
| **Connections** | Gmail, Omi, Calendly, HoneyBook integrations + their state. | `/settings/omi` | `/settings/calendly`, `/agent/settings` (Gmail panel) |
| **Onboarding** | Re-run any step — useful for voice re-training or brand updates. | `/onboarding` | (each step accessible via query param in Phase 2B) |

### Portal experience sub-grouping (locked after Phase 2A review)

Enumerated 26 `/portal/*` pages. 14 config pages live here; 4 live on other rails (vendors, kb, sage-queue, venue-usps-config); 8 are operational (messages, quick-add, availability, coordinator wedding pages) and move to a separate "Weddings" surface — **not** under Sage's Brain. Operational pages flagged below.

| Bucket | Pages | URLs |
|---|---|---|
| **Spaces** | 3 | `/portal/rooms-config`, `/portal/tables-config`, `/portal/seating-config` |
| **Service** | 4 | `/portal/bar-config`, `/portal/decor-config`, `/portal/staffing-config`, `/portal/guest-care-config` |
| **Logistics** | 3 | `/portal/shuttle-config`, `/portal/accommodations-config`, `/portal/rehearsal-config` |
| **Day-of** | 2 | `/portal/wedding-details-config`, `/portal/checklist-config` |
| **Brand** | 1 | `/portal/venue-assets-config` |
| **Meta / Access** | 1 | `/portal/section-settings` (which sections couples see) |

**Total Portal experience config pages: 14.**

### Pages that DON'T move under Sage's Brain (8 operational)

These are coordinator daily-use, not Sage configuration. They need a home but shouldn't clutter the Sage's Brain rail.

- `/portal/messages` — coordinator-side couple chat
- `/portal/quick-add` — quick wedding creation
- `/portal/availability` — calendar view
- `/portal/weddings` (list)
- `/portal/weddings/[id]` (detail)
- `/portal/weddings/[id]/portal` (couple-facing preview)
- `/portal/weddings/[id]/print`
- `/portal/weddings/[id]/table-map`

**Proposed home:** a new top-nav slot `Weddings` (between Pipeline and Sage's Brain), or fold under the existing `Pipeline` top-nav. I'll default to folding under Pipeline unless you want a dedicated slot. **Flagged as Q8 below.**

---

## Org admin — rail

Entry point: `/org`. Only visible to `org_admin` and `super_admin` roles.

```
Org admin
├── Team                 → /settings/team
├── Billing              → /settings/billing           ← flagged below (Q1)
├── Venues               → /settings (venue picker) + per-venue quick-switch
├── Groups               → /settings/groups
├── Portfolio analytics  → /intel/portfolio, /intel/company  (scope-aware at company level)
└── Super-admin          → /super-admin/*              (only for super_admin role)
```

---

## Old URL → new nav path (every URL from Phase 1A)

| Old URL | New nav path | Notes |
|---|---|---|
| `/settings` (venue scope — brand) | Sage's Brain → Identity (merged) | Venue brand fields fold into Identity — all venue-scoped venue_config writes |
| `/settings` (org scope — brand) | Org admin → Venues | Org-level brand/colour cascade lives with Venues list |
| `/settings/sage-identity` | Sage's Brain → Identity | Unchanged URL |
| `/settings/personality` | Sage's Brain → Voice & Personality (primary) | Unchanged URL |
| `/settings/voice` | Sage's Brain → Voice & Personality (secondary — training games) | Unchanged URL |
| `/settings/inbox-filters` | Sage's Brain → Inquiry behaviour (secondary) | Unchanged URL |
| `/settings/omi` | Sage's Brain → Connections (primary) | Unchanged URL |
| `/settings/calendly` | Sage's Brain → Connections (secondary) | Unchanged URL (placeholder if not yet built) |
| `/settings/brand` | Sage's Brain → Identity | Brand kit consolidated with Identity |
| `/settings/team` | Org admin → Team | Unchanged URL |
| `/settings/billing` | Org admin → Billing | Unchanged URL — but see Q1 |
| `/settings/groups` | Org admin → Groups | Unchanged URL |
| `/super-admin/*` | Org admin → Super-admin | Only super_admin role sees rail item |
| `/agent/settings` | Sage's Brain → Inquiry behaviour (primary) + Connections (Gmail panel) | Same page, surfaced from two rail items |
| `/agent/rules` | Sage's Brain → Voice & Personality (secondary — always/never rules) | Unchanged URL |
| `/agent/learning` | Sage's Brain → Voice & Personality (secondary — feedback dashboard) | Unchanged URL |
| `/agent/knowledge-gaps` | Sage's Brain → Knowledge (secondary — resolve queue) | Unchanged URL |
| `/agent/sequences` | Sage's Brain → Inquiry behaviour (secondary — follow-up sequences) | Brief lists this; I didn't find a page in 1A — flagged as Q2 |
| `/portal/kb` | Sage's Brain → Knowledge (primary) | Unchanged URL |
| `/portal/sage-queue` | Sage's Brain → Knowledge (secondary — uncertain portal answers) | Unchanged URL |
| `/portal/venue-usps-config` | Sage's Brain → Inquiry behaviour (secondary) | Unchanged URL |
| `/portal/venue-assets-config` | Sage's Brain → Portal experience (primary — attachable files) | Unchanged URL |
| `/portal/vendors` | Sage's Brain → Vendors | Unchanged URL |
| `/portal/*` (16 config pages) | Sage's Brain → Portal experience | Unchanged URLs; grouped by domain |
| `/vendor/[token]` | External (vendor self-serve) | Not in platform nav — unchanged |
| `/vendor-portal/[token]` | External (vendor self-serve, legacy) | Not in platform nav — unchanged |
| `/onboarding` | Sage's Brain → Onboarding | Unchanged URL |
| `/preview/[slug]` | External (public preview) | Not in platform nav |
| `/intel/portfolio` | Org admin → Portfolio analytics | Unchanged URL |
| `/intel/company` | Org admin → Portfolio analytics | Unchanged URL |
| Existing `/intel/*` routes (excluding portfolio/company) | `Intel` (unchanged top-nav) | Unchanged |
| Existing `/agent/inbox`, `/agent/drafts`, `/pipeline` | `Inbox` / `Pipeline` (unchanged top-nav) | Unchanged |

**Verification checkpoint:** every URL in the Phase 1A map has a home in the new nav. No orphans.

---

## Transition plan for bookmarked URLs

Nothing breaks. Every old URL continues to resolve to its existing page. What changes is:

- The top nav renders the new structure
- `/sage` and `/org` are new index pages — they do not conflict with existing routes (neither exists today)
- The old top-nav `Portal` and `Settings` slots disappear from the sidebar/header, but their URLs still work if typed or bookmarked
- During the feature-flag period (Phase 2B), users can flip back to the old nav with a toggle — in case the new one breaks their muscle memory

Zero 301s, zero redirects, zero broken bookmarks. This is a presentation layer change only.

---

## Open product questions that need your call before 2B starts

1. **Billing scope — venue or org?** Today `/settings/billing` writes `venues.plan_tier` and `stripe_customer_id` despite sitting in the "settings" section. Under "Org admin → Billing," does each venue remain billed individually (multi-venue orgs pay per venue) or should billing roll up to the org? If org-level, there's a schema migration (not in this brief). For now I'll nav it to Org admin but the data shape is unchanged.

2. **`/agent/sequences` — does this page exist?** Brief lists it, my 1A audit didn't find it. If not built yet, the rail item links to a stub or is hidden until built. Tell me if it's a planned page or a ghost in the brief.

3. **Identity vs Voice split.** Your Phase 1 answer was "portal-Sage should read voice_preferences for personality match" — already shipped. Downstream question: under "Voice & Personality," should the sliders (warmth, formality, etc.) be a single per-venue row (today) or allow per-context overrides (inquiry more formal / portal warmer)? My recommendation in 1E was to skip per-context overrides unless you actively want them. Confirm or override.

4. **Portal experience sub-grouping.** I need to enumerate the 16 portal pages before Phase 2B and group them by domain. Tentative buckets from the brief:
   - **Spaces** — rooms, decor, floor plans
   - **Service** — bar, catering, staff
   - **Logistics** — shuttles, parking, rehearsal
   - **Brand** — logo, colours, couple portal look
   - **Day-of** — timeline defaults, setup windows
   
   Want me to lock these buckets now, or show you the full 16-page list first and let you group?

5. **`/sage` and `/org` URL slugs — are those right?** Short, punchy. Alternatives: `/brain`, `/sage-brain`, `/venue`; `/admin`, `/organization`. I recommend `/sage` and `/org` — confirm or swap.

6. **Venues list inside Org admin — is this just a picker?** Or a full management view (create venue, archive venue, admin per-venue settings shortcuts)? A picker is fast to build. Full management is more complex. My default: picker + quick-switch, full management deferred.

7. **Role-based visibility.** Org admin rail only shows for `org_admin` / `super_admin`. Do you want a third mid-tier role (e.g., "group admin" who manages a set of venues but not the whole org)? Today there are only `coordinator` / `org_admin` / `super_admin`. No change proposed unless you flag one.

---

## What is NOT in this document

- **No code.** No pages edited, no new routes added. That's Phase 2B.
- **No URL changes.** Everything navigates to existing URLs.
- **No schema changes.** Those are Phase 3B (vendors) and Phase 3D (KB).
- **No consolidation of the underlying pages.** Identity still has its own URL, Voice still has its own URL — the rail just groups them visually.

---

## Isadora's decisions on the 7 questions (captured 2026-04-24)

1. **Billing** — leave for future. Per-venue billing stays.
2. **`/agent/sequences`** — confirmed exists at `src/app/(platform)/agent/sequences/page.tsx`. My 1A agent missed it. URL in the rail is correct as-is.
3. **Per-context voice sliders** — one unified voice per venue. No per-context override table.
4. **Portal experience buckets** — locked (table above). Full 26-page enumeration revealed 14 config pages under Sage's Brain + 8 operational pages that need a separate home (see Q8 below).
5. **`/sage` and `/org` slugs** — approved.
6. **Venues list** — picker + quick-switch only. No full management.
7. **Roles — add `group_admin`**. Org admin can create venue groups AND assign a user as the lead of a group. That group lead sees the Org admin rail filtered to their group's venues (not the whole org). Scoped by `venue_groups.lead_user_id` (or similar) — schema detail deferred to Phase 2B.

### New question raised in review

**Q8. Home for the 8 operational portal pages** (messages / quick-add / availability / wedding list / wedding detail / portal preview / print / table-map). These are coordinator daily-use, not Sage config. Options:
- A) Fold under existing `Pipeline` top-nav (default — zero new nav surface)
- B) New `Weddings` top-nav slot (more visible, cleaner separation from Pipeline's funnel view)

Default: **A (fold under Pipeline)** unless you want dedicated space. Confirm.

---

## Phase 2B scope (unblocked once Q8 is answered)

1. Build nav config + `/sage` + `/org` index pages
2. Feature flag toggle for new-nav on/off
3. Demo cookie + scope cookie flow preserved
4. Role-based visibility:
   - `coordinator` → sees Sage's Brain, no Org admin
   - `group_admin` → sees Sage's Brain + Org admin (filtered to their group's venues — Team, Billing, Portfolio analytics all scope to group)
   - `org_admin` → sees Sage's Brain + full Org admin (whole org)
   - `super_admin` → sees Sage's Brain + full Org admin + Super-admin rail item

The `group_admin` role requires minor schema work (a `lead_user_id` on `venue_groups` OR a new `venue_group_members.is_lead` flag). Small migration, I'll propose the shape in Phase 2B kickoff.

---

## What happens after you approve this doc

Phase 2B scope:
1. Build the nav config + the `/sage` and `/org` index pages
2. Wire a feature flag so you can toggle new-nav on/off
3. Preserve demo flow (cookie + scope flow is fragile per your brief — I'll test it end-to-end)
4. Implement role-based visibility for Org admin

Phase 2B ends with a working feature flag for you to flip. Phase 2C is you actually using it for a work session.

**Awaiting your decisions on the 7 questions above before I start Phase 2B.**
