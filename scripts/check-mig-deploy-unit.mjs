#!/usr/bin/env node
/**
 * Guard: code referencing new progression-eligible `action_type` values
 * must not ship before the matching migration extends the
 * `couple_progression_events_event_type_check` CHECK constraint.
 *
 * Why this exists
 * ---------------
 * §7 OPERATOR-BLOCK item 5 (PHASE-1-BATCH-2.md:264): Batch-2 wires five
 * new ingestion channels (Calendly cancellations, HoneyBook CSV, Twilio
 * + OpenPhone SMS, OpenPhone voice + voicemail, Zoom meetings) into the
 * cascade via `linkSignal`. Each emits new `action_type` values that
 * `progressionEventTypeFor` (`progression.ts`) maps to new
 * progression `event_type` values. If the code lands BEFORE the matching
 * migration extends the CHECK constraint:
 *
 *   - INSERT against `couple_progression_events` fails CHECK (23514).
 *   - `recordProgressionIfEligible` (`progression.ts:244-250`) swallows
 *     the error and returns `{recorded:false}` (only `23505` PK conflict
 *     is treated as success-without-clock-bump; every other code path
 *     returns the sentinel without throwing).
 *   - The legacy `interactions` / `touchpoints` writes STILL land —
 *     pipeline doesn't crash.
 *   - But `couples.last_progression_at` doesn't move, so decay scoring +
 *     heat-map color + journey-ribbon recency degrade silently. 6x the
 *     silent-degradation surface vs migration 368's single value.
 *
 * The pressure-test asked for a CI guard that couples the migration +
 * code as a single deploy unit. That's this file.
 *
 * What it checks
 * --------------
 * Two coupled invariants, both required for the deploy unit to hold:
 *
 *   (a) MAPPER COVERAGE — every progression `event_type` returned by
 *       `progressionEventTypeFor` is present in the committed CHECK
 *       constraint (the highest-numbered migration that defines or
 *       extends `couple_progression_events_event_type_check`).
 *
 *       Without this: code maps an action_type to an event_type whose
 *       CHECK doesn't accept it, INSERT fails 23514 silently.
 *
 *   (b) BUILDER COVERAGE — every `action_type` literal emitted by a
 *       cascade signal builder (`src/lib/services/identity/*-to-signal.ts`)
 *       is either (i) explicitly null-mapped by `progressionEventTypeFor`
 *       (intentional skip — e.g. `tour_cancelled` is regression, not
 *       progression), or (ii) maps to an event_type that the CHECK
 *       accepts.
 *
 *       Without this: a new builder ships a new action_type, the mapper
 *       doesn't know about it (returns null) → no progression row
 *       written, no error raised. The signal lands as a touchpoint and
 *       the operator sees the touchpoint but the decay clock never
 *       moves. That's the EXACT failure mode that motivates this guard.
 *
 * Pure static analysis — no DB dependency.
 *
 * Usage:
 *
 *   node scripts/check-mig-deploy-unit.mjs
 *
 * Exit 0 = clean. Exit 1 = mapper/builder/CHECK out of sync.
 *
 * --------------------------------------------------------------------
 * HOW TO ADD A NEW ACTION_TYPE (read before editing a *-to-signal.ts):
 * --------------------------------------------------------------------
 * Adding a new `action_type` literal in a signal builder under
 * `src/lib/services/identity/*-to-signal.ts` requires the migration
 * + mapper + builder land as ONE commit:
 *
 *   1. Decide whether the new action_type is PROGRESSION-eligible:
 *      - Inbound, couple-initiated, moves the lead forward → YES
 *      - Outbound venue activity, terminal/regression, or admin →
 *        explicitly add a null-return branch in
 *        `progressionEventTypeFor` (don't rely on default fall-through —
 *        the guard treats unmapped action_types as failures).
 *
 *   2. If YES, choose a progression `event_type`:
 *      - Reuse an existing one when semantically equivalent
 *        (e.g. HoneyBook CSV `crm_imported_booked` reuses
 *        `contract_signed` per progression.ts:166).
 *      - Coin a new one when distinct — naming pattern: verb-noun,
 *        inbound prefix when ambiguous direction.
 *
 *   3. If you coined a new event_type, create a new migration
 *      `supabase/migrations/NNN_progression_event_<short>.sql` that
 *      DROPs + re-ADDs `couple_progression_events_event_type_check`
 *      with the extended value list. Pattern: see migration 368 or
 *      the file referenced by §7 OPERATOR-BLOCK item 5.
 *
 *   4. Add the mapper branch in `progressionEventTypeFor` mapping
 *      (channel, action_type) → new event_type.
 *
 *   5. Add the action_type literal in the builder file
 *      (`<channel>-to-signal.ts`).
 *
 *   6. Run `node scripts/check-mig-deploy-unit.mjs` to verify.
 *
 *   7. Commit all of (3) + (4) + (5) together. The guard fails CI if
 *      any of the three drift.
 * --------------------------------------------------------------------
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const IDENTITY_DIR = join(REPO_ROOT, 'src', 'lib', 'services', 'identity')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations')
const PROGRESSION_FILE = join(IDENTITY_DIR, 'progression.ts')

// ---------------------------------------------------------------------------
// Signal-builder file list. Each builds a NormalizedSignal with a literal
// `action_type` value that downstream `linkSignal` → mapper →
// `recordProgressionIfEligible` consumes.
//
// If a new *-to-signal.ts file is added, add it here. The guard will then
// scan it for new action_type literals.
// ---------------------------------------------------------------------------
const BUILDER_FILES = [
  'calendly-to-signal.ts',
  'email-to-signal.ts',
  'honeybook-csv-to-signal.ts',
  'sms-to-signal.ts',
  'voice-to-signal.ts',
  'zoom-to-signal.ts',
]

// ---------------------------------------------------------------------------
// Action types that builders emit but the mapper intentionally drops to
// null (regression, outbound, admin, no-progression-mapping-yet). These
// are EXPECTED unmapped. Source of truth lives in progression.ts itself —
// each entry below must be backed by a branch / comment in that file.
//
// We mirror them here so the guard can distinguish "intentional skip"
// from "you added an action_type and forgot the mapper branch."
// ---------------------------------------------------------------------------
const INTENTIONALLY_UNMAPPED = new Set([
  // Outbound venue activity — explicit early-return in
  // `progressionEventTypeFor` (progression.ts:124). Doctrine §3
  // Don't-skip #1: "venue sent them a marketing email is not
  // progression."
  'venue_sent',
  'outbound',
  'auto_send',
  'sms_outbound',
  'outbound_call',
  // Regression signals — cancellation is NOT progression
  // (progression.ts:204-206). C11 lands them as touchpoints; D9 cohort
  // funnel detects regression from there.
  'tour_cancelled',
  // CSV terminal states — `crm_imported_lost` is loss, not progression
  // (progression.ts:158-159). Read off `weddings.lost_at` /
  // `weddings.status` instead.
  'crm_imported_lost',
  // Synthetic provenance row — discovery-source attribution, not a
  // couple-action progression (progression.ts:160-164). The discovery-
  // source path has its own progression handling via
  // captureDiscoverySource → Pbatch2-6 routing.
  'crm_attribution',
  // Body-extracted enrichment signal — Tier-0 follow-on after the
  // primary inbound has already been routed (sms-to-signal.ts:54-58
  // header). Not an inbound signal in its own right; the original
  // inbound already moved the clock.
  'body_extracted_email',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileExists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Extract every string-literal `action_type` value that appears in a
 * signal-builder file. Two shapes are recognised:
 *
 *   (a) Object-literal `action_type: 'foo'` (every -to-signal.ts builder
 *       ends with one or more `return { ..., action_type: 'foo', ... }`
 *       blocks).
 *   (b) Assignment to a `let actionType` / `const actionType` followed
 *       by `'foo'` — appears in sms-to-signal.ts + voice-to-signal.ts
 *       where the action_type depends on direction/mode at runtime.
 *
 * Honest gap: we DO NOT catch dynamic action_types (variables passed
 * through from caller, template literals). At time of writing every
 * builder uses string literals exclusively. If a future builder uses
 * a dynamic shape, the guard misses it — add a doctrine note here AND
 * audit the mapper coverage manually.
 */
function extractActionTypeLiterals(text) {
  const out = new Set()

  // Pattern (a): `action_type: 'foo'` or `action_type: "foo"` in object
  // literals. Captures the string value.
  const objLit = /\baction_type\s*:\s*['"]([a-z_]+)['"]/gi
  let m
  while ((m = objLit.exec(text)) !== null) {
    out.add(m[1])
  }

  // Pattern (b): `actionType = 'foo'` (camelCase local). sms/voice
  // builders use this shape inside an if/else chain.
  const assign = /\bactionType\s*=\s*['"]([a-z_]+)['"]/gi
  while ((m = assign.exec(text)) !== null) {
    out.add(m[1])
  }

  // Pattern (b'): `return 'foo'` inside an `actionTypeForStatus`-like
  // helper. honeybook-csv-to-signal.ts uses this for the status switch.
  // We bound the scan to lines that mention `crm_imported_` to avoid
  // catching unrelated `return 'foo'` statements (false positives).
  const returnLit = /return\s+['"](crm_imported_[a-z_]+|crm_attribution)['"]/g
  while ((m = returnLit.exec(text)) !== null) {
    out.add(m[1])
  }

  return out
}

/**
 * Parse `progressionEventTypeFor` from progression.ts and produce a Map
 * from action_type → event_type | null. Strategy: read the source as
 * text, locate the function body, then scan for the well-defined
 * pattern lines:
 *
 *   if (action === 'foo' || action === 'bar') return 'event_type'
 *   if (action === 'baz') return 'event_type'
 *
 * Plus the explicit-null early-return:
 *
 *   if (action === 'venue_sent' || action === 'outbound' || ...) {
 *     return null
 *   }
 *
 * This static-parse mirrors how the function actually dispatches; if
 * the function ever gets a more dynamic shape (mapping table, computed
 * dispatch) this parser MUST be revisited.
 */
function parseProgressionMapper(text) {
  const mapping = new Map() // action_type (lowercase) → event_type | null

  // ---------------------------------------------------------------------
  // First: the explicit-null early-return at progression.ts:124. Capture
  // every `action === 'X'` inside the `if (...) return null` block.
  // ---------------------------------------------------------------------
  const nullEarlyReturn = /if\s*\(([^)]+)\)\s*\{\s*return\s+null\s*;?\s*\}/g
  let m
  while ((m = nullEarlyReturn.exec(text)) !== null) {
    const condition = m[1]
    const actionEq = /action\s*===\s*['"]([a-z_]+)['"]/gi
    let am
    while ((am = actionEq.exec(condition)) !== null) {
      mapping.set(am[1].toLowerCase(), null)
    }
  }

  // ---------------------------------------------------------------------
  // Then: every `if (action === 'X' [|| action === 'Y']) return 'event'`
  // line. Capture all action literals on the LHS + the event_type on
  // the RHS.
  // ---------------------------------------------------------------------
  const ifReturn = /if\s*\(([^)]+)\)\s*return\s+['"]([a-z_]+)['"]/gi
  while ((m = ifReturn.exec(text)) !== null) {
    const condition = m[1]
    const eventType = m[2]
    const actionEq = /action\s*===\s*['"]([a-z_]+)['"]/gi
    let am
    while ((am = actionEq.exec(condition)) !== null) {
      const action = am[1].toLowerCase()
      // Honest precedence: the FIRST match wins (matches runtime
      // semantics — JS returns at the first satisfied branch). Don't
      // overwrite a prior mapping.
      if (!mapping.has(action)) mapping.set(action, eventType)
    }
  }

  return mapping
}

/**
 * Parse every migration's CHECK on `couple_progression_events.event_type`.
 * Returns the union of event_type values defined by the highest-numbered
 * migration that touches the constraint — that's the "committed schema."
 *
 * Strategy: scan migrations in numeric-prefix order; for each file that
 * mentions `couple_progression_events_event_type_check` OR creates the
 * table with an inline CHECK on event_type, extract the value list.
 * Later migrations REPLACE earlier ones (DROP CONSTRAINT then ADD), so
 * the LAST file's values are the source of truth.
 */
function parseCommittedCheck() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/i.test(f))
    .sort() // lexicographic = numeric for 3-digit prefixes

  let committed = null
  let committedFromFile = null

  for (const f of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, f), 'utf8')
    // We need either an inline CHECK on event_type in the table CREATE,
    // OR a DROP/ADD of the named constraint.
    const mentionsTable = /couple_progression_events/.test(text)
    if (!mentionsTable) continue

    const mentionsCheck =
      /event_type[^\n]*CHECK[^\n]*\(/i.test(text) ||
      /couple_progression_events_event_type_check/.test(text)
    if (!mentionsCheck) continue

    // Find every `CHECK (event_type IN ( 'a', 'b', ... ))` clause in
    // the file. The latest clause in the file wins (the file's own
    // last write). Tolerate multi-line value lists.
    //
    // Strip SQL `--` line comments FIRST. The migration files annotate
    // value lists with comments like `-- migration 371 additions
    // (Batch 2 channels)` — the literal `)` inside those comments
    // would short-circuit a naive `[^)]*` body capture. Stripping
    // comments line-by-line preserves line structure (so error-line
    // numbers downstream still match the file) while removing the
    // rogue parens.
    const stripped = text
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('--')
        return idx === -1 ? line : line.slice(0, idx)
      })
      .join('\n')

    const checkRe = /CHECK\s*\(\s*event_type\s+IN\s*\(([^)]*)\)\s*\)/gi
    let lastValues = null
    let m
    while ((m = checkRe.exec(stripped)) !== null) {
      const body = m[1]
      const values = new Set()
      const lit = /['"]([a-z_]+)['"]/gi
      let v
      while ((v = lit.exec(body)) !== null) {
        values.add(v[1])
      }
      if (values.size > 0) lastValues = values
    }

    if (lastValues) {
      committed = lastValues
      committedFromFile = f
    }
  }

  return { values: committed, sourceFile: committedFromFile }
}

// ---------------------------------------------------------------------------
// Run the checks
// ---------------------------------------------------------------------------

function main() {
  const violations = []
  const info = []

  // 1. Parse the committed CHECK from migrations.
  const { values: committedCheck, sourceFile: checkFile } = parseCommittedCheck()
  if (!committedCheck) {
    console.error(
      'FAIL — could not locate any migration defining the '
        + '`couple_progression_events.event_type` CHECK constraint. '
        + 'Expected an inline CHECK in the CREATE TABLE or a named '
        + 'constraint `couple_progression_events_event_type_check` in '
        + 'a DROP/ADD migration. Check supabase/migrations/.',
    )
    process.exit(1)
  }
  info.push(
    `committed CHECK: ${[...committedCheck].sort().join(', ')} `
      + `(from supabase/migrations/${checkFile})`,
  )

  // 2. Parse the progression.ts mapper.
  if (!fileExists(PROGRESSION_FILE)) {
    console.error(
      `FAIL — progression.ts not found at ${relative(REPO_ROOT, PROGRESSION_FILE)}.`,
    )
    process.exit(1)
  }
  const progressionText = readFileSync(PROGRESSION_FILE, 'utf8')
  const mapper = parseProgressionMapper(progressionText)

  // 3. Coverage (a): MAPPER → CHECK. Every event_type the mapper can
  // return must be in the committed CHECK.
  const mappedEventTypes = new Set()
  for (const [, eventType] of mapper) {
    if (eventType !== null) mappedEventTypes.add(eventType)
  }
  for (const et of mappedEventTypes) {
    if (!committedCheck.has(et)) {
      violations.push(
        `Mapper-vs-CHECK drift: \`progressionEventTypeFor\` (progression.ts) `
          + `returns event_type '${et}' but the committed CHECK constraint `
          + `(supabase/migrations/${checkFile}) does NOT accept it. `
          + `Add a migration extending couple_progression_events_event_type_check `
          + `to include '${et}' BEFORE shipping the code that returns it.`,
      )
    }
  }

  // 4. Coverage (b): BUILDERS → MAPPER → CHECK. Every action_type a
  // builder emits must either be intentionally-unmapped or map to a
  // CHECK-accepted event_type.
  for (const builderFile of BUILDER_FILES) {
    const builderPath = join(IDENTITY_DIR, builderFile)
    if (!fileExists(builderPath)) {
      violations.push(
        `Builder file missing: ${relative(REPO_ROOT, builderPath)}. `
          + `Update BUILDER_FILES in this script if the file was renamed `
          + `or removed; otherwise restore the builder.`,
      )
      continue
    }
    const builderText = readFileSync(builderPath, 'utf8')
    const actions = extractActionTypeLiterals(builderText)
    for (const action of actions) {
      const a = action.toLowerCase()

      // First check: is the action explicitly null-mapped by the mapper
      // OR known-intentionally-unmapped per the INTENTIONALLY_UNMAPPED
      // set?
      const mapperKnows = mapper.has(a)
      const mapperReturnsNull = mapperKnows && mapper.get(a) === null
      const intentionallyUnmapped = INTENTIONALLY_UNMAPPED.has(a)

      if (mapperReturnsNull) continue
      if (intentionallyUnmapped) continue

      if (!mapperKnows) {
        violations.push(
          `Action type '${a}' in src/lib/services/identity/${builderFile} `
            + `is not handled by progressionEventTypeFor (progression.ts) — `
            + `neither an explicit mapping nor an explicit null-return nor `
            + `a listing in INTENTIONALLY_UNMAPPED. Either add a mapper `
            + `branch (with a CHECK-accepted event_type) OR add the `
            + `action to INTENTIONALLY_UNMAPPED in this script with a `
            + `comment justifying why it never produces a progression row.`,
        )
        continue
      }

      // mapperKnows AND not null → maps to a real event_type.
      const eventType = mapper.get(a)
      if (!committedCheck.has(eventType)) {
        violations.push(
          `Action type '${a}' in src/lib/services/identity/${builderFile} `
            + `maps to progression event '${eventType}' which is not in any `
            + `committed migration's CHECK constraint `
            + `(supabase/migrations/${checkFile}). Add a migration before `
            + `shipping code referencing '${a}'.`,
        )
      }
    }
  }

  // ---------------------------------------------------------------------
  // Emit results
  // ---------------------------------------------------------------------
  for (const line of info) {
    // eslint-disable-next-line no-console
    console.log(line)
  }

  if (violations.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `\nOK — migration / mapper / signal-builder are in sync. `
        + `${BUILDER_FILES.length} builders scanned · `
        + `${mappedEventTypes.size} mapped event types · `
        + `${committedCheck.size} committed CHECK values.`,
    )
    process.exit(0)
  }

  console.error('\nFAIL — migration / code deploy-unit out of sync:\n')
  for (const v of violations) {
    console.error(`  - ${v}`)
  }
  console.error(
    '\nSee PHASE-1-BATCH-2.md §7 OPERATOR-BLOCK item 5 + the '
      + '`HOW TO ADD A NEW ACTION_TYPE` header comment in this script '
      + '(scripts/check-mig-deploy-unit.mjs).\n',
  )
  process.exit(1)
}

main()
