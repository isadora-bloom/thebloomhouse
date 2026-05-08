# PostHog setup

**Date:** 2026-05-08
**Anchor:** `docs/pricing-policy.md` (D8 picked PostHog).

PostHog is the analytics platform for Bloom (replacing the absence of analytics).

## Why PostHog

- Open source; self-host option preserves data residency for future EU customers
- Generous free tier (1M events/month) covers current + 12-month-out scale
- Autocapture: no per-event taxonomy upfront; clicks + page views + form submissions land for free
- Built-in funnels, retention curves, session replay
- Easier than Mixpanel for the founder-led-team stage

## Account setup (manual, Isadora does this)

1. Sign up at https://posthog.com (US cloud) or https://eu.posthog.com (EU, when EU customers arrive)
2. Create a project named "Bloom House" (production) and "Bloom House Dev" (development)
3. Pull the Project API Key from project settings
4. Add to Vercel env vars:
   - `NEXT_PUBLIC_POSTHOG_KEY=<production project key>`
   - `NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com` (or eu.i.posthog.com)
5. Pull the Personal API Key for backend event tracking (rare; we mostly autocapture frontend)
6. Add `POSTHOG_PROJECT_ID` to env vars if backend events are needed later

## Code integration

Provider added at `src/components/posthog-provider.tsx`. Wraps the app in the platform layout. Gracefully no-ops if `NEXT_PUBLIC_POSTHOG_KEY` is unset (so dev / demo / pre-setup environments don't break).

## Events to track

Day 1 (autocapture handles these):
- Page views (every URL)
- Button clicks
- Form submissions

Custom events to wire (next session if needed):
- `signup_complete` — fired from /signup success path
- `first_brain_dump` — fired on first brain-dump entry per venue
- `first_email_processed` — fired on first inbound email pipeline run per venue
- `first_draft_viewed` — fired on first /agent/drafts page view per venue
- `subscription_canceled` — fired from Stripe webhook handler
- `tier_upgraded` — fired from Stripe webhook handler
- `cost_ceiling_hit` — fired from cost-ceiling.ts when a venue hits 100%

## Funnels to monitor

Weekly check-in on these:

1. **Acquisition funnel:** pricing page view → signup start → signup complete → first session
2. **Activation funnel:** first session → first AI interaction → day-7 retention
3. **Conversion funnel:** trial start → trial day 14 → paid conversion
4. **Churn signal:** subscription_canceled events / events fired by tier

## What to NOT do

- Don't ship the project key to client without a domain allowlist (PostHog supports this in project settings).
- Don't track PII directly (no email, name, phone) unless a feature explicitly demands it. Use distinct_id only.
- Don't autocapture in `/agent/inbox` body text (couple PII). Set `data-ph-no-capture` on body-rendering elements if needed.

## Privacy posture

PostHog autocapture is GDPR + CCPA compliant when:
- Project key is properly scoped (only domains we own)
- PII is masked in URLs / inputs (autocapture has built-in input masking)
- Session replay is opt-in (we don't enable session replay until explicitly chosen for a customer)

Customer-facing privacy policy reference: PostHog appears in our sub-processor list (`docs/compliance/dpa-reference.md`) once installed in production.

## Going EU later

When the first EU customer signs:
1. Move the production project to https://eu.i.posthog.com.
2. Update `NEXT_PUBLIC_POSTHOG_HOST` env var.
3. Enable EU data residency in project settings.
4. Update DPA reference doc to note PostHog EU.
