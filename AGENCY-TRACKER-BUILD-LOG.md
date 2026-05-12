# Agency Tracker — Build Log

Wave 6E of the Bloom House platform. Shipped across four commits between 2026-05-12 and 2026-05-13 to turn the original "is Hawthorn paying off?" investigation into a working forensic-agency-performance surface.

This document explains **what was built**, **why each piece exists**, and **what's deliberately deferred** so the next person who touches this area knows the doctrine before they edit.

---

## Why this exists

Boutique wedding-marketing agencies (Hawthorn Creative, Elite Wedding Marketing, Path & Compass, Alecan, Slamdot, Del Priore, etc.) bill venues $2k-$8k/mo and report on top-of-funnel metrics they can see: impressions, sessions, form submissions. They cannot see what happens after the form lands: tour conversion, booking, revenue, true CAC.

Bloom can. Every couple's full forensic record lives in the platform already. Surfacing the contrast between **what the agency reports** and **what the agency actually delivered** is the strongest single argument for Bloom in the boutique-venue segment. The headline:

> "Hawthorn says they got you 47 leads last quarter. Bloom can tell you that 22 of those were brand searches (not acquisition), 8 were Instagram-discovered couples who used Hawthorn's landing page as the intake form, and 17 were net-new — converting to 2 tours and 1 booking. Hawthorn's true CAC is $14,000, not $580."

The agency tracker is the substrate that makes this claim defensible.

## The pressure test, recorded once so we don't oversell

The headline above is achievable, but **load-bearing on three operator-side actions**:

1. **Pixel installed on the venue's marketing site.** Without cross-session attribution, Instagram-on-Monday → form-fill-on-Wednesday looks like "direct" traffic. *(Shipped — see "Site pixel" below.)*
2. **Google Ads OAuth grant.** Without GCLID resolution, brand-search vs non-brand split degrades from ~80% confidence (with OAuth + actual keyword + match type) to ~30% (utm_term hygiene). *(OAuth flow shipped; awaiting Google Cloud env-var setup.)*
3. **Calendly Q&A capture.** *("Where did you hear about us?" answers are extracted via Wave 15's discovery-source capture. Shipped before this wave; coverage logic in the TBH Report now reads it as live.)*

Without these, the report numbers are still useful, but they're a **lower bound** on real attribution coverage. The TBH Report explicitly discloses pixel/OAuth/Calendly status in every output so we never claim attribution we don't have. The honesty is the brand asset.

---

## What shipped, in dependency order

### 1. Entity layer (migrations 304/305)

The original v1, two migrations:

**`marketing_agencies`** — entity for the agency itself. Owned by either an `org_id` (Wedgewood-scale: one Hawthorn relationship shared across many venues) or a `venue_id` (single-venue Bloom customer). A CHECK constraint enforces exactly one. Carries name, website, contact info, default monthly retainer, performance fee %, free-text services array, notes, soft-delete.

**`venue_agency_engagements`** — M:N pivot between venues and agencies. Carries per-venue monthly fee, per-venue managed-channels array, scope description. One active engagement per (venue, agency) via partial unique index. Soft-delete preserves history.

**`marketing_spend_records.agency_id` + `marketing_channels.managed_by_agency_id`** — nullable FK columns added on existing tables so spend rows can be tagged to an agency and channels can declare "managed by this agency". Both ON DELETE SET NULL to preserve history when an agency is removed.

Why the two-table split: the **engagement** is where per-venue cost varies and where the channel mapping that drives attribution lives. Same agency, two venues, different monthly fees, different channel scopes. The `agency` is the relationship; the `engagement` is the contract.

### 2. ROI compute + first surface (commit e3c45f3)

**`computeAgencyROI(agencyId, venueIds, windowDays)`** — joins `engagement.managed_channels` → `attribution_events.source_platform` → `weddings.status` to answer the core question. Sums direct spend (rows tagged with `agency_id`) plus retainer accrual (engagement monthly fee × months in window). Returns spend / leads / tours / bookings / revenue / CAC / cost-per-lead.

UI under `/intel/agencies`: list with per-agency 90-day ROI cards, new/edit forms, detail page with the engagement panel. Nav entry under Intel → Conversion.

The honesty banner on the list page was added here on purpose. Operators landing on the page need to know upfront that attribution coverage degrades pre-pixel — the gap between "Bloom says 17 leads" and "true count" is real and acknowledged before they read any number.

### 3. Surfacing pass + dashboard depth + onboarding (commit 7314c29)

After the v1 audit identified seven gaps, all seven shipped:

- **Agency badge on `/intel/sources` scorecard.** Channel-key → agency map fetched client-side. Visual lift from 4/10 to 8/10 on surfacing.
- **Agency filter on the source-quality table.** Reuses the same map. "Show me only channels Hawthorn manages."
- **`computeAgencyBreakdown`** for per-channel rollup + 12-month trend + persona overlay. Persona counts read the `attribution_events.persona_overlay` column already populated by Wave 5A — that data was sitting unused.
- **Lead drill-down.** `GET /api/intel/agencies/[id]/leads` + `/intel/agencies/[id]/leads` page renders weddings whose first-touch landed on the agency's managed channels. ROI grid stats are clickable deep-links.
- **Profile depth (migration 307).** `agency_contacts` (multiple humans per agency, primary flag), `agency_documents` (URL-only at this point, contracts/reports), `agency_kpi_commitments` (what the agency promised), `agency_activity_log` (decisions / meetings / KPI events). Plus extensions on `venue_agency_engagements`: `channel_sub_budgets` jsonb, `reporting_cadence`, `dashboard_url`.
- **Spend form + channel config integration.** Agency dropdown on the spend manual entry; per-channel managed-by-agency picker on `/portal/marketing-channels-config`. Spend ingestion (`recordSpend` → payload `agency_id`) plumbed end-to-end.
- **Onboarding step.** Day 2 of the onboarding project flow gained a "marketing_agencies" step with link to `/intel/agencies`.

### 4. Depth pass — KPI truth-vs-claim + native uploads + TBH Report (commit 06e1685)

**`computeKpiPerformance`** — canonical metric registry mapping `leads_per_month`, `cost_per_lead`, `cac`, `tour_conversion_rate`, `booking_conversion_rate`, `roas`, etc. to derivations from the breakdown. Handles:

- **Window scaling** — per-month KPI compared against 90-day measurement divides count by 3; per-year KPI is **not** 4×-extrapolated (hockey-stick projection); engagement-windowed KPIs use raw counts.
- **Unit conversion** — cents↔usd auto-converts; unmappable mismatches return `not_measurable` with reasoning.
- **Too-early gating** — KPI in effect <30 days returns `too_early` regardless of actuals. Agencies get a fair shot.
- **Unmeasurable metrics** — impressions / brand_search_lift / share_of_voice are flagged with explicit "Bloom can't see this; here's where to look" instead of failing silently.
- **Confidence labels** — `high` (sample ≥30, no scaling), `low` (sample <10 or scaling from short to long window), `medium` otherwise.

The status semantics flow into both the agency-detail page (`AgencyKpiPerformanceSection`) and the TBH Report's KPI section.

**Native file uploads (migration 308).** Supabase Storage bucket `agency-documents` (private, 25MB cap), locked to service-role. `POST /api/intel/agencies/[id]/documents/upload` accepts multipart, validates MIME whitelist, uploads at path `{agency_id}/{doc_id}-{slug}.{ext}`, orphan-cleans on insert failure. `GET .../[documentId]/download` mints a 60-second signed URL and redirects. External URLs (Drive/Dropbox links pasted into the URL mode) pass through directly.

The bucket-locked-to-service-role design is deliberate: **the agency_documents row is the permission boundary**, not the storage object. Signed URLs derived from authenticated API access carry the access decision. This is simpler than per-object storage RLS and works at any scale.

**TBH Report.** Migration 308 also adds `public.tbh_reports` — persisted history keyed by `short_code` (`TBH-YYYY-Qq-XXXXX`). `snapshot` jsonb stores every number behind the LLM narrative so reports are reproducible even after upstream metrics drift.

`computeTbhReport` gathers ROI + breakdown + KPI performance + activity highlights + coverage disclosure in parallel, then calls Sonnet to generate executive summary, conflict findings, recommendations, and (in `shareable` mode) a cover note for forwarding to the agency. Two modes per the TBH brand-asset doctrine:

- **internal** — sharp framing, conflict-forward, operator alone reads it.
- **shareable** — collaborative framing, divergence-as-different-views, suitable for forwarding to the agency.

`/intel/agencies/[id]/tbh-report` is print-styled: `@media print` hides chrome, sets letter / 0.5" margin / `color-adjust: exact`, with `page-break-before` on each major section.

### 5. Follow-ups (this commit)

The three load-bearing infrastructure pieces from the pressure test, plus the smaller follow-ups noted during the depth-pass review:

#### Site pixel (migration 309)

- **`/public/bloom-pixel.js`** — ~3kb script venues paste into their marketing-site `<head>`. Sets a first-party `bloom_visitor_id` cookie (1-year max-age), reads UTM params + `gclid`/`fbclid`/`ttclid`/`msclkid`, POSTs to `/api/v1/visit` on every pageview via `navigator.sendBeacon` (falls back to `fetch` keepalive).
- **`/api/v1/visit`** — public CORS-open ingest endpoint. Validates the per-venue `pixel_ingest_key` (locally generated UUID, embedded in the snippet, rotatable from the config page). In-process rate limit at 240 hits/minute per key. Stamps `venue_config.pixel_installed_at` on the first successful POST so the TBH Report's coverage disclosure can read it.
- **`web_visits`** — anonymous-by-default. `anon_visitor_id` is the cookie value; `candidate_identity_id` is NULL until a form submission carrying the same cookie resolves the visitor. IP + UA hashed with per-venue salt — no raw values stored, no reversibility across venues.
- **`/portal/pixel-config`** — coordinator surface: shows install status, last-30-day visit count, copy-the-snippet button, rotate-key button (with explicit warning that the old snippet stops working immediately).
- **`linkWebVisitsToCandidate`** service function exists for the form-adapter integration that ties an anonymous visit cluster to a resolved candidate identity. Wiring the web-form adapter to call it is the one follow-up the pixel layer still needs — for now, the data is captured and queryable.

**Privacy floor decisions:** raw IP + UA never persisted. Cookie is first-party, no third-party. No PII captured client-side until the form submission with name + email arrives via the existing web-form adapter. These are deliberate boundaries — the pixel is forensic *enough* to close the cross-session gap without being surveillance-grade.

#### Google Ads OAuth scaffold (migration 310)

- **`google_ads_connections`** — token storage table. `access_token` + `refresh_token` stored as text (encryption-at-rest is a follow-up; the doctrine note in the migration calls out the pgsodium TODO). `status` enum (pending/connected/error/revoked) drives UI state. Service-role-only writes; authenticated SELECT exposes the row but the API layer never serializes the token fields.
- **`/api/integrations/google-ads/oauth/{start,callback}`** — full OAuth 2.0 flow. State token is an HMAC of `${venueId}:${nonce}:${ts}` signed with CRON_SECRET (no separate state table needed; 10-minute TTL embedded in the timestamp). Token exchange runs server-side via `fetch`. Tokens persisted to `google_ads_connections` via service-role.
- **`getValidAccessToken(venueId)`** — server-side helper that returns a fresh access token, transparently refreshing if expired. On refresh failure, marks the connection `status='error'`. Never returns tokens to clients.
- **`/settings/integrations/google-ads`** — coordinator surface. Shows connection status. When env vars are missing, surfaces a structured "Setup not complete" panel with the four required env vars and inline Google Cloud setup steps.

**Why this is a scaffold, not done.** Three things need to happen to make this real:

1. Isadora creates a Google Cloud project, enables the Google Ads API, creates OAuth client credentials, and applies for a developer token.
2. Four env vars get set in Vercel: `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_OAUTH_REDIRECT_URI`.
3. Once a venue connects, the next layer (customer-picker UI + GCLID-to-keyword sync into `attribution_events`) needs to run — currently the existing `google-ads.ts` spend connector handles spend pulls; keyword lookups extend that pattern.

The architecture is sound; the code is in place; deployment unblocks the rest.

#### Document download audit (migration 310)

- **`agency_document_downloads`** — one row per signed-URL mint. Logged BEFORE the redirect so closing the tab mid-redirect still leaves a trace.
- IP + UA hashed with per-document salt (no cross-document correlation possible).
- Becomes interesting when the agency-portal mode lands ("Hawthorn opened your Q2 contract on May 12"). The table is cheap to land now so the download endpoint can start writing rows immediately.

#### Activity auto-writers cron (`agency_activity_sweep`)

- Daily cron walks every active engagement.
- **`kpi_missed` detection:** runs `computeKpiPerformance` per agency, finds KPIs at status `miss`, suppresses duplicates within 14 days (checks recent activity log for matching `kpi_id` in payload).
- **`report_late` detection:** for engagements with `reporting_cadence` set, checks for a recent `report_received` activity. If none within the cadence-derived threshold (`weekly_email`=10d, `biweekly_call`=18d, `monthly_*`=38d, `quarterly_review`=100d), writes a `report_late` activity. `on_demand`/`other` cadences never auto-flag.

#### TBH monthly cron (`tbh_reports_monthly`)

- Runs at 09:00 UTC on the 1st of each month.
- Walks every agency with an engagement that overlaps the prior calendar month.
- Calls `computeTbhReport` in `internal` mode with `period_start`/`period_end` set to the prior month's bounds.
- Skips if a report already exists for the same (agency, period, mode) — operator-triggered regeneration uses the same upsert path so the cron and manual generation coexist.

Cost target: ~$0.05/report × N agencies. At 10 venues × 2 agencies each, that's ~$1/month in LLM spend. Trivial.

#### Orphan-document cleanup cron (`agency_document_orphans`)

- Weekly cron walks Supabase Storage for files whose `agency_documents` row was soft-deleted more than 30 days ago.
- Hard storage removal happens only past the retention window so accidental soft-deletes are recoverable for ~4 weeks.
- Batched at 100 paths per `storage.from().remove()` call.

#### Smaller UX polish

- **CSV bulk-spend agency tagging:** new "Tag every row with agency" dropdown above the CSV paste textarea. Agency tag applied to every row in the batch.
- **Contact edit UI:** `ContactsSection` rows gain an Edit button that inlines the form (reuses the same `ContactForm` component with an `existing` prop; the service already had `updateContact` waiting for a UI).
- **Engagement picker on documents:** `DocumentForm` accepts an `engagements` prop and renders an optional dropdown ("scope: all engagements" / specific engagement). Writes `agency_documents.engagement_id`.

#### TBH Report coverage logic now reads live state

Coverage disclosure used to hardcode `pixel='not_installed'`, `googleAdsOAuth='not_connected'`, `calendlyQa='webhook_only'`. After this batch:

- Pixel state reads `venue_config.pixel_installed_at` (NULL = not installed, populated = installed at that date).
- Google Ads OAuth state reads `google_ads_connections.status` (connected vs not).
- Calendly Q&A reads `discovery_sources` row count for the venue (>0 = capturing, 0 = webhook-only).

The TBH Report no longer claims gaps that have been closed.

---

## File map

Backend:

```
supabase/migrations/304_marketing_agencies.sql            entity tables
supabase/migrations/305_agency_spend_channel_linkage.sql  FK columns
supabase/migrations/307_agency_profile_depth.sql          contacts/docs/kpis/log + engagement extras
supabase/migrations/308_agency_storage_and_tbh_reports.sql storage bucket + tbh_reports
supabase/migrations/309_web_pixel.sql                     web_visits + pixel_ingest_key
supabase/migrations/310_google_ads_and_downloads_audit.sql google_ads_connections + downloads audit

src/lib/services/intel/marketing-agencies.ts              core ROI + breakdown + CRUD
src/lib/services/intel/marketing-agency-profile.ts        contacts/docs/kpis/activity CRUD
src/lib/services/intel/marketing-agency-kpi-performance.ts truth-vs-claim resolver
src/lib/services/intel/marketing-agency-tbh-report.ts     TBH Report + LLM narrative
src/lib/services/intel/marketing-agency-cron.ts           cron implementations
src/lib/services/intel/web-pixel.ts                       pixel-config + link-visits helper
src/lib/services/integrations/google-ads-oauth.ts         OAuth + token persistence
```

APIs:

```
/api/intel/agencies                                  list / create
/api/intel/agencies/[id]                             read / patch / delete
/api/intel/agencies/[id]/engagements                 upsert engagement
/api/intel/agencies/[id]/engagements/[engagementId]  end / soft-delete
/api/intel/agencies/[id]/roi                         90-day ROI summary
/api/intel/agencies/[id]/breakdown                   per-channel + 12-month trend
/api/intel/agencies/[id]/leads                       drill-down list
/api/intel/agencies/[id]/contacts (+ [contactId])    profile depth — contacts
/api/intel/agencies/[id]/documents                   URL-mode list / create
/api/intel/agencies/[id]/documents/upload            multipart file upload
/api/intel/agencies/[id]/documents/[documentId]      delete
/api/intel/agencies/[id]/documents/[documentId]/download  signed-URL redirect + audit row
/api/intel/agencies/[id]/kpis (+ [kpiId])            profile depth — KPI commitments
/api/intel/agencies/[id]/kpi-performance             truth-vs-claim resolver
/api/intel/agencies/[id]/activity (+ [activityId])   timeline
/api/intel/agencies/[id]/tbh-report                  latest TBH report + regenerate

/api/portal/marketing-channels                       channels lookup (for managed-by picker)
/api/portal/pixel-config                             pixel key + status / rotate

/api/v1/visit                                        public pixel ingest

/api/integrations/google-ads/status                  configured? connected?
/api/integrations/google-ads/oauth/start             begin OAuth
/api/integrations/google-ads/oauth/callback          finish OAuth

/api/cron/agency-activity-sweep                      standalone (ad-hoc)
/api/cron/tbh-reports-monthly                        standalone (ad-hoc)
/api/cron/agency-document-orphans                    standalone (ad-hoc)
/api/cron?job=agency_activity_sweep                  Vercel-fired
/api/cron?job=tbh_reports_monthly                    Vercel-fired
/api/cron?job=agency_document_orphans                Vercel-fired
```

UI:

```
/intel/agencies                                      list
/intel/agencies/new                                  create
/intel/agencies/[id]                                 detail (ROI / engagement / profile / KPI truth / activity)
/intel/agencies/[id]/edit                            profile edit
/intel/agencies/[id]/leads                           drill-down
/intel/agencies/[id]/tbh-report                      print-styled TBH Report

/portal/pixel-config                                 pixel install
/portal/marketing-channels-config                    (extended with managed-by picker)
/settings/integrations/google-ads                    OAuth + setup instructions
```

Cron (`vercel.json`):

```
agency_activity_sweep    daily   06:30 UTC
tbh_reports_monthly      monthly 09:00 UTC on the 1st
agency_document_orphans  weekly  02:00 UTC Sunday
```

Prompts (`PROMPTS-CHANGELOG.md`):

```
tbh-report.prompt.v1.0   Sonnet, internal vs shareable modes, ~$0.05/report
```

---

## Doctrine to preserve

If you touch this code, hold these:

1. **The agency_documents row is the permission boundary.** Storage objects sit behind a service-role-only bucket. All reads route through `/api/intel/agencies/[id]/documents/[documentId]/download` which checks RLS on the row, mints a 60-second signed URL, and redirects. Never widen storage RLS to authenticated.

2. **Tokens never reach the client.** `google_ads_connections.access_token` + `refresh_token` are SELECT-able by authenticated users (RLS permits) but the API layer's `/status` endpoint deliberately strips them from the response. If you add a new API path that touches the table, do the same.

3. **The TBH Report's coverage disclosure must be honest.** When you add a new attribution substrate (e.g. wire up the form-adapter ↔ pixel linkage), update `buildCoverage` in `marketing-agency-tbh-report.ts` to read the live state. Don't hardcode `'not_installed'` after the thing is installed.

4. **KPI resolver is the metric oracle.** When a new canonical metric becomes measurable, add it to `METRIC_REGISTRY` in `marketing-agency-kpi-performance.ts`. When a metric stays unmeasurable, add it to `UNMEASURABLE_METRICS` with a useful "look elsewhere" hint. Silent failure on an unknown metric is the failure mode to avoid.

5. **Idempotency at every layer.** Crons re-run safely. Spend ingest is unique-constrained. Report generation upserts on (agency, period, mode). Storage uploads pre-allocate the doc UUID so a retry never duplicates. If you add a new write path, ask: what happens if this fires twice in the same minute?

6. **LLM is the primitive** (Wave 4-5-6 doctrine). The TBH Report narrative uses Sonnet. Don't replace it with templated copy "to save tokens" — the LLM call is the differentiator vs every other CRM's automated reports. Cost is bounded by persistence + operator-triggered regeneration.

7. **Constitution-aligned forensics.** `web_visits` is a PRE-ZERO candidate signal in the Constitution sense (`bloom-constitution.md`). The resolver promotes web_visits → candidate_identity → wedding the same way Knot CSV signals do. If you wire form-adapter ↔ pixel linkage, walk that chain; don't shortcut it.

---

## What's still deferred (and why)

- **Form-adapter ↔ pixel linkage.** The web-form adapter doesn't currently forward `bloom_visitor_id` to the candidate resolver. `linkWebVisitsToCandidate` exists as a service helper; wiring it into the adapter is a one-line addition that needs careful path-testing against the existing form-import flow. Half a day, when the next person who works in `crm-import/web-form.ts` is in there anyway.

- **GCLID → keyword sync.** Google Ads OAuth deposits tokens. The existing `google-ads.ts` connector already pulls spend; extending it to query the keywords API and write canonical keyword/match-type back to `attribution_events` is the layer that flips the brand-search disclosure from "approximate" to "definitive". Two days, after the venue actually grants OAuth.

- **Token encryption at rest** (pgsodium wrap on `google_ads_connections.access_token`/`refresh_token`). Documented as a TODO comment in the migration. Should land before any live ads account connects.

- **Agency-portal mode.** Memory says wait until 5+ venues use TBH Reports. Reasonable.

- **TBH Report tier-gating decision.** Open product question.

- **Hawthorn-as-launch-partner.** Open business question.

---

## Closing note

The agency tracker is the most-pressure-tested surface in Bloom because it carries the most-public claim. The TBH Report is the artifact that has to survive a venue forwarding it to their agency and the agency reading it in adversarial mode. Every number that ships through this code needs to either be defensible from first principles or labeled honestly as low-confidence. The honesty banners and coverage disclosures aren't decoration — they're the brand asset.
