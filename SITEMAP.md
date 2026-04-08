# The Bloom House — Complete Sitemap

**Stack:** Next.js 16 (App Router) + TypeScript + Supabase
**Total:** ~147 pages, ~81 API routes

---

## Public / Auth

| URL | Description |
|-----|-------------|
| `/` | Landing / home page |
| `/demo` | Demo page |
| `/login` | Login |
| `/signup` | Sign up |

---

## Platform — Agent (Email AI)

| URL | Description |
|-----|-------------|
| `/agent` | Agent workspace home |
| `/agent/analytics` | Agent performance analytics |
| `/agent/codes` | Discount/promo codes |
| `/agent/drafts` | Email drafts |
| `/agent/errors` | Agent error log |
| `/agent/inbox` | Email inbox |
| `/agent/knowledge-gaps` | Knowledge gaps detected by agent |
| `/agent/leads` | Lead management |
| `/agent/learning` | Agent learning/training |
| `/agent/notifications` | Notifications |
| `/agent/pipeline` | Sales pipeline |
| `/agent/relationships` | Relationship tracking |
| `/agent/rules` | Agent rules/behavior config |
| `/agent/sequences` | Email sequences |
| `/agent/settings` | Agent settings |

---

## Platform — Intel (Analytics & CRM)

| URL | Description |
|-----|-------------|
| `/intel/dashboard` | Intel dashboard home |
| `/intel/annotations` | Data annotations |
| `/intel/briefings` | AI-generated briefings |
| `/intel/campaigns` | Marketing campaigns |
| `/intel/capacity` | Venue capacity planning |
| `/intel/clients` | Client list |
| `/intel/clients/[id]` | Individual client detail |
| `/intel/company` | Company overview |
| `/intel/cross` | Cross-selling insights |
| `/intel/forecasts` | Revenue forecasts |
| `/intel/health` | Business health metrics |
| `/intel/lost-deals` | Lost deal analysis |
| `/intel/market-pulse` | Market trends |
| `/intel/matching` | Client-venue matching |
| `/intel/nlq` | Natural language query |
| `/intel/portfolio` | Portfolio overview |
| `/intel/regions` | Regional breakdown |
| `/intel/reviews` | Review management |
| `/intel/social` | Social media intel |
| `/intel/sources` | Lead source tracking |
| `/intel/team` | Team performance |
| `/intel/team-compare` | Team comparison |
| `/intel/tours` | Tour analytics |
| `/intel/trends` | Trend analysis |

---

## Platform — Portal (Venue Config)

| URL | Description |
|-----|-------------|
| `/portal` | Portal home |
| `/portal/weddings` | All weddings list |
| `/portal/weddings/[id]/portal` | Individual wedding portal view |
| `/portal/bar-config` | Bar/beverage configuration |
| `/portal/checklist-config` | Checklist template config |
| `/portal/decor-config` | Decor options config |
| `/portal/guest-care-config` | Guest care config |
| `/portal/kb` | Knowledge base |
| `/portal/messages` | Messages / comms |
| `/portal/rehearsal-config` | Rehearsal config |
| `/portal/rooms-config` | Room block config |
| `/portal/sage-queue` | Sage AI response queue |
| `/portal/seating-config` | Seating config |
| `/portal/section-settings` | Portal section visibility |
| `/portal/shuttle-config` | Shuttle/transport config |
| `/portal/staffing-config` | Staffing config |
| `/portal/tables-config` | Tables & linens config |
| `/portal/vendors` | Preferred vendor management |
| `/portal/wedding-details-config` | Wedding details config |

---

## Platform — Settings & Admin

| URL | Description |
|-----|-------------|
| `/settings` | Settings home |
| `/settings/personality` | AI personality config |
| `/settings/voice` | Venue voice training |
| `/onboarding` | Venue onboarding flow |
| `/super-admin` | Super admin panel |

---

## Couple Portal (`/couple/[slug]/...`)

Each couple gets a unique slug. All pages below are under `/couple/[slug]/`.

| URL | Description |
|-----|-------------|
| `/couple/[slug]` | Couple portal home |
| `/couple/[slug]/login` | Couple login |
| `/couple/[slug]/getting-started` | Getting started guide |
| `/couple/[slug]/chat` | Chat with Sage AI |
| `/couple/[slug]/messages` | Messages with venue |
| `/couple/[slug]/checklist` | Planning checklist |
| `/couple/[slug]/timeline` | Day-of timeline |
| `/couple/[slug]/budget` | Budget tracker |
| `/couple/[slug]/contracts` | Contracts & docs |
| `/couple/[slug]/guests` | Guest list |
| `/couple/[slug]/rsvp-settings` | RSVP settings |
| `/couple/[slug]/seating` | Seating chart |
| `/couple/[slug]/tables` | Table assignments |
| `/couple/[slug]/party` | Wedding party |
| `/couple/[slug]/ceremony` | Ceremony details |
| `/couple/[slug]/rehearsal` | Rehearsal details |
| `/couple/[slug]/bar` | Bar selections |
| `/couple/[slug]/decor` | Decor choices |
| `/couple/[slug]/photos` | Photo planning |
| `/couple/[slug]/couple-photo` | Couple photo |
| `/couple/[slug]/inspo` | Inspiration board |
| `/couple/[slug]/picks` | Couple's picks |
| `/couple/[slug]/beauty` | Beauty/hair/makeup |
| `/couple/[slug]/vendors` | Vendor contacts |
| `/couple/[slug]/preferred-vendors` | Venue preferred vendors |
| `/couple/[slug]/rooms` | Room blocks |
| `/couple/[slug]/stays` | Guest accommodations |
| `/couple/[slug]/transportation` | Transportation/shuttles |
| `/couple/[slug]/allergies` | Allergy tracking |
| `/couple/[slug]/guest-care` | Guest care info |
| `/couple/[slug]/staffing` | Staffing/day-of contacts |
| `/couple/[slug]/venue-inventory` | Venue inventory |
| `/couple/[slug]/wedding-details` | Wedding details |
| `/couple/[slug]/worksheets` | Planning worksheets |
| `/couple/[slug]/downloads` | Downloadable resources |
| `/couple/[slug]/resources` | Resources & guides |
| `/couple/[slug]/website` | Wedding website builder |
| `/couple/[slug]/booking` | Booking info |
| `/couple/[slug]/final-review` | Final review before event |

---

## Special / Public Routes

| URL | Description |
|-----|-------------|
| `/preview/[slug]` | Portal preview (non-authenticated) |
| `/vendor-portal/[token]` | Vendor portal (token-based access) |
| `/w/[slug]` | Short wedding website link |

---

## API Routes (81 total)

### Agent API (`/api/agent/`)
`analytics` · `codes` · `drafts` · `errors` · `gmail` · `heat` · `knowledge-gaps` · `leads` · `pipeline` · `relationships` · `reply` · `send` · `sequences`

### Couple API (`/api/couple/`)
`allergies` · `bar` · `beauty` · `borrow` · `budget` · `ceremony` · `checklist` · `contracts` · `decor` · `details` · `finalization` · `guest-care` · `guests` · `inspo` · `messages` · `onboarding` · `party` · `photos` · `rehearsal` · `rooms` · `seating` · `staffing` · `stays` · `tables` · `timeline` · `transportation` · `vendors` · `website` · `wedding-details` · `worksheets`

### Intel API (`/api/intel/`)
`annotations` · `anomalies` · `attribution` · `briefings` · `campaigns` · `clients` · `forecasts` · `health` · `lost-deals` · `matching` · `nlq` · `positioning` · `recommendations` · `reviews` · `social` · `sources` · `team` · `tours` · `trends`

### Portal API (`/api/portal/`)
`borrow` · `contracts` · `finalization` · `kb` · `messages` · `reminders` · `sage` · `section-config` · `vendors` · `wedding-detail-config` · `weddings`

### Other API
`/api/auth/callback` · `/api/platform/notifications` · `/api/public/sage-preview` · `/api/public/vendor-portal` · `/api/public/wedding-website` · `/api/cron` · `/api/webhooks/calendly` · `/api/webhooks/stripe`
