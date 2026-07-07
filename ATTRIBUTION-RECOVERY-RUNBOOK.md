# Attribution recovery runbook (2026-06-17)

Findings + fixes for the two attribution gaps + the "names/forms/calculators
back to original source" question. Several steps are gated on Supabase
(which was down at authoring time) and on migration 309 being applied.

## What was confirmed (prod, Rixey venue f3d10226-…)
- **`web_visits` table does NOT exist** — migration 309 never applied. Zero
  first-party pixel data. (`scripts/diag-web-and-calendly.ts`)
- **`bloom-pixel.js` was never installed** on rixeymanor.com.
- **`calendly_qa` empty on all 629 weddings** — webhook code path exists but
  never fired in prod. Data IS recoverable: 343 "New Event:" Calendly emails
  in `interactions.full_body` carry the full Q&A. (`scripts/diag-calendly-emails.ts`)
- **`attribution_events` = 0 rows, `discovery_sources` = 3** — the
  attribution layer has effectively never run for Rixey.
  (`scripts/diag-attr-state.ts`)
- GA4 `website_traffic_history` is healthy (channel-level only).

## Website changes (done, in rixey-manor-website — needs deploy)
- `app/layout.js` — installs `/bloom-pixel.js` + an inline config script that
  **unifies the visitor id**: seeds `bloom_visitor_id` from the site's own
  `rixey_vid` so a pixel pageview and a later calculator submission stitch to
  the SAME couple. Pixel key `4114bda6-34be-40cb-bdef-dfbb01b0f52f`
  (override via `NEXT_PUBLIC_BLOOM_PIXEL_KEY`), endpoint
  `https://app.thebloomhouse.ai/api/v1/visit` (override via
  `NEXT_PUBLIC_BLOOM_PIXEL_ENDPOINT`). **CONFIRM the endpoint domain.**
- `components/pricing/PricingCalculator.jsx` — adds "How did you find us?"
  dropdown; sends `heardAbout`. (`visitor_id` was already sent via getUTM.)
- `app/api/calculator-submit/route.js` — stores `heard_about` (defensive
  retry if the column is missing) + shows it in the venue email.
- `supabase/migrations/add_calculator_heard_about.sql` — adds the column on
  the WEBSITE's Supabase (project fgbnvotlqpfaewvpnsxf).

## Gated steps — run when Supabase is back

1. **Apply migration 309** (`supabase/migrations/309_web_pixel.sql`) to
   bloom-house prod. Idempotent (CREATE/ADD … IF NOT EXISTS).
2. **Set the Rixey pixel key** so it matches the website (after 309):
   ```sql
   update venue_config set pixel_ingest_key = '4114bda6-34be-40cb-bdef-dfbb01b0f52f'
   where venue_id = 'f3d10226-4c5c-47ad-b89b-98ad63842492';
   ```
   (Or read /portal/pixel-config and paste THAT key into the website env
   instead — either way the two must match.)
3. **Apply `add_calculator_heard_about.sql`** to the website Supabase, then
   deploy the website.
4. **Backfill Calendly Q&A** (recovers names + discovery source for past
   bookings, no website dependency):
   ```
   npx tsx scripts/backfill-calendly-email-qa.ts            # dry-run, REVIEW
   npx tsx scripts/backfill-calendly-email-qa.ts --apply    # write
   ```

## Known follow-ups (not done)
- The calculator's `heard_about` reaches bloom-house only via the venue
  email today. To wire it into `discovery_sources` from the CSV import,
  extend `CALCULATOR_SUBMISSIONS_HINT` in `src/lib/services/crm-import/web-form.ts`
  with a discovery column + a discovery write, OR add calculator-email
  parsing alongside the Calendly backfill.
- The backfill intentionally skips the forwards-linker cascade and does NOT
  write partner names into people/couples (name-evidence chokepoint). It
  captures them into `calendly_qa` for deliberate promotion.
- Point a live Calendly webhook at prod so #4 stops needing to be a backfill.
