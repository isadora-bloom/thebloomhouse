# Vendor network: the January schema, the Rixey portal and Bloom, side by side

**Date:** 2026-09-17 · **For:** Isadora, before the standalone vendor app gets built (`ISADORA-PLAN.md`, week 1)
**Method:** code and migrations read. No database queried, so every row count below is from the 26 August session notes, not today.

What was read:
- **January schema:** `isadora-bloom/vendor_bloom`, one file, `vendor-network-schema.sql` (14 Jan 2026). Tables, enums, seed lists, helper functions, placeholder security. No app.
- **Rixey portal:** migrations 029 to 034 plus the two archived vendor migrations, the 30 vendor routes in `server/index.js`, `VendorsAdmin.jsx`, `PreferredVendors.jsx`, `VendorChecklist.jsx`, `VendorPortal.jsx`, `shared/vendor-names.js`, `shared/contact-bits.js`, and the eight vendor scripts.
- **Bloom today:** `vendor_recommendations` (migration 004, portal columns in 097), `booked_vendors` (015, 097 and later), `event_feedback_vendors` (043), the two vendor token pages and the coordinator and couple vendor pages.

## The one-paragraph answer

The two are good at opposite things. The **January schema** was drawn for a network: one vendor row shared by every venue, each venue's own relationship with that vendor kept separately, and rich ways to match a vendor to a couple (style, personality, specialties, languages, distance, availability). It has no idea how messy real vendor data is. The **Rixey portal** is the opposite. It only knows one venue, but it was built from 268 real bookings and it's full of the machinery that mess needs: aliases, never-delete merges, a question queue for possible duplicates, contact details kept with where they came from, and vendors editing their own profiles through a link. **Bloom** has a thin version of the Rixey model and nothing of the January one. The standalone app should take the January shape and put the Rixey machinery inside it.

## Side by side

| Area | January schema | Rixey portal | Bloom today |
|---|---|---|---|
| **Who a vendor belongs to** | Nobody. One global row, and each venue links to it through `venue_vendor_relationships` | Rixey. One table, one venue | Each venue has its own `vendor_recommendations` rows. The same photographer at two venues is two unrelated rows |
| **Same vendor, different spellings** | Nothing. `business_name` only | `aliases` (Sammy's has nine), a shared name matcher with recorded rulings, and a merge-questions queue | Nothing |
| **Duplicates** | Nothing | `merged_into`: the duplicate is kept and points at the survivor, so an old edit link still works. Never deleted | Nothing |
| **Categories** | One category per vendor, with a parent-child category table and 16 seeded | Several per vendor (`categories TEXT[]`), because Carpe Donut is both Brunch and Food Truck | One free-text `vendor_type` |
| **Contact details** | Email, phone, website, five social handles | The same plus `vendor_contact_evidence`: every detail ever seen, where it came from, how many places agreed, and a dismiss that stops it coming back | Email, phone, website, Instagram, Facebook |
| **Location and travel** | Zip code (required), latitude and longitude, a travel radius, travel fee notes, a distance function | An `is_local` tick | Nothing |
| **Price** | Nine price brackets plus notes | `pricing_info` free text and an `is_budget_friendly` tick | `pricing_info` free text |
| **Style and fit** | Style tags (aesthetic, mood, approach, food, music, florals, beauty, cake, officiant), eight personality traits, specialties (couple types, wedding types, 16 cultural), 22 languages with fluency | `serves_indian`, `serves_chinese`, `has_multiple_events` ticks | Nothing |
| **Professional standing** | Licensed, insured, insurance expiry, backup plan, contract required | Nothing | Nothing |
| **Inclusion and sustainability** | Accessibility notes, `lgbtq_friendly`, multicultural experience, eco options | Nothing | Nothing |
| **Availability** | The vendor's own bookings (including personal and holiday), day-of-week preferences, seasonal blocks, a computed day-by-day cache, capacity per day, week and month | `availability_note` free text | Nothing |
| **The venue's view of a vendor** | Preferred, approved or blocked. Private notes, working style, best for, avoid for, a 1 to 5 rating, times recommended and booked | `is_recommended`, `notes` (couples see these) and `internal_notes` (they don't) | `is_preferred`, a description, a click count |
| **History at the venue** | `vendor_venue_history`: wedding date, couple rating and feedback, venue rating and feedback | Every booking (`vendor_checklist`) linked to its vendor, 259 of 268 linked. Weddings worked, arrival and departure times, worked here before | `booked_vendors` per wedding, not linked to the venue's vendor list. Ratings live separately in `event_feedback_vendors` |
| **Contracts** | A `contract_signed` tick | Uploaded per booking, stored by path and signed when read, versions tracked (033), and the planning details pulled out of the contract by AI into planning notes | Uploaded per booking with a storage path. AI extraction on the couple's contracts page |
| **Vendor edits their own profile** | Planned as accounts (`claimed`, `claimed_by_user_id`) | A private link. Bio, photos, logo, special offer with an expiry, availability note, contact, pricing. Saving makes it live. Rixey can hide it, and a hide survives the vendor's next save | Two separate link pages writing to two different tables. Tokens hashed and expiring |
| **Getting vendors to fill it in** | Nothing | Invite emails, grouped by address, with a sent date and count per vendor. A "send profile link" button on each row | Nothing |
| **What couples see** | Nothing built | A directory of every recommended vendor with their own words, photos and offers on top, and a filter for vendors with an offer | A preferred-vendors page |
| **Security** | Every table open to everyone ("Allow all for now") | Locked down after two holes found on 26 Aug. Couples never see edit links, emails, phones, private notes or aliases. Tokens stored plain | Tokens hashed with expiry. Venue isolation on the tables |
| **Real data** | None | As of 26 Aug: 208 live vendors, 19 merged away, 101 recommended, 81 reachable, 7 vendor-written profiles, 28 merge questions open, 0 invites sent | Rixey's wiped in the Phase 2 reset |

## What to take, and from where

### From the January schema: the shape

1. **One vendor, many venues.** This is the whole point of a network, and with 200 venues it isn't optional. The same florist working at 30 venues has to be one row, or nothing about them adds up. Neither the Rixey portal nor Bloom can do this today.
2. **The venue's relationship as its own record.** Preferred, approved or blocked, plus private notes, best for and avoid for. A venue's private notes about a vendor must never reach another venue.
3. **Matching attributes:** style tags, personality, specialties, languages, travel radius, price bracket. This is what lets a couple be pointed at the right vendor rather than just a list.
4. **Professional standing:** insurance with an expiry date is something venues genuinely ask for.
5. **Couple and venue ratings after the wedding.**

### From the Rixey portal: the machinery that real data needs

1. **Aliases, the name matcher and its rulings** (`shared/vendor-names.js`). The matcher's rules came out of real mistakes: `&` isn't a separator, an apostrophe isn't a word break, a shared word isn't a match, a bare trade isn't a name.
2. **Never delete a duplicate.** `merged_into` plus the survivor rule (recommended first, then has a profile, more weddings, spelling on their own website, fuller name).
3. **The merge-questions queue.** A possible duplicate is a question for a person, not something to guess.
4. **Contact evidence with provenance**, including the lesson that a contract mentions other companies, so details from contract text are shown but never filled in automatically.
5. **Bookings as the source of truth** for which vendors a venue has actually worked with.
6. **The vendor self-edit link:** save means live, a hide that survives, logo and photos, an offer that stops showing after its expiry date.
7. **Invite tracking**, and sending grouped by address so one business with three records doesn't get three emails.
8. **Several categories per vendor.**
9. **Contract per booking stored by path**, with versions.

### From Bloom: keep

1. **Hashed, expiring vendor links.** Safer than the Rixey portal's plain tokens.
2. **`event_feedback_vendors`** as the start of ratings.
3. **The couple's booked vendor with day-of times** (arrival, departure), already ported.

## Things in the January schema to change before building on it

- **Security is wide open.** Every table has an allow-all policy. That has to be real from the first migration.
- **`lgbtq_friendly` defaults to true.** That states something on the vendor's behalf that nobody asked them. It should start empty and be something the vendor says.
- **`zip_code` is required.** None of Rixey's 208 vendors has one on file, so the import would fail. It has to be optional, with the distance features only for vendors who have given a location.
- **One category per vendor.** Needs to become several.
- **No aliases, no merges, no evidence.** Add the Rixey machinery.
- **`vendor_bookings` holds client names, emails and phones** for couples outside Bloom. That's personal data about people who never agreed to anything, so keep only what the availability check needs.
- **`venue_id` and `wedding_id` have no link to anything.** In the standalone app they should be the same IDs Bloom uses, so the merge in week 7 is joining tables rather than translating them.
- **The availability cache, seasonal blocks and day-of-week preferences** are the most work and the least needed for November. Leave the tables in the design and build them after.

## Suggested core for November

What a venue, a couple and a vendor need to see working:

1. Global vendors with aliases, several categories, merges and the question queue.
2. Venue relationships: preferred, approved, blocked, private notes, best for, avoid for.
3. Bookings linked to vendors, with weddings worked counted from them.
4. The vendor's self-edit link: profile, photos, logo, offer, availability note.
5. The couple directory, filtered to one venue's recommended vendors.
6. Contact evidence.
7. Invites.
8. Style tags, specialties and languages on the vendor profile, so the matching data starts being collected even before matching is built.

After November: distance and travel matching, availability, ratings across venues, vendor accounts.

## Questions for Isadora

1. **Do vendors get to see which venues recommend them?** Useful for them, but it shows one venue's relationships to anyone the vendor tells.
2. **Are couple ratings shared across venues?** That's the network effect, and also a privacy decision about what one venue's couples said.
3. **Who answers merge questions for a vendor two venues both have?** Neither venue owns the global row.
4. **Is "blocked" visible to the vendor?** The January schema doesn't say.
5. **Are the 28 Rixey merge questions answered yet?** They should be before Rixey's vendors are imported, or the duplicates come across with them.
