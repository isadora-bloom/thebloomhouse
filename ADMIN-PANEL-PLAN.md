# Admin panel plan: running The Bloom House as a business

**Written:** 2026-09-17 · **Owner:** Isadora · **Order of work:** `ISADORA-PLAN.md`
**Picture it's designed for:** 200 venues signed up. Some are one venue on its own. Some are groups with several venues, sometimes arranged as region, then district, then venue. All of them use Bloom every day. Everyone who works at Bloom uses this panel.

## What it's for

One place where anyone at Bloom can answer, without asking an engineer:

- Who has signed up, who is setting up, who is live, who is slipping away?
- Are we being paid, and by whom? Who's about to stop paying?
- Is each venue actually using it, and which parts?
- Is anything broken for a venue right now?
- What does each venue cost us to run, next to what it pays?
- When a venue calls with a problem, what's going on with their account?

And one place to act on the answers, with every action written down.

## What already exists to build on

Checked in code on 2026-09-17.

- **`/super-admin`** has four pages. The overview counts venues by status (active, trial, suspended, churned) and by tier, reading `venues`, `organisations`, `weddings` and `api_costs`. `pipeline-health` shows messages in per venue, drafts waiting, the auto-send queue, errors in the last 24 hours and Gmail sync state. There are also `observability` and `consumer-requests` (privacy requests) pages.
- **Accounts:** `organisations` (name, owner, plan tier, Stripe customer), `venues` (status, tier, Stripe subscription and status, `trial_ends_at`), `venue_groups` with a parent group for hierarchies (migration 234).
- **People:** `user_profiles` with roles `super_admin`, `org_admin`, `venue_manager`, `coordinator`, `readonly`, `couple`. Team invitations (049), couple invites (391).
- **Money:** Stripe checkout and portal routes, `stripe_events` (every webhook, full payload), `billing-state.ts` (trial banner, auto-send off after trial), `dunning.ts`, `capacity-enforcement.ts` (it notices a venue went over its plan's limits and tells them, never blocks).
- **Cost:** `api_costs`, one row per AI call, per venue, with model, tokens, cost and prompt version.
- **Onboarding:** `onboarding_projects` with `readiness_passed_at` (the 5-day setup project).
- **Activity:** `activity_log`.

### Two problems in what exists

1. **Bloom staff and customers are the same kind of user.** `/super-admin` lets in anyone whose `user_profiles.role` is `super_admin`. That's the same table and the same list of roles as a venue's own coordinators. At 200 venues this needs to be separate: a Bloom staff member is not a member of any venue, and nothing a venue does (inviting, changing roles) should ever be able to produce one. There's also only one staff level, so Finance and Support would see and do the same things.
2. **The pricing page and the code disagree about trials.** Pricing v2 says no free trial, and every signup goes through a conversation. The database gives every new venue a 14-day trial, after which a banner appears and auto-send switches off. Decided 17 Sep: the trial stays, so the pricing page is what needs changing.

## Who uses it

Everyone at Bloom, each with what their job needs.

| Role | Sees | Can do |
|---|---|---|
| **Founder** | Everything | Everything, including managing staff |
| **Finance** | Accounts, billing, usage, cost | Credits, plan changes, refunds (through Stripe), founding member status |
| **Customer success / onboarding** | Accounts, people, onboarding, usage, health | Resend invites, extend setup, account notes, pause auto-send, read-only view as the venue |
| **Support** | Accounts, people, health, errors | Resend invites, password reset links, account notes, read-only view as the venue |
| **Engineering** | Health, errors, pipelines, cost, config | Platform switches (AI fallback, global auto-send pause), rerun a stuck job |
| **Read-only** (new starters, advisers) | Home, accounts, usage | Nothing |

## Rules it's built on

1. **Every action is written down:** who, what, which account, when, why. Some actions require a reason before they run.
2. **Couples' private data stays private by default.** Staff see counts about couples, not their messages, guest lists or allergy notes. Opening one venue's actual data means the read-only "view as venue" with a reason, and the venue can see it happened.
3. **Stripe is the truth about money.** The panel reads it and acts through it. It never keeps its own idea of what someone paid.
4. **Built for 200 venues, not 1.** Every list is paged and searchable on the server. Daily figures are added up overnight into a summary table, not recalculated across millions of rows each time someone opens a page.
5. **Times shown in the venue's own time zone** where it's about the venue, and UTC in the audit log.
6. **One number, one definition.** "Active venue", "booked", "monthly revenue" each get written down once and read from one function, the same doctrine the rest of Bloom follows.

## Screens

### 1. Today

The page staff open every morning. Short, and it only shows what needs someone.

- **Signups** since yesterday and this week.
- **Setup stuck:** venues in onboarding with no progress for 3 or more days.
- **Money needing attention:** failed payments, cards expiring this month, subscriptions set to cancel, trials ending in the next 7 days.
- **Broken for a venue right now:** Gmail disconnected, Calendly or OpenPhone failing, sending domain unverified, a pipeline with no messages in for 24 hours when it normally has dozens.
- **Error spikes:** a venue whose errors today are well above its usual.
- **Going quiet:** venues whose logins or activity dropped sharply over two weeks. This is the early warning for losing them.
- **Over their plan:** venues past their tier's inquiries, couples or venues this month (from `capacity-enforcement`). These are upgrade conversations, not problems.
- **AI spend today** against the usual day, overall and the top five venues.
- **Privacy requests** waiting, with how many days are left on the legal deadline.

### 2. Accounts

**List:** every organisation. Columns: name, individual or group, number of venues, tier, status, monthly revenue, signed up, last active, health (one colour, explained on hover), owner at Bloom. Filters for status, tier, individual or group, health, founding member, and "needs attention". Search by name, venue name, person's email or Stripe customer ID.

**Account page** (one organisation):
- **Summary:** tier, status, monthly revenue, founding member (and when that rate ends), signed up, went live, Bloom contact.
- **Venues:** each with its own status, go-live date, health and usage. For groups, the region to district to venue tree, which can be rearranged here.
- **People:** everyone with a login, their role, which venues, last sign-in, pending invites.
- **Billing:** subscription, next invoice, payment method status, invoice history, credits, plan history. Links to the Stripe customer.
- **Usage:** the last 30 and 90 days (see Usage).
- **Health:** integrations per venue and recent errors.
- **Timeline:** signup, calls, plan changes, payment failures, support actions, notes, all in one list.
- **Notes:** free-text notes from Bloom staff, never visible to the venue.

**Venue page:** the same, for one venue, plus its onboarding project step by step, the integrations with last successful sync, and the settings that matter for support (auto-send on or off, sending domain, AI name).

### 3. People

Everyone with a venue login across all 200 venues. Name, email, venue or venues, role, last sign-in, invited by, status. Search by email. Filters: never signed in, not signed in for 30 days, invite pending, pending over 7 days.

Couples are counted per venue (invited, registered, active this month), not listed. See rule 2.

### 4. Signups and setup

The funnel from first contact to fully live, as counts and as a list for each step:

contact form or call → agreement signed → account created → onboarding project started → data imported → readiness passed → live → first couple invited → first inquiry answered by Bloom.

For each step: how many are sitting there, for how long, and who at Bloom owns them. Pre-Opening venues show their rollover date (first paid wedding or 24 months).

### 5. Billing

- **Revenue:** monthly and annual recurring revenue, split by tier, by monthly or annual, individual or group. New, expansion, contraction and lost revenue each month.
- **Founding members:** how many of the 25 places are taken, who has them, when each 24-month rate ends.
- **Failed payments:** each one, how far through the dunning steps, amount, last contact.
- **Upcoming:** renewals and rate changes in the next 30 days (annual renewals, founding rates ending, Pre-Opening rollovers).
- **Enterprise:** annual contracts that may be invoiced outside a card subscription, with their renewal dates.
- **Actions:** apply a credit, change plan, cancel at period end, pause, mark founding member, resend an invoice. All through Stripe, all logged, credits and refunds with a reason.

### 6. Usage

Per venue, per day, added up overnight into `usage_daily`:

- **People:** staff who signed in, couples who signed in.
- **Agent:** inquiries in, drafts written, drafts sent after review, auto-sent, average time to first reply.
- **Portal:** couples invited, couples active, Sage messages from couples, sections completed.
- **Intel:** pages viewed, questions asked.
- **Messages sent:** emails and texts out.
- **Cost:** AI spend from `api_costs`, email and SMS sending costs.
- **Margin:** what the venue pays against what it costs to run.

Screens: the whole platform over time, a league table of venues (most and least engaged, most and least costly), and the per-venue view on the account page. **Adoption depth:** which of Agent, Intel and Portal each venue actually uses, so customer success knows who has only switched on one third of what they pay for.

### 7. Health

- **Integrations:** one grid, venues down the side, Gmail, Calendly, OpenPhone, Zoom, Instagram, the ad platforms and the sending domain across the top. Each cell: fine, failing since when, or not connected.
- **Pipelines:** the existing pipeline-health page, per venue and overall.
- **Scheduled jobs:** did each nightly and hourly job run, how long it took, what failed.
- **Errors:** grouped by kind, with the venues affected.
- **Email sending:** bounces and complaints per venue.

### 8. Support tools

- **View as venue, read-only,** with a reason, a time limit, a banner while it's on, and an entry in the venue's own activity so they can see Bloom looked.
- **Resend an invite, send a password reset link, unlock an account.**
- **Pause auto-send for a venue,** with a reason. Same switch the venue has, so they can see it.
- **Transfer account ownership** when the owner leaves.
- **Move a venue** between groups, or into a new organisation (when a venue is sold, which also ends a founding member rate).
- **Privacy requests:** the existing consumer-requests page, with export and erasure.

### 9. Platform switches

For engineering and the founder only:
- AI fallback on or off (`AI_FORCE_FALLBACK` today is an environment variable, which means a redeploy).
- Pause all auto-send across the platform.
- Per-venue features that are off by default (cross-venue benchmarks).
- A banner message shown to all venues (planned maintenance, an outage).

### 10. Staff and audit log

- Bloom staff: add, remove, change role. Founder only.
- The audit log: every staff action, filterable by person, account and action. Nobody can edit or delete it.

## New pieces to build

| Piece | What it is |
|---|---|
| `bloom_staff` | Bloom employees and their panel role. Separate from `user_profiles`, so no venue action can ever create one. Two-factor sign-in required |
| `staff_audit_log` | Every staff action: who, what, account, before and after, reason, when. Insert only |
| `account_notes` | Staff notes per organisation or venue |
| `usage_daily` | One row per venue per day with the usage figures above. Filled by a nightly job |
| `billing_snapshot` | Current subscription state per organisation, kept up to date from the Stripe webhooks already landing in `stripe_events` |
| `integration_health` | Latest state per venue per integration, written by the jobs that already sync them |
| `platform_flags` | The switches in screen 9, read at runtime rather than from environment variables |
| `view_as_sessions` | Who looked at which venue, why, from when to when |

**The nightly job has to fit the cron budget.** Bloom's ratchet holds scheduled jobs at 49 of 49, so the usage roll-up runs inside an existing nightly slot, the way waves 6 and 7 did.

## Build order

Fits weeks 1 to 4 of `ISADORA-PLAN.md`.

1. **Foundations:** `bloom_staff` with roles and two-factor, the audit log, and moving `/super-admin` off the `super_admin` venue role onto staff roles. Nothing else is safe to build before this.
2. **Accounts, people and Today:** mostly reading tables that exist. This is the part that answers "who has signed up".
3. **Usage:** the `usage_daily` roll-up, then the usage screens. Backfilled from `api_costs`, the spine and the logs so it doesn't start from zero.
4. **Billing:** the Stripe snapshot, revenue, failed payments, founding members, then the billing actions.
5. **Health and support tools:** the integration grid, then view as venue, then the account actions. Staff alerts go through a bell in the panel and Bloom's own email, not Slack.
6. **Platform switches** last.

## To test it properly

200 venues can't be tested on Rixey and four demo venues. The test project needs a seeded spread: individual venues and groups with a two-level hierarchy, every status, every tier, a few founding members, failed payments, broken integrations, quiet venues and busy ones. Enough rows that paging and search are real.

## Decisions

Answered by Isadora, 2026-09-17:

1. **Trials stay.** The 14-day trial in the code is right. The pricing page on thebloomhouse.ai, which says there's no free trial, is the thing out of step.
2. **Staff roles:** these are Bloom's own staff, not roles inside a customer's organisation. Customers already have theirs (org admin, venue manager, coordinator, read-only, couple). Isadora asked what the six are; confirm once she's read the table above.
3. **Billing is Stripe.** Still open: one subscription per organisation, or one per venue, for groups.
4. **Enterprise invoicing:** not decided yet.
5. **Alerts are built into Bloom.** No Slack or other outside tools. Today's items show in the panel, and a staff notification bell and a daily email digest from Bloom itself carry the urgent ones.
6. **View as venue: a notice is enough.** The venue sees an entry in its activity. It doesn't have to agree first.
7. **What makes a venue red:** to be worked out together. The suggestion (integration failing over 24 hours, a failed payment, activity down by half over two weeks) stands until then.
