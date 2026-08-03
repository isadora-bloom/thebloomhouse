# Bloom House — Handover to Phil

Hi Phil. Isadora is handing you the reins on this for a bit. Here is the short version.

## What it is
Bloom House takes everything a wedding venue produces (emails, texts, calls, tour
bookings, CRM exports, marketplace enquiries) and turns it into one clear picture of
each couple.

## The main point
**Building the couple profile is the heart of it.** One rich, accurate file per couple,
pulled together from every channel they ever touched. If the couple profiles are right,
everything else the product does works. If they are wrong, nothing does. That is the
thing to protect and get right.

## What already works well (you are not starting from scratch)
A lot of this is built and running:

- **Data comes in from all the channels.** Email (Gmail), texts (Twilio/OpenPhone),
  Calendly tours, HoneyBook exports, The Knot, reviews. These pipelines exist and work.
- **The history is loaded.** Over 18,000 emails going back to 2021 are already in.
- **It joins people up.** The system matches a new email or text to the right couple by
  their email or phone, and creates a new couple if it is someone new.
- **The couple profile itself is built.** There is a step that reads every signal for a
  couple and writes a profile, with a real quote behind each fact so nothing is made up.
- **It is one clean pipeline.** Everything is written the same way, whether it is old
  data being replayed or a new message arriving now. There is no second system fighting it.

## Where you come in
Isadora's instinct is that the couple profiles are the key, and she is right. The useful
work now is less "build new plumbing" and more:

1. Understand how a signal flows in and becomes part of a couple profile.
2. Confirm it actually holds up on the real data (pick a real couple, follow it through).
3. Help run the clean re-import that rebuilds every profile from the source data.

## Where to look (in order)
1. `INGESTION-BACKFILL-DOCTRINE.md` — the fuller brief on all of the above.
2. `HANDOFF-STATE-OF-BLOOM-HOUSE.md` — the current state of play.
3. `PHASE2-GO-CHECKLIST.md` — the step-by-step for the re-import.

Access and logins are in `PHIL-ACCESS-CHECKLIST.md`. Anything unclear, ask Isadora when
she is back, but you have enough here to get properly started.
