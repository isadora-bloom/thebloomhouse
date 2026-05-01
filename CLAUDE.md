# The Bloom House

## What This Is
Unified wedding venue intelligence platform. Three product areas (Agent, Intelligence, Portal) sharing one database, one auth system, one AI personality engine.

## Architecture
- **Repo:** `C:\Users\Ismar\bloom-house`
- **Stack:** Next.js (App Router) + TypeScript + Tailwind v4 + shadcn/ui + Supabase + Claude API
- **Supabase:** `https://jsxxgwprxuqgcauzlxcb.supabase.co` (fresh project)
- **Full blueprint:** `BLUEPRINT.md` — read this first for architecture, schema, AI system, build order

## Key Principles
1. **Intelligence loop is the USP** — trends, weather, reviews feed back into Agent and Portal behavior
2. **Custom venue voice** — 4-layer prompt system, voice training games, learning loops
3. **Hold the line** — see "WHAT NOT TO BUILD" in BLUEPRINT.md. If it's in that table, don't build it.

## Source Codebases (READ ONLY — never modify these)
- `C:\Users\Ismar\Downloads\bloom-agent-main\bloom-agent-main` — Phil's Agent (Python/FastAPI). Port logic, don't run it.
- `C:\Users\Ismar\bloom` — Intelligence (Next.js/tRPC). Reference for AI wrapper, extraction, reviews.
- `C:\Users\Ismar\bloom-house-portal` — Portal (React/Express). Reference for promptBuilder, Sage chat.
- `C:\Users\Ismar\rixey-portal` — Original Rixey portal. Reference for components, Sage prompt.

## Demo vs Real
- **Demo mode** is cookie-based (`bloom_demo=true`). Visit `/demo` to activate.
- **Real mode** requires Supabase auth (login/signup). No env var needed.
- Demo data uses the fictional "Crestwood Collection" (Hawthorne Manor, Crestwood Farm, The Glass House, Rose Hill Gardens). Not real venues.
- The `NEXT_PUBLIC_DEMO_MODE` env var is deprecated and no longer used.
- Demo banner + DEMO badge appear automatically when the cookie is set.
- Login/signup clears the demo cookie.

## Project Structure
```
src/
  app/(platform)/     — Authenticated shell (Agent, Intel, Portal, Settings)
  app/(auth)/          — Login, signup
  app/demo/            — Demo entry page (sets bloom_demo cookie)
  app/(couple)/        — Couple-facing portal (future — subdomain routing)
  app/api/             — API routes (agent pipeline, intel, portal sage, cron)
  lib/supabase/        — Browser, server, service role clients
  lib/ai/              — callAI, callAIJson, callAIVision + cost tracking
  lib/services/        — Business logic (email pipeline, heat mapping, etc.)
  components/shell/    — Sidebar, venue selector, demo banner, top bar
  components/ui/       — shadcn/ui components
  config/prompts/      — AI prompt templates (universal rules, task prompts)
supabase/
  migrations/          — SQL migrations (run in order)
  functions/           — Edge Functions (email poll, digest, decay)
  seed.sql             — Crestwood demo seed (fictional venues)
```

## Design System
- **Primary:** `#7D8471` (Sage Green) — `sage-500`
- **Secondary:** `#5D7A7A` (Dusty Teal) — `teal-500`
- **Accent:** `#A6894A` (Warm Gold) — `gold-500`
- **Background:** `#FDFAF6` — `warm-white`
- **Fonts:** Playfair Display (headings), Inter (body)
- **Components:** shadcn/ui + Tailwind
- **Icons:** lucide-react

## Commands
```bash
npm run dev     # http://localhost:3000
npm run build   # production build
npm run lint    # eslint
```

## Database
Fresh Supabase project. Migrations in `supabase/migrations/`. Schema follows ownership rules in BLUEPRINT.md §2-6.

## AI System
All AI calls go through `lib/ai/client.ts` (callAI, callAIJson, callAIVision). Every call logged to `api_costs` table. Claude primary; OpenAI fallback gated by circuit breaker (T1-F) at `lib/ai/circuit-breaker.ts` — env vars `AI_FORCE_FALLBACK` / `AI_DISABLE_FALLBACK` for manual override.

Each brain module exports a `BRAIN_PROMPT_VERSION` constant (T1-E) that gets logged to `api_costs.prompt_version`. See `PROMPTS-CHANGELOG.md` at the repo root for the per-prompt revision history. Bumping a prompt requires updating the constant + adding a changelog row.

## Observability
Structured logger at `lib/observability/logger.ts` (T1-G) emits JSON-line events with required fields (level / msg / venue_id / correlation_id / actor / event_type / outcome / latency_ms / ts). PII redaction wraps msg + data via `lib/observability/redact.ts`. `processIncomingEmail` mints a correlation id at entry and threads through brain calls + draft writes.

## Coordinator surfaces (admin pages)

### Sage's Brain → Voice & Personality
- `/agent/learning` — Teach voice
- `/agent/rules` — Always / Never rules

### Sage's Brain → Inquiry behaviour
- `/agent/settings` — Auto-send + follow-ups
- `/agent/forbidden-topics` — per-venue forbidden topic keywords (T1-J / B-21). Reads `venue_forbidden_topics` (migration 125). `checkEscalationForVenue` merges these with global ESCALATION_KEYWORDS.
- `/agent/identity-windows` — per-platform decay windows for the candidate-resolver (T2-D / ARCH-8.5.3). Defaults at `lib/services/identity-windows-constants.ts`.

### Sage's Brain → Internal context (T2-B Phase 2)
- `/portal/marketing-channels-config` — venue-scoped channel registry (LIMB-16.2.4-A). Replaces the global CANONICAL_SOURCES const.
- `/portal/absences-config` — coordinator absence windows (LIMB-16.2.1-A). Loaded into anomaly-detection hypothesis prompt.
- `/portal/property-state-config` — renovation / closure / vendor-change / policy-change windows (LIMB-16.2.2). Same hypothesis-prompt loader.

### Sage's Brain → Onboarding
- `/onboarding` — quick 15-min wizard (legacy, friend-of-Isadora venues)
- `/onboarding/project` — 5-day enterprise project flow (T2-A). One active project per venue. Steps link out to the actual work surfaces; coordinator marks done.

### Intel → Demand
- `/intel/cultural-moments` — propose-and-confirm queue (T2-C / INS-19.5.8). Confirmed moments enter the correlation engine's External Context.

### Agent surfaces
- `/agent/audio-inbox` (was `/agent/omi-inbox`) — orphan transcripts from any audio-capture provider (T2-E Phase 2 / ARCH-5.4)
- `/settings/audio-capture` (was `/settings/omi`) — provider-agnostic audio settings

## External Context (T2-C)
`lib/services/external-context/` owns the channel loaders for the correlation engine:
- `fred.ts` — DEFAULT_FRED_SERIES (CPI / mortgage rate / S&P 500 / unemployment / consumer sentiment), forward-fill from monthly to daily
- `cultural-moments.ts` — propose / confirm / dismiss + per-day series projection
- `calendar.ts` — hierarchical geo_scope (us → us_<state> → us_<state>_<metro>) with per-category channel split
- `stats.ts` — Acklam inverse-normal + Cornish-Fisher t-correction + Bonferroni critical r derivation

`correlation-engine.ts` `buildSeries` appends these alongside the Internal channels (inquiries / marketing_metric / tangential_signals) and runs lagged Pearson with Bonferroni-corrected significance.

## Heat scoring
Heat-map dedup (2026-05-01 fix) — `tour_requested` / `high_commitment_signal` / `family_mentioned` / `high_specificity` / `tour_cancelled` / `not_interested_signal` are FIRE-ONCE-PER-WEDDING. Reopen-aware: if `weddings.lost_at` is more recent than the existing event, dedup is bypassed (allows fresh fire on a re-engaged lead). `dedup-fire-once-events.ts` is the maintenance script for cleaning up legacy multi-fires + tour_completed-after-cancellation false positives.
