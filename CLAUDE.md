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
All AI calls go through `lib/ai/client.ts` (callAI, callAIJson, callAIVision). Every call logged to `api_costs` table. Claude primary, no fallback in v1.
