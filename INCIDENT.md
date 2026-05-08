# Bloom House — Incident Response Runbook

**Owner:** Isadora Martin-Dye · isadora@rixeymanor.com
**Last reviewed:** 2026-05-07

This is the playbook for responding to a Bloom House production incident.
It is opinionated, Bloom-specific, and short on purpose. If you are
following it during an incident, breathe first.

---

## Severity definitions

| Severity | Definition | Response |
|---|---|---|
| **SEV1** | Customer data leak; auto-send firing wrong content; ANY venue can read another venue's data; payment / Stripe charge anomaly; Sage replying with hallucinated PII | Stop the world. Page on-call. Pause auto-send platform-wide via cost-ceiling. Begin the incident log NOW. |
| **SEV2** | Auto-send disabled venue-wide; cron pipeline stalled > 30 min; AI provider full outage with fallback failing; Supabase outage > 5 min | Respond within the hour. Auto-send is the revenue surface; coordinator inbox grows from minutes to hours. |
| **SEV3** | Single venue reporting weird AI behaviour; insight surface returning stale data; couple portal slow; one cron job behind | Same business day. File a memory note + ticket so it doesn't get lost. |

If you are unsure, treat as one severity higher. Costs of over-responding
are low (15 minutes of your attention). Costs of under-responding to a
SEV1 are losing the customer or worse.

---

## On-call

Today, on-call = Isadora. There is no rotation yet.

Phone: refer to personal contact.
Email for ack-able alerts: isadora@rixeymanor.com.

When the team grows past one engineer, this section becomes a real
rotation document — see Tier-C engineering org item #138.

---

## Communication channels during an incident

1. **Internal log:** open a Notion page named `INCIDENT-YYYY-MM-DD-<short-name>`. Put it under the Bloom workspace. Append timestamps as you go — even a one-line "discovered email pipeline lag" is worth more than reconstructing later.
2. **Customer comms:** if the incident affects coordinators, send a short note to each affected venue's primary contact within 1 hour of confirmation. Keep it factual. Do NOT speculate on cause.
3. **Status page:** does not exist yet (Tier-C item). Until it does, customer comms is the substitute.

---

## Common scenarios

### A. Customer reports "Sage replied with someone else's data"

**This is SEV1.** Treat as a confirmed cross-tenant leak until proven otherwise.

1. Get the exact draft / interaction id from the coordinator.
2. Read it in Supabase Studio: `select * from drafts where id = '...'` and `select * from interactions where id = '...'`.
3. Confirm `venue_id` and `wedding_id` match the reporting venue. If they don't, you have a cross-tenant write — pause auto-send platform-wide.
4. Pause auto-send: `update venue_config set autonomous_paused = true` (every row).
5. Sweep: `select venue_id, count(*) from drafts where created_at > now() - interval '24 hours' group by venue_id` — confirm no foreign-venue ids you don't recognise.
6. Audit trail: `select * from activity_log where created_at > now() - interval '24 hours' and details->>'cross_tenant' is not null`.
7. After containment, file the post-mortem (template below). Customer comms within 1 hour.

### B. Auto-send disabled venue-wide, no obvious cause

Per Round 8: most likely cause is a missing migration column being read by `lib/services/email/autonomous-sender.ts`. The defensive 42703 fallback should keep auto-send running, but verify.

1. Open Vercel logs, filter `compliance_erasure_step_failed` and `auto-send`. Look for `code: '42703'` or `column ... does not exist`.
2. If the error names a column on `auto_send_rules`, apply the matching migration.
3. If the error is on a different table, it's a different bug; capture the error and the matching commit / file:line.
4. After fix, scrape the last 24 hours of auto-send fires: `select venue_id, count(*) from interactions where direction = 'outbound' and created_at > now() - interval '24 hours' group by venue_id` — should match the typical pattern per venue.

### C. Email pipeline backed up

Symptom: `email_poll` cron is firing but `interactions.created_at` is way behind real time.

1. Check `gmail_connections` — any rows with `status = 'error'`? Clear the error and refresh the OAuth token.
2. Check `email_sync_state` — `last_sync_at` should be < 10 minutes old per venue. Older means the per-venue sync is wedged.
3. Check Vercel function timeouts — if `email_poll` is hitting the 60s ceiling, narrow the per-tick window.
4. Don't bulk-replay without thinking: the candidate-clusterer and identity-resolution pipelines depend on temporal ordering.

### D. AI provider outage (Claude or OpenAI)

The circuit breaker at `lib/ai/circuit-breaker.ts` should auto-route to the fallback. If it doesn't:

1. `process.env.AI_FORCE_FALLBACK = 'true'` in Vercel env, redeploy.
2. Watch `api_costs` for fallback-tagged rows landing.
3. Don't disable auto-send unless drafts are noticeably worse — fallback drafts get a coordinator review anyway in shadow-mode-by-default.

### E. Supabase outage

There is nothing to do but wait. Vercel functions will return 500 on every DB call.

1. Confirm at status.supabase.com.
2. Customer comms after 5 minutes: "We are currently experiencing a database outage upstream of our platform. Email drafts and AI replies are paused. We will resume automatically when the upstream provider recovers."
3. Once back up: check `cron_runs` for the missed window and decide which crons need a manual replay.

### F. Lost / leaked Supabase service-role key

**This is SEV1.** The service-role key bypasses RLS — a leak is functionally a full-data-access exposure.

See "Service-role key rotation" below.

### G. Lost / leaked CRON_SECRET

**SEV2** for the read-only secret. **SEV1** for the destructive-class secret (`CRON_SECRET_DESTRUCTIVE` — see Tier-C #126).

A leaked read-only `CRON_SECRET` lets an attacker trigger reads + refreshes (annoying, bounded). A leaked destructive secret lets them trigger backtrace / data-integrity sweeps that mutate identity-resolution state.

See "Cron secret rotation" below.

### H. DNS / Vercel deployment incident

1. Verify the deployment did not silently roll back. `vercel deployments list` from the CLI.
2. If domains are misrouting, check Vercel project domain config. The Bloom House primary is `thebloomhouse.ai`; the marketing site is on its own deployment.
3. If a deploy needs an immediate rollback: `vercel promote <known-good-deployment-id>`.

---

## Service-role key rotation

The service-role key is `process.env.SUPABASE_SERVICE_ROLE_KEY`. It bypasses
RLS and is used by every route that needs cross-tenant or admin reads.

### Routine rotation (every 90 days, or after any suspected exposure)

1. Generate a new service-role key in Supabase Studio: Project Settings → API → "Reset service_role secret". This DOES revoke the old key.
2. Update Vercel env: `vercel env add SUPABASE_SERVICE_ROLE_KEY` (Production / Preview / Development). Paste new key.
3. Trigger a redeploy: `vercel deploy --prod` (or push an empty commit).
4. Verify: `node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/verify-service-role-key.ts` — see verifier below.
5. Confirm crons + auth-helpers paths still work by tailing Vercel logs for 5 minutes after redeploy.

### Emergency rotation (suspected leak)

Same as routine, but:

- Do step 1 immediately. The key is revoked the moment you reset it; everything using it dies until step 2 lands.
- Pre-stage step 2 in the Vercel UI before clicking reset so the gap is < 60 seconds.
- After rotation, audit `auth.audit_log_entries` and any custom logs for activity during the suspected exposure window. File a post-mortem with the time range and any observed unauthorised access.

---

## Cron secret rotation

`CRON_SECRET` is verified by every cron route. `CRON_SECRET_DESTRUCTIVE`
is required additionally for the destructive cron set (see Tier-C #126).

### Rotation

1. Generate a new value: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Update in Vercel: `vercel env add CRON_SECRET` (or `CRON_SECRET_DESTRUCTIVE`). Paste new value.
3. Trigger a redeploy. Vercel cron triggers automatically use the latest env, so once the deploy is live the new secret is active.
4. Wait one cron tick (≤ 5 minutes for `email_poll`); confirm the new tick succeeded in Vercel logs.
5. There is no key revocation step — the env var is the single source of truth and replacing it invalidates the old.

---

## Customer-data leak — verified

**This is SEV1. Stop reading and start acting.**

1. Pause auto-send platform-wide: `update venue_config set autonomous_paused = true`.
2. Snapshot the affected rows for forensic record: copy the raw rows from `drafts`, `interactions`, `messages` to a separate audit table or local SQL dump. Do not delete or anonymise yet.
3. Identify scope: which venue(s) saw what data? Which couples? Time window?
4. Notify affected parties within 24 hours per CCPA 1798.82 (and 72 hours per GDPR Art. 33). Email per affected venue's primary contact + a regulator-template body.
5. File a `consumer_requests` row with `request_type='access'` for each affected user automatically; this seeds the audit trail.
6. Once contained, run the eraseCouple helper for any wedding whose data leaked into the wrong tenant.
7. Post-mortem within 48 hours.

---

## Post-mortem template

```markdown
# Incident: <short name>

**Date:** YYYY-MM-DD
**Severity:** SEV?
**Duration:** Detection → resolution
**Customer impact:** Who, how many, what they saw

## Timeline (UTC)
- HH:MM — first signal observed (where? alert? customer report?)
- HH:MM — incident declared
- HH:MM — root cause identified
- HH:MM — fix deployed
- HH:MM — monitoring confirmed clean

## Root cause
What broke, in plain sentences. No "and then" — be precise.

## What worked
What detection / response steps fired correctly.

## What didn't
What detection / response gaps surfaced. These become Tier-C items.

## Action items
- [ ] One concrete change per gap. File against the launch plan ledger.
- [ ] Customer comms / regulator filing if required.

## Lessons
What we learned that's worth saving in `feedback_*` memory.
```

---

## Things this runbook does NOT cover (yet)

- **SOC 2 path** (Tier-C #121).
- **DPA reference per processor** — Anthropic, Resend, Stripe, Supabase, Vercel, HoneyBook (Tier-C #122).
- **Status page** — public-facing status.bloomhouse.ai (Tier-C, future).
- **Anomaly detection on bulk reads** — Tier-C #130 (no pager hooked up; you'd discover via dashboard or customer report).
- **State PII breach-notification runbook for Virginia and North Carolina** — Tier-C #120.

When any of these become real, fold them in here rather than maintaining
a parallel doc.
