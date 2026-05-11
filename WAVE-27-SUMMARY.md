# Wave 27 — Author-class classification

Stream 1 of 5-parallel-stream build. Adds the third forensic dimension
(WHO authored the signal) to `interactions` alongside the existing
`direction` and `signal_class`. Without it, Calendly notifications,
Knot relay alerts, autoresponders, and OOO replies contaminate every
downstream metric they touch — knowledge-gap captures, classifier
health %, heat scoring, draft training.

Class-of-problem fix, not a Calendly/HoneyBook block list. Per
`feedback_deep_fix_vs_bandaid.md` and `bloom-may9-llm-vs-template.md`,
the chokepoint is a real callAI on every email, not heuristics or a
domain allowlist.

## Files created

| File | Lines | Purpose |
|------|-------|---------|
| `src/config/prompts/author-class.ts` | 290 | Haiku system+user prompt + validator. `AUTHOR_CLASS_PROMPT_VERSION = 'author-class.prompt.v1'`. 6 classes: couple / operator / sage / platform_system / vendor / unknown. |
| `src/lib/services/email/author-classifier.ts` | 187 | `classifyAuthor()` — fire-and-forget Haiku call. Persists `author_class` + `author_class_prompt_version` + `author_class_decided_at` when given an `interactionId`. Never throws upstream; returns `'unknown'` on any error. |
| `src/lib/services/email/author-class-backfill.ts` | 206 | Bulk per-venue backfill. `runAuthorClassBackfill()` drains every venue's inbound `'unknown'` rows, batched 50-in-parallel, capped 500/venue/tick. Idempotent. |

## Files edited

| File | Edit |
|------|------|
| `src/lib/services/email/pipeline.ts` | Post-`interactions.insert` fire-and-forget call to `classifyAuthor()` (skipped for `wave9InboundFromOwn` since those rows are already `'operator'` / `'sage'`). Threads `interactionId` into the existing `generateClientDraft` call so the knowledge-gap detector can guard on author_class. |
| `src/lib/services/knowledge-gaps/detect-from-draft.ts` | Added optional `interactionId` field to `DetectFromDraftInput`. Early-exits silently with `skipReason='author_class_platform_system'` / `'author_class_sage'` when the inbound was authored by Calendly/HoneyBook/relay/etc. or by Sage itself. Per the doctrine reminder, the skip is logged + soft. |
| `src/app/api/admin/knowledge-gaps/detect/route.ts` | Threads `draftRow.interaction_id` into the detector call (was already loaded from the draft row; just unused). |
| `src/lib/services/brain/client.ts` | `ClientDraftOptions` now carries optional `interactionId`; threads it through the existing fire-and-forget `detectKnowledgeGapsFromDraft` call. |
| `src/app/(platform)/agent/classification-health/page.tsx` | Inbound select now pulls `author_class`. Null-bucket calc + null-list filter + today metric all subtract `author_class='platform_system'` rows. New sub-stat under the existing "Today null-classification" card: "Of those, X% were platform_system (not classifiable, correctly skipped)". Existing copy/labels around the null counter untouched per Stream 4's territory (F33). |
| `src/app/api/cron/route.ts` | Registered `'author_class_backfill'` in `VALID_JOBS` + a switch case that imports `runAuthorClassBackfill` lazily. Not added to vercel.json (cron count is at the 40 Pro-plan cap); ops invoke manually via curl. |

## Cost estimate

- Per email: ~$0.0003 on Haiku (200 max_tokens, 0 temperature, body
  truncated at 2500 chars, no extracted_identity bloat).
- Rixey ~12,000-row backfill: **~$3.60 total**, spread across
  ~24 ticks at the 500/venue/tick cap.
- Live pipeline at Rixey volume (~30 inbounds/day): **<$0.01/day**.
- Wedgewood scale (80 venues, similar volume): **<$1/day**.

## Open questions for the reconciler

1. **Outbound rule precedence (rules-v1 vs prompt v1).** Migration 293
   stamps `author_class_prompt_version='rules-v1'` on outbound rows.
   The pending-classification cron filters on `direction='inbound'`
   so it will not re-classify those, but the field can be confusing.
   Keep as-is, or migrate to `'rules-out.v1'`?

2. **Multi-Gmail venue `'sage'` inbound case.** When a venue's Sage
   reply gets forwarded back into a different Gmail inbox (e.g.
   coordinator forwards from sage@venue.com to inbox@venue.com), it
   lands as inbound with Sage's signature. The prompt correctly
   classifies this as `'sage'`, and the knowledge-gap skip is silent.
   No code change needed — flag is just for awareness.

3. **Vercel cron registration.** We left `author_class_backfill` out
   of vercel.json because we're at the 40-cron Pro-plan cap (per the
   stream brief). The reconciler may want to fold it into the
   existing `prune_maintenance` cron that already runs 3 sub-jobs
   sequentially at 02:00 UTC. Backfill is heavier than prune (LLM
   calls, not DELETEs), so my recommendation is keep it manual-trigger
   for now and pick it up when a shared "Wave 27/28 maintenance"
   cron lands.

4. **Stream 4 copy fix.** I touched only the metric calc inside the
   "Today null-classification" card and added the new sub-stat below
   the existing caption. The caption itself ("inbounds with no
   extraction record") still says the old thing. Stream 4's F33 owns
   the rewrite; my edit doesn't conflict — it adds a line, doesn't
   change a line.

5. **`author_class_prompt_version` bump migration path.** When v2
   ships, the cron should re-classify rows where the version is
   `'author-class.prompt.v1'`. That's a one-line filter change on the
   backfill query plus a new `force` flag. Not built yet; not needed
   for v1.

## Verification

No build/test run per the stream brief. Migration 293 already exists.
TypeScript types declared on every new export. No em dashes. No
transaction wrappers in migrations (mig 293 already follows the
pattern). Inbox-lifecycle direction filter respected in the backfill
query (`.eq('direction', 'inbound')`).

Doctrine anchors followed:
- `bloom-constitution.md` — author_class is forensic, not heuristic
- `bloom-may9-llm-vs-template.md` — Haiku call, not a regex
- `feedback_deep_fix_vs_bandaid.md` — class-of-problem fix
- `feedback_inbox_lifecycle_inbound_only.md` — inbound filter on the
  backfill query
- `feedback_no_em_dash.md` — verified
