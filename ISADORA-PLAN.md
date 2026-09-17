# Isadora's track: the order to do it in

**Written:** 2026-09-17, updated the same day with Isadora's answers · **Hard date:** 8 Nov 2026, everything merged
**Scope:** Isadora's five areas from the Phil/Isadora split in `CLAUDE.md`. Phil's Agent and Intel work is not in here.

## Settled (2026-09-17)

- **Everything is merged into Bloom by 8 November.** ContractHouse and the vendor network both.
- **The vendor network is built standalone first**, like ContractHouse. It already has a start: the private GitHub repo `isadora-bloom/vendor_bloom` holds one file, `vendor-network-schema.sql` (January 2026, 16 tables: vendors, categories, styles, personality traits, specialties, languages, bookings, day preferences, seasonal blocks, availability cache, venue relationships, venue history). No app yet. The Rixey portal's vendor records from August are the other half.
- **The admin panel is for everyone at Bloom**, not just Isadora. So it needs staff roles from the start. The 14-day trial stays, billing is Stripe, alerts are built into Bloom (no Slack), a notice is enough when staff view a venue.
- **The test venue gets the 3 or 4 most complete Rixey couples.** No anonymising beyond changing their email addresses (and phone numbers), so nobody gets a notification by accident. It's internal only.
- **Real Rixey clients move onto Bloom from 2027 weddings onwards.** 2026 weddings finish on the Rixey portal. Rixey isn't sending contracts through ContractHouse today, so there are no live contracts to carry across.
- **The Rixey portal is done with new features.** Fixes only from here.
- **Rixey portal features Bloom lacks get built into Bloom:** walkthrough notes with photos and voice, family and contacts, meeting recording, planning document import. The Google Sheet sync is dropped.
- **Venue staff can edit a couple's sections for them**, marked as done by the venue.

## The short version

1. Clear the ground: delete Bloom's own contracts (W57).
2. Read the Rixey portal and `vendor_bloom` once, for three outputs: the test data map, the vendor design, and ContractHouse's gaps.
3. Three builds run side by side from week 2: admin panel, ContractHouse fixes, the vendor network app.
4. Load the anonymised venue, build the page spreadsheet, then walk it from both ends.
5. Merge ContractHouse in week 5 and 6, the vendor network in week 7.

## Why this order

- **W57 has to go before the road test.** Bloom's contracts show up on the coordinator's wedding page and in the couple's contract library. Walking those pages now means testing something that's about to be deleted.
- **The Rixey portal holds the client history and the vendor records.** One read covers the export and the vendor design.
- **The vendor network starts in week 2, not week 5.** Being merged by 8 November means building a standalone app and merging it in seven weeks. It can't wait until ContractHouse is done.
- **The UIX pass is pointless on empty pages.** The spreadsheet comes early, the walk waits for data.
- **Road testing the portal and walking the venue side are the same job from two ends.** Same weddings, one spreadsheet.
- **Merges come last on purpose:** each thing solid on its own first.

## The risk to say out loud

From week 2 to week 4 there are three agent builds running at once (admin panel, ContractHouse, vendor network), plus your own walk-through. The agents can do the building. What limits it is how much you can review. If something has to give, the walk-through findings get fixed first, and the vendor network keeps its core (vendors, the venue's relationship with them, booked history) and drops the rest (availability cache, seasonal blocks) until after November.

## Week by week

### Week 1 · 17 to 23 Sep: clear the ground and read

- [x] **Delete W57.** Done 17 Sep (`e76dc422`): prod's 21 generated contracts were all demo seeds. E2E sections 27 and 32 need a rerun. A later migration drops 409's columns. First check prod for any generated contract rows. If there are none, remove `src/lib/services/contracts/**`, `src/app/api/portal/contracts/**`, `src/app/api/contracts/sign/**`, `src/app/join/contract/**`, `src/app/(platform)/settings/contract-template/**`, the fifth collapsed section on the wedding page and the pill on the couple library. Migration 409's columns stay for now and a later migration drops them. E2E section 32's `/join/contract` test goes too.
- [ ] **Read the Rixey portal.** Two outputs (the vendor list and a first portal comparison are done, see `audits/2026-09-17-vendor-network-side-by-side.md` and `audits/2026-09-17-rixey-portal-vs-bloom-portal.md`; the table-by-table data map is still to do):
  - *Data map:* where couples, guests, timelines, messages, Sage chats and planning notes live, and where each lands in Bloom.
  - *Vendor steal-list:* records, booked history, contracts, aliases, recommend toggle, directory, merge questions. Take as is, take the idea, or leave it.
- [x] **Vendor design.** Done 17 Sep: `vendor_bloom/DESIGN.md` and `supabase/migrations/001_vendor_network.sql` (parsed, not yet run). Next: Isadora creates the Supabase project. Put the January schema next to the steal-list and write one design. The January schema was drawn before the Rixey records existed, so it needs updating. It also needs `venue_id` and `wedding_id` keys that line up with Bloom's, so the merge in week 7 is joining tables, not translating them.
- [ ] **ContractHouse audit.** List what's broken and what's left from v1 (late payment reminders, certificate of completion PDF, co-signer) before fixing anything. It's live for Rixey, so nothing is tested against its production database.
- [x] **Admin panel spec.** Written: `ADMIN-PANEL-PLAN.md`, with seven decisions waiting. Registrations (venues, users, couples, when), billing (plan, Stripe status, trial, failed payments), usage (AI spend from `api_costs`, emails processed, active users). Staff roles, since it's for everyone at Bloom. Start from what `/super-admin` shows.

### Week 2 · 24 to 30 Sep: start the three builds, load the venue

- [ ] **Vendor network app.** Stand up `vendor_bloom` with the same stack as ContractHouse (Next 16, Supabase, Tailwind, shadcn), so both merges look alike. It needs its own Supabase project, which you create.
- [ ] **Admin panel** build starts.
- [ ] **ContractHouse fixes** start, against a test copy of its database.
- [ ] **Export the 3 or 4 most complete Rixey couples.** The raw export stays local and never goes into git. Every email address and phone number (couples, guests, family, vendors) swapped for a safe test one, so nothing can notify a real person. Everything else as it is.
- [ ] **Load them into the test Supabase project** as their own venue, with a coordinator login and a couple login. After the next E2E run, check the venue survived.
- [ ] **Page spreadsheet**, generated from the route list (`scripts/gen-sitemap.mjs`): page, who sees it, nav location or orphan, blank columns for verdict and notes.

### Weeks 3 and 4 · 1 to 14 Oct: walk it, keep building

- [ ] **Couple side:** log in as each anonymised couple and use the portal the way they would.
- [ ] **Venue side:** work down the spreadsheet as the coordinator, on the same weddings.
- [ ] **Build the missing Rixey features into Bloom:** walkthrough notes (photos, voice, transcription), family and contacts, meeting recording, planning document import, and staff editing couple sections.
- [ ] **Fix as you go** in your areas. Agent or Intel problems go to Phil through the diary.
- [ ] **Admin panel** finished and checked against real numbers.
- [ ] **ContractHouse** declared solid: every v1 flow works end to end on the test copy.
- [ ] **Vendor network** core working: vendors, venue relationships, booked history, directory.

### Weeks 5 and 6 · 15 to 28 Oct: merge ContractHouse, finish vendors

- [ ] **ContractHouse into Bloom.** Tables into Bloom's database, joined through the `wedding_id` and `couple_id` it already carries. Pages under the platform and couple portal. No live Rixey contracts to move: Rixey isn't using ContractHouse today.
- [ ] **Re-walk the contract pages** on the test venue.
- [ ] **Vendor network** declared solid.

### Week 7 · 29 Oct to 4 Nov: merge vendors

- [ ] **Vendor network into Bloom**, including Rixey's vendor records. Connects to the couple's preferred-vendors page and the coordinator's vendors page, and replaces Bloom's two vendor token portals with one.
- [ ] **One more pass** through the spreadsheet's worst rows.

### Week 8 · 5 to 8 Nov: buffer

Nothing planned. Something will need it.

## Still to confirm

- Nothing on the plan itself. Open items live in `ADMIN-PANEL-PLAN.md` and `vendor_bloom/DESIGN.md`.

## Where findings go

The diary for what happened each day. The page spreadsheet for UIX verdicts. This file gets ticked off and updated when the plan changes.
