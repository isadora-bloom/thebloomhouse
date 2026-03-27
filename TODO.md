# The Bloom House — TODO

## What Ismar Needs To Do (can't be automated)
- [ ] Create fresh Supabase project → put URL + keys in `.env.local`
- [ ] Get ANTHROPIC_API_KEY from Phil or use existing → put in `.env.local`
- [ ] Get GOOGLE_CLIENT_ID + SECRET (Gmail OAuth) from Phil → put in `.env.local`
- [ ] Create GitHub repo (github.com/isadora-bloom/bloom-house or similar) and push

## What Claude Code Is Building (hands off)

### LAYER 0: Foundation
- [ ] Scaffold Next.js 14 + TypeScript + Tailwind v4 + shadcn/ui
- [ ] `.env.local.example` with all required keys
- [ ] Supabase client setup (browser + server + service role)
- [ ] AI client (`callAI`, `callAIJson`, `callAIVision` + cost tracking)
- [ ] Auth (Supabase Auth + middleware + role-based routing)
- [ ] Shell layout (sidebar, venue selector, role-based nav, top bar)
- [ ] ALL database migrations (shared + agent + intel + portal + AI tables)
- [ ] RLS policies (venue isolation + role-based access)
- [ ] Crestwood demo seed (4 venues, 4 consultants, 24 months of data)
- [ ] CLAUDE.md for the project

### LAYER 1: The USP (parallel after Layer 0)
**Voice Engine:**
- [ ] Universal rules + task prompts + phrase library (ported to TS)
- [ ] Personality builder (venue_ai_config → system prompt)
- [ ] Phrase selector (anti-duplication per contact)
- [ ] Personality configurator page (sliders, vibe, style, signature)
- [ ] Voice training games page (3 games → voice_preferences)
- [ ] Learning loop service (draft_feedback → examples/patterns → Layer 4)

**Intelligence Loop:**
- [ ] Google Trends fetch + storage service
- [ ] NOAA weather fetch + storage service
- [ ] FRED economic fetch + storage service
- [ ] Trend recommendation engine (deviation → AI recs)
- [ ] Seasonal intelligence (lead-time patterns → time-aware recs)
- [ ] Anomaly detection service
- [ ] Weekly briefing generator
- [ ] Review language extraction service
- [ ] Intelligence → Sage feedback wiring
- [ ] Trends page UI
- [ ] Briefings page UI
- [ ] Anomaly alerts UI

**Knowledge Base:**
- [ ] KB editor page (CRUD, categories, priority)
- [ ] KB keyword retrieval service

**Gmail Service:**
- [ ] Gmail OAuth flow
- [ ] Email fetch service
- [ ] Email send service

### LAYER 2: Products (parallel after Layer 1 dependencies)
**Agent:**
- [ ] Router brain (email classification)
- [ ] Inquiry brain (4-layer → draft)
- [ ] Client brain (4-layer → draft, no sales)
- [ ] Email pipeline orchestrator
- [ ] Approval queue page
- [ ] Pipeline kanban page
- [ ] Lead scoring / heat mapping
- [ ] Auto-send settings (inquiry vs client)
- [ ] Daily digest email
- [ ] Follow-up sequence engine

**Intelligence Dashboards:**
- [ ] Overview dashboard
- [ ] Source attribution
- [ ] Consultant performance
- [ ] NLQ interface

**Portal Admin:**
- [ ] Active weddings list
- [ ] Sage uncertain questions queue
- [ ] Coordinator-couple messaging
- [ ] Vendor recommendations manager

**Couple Portal:**
- [ ] Subdomain routing middleware
- [ ] Venue-branded couple login
- [ ] Sage chat (couple-facing)
- [ ] Timeline builder
- [ ] Budget tracker
- [ ] Guest list + RSVP
- [ ] Seating chart
- [ ] Vendor checklist
- [ ] Planning checklist
- [ ] Inspo gallery
- [ ] Contract upload + vision analysis

## Status
**Current:** Starting Layer 0
**Last updated:** 2026-03-27
