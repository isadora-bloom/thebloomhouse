# Expansion verticals — beyond weddings

**Status:** TEMPLATE.
**Anchor:** `00-positioning.md` (the brain shape generalises; CRM features don't).

Wedding venues alone hit a SAM ceiling around $50-200M ARR per `01-tam-sam-som.md`. Hitting fund-returner outcomes per `05-fund-returner-math.md` requires expansion. Three candidate verticals, ranked by overlap-with-current-product.

## Vertical 1: Bed & breakfast / boutique hospitality

**The pitch:** Bloom learns the inn's voice from email + booking flow + guest reviews. Drafts replies. Predicts source attribution (Booking.com vs direct vs referral). Identifies high-LTV repeat-guest patterns.

**Why this is the strongest first expansion:**
- B&Bs already have email + booking platforms (Booking.com, Airbnb, direct). Bloom imports these like Knot/WeddingWire.
- Owner-operators (similar coordinator profile to wedding venues).
- Voice DNA matters (Bloom's brand voice maps to inn's hospitality voice).
- Identity reconstruction matters (who's a returning guest, who's likely to refer).
- Smaller per-venue ACV ($300-700/mo) but larger venue count.

**ACV estimate:** $400-600/mo per inn.

**Switching costs:** lower than wedding (less voice DNA accumulation; bookings are more transactional).

**Bloom adaptation effort:** medium. Re-skin the couple portal as "guest portal." Re-tune the prompt library for hospitality language. New brain-dump shape registry entries (Booking.com / Airbnb exports).

**Risk:** B&B market is fragmented (US: ~17K B&Bs); each is a separate sale; no Wedgewood-equivalent rollup.

**Score (1-5):** ease 4, value 3, fit 4, total 11.

## Vertical 2: Corporate event venues

**The pitch:** corporate event venues ($500K+ events) need brain on their event lifecycle. Lead → proposal → contract → execution → follow-up.

**Why this is powerful:**
- Higher ACV ($1500-3000/mo realistic).
- Tripleseat is the incumbent CRM; brain layer competes with their AI weakness.
- Buyer is professional event manager (not owner-operator), better conversion to enterprise contracts.

**Why this is harder:**
- Corporate events are NOT wedding-shaped. Different lifecycle, different KPIs, different vocabulary.
- Bloom's couple-portal value drops to zero (corporate clients don't use a "couple portal").
- Voice DNA must re-learn from scratch (corporate-event email is different from wedding email).
- Brain-dump shape registry needs major expansion (Cvent exports, RFP responses, vendor RFPs).

**Bloom adaptation effort:** high. Essentially a new vertical product on the same brain platform.

**Score (1-5):** ease 2, value 5, fit 3, total 10.

## Vertical 3: Retreat centers + wellness

**The pitch:** small retreat centers (yoga, meditation, corporate offsite) book multi-day stays with similar dynamics to weddings.

**Why this is interesting:**
- Cohort size: smaller (~5K retreat centers in US) but sticky.
- ACV: $400-800/mo.
- Voice DNA matters (very specific tone — wellness, mindfulness, minimalism).
- Multi-source signals (Yoga Trail, Wellness Tourism, Instagram).

**Why this is risky:**
- Smallest market by far.
- Buyer profile: solo operator, often artist-type, lower willingness-to-pay.
- Bloom adaptation: medium-high. Not weddings, not B&Bs. Standalone vertical.

**Score:** ease 3, value 2, fit 3, total 8.

## Decision matrix

| Vertical | Ease | Value | Fit | Total |
|---|---|---|---|---|
| B&B / boutique hospitality | 4 | 3 | 4 | 11 |
| Corporate event venues | 2 | 5 | 3 | 10 |
| Retreat centers / wellness | 3 | 2 | 3 | 8 |

**Recommended sequence:** B&B first (lowest cost of proof), corporate event venues second (highest ARR ceiling), retreat centers third (or skip).

## How to test a vertical without committing

1. **Pick 3 customers** in the candidate vertical (existing relationships, reach via warm intro).
2. **Run a 60-day pilot** with manual onboarding.
3. **Score weekly:**
   - Did the brain learn voice in 60 days?
   - Did the source-attribution graph populate from their data sources?
   - Did the operator say "this saved me time" unprompted?
4. **Decide at day 60:**
   - 3/3 yes → ship the vertical
   - 2/3 yes → tune one missing piece + extend to 90 days
   - 1/3 yes → pause; not the next vertical

## Anti-vertical: photographers, individual planners, florists

Bloom is venue-shape. Single-operator vendors (photographer, florist) have fundamentally different workflows: per-event focus, gear-management, vendor-selling-to-couple dynamic. The brain shape doesn't generalise without major rework.

Don't accidentally drift into these by accepting "we know a photographer who'd love this." Photographer-shape products are crowded (Tave, 17hats, Sprout Studio). No moat for Bloom.

Cross-references: `00-positioning.md`, `01-tam-sam-som.md`, `08-competitive-landscape.md`.
