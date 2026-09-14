# Security audit, 2026-09-14

Six read-only auditors, one attack surface each, run against `consolidation` after the
November-plan verification. Every finding below was traced in code (VERIFIED) unless marked
PLAUSIBLE. Remediation is running as workstreams S1 to S5 (last section); items marked OPERATOR
need Isadora. Nothing here was exploited, no request was sent, no database was written.

## Do these first (operator)

1. **Rotate the Supabase service-role key.** It was committed in five one-off seed scripts under
   `supabase/` and the GitHub repository is public. The files are gone from the tree (8e98090b);
   history still holds them. Rotation is the only fix. Treat every secret in the same
   `.env.local` as exposed until proven otherwise.
2. **Rotate `CRON_SECRET`** to 32 random bytes. The production value is a short guessable literal.
   It gates 92 admin endpoints (many take a venue id from the body), every cron job, and it signs
   the OAuth state for Google, Meta, TikTok and Instagram. Set `CRON_SECRET_DESTRUCTIVE` too.
3. **Set `STRIPE_WEBHOOK_SECRET` and `CALENDLY_WEBHOOK_SECRET`** in Vercel production. Both routes
   fail open when unset (S2 makes them fail closed in code).
4. **Apply migration 411** when S3 lands: it closes the storage buckets (five buckets public with
   anonymous read, write and delete since migration 028), the token columns any logged-in user
   can read, and the demo-anon policies that expose `venue_config` tokens.
5. **Bump `next`** past 16.3.2 (critical advisory, middleware bypass class) with `sharp` and
   `postcss` (S5 does the bump; you deploy it).
6. Set `APP_CANONICAL_HOST`, `STATE_SIGNING_SECRET`, `DEMO_SIGNING_SECRET` in production if any
   is blank there; the local snapshot has three of them blank.

## Critical

| id | where | what | fix by |
|---|---|---|---|
| SEC-C1 | five `supabase/*seed*` files (removed) | production service-role JWT in a public repo | OPERATOR rotate |
| SEC-C2 | migration 028 storage policies | `contracts`, `vendor-contracts`, `couple-photos`, `inspo-gallery`, `venue-assets` public with anon SELECT/INSERT/UPDATE/DELETE; migration 038 adds authenticated policies scoped on bucket only, so any couple or coordinator can list, download and delete every venue's contracts and photos; `day-of-media` (097) the same | S3 |
| SEC-C3 | `api/team/invite`, `api/team/accept` | no auth on invite, role and org from the body, token returned in the response; accept binds an invitation to an existing user without that user authenticating. Org takeover from a known org id (which `venue-groups/tree` hands to any member) | S1 |
| SEC-C4 | `api/webhooks/stripe`, `api/webhooks/calendly` | unset secret means parse-and-trust; forged subscription events change any venue's plan; forged Calendly events mint tours | S2 + OPERATOR |
| SEC-C5 | `.env.production` `CRON_SECRET` | short literal, four jobs at once | S2 helper + OPERATOR rotate |
| SEC-C6 | `form-relay-parsers.ts` shape heuristic | any email with two labelled lines picks the reply address from its own body, skips the classifier and noise guards, and can be auto-sent to that address from the venue's Gmail | S4a |
| SEC-C7 | `intel/agencies/[id]/**` cluster | no venue scoping anywhere; read, edit, delete another venue's agencies, contacts and documents | S5 |
| SEC-C8 | `next` 16.2.1 | critical advisory | S5 + OPERATOR deploy |

## High

| id | where | what | fix by |
|---|---|---|---|
| SEC-H1 | `middleware.ts` `/demo/*` rewrite | `/demo/api/...` reaches any API route with a minted demo coordinator identity; `wipe-pipeline-data` has no demo guard | S1 |
| SEC-H2 | 90 admin routes | inline bearer comparison yields `Bearer undefined` when the secret is unset; the fail-closed helper exists but is unused | S2 |
| SEC-H3 | `auth/signup` | no rate limit, `email_confirm: true`, unknown role creates a profile-less user that a later team invite binds | S1 |
| SEC-H4 | `client-ip.ts` | leftmost `x-forwarded-for`, client-supplied, so all seven IP rate limits can be reset per request | S4b |
| SEC-H5 | `public/sage-preview` | any venue slug, model spend attributed to that venue, no cost gate | S4b |
| SEC-H6 | `next.config.ts` | no security headers at all; the contract signing page is frameable | S5 |
| SEC-H7 | migrations 310, 097 | `google_ads_connections`, `zoom_connections`, `openphone_connections` return tokens to any authenticated user (no column grants) | S3 |
| SEC-H8 | migrations 027/147/064/383 | demo-anon read and write on `venue_config` (Gmail, Calendly, OMI tokens); `gmail_connections` anon-readable again | S3 |
| SEC-H9 | `connectors/shared.ts`, `instagram-meta.ts` + grants in 401/407 | a venue can set `token_env_key` to any variable name, including the service-role key; `ig_business_id` can pre-claim another venue's account | S3 grants + S2 allow-list |
| SEC-H10 | `settings/sending-domain` | a demo (anonymous) session can register arbitrary domains in the shared Resend account | S1 |
| SEC-H11 | `asset-matcher.ts` | fetches a coordinator-pasted URL raw and mails the bytes (SSRF with an out-of-band channel) | S5 |
| SEC-H12 | `email/gmail.ts` | header injection: CR/LF in To, Cc, Subject, filenames reach the raw RFC 2822 assembly | S5 |
| SEC-H13 | `portal/sage/route.ts` `fileContext` | client-supplied text lands in the system prompt raw and uncapped | S4b |
| SEC-H14 | `couple-prompt.ts` + contract analysis | coordinator's confidential notes are in context while the model reads a document the couple uploaded | S4b |
| SEC-H15 | `referenced-couple-resolver.ts` | model output re-points a thread to another couple at 0.55 similarity, no venue predicate | S4a |
| SEC-H16 | `brain/client.ts` | booked-couple email body enters the prompt unwrapped | S4a |
| SEC-H17 | `intel/tools.ts` grounding | numbers inside ingested prose (reviews, quotes) count as grounded facts | S4b |
| SEC-H18 | tool results | ingested prose returns to the coordinator brain unwrapped (indirect injection) | S4b |
| SEC-H19 | `lifecycle/signal-detector.ts` | text alone can flip a wedding to booked | S4a |
| SEC-H20 | agency documents download/upload | signed URL and storage folder from an unchecked path param | S5 |
| SEC-H21 | `brain-dump/route.ts` | downloads a caller-supplied storage path; with C2, enumerate then read other venues' uploads | S4a |
| SEC-H22 | `intel/benchmark` group scope, `intel/voice-dna` | null org id or demo skips the org check | S1 |
| SEC-H23 | `positioning`, `weekly-learned`, `agencies` GET, `admin/lifecycle/apply`, `portal/invite-couple` (writes before the check) | venue or wedding id trusted from the request | S1 |
| SEC-H24 | `drafts/[id]/send` and insights | role check tests `'admin'`/`'manager'`, roles that do not exist | S1 |
| SEC-H25 | deps | `sharp`, `postcss`, `ws`, `nanoid`, `protobufjs`, `qs` high; `xlsx` 0.18.5 no fix, parses uploads | S5 |

## Medium and low (summary)

Knowledge-base `.or(ilike)` built from the couple's raw message (chat 500 on one character);
venue-internal anomaly alerts in the couple prompt guarded by a sentence; sign-off missing on
three canned replies and the public preview; `injectionSuspected` is a fixed English regex list and
the only auto-send block; escalation detector unwrapped; `bucket` argument unvalidated;
`NLQ_LEGACY` env flag silently disables grounding; seven id-list queries with no venue predicate;
`approvePhraseForSage` cross-venue; four model-spending routes with no limit; CSV formula
injection in every export; stored listing regexes run with no timeout (a ReDoS stalls the shared
cron tick); any org member can rewrite `venue_config.feature_flags`; year-long signed URLs persisted
in `contracts.file_url`; contract sign token never expires; SVG logos accepted into a public
bucket; Zoom token object logged; seating import unbounded; `.or()` filters unescaped in three
routes; raw `error.message` returned by about 90 routes (guard scope too narrow); about 140 admin
routes with no role gate; `wipe-pipeline-data` behind a `?confirm=YES`; `tracking` and
`section-config` trust a venue id; benchmark ignores the opt-in; `bloom_scope`/`bloom_venue`
cookies without `secure`/`sameSite`; demo cookie survives sign-out for 24h; team invite token
plaintext; vendor portal token plaintext; `knot_template_patterns` anon-readable; Gmail `returnTo`
accepts a backslash host; wedding-website password plaintext and in the query string; couple
forgot-password page unreachable through the middleware; OMI webhook token in the query string
with no rate limit; pixel ingest limiter is per-instance; `payload.ts` unbounded; Zoom state
secret falls back to a literal; auth callback redirects on the Host header.

## Done well

Twilio and Instagram webhook signature checks (raw body, constant time, 503 when unset). The
durable Postgres rate limiter with a circuit breaker. The demo token (HMAC, HttpOnly, fail-closed
key). `safe-fetch.ts` and its use on the couple upload path. `exec_sql` locked to the service role
with no caller under `src/`. The couple portal's `getCoupleAuth` double-filtering and field
allow-lists; mass assignment came back clean across the API. The coordinator brain binds the venue
server-side with no tenant in any tool argument. `profile-reflection-scope.ts` as an allow-list.
The contract template and PDF writer escape everything. `normalizeHandle`.

## Remediation workstreams (launched 2026-09-14, all worktrees on `consolidation`)

| | scope |
|---|---|
| S1 | team invite/accept, signup, `/demo` rewrite, demo refusal guard + CI check, the eight trusted-id routes, benchmark/voice-dna, role helper on admin routes, rate limits, returnTo, site password |
| S2 | Stripe and Calendly fail closed, `verifyCronAuth` everywhere + CI guard, destructive tier, OAuth state on its own key with user binding and nonce, secret-scan CI guard |
| S3 | migration 411: storage policies and public flags, token column grants, demo-anon policies, env-var-name constraint and grants, Twilio number uniqueness, invite and vendor token hash columns, feature_flags role policy; live policy report script; storage-policy static guard |
| S4a | form-relay heuristic, client brain wrapping, lifecycle gate, referenced-couple proposal, escalation, auto-send allow-list default, planning extraction, review response, brain-dump path prefix |
| S4b | couple chat `fileContext`, coordinator notes out of couple-controlled modes, intelligence gating, sign-off chokepoint, knowledge-base escaping, preview limits and cost gate, trusted client IP, grounding from typed fields, tool-result wrapping, argument validation, `NLQ_LEGACY`, venue predicates |
| S5 | security headers, dependency bumps, CSV formula escape, ReDoS guard, agency cluster scoping, signed URL TTLs, sign token expiry, Gmail header stripping, SSRF sites, email HTML escaping, uploads, cookies, demo sign-out, small ones |

Not covered by any auditor: live `pg_policies` (all RLS findings are from migration files; S3's
read-only script reports the live state), Supabase Edge Functions, Server Actions, e2e tests, the
Vercel dashboard's actual environment values.

## Remediation status (same day)

All six workstreams merged on `consolidation`: S3 (6338fb51, migration 411 + two guards), S2
(b80d0260), S1 (600e771a), S4b (bbd1017a), S4a (56af9244), S5 (532e7e4c). New CI guards:
`check-storage-policies-scoped`, `check-cron-auth-helper`, `check-no-secrets`,
`check-demo-refused-on-writes`, the disclosure guard's chat check, and the RLS ratchet at zero.

Left open, with an owner named:
- OPERATOR: rotate the service-role key and `CRON_SECRET`; set `CRON_SECRET_DESTRUCTIVE`,
  `STATE_SIGNING_SECRET`, `STRIPE_WEBHOOK_SECRET`, `CALENDLY_WEBHOOK_SECRET` in Vercel production
  BEFORE master moves (cron jobs, OAuth connects and both webhooks refuse without them); apply 411
  (its storage half may need the SQL editor, `scripts/check-live-policies.mjs` shows before and
  after); regenerate `types.generated.ts` after the migrations and delete the 24 `as unknown as`
  casts they forced; confirm the `venue-assets` bucket excludes `image/svg+xml`; CI installs now
  need `cdn.sheetjs.com` for `xlsx` 0.20.3.
- CODE, follow-up: `day-of-memories-tab.tsx` hand-builds a public URL for a bucket 411 makes
  private (needs `createSignedUrl`); `settings/page.tsx` selects `*` from `venue_config` and
  writes it from the browser (411 restricts both; route the writes through an API and name the
  columns); `booked_vendors.portal_token` hash column exists, code still reads plaintext; the
  in-process OAuth nonce set does not catch a cross-instance replay; the CSP still carries
  `unsafe-inline`/`unsafe-eval` until a nonce is minted in middleware; ~140 admin routes remain
  coordinator-reachable by design (list in S1's report); 64 commits on this branch fail
  `check-pr-cites-section` (inert in CI because of the shallow checkout; do not relax it, cite a
  W-tag in every commit from now on).
- The plan's own headline goal (every visible number through the canonical layer) is not met:
  255 legacy reads remain and `/agent/leads` and `/agent/pipeline` still read `weddings`
  directly. That is a wave, not a patch.
