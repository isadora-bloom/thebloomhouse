---
name: The Bloom House — Complete Platform Blueprint
description: Unified platform spec for Agent + Intelligence + Portal. Architecture, schema, AI system, design system, intelligence loops, build order. The master document before any code is written.
type: project
---

# The Bloom House — Complete Platform Blueprint

**Date:** 2026-03-27
**Status:** Pre-build — no code until this is approved
**Repo:** `C:\Users\Ismar\bloom-house` (to be created)
**Domain:** `bloomhouse.ai`

---

## 1. WHAT THIS IS

One Next.js application with three product areas sharing one Supabase database, one auth system, and one AI personality engine.

- **Agent** — the coordinator's hands (email processing, drafts, pipeline, lead scoring)
- **Intelligence** — the owner's brain (analytics, attribution, trends, proactive recommendations)
- **Portal** — the couple's face (planning tools, AI concierge, wedding website)

Each area has its own routes, its own owned tables, and could be extracted to its own repo later. But today it's one app, one deploy, one team (Ismar + Claude Code).

---

## 2. STACK

```
Framework:     Next.js 14 App Router + TypeScript
Styling:       Tailwind CSS v4 + shadcn/ui (Radix primitives)
Database:      Supabase (fresh project — PostgreSQL + Auth + Storage + Edge Functions)
AI:            Anthropic Claude (primary), OpenAI GPT-4o (fallback), Whisper (voice)
Email:         Gmail API (OAuth 2.0) + Resend (transactional)
Icons:         lucide-react (latest)
Charts:        recharts
Dates:         date-fns
Deployment:    Vercel
Cron:          Vercel Cron + Supabase Edge Functions
```

**No Python. No Express. No tRPC. No Prisma. No Turborepo.**
One stack. Supabase client for all database access. Next.js API routes for server logic.

---

## 3. DESIGN SYSTEM

### Colors

**Primary:** `#7D8471` (Sage Green) — buttons, active states, primary actions
**Secondary:** `#5D7A7A` (Dusty Teal) — secondary actions, links, info states
**Accent:** `#A6894A` (Warm Gold) — highlights, badges, premium features
**Background:** `#FDFAF6` (Warm White) — page background
**Surface:** `#FFFFFF` — cards, panels
**Border:** `#E8E4DF` — subtle borders

**Semantic:**
- Success: `#2D8A4E`
- Warning: `#D97706`
- Destructive: `#DC2626`
- Info: `#3B82F6`

**Heat Map (Agent lead scoring):**
- Hot: `#EF4444`
- Warm: `#F59E0B`
- Cool: `#3B82F6`
- Cold: `#1E40AF`
- Frozen: `#6B7280`

**Per-Venue Overrides:**
Venues can set `primary_color`, `secondary_color`, `accent_color` in `venue_config`. These override the defaults via CSS custom properties for the couple-facing Portal. The admin/Agent/Intel side always uses the Bloom House brand colors.

### Typography

**Headings:** Playfair Display (serif) — via `next/font/google`
**Body/UI:** Inter (sans-serif) — via `next/font/google`

```css
--font-heading: 'Playfair Display', serif;
--font-body: 'Inter', sans-serif;
```

### Component Library

**shadcn/ui** — installed components, customized with Bloom colors:
- Button, Card, Dialog, Dropdown, Input, Select, Tabs, Table, Badge, Avatar, Tooltip
- Sidebar (custom, based on shadcn patterns)
- All styled via Tailwind with CSS variables

### CSS Architecture

```css
/* Tailwind v4 — @theme block in globals.css */
@theme {
  --color-sage-50: #F2F3F1;
  --color-sage-100: #E0E3DD;
  --color-sage-200: #C1C7BB;
  --color-sage-300: #A2AB99;
  --color-sage-400: #8F9A85;
  --color-sage-500: #7D8471;  /* PRIMARY */
  --color-sage-600: #6A7060;
  --color-sage-700: #575C4F;
  --color-sage-800: #44483E;
  --color-sage-900: #31342D;

  --color-teal-500: #5D7A7A;  /* SECONDARY */
  --color-gold-500: #A6894A;  /* ACCENT */

  --color-warm-white: #FDFAF6;
  --color-surface: #FFFFFF;
  --color-border: #E8E4DF;

  --font-heading: 'Playfair Display', serif;
  --font-body: 'Inter', sans-serif;
}
```

---

## 4. ROUTING & DOMAIN ARCHITECTURE

### Platform (authenticated — coordinator/owner/admin)
```
app.bloomhouse.ai/                     → Dashboard (role-based redirect)
app.bloomhouse.ai/agent/inbox          → Email inbox & conversations
app.bloomhouse.ai/agent/drafts         → Approval queue
app.bloomhouse.ai/agent/pipeline       → Kanban lead pipeline
app.bloomhouse.ai/agent/leads          → Heat map & lead scoring
app.bloomhouse.ai/agent/settings       → Agent config, auto-send rules
app.bloomhouse.ai/intel/dashboard      → Analytics overview
app.bloomhouse.ai/intel/sources        → Source attribution & ROI
app.bloomhouse.ai/intel/team           → Consultant performance
app.bloomhouse.ai/intel/trends         → Google Trends & market intelligence
app.bloomhouse.ai/intel/briefings      → AI briefings & recommendations
app.bloomhouse.ai/intel/reviews        → Review analysis & Sage vocabulary
app.bloomhouse.ai/portal/weddings      → Active weddings list
app.bloomhouse.ai/portal/sage-queue    → Uncertain questions review
app.bloomhouse.ai/portal/messages      → Coordinator-couple messaging
app.bloomhouse.ai/portal/kb            → Knowledge base editor
app.bloomhouse.ai/portal/vendors       → Vendor recommendations manager
app.bloomhouse.ai/settings             → Venue config, branding, integrations
app.bloomhouse.ai/settings/voice       → Voice training games
app.bloomhouse.ai/settings/personality → AI personality configurator
app.bloomhouse.ai/onboarding          → New venue setup wizard
app.bloomhouse.ai/super-admin          → Multi-venue management (super admins)
```

### Couple-Facing Portal (public or couple-authenticated)
```
[venue-slug].bloomhouse.ai/            → Couple dashboard (login required)
[venue-slug].bloomhouse.ai/login       → Couple login
[venue-slug].bloomhouse.ai/chat        → Sage AI concierge
[venue-slug].bloomhouse.ai/timeline    → Wedding timeline
[venue-slug].bloomhouse.ai/budget      → Budget tracker
[venue-slug].bloomhouse.ai/guests      → Guest list & RSVP
[venue-slug].bloomhouse.ai/seating     → Table map & seating
[venue-slug].bloomhouse.ai/vendors     → Vendor checklist
[venue-slug].bloomhouse.ai/checklist   → Planning checklist
[venue-slug].bloomhouse.ai/inspo       → Inspiration gallery
[venue-slug].bloomhouse.ai/website     → Wedding website builder
```

### Implementation

Next.js middleware handles routing:
- Requests to `app.bloomhouse.ai/*` → platform app (authenticated shell)
- Requests to `*.bloomhouse.ai/*` → couple-facing portal (venue resolved from subdomain)
- In development: `localhost:3000` for platform, `localhost:3000/couple/[venue-slug]` for couple portal

---

## 5. PROJECT STRUCTURE

```
bloom-house/
├── app/
│   ├── (auth)/                        ← Login, signup, forgot password
│   │   ├── login/page.tsx
│   │   ├── signup/page.tsx
│   │   └── layout.tsx
│   ├── (platform)/                    ← Authenticated shell
│   │   ├── layout.tsx                 ← Shell: sidebar + nav + venue selector
│   │   ├── page.tsx                   ← Dashboard (role-based)
│   │   ├── agent/
│   │   │   ├── inbox/page.tsx
│   │   │   ├── drafts/page.tsx
│   │   │   ├── pipeline/page.tsx
│   │   │   ├── leads/page.tsx
│   │   │   └── settings/page.tsx
│   │   ├── intel/
│   │   │   ├── dashboard/page.tsx
│   │   │   ├── sources/page.tsx
│   │   │   ├── team/page.tsx
│   │   │   ├── trends/page.tsx
│   │   │   ├── briefings/page.tsx
│   │   │   └── reviews/page.tsx
│   │   ├── portal/
│   │   │   ├── weddings/page.tsx
│   │   │   ├── sage-queue/page.tsx
│   │   │   ├── messages/page.tsx
│   │   │   ├── kb/page.tsx
│   │   │   └── vendors/page.tsx
│   │   ├── settings/
│   │   │   ├── page.tsx               ← General venue settings
│   │   │   ├── voice/page.tsx         ← Voice training games
│   │   │   └── personality/page.tsx   ← AI personality configurator
│   │   ├── onboarding/page.tsx
│   │   └── super-admin/page.tsx
│   ├── (couple)/                      ← Couple-facing portal
│   │   ├── layout.tsx                 ← Couple shell (venue-branded)
│   │   ├── page.tsx                   ← Couple dashboard
│   │   ├── chat/page.tsx              ← Sage concierge
│   │   ├── timeline/page.tsx
│   │   ├── budget/page.tsx
│   │   ├── guests/page.tsx
│   │   ├── seating/page.tsx
│   │   ├── vendors/page.tsx
│   │   ├── checklist/page.tsx
│   │   ├── inspo/page.tsx
│   │   └── website/page.tsx
│   └── api/
│       ├── agent/
│       │   ├── pipeline/route.ts      ← Email processing
│       │   ├── drafts/route.ts        ← Draft CRUD + approve/reject
│       │   ├── gmail/route.ts         ← Gmail OAuth + send
│       │   └── heat/route.ts          ← Lead scoring
│       ├── intel/
│       │   ├── attribution/route.ts   ← Source ROI calculations
│       │   ├── trends/route.ts        ← Google Trends + recommendations
│       │   ├── briefings/route.ts     ← AI briefing generation
│       │   ├── anomalies/route.ts     ← Anomaly detection
│       │   └── reviews/route.ts       ← Review analysis
│       ├── portal/
│       │   ├── sage/route.ts          ← Sage chat (couple-facing)
│       │   ├── contracts/route.ts     ← Contract vision analysis
│       │   └── reminders/route.ts     ← Automated reminders
│       ├── cron/route.ts              ← Vercel cron handler
│       ├── webhooks/
│       │   ├── stripe/route.ts
│       │   └── calendly/route.ts
│       └── auth/
│           └── callback/route.ts      ← OAuth callbacks
├── lib/
│   ├── supabase/
│   │   ├── client.ts                  ← Browser client
│   │   ├── server.ts                  ← Server client (cookies)
│   │   ├── service.ts                 ← Service role client (admin)
│   │   └── types.ts                   ← Generated types
│   ├── ai/
│   │   ├── client.ts                  ← callAI, callAIJson, callAIVision (from Intel)
│   │   ├── personality-builder.ts     ← Build system prompt from venue_ai_config (from Agent)
│   │   ├── phrase-selector.ts         ← Anti-duplication phrase selection (from Agent)
│   │   └── cost-tracker.ts            ← Log AI costs to ai_usage_log
│   ├── services/
│   │   ├── email-pipeline.ts          ← Gmail fetch → classify → draft → approve (from Agent)
│   │   ├── router-brain.ts            ← Email classification (from Agent)
│   │   ├── inquiry-brain.ts           ← Inquiry draft generation (from Agent)
│   │   ├── client-brain.ts            ← Client draft generation (from Agent)
│   │   ├── sage-brain.ts              ← Couple chat (from Portal promptBuilder)
│   │   ├── intel-brain.ts             ← Briefings, anomaly explanations, NLQ
│   │   ├── heat-mapping.ts            ← Lead scoring engine (from Agent)
│   │   ├── learning.ts                ← Feedback loops (from Agent)
│   │   ├── autonomous-sender.ts       ← Auto-send rules (from Agent)
│   │   ├── gmail.ts                   ← Gmail API client (rewritten from Python)
│   │   ├── extraction.ts              ← Signal extraction (from Intel)
│   │   ├── review-language.ts         ← Review phrase analysis (from Intel)
│   │   ├── trends.ts                  ← Google Trends + seasonal intelligence
│   │   ├── weather.ts                 ← NOAA weather data
│   │   ├── economics.ts               ← FRED economic indicators
│   │   └── attribution.ts             ← Source ROI calculations
│   └── utils/
│       ├── dates.ts
│       └── validation.ts
├── config/
│   ├── prompts/
│   │   ├── universal-rules.ts         ← Layer 1 (from Agent — unchanged)
│   │   ├── task-prompts-inquiry.ts    ← Layer 3 inquiry tasks (from Agent)
│   │   ├── task-prompts-client.ts     ← Layer 3 client tasks (from Agent)
│   │   ├── task-prompts-sage.ts       ← Layer 3 couple chat tasks (from Portal)
│   │   └── task-prompts-intel.ts      ← Layer 3 briefing/analysis tasks (new)
│   ├── phrase-library.ts              ← Phrase variants by style (from Agent)
│   ├── escalation-keywords.ts         ← Escalation triggers (from Agent)
│   └── seasonal-language.ts           ← Seasonal imagery defaults (from Agent)
├── components/
│   ├── shell/
│   │   ├── sidebar.tsx                ← Platform sidebar with role-based sections
│   │   ├── venue-selector.tsx         ← Multi-venue dropdown
│   │   ├── top-bar.tsx                ← Mobile header
│   │   └── user-menu.tsx              ← Avatar + profile dropdown
│   ├── agent/
│   │   ├── approval-queue.tsx         ← Draft approval cards (from Agent)
│   │   ├── draft-card.tsx             ← Individual draft with approve/edit/reject
│   │   ├── inbox-thread.tsx           ← Email conversation view
│   │   ├── pipeline-board.tsx         ← Kanban board (from Agent)
│   │   ├── lead-card.tsx              ← Lead with heat score
│   │   ├── heat-badge.tsx             ← Temperature indicator
│   │   ├── auto-send-settings.tsx     ← Per-source auto-send config
│   │   └── daily-digest.tsx           ← Dashboard summary
│   ├── intel/
│   │   ├── source-chart.tsx           ← Attribution by source (recharts)
│   │   ├── consultant-table.tsx       ← Performance comparison
│   │   ├── trend-card.tsx             ← Google Trends insight card
│   │   ├── briefing-panel.tsx         ← Weekly AI briefing display
│   │   ├── anomaly-alert.tsx          ← Metric deviation alert
│   │   ├── recommendation-card.tsx    ← Proactive AI recommendation
│   │   └── review-phrase-manager.tsx  ← Approve phrases for Sage
│   ├── portal/
│   │   ├── wedding-list.tsx           ← Active weddings grid
│   │   ├── sage-queue-item.tsx        ← Uncertain question card
│   │   ├── message-thread.tsx         ← Coordinator-couple chat
│   │   ├── kb-editor.tsx              ← Knowledge base CRUD
│   │   └── vendor-card.tsx            ← Vendor recommendation
│   ├── couple/                        ← Couple-facing components
│   │   ├── sage-chat.tsx              ← Sage concierge interface
│   │   ├── timeline-builder.tsx       ← Day-of timeline
│   │   ├── budget-tracker.tsx         ← Budget categories
│   │   ├── guest-list.tsx             ← Guest management + RSVP
│   │   ├── seating-chart.tsx          ← Table map (react-konva)
│   │   ├── vendor-checklist.tsx       ← Vendor tracking
│   │   ├── planning-checklist.tsx     ← Planning milestones
│   │   ├── inspo-gallery.tsx          ← Inspiration board
│   │   └── wedding-website.tsx        ← Website builder
│   ├── settings/
│   │   ├── voice-training.tsx         ← Voice training games (from Agent)
│   │   ├── personality-config.tsx     ← AI dimension sliders
│   │   ├── gmail-connect.tsx          ← Gmail OAuth flow
│   │   └── branding-editor.tsx        ← Colors, fonts, logo upload
│   └── ui/                            ← shadcn/ui components
│       ├── button.tsx
│       ├── card.tsx
│       ├── dialog.tsx
│       ├── input.tsx
│       ├── select.tsx
│       ├── badge.tsx
│       ├── tabs.tsx
│       ├── table.tsx
│       └── ...
├── supabase/
│   ├── migrations/
│   │   ├── 001_shared_tables.sql      ← venues, venue_config, weddings, people, contacts, etc.
│   │   ├── 002_agent_tables.sql       ← interactions, drafts, engagement_events, etc.
│   │   ├── 003_intel_tables.sql       ← marketing_spend, attribution, trends, briefings, etc.
│   │   ├── 004_portal_tables.sql      ← guest_list, timeline, budget, seating, sage, etc.
│   │   ├── 005_ai_tables.sql          ← venue_ai_config, phrase_usage, voice_training, etc.
│   │   ├── 006_rls_policies.sql       ← All RLS policies
│   │   └── 007_functions.sql          ← Helper functions
│   ├── functions/
│   │   ├── email-poll/index.ts        ← Edge Function: poll Gmail every 5 min
│   │   ├── daily-digest/index.ts      ← Edge Function: morning digest email
│   │   ├── heat-decay/index.ts        ← Edge Function: daily lead score decay
│   │   └── sequence-processor/index.ts ← Edge Function: follow-up sequences
│   └── seed.sql                       ← Dev seed data
├── middleware.ts                       ← Route platform vs couple portal
├── .env.local.example
├── next.config.ts
├── tailwind.config.ts                  ← Minimal (most config in globals.css @theme)
├── tsconfig.json
├── package.json
└── CLAUDE.md
```

---

## 6. THE UNIFIED AI PERSONALITY ENGINE

### How It Works

Every AI interaction in the platform goes through the same personality engine. The output differs based on **context** (email, chat, briefing) but the **voice** is consistent.

```
┌─────────────────────────────────────────────────────┐
│                PERSONALITY ENGINE                     │
│                                                       │
│  Layer 1: Universal Rules (hardcoded, immutable)      │
│  ├── AI transparency (must disclose AI nature)        │
│  ├── Anti-hallucination (only verified info)          │
│  ├── Safety checks (escalation triggers)              │
│  ├── Alan Berg methodology (sell the appointment)     │
│  └── Banned phrases (universal)                       │
│                                                       │
│  Layer 2: Venue Personality (from venue_ai_config)    │
│  ├── AI name, email, emoji                            │
│  ├── Personality dimensions (warmth, formality, etc.) │
│  ├── Phrase style + signature expressions             │
│  ├── USPs, seasonal language, sign-off                │
│  ├── Voice preferences (from training games)          │
│  └── Review vocabulary (from approved review phrases) │
│                                                       │
│  Layer 3: Task Instructions (per context)             │
│  ├── EMAIL CONTEXT:                                   │
│  │   ├── new_inquiry, reply, follow_up_3_day, final   │
│  │   ├── client_reply, client_onboarding, client_vendor│
│  │   ├── client_timeline, client_final_details         │
│  │   └── client_day_of                                │
│  ├── CHAT CONTEXT:                                    │
│  │   ├── couple_question, welcome, follow_up          │
│  │   └── contract_analysis, file_chat                 │
│  ├── INTEL CONTEXT:                                   │
│  │   ├── weekly_briefing, anomaly_explanation          │
│  │   ├── trend_recommendation, nlq_response           │
│  │   └── review_analysis                              │
│  └── VENDOR CONTEXT (future):                         │
│      └── vendor_reply, vendor_follow_up               │
│                                                       │
│  Layer 4: Dynamic Context (per interaction)           │
│  ├── EMAIL: extracted dates/guests, availability,     │
│  │   thread history, relevant FAQs, learning examples │
│  ├── CHAT: wedding context (vendors, budget, timeline,│
│  │   contracts), conversation history, planning notes  │
│  ├── INTEL: venue metrics, period data, comparison    │
│  │   benchmarks, anomaly details                       │
│  └── Anti-duplication: pre-selected phrases for this  │
│      contact from phrase_usage table                   │
│                                                       │
│  OUTPUT = system_prompt(L1+L2) + user_prompt(L3+L4)   │
└─────────────────────────────────────────────────────┘
```

### Venue Picks Their Own AI Name

During onboarding or in Settings > Personality:
- AI Name (default: "Sage")
- AI Email (default: "[name]@[venue-slug].bloomhouse.ai")
- AI Emoji (optional)
- Personality description (freeform text)
- Personality dimensions (sliders 1-10)
- Phrase style (warm / playful / professional / enthusiastic)
- Vibe (romantic_timeless / fun_modern / rustic_cozy / luxurious_exclusive / etc.)

### Voice Training Games (Settings > Voice)

Three games from Agent, ported to TypeScript:

**1. "Would You Send This?" (20 rounds)**
Shows AI-generated draft → venue owner votes send/wouldn't send. Captures approval/rejection patterns.

**2. "Cringe or Fine?" (15 rounds)**
Shows common phrases with context → venue owner votes cringe/fine. Builds banned_phrases and approved_phrases lists.

**3. "Quick Voice Quiz" (10 rounds)**
Multiple choice personality questions → directly adjusts dimension scores (warmth, formality, enthusiasm, etc.)

Results stored in `voice_preferences` table and fed into Layer 2 of every prompt.

### Learning Loops

```
COORDINATOR ACTION          →  STORED AS           →  FED BACK INTO
───────────────────────────────────────────────────────────────────
Approve draft               →  good_example         →  Layer 4 (emulate this)
Edit then approve           →  edit_pattern          →  Layer 4 (learn corrections)
Reject draft                →  rejection_reason      →  Layer 4 (avoid this)
Play voice training game    →  voice_preference      →  Layer 2 (adjust personality)
Approve review phrase       →  sage_vocabulary       →  Layer 2 (use real couple words)
Answer uncertain question   →  knowledge_base entry  →  Layer 2 (expand knowledge)
```

### Autonomous Sending

**Configurable separately for inquiries and booked clients.**

```
auto_send_rules table:
  venue_id
  context (inquiry | client)        ← NEW: separate toggle
  source (theknot | zola | weddingwire | calculator | direct | all)
  enabled (bool)
  confidence_threshold (0.0-1.0)
  daily_limit (int)
  require_new_contact (bool)
```

Pre-send checks (in order):
1. Is auto-send enabled for this context + source?
2. Confidence >= threshold?
3. Daily limit not reached?
4. No escalation keywords detected?
5. No red flags (past dates, conflicting info)?
6. → APPROVED TO AUTO-SEND

Venue can independently enable auto-send for inquiry responses (fast response to leads) while keeping client emails human-approved (higher stakes).

---

## 7. THE INTELLIGENCE FEEDBACK LOOP (USP)

This is what makes Bloom House different from every other wedding platform. Intelligence doesn't just report — it actively improves the other two products.

### Intelligence → Agent (Email gets smarter)

```
INTELLIGENCE OBSERVES              →  AGENT ADAPTS
─────────────────────────────────────────────────────────
"Garden wedding" searches up 40%   →  Sage mentions garden ceremony
  in your metro this month            locations earlier in inquiry responses

Instagram inquiries convert 3x     →  Agent prioritizes Instagram leads,
  better than The Knot                 adjusts follow-up intensity by source

Average response time is 4.2 hrs   →  Auto-send confidence threshold
  but competitors respond in 1 hr     lowered to get faster first responses

Review phrases: "felt like home"   →  Sage weaves approved review language
  appears in 80% of 5-star reviews    into email drafts naturally

Fall booking inquiries spike in    →  Agent adjusts seasonal language to
  May (6 months before)               emphasize fall imagery starting April
```

### Intelligence → Portal (Couple experience adapts)

```
INTELLIGENCE OBSERVES              →  PORTAL ADAPTS
─────────────────────────────────────────────────────────
"Garden weddings" trending         →  Inspo gallery surfaces garden images
                                       higher in default sort order

Most couples ask about pet policy  →  Sage proactively mentions pet-
  in first conversation               friendliness in welcome message

Budget tracker shows couples       →  Budget categories pre-populated
  spend 35% on photography            with realistic ranges for this venue

Guest list completion is the       →  Planning checklist highlights guest
  #1 predictor of smooth wedding      list earlier, with nudge reminders
```

### Intelligence → Venue Owner (Proactive recommendations)

```
INTELLIGENCE DETECTS               →  OWNER SEES (in briefings + trends page)
─────────────────────────────────────────────────────────
"Garden wedding" search volume     →  "Couples are searching for garden
  up 40% in Virginia this month       weddings 40% more this month. Consider
                                       updating your website hero to feature
                                       your garden ceremony space."

It's May — fall bookings           →  "May is peak booking season for fall
  historically spike now               weddings. We recommend featuring your
                                       fall foliage gallery and mentioning
                                       harvest season in Sage's responses."

Your Knot listing costs $4,200     →  "Your Knot listing costs $350/inquiry
  and produced 12 inquiries            but Instagram produces inquiries at
                                       $0. Consider reallocating $2,000 to
                                       targeted Instagram content."

Competitor venue X just raised     →  "Based on public pricing data,
  prices 15%                           comparable venues averaged a 12%
                                       increase this year. Your current
                                       pricing is 8% below market."
```

### How Trends Data Flows

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  EXTERNAL DATA   │     │  INTELLIGENCE    │     │  RECOMMENDATIONS │
│                  │     │  LAYER           │     │                  │
│  Google Trends   │────▶│                  │────▶│  Website hero    │
│  (wedding terms, │     │  Compare to:     │     │  image rotation  │
│  by metro, weekly│     │  - Venue's own   │     │                  │
│                  │     │    inquiry data   │     │  Sage seasonal   │
│  NOAA Weather    │────▶│  - Historical    │────▶│  language update  │
│  (venue location,│     │    same-period   │     │                  │
│  forecast + hist)│     │  - Competitor    │     │  Email draft      │
│                  │     │    benchmarks    │     │  tone adjustment  │
│  FRED Economic   │────▶│                  │────▶│                  │
│  (consumer       │     │  Generate:       │     │  Pricing signal   │
│  confidence,     │     │  - Anomaly if    │     │  (raise/hold/     │
│  wedding spend)  │     │    deviation >2σ │     │  offer incentive) │
│                  │     │  - Trend if      │     │                  │
│  Review Sites    │────▶│    3+ weeks same │────▶│  Review response  │
│  (Google, Knot,  │     │    direction     │     │  prompts +        │
│  WeddingWire)    │     │  - Seasonal if   │     │  vocabulary       │
│                  │     │    matches hist.  │     │                  │
└──────────────────┘     │    pattern       │     └──────────────────┘
                         └──────────────────┘
```

### Google Trends Integration (New)

**Table: `search_trends`**
```sql
CREATE TABLE search_trends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid REFERENCES venues(id),
  metro text NOT NULL,           -- DMA region (e.g., "Washington DC")
  term text NOT NULL,            -- search term (e.g., "garden wedding venue")
  week date NOT NULL,            -- week start date
  interest integer NOT NULL,     -- 0-100 relative interest
  created_at timestamptz DEFAULT now()
);
```

**Table: `trend_recommendations`**
```sql
CREATE TABLE trend_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid REFERENCES venues(id),
  recommendation_type text NOT NULL,  -- 'hero_image' | 'sage_language' | 'pricing' | 'content' | 'marketing'
  title text NOT NULL,
  body text NOT NULL,                 -- AI-generated recommendation
  data_source text NOT NULL,          -- 'google_trends' | 'weather' | 'economic' | 'reviews' | 'internal'
  supporting_data jsonb,              -- raw numbers backing the recommendation
  priority text DEFAULT 'medium',     -- 'high' | 'medium' | 'low'
  status text DEFAULT 'pending',      -- 'pending' | 'applied' | 'dismissed'
  applied_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
```

**Tracked search terms** (per venue's region):
- "[city] wedding venue"
- "outdoor wedding venue [state]"
- "garden wedding", "barn wedding", "estate wedding", "intimate wedding"
- "fall wedding", "spring wedding", "winter wedding", "summer wedding"
- "wedding venue cost", "affordable wedding venue"
- "elopement [state]", "micro wedding [state]"
- "wedding photographer [city]", "wedding planner [city]"

**Cron: weekly** — fetch Google Trends data, compare to venue's inquiry patterns, generate recommendations if deviation > 20%.

### Seasonal Intelligence Engine

The system knows:
- **When couples book** for each season (lead time patterns from historical data)
- **What they search for** right now (Google Trends)
- **What converts** at this venue (source attribution data)
- **What the weather will be** (NOAA forecast for venue location)

This produces **time-aware recommendations**:
- "It's April. Fall wedding inquiries historically spike in 3 weeks. Update your fall gallery now."
- "Rain is forecasted for 4 of the next 6 weekends. Sage should emphasize your indoor ceremony option."
- "Couples searching 'affordable wedding venue' in your area is up 60%. Consider highlighting your all-inclusive pricing."

---

## 8. DATABASE SCHEMA

### Shared Tables

**venues**
```sql
id uuid PK, name text, slug text UNIQUE, org_id uuid FK nullable,
plan_tier text ('starter'|'intelligence'|'enterprise'),
status text ('active'|'trial'|'suspended'|'churned'),
created_at timestamptz, updated_at timestamptz
-- COMMENT: owner:shared
```

**venue_config**
```sql
id uuid PK, venue_id uuid FK,
-- Branding
business_name text, logo_url text, primary_color text, secondary_color text, accent_color text,
font_pair text, timezone text, currency text DEFAULT 'USD',
-- Business model
catering_model text, bar_model text, capacity int, base_price decimal,
-- Contacts
coordinator_name text, coordinator_email text, coordinator_phone text,
-- Integrations
gmail_tokens jsonb, calendly_link text, calendly_tokens jsonb,
-- Portal
feature_flags jsonb,
created_at timestamptz, updated_at timestamptz
-- COMMENT: owner:shared
```

**venue_ai_config** (THE PERSONALITY ENGINE TABLE)
```sql
id uuid PK, venue_id uuid FK UNIQUE,
-- Identity
ai_name text DEFAULT 'Sage', ai_email text, ai_emoji text,
-- Personality (1-10 scales)
warmth_level int DEFAULT 7, formality_level int DEFAULT 4,
playfulness_level int DEFAULT 5, brevity_level int DEFAULT 6,
enthusiasm_level int DEFAULT 6,
-- Style
uses_contractions boolean DEFAULT true, uses_exclamation_points boolean DEFAULT true,
emoji_level text DEFAULT 'signoff_only', phrase_style text DEFAULT 'warm',
vibe text DEFAULT 'romantic_timeless',
-- Behavior
follow_up_style text DEFAULT 'moderate', max_follow_ups int DEFAULT 2,
escalation_style text DEFAULT 'soft_offer', sales_approach text DEFAULT 'consultative',
-- Signature
signature_greeting text, signature_closer text, signature_expressions jsonb,
-- Links
tour_booking_link text, intro_call_link text, pricing_calculator_link text,
-- Portal model details
assistant_personality text,
event_model text, alcohol_model text, catering_model text,
accommodation_model text, vendor_policy text, coordinator_level text,
staff_rate decimal, min_bartenders int, guests_per_bartender int,
created_at timestamptz, updated_at timestamptz
-- COMMENT: owner:shared
```

**weddings**
```sql
id uuid PK, venue_id uuid FK,
status text ('inquiry'|'tour_scheduled'|'tour_completed'|'proposal_sent'|'booked'|'completed'|'lost'|'cancelled'),
source text ('the_knot'|'weddingwire'|'google'|'instagram'|'referral'|'website'|'walk_in'|'other'),
source_detail text,
wedding_date date, guest_count_estimate int, booking_value decimal,
assigned_consultant_id uuid FK nullable,
inquiry_date timestamptz, first_response_at timestamptz,
tour_date timestamptz, booked_at timestamptz,
lost_at timestamptz, lost_reason text,
heat_score int DEFAULT 0, temperature_tier text DEFAULT 'cool',
notes text,
created_at timestamptz, updated_at timestamptz
-- COMMENT: owner:agent (status transitions), portal (planning data)
```

**people**
```sql
id uuid PK, venue_id uuid FK, wedding_id uuid FK nullable,
role text ('partner1'|'partner2'|'guest'|'wedding_party'|'vendor'|'family'),
first_name text, last_name text, email text, phone text,
created_at timestamptz, updated_at timestamptz
-- COMMENT: owner:agent+portal
```

**contacts**
```sql
id uuid PK, person_id uuid FK, type text ('email'|'phone'|'instagram'),
value text, is_primary boolean DEFAULT false, created_at timestamptz
-- COMMENT: owner:agent+portal
```

**knowledge_base**
```sql
id uuid PK, venue_id uuid FK,
category text, question text, answer text,
keywords text[], priority int DEFAULT 0, is_active boolean DEFAULT true,
created_at timestamptz, updated_at timestamptz
-- COMMENT: owner:portal (admin edits), read by agent+portal sage
```

**users** (extends Supabase auth.users)
```sql
id uuid PK (= auth.users.id), venue_id uuid FK nullable,
org_id uuid FK nullable,
role text ('super_admin'|'org_admin'|'venue_manager'|'coordinator'|'couple'),
first_name text, last_name text, avatar_url text,
created_at timestamptz
-- COMMENT: owner:platform
```

**booked_dates**
```sql
id uuid PK, venue_id uuid FK, date date, wedding_id uuid FK nullable,
block_type text ('wedding'|'private_event'|'maintenance'|'hold'),
notes text, created_at timestamptz
-- COMMENT: owner:agent
```

**organisations** (for multi-venue groups)
```sql
id uuid PK, name text, owner_id uuid FK,
plan_tier text, stripe_customer_id text, created_at timestamptz
-- COMMENT: owner:platform
```

### Agent-Owned Tables

**interactions** — every email/call/voicemail
```sql
id, venue_id, wedding_id, person_id, type, direction, subject,
body_preview, full_body, gmail_message_id, gmail_thread_id,
timestamp, created_at
```

**drafts** — AI-generated responses
```sql
id, venue_id, wedding_id, interaction_id, to_email, subject, draft_body,
status ('pending'|'approved'|'rejected'|'sent'),
context_type ('inquiry'|'client'),  ← NEW: tracks which context
brain_used, model_used, tokens_used, cost,
confidence_score, auto_sent, auto_send_source,
feedback_notes, approved_by, approved_at,
created_at
```

**engagement_events** — lead scoring events
```sql
id, venue_id, wedding_id, event_type, points, metadata jsonb, created_at
```

**lead_score_history** — score snapshots
```sql
id, venue_id, wedding_id, score, temperature_tier, calculated_at
```

**heat_score_config** — point values per event
```sql
id, venue_id, event_type, points, decay_rate
```

**draft_feedback** — learning from approvals
```sql
id, venue_id, draft_id, action ('approved'|'edited'|'rejected'),
original_body, edited_body, rejection_reason, coordinator_edits,
created_at
```

**learned_preferences** — aggregated patterns
```sql
id, venue_id, preference_type, pattern, confidence, created_at
```

**auto_send_rules** — autonomous sending config
```sql
id, venue_id, context ('inquiry'|'client'),
source text, enabled boolean DEFAULT false,
confidence_threshold float DEFAULT 0.85,
daily_limit int DEFAULT 5,
require_new_contact boolean DEFAULT true
```

**intelligence_extractions** — structured data from emails
```sql
id, venue_id, wedding_id, interaction_id,
extraction_type, value, confidence, created_at
```

**email_sync_state** — Gmail cursor
```sql
id, venue_id, last_history_id, last_sync_at, status, error_message
```

**api_costs** — per-call cost tracking
```sql
id, venue_id, service, model, input_tokens, output_tokens,
cost, context, created_at
```

### Intelligence-Owned Tables

**marketing_spend** — monthly spend per source
```sql
id, venue_id, source, month date, amount decimal, notes, created_at
```

**source_attribution** — calculated ROI by source
```sql
id, venue_id, source, period_start, period_end,
spend, inquiries, tours, bookings, revenue,
cost_per_inquiry, cost_per_booking, conversion_rate, roi,
calculated_at
```

**search_trends** — Google Trends data
```sql
id, venue_id, metro, term, week date, interest int, created_at
```

**trend_recommendations** — proactive AI recommendations
```sql
id, venue_id, recommendation_type, title, body,
data_source, supporting_data jsonb,
priority, status ('pending'|'applied'|'dismissed'),
applied_at, dismissed_at, created_at
```

**ai_briefings** — weekly AI briefings
```sql
id, venue_id, briefing_type ('weekly'|'monthly'|'anomaly'),
content jsonb, delivered_via, delivered_at, created_at
```

**anomaly_alerts** — metric deviation alerts
```sql
id, venue_id, alert_type, metric_name,
current_value, baseline_value, change_percent,
severity ('info'|'warning'|'critical'),
ai_explanation text, causes jsonb,
acknowledged boolean, acknowledged_by uuid, created_at
```

**consultant_metrics** — performance snapshots
```sql
id, venue_id, consultant_id uuid FK,
period_start, period_end,
inquiries_handled, tours_booked, bookings_closed,
conversion_rate, avg_response_time_minutes,
avg_booking_value, calculated_at
```

**review_language** — extracted review phrases
```sql
id, venue_id, review_id, phrase text, theme text,
sentiment_score float, frequency int,
approved_for_sage boolean DEFAULT false,
approved_for_marketing boolean DEFAULT false,
created_at
```

**weather_data** — NOAA data for venue location
```sql
id, venue_id, date, high_temp, low_temp, precipitation, conditions, source
```

**economic_indicators** — FRED data
```sql
id, indicator_name, date, value, source
```

**natural_language_queries** — NLQ log
```sql
id, venue_id, user_id, query_text, response_text,
model_used, tokens_used, cost, helpful boolean nullable, created_at
```

### Portal-Owned Tables

**guest_list**
```sql
id, venue_id, wedding_id, person_id FK, group_name,
rsvp_status ('pending'|'attending'|'declined'|'maybe'),
meal_preference, dietary_restrictions, plus_one boolean,
plus_one_name, table_assignment_id FK nullable,
care_notes text, invitation_sent boolean,
rsvp_responded_at, created_at, updated_at
```

**timeline**
```sql
id, venue_id, wedding_id, time, duration_minutes,
title, description, category, location, vendor_id FK nullable,
sort_order, created_at, updated_at
```

**budget**
```sql
id, venue_id, wedding_id, category, item_name,
estimated_cost, actual_cost, paid_amount,
vendor_id FK nullable, notes, created_at, updated_at
```

**seating_tables**
```sql
id, venue_id, wedding_id, table_name, table_type,
capacity, x_position, y_position, rotation, created_at
```

**seating_assignments**
```sql
id, venue_id, wedding_id, guest_id FK, table_id FK,
seat_number, created_at
```

**sage_conversations**
```sql
id, venue_id, wedding_id, user_id,
role ('user'|'assistant'), content,
model_used, tokens_used, cost, confidence_score,
flagged_uncertain boolean, created_at
```

**sage_uncertain_queue**
```sql
id, venue_id, wedding_id, conversation_id FK,
question, sage_answer, confidence_score,
coordinator_response, resolved_by, resolved_at,
added_to_kb boolean DEFAULT false, created_at
```

**planning_notes** — extracted from chat messages
```sql
id, venue_id, wedding_id, user_id,
category ('vendor'|'guest_count'|'decor'|'checklist'),
content, source_message, status, created_at
```

**contracts** — uploaded documents
```sql
id, venue_id, wedding_id, filename, file_type,
extracted_text, storage_path, created_at
```

**checklist_items**
```sql
id, venue_id, wedding_id, title, description,
due_date, category, is_completed, completed_at,
sort_order, created_at
```

**messages** — coordinator-couple DMs
```sql
id, venue_id, wedding_id, sender_id FK, sender_role,
content, read_at, created_at
```

**vendor_recommendations** — venue-suggested vendors
```sql
id, venue_id, vendor_name, vendor_type, contact_email,
contact_phone, website_url, description, logo_url,
is_preferred, sort_order, click_count, created_at
```

**inspo_gallery** — inspiration images
```sql
id, venue_id, wedding_id nullable, image_url,
caption, tags text[], uploaded_by, created_at
```

### AI System Tables

**venue_usps** — unique selling points per venue
```sql
id, venue_id, usp_text, sort_order, is_active, created_at
```

**venue_seasonal_content** — seasonal imagery per venue
```sql
id, venue_id, season ('spring'|'summer'|'fall'|'winter'),
imagery text, phrases text[], created_at
```

**phrase_usage** — anti-duplication tracking
```sql
id, venue_id, contact_email, phrase_category,
phrase_text, used_at timestamptz
```

**voice_training_sessions**
```sql
id, venue_id, game_type ('would_you_send'|'cringe_or_fine'|'quick_quiz'),
completed_rounds, total_rounds, staff_email,
started_at, completed_at
```

**voice_training_responses**
```sql
id, session_id FK, round_number, content_type,
response text, response_reason text nullable
```

**voice_preferences** — learned from training games
```sql
id, venue_id, preference_type ('banned_phrase'|'approved_phrase'|'dimension'),
content text, score float, sample_count int,
UNIQUE(venue_id, preference_type, content)
```

---

## 9. AUTH & ROLES

**Supabase Auth** with email/password. OAuth for Google (venue staff login).

| Role | Sees | Can Do |
|------|------|--------|
| `super_admin` | Everything + super admin panel | Manage all venues, billing, system config |
| `org_admin` | All venues in org across all 3 areas | Portfolio analytics, cross-venue comparison |
| `venue_manager` | Single venue — Agent + Intel + Portal admin | Full venue control, billing, AI config |
| `coordinator` | Single venue — Agent + Portal admin | Email pipeline, wedding management, messages |
| `couple` | Single wedding — couple portal only | Planning tools, Sage chat, their wedding data |

**RLS enforces all of this at the database level.**

---

## 10. CRON JOBS

| Job | Schedule | What It Does |
|-----|----------|--------------|
| Email poll | Every 5 min | Fetch Gmail → classify → draft → queue |
| Heat decay | 6:00 AM daily | -1 point to all leads without recent activity |
| Daily digest | 7:00 AM daily | Email summary to coordinators |
| Sequence processor | Every 1 hour | Process follow-up email sequences |
| Trends refresh | Weekly (Monday) | Fetch Google Trends, generate recommendations |
| Weather forecast | Daily | NOAA forecast check for upcoming weddings |
| Attribution calc | Weekly | Recalculate source ROI from weddings + spend |
| Anomaly detection | Daily | Check all metrics for deviations |
| Weekly briefing | Monday 8 AM | Generate and send AI briefing |

---

## 11. API KEYS (FINAL LIST)

```env
# === REQUIRED ===
ANTHROPIC_API_KEY=                    # All AI (one key, all contexts)
NEXT_PUBLIC_SUPABASE_URL=             # Fresh Supabase project
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
GOOGLE_CLIENT_ID=                     # Gmail OAuth (one app)
GOOGLE_CLIENT_SECRET=
NEXTAUTH_SECRET=                      # Auth signing key
CRON_SECRET=                          # Scheduled job auth

# === RECOMMENDED ===
OPENAI_API_KEY=                       # Whisper transcription + GPT fallback
RESEND_API_KEY=                       # Transactional emails (digests, sequences)
NOAA_CDO_TOKEN=                       # Weather data
FRED_API_KEY=                         # Economic indicators

# === PHASE 2 ===
STRIPE_SECRET_KEY=                    # When billing launches
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
CALENDLY_CLIENT_ID=                   # When tour scheduling added
CALENDLY_CLIENT_SECRET=
GOOGLE_TRENDS_API_KEY=                # If using SerpAPI or similar for Trends
```

---

## 12. BUILD ORDER

**This is a dependency graph, not a timeline.** Items at the same level have no
dependencies on each other and will be built concurrently. The only sequential
constraint is: things below depend on things above.

**Priority #1 is the USP: the reactive intelligence loop and the custom venue voice.**

```
LAYER 0: Foundation (blocks everything)
├── Scaffold Next.js + Tailwind v4 + shadcn/ui
├── Fresh Supabase project + ALL migrations (run once, all tables)
├── Auth (Supabase Auth + role-based middleware + RLS policies)
├── Shell layout (sidebar, venue selector, role-based nav, top bar)
├── AI client (callAI/callAIJson/callAIVision + cost tracking)
└── CRESTWOOD DEMO SEED (runs with migrations — validates schema immediately)
    ├── 1 org: Crestwood Hospitality Group
    ├── 4 venues with venue_config + venue_ai_config (each with distinct personality)
    ├── 4 consultants as users (one per venue)
    ├── 24 months of weddings with full lifecycle (inquiry → booked → completed → lost)
    ├── Interactions, drafts, engagement_events, lead_score_history
    ├── Marketing spend per source per venue
    ├── Knowledge base entries per venue
    ├── Search trends + trend_recommendations
    ├── AI briefings + anomaly_alerts
    ├── Review language with approved/pending phrases
    ├── Guest lists, timelines, budgets, sage_conversations
    └── Voice preferences (simulated training game results)

    The seed is not decoration. It is the integration test. If the seed
    breaks, the schema is wrong. Every table, every FK, every RLS policy
    gets exercised by real-shaped data from day one.

    ↓ everything below can start simultaneously once Layer 0 exists ↓

LAYER 1: The USP (no dependencies on each other — all built in parallel)
├── VOICE ENGINE
│   ├── Port universal rules + task prompts + phrase library to TS
│   ├── Port personality builder (venue_ai_config → system prompt)
│   ├── Port phrase selector (anti-duplication per contact)
│   ├── Personality configurator UI (sliders, vibe, style, signature)
│   ├── Voice training games UI (3 games → voice_preferences)
│   ├── AI name/email/emoji picker
│   └── Learning loop (draft_feedback → examples/patterns → Layer 4)
│
├── INTELLIGENCE LOOP
│   ├── Google Trends fetch + storage (cron + search_trends table)
│   ├── NOAA weather fetch + storage (cron + weather_data table)
│   ├── FRED economic fetch + storage (cron + economic_indicators)
│   ├── Trend recommendation engine (deviation detection → AI recs)
│   ├── Seasonal intelligence (booking lead-time patterns → time-aware recs)
│   ├── Anomaly detection (metric baselines → deviation → AI explanation)
│   ├── Weekly briefing generator (combines all signals → briefing)
│   ├── Review language extraction (reviews → phrases → approval pipeline)
│   ├── Intelligence → Sage feedback wiring (trends adjust seasonal language,
│   │   review phrases flow into personality builder, source performance
│   │   adjusts follow-up intensity)
│   ├── Trends page UI (recommendation cards, apply/dismiss)
│   ├── Briefings page UI (formatted briefing + supporting data)
│   └── Anomaly alerts UI
│
├── KNOWLEDGE BASE
│   ├── KB editor UI (CRUD, categories, priority, active toggle)
│   └── KB keyword retrieval service (used by email brain + chat brain)
│
└── GMAIL SERVICE
    ├── Gmail OAuth flow (Node googleapis)
    ├── Email fetch service
    └── Email send service

    ↓ everything below can start once its specific dependency exists ↓

LAYER 2: The three products (no dependencies on each other — all parallel)
│
├── AGENT (depends on: voice engine + gmail service)
│   ├── Router brain (classify → INQUIRY/CLIENT/VENDOR/ESCALATE/SPAM/IGNORE)
│   ├── Inquiry brain (4-layer prompt → draft)
│   ├── Client brain (4-layer prompt → draft, no sales language)
│   ├── Email pipeline orchestrator (fetch → classify → brain → draft → queue)
│   ├── Approval queue UI (approve/edit/reject, each feeds learning loop)
│   ├── Pipeline kanban board
│   ├── Lead scoring / heat mapping
│   ├── Auto-send settings (inquiry vs client toggles, per-source rules)
│   ├── Daily digest email (Resend)
│   ├── Follow-up sequence engine
│   └── Email sync state tracking
│
├── INTELLIGENCE DASHBOARDS (depends on: intel loop + weddings data)
│   ├── Overview dashboard (inquiry volume, conversion, response times)
│   ├── Source attribution (spend input + calculated ROI)
│   ├── Consultant performance comparison
│   └── NLQ interface (ask questions about your data)
│
└── PORTAL (depends on: voice engine + KB)
    ├── ADMIN SIDE
    │   ├── Active weddings list + status management
    │   ├── Sage uncertain questions queue
    │   ├── Coordinator-couple messaging
    │   └── Vendor recommendations manager
    │
    └── COUPLE SIDE (parallel with admin)
        ├── Subdomain routing middleware
        ├── Venue-branded couple login
        ├── Sage chat (couple-facing, same personality engine)
        ├── Timeline builder
        ├── Budget tracker
        ├── Guest list + RSVP
        ├── Seating chart (react-konva)
        ├── Vendor checklist
        ├── Planning checklist
        ├── Inspo gallery
        └── Contract upload + vision analysis

DEFERRED (not in initial build — hold the line)
├── Wedding website builder
├── Stripe billing
├── Organisation model
├── Benchmarks (needs 20+ venues)
├── Calendly integration
├── SMS notifications
├── Mobile app (React Native)
├── Voice transcription (Whisper)
└── Vendor brain
```

**How this actually runs:** Layer 0 is one session — scaffold, migrations,
seed, auth, shell. The Crestwood seed validates every table and relationship
before any feature code exists. Then Layer 1's four branches fan out
concurrently. Layer 2's three products fan out after their dependencies.
The only sequential chain: Foundation → Voice Engine → Brains → Pipeline.

---

## 13. WHAT NOT TO BUILD (HOLD THE LINE)

This section is a contract. Claude Code will happily build any of these
if asked. Do not ask. Not yet. Each item has a trigger condition — build
it when the trigger fires, not before.

| Feature | Why Not Now | Build When |
|---------|------------|------------|
| **Benchmarks** | Useless until 20+ venues. Meaningless averages from 3 venues mislead. | 20 active venues |
| **Organisation model** | Venues can be independent. Don't build group hierarchy for one group. | A venue group actually signs up |
| **Wedding website builder** | Cool but not revenue-critical. Couples have Zola/Knot/Minted for this. | Venues ask for it (>3 requests) |
| **Stripe billing** | No one is paying yet. Don't build billing for a product that isn't sold. | First paying venue is ready to swipe |
| **Calendly integration** | Tours can be booked by link. OAuth integration is nice-to-have. | Email pipeline is stable + venues ask |
| **SMS notifications** | Email + dashboard covers it. SMS adds Twilio dependency + cost. | Coordinators say they miss things |
| **Voice transcription (Whisper)** | Edge case. Very few coordinators send voice memos. | A venue actually needs it |
| **Vendor brain** | Agent's vendor communication. Inquiry + client brains come first. | Inquiry + client brains have 75%+ approval |
| **Mobile app (React Native)** | Web app is mobile-responsive. Native app is a maintenance burden. | Web app is stable + user demand proven |
| **Economic indicators dashboard** | Data feeds into briefings quietly. No one needs a FRED chart. | Never (it stays behind the scenes) |
| **Custom email templates** | HTML email templates are a rabbit hole. Plain text + signature works. | Venues specifically ask for branded emails |
| **Onboarding quiz** | Agent has elaborate quiz for personality. Sliders + games are simpler. | Voice training adoption is low |

**The rule:** If it's in this table, the answer is "not yet" until its
trigger condition is met. No exceptions. No "while we're at it." No
"it would only take an hour." Scope creep is how products die.

---

## 14. ISOLATION RULE

**This is an entirely new project. The source codebases are READ-ONLY reference.**

```
C:\Users\Ismar\bloom-house\              ← NEW. This project. Own repo, own Supabase, own deploy.

C:\Users\Ismar\Downloads\bloom-agent-main ← READ ONLY. Phil's Agent. Do not modify.
C:\Users\Ismar\bloom\                     ← READ ONLY. Intelligence. Do not modify.
C:\Users\Ismar\bloom-house-portal\        ← READ ONLY. Portal. Do not modify.
C:\Users\Ismar\rixey-portal\              ← READ ONLY. Original Rixey. Do not modify.
```

**Rules:**
- Copy logic, prompts, configs, and patterns FROM source codebases INTO bloom-house
- Never write to, edit, or commit in any source codebase
- Never share a Supabase project — bloom-house gets a fresh one
- The old apps keep running in production untouched
- If bloom-house breaks, Ismar rolls back to the individual apps with zero impact
- When bloom-house is proven stable, the old apps are sunset one by one — not before

**No imports, no symlinks, no shared packages.** Clean copies, ported to TypeScript,
adapted to the unified schema. The source repos are reference material, not dependencies.
