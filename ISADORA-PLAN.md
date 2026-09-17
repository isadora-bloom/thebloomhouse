# Isadora's track: the order to do it in

**Written:** 2026-09-17 · **Deadline it works back from:** ~8 Nov 2026 (NOVEMBER-PLAN.md)
**Scope:** Isadora's five areas from the Phil/Isadora split in `CLAUDE.md`. Phil's Agent and Intel work is not in here.

## The short version

1. Clear the ground: delete Bloom's own contracts (W57).
2. Read the Rixey portal once, for two jobs at the same time: the anonymised test data and the vendor steal-list.
3. Load an anonymised Rixey venue into the test project and build the page spreadsheet.
4. Walk it from both ends. The client portal road test and the venue UIX pass become one exercise.
5. Admin panel and ContractHouse run alongside, because neither blocks or waits on the others.
6. Merge ContractHouse into Bloom, then the vendor network, once each is solid.

## Why this order

A few things decide it.

- **W57 has to go before the road test.** Bloom's contracts show up on the coordinator's wedding page and in the couple's contract library. Walking those pages now means testing something that's about to be deleted, and any agent working nearby might build on it in the meantime.
- **The Rixey portal holds both the client history and the vendor records.** Going through it twice would be wasted effort. One read produces the table map for the export and the list of what to take for vendors.
- **The UIX pass is pointless on empty pages.** Most of Bloom looks broken or bare with no data in it. So the spreadsheet can be built early, but the walk-through waits for the anonymised venue.
- **Road testing the portal and walking the venue side are the same job from two ends.** Same data, same weddings. Log findings for both in one spreadsheet.
- **The admin panel and ContractHouse don't depend on anything above.** The admin panel reads data Bloom already has, and ContractHouse is its own repo with its own database. Both can be built by agents while your own time goes on the walk-through.
- **Merges come last on purpose.** That was the call: make each thing solid on its own first.

## Week by week

### Week 1 · 17 to 23 Sep: clear the ground and read the Rixey portal

- [ ] **Delete W57.** First check prod for any generated contract rows (`contracts` where `kind` marks a generated one). If there are none, remove `src/lib/services/contracts/**`, `src/app/api/portal/contracts/**`, `src/app/api/contracts/sign/**`, `src/app/join/contract/**`, `src/app/(platform)/settings/contract-template/**`, the fifth collapsed section on the wedding page and the pill on the couple library. Migration 409's columns stay in the database for now (a later migration drops them), since removing columns on prod is its own step. E2E section 32's `/join/contract` test goes with it.
- [ ] **Read the Rixey portal**, one pass, two outputs:
  - *Data map:* which Rixey portal tables hold couples, guests, timelines, messages, Sage chats, vendors, planning notes, and where each lands in Bloom. Mark anything with no home in Bloom.
  - *Vendor steal-list:* the vendor records model, booked history, contracts, aliases, recommend toggle, directory and the merge questions tool. For each one, say whether to take it as is, take the idea, or leave it.
- [ ] **ContractHouse audit.** It hasn't been touched since 29 June. List what's broken and what's left from the v1 scope (late payment reminders, certificate of completion PDF, co-signer, and so on) before fixing anything. It's live for Rixey, so nothing gets tested against its production database.
- [ ] **Admin panel spec.** Agree what's on it: who has registered (venues, users, couples, when), billing (plan, Stripe status, trial, failed payments), usage (AI spend from `api_costs`, emails processed, active users). Check what `/super-admin` already shows, since it's the obvious place to build.

### Week 2 · 24 to 30 Sep: build the test venue and the spreadsheet

- [ ] **Export and anonymise.** Run the export from the Rixey portal into a local folder that never goes into git. Swap names, emails, phones and addresses for consistent fakes, so one couple is the same fake couple everywhere. Rewrite free text (messages, notes, Sage chats, allergy details) properly rather than with find-and-replace. Leave out photos and uploaded files. Vendor businesses are public businesses, so their names can probably stay, but decide that explicitly.
- [ ] **Load into the test Supabase project** as its own made-up venue, with a coordinator login and a couple login. After the next E2E run, confirm the venue survived, since the seed clears data venue by venue.
- [ ] **Page spreadsheet.** Generate it from the route list (`scripts/gen-sitemap.mjs` already walks the pages): page, who sees it (venue, couple, vendor, public), nav location or "orphan", and blank columns for your verdict and notes.
- [ ] **Admin panel build** starts (agents).
- [ ] **ContractHouse fixes** start (agents), against a test copy of its database.

### Weeks 3 and 4 · 1 to 14 Oct: walk it

- [ ] **Couple side:** log in as the anonymised couple and go through the portal the way a real couple would, in the order they'd use it.
- [ ] **Venue side:** work down the spreadsheet as a coordinator, on the same weddings.
- [ ] **Fix as you go**, for anything in your areas. Anything that's really Agent or Intel goes to Phil through the diary, not fixed quietly.
- [ ] **Admin panel** finished and checked against real numbers.
- [ ] **ContractHouse** declared solid: every v1 flow works end to end on the test copy.

### Weeks 5 and 6 · 15 to 28 Oct: merge ContractHouse, build vendors

- [ ] **ContractHouse into Bloom.** Its tables go into Bloom's database, joined to weddings and couples through the `wedding_id` and `couple_id` it already carries. Its pages go under the platform and couple portal. Rixey's live contracts and payments get moved over. Plan that move before doing it, because it's real money and signed documents.
- [ ] **Vendor network build**, from the week 1 steal-list.
- [ ] **Re-walk the contract pages** on the test venue after the merge.

### Week 7 · 29 Oct to 4 Nov: vendor merge and a last walk

- [ ] **Vendor network into Bloom**, if it's solid. If it isn't, it waits until after November, and that's a decision to make out loud, not something that slips.
- [ ] **One more pass** through the spreadsheet's worst rows.

### Week 8 · 5 to 8 Nov: buffer

Nothing planned. Something will need it.

## Decisions still open

- **Where the vendor network gets built before it merges.** In the Rixey portal where it already lives with real data, in a new standalone repo like ContractHouse, or straight into Bloom? This decides week 5.
- **Does ContractHouse have to be merged by 8 November,** or is solid and standalone enough for showing clients and investors?
- **Admin panel access:** just you, or anyone at Bloom later?
- **How many Rixey couples go into the test venue.** Enough to see busy pages (probably a season's worth), not the whole history.

## Where findings go

The diary for what happened each day. The page spreadsheet for UIX verdicts. This file gets ticked off and updated when the plan changes.
