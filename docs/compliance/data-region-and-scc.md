# Data region + cross-border transfer mechanism

**Tier-C #119**
**Owner:** Isadora Martin-Dye
**Last reviewed:** 2026-05-08

---

## Where customer data physically lives

| System | Region | Provider | What it holds |
|---|---|---|---|
| Primary database | **AWS us-east-2 (Ohio)** | Supabase | All venue + couple + interaction data; the `weddings`, `interactions`, `drafts`, `people` core tables |
| File storage (couple photos, contracts, vendor files) | **AWS us-east-2 (Ohio)** | Supabase Storage buckets | Per-bucket: `contracts`, `couple-photos`, `vendor-contracts`, `venue-assets`, `inspo-gallery` |
| Application hosting + edge | **Global edge — request handling** / **us-east-1 — function execution** | Vercel | No persisted customer data on Vercel; functions are stateless. Logs retained 7 days. |
| AI inference | **us-east-1 / us-west-2** (varies by model) | Anthropic | Inference is zero-retention for tier-1 content (see `lib/ai/client.ts` `tier?` param). Anthropic ZDR is org-level. |
| AI fallback inference | **us-east-1** | OpenAI | Same zero-retention contract via `store: false` flag for tier-1 content. |
| Transactional email | **us-east-1 / EU varies** | Resend | Outbound copies of system emails (digest, briefings, password reset). Does NOT touch coordinator → couple email — that goes via Gmail. |
| Payment | **us-east-1** | Stripe | PCI scope contained to Stripe-hosted checkout. We never see card numbers. |
| Coordinator → couple email | **Google data centers — global** | Google (Gmail API) | Coordinator-owned Gmail mailboxes. We hold OAuth refresh tokens, never message bodies long-term — we read on poll, classify, store the classification + a body excerpt in `interactions`. |

**Single sentence to a CISO:** "All customer data of record sits in
Supabase in AWS Ohio (us-east-2). Inference runs in US AWS regions
under zero-retention contracts. The coordinator's Gmail mailbox is
their own — we hold a refresh token but the original mail lives in
Google's infrastructure."

---

## Customer base today

All paying customers and pilot venues operate in the **United States**.
We do not currently market to or onboard EU-resident venues.

This means **GDPR transfer mechanisms (SCCs / adequacy decisions) are
not engaged today**. They become relevant the moment we (a) onboard a
venue with EU operations, or (b) onboard a venue whose couples are
EU-resident data subjects.

The decision to expand to EU venues is a **customer-pull decision**,
not a sales-push one. When the first EU prospect appears, this section
gets rewritten and the SCC trigger is real.

---

## When SCCs become required

Three triggers, any one of them flips this from "documented
non-applicable" to "we ship SCCs":

1. **Venue is EU-resident** (corporate entity in an EU member state).
2. **Venue's couple base is meaningfully EU-resident** — i.e., the
   couples whose data flows through Bloom are EU data subjects.
3. **A US customer specifically requests SCC coverage** as a contract
   precondition. (Some enterprise procurement teams default to this
   even for US-only data.)

---

## When that day comes — the SCC playbook

Module 2 (controller-to-processor) of the EU Standard Contractual
Clauses (Commission Implementing Decision (EU) 2021/914) is the right
template. We are the processor; the venue is the controller of its
couple data.

The four-step rollout looks like this:

1. **Sign Module 2 SCCs with the venue** as part of the venue's
   subscription contract. Pre-fill: data categories (couple contact +
   wedding logistics + AI conversation history); processing duration
   (subscription term + 30 day deletion grace); transfer destination
   (US). Annex II (technical safeguards) cribs from
   `vendor-security-review.md`.

2. **Verify each sub-processor in `dpa-reference.md` carries
   onward-transfer SCCs** with their own EU customers. As of this
   review date: Supabase, Anthropic, OpenAI, Stripe, Resend, Vercel,
   Google all do. (Verify in their public DPA at SCC sign time —
   contracts move.)

3. **Run a Transfer Impact Assessment (TIA)** for the route. The
   short-form TIA Bloom would write: "US data destination, no
   government access concerns specific to wedding-venue communications,
   FISA 702 risk is theoretical and mitigated by encryption-in-transit
   + at-rest. Sub-processor onward transfers all covered by their own
   DPA."

4. **Add an EU data subject DSAR pathway** to the existing erasure +
   portability endpoints (`/api/couple/me/{erase,export}`). Currently
   the consumer_requests ledger is jurisdiction-agnostic by design;
   the only EU-specific thing we'd add is the 30-day SLA tripwire (vs
   the 45 we use today for CCPA compliance).

---

## What lives outside the US right now

Nothing structurally. Two soft exceptions to be aware of:

- **Anthropic / OpenAI inference traffic** is routed by the provider
  to whichever US region has capacity. We do not pin a region and the
  providers do not commit to one for non-enterprise tiers. From an
  SCC standpoint this is still a US-bound transfer.
- **Vercel edge** evaluates middleware at the closest edge to the
  user's IP. Middleware reads cookies + the request URL but NEVER
  customer DB rows — those are pulled from Supabase only inside the
  regional function in us-east-1. Edge evaluation is a transit hop
  with no persisted state; treated as in-transit data, not a
  cross-border transfer.

---

## Region change procedure

If we ever move the primary database (e.g., to a co-located region for
a Wedgewood-scale customer in California, or to an EU region for a
European pilot), the change is a **two-week supervised migration**:

1. Spin up a second Supabase project in the new region.
2. Use Supabase project-level replication (paid feature) to mirror.
3. Cut DNS + env vars + Stripe webhook URL atomically inside a
   pre-announced maintenance window.
4. Hold the old project read-only for 30 days as rollback insurance.
5. After 30 days, rotate service-role key + dump-and-shred the old
   project.

This is the same playbook as Tier-C #112 (demo/prod separation) — the
mechanics are identical, the only difference is the destination region.
