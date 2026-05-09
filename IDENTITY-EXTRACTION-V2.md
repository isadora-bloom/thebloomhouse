# Identity Extraction v2 — Wave 3 deep fix

Status: shipped 2026-05-09.
Anchor docs: `IDENTITY-CAPTURE-DESIGN.md` (full design), `bloom-constitution.md` (forensic identity reconstruction), `bloom-data-integrity-sweep.md` (Apr-30 ID-pipeline overhaul), Wave 2.5 commit `35f9430`.

---

## Why this exists

The pre-Wave-3 body extractor at `src/lib/services/identity/body-extract.ts` is structurally blind. It walks the flat haystack with `NAME_RE = /\b([A-Z][a-z'À-ſ-]{1,29})\s+([A-Z](?:[a-z'À-ſ-]{1,29}|\.))/g` and captures any "Capitalized Capitalized" pair. It cannot distinguish:

- The salutation addressee ("Hi Megan") from the sender — Megan is the COORDINATOR, not the prospect.
- The signature name ("Cheers, Mike") from a name dropped in the body for a different reason ("Mike from Knot is helping us tour venues").
- A forwarded chain's framing from the original sender's identity.
- The venue's own name or the AI assistant's name from a prospect's name.

Wave 2.5 (commit `35f9430`) added a reject-list at the chokepoint (`src/lib/services/identity/name-capture.ts`) that catches greetings, HTML residue, and venue-own names AFTER they've been captured as evidence. That patched the most visible symptoms but did nothing for the underlying extractor: the next class of junk (signoff phrases without names, role labels mistaken for names, mentioned-person promoted to sender, family-member captured as partner2) still slips through.

Wave 3 is the deep fix. It replaces the regex-over-body approach with structured email parsing + LLM-driven extraction + cross-validation against venue identity.

---

## Architecture

```
inbound email
   │
   ├─► parseEmailAnatomy(rawBody)
   │       returns ParsedEmailAnatomy {
   │         salutation, salutationName,
   │         body, signature, signoffName,
   │         forwarded (recursive), htmlStripped
   │       }
   │
   ├─► extractEmailIdentity({ rawBody, fromHeader, fromEmail, subject, venueContext, ... })
   │       1. parseEmailAnatomy()
   │       2. Build prompt with: salutation, body excerpt (1500 chars), signature,
   │          fromHeader, fromEmail, venue name, business name, AI name,
   │          team member names, owned email domains.
   │       3. Call Claude Haiku (tier='haiku', taskType='email_identity_extract',
   │          promptVersion='email-identity-extract.v1', temperature=0.0).
   │       4. Numbers-guard: every name in output must appear verbatim in input.
   │       5. Cross-validate sender_identity against venue's own outbound domain
   │          (reject the from_header source when the from_email's domain is
   │          venue-owned).
   │       returns ExtractedEmailIdentity {
   │         sender_identity { first, last, confidence, source },
   │         mentioned_humans [{ name, role, sub_role, confidence }],
   │         venue_side_echoes [string],
   │         rejected_tokens [string]
   │       }
   │
   ├─► pipeline.ts merges Wave-3 output INTO `interactions.extracted_identity`
   │       (alongside the legacy `extractIdentityFromEmail` regex output).
   │
   └─► chokepoint at name-capture.ts ingests the wave-3 sender_identity as
       a HIGH-CONFIDENCE per-email evidence row; mentioned_humans are
       available for `wedding_relationships` writers; venue_echoes are
       persisted on the row but never enter name_evidence.
```

---

## Contract changes on `interactions.extracted_identity`

**Back-compat preserved.** Every legacy field stays populated. New fields layer on top:

| Field | Pre-Wave-3 | Wave 3 |
|-------|------------|--------|
| `emails[]` | regex emails | unchanged |
| `phones[]` | regex phones | unchanged |
| `names[]` | regex `Capitalized Capitalized` pairs | augmented with LLM-classified humans + sender |
| `date_hints[]` | regex date patterns | unchanged |
| `guest_count_hint` | regex | unchanged |
| `primary_email` | first non-venue-non-relay email | unchanged |
| `sender_identity` | did not exist | `{ first, last, confidence, source: 'from_header'/'signature'/'body_self_reference'/'unknown' } \| null` |
| `mentioned_humans` | did not exist | `[{ name, role, sub_role?, confidence }]` |
| `venue_echoes` | did not exist | `[string]` — names that match venue's own identity |
| `rejected_tokens` | did not exist | `[string]` — junk caught by the LLM (greetings without names, signoff phrases, HTML residue) |

Downstream readers that already iterate `names[]` keep working unchanged. Readers that adopt `sender_identity` get a much stronger per-email signal.

---

## Chokepoint integration

`src/lib/services/identity/name-capture.ts` adds three new sources to the `NameSource` union:

| Source | Base confidence | Triggered when |
|--------|-----------------|----------------|
| `email_signature_extraction` | 75 | Wave-3 sender_identity.source = 'signature'. Name parsed from a signature block — the strongest single per-email signal. |
| `email_identity_extract_header` | 60 | sender_identity.source = 'from_header'. LLM still classified, but uses the from header which can carry a relay username. |
| `email_identity_extract_body` | 50 | sender_identity.source = 'body_self_reference'. LLM inference from body self-reference ("This is Sarah"). |

Cross-validation expansion in `loadVenueOwnNames` (chokepoint cache):

- Before Wave 3: `venues.name`, `venue_config.business_name`.
- After Wave 3: + `venue_ai_config.ai_name`, + every `user_profiles.first_name + last_name` for the venue's team.

The team-member match is **full-name only**. We deliberately do NOT add first-only entries because a prospect named "Megan" must not collide with a coordinator named "Megan". The Wave-3 LLM output's `venue_side_echoes` field is the better instrument for ambiguous first-only matches because it has salutation + signature context.

Wave 2.5's `REJECTED_NAME_TOKENS` greeting list and the synchronous `containsHtmlTag` / `isVenueOwnName` checks all stay in place. They are now the **safety net** — they catch anything that slips past the LLM (LLM unavailable, malformed JSON, the Wave-3 path bypassed).

---

## Cost model

Per email:

- Anatomy parser: $0 (pure function).
- LLM call: ~500 input tokens + ~150 output tokens × Haiku rate = ~$0.0002.

Per venue per month:

| Volume | Monthly cost |
|--------|--------------|
| 200 inbound emails | $0.04 |
| 1,000 inbound emails | $0.20 |
| 5,000 inbound emails | $1.00 |
| 10,000 inbound emails (Wedgewood-tier multi-property) | $2.00 |

Per-venue lifetime (Rixey-sized, 12 months of inbound history at ~600 weddings × 5 interactions): ~$0.60.

Backfill cost (one-time): cap at 50 LLM calls per wedding per call to `/api/admin/identity/rebuild-names`. A 700-wedding venue costs ~$7 to fully migrate. Idempotent — interactions with `sender_identity` already populated are skipped.

Budgeted under T1-O AI cost ceiling. Cheap.

---

## Failure modes & graceful degradation

`extractEmailIdentity` never throws. On any of the following, it returns an empty result and the pipeline continues with the legacy regex extractor:

- LLM unavailable (Anthropic 5xx, network timeout, fallback also failed).
- Malformed JSON response (the `callAIJson` parse fails).
- All names rejected by the verbatim guard (LLM hallucinated something not in the input).
- Sender domain matches venue's own outbound — sender_identity dropped, mentioned_humans + venue_echoes still returned.

Empty Wave-3 output means downstream chokepoint reads only the legacy `names[]` evidence — same behaviour as pre-Wave-3. No regression.

---

## Rollout sequence

1. **Ship code (Wave 3 commit, 2026-05-09).** Pipeline starts emitting Wave-3 fields on every new inbound email going forward. Cost impact ~$0.0002/email — invisible in the venue-budget mix.

2. **Backfill historical interactions.** Run `POST /api/admin/identity/rebuild-names` with `{ "dryRun": false, "runWave3Extract": true }`. Endpoint:
   - Walks weddings paged at `limit=50` per call.
   - For each wedding's interactions lacking `sender_identity`, calls `extractEmailIdentity` and patches `extracted_identity` jsonb on disk.
   - Re-runs the chokepoint picker on the upgraded evidence.
   - Caps LLM calls at `wave3PerWeddingCap=50` per wedding per call (configurable in body).
   - Returns `hasMore: true` until every wedding is processed; coordinator runner re-invokes until complete.

3. **Audit results.** Each upgraded wedding fires one `admin_notifications` row with the before/after picker output. Coordinator scans the bell, manually overrides any wrong picks via the existing Wave 2D evidence panel.

4. **Wave 2.5 reject-list watch.** Inspect `name-capture.rejected` log events. If the rate of safety-net trips is non-zero, the LLM is missing something — bump prompt version + add a row to PROMPTS-CHANGELOG.md.

---

## File inventory

| File | Change |
|------|--------|
| `src/lib/services/extraction/email-anatomy.ts` | NEW — `parseEmailAnatomy` |
| `src/lib/services/extraction/identity-from-email.ts` | NEW — `extractEmailIdentity` |
| `src/lib/services/email/pipeline.ts` | + `loadVenueIdentityContext`, Wave-3 wiring at `processIncomingEmail`, Wave-3 sender_identity → chokepoint capture |
| `src/lib/services/identity/name-capture.ts` | + 3 new `NameSource` enum members, expanded `loadVenueOwnNames` (ai_name + team), doctrine comment update |
| `src/app/api/admin/identity/rebuild-names/route.ts` | + `runWave3Extract` flag, `wave3PerWeddingCap` cap, `rebuildWave3IdentityForInteractions` helper, sender_identity + mentioned_humans signal harvest |
| `PROMPTS-CHANGELOG.md` | + Wave-3 entry for `email-identity-extract.v1` |

---

## Things Isadora should re-run

- [ ] **Sage email pipeline smoke test.** Send a test email from a personal Gmail to your venue's Sage address with the body `Hi Sage,\n\nMy fiancé Mike and I are interested in Rixey for September 2026.\n\nCheers,\nIsadora Martin-Dye`. Then check the resulting interaction in Supabase. `extracted_identity.sender_identity` should be `{ first: "Isadora", last: "Martin-Dye", source: "signature", confidence: 90+ }`. `extracted_identity.mentioned_humans` should include `{ name: "Mike", role: "partner" }`. `venue_echoes` should include `"Sage"`.

- [ ] **Backfill Rixey.** Hit `POST /api/admin/identity/rebuild-names` with `{ "dryRun": true }` to size the cohort, then `{ "dryRun": false, "runWave3Extract": true }` paged through every wedding. Audit the resulting `admin_notifications` "Name rebuilt from historical evidence" rows to confirm the fixes (Knot relays, "Hi Megan", `</strong>` etc. all clear).

- [ ] **Spot-check the bell.** Lead-detail evidence panel (`components/intel/NameEvidencePanel.tsx`) should now show new evidence rows tagged `email_signature_extraction` for any email that's arrived since the deploy.

- [ ] **Cost watch.** Check `api_costs` weekly for taskType=`email_identity_extract`. Expected steady-state ~$0.20/month at Rixey-scale. Alarm if 10× higher (LLM looping or a prompt-cache miss).
