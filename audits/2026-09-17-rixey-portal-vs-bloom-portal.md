# Rixey portal vs Bloom portal, September

**Date:** 2026-09-17 · **For:** Isadora, before the anonymised road test (`ISADORA-PLAN.md`, weeks 1 to 4)
**Builds on:** the July parity audit (`C:\Users\Ismar\rixey-vs-bloom-portal-audit.md`) and the fixes that followed it (migrations 382 to 390).

## How far to trust this

- The Rixey side comes from its section registry (`shared/sections.js`, the one list both its menus now render from) and its commit history since 20 July: 428 commits, about 90 of them new features.
- The Bloom side comes from its route folders and targeted code searches. **Nothing was clicked through in a browser.** Where a row says "not found", I searched for it and it wasn't there, but a feature under a different name could have been missed. The road test is what settles it.
- Each gap below is marked **checked** (I read the code on both sides) or **searched** (code search only).

## The headline

In July the two were roughly level, each ahead in different places. **Since then the Rixey portal has pulled ahead on the venue side.** Most of its new work in August and September is things a coordinator does around a wedding: walkthrough notes with voice and photos, family and contacts who have no login, meeting recording, importing from planning documents and the Google Sheet, a much better guest import, and a stronger vendor model. Bloom's work in the same period went into the Agent, Intel and the spine, which is Phil's side now.

**On the couple side the two are close.** Nearly every couple section exists in both. Bloom has a few things the Rixey portal doesn't (weather, the public wedding site route, seating as its own page, a getting-started flow).

**The Rixey portal is still moving fast.** Around 60 feature commits landed between 14 and 17 September, and a session was working on it today. Parity is a moving target unless there's a rule for it (see the end).

## Fixed since the July audit

- Wedding party saves (Bloom sent a column that didn't exist).
- Website password: Bloom has `site_password` now.
- Couple notification bell and feed.
- Vendor arrival and departure times, Instagram, worked here before.
- Photo upload from a device, and the guest CSV parser.
- Section sign-off by the venue: Bloom has a finalisations route and widget.

## Couple side, section by section

Rixey's registry groups in its own order. "Same" means both have the section. It doesn't mean they behave the same, and that's what the road test is for.

| Rixey section | Bloom | Notes |
|---|---|---|
| Chat with Sage | Same (`chat`) | |
| Worksheets | Same (`worksheets`) | Rixey badges a filled worksheet on the venue side so staff notice |
| Checklist | Same | |
| Wedding Details | Same | |
| Walkthrough Notes | **Not found** (checked) | In Bloom "walkthrough" is only the name of the collapsible sections on the coordinator's wedding page. Rixey's is notes from the in-person walkthrough, with photos and transcribed voice notes |
| Budget | Same | |
| Guest List | Same | Rixey now detects which CSV column is which, can update matching guests instead of doubling them, picks export columns, and has a "type the word" delete all (all 14 to 15 Sep). Bloom's import: **searched**, none of those found |
| Vendors | Same | See the vendor audit |
| Vendor Directory | Same (`preferred-vendors`) | Rixey's is much richer: photos, bios, offers, offer filter |
| Timeline | Same | |
| Tables | Same | Bloom also has a separate `seating` page |
| Documents | **Not found** (searched) | Rixey gives couples a read-only list of their documents |
| Notes from Rixey | **Not found** (searched) | Couples read the notes the venue filed from a call or email. In Bloom `planning_notes` is only read by the contracts route on the couple side |
| Completeness | **Not found** (searched) | Rixey shows the couple how complete each section is |
| Ceremony Order | Same (`ceremony`) | |
| Ceremony Chairs | Same | |
| Table Map | Same | |
| Staffing Guide | Same | |
| Bar Planner | Same | Rixey saves an extracted cocktail recipe, once |
| Hair & Makeup | Same (`beauty`) | |
| Shuttle Schedule | Same (`transportation`) | Bloom has the shuttle capacity calculator |
| Rehearsal Dinner | Same | |
| Bedroom Assignments | Same (`rooms`) | July lead: Rixey assigns per night (Friday, Saturday). Still to check |
| Decor Inventory | Same | |
| RSVP Settings | Same | Rixey added in August: plus ones find themselves by name, their own questions, a decliner can leave a message, guests get something in writing |
| Allergy Registry | Same | |
| Guest Care Notes | Same | |
| Website Builder | Same (`website`) | Bloom's public site is `w/[slug]` |
| Photo Library | Same (`photos`) | Rixey can reorder |
| Wedding Party | Same (`party`) | |
| Inspiration | Same (`inspo`) | Rixey: only the uploader or the venue can delete a photo |
| Borrow Brochure | Same (`venue-inventory`) | |
| Rixey Picks | Same (`picks`) | |
| Manor Downloads | Same (`downloads`) | |
| Day-of Memories | Same | Rixey: the venue can reorder, and one bad upload no longer loses the batch |
| Inbox | Same (`messages`) | |
| Book a Meeting | Same (`booking`) | |
| Resources | Same | |
| Quick jump (Ctrl+K), remembered menu groups, tick and pending count per section | **Not found** (searched) | Rixey added all of these on 14 Sep |

**Bloom only, couple side:** `addresses`, `couple-photo`, `day-of`, `final-review`, `getting-started`, `privacy`, `seating`, `stays`, `venue-info`, `whats-next`, `contracts` (going, replaced by ContractHouse), `availability`, the wedding-day weather card, the conversion nudge on home.

## Venue side, around one wedding

This is where the gap is.

| Rixey (venue only) | Bloom | Notes |
|---|---|---|
| Overview | Same idea: `portal/weddings/[id]` | Bloom's wedding page is 2,462 lines with collapsible story, contracts, timeline, commitments and contracts-status sections |
| View the portal as the couple, read-only | Similar: `portal/weddings/[id]/portal` | Bloom's page shows the couple's sections to staff. Whether it's truly "as the couple sees it" is a road test item |
| Planning Notes, approve or dismiss a whole category at once | Partly (searched) | Bloom has planning notes and commitment reconciliation. Bulk approve not found |
| Sage Conversations | Same | |
| **Family & Contacts** | **Not found** (checked) | People with no login (mothers, planners) whose calls and emails get filed to the wedding. Rixey 20 Aug |
| Uncertain Q's | Same (`agent/knowledge-gaps`, `portal/sage-queue`) | |
| **Meetings: record in the browser, transcribe** | **Not found** (checked) | Bloom takes audio from capture devices (Omi webhook, `agent/audio-inbox`). No in-browser recorder. Rixey records a meeting that follows you round the portal and transcribes long meetings in parts |
| Recent Activity | Same | |
| **Sync from Sheet** | **Not found** (searched) | Rixey's Google Sheet diff for Grace |
| **Import from a planning document** | **Not found** (searched) | Rixey reads an uploaded planning doc and diffs it against the portal |
| Upload Contract | Replaced by ContractHouse | |
| **Ask About Wedding** | **Not found** as a per-wedding tool (searched) | Rixey: ask Sage about any wedding from the admin home, and a sentence can name the wedding. Bloom's Ask is venue-wide NLQ (Intel) |
| API Usage | Belongs in the admin panel | See `ADMIN-PANEL-PLAN.md` |
| Errors tab | Same (`agent/errors`) | Rixey: a resolved error can carry a note |
| Tours | Different home | Bloom tours live in the Agent and Intel, Phil's side |
| Accommodations editor | Same (`portal/accommodations-config`) | |
| Vendors admin | Much thinner in Bloom | See the vendor audit |
| Calendly diary imports hourly | Phil's side | Integration exists in Bloom |
| Quo (OpenPhone) texts | Phil's side | Ingestion exists in Bloom |

## What this means for the road test

1. **Pick couples who used Rixey's newer features.** A couple with walkthrough notes, family contacts and a big guest list shows the gaps. A couple who only used chat and the checklist hides them.
2. **Some Rixey data has nowhere to go in Bloom yet:** walkthrough notes and their media, wedding contacts, meeting recordings, sheet sync history. The data map in week 1 should list these as "no home", and each needs a decision: build it in Bloom, or accept it's gone.
3. **Walk the venue side as hard as the couple side.** The couple side is close. The venue side is where Rixey is ahead.
4. **Check the July leads that were never verified:** silent save failures across couple pages, per-night bedroom assignment, inspo captions reaching Sage.

## Rules that would stop this happening again

- **Whatever lands in the Rixey portal gets a line in this file,** or in the page spreadsheet: port it, skip it, or already there. Otherwise every week of Rixey work widens the gap.
- **Or freeze new features in the Rixey portal** except fixes, from the week the anonymised road test starts, since real clients move to Bloom from 2027 weddings anyway.

That second one is your call. The first costs a minute per Rixey commit.
