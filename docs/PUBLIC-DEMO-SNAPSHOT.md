# Public demo snapshot — `/api/public/demo-snapshot`

W58, NOVEMBER-PLAN.md Wave 8. The Bloom-side hook the marketing site's
live demo polls. Bloom ships this route only; the marketing site's own
build (the page that calls it, the animation, the polling loop) is a
separate repo and out of scope here.

## What it is

`GET /api/public/demo-snapshot` — no auth, no cookies, no request body,
no query parameters that change what is returned. It always serves the
same fixed venue: the Crestwood demo venue (`PUBLIC_DEMO_VENUE_ID` in
`src/app/api/public/demo-snapshot/route.ts`, currently Hawthorne Manor).
There is nothing in the request the caller can use to ask for a
different venue — the id is a server-side constant, checked again at
read time against `venues.is_demo = true` before anything else is
queried. If that check ever fails (the constant pointed somewhere it
shouldn't), the route refuses with a 503 rather than serving whatever it
found.

Every number in the response comes from an existing canonical reader or
adapter — this route computes nothing new:

| Field | Source |
|---|---|
| `today.*` | `loadDailyList` (`src/lib/intel/canonical.ts`) — the same four blocks `/today` renders |
| `monthlyStory` | `loadMonthlyStory` + `buildMonthlyStoryView` (`src/lib/intel/adapters/monthly-story.ts`, W52) |
| `heat` | `loadCohortData` + `buildHeatReport` (`src/lib/services/cohort/{data,heat}.ts`) — the same distribution `/intel/heat` renders |
| `insights` | `listExistingNarrations` (`src/lib/services/insights/correlation-narration.ts`) — a **read-only** fetch of already-narrated correlation rows; this route never triggers a fresh narration and makes no AI call |

Names in the response are whatever is stored against the demo venue —
the fictional Crestwood roster (`scripts/demo-reseed/roster.ts`). Nothing
in this route generates, rewrites, or anonymises a name; it reads what
is already fictional in the database.

## Response shape

```jsonc
{
  "generated_at": "2026-09-14T12:00:00.000Z",
  "next_refresh_at": "2026-09-14T12:05:00.000Z",   // generated_at + 5 minutes
  "venue": { "name": "Hawthorne Manor", "slug": "hawthorne-manor" },
  "today": {
    "needsReply":     { "count": 4, "topRows": [ { "id": "...", "names": "..." }, /* up to 3 */ ] },
    "goingCold":       { "count": 1, "topRows": [ ... ] },
    "toursThisWeek":   { "count": 2, "topRows": [ { "id": "...", "names": "...", "scheduledAt": "..." } ] },
    "highIntent":      { "count": 5, "topRows": [ ... ] }
  },
  "monthlyStory": [
    {
      "key": "response-time",
      "title": "How fast you answer",
      "headline": "Your typical first reply goes out in 2 hours.",
      "isFinding": true,
      "rows": [ { "label": "Typical first reply", "value": "2 hours", "note": "Measured across 40 couples." } ],
      "empty": null
    }
    // ...tour-weekday, channel-roi, reviews
  ],
  "heat": {
    "bands": [
      { "label": "Cold", "min": 0, "max": 19, "count": 10 },
      { "label": "Cool", "min": 20, "max": 39, "count": 15 },
      { "label": "Warm", "min": 40, "max": 59, "count": 12 },
      { "label": "Hot", "min": 60, "max": 79, "count": 8 },
      { "label": "On fire", "min": 80, "max": null, "count": 3 }
    ]
  },
  "insights": [
    { "title": "Mortgage rate preceded tours", "body": "Mortgage rate and tours moved with about a 14-day lag over the last 90 days (correlation 0.51)." }
    // up to 3, highest surface_priority first
  ]
}
```

`today.*` blocks always report the true `count` even when only the top
three `topRows` are shown — the marketing site can say "4 couples need a
reply" without needing all four rows.

## Poll cadence, not push

There is no `/api/public/demo-snapshot/stream` route. Instead the body
carries `generated_at` and `next_refresh_at` so the marketing site knows
when to poll again — `next_refresh_at` is `generated_at` plus the same
five minutes as the `Cache-Control` window below.

## Caching

`Cache-Control: public, s-maxage=300, stale-while-revalidate=600` — a
CDN (Vercel's edge, or any front proxy) can serve a cached copy for up
to five minutes and keep serving a stale copy for up to ten more while
revalidating in the background. The repo has no other API-route
cache-header convention to match; this follows NOVEMBER-PLAN.md's stated
fallback directly.

## Rate limit

60 requests per minute per IP, via the repo's existing durable limiter
(`src/lib/rate-limit.ts`, Postgres-backed with an in-memory floor when
Postgres is unreachable) keyed as `public-demo-snapshot:<ip>`. A limited
caller gets `429` with a `Retry-After` header. This is a generous bucket
by design — the route is meant to be polled by a public marketing page,
not protected like a per-couple data endpoint.

## CORS — `PUBLIC_DEMO_ALLOWED_ORIGINS`

Set in the environment as a comma-separated list of exact origins, e.g.:

```
PUBLIC_DEMO_ALLOWED_ORIGINS=https://thebloomhouse.ai,https://marketing.thebloomhouse.ai
```

- A request whose `Origin` header is **not** in the list gets `403`
  before any database read (and before the rate limiter is even
  checked).
- A request with **no** `Origin` header at all (server-to-server, curl,
  a health check) is let through with no CORS headers attached — there
  is no browser page reading the response in that case, so there is
  nothing to restrict.
- Leaving the variable unset refuses every browser-originated request.
  Set it before the marketing site goes live against this route.
- `OPTIONS` preflight mirrors the same allow-list.

## What the marketing site must never do with this

- **No PII claims.** Every name, wedding date and couple in this
  response is fiction — the Crestwood roster
  (`scripts/demo-reseed/roster.ts`). Do not present it, label it, or
  imply it is a real couple, a real venue, or real financial data. If
  the marketing site adds any copy near this data ("meet Amara & Theo"),
  it must be unambiguous that this is a demonstration, not a testimonial
  or a case study.
- **No re-hosting as a downloadable dataset.** This is a live snapshot
  for one page, not an export; don't turn it into a public CSV/JSON
  download link.
- **No treating `venue.name` / `venue.slug` as a real, bookable venue.**
  It is Bloom's own demo venue, not a business the visitor can contact.
- **No bypassing the origin allow-list from client code** (e.g. proxying
  the request server-side from an unlisted domain to dodge CORS) without
  first asking Bloom to add that origin to
  `PUBLIC_DEMO_ALLOWED_ORIGINS` — the allow-list exists so Bloom knows
  who is depending on this route before it changes shape.
