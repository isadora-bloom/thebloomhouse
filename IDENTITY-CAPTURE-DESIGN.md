# Identity Capture — Deep Design

Status: research + design only. No code or migrations have changed.
Anchor docs: `bloom-constitution.md` (Point-Zero), `src/lib/services/identity/resolver.ts` (resolver chain), `bloom-data-integrity-sweep.md` (Apr-30 ID-pipeline overhaul).

---

## 1. TL;DR

The pipeline mints `people.first_name` / `people.last_name` from whichever signal happened to arrive first — usually a Gmail `From:` header or a CSV row — and never re-evaluates. There is no concept of "evidence." The same field carries a Knot relay proxy ID (`User 89436314x630a2de3b6d57e165fc99f`), a calculator-form's full legal name, and a contract signer's name with no way to know which is best. The new mandate (2026-05-09) added a one-shot upgrader (`identity/name-upgrade.ts`) but it still writes to the same flat columns and a username-shaped `from_name` (`Erinhorrigan`, `Mconn`, `Thelabrozzis`) is structurally indistinguishable from a real first name once it lands.

The fix is to keep every name we ever see as evidence (`people.name_evidence` jsonb array of `{source, value, confidence, captured_at}`), to compute `first_name` / `last_name` / `display_name` as a *picked* projection of that evidence at write time, and to put a username-shape detector in front of every capture site so junk goes to a `display_handle` column instead of a name column. Family / planner / mom mentions move to a new `wedding_relationships` table so they stop being created as `partner2`. Resolver rerun closes Naina-style multi-wedding leakage.

Effort is roughly two weeks of work split across five phases (schema → capture-site refactor → backfill → resolver patch → UI polish), with mig 255 the next slot.

---

## 2. Audit — every ingest site that writes a name

Each row is one place where a name shape becomes a `people` row (or a `candidate_identities` row that later promotes).

| # | Site | File | Lines | Source signal | Validation today | Failure example from Rixey |
|---|------|------|-------|----------------|-------------------|----------------------------|
| 1 | Email pipeline `findOrCreateContact` | `src/lib/services/email/pipeline.ts` | 620-633 | `from_name` header → split on whitespace; `email.split('@')[0]` fallback | `name?.trim().split(/\s+/)`; no shape check | `Erinhorrigan` (RM-0011) — Knot proxy `From: Erinhorrigan` lands as `first_name='Erinhorrigan'`. `User 89436314x...` → `first_name='User'`, `last_name='89436314x...'` (RM-0007) |
| 2 | Email pipeline partner2 from classifier | `src/lib/services/email/pipeline.ts` | 1710-1719 | `extracted.partnerName` (LLM classifier output) | none | `Brett Smith & Brett` (RM unknown) — body says "thanks, Brett" so classifier emits `partnerName='Brett'` |
| 3 | Email pipeline scheduling-tool synth | `src/lib/services/email/pipeline.ts` | 2398-2413 | Calendly `inviteeName`, fallback to `email.split('@')[0]` | none | `Juliabrosenberger` from `juliabrosenberger@gmail.com` (cited in code comment line 2491) |
| 4 | Email pipeline scheduling partner2 | `src/lib/services/email/pipeline.ts` | 2438-2449 | `extras.partnerName` from Calendly extras | none | When Calendly's "partner name" answer is blank, body fallback can dump a planner / mom |
| 5 | Email pipeline name-hygiene overwrite | `src/lib/services/email/pipeline.ts` | 2493-2519 | Calendly `inviteeName` | "looksLikeSalvage" heuristic on length+casing | Heuristic at 2509-2515 has logical bug: ternary returns boolean of `!curLast` regardless of casing branch. Real names with no last get smashed. |
| 6 | Email pipeline sub-zero candidate | `src/lib/services/email/pipeline.ts` | 1900-1919 | `senderName` (extracted) ∥ `fromName` | none | Same Knot proxies and concatenated handles flow into `candidate_identities.first_name` |
| 7 | Identity resolver `createPerson` | `src/lib/services/identity/resolver.ts` | 447-472 | `signals.fullName` ∥ `signals.partner1Name`; fallback `email.split('@')[0]` | none | Single-name imports become `first_name='Hyo Jung'`, `last_name=null` |
| 8 | Resolver email-canon backfill | `src/lib/services/identity/resolver.ts` | 553-568 | `signals.fullName` | only fills nulls (`!hit.first_name`) | Once a junk first lands first (case 1), this site is a no-op even when better evidence arrives |
| 9 | Name-upgrade service | `src/lib/services/identity/name-upgrade.ts` | 240-373, 422-433, 536-562 | `interactions.extracted_identity.names[]`, contract `extracted_text`, wedding notes, sage_context | strict-prefix rule (`Jen`→`Jennifer`), conflict reject | Cannot fix `Erinhorrigan`→`Erin Horrigan` because no prefix relation. Cannot fix `Mconn` because there is no signal anywhere with the real name. |
| 10 | CRM-import generic-csv | `src/lib/services/crm-import/generic-csv.ts` | 183-188 | mapped CSV cells | none | Coordinator pastes "Mary and Mendy Pratt" into `partner1_first_name` |
| 11 | CRM-import HoneyBook | `src/lib/services/crm-import/honeybook.ts` | 506-511 | parsed project name | "Mike's Wedding" stripper at 286 | Stripper leaves `Mike's` as `partner2_first_name`; possessive lands as a name |
| 12 | CRM-import tour-scheduler | `src/lib/services/crm-import/tour-scheduler.ts` | 886-891 | Calendly `Invitee` + extras | none | Same as #3 / #4 but at import time |
| 13 | CRM-import web-form | `src/lib/services/crm-import/web-form.ts` | 744-753 | calculator form fields | none | Coordinator-controlled fields, generally clean |
| 14 | CRM-import commit (people) | `src/lib/services/crm-import/index.ts` | 506-545 | normalised row | dedupe partner2 by `ilike(first_name)` | Will dedup `Brett & Brett` to one Brett (good) but ilike-empty-string matches everyone (bad) |
| 15 | Coordinator CSV import | `src/lib/services/data-import.ts` | 148-159, 262-267 | mapped row, `splitName(rawName)` | None for partner2 | "Carolynn Boutivas (mother of the Bride)" stays whole as partner1 first |
| 16 | Brain-dump LLM extraction | `src/app/api/brain-dump/route.ts` | 300-301, 336, 345, 854-856 | Vision LLM output | LLM-prompted to keep `Jen B.` style | LLM follows instructions but mostly OK; this is high-quality |
| 17 | Brain-dump resolve route | `src/app/api/brain-dump/[id]/resolve/route.ts` | 397-409 | "staffName" trimmed | none | Looks up an existing user by ilike — does not write a person row |
| 18 | Form-relay parsers | `src/lib/services/ingestion/form-relay-parsers.ts` | (whole file, 35-58 the shape) | parser-extracted `leadName`, `partnerName` | `looksLikePersonName` rejector at lines 76+ | Generally clean — strongest source apart from contract |
| 19 | Platform-detectors (CSV) | `src/lib/services/platform-detectors/{the-knot, wedding-wire, instagram, pinterest, ...}.ts` | each `parseFirstLast` | last-token heuristic | filters `last_name=null` when token is single letter | Pinterest / handle platforms set `first_name=null` (line 77 pinterest.ts) — the cluster fingerprint is then unsalvageable |
| 20 | Zoom transcript matcher | `src/lib/services/ingestion/zoom.ts` | 433-449 | spoken-name token match against existing `people` | does not write — read only | n/a |
| 21 | Identity reconciliation merger | `src/lib/services/identity/reconciliation.ts` | 696-712 | promotes loser fields onto winner | `namesAreCompatible` check | Compares only on the existing flat columns, so a junk-first vs real-first looks like a conflict and the merger declines |

A read-only consumer surface — not a writer — but worth knowing: the inbox renderer at `src/lib/services/email/pipeline.ts:2799-2815` builds a couple label from `partner1.first_name` + `partner2.first_name`; if either is junk the inbox prints junk.

---

## 3. Failure-mode classification

For each named bug shape from the brief, traced to the site responsible.

### 3a. Username-shaped values land as `first_name`

**Examples:** `Mconn`, `Erinhorrigan`, `Thelabrozzis`, `Hillfive`, `Catesbyandben`, `Rosaliehoyle`, `User 89436314x...`

**Why it happens:** Site #1 takes `from_name` verbatim. The Gmail `From:` field on Knot relays is not a human-controlled field; it's a token the platform synthesises from the prospect's username on Knot — sometimes "First Last", sometimes a `firstname+lastname` smush, sometimes a literal `User <opaque-id>`. The pipeline cannot tell those apart from a real name.

**Why it shouldn't happen:** Names have shape rules a heuristic can defend (single-token over 11 chars with no vowels-after-consonants in a typical pattern, mixed-case smush, `User <hex>`). When the shape fails the test, the value is a *handle*, not a name.

**Cost when wrong:** Coordinator inbox shows "Erinhorrigan" as the lead's first name. Sage prompts include `"Hi Erinhorrigan,"` in drafts unless a manual override happens. Family-and-friends communications are embarrassing. RM-0007's `User 89436314x630a2de3b6d57e165fc99f` is the worst case: Sage will literally call the lead "User."

### 3b. First-name-plus-initial captured but never upgraded

**Examples:** `Jen B`, `Heidy D`, `K A`, `Christina M`, `Kellie Phillis via WeddingWire`

**Why it happens:** Site #19 (`platform-detectors/wedding-wire.ts:48-49`) deliberately writes `last_initial='B'` and `last_name=null`. Site #1 then sees a `From: Jen B` and writes `first_name='Jen'`, `last_name='B'`. The body extractor (site #9) only upgrades on a strict-prefix relation; "B" is a one-character prefix of every B-surname, but the upgrade then needs a reliable full-last-name candidate from the same wedding. WeddingWire-only weddings never get one.

**Why it shouldn't happen:** "B" should be carried as `last_initial` evidence with low confidence so a later signal can override. Today it's stamped as an authoritative `last_name='B'` and any subsequent upgrade must clear the prefix-rule plus the evidence-conflict guard.

**Cost when wrong:** Sage writes "Hi Jen B" in drafts. Search-by-last-name returns "B" alphabetised as a giant cluster.

### 3c. First-name-only on real bookings

**Examples:** `Hyo Jung` (booked), `John`, `Liam`, `Adam`, `Ben`, `Aidan`, `Brett Smith`, dozens more

**Why it happens:** Site #3 / #7 / #15 fall back to whatever the available signal carries. If Calendly only has "Adam" in `Invitee:` — common when the invitee answered with first-name only — that's what gets stored. The resolver's never-overwrite rule (site #8) protects the value forever even when contract data later carries the legal name.

**Why it shouldn't happen:** "First-name-only" is a signal-quality state — represented in the evidence record, not in the picked field. If a downstream contract signer arrives, the picker should re-run.

**Cost when wrong:** Booked weddings (Hyo Jung at RM-0299) are missing a last name forever. Coordinator can't print signed contract envelope. Cohort analytics group "John" into one giant John-cluster.

### 3d. Partner-placeholder duplicates ("X & X")

**Examples:** `Brett Smith & Brett`, `Hannah Lord & Hannah Lord`, `Tae Chang & Tae Chang`, `Jeremy Hinson & Jeremy Hinson`

**Why it happens:** Site #2 — the email pipeline minds an LLM `extracted.partnerName`. The classifier reads the body, sees the sender sign off "Brett," and emits `partnerName: 'Brett'`. That writes a row with `first_name='Brett'`, `last_name=null`. There is no check that `partnerName !== senderFirstName`.

A separate path: Site #14 dedup uses `ilike('first_name', row.partner2_first_name ?? '')`. When `partner2_first_name` is empty string, ilike-empty matches *every* row → falsely says "partner2 already exists" and skips legitimate inserts.

**Why it shouldn't happen:** Two people with identical first name and no last name on the same wedding is almost certainly a phantom. (Sarah Rohrschneider & Sarah Olkowski is a real edge case but they have full last names — that's the disambiguator.)

**Cost when wrong:** Sage's couple-context prompts say "writing to Brett and Brett" — coordinator reads the AI output and laughs (or worse, the AI uses it in a draft).

### 3e. Family / planner mention captured as partner2

**Examples:** `Carolynn Boutivas & Carrie Merlin (mother of the Bride)`, `Mary and Mendy Pratt` (single string with two names jammed)

**Why it happens:** Site #2 (LLM partner extraction) and site #15 (CSV split) both treat any second name as partner2 by structural assumption. There is no `relationship_role` slot — the `people.role` enum has `partner2`, `guest`, `family` but the pipeline never writes `family`.

**Why it shouldn't happen:** `mother of the Bride`, `planner`, `MOH`, `(mom)`, `'s sister`, `friend who's helping plan` are role descriptors. Anything in parentheses, anything ending in `'s mom`, `'s mother`, `'s dad`, etc., is structurally a relationship descriptor and should not become partner2.

**Cost when wrong:** Couple-portal sees "Carrie" as a couple member. Sage addresses contract draft to "Carolynn and Carrie." Worse: when the actual second partner emails, the resolver finds the wedding, sees a partner2 already exists, and either creates a third person or merges incorrectly.

### 3f. Multi-name single-string

**Examples:** `Mary and Mendy Pratt`

**Why it happens:** A coordinator typed "Mary and Mendy Pratt" in a CSV partner1 column or it came from a CRM that doesn't split. Site #15's `splitName` takes the first whitespace-split token as first and the rest as last → `first_name='Mary'`, `last_name='and Mendy Pratt'`.

**Why it shouldn't happen:** "X and Y", "X & Y", "X y Y" patterns should be detected as a couple-string and split into two partners with shared last (Pratt).

**Cost when wrong:** The wedding row only has one partner, called "Mary and Mendy Pratt" with last name "and Mendy Pratt." Every downstream surface that joins on last_name breaks.

### 3g. Cross-row duplicates the resolver missed

**Examples:** Naina Davidar at RM-0200 (Inquiry) AND RM-0204 (lost). Sarah Rohrschneider in 3 RM-codes. Cameron at RM-0301, Justin at RM-0279, Jamie Boyer at RM-0113 + RM-0259.

**Why it happens:** The resolver match chain at `identity/resolver.ts:511-630` picks the first hit and stops. When the second wedding lands with a slightly different email shape (Knot relay alias `naina.davidar.<hash>@member.theknot.com` versus her personal `naina@gmail.com`), step 1 (email exact) misses, step 2 (gmail canonical) misses (different domain), step 3 (phone) only fires if the second arrival has phone, step 4 (name+date) only fires if both are absent. The resolver creates a fresh wedding.

The post-create `enqueueIdentityMatches` (site #1 via line 660-668) runs the candidate clusterer / merger but the merger requires the same fingerprint (first_name + last_initial + state) within tight windows; cross-platform same-person-different-platform is exactly the case the windows were tuned to *not* auto-merge.

The people-merge-aliases logic at `identity/people-merge-aliases.ts:16-85` handles the `member.theknot.com` alias case but only after the fact, on a periodic sweep.

**Why it shouldn't happen:** A truly-same person (same email canonical OR same phone OR same Knot/WW external_id when present) should attach to the existing wedding rather than mint a new one. A new wedding for the *same person* should require explicit signal of a new event (new wedding_date 90+ days off the existing, OR coordinator action).

**Cost when wrong:** Two RM-codes for one couple → coordinator confusion, double drafts, double notifications, attribution split, Sage prompt context split.

---

## 4. Proposed model

### 4a. Schema

```sql
-- Migration 255 (next slot — confirmed in supabase/migrations/254_*.sql is latest)
ALTER TABLE public.people ADD COLUMN name_evidence jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.people ADD COLUMN display_handle text;        -- username/handle salvage when no real name yet
ALTER TABLE public.people ADD COLUMN name_confidence smallint;   -- 0-100, picked-evidence score
ALTER TABLE public.people ADD COLUMN name_picked_source text;    -- which evidence source won

CREATE INDEX idx_people_name_confidence ON public.people(name_confidence)
  WHERE merged_into_id IS NULL;

CREATE TABLE public.wedding_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  first_name text,
  last_name text,
  relationship_role text NOT NULL CHECK (relationship_role IN (
    'mother', 'father', 'parent', 'mother_in_law', 'father_in_law',
    'planner', 'wedding_party', 'maid_of_honor', 'best_man',
    'sibling', 'child', 'family_other', 'friend', 'vendor_contact', 'other'
  )),
  source text NOT NULL,           -- 'body_extraction', 'brain_dump', 'manual', 'csv_import'
  confidence smallint,            -- 0-100
  source_interaction_id uuid REFERENCES interactions(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  created_by uuid                 -- nullable; pipeline writes leave null
);
CREATE INDEX idx_wedding_relationships_wedding ON public.wedding_relationships(wedding_id);
COMMENT ON TABLE public.wedding_relationships IS 'owner:agent — non-partner humans named on a wedding';
```

`name_evidence` shape (jsonb array, append-only at the service layer):

```json
[
  { "source": "gmail_from_name", "value": { "first": "Jen", "last": "B" }, "raw": "Jen B", "captured_at": "2026-04-15T...", "confidence": 30 },
  { "source": "calculator_form", "value": { "first": "Jennifer", "last": "Biaksangi" }, "captured_at": "2026-04-21T...", "confidence": 90 },
  { "source": "contract_signer", "value": { "first": "Jennifer", "last": "Biaksangi" }, "captured_at": "2026-04-29T...", "confidence": 98 }
]
```

`display_handle` is the username-shaped salvage (`Erinhorrigan`, `Mconn`) so coordinator UIs can show "Knot username: erinhorrigan" while keeping `first_name`/`last_name` blank.

### 4b. Confidence scoring

Confidence is the static base. The picker adds runtime adjustments (email-match boost, recency boost, completeness bonus).

| Source | Base confidence | Notes |
|--------|-----------------|-------|
| `coordinator_typed` | 100 | Manual override is law |
| `contract_signer` | 98 | Signed legal document |
| `calculator_form` | 90 | Coordinator-shaped fields, structured |
| `web_form_other` | 85 | Other branded form intakes |
| `brain_dump_note` | 80 | Coordinator-typed observation |
| `email_extracted_identity_direct` | 70 | Parser populated `first_name`/`last_name` directly in `extracted_identity` |
| `email_signature_extraction` | 70 | Name in sig block |
| `tour_transcript` | 70 | Spoken, may have ASR errors |
| `gmail_from_name_full` | 75 | "Jennifer Biaksangi" two-token + clean |
| `gmail_from_name_first_initial` | 30 | "Jen B" — first + initial |
| `gmail_from_name_all_caps` | 60 | "JENNIFER BIAKSANGI" — likely real but suspect |
| `gmail_from_name_single` | 35 | "Adam" — first only |
| `partner_mention_in_body` | 40 | LLM extracted partner name from body |
| `pinterest_scraper` | 30 | Often a username |
| `email_handle` | 20 | `rosaliehoyle@gmail.com` → `Rosalie Hoyle`, best-effort |
| `gmail_from_name_username_shaped` | 0 | Junk; rejected to `display_handle` |
| `relay_proxy_id` | 0 | `User <hex>` — rejected entirely |

Runtime adjustments:
- +20 when the `value` came from an interaction whose `from_email` matches the people row's stored email (the person is naming themselves)
- +15 completeness bonus when both first AND last fields are present
- −10 staleness penalty when newer evidence with overlapping shape exists (favours fresher signals on ties)

### 4c. Picker logic

```
function pickDisplayName(evidence: NameEvidence[]) -> { first, last, confidence, source }
  for field in [first, last]:
    candidates = evidence.filter(e => isUsable(e, field))
    if none: field = null; continue
    sort candidates by adjustedScore desc, captured_at desc
    field = top.value[field]
  store: name_picked_source = top.source for first; confidence = top.adjustedScore
```

Hard rule: never pick a value that fails the username detector (4d). When all evidence is junk, both fields stay null and `display_handle` is populated from the highest-confidence handle salvage.

### 4d. Username detector — runs at every capture site

`isUsernameShaped(value: string): boolean`

Returns true (reject as a name) when:

1. Single token, length ≥ 11, mixed-case smush with no whitespace and at least one non-prefix capital ("Erinhorrigan", "Catesbyandben", "Rosaliehoyle", "Thelabrozzis"). Tunable threshold; 11 chosen so "Christopher" passes.
2. Single token all-lowercase with length ≥ 6 ("mconn" — though `from_name` is rarely all-lowercase, this catches handle-leak cases)
3. Contains digits ("user12345", "username2026", "thebride2027")
4. Matches `/^User\s+[A-Za-z0-9]{20,}$/` (Knot proxy ID pattern, RM-0007)
5. Matches `/^[a-z0-9._-]+$/` AND length ≥ 8 (looks like an email local-part / handle)
6. Contains a known relay-domain substring ("via WeddingWire", "@member.theknot")
7. ALL CAPS over 12 chars AND contains punctuation typical of sig-block junk

When (1) or (2) fires, the value goes to `display_handle` instead of `first_name`. When (3)-(7) fire, the value is dropped from name evidence entirely (still recorded as evidence row with `confidence: 0` for audit, but never picked).

Sub-fallback: when `display_handle` is empty and we still need *something* to display, use the email local part with title-case AND only if it itself is not username-shaped. If everything fails, display falls back to literal `(Unknown)` — never silently uses junk.

### 4e. Partner-placeholder detector

Runs after both partners are computed but before they're committed.

| Pattern | Action |
|---------|--------|
| partner2.first === partner1.first AND partner2.last is null | Drop partner2 (Brett & Brett, Hannah & Hannah) |
| partner2.first === partner1.first AND partner2.last === partner1.last | Drop partner2 (full duplicate) |
| partner2.full matches `/\(.+\)/` (has parenthetical role) | Move to `wedding_relationships`, parse role from parenthetical |
| partner2.full matches `/'s (mom|mother|dad|father|sister|brother|aunt|uncle|cousin|MOH|maid of honor|best man|planner)\b/i` | Move to `wedding_relationships` |
| partner1.full matches `/^([A-Z][a-z]+)\s+(?:and|&|y)\s+([A-Z][a-z]+)\s+([A-Z][a-z]+)$/` (Mary and Mendy Pratt) | Split into two partners with shared last name |

Family / planner mentions extracted from email body (LLM partnerName output OR body-extract `names[]`) get classified through the same detector before they ever land as `people`.

### 4f. Resolver: same-person multi-wedding rule

Add to `identity/resolver.ts:511`:

```
After step 1-4 hit, before fetching active wedding:
  - If the matched person already has a non-terminal wedding AND
    the incoming signal carries a wedding_date that's within ±60 days of
    the stored wedding_date (or no incoming wedding_date),
    attach to existing wedding (current behaviour).
  - If the incoming wedding_date is >60 days off the stored AND the
    matched wedding's status is non-terminal,
    create wedding_identity_conflict admin_notification and attach to
    existing (current). Caller must explicitly opt into a new-wedding
    create.
  - If the matched person's only wedding is terminal (lost / cancelled / completed)
    AND incoming is a fresh inquiry, surface a "re-engagement / second wedding?"
    notification and ask coordinator BEFORE creating a new wedding.
```

This prevents Naina-style splits: when Knot view → email arrives for someone whose prior wedding closed lost, the system should ask rather than mint.

---

## 5. Phased rollout

### Phase 1 — Schema + capture primitives (mig 255)

- Migration `255_identity_evidence.sql`: people columns + wedding_relationships table.
- New service `src/lib/services/identity/name-capture.ts` (NEW FILE) exporting:
  - `captureNameEvidence(personId, signal)` — appends evidence
  - `pickDisplayName(person)` — recomputes `first_name`/`last_name`/`display_handle`
  - `isUsernameShaped(value)` — detector with the seven rules above
  - `extractFromEmailHandle(email)` — local-part → title-case best-effort
  - `classifyRelationshipFromString(value)` — returns `{ kind: 'partner', value } | { kind: 'relationship', role, name }`
- New service `src/lib/services/identity/relationships.ts` (NEW FILE) with `addWeddingRelationship`, `findRelationships(weddingId)`.

No call sites move yet — the primitives ship green and the existing flat columns keep working.

### Phase 2 — Capture-site refactor

Replace inline name-writing at every site from §2. Order by impact:

1. Email pipeline (#1, #2, #3, #4): biggest blast radius. Write to evidence list + call picker. Junk goes to `display_handle`.
2. Resolver `createPerson` (#7): pass evidence array; fields computed from picker.
3. Resolver backfill (#8): replace "fill if null" with "append evidence + pick again."
4. Sub-zero candidate (#6): same.
5. CRM-import paths (#10, #11, #12, #13, #14): import rows arrive with structured first/last; that's high-confidence `csv_coordinator` source.
6. data-import #15: same.
7. Brain-dump #16, #17: append evidence with `brain_dump_note` source.
8. Platform detectors #19: handle goes to `display_handle`, parsed first/last_initial to evidence.

`name-upgrade.ts` becomes a thin wrapper: it now just runs the picker against fresh evidence rather than mutating columns directly.

### Phase 3 — Backfill (`/api/admin/identity/rebuild-names`, NEW endpoint)

Walks every non-tombstoned `people` row at a venue:
1. Loads every interaction for that wedding plus contracts plus brain-dump entries
2. Runs the same evidence-capture extractors as the live pipeline (re-using Phase-2 primitives)
3. Runs the picker
4. Stamps the changes; records a `name_rebuild_audit` rows so coordinator can review what changed

Cost estimate: per-venue a Rixey-sized run is ~600 weddings × ~5 interactions average = ~3000 row scans. The existing `name-upgrade` endpoint already does most of the SELECT shape; same query plan extended to write evidence rather than columns. Each venue should complete under 30 seconds; safe to run synchronously from the admin UI. No LLM calls.

### Phase 4 — Identity merge gaps

- Resolver patch: same-person multi-wedding rule (§4f).
- Partner-placeholder cleanup pass: scan every wedding with two partners, run §4e detector on the pair, queue admin review for non-trivial drops, auto-fix the obvious cases (`Brett & Brett` etc).
- Family-mention sweep: scan `weddings.notes` + `interactions.extracted_identity.names[]` for parenthetical role markers; create `wedding_relationships` rows; if the same name currently exists as a `partner2` person, soft-delete that person (set `merged_into_id` to a tombstone target — needs a separate "non_partner_demoted" tombstone semantic, design TBD).

### Phase 5 — UI polish

- Lead-detail "Name Evidence" panel: show the evidence array, confidence per row, picker decision, manual override button.
- `/admin/identity` page extension: shows weddings with `name_confidence < 50` for coordinator review.
- Couple portal: surfaces `display_handle` as "Knot username:" if known, otherwise hides.
- Sage prompts: read picker output, never raw `first_name` if `name_confidence < 30`.

---

## 6. Backfill design (Phase 3 detail)

Endpoint: `POST /api/admin/identity/rebuild-names` body `{ venueId: uuid, dryRun: boolean }`.

Pipeline per person:
1. Load all interactions for `wedding_id`, all contract `extracted_text`, all brain_dump entries linked.
2. Extract candidates via the same primitives the live pipeline uses (this is why Phase 2 builds them as a service).
3. For each candidate, classify via `isUsernameShaped` + `classifyRelationshipFromString`.
4. Append all surviving candidates to `name_evidence`.
5. Run the picker; write `first_name` / `last_name` / `display_handle` / `name_confidence` / `name_picked_source`.
6. Log a `name_rebuild_audit_entry` (could be `admin_notifications` row with `type='name_rebuild'`) listing before/after for any field that moved.

Cost: a ~600-wedding venue with no LLM calls runs in seconds. The expensive write is the evidence-array population; we batch updates per person. Idempotent — running it twice is a no-op because the evidence array dedupes on `(source, value, captured_at)`.

---

## 7. Open questions for Isadora

These are decisions the design needs before Phase 2 ships.

### Q1 — First-name-only booked weddings (Hyo Jung, John, Liam, Adam)

Three options:

- **A.** Show `first_name` only, suffix `(last name unknown)` in coordinator UI. Sage drafts use first only.
- **B.** Use the email handle as a soft hint: `John (jdavidson@gmail.com)` in coordinator UI; Sage uses first only.
- **C.** Leave display blank — force coordinator to fill it before booking moves forward (gates the wedding state-transition).

The user's directive says "no names should be just one name if they have inquired." Option C honours the spirit but blocks ingestion; option A/B keeps flow but accepts the gap. **Recommendation: A for inquiries, C as a soft warning at booked-status transition (don't block, but surface in lead-detail prominently).**

### Q2 — Pinterest / Knot username scraping

If the only signal we ever get is `rosaliehoyle` (Pinterest handle), do we (a) proactively visit `pinterest.com/rosaliehoyle/` to look for a real name, or (b) wait for an organic email that surfaces the real identity?

(a) is fragile (rate limits, robots.txt, JS-rendered profiles), gives weak data ("Rosalie H"), and risks abuse complaints. (b) is patient — the resolver will pick up the real name when it arrives. **Recommendation: b. Storing the handle as `display_handle` with `pinterest_scraper` confidence 30 lets the picker activate as soon as a better signal lands.**

### Q3 — Partner-placeholder "Brett & Brett" handling

Three options:

- **A.** Drop partner2 entirely. `wedding.couple_label = 'Brett'`, `partner_count = 1`.
- **B.** Drop partner2 but flag `wedding.single_decision_maker = true` so prompts know.
- **C.** Keep partner2 but mark `is_phantom = true`, hide from couple portal.

Some real weddings have one decision-maker speaking. The coordinator needs to know whether the actual second person is silent or absent. **Recommendation: B — `weddings.partner_count` (smallint, NULL by default) gets stamped 1 when the placeholder detector fires.**

### Q4 — `wedding_relationships` minimum viable surface

- **A.** Storage + audit only (CSV-import sees it, body-extract writes it, never displayed).
- **B.** Storage + lead-profile read view (coordinator sees a "Family & Friends" section).
- **C.** B plus Sage prompt context (planner's name flows into draft signing).

**Recommendation: B for Phase 1 ship, C as a Phase 5 polish. Risk in C: leaks of family names into AI drafts could be cringe; needs a confirmed-by-coordinator gate.**

### Q5 — `display_handle` visibility

Internal-only or surfaced to coordinators?

- **A.** Hidden — internal field used only for fallback rendering when name is blank.
- **B.** Surfaced as small print under name on lead detail ("Knot: rosaliehoyle").

**Recommendation: B. Coordinators recognise platform handles and use them to identify leads when memory beats UI search.**

---

## File inventory (what changes in each phase)

| Phase | New files | Modified files | Migrations |
|-------|-----------|----------------|------------|
| 1 | `lib/services/identity/name-capture.ts`, `lib/services/identity/relationships.ts` | (none) | `255_identity_evidence.sql` |
| 2 | `app/api/admin/identity/rebuild-names/route.ts` | `lib/services/email/pipeline.ts` (sites #1-#5), `lib/services/identity/resolver.ts` (#7-#8), `lib/services/identity/name-upgrade.ts`, `lib/services/crm-import/index.ts` (#14), `lib/services/data-import.ts` (#15), `app/api/brain-dump/route.ts`, all `lib/services/platform-detectors/*.ts` (#19) | (none) |
| 3 | (admin UI tab on `/admin/identity`) | `app/(platform)/admin/identity/page.tsx` | (none) |
| 4 | (none) | `lib/services/identity/resolver.ts` (multi-wedding rule), `lib/services/identity/reconciliation.ts` | optional `256_partner_count.sql` if Q3=B |
| 5 | `components/identity/name-evidence-panel.tsx` | `app/(platform)/agent/leads/[id]/...`, Sage prompt builder | (none) |

---

End of design.
