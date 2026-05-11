# Content Suggester — Stream 6 summary

Pulls venue-specific USPs + per-season imagery & phrases from the
venue's own marketing website. The operator clicks one button, the
LLM proposes suggestions grounded in verbatim site copy, and the
operator accepts / edits / skips each one before any of it lands.

Operator authority is preserved end-to-end: suggestions are NEVER
auto-saved. The new admin routes only READ — every commit goes
through the existing Save buttons on each page.

## Files created (7)

### Services

- `src/lib/services/content-suggester/fetch-page.ts`
  - `fetchVenueHomepage(url)` — fetches the homepage plus up to two
    on-host subpages that look topically relevant (about / pricing
    / venue / weddings / seasons / gallery / story / experience).
  - SSRF-defended via `assertSafeUrl` on every hop (mirrors brain-
    dump url.ts posture). 10s total timeout, 2MB body cap, max 5
    redirects, text/html-only content-type, https-only.
  - Returns `{ homepage, subpages, combinedText }` ready for the LLM.
  - Typed `ContentFetchError` so the route handlers can map fetch
    failures to friendly 400 messages instead of generic 500s.
  - `normaliseVenueUrl()` accepts bare hosts ("www.rixeymanor.com")
    and upgrades to `https://` so coordinators don't have to remember
    a scheme.

- `src/lib/services/content-suggester/extract-usps.ts`
  - `extractUSPs({ venueId, venueName, pageText, currentUSPs })`
    runs a Sonnet pass on the cleaned page text and returns
    `{ suggestions: USPSuggestion[], reasoning }`.
  - Post-LLM safety net: case-insensitive bidirectional substring
    dedup against existing USPs (catches cases the prompt missed).
  - Uses `callAI({ tier: 'sonnet', taskType: 'usp_extract',
    promptVersion: USP_EXTRACTOR_PROMPT_VERSION, contentTier: 3 })`.
  - All AI cost is auto-logged to api_costs.

- `src/lib/services/content-suggester/extract-seasonal.ts`
  - `extractSeasonalContent({ venueId, venueName, pageText, current })`
    runs ONE Sonnet pass that returns all four seasons in a single
    response. Empty seasons are returned explicitly so the operator
    knows the LLM looked but found nothing.
  - Same post-LLM dedup pass against operator-entered imagery + phrases.
  - `taskType: 'seasonal_extract'`,
    `promptVersion: SEASONAL_EXTRACTOR_PROMPT_VERSION`,
    `contentTier: 3` (marketing copy, no PII).

### Prompts

- `src/config/prompts/usp-extractor.ts`
  - `USP_EXTRACTOR_PROMPT_VERSION = 'usp-extractor.prompt.v1'`
  - System prompt enforces venue-specific shapes (REJECT "beautiful
    venue" / "amazing staff"; ACCEPT "200-year-old stone barn" /
    "Blue Ridge views"). Every suggestion MUST carry a verbatim
    evidence_excerpt or it is rejected. Empty suggestions array is
    the right answer when the site is generic.
  - Output schema: `{ suggestions: [{ usp_text, evidence_excerpt,
    confidence }], reasoning }`.
  - Validator clips strings to 240 chars, clamps confidence to [0, 1].

- `src/config/prompts/seasonal-extractor.ts`
  - `SEASONAL_EXTRACTOR_PROMPT_VERSION = 'seasonal-extractor.prompt.v1'`
  - One call returns all 4 seasons. Imagery must be visual + specific
    (REJECT "lovely weather"); phrases must be actionable hooks
    (REJECT "fall is beautiful"; ACCEPT "Fall foliage peaks third
    weekend of October"). Evidence excerpt required for every entry.
  - Output schema: `{ suggestions: { spring, summer, fall, winter },
    reasoning }`. Validator tolerates a missing season as empty.

### Routes

- `src/app/api/admin/content-suggest/usps/route.ts`
  - `POST { venueId }` → `{ suggestions, reasoning, websiteUrl,
    subpagesFetched, skipped, skipReason }`.
  - Auth: `getPlatformAuth` + `assertCanAccessVenue` (demo blocked).
  - 400 with operator-readable error if the venue's website URL is
    missing: "Set your website URL first in /settings/venue-info..."
  - 400 with friendly explanation when the fetch fails (timeout,
    unreachable, content-type, body-too-large, etc.).
  - `maxDuration = 60` so Vercel does not kill the function before
    the 10s fetch + ~5s Sonnet call complete.

- `src/app/api/admin/content-suggest/seasonal/route.ts`
  - Same shape, posts to `extractSeasonalContent`. Loads the venue's
    existing `venue_seasonal_content` rows for exclusion.

## Files edited (2)

- `src/app/(platform)/portal/venue-usps-config/page.tsx`
  - Added "Pull suggestions from your website" button under the
    description, with `Wand2` icon and loading spinner.
  - Renders a suggestion panel above the editor with Accept / Edit /
    Skip per row, an "Accept all" button, and the evidence excerpt
    in italic underneath each proposal so the operator can verify
    provenance ("From the site: ...").
  - Confidence badge displayed per suggestion.
  - Accept and Edit both push a new editable row into the existing
    state — the rows are already textareas so "Edit" is "accept and
    tweak in place" by design. Save USPs remains the only commit path.

- `src/app/(platform)/settings/seasonal-content/page.tsx`
  - Added a single "Pull suggestions for all seasons" button at the
    top of the page.
  - Inside each season card, a small inline suggestions panel
    surfaces:
    - The proposed imagery with a "Use this" / "Skip" pair, plus
      the verbatim evidence excerpt.
    - Each proposed phrase as a chip with "Accept" (Check icon) and
      "Skip" (X icon). The evidence excerpt shows on tooltip-hover
      because the chip is too small to render inline.
  - Save per season remains the only commit path.

## Prompt version constants

- `USP_EXTRACTOR_PROMPT_VERSION = 'usp-extractor.prompt.v1'`
  - logged to `api_costs.prompt_version` for cost / latency / quality
    correlation
- `SEASONAL_EXTRACTOR_PROMPT_VERSION = 'seasonal-extractor.prompt.v1'`
  - same

If/when the prompts get revised, bump these and add a row to
`PROMPTS-CHANGELOG.md` at the repo root.

## Cost estimates per call

| Call           | Tier   | Input tokens | Output tokens | Cost/call |
| -------------- | ------ | ------------ | ------------- | --------- |
| USP extract    | Sonnet | ~3-5k        | ~500          | ~$0.008   |
| Seasonal       | Sonnet | ~3-5k        | ~1200         | ~$0.012   |

Operator-triggered (manual button). Expect 1-3 calls per venue per
quarter (operator runs on initial setup, then again after the venue's
website materially changes). Per-venue annual cost: ~$0.10.

At Wedgewood scale (~80 venues), annual ceiling ~$10. Negligible.

## Why Sonnet, not Haiku

Doctrine: `memory/bloom-may9-llm-vs-template.md`. USPs and seasonal
phrases shape the venue's voice for every AI-written reply. Haiku
tends to produce universal pleasantries ("beautiful venue", "fall is
beautiful") even with explicit instructions — exactly the failure
mode we're trying to prevent. The cost delta is ~$0.007 per call
versus the operator hours saved per venue. Sonnet is the right tier.

## Doctrine alignment

- **Constitution** — the venue's own published words are treated as
  evidence, not truth. Every suggestion carries a verbatim
  evidence_excerpt, and the operator decides what becomes canonical.
- **TBH brand asset** — be honest. The fetcher identifies itself as
  `BloomHouseBot/1.0 (+https://thebloomhouse.ai)` and the operator
  is shown the exact line from the site that each suggestion
  references.
- **LLM-is-the-primitive** — fetch + Sonnet, not regex or template.
- **Self-reported ≠ truth** — the venue's marketing site is a
  self-report. Operator review is the contract that converts it to
  canonical. No silent writes.
- **No em dashes** — confirmed in every prompt + UI string.
- **Operator authority preserved** — the admin routes never write.
  All persistence flows through the existing Save buttons on each
  page (which were already RLS-scoped + audit-logged by the existing
  page logic — Stream 6 doesn't touch them).

## Source for the venue's website URL

The brief specified `venue_config.website_url`. That column does
NOT exist in this schema (verified — migration 001 venue_config has
no website column; only `venue_ai_config.signature_website` was
added in migration 195 for the email-signature builder).

Decision: use `venue_ai_config.signature_website` as the canonical
source. This is also what `signature_website` already feeds in
prompt building (personality-loader.ts, brain/sage.ts, brain/
inquiry.ts, brain/client.ts), so it is operator-already-curated.

The "Set your website URL first" error message points at
`/settings/venue-info` which is where the operator-facing form lives
(signature fields). If Stream 1-5 lands a dedicated `website_url`
column on `venue_config`, swap the column read in the two routes —
the rest of the pipeline is decoupled.

## Open questions / future follow-ups

1. **No persistent provenance trail.** Suggestions land in the
   operator's draft rows but the evidence excerpt is dropped at
   accept time. If a later audit wants to know "where did this USP
   come from?" we'd want a column on `venue_usps` (and
   `venue_seasonal_content`) recording the suggestion source URL +
   excerpt + prompt_version. Out of scope for Stream 6 (no migration)
   but a clean follow-up: add `source_url`, `source_excerpt`,
   `source_prompt_version` nullable columns and thread them through
   the Accept path.

2. **Rate limit.** No explicit rate limit on the suggest endpoints.
   Each call costs ~$0.01 + opens an outbound fetch. If a coordinator
   spam-clicks, the cost ceiling is real but small. If we ever expose
   this to less-trusted roles, plug it into the existing rate limiter
   (`src/lib/api/rate-limit.ts` or similar). For now, only platform-
   auth coordinators can trigger it.

3. **Subpage selection is regex-based.** `findSubpageCandidates`
   walks the homepage HTML with a regex over anchors and keyword-
   matches the pathname + link text. Cheap and pragmatic; could be
   smarter (e.g. let the LLM pick subpages in a first pass before
   the extraction call) at extra cost. Worth revisiting once a few
   real venues run it and we can see which sites confuse the heuristic.

4. **The "Edit" action on USP suggestions** is currently functionally
   identical to Accept — the row lands editable in the textarea list,
   so "Edit" means "accept then tweak in place." If the operator
   wants a distinct "edit before adding" flow, that's a future
   enhancement (modal with pre-filled text).
