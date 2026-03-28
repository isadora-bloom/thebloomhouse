# The Bloom House — TODO

## What Ismar Needs To Do (can't be automated)
- [x] Create fresh Supabase project → put URL + keys in `.env.local`
- [x] Get ANTHROPIC_API_KEY → in `.env.local`
- [x] Get GOOGLE_CLIENT_ID + SECRET → in `.env.local`
- [x] Create GitHub repo → github.com/isadora-bloom/thebloomhouse
- [x] Run migrations 001-008 in Supabase SQL Editor (paste each file in order)
- [x] Run seed.sql in Supabase SQL Editor after migrations

## What Claude Code Is Building (hands off)

### LAYER 0: Foundation
- [x] Scaffold Next.js + TypeScript + Tailwind v4
- [x] `.env.local.example` with all required keys
- [x] Supabase client setup (browser + server + service role)
- [x] AI client (`callAI`, `callAIJson`, `callAIVision` + cost tracking)
- [x] Auth (Supabase Auth + middleware + role-based routing)
- [x] Shell layout (sidebar, venue selector, role-based nav, top bar)
- [x] ALL database migrations (8 files, ~60 tables + venue location fields)
- [x] RLS policies (venue isolation + role-based access)
- [x] Crestwood demo seed (4 venues, 4 consultants, 24 months of data, 47 tables seeded)
- [x] CLAUDE.md for the project

### LAYER 1: The USP (parallel after Layer 0)
**Voice Engine:**
- [x] Universal rules + task prompts + phrase library (ported to TS)
- [x] Personality builder (venue_ai_config → system prompt)
- [x] Phrase selector (anti-duplication per contact)
- [x] Personality configurator page (sliders, vibe, style, signature, live preview)
- [x] Voice training games page (3 games: Would You Send, Cringe or Fine, Quick Quiz)
- [x] Learning loop service (draft_feedback → examples/patterns → Layer 4)

**Intelligence Loop:**
- [x] Google Trends fetch + storage service (SerpAPI)
- [x] NOAA weather fetch + storage service (CDO + Open-Meteo)
- [x] FRED economic fetch + storage service
- [x] Trend recommendation engine (deviation → AI recs)
- [x] Anomaly detection service
- [x] Weekly briefing generator (+ monthly)
- [x] Review language extraction service
- [x] Intel brain (NLQ, positioning suggestions)
- [x] Intel task prompts (7 prompt templates)
- [x] API routes: trends, briefings, anomalies, reviews
- [x] Cron handler (6 jobs: trends, weather, econ, anomaly, weekly/monthly briefing)
- [x] Trends page UI (charts, deviations, recommendations)
- [x] Briefings page UI (weekly/monthly, metrics, history)
- [x] Anomaly alerts UI (on intel dashboard, with acknowledge)
- [x] Reviews page UI (phrase grid, extract modal, approve for Sage/marketing)
- [x] Intelligence → Sage feedback wiring (sage-intelligence.ts)

**Venue Branding:**
- [x] Font pairs config (6 curated wedding font pairs)
- [x] Migration 008 (venue location + branding fields)
- [x] Branding editor page (color pickers, font pair selector, live preview)
- [x] CSS variable injection in couple portal layout

**Knowledge Base:**
- [x] KB editor page (CRUD, categories, priority, search, modal)
- [x] KB keyword retrieval service

**Gmail Service:**
- [x] Gmail OAuth flow + fetch + send (gmail.ts, graceful if googleapis not installed)

### LAYER 2: Products (parallel after Layer 1 dependencies)
**Agent:**
- [x] Router brain (email classification + contact finder + auto-ignore)
- [x] Inquiry brain (4-layer → draft, follow-ups)
- [x] Client brain (4-layer → draft, onboarding, no sales)
- [x] Email pipeline orchestrator (full flow: fetch → classify → draft → approve/send)
- [x] Approval queue page (approve, edit & approve, reject with feedback)
- [x] Pipeline kanban page (6-column board)
- [x] Lead scoring / heat mapping (engagement events, decay, leaderboard)
- [x] Auto-send engine (rules, eligibility check, stats)
- [x] Inbox page (email list + conversation thread)
- [x] Leads/heat map page (distribution bar, sortable table)
- [x] Daily digest email (HTML template + cron job)
- [x] Follow-up sequence engine (3-step sequence + cron job)

**Intelligence Dashboards:**
- [x] Overview dashboard (with anomaly alerts)
- [x] Source attribution page (ROI charts, spend over time)
- [x] Consultant performance page (metrics, comparison chart)
- [x] NLQ chat interface (dedicated page + API route)

**Portal Admin:**
- [x] Active weddings list (expandable cards with timeline/budget/checklist)
- [x] Sage uncertain questions queue (respond + add to KB)
- [x] Coordinator-couple messaging (split-panel thread UI)
- [x] Vendor recommendations manager (CRUD, preferred, types)

**Couple Portal:**
- [x] Couple layout with CSS variable injection (venue-branded colors + fonts)
- [x] Couple dashboard (countdown, stats, timeline, messages, Sage CTA)
- [x] Sage chat (couple-facing AI concierge + API route)
- [x] Timeline builder (visual timeline, add/edit)
- [x] Budget tracker (summary cards, category breakdown, items table)
- [x] Guest list + RSVP (stats, table, add/edit, CSV export)
- [x] Planning checklist (progress bar, overdue alerts, categories)
- [x] Seating chart (CSS-based table map, assign guests)
- [x] Inspo gallery (masonry grid, tags, lightbox, upload)
- [x] Contract upload + analysis (drag-and-drop, AI analysis, ask questions)
- [x] Venue-branded couple login (branded form, role verification)
- [x] Subdomain routing middleware (dev path + production subdomain)

## Status
**Current:** ALL LAYERS COMPLETE. 81 TypeScript files, ~30,000 lines. Every feature in the blueprint is built. Clean TypeScript compile. Ready for testing, polish, and deploy.
**Last updated:** 2026-03-27
