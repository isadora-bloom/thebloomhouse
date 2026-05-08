# Bloom House — vendor security review

**Tier-C #127**
**Owner:** Isadora Martin-Dye
**Last reviewed:** 2026-05-08

---

This is the document Bloom House sends to a prospective customer
asking "how secure are you?" — usually a venue operator's IT team or
an enterprise procurement office. It is **deliberately concise and
specific**. We are a small team; pretending to be SOC-2-certified
when we are not is a faster way to lose trust than admitting we are
on a path to it.

**Audience:** non-technical procurement (with a CISO peer-reviewing).
**Reading time:** ~10 minutes.

---

## 1. About Bloom House

Bloom House is the wedding venue intelligence platform that pulls a
venue's email, calendar, financial, and external-context data into a
single AI-driven workflow. Customer base: wedding-venue operators in
the United States. Founded 2026 by Isadora Martin-Dye, owner-operator
of Rixey Manor (Jeffersonton, VA).

The platform handles three categories of customer data:

- Coordinator side: venue + coordinator profiles, email content,
  drafts, audit logs.
- Couple side: planning content (timeline, budget, guest list, vendors,
  AI conversation), file uploads (contracts, photos).
- External: macroeconomic indicators, weather, search trends. **No
  PII in this category.**

---

## 2. Hosting + data flow

Detailed in `data-region-and-scc.md`. Summary:

- Database: Supabase (managed Postgres + auth + storage) on AWS
  us-east-2. Encrypted at rest by default. Point-in-time recovery
  enabled.
- Hosting: Vercel. Functions execute in us-east-1; edge serves cookies
  + middleware globally. No customer data persists on Vercel.
- AI: Anthropic primary, OpenAI fallback. Both contracted under
  zero-retention terms for tier-1 content (PII-bearing email + chat).

A complete sub-processor list lives at `dpa-reference.md`. Customers
can subscribe to advance notice of new sub-processors before they
are added.

---

## 3. Authentication + access control

- Coordinator login: Supabase Auth, email + password. Magic links
  available for first-time setup. Password policy: minimum 8 chars,
  zxcvbn strength check, plus standard supabase rate-limiting.
- Couple login: Supabase Auth tied to a wedding via event-code +
  email at registration. Cap of 2 user_profiles per wedding.
- MFA: not yet enforced for coordinators. Roadmap item; default-on
  TOTP planned alongside Tier-C demo/prod separation work.
- Authority levels: `super_admin`, `org_admin`, `manager`,
  `coordinator`, `couple`, `readonly`. Each is distinct + explicit
  in API auth checks.
- Row-level security: every customer-data table has RLS enabled.
  Demo data uses a separate policy from real-customer data. Round 7
  + 9 audits (2026-05-07/08) closed the leakage paths between them.

---

## 4. Data segregation

Bloom House operates as a multi-tenant platform. Customer data is
segregated at three layers:

- **Database**: shared Supabase project with Postgres RLS scoped on
  `venue_id` (or `org_id` for organization-spanning queries). Service
  role bypass is restricted to backend code — never the browser
  client. The Round 8 verification audit (2026-05-07) confirmed RLS
  enforcement across all 230+ migrations.
- **Storage**: Supabase Storage buckets are venue-scoped via prefix
  policies. Owner photo URLs are validated to require Supabase Storage
  public URLs (Round 6 audit fix); arbitrary URLs cannot be stored as
  third-party data exfil vectors.
- **AI inference**: per-call context is venue-scoped. The AI client
  (`lib/ai/client.ts`) does not maintain conversation state between
  unrelated venues; each call is stateless.

Per Tier-C #112 (in roadmap), demo and prod will move to separate
Supabase projects. Today they share one project segregated by RLS.
Customers asking for a hard project-level separation should be
flagged for the Tier-C delivery.

---

## 5. Encryption

- **In transit**: TLS 1.2+ for all customer-facing endpoints. Vercel
  enforces HTTPS-only. Supabase enforces TLS on all connections.
- **At rest**: Supabase Postgres default at-rest encryption (AES-256
  via AWS RDS). Supabase Storage objects encrypted at rest.
- **Application-level encryption**: NOT applied to PII fields. The
  service-role key is the protective boundary, not column-level
  encryption.
- **Key management**: Supabase service-role key + Anthropic /
  OpenAI / Stripe / Resend / Google API keys held in Vercel env
  vars. Rotation procedure documented in `OPS.md` and the credential
  recovery playbook.
- **Backups**: Supabase Pro plan includes daily backups + 7-day
  point-in-time recovery. Supabase manages backup encryption.

---

## 6. Logging + monitoring

- **Read-side audit log**: every tier-1 read on `lead_insights`,
  `journey_narrative`, `weddings_rollup`, and the export endpoints
  writes to `activity_log`. Retention 730 days (Tier-C #132).
- **Bulk-read anomaly detection**: nightly cron flags users whose
  read volume crosses thresholds (500 rows/5min OR 50 events/5min OR
  5000 rows/24h OR 200 events/24h) — admins are notified
  venue-broadcast.
- **Application observability**: structured JSON logs via
  `lib/observability/logger.ts`. Required fields: `level`, `msg`,
  `venue_id`, `correlation_id`, `actor`, `event_type`, `outcome`,
  `latency_ms`. PII redaction wraps every emit.
- **Cost telemetry**: every AI call logged to `api_costs` with
  prompt-version pinning so prompts can be audited per output. Daily
  cost ceiling at $5/venue/day with 80% notify + 100% pause.

---

## 7. Incident response

`INCIDENT.md` at the repo root defines:

- Severity classifications (SEV1 / SEV2 / SEV3)
- On-call rotation (currently solo founder; rotation forms when team
  grows past one engineer)
- Internal communication channel (Notion `INCIDENT-YYYY-MM-DD-*`)
- Customer notification timing (SEV1: within 24h; SEV2: within 72h)
- Post-mortem requirement for every SEV1 + SEV2

State-by-state PII breach notification timing in
`breach-notification-runbook.md`. Default response: 30 days for any
state, even those with looser statutory windows, so Bloom is clean
under the strictest applicable law.

---

## 8. Vulnerability management

Detailed in `vulnerability-management.md`. Summary:

- Dependency scanning via npm audit on every CI run.
- Manual quarterly review of CVE feeds for our stack
  (Next.js / Supabase JS / Anthropic SDK / OpenAI SDK).
- Patch SLA: critical CVE → 24 hours, high → 7 days, medium →
  next sprint.
- External penetration test cadence documented in the same doc;
  first formal pen-test gates Wedgewood-scale customer onboarding.

---

## 9. Data retention + deletion

- **Coordinator + couple data of record** (interactions, drafts,
  weddings, planning content): retained for the duration of the
  subscription + 30 days, then deleted on customer request OR on
  account closure.
- **Audit log**: 730 days (Tier-C #132).
- **Telemetry** (api_costs, cron_runs, metered_events): 30-90 days
  via `prune_telemetry` cron.
- **Rate-limit buckets**: 7 days standard, 91 days for compliance
  buckets so 30/90-day request limits are not silently defeated.
- **Lead score history** (`lead_score_history`): 365 days, drives
  heat-trajectory bucketing.
- **Couple-side erasure**: implemented at
  `/api/couple/me/erase` and `/api/agent/me/erase`. The
  consumer_requests admin queue at `/super-admin/consumer-requests`
  is the operator-side processing surface. SLA 45 days.
- **Couple-side data export**: `/api/couple/me/export` returns a JSON
  bundle of every wedding-keyed row.

---

## 10. What we do NOT do (yet)

Honest disclosure of gaps. These are roadmap items, not denied
capabilities. A customer asking about any of these should be flagged
as a possible Wedgewood-tier or enterprise-tier prospect.

- **SOC 2 Type 1**: not yet attained. Tier-C #121 in the launch plan
  scopes the path. Earliest attainability: Q2 2027 conditional on
  Series A funding.
- **HIPAA**: out of scope. Bloom does not handle PHI. We do not
  market to medical / wellness venues that might include PHI.
- **PCI DSS**: out of scope. PCI scope is contained to Stripe-hosted
  checkout. We do not see card numbers.
- **Hardware MFA**: roadmap item for coordinator-tier accounts.
- **Customer-managed encryption keys (CMK / BYOK)**: not supported.
  Encryption is provider-managed (Supabase / AWS).
- **On-premise deployment**: not supported. Bloom is multi-tenant
  cloud-only.
- **Data residency in Europe**: not supported today. EU venue
  onboarding triggers the SCC + region-pinning playbook in
  `data-region-and-scc.md`.
- **Single Sign-On (SAML / OIDC)**: roadmap item. Currently
  email + password + magic-link only.

---

## 11. Useful contact addresses

- **Security disclosure**: `security@thebloomhouse.ai` (TBD — until
  set up, send to `isadora@rixeymanor.com`).
- **Privacy / DSAR**: `privacy@thebloomhouse.ai` (TBD — until set up,
  same fallback).
- **General contract questions**: `isadora@rixeymanor.com`.

---

## 12. Document control

This doc lives at `docs/compliance/vendor-security-review.md` in the
private Bloom House repository. The customer-facing version is
periodically published as a static PDF. The authoritative version is
always the latest commit on `master`.

Review cadence: every quarter, OR when a sub-processor / hosting region
/ access-control / authentication change makes a section out of date.
