# Future ideas

**Date:** 2026-05-08
**Owner:** Isadora Martin-Dye

Parking lot for ideas raised but deliberately deferred. Each entry
has a "why parked" so a future revisit knows what changed.

---

## Couple identity profile (from B2 expansion, 2026-05-08)

**The seed idea:** demographic data on couples and their families is
intelligence we are leaving on the table. Not just "where do guests
come from" - the much richer picture:

- Couple's home address
- Each parent's home address (4 addresses)
- Each partner's job / occupation / employer
- Number of children (existing, from prior relationships)
- Age range or specific ages of couple
- Household income proxy (from address, job)
- Both parents' professional networks (likely overlap with guest list)

**Why it aligns with Bloom's thesis (constitution: forensic identity
reconstruction):**

- Better cross-source identity resolution. An inbound "Jane R."
  inquiry is hard to match to a known prospect by name alone; home
  address or employer pinpoints exactly which Jane.
- Reactivation graph. Couples whose parents work at company X are
  more likely to recommend the venue to coworkers in zip code Y.
- Pricing intelligence. Zip code is a strong income proxy.
- Multi-touch attribution. Parent's network is often where the
  initial recommendation came from. Today we cannot trace that.
- Vendor recommendations. Recommend a florist closer to the couple's
  actual home, not the venue's home.
- Travel + hotel block math. Pre-compute hotel block size based on
  actual out-of-state guest density, not coordinator estimate.

**Why parked:**

This is a meaningful product direction, not a 60-min code change.
Open questions before we ship anything:

- Privacy posture. Couple PII + parent PII + occupation + kid data
  is a major expansion of the data we hold. CCPA / GDPR child-data
  rules apply. Needs explicit consent + a data-minimization stance
  worth defending if a regulator asks.
- Required vs optional. If the couple sees too many fields on
  signup they bounce. Every field has to be optional + the value
  has to be clear to the couple as well as to the venue.
- Field ordering. Probably address-first (clear value: thank-you
  cards + RSVP management). Occupation second. Kids + age range
  last (highest sensitivity, lowest immediate value).
- First-customer surface. Build for the couple-facing flow first
  (so couples enter their own data because it helps them), then
  the operator surface that consumes it for intelligence.

**Recommended starting cut (when picked up):**

1. Couple's home address - on wedding-details page, optional
2. Two parent addresses - on guest-list as part of "VIP guests"
   sub-list with addresses-for-thank-you-cards UX framing
3. RSVP cards already capture addresses - mine that path
4. Defer occupation, kids, age until a paying customer asks

**The thesis bet:** if Bloom owns the couple's identity graph
(addresses, networks, employers), every wedding recommendation,
every reactivation email, every cross-venue match gets sharper. The
existing tangential_signals + identity_resolution pipelines are the
substrate; this is the next data layer to feed them.

---

## Quote-to-book delta (B1, parked 2026-05-08)

`weddings.quoted_value` column ships in mig 235 (nullable, no writer
yet). Could capture the spread between original quote and final
booking value. Useful intelligence (discount discipline, pricing
power, source-quality differentiation) but no clear use case the
operator pulls today.

**When to revive:**

- A coordinator says "I keep losing money on negotiation, where am
  I leaking?"
- A pricing review surfaces that some sources convert at full price
  and others don't.
- A Wedgewood-tier customer asks about pricing power benchmarking.

Until then column stays as documented but unused.

---

## intelligence_extractions structuring (B7, parked 2026-05-08)

Currently `intelligence_extractions.value` is `jsonb`. Promoting the
top 5-10 most-queried fields to first-class columns would enable
indexes + faster queries. Cost: invasive refactor (every reader
changes) + ~$50 Claude backfill cost.

**When to revive:**

- A query against intelligence_extractions actually shows up slow
  in production telemetry (Vercel logs / Sentry).
- A new feature requires aggregating across 100K+ extraction rows
  in a single query.
- We hit Postgres jsonb-parse cost on the request path.

Until then `value jsonb` works fine.
