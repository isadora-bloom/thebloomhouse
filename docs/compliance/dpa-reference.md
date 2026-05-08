# Sub-processor + DPA reference

**Tier-C #122**
**Owner:** Isadora Martin-Dye
**Last reviewed:** 2026-05-08

---

This is the canonical sub-processor list for Bloom House. Every vendor
that handles **any** customer personal data on our behalf appears
here. A prospective customer asking "who else sees our data?" gets
this page (or a derivative of it) as the answer.

The list is **append-only**. When a sub-processor is added, the row
is added; when one is removed, its row is marked retired with the
removal date — it does not disappear, so historical incident response
can still cite it.

---

## Active sub-processors

| Vendor | Role | Categories of personal data | Hosted in | DPA / contract reference |
|---|---|---|---|---|
| **Supabase** | Primary database + file storage + auth | All customer data of record: venue, couple, interactions, drafts, contracts, photos | AWS us-east-2 (Ohio) | <https://supabase.com/legal/dpa> |
| **Vercel** | Application hosting + edge | None persisted; logs (request URL, headers, response codes) retained 7 days | Global edge / us-east-1 | <https://vercel.com/legal/dpa> |
| **Anthropic** | AI inference (primary) | Email body excerpts, brain-dump notes, Sage chat content during inference only — zero retention via tier-1 ZDR contract | US (region varies) | <https://www.anthropic.com/legal/commercial-terms> + ZDR amendment |
| **OpenAI** | AI inference (fallback) | Same as Anthropic; `store: false` flag on tier-1 calls | US (region varies) | <https://openai.com/policies/data-processing-addendum> |
| **Stripe** | Payment processing | Card data (PCI scope contained to Stripe-hosted checkout); customer billing email | US | <https://stripe.com/legal/dpa> |
| **Resend** | Transactional email (digest, password reset, briefings) | Recipient email + body of system emails | US (us-east-1) | <https://resend.com/legal/dpa> |
| **Google (Gmail API)** | Coordinator → couple email channel | OAuth refresh tokens + transient body access during pipeline poll. Does NOT store mail bodies — pulls + classifies + retains classification metadata only. | Google global | Google Cloud DPA: <https://cloud.google.com/terms/data-processing-addendum> |
| **SerpAPI** | Search-trends ingest (Google Trends data) | Search term keywords (no PII; venue-scoped query strings only) | US | <https://serpapi.com/legal> — DPA on request |
| **NOAA + Open-Meteo** | Weather data ingest | None — public meteorological data only | US | Public-domain data; no DPA |
| **FRED (St. Louis Fed)** | Macroeconomic indicators ingest | None — public economic data | US | Public-domain data; no DPA |

---

## Categories of personal data — what flows where

| Data category | Who touches it |
|---|---|
| Couple name + email + phone | Supabase (storage), Anthropic (inference of inquiry/Sage drafts), Resend (digest emails — coordinator only, never to couple) |
| Wedding details (date, guest count, budget, allergies) | Supabase, Anthropic |
| Coordinator login + auth | Supabase Auth, Stripe (billing email) |
| Coordinator → couple email content | Supabase (interactions table — body excerpt + classification), Google Gmail API (poll source), Anthropic (classification + draft generation) |
| Couple-uploaded files (contracts, photos) | Supabase Storage only |
| Vendor names / contracts | Supabase, Anthropic (contract extraction) |
| Card / payment | Stripe only — never reaches Bloom servers |
| Search terms (for trends) | SerpAPI (no PII; venue-keyworded search queries) |

---

## Onboarding a new sub-processor — the checklist

Adding a new vendor that touches customer data requires going through
this checklist before they go live:

1. **Confirm necessity.** Can existing sub-processors do the job? Each
   added vendor is an attack surface and a contract obligation.
2. **Read their DPA.** Does it cover GDPR / CCPA / VA / NC? If they
   don't have a public DPA, ask for one in writing before signing.
3. **Confirm sub-processor sub-processors.** Some vendors disclose
   their own sub-processor list. Read it; some surprise you (e.g., a
   "US-hosted" vendor with a Heroku dependency that runs in EU).
4. **Confirm region.** US-only customers want US-hosted vendors. Add
   a row to `data-region-and-scc.md` if the new vendor's region is
   notable.
5. **Add to this file.** Add the row + the DPA link. Update the data
   category table.
6. **30-day customer notice.** If a customer's contract requires
   prior notice for new sub-processors (Wedgewood-scale customers
   often do), send notice and wait before going live.
7. **Update `vendor-security-review.md`** if the new vendor changes
   the answer to a "do you use X?" question that comes up regularly.

---

## Retired sub-processors

None retired yet — Bloom House is young. When the first one is dropped,
add a row with status: retired, removal date, and forwarding pointer
if the customer data touched was migrated.

---

## Customer-facing version

A customer-friendly subset of this list (vendor + role + region —
without the DPA URLs and internal-decision context) belongs at
`/legal/sub-processors` on `thebloomhouse.ai`. As of this review the
public list is still TODO.

When that page ships, it must:
- mirror the active-sub-processors table from this doc
- have an email signup ("notify me before a new sub-processor is
  added") for enterprise customers
- be revisable in lockstep with this doc — single source of truth here

---

## Cross-references

- `data-region-and-scc.md` — where each vendor's region is documented
- `vendor-security-review.md` — Bloom House security posture vs each
  vendor's posture
- `breach-notification-runbook.md` — sub-processor breach is still
  our customer-facing breach
