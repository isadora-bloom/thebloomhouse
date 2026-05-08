# Service-Level Agreement

**Tier-C #137**
**Owner:** Isadora Martin-Dye
**Last reviewed:** 2026-05-08

---

This is the written commitment Bloom House makes to enterprise +
multi-venue customers regarding uptime, support response, and
incident handling. Customers below the **multi** plan tier follow
the same operational practices in spirit but do not have a
contractual SLA — they get best-effort support.

The numbers in this draft are **starting commitments**, calibrated
to what a small operations team can credibly deliver. They tighten
as the team grows; they don't tighten as a marketing claim.

---

## 1. Uptime commitment

**Multi tier:** 99.5% monthly uptime
**Enterprise tier:** 99.9% monthly uptime

Calculated against the public-facing application surface
(thebloomhouse.ai + couple-portal subdomain). Excludes scheduled
maintenance windows announced ≥ 48 hours in advance.

What counts as downtime:
- HTTP 5xx errors > 1% of requests for 5 consecutive minutes
- Inability to log in for any authenticated coordinator for > 5
  consecutive minutes
- Couple portal unable to load `/couple/[slug]` for > 10 consecutive
  minutes

What does NOT count as downtime:
- Slow responses inside the 95th-percentile latency budget
- Third-party outages (Anthropic, OpenAI, Stripe, Resend, Google) —
  Bloom serves cached responses + degraded paths, but if the
  underlying provider is down, downstream features are too. We
  surface a status banner to coordinators instead.
- Scheduled maintenance announced ≥ 48 hours ahead

How we measure: Vercel uptime monitoring + an internal canary
heartbeat that pings login + couple-portal + the Sage API every 60
seconds. Monthly uptime calculation aggregates the heartbeat data.

Status page: TBD — `status.thebloomhouse.ai` (placeholder for
post-Wedgewood-deal commitment when the operational complexity
warrants a public status page).

---

## 2. Support response

**Severity 1 (production down for the customer):**
- Acknowledgment: within 2 hours, 24/7
- Engineer engaged: within 4 hours
- Status update cadence: every 2 hours until resolved

**Severity 2 (functional degradation, workaround exists):**
- Acknowledgment: within 1 business day
- Engineer engaged: within 2 business days
- Status update cadence: daily until resolved

**Severity 3 (questions, feature requests, non-critical bugs):**
- Acknowledgment: within 2 business days
- Resolution / closure: within 30 days OR explicit deferral with
  reason + revised target

**Business hours:** 9 AM - 5 PM ET, Monday through Friday,
excluding US federal holidays.

**Out-of-hours coverage (SEV1 only):** Currently solo-founder on
call. Acknowledgment honoured 24/7 for SEV1 only; non-SEV1 issues
queue to next business day.

When the team grows past one engineer, this section is revised to
reflect a real on-call rotation. Until then, customers signing the
multi or enterprise tier should know solo-founder is the operational
reality.

---

## 3. Incident communication

For every SEV1 + SEV2:

- **During incident:** status updates posted to the affected
  customer's primary contact (email) and the in-app banner.
- **Post-mortem:** written summary delivered within 7 days of
  resolution. Covers: what happened, what we knew when, what we
  did, what we'll do differently. Shared with the affected customer;
  generic version posted internally for team learning.
- **Root cause + remediation:** identified for every SEV1; remedied
  with a code change or process change within 30 days when the cause
  is in our system.

For sub-processor incidents (Anthropic outage, Supabase incident,
etc.) we pass through the upstream post-mortem with our own
contextual analysis: what features were affected, what fallback
behaviour kicked in, what we learned about our resilience to that
specific failure mode.

---

## 4. Data export + termination

Customers can export their data at any time via the existing
data-portability endpoints (`/api/agent/me/export`,
`/api/couple/me/export`). The export bundle is documented in
`vendor-security-review.md` §9.

On contract termination:
- Customer has 30 days to export their data (extendable to 60 days
  on written request).
- After 30 days from termination, data is deleted from the active
  database. A backup may persist for 7 days per Supabase's standard
  retention before final purge.
- Audit-log entries pertaining to the customer are retained per
  the audit-retention policy (730 days from `vendor-security-review.md`
  §6).

---

## 5. Maintenance windows

Scheduled maintenance windows are announced ≥ 48 hours in advance via:
- Email to the customer's primary contact
- In-app banner for the duration of the window

Default maintenance window: **Tuesday 06:00-08:00 UTC**. We try to
keep maintenance windows < 30 minutes; the 2-hour window is a
buffer.

Emergency maintenance (security patch, data integrity fix) may be
scheduled with less notice. We commit to ≥ 1 hour notice for
non-data-integrity emergencies and best-effort notice for active
incidents.

---

## 6. What this SLA does NOT cover

Honest disclosure of out-of-scope items:

- **Force majeure:** AWS region outage, ISP outages, internet
  backbone disruption, natural disaster, etc. We restore service
  ASAP but the SLA clock pauses.
- **Customer-caused outages:** misconfigured DNS, credential
  rotation that locks out their own users, mistakes in the
  brain-dump that import bad data and lock up workflows.
- **Sub-processor outages where we serve degraded paths
  successfully:** Anthropic down, Sage replies fall back to
  templated responses — that's a feature, not downtime.
- **Beta features:** anything labeled "beta" in the UI is excluded
  from SLA. Beta features are released for feedback, not for
  production reliance.
- **Free tier / starter / solo / growth plans:** these get
  best-effort support, no contractual SLA.

---

## 7. Contract precedence

When a signed customer contract specifies different SLA terms (e.g.
a Wedgewood-tier MSA with custom uptime commitments), the contract
governs and this document serves as the default. Contract precedence
is documented per-customer in `legal/contracts/`.

---

## 8. Review + revision

This document is reviewed quarterly. The next-revision trigger
conditions:
- Bloom House team grows past one engineer (rotation + after-hours
  coverage tightens)
- First SEV1 incident provides real data on response times achieved
  vs committed
- Wedgewood-tier customer contract demands stricter terms (those
  contract terms then become the default)

---

## 9. Customer contact

For SLA inquiries, contract negotiations, or to escalate an
unresolved support issue:

- **Primary contact:** isadora@rixeymanor.com
- **Future SLA escalation:** sla@thebloomhouse.ai (once configured)
- **Emergency only:** TBD — will be provisioned when the team
  establishes 24/7 on-call rotation.
