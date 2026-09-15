/**
 * W70: tests for the demo-coverage static parsers.
 *
 * The coverage report is only worth reading if the parsing underneath it
 * is right. Two of these cases are regressions found while writing it:
 * a split SQL statement carries the comment block above it, so an
 * anchored `^INSERT` matches almost nothing; and the wave 7 and 8 seed
 * files use `INSERT ... SELECT ... WHERE NOT EXISTS`, which has no VALUES
 * clause at all and would otherwise have read as zero rows.
 *
 * The last test is the one that matters most: the plan the reseed
 * generates must actually reach every table the aux generator claims,
 * with enough rows on each that a surface has something to show.
 */

import { describe, it, expect } from 'vitest'
import {
  buildStaticCoverage,
  classify,
  countValuesTuples,
  enumerateDemoTables,
  isSingleRowSelect,
  parseSeedRows,
  reseedTableRows,
  stripLeadingComments,
  summarise,
  THIN_THRESHOLD,
  verdictFor,
} from '../demo-coverage'
import { AUX_TABLES, DRAFT_STATES } from '../demo-reseed/mirror-rows'
import { generateDemoDataset, SEED_TODAY } from '../demo-reseed/generate'
import { buildReseedPlan } from '../demo-reseed/plan'

describe('countValuesTuples', () => {
  it('counts a single-row insert', () => {
    expect(countValuesTuples("INSERT INTO t (a, b) VALUES (1, 'x')")).toBe(1)
  })

  it('counts a multi-row insert', () => {
    expect(
      countValuesTuples("INSERT INTO t (a) VALUES (1), (2), (3), (4)"),
    ).toBe(4)
  })

  it('does not count parentheses inside a string literal', () => {
    expect(
      countValuesTuples("INSERT INTO t (a) VALUES ('a (nested) note'), ('b')"),
    ).toBe(2)
  })

  it('does not count parentheses inside a nested function call', () => {
    expect(
      countValuesTuples(
        "INSERT INTO t (a, b) VALUES (jsonb_build_object('k', 'v'), now()), (NULL, now())",
      ),
    ).toBe(2)
  })

  it('stops at ON CONFLICT', () => {
    expect(
      countValuesTuples(
        'INSERT INTO t (a) VALUES (1), (2) ON CONFLICT (a) DO UPDATE SET a = excluded.a',
      ),
    ).toBe(2)
  })

  it('ignores a VALUES that is only part of a longer word', () => {
    expect(countValuesTuples('INSERT INTO t (a) SELECT novalues FROM u')).toBeNull()
  })

  it('returns null when there is no VALUES clause', () => {
    expect(countValuesTuples('INSERT INTO t (a) SELECT a FROM u')).toBeNull()
  })

  it('does not count a comment that contains a bracket', () => {
    expect(
      countValuesTuples("INSERT INTO t (a) VALUES\n  -- see (above)\n  (1), (2)"),
    ).toBe(2)
  })
})

describe('stripLeadingComments', () => {
  it('drops a leading line-comment block', () => {
    const out = stripLeadingComments('-- one\n-- two\n\nINSERT INTO t (a) VALUES (1)')
    expect(out.startsWith('INSERT')).toBe(true)
  })

  it('drops a leading block comment', () => {
    expect(stripLeadingComments('/* hello */ INSERT INTO t (a) VALUES (1)')).toBe(
      'INSERT INTO t (a) VALUES (1)',
    )
  })

  it('leaves a bare statement alone', () => {
    expect(stripLeadingComments('INSERT INTO t (a) VALUES (1)')).toBe(
      'INSERT INTO t (a) VALUES (1)',
    )
  })
})

describe('isSingleRowSelect', () => {
  it('is true for an insert-if-absent with a literal row', () => {
    expect(
      isSingleRowSelect(
        "INSERT INTO t (a) SELECT 'x' WHERE NOT EXISTS (SELECT 1 FROM t WHERE a = 'x')",
      ),
    ).toBe(true)
  })

  it('is false when the select reads a table', () => {
    expect(isSingleRowSelect('INSERT INTO t (a) SELECT a FROM u')).toBe(false)
  })
})

describe('parseSeedRows', () => {
  it('sums tuples per table across comment-separated statements', () => {
    const sql = `
      -- the first block
      INSERT INTO guest_list (a) VALUES (1), (2);

      -- the second block, on the same table
      INSERT INTO guest_list (a) VALUES (3);

      -- an insert-if-absent
      INSERT INTO contracts (a)
      SELECT 'one'
      WHERE NOT EXISTS (SELECT 1 FROM contracts WHERE a = 'one');

      -- something genuinely dynamic
      INSERT INTO weather_data (a) SELECT g FROM generate_series(1, 30) g;
    `
    const { counts, dynamic } = parseSeedRows(sql)
    expect(counts.guest_list).toBe(3)
    expect(counts.contracts).toBe(1)
    expect(counts.weather_data).toBeUndefined()
    expect(dynamic.has('weather_data')).toBe(true)
  })

  it('ignores statements that are not inserts', () => {
    const { counts } = parseSeedRows('UPDATE venue_config SET a = 1;')
    expect(Object.keys(counts)).toHaveLength(0)
  })
})

describe('enumerateDemoTables', () => {
  const migrations = `
    CREATE TABLE IF NOT EXISTS alpha (
      id uuid PRIMARY KEY,
      venue_id uuid NOT NULL
    );
    CREATE TABLE IF NOT EXISTS beta (
      id uuid PRIMARY KEY,
      wedding_id uuid NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gamma (
      id uuid PRIMARY KEY,
      name text
    );
    ALTER TABLE gamma ADD COLUMN IF NOT EXISTS venue_id uuid;
    CREATE TABLE IF NOT EXISTS delta (
      id uuid PRIMARY KEY,
      venue_id uuid
    );
    DROP TABLE IF EXISTS delta;
  `

  it('finds venue_id and wedding_id tables', () => {
    const names = enumerateDemoTables(migrations).map((t) => t.table)
    expect(names).toContain('alpha')
    expect(names).toContain('beta')
  })

  it('picks up a column added by a later ALTER', () => {
    const gamma = enumerateDemoTables(migrations).find((t) => t.table === 'gamma')
    expect(gamma?.keys).toEqual(['venue_id'])
  })

  it('drops a table a later migration removed', () => {
    const names = enumerateDemoTables(migrations).map((t) => t.table)
    expect(names).not.toContain('delta')
  })

  it('adds the couple-keyed spine table', () => {
    const row = enumerateDemoTables(migrations).find(
      (t) => t.table === 'couple_progression_events',
    )
    expect(row?.keys).toEqual(['couple_id'])
  })
})

describe('verdictFor', () => {
  it('calls an empty table empty', () => {
    expect(verdictFor(0, 'guest_list')).toBe('empty')
  })

  it('calls a table under the threshold thin', () => {
    expect(verdictFor(THIN_THRESHOLD - 1, 'guest_list')).toBe('thin')
  })

  it('accepts four rows on a one-row-per-venue table', () => {
    expect(classify('venue_config')).toBe('per-venue')
    expect(verdictFor(4, 'venue_config')).toBe('ok')
    expect(verdictFor(3, 'venue_config')).toBe('thin')
  })

  it('marks a provider-only table not applicable', () => {
    expect(verdictFor(0, 'gmail_connections')).toBe('n/a')
  })

  it('classifies a work queue as a queue', () => {
    expect(classify('intel_match_jobs')).toBe('queue')
    expect(classify('tracer_run_events')).toBe('core')
  })
})

describe('the reseed plan against the coverage report', () => {
  const plan = buildReseedPlan(generateDemoDataset({ today: SEED_TODAY }))
  const byTable = reseedTableRows(plan)

  it('writes every table the aux generator lists', () => {
    const missing = AUX_TABLES.filter((t) => (byTable[t] ?? 0) === 0)
    expect(missing).toEqual([])
  })

  it('writes at least the minimum on each of them', () => {
    // The minimum is the coverage script's own, not a second copy of it:
    // five rows, or four on a table whose natural maximum is one per
    // venue.
    const thin = AUX_TABLES.filter((t) => verdictFor(byTable[t] ?? 0, t) !== 'ok')
    expect(thin).toEqual([])
  })

  it('puts a draft in every state a coordinator sees', () => {
    const states = new Set<string>()
    for (const step of plan.steps) {
      if (step.kind !== 'aux_rows' || step.table !== 'drafts') continue
      for (const row of step.rows ?? []) states.add(String(row.status))
    }
    expect([...states].sort()).toEqual([...DRAFT_STATES].sort())
  })

  it('rebuilds the spine itself', () => {
    expect(byTable.couples).toBeGreaterThanOrEqual(30)
    expect(byTable.couples).toBeLessThanOrEqual(60)
    expect(byTable.touchpoints).toBeGreaterThan(200)
    // Progression is the decay clock. A plan that mints couples and no
    // progression events would leave every surface that reads
    // `last_progression_at` blank, which is the state production is in.
    expect(byTable.couple_progression_events).toBeGreaterThan(100)
  })

  it('clears every table it writes, so a second run replaces rather than doubles', () => {
    const cleared = new Set(plan.deletes.map((d) => d.table))
    // `table_map_layouts` is the documented exception: it has no
    // venue_id, so it rides the weddings cascade instead.
    const notCleared = AUX_TABLES.filter((t) => !cleared.has(t) && t !== 'table_map_layouts')
    expect(notCleared).toEqual([])
  })
})

describe('the committed seed set', () => {
  const rows = buildStaticCoverage({ repoRoot: process.cwd() })

  it('leaves no core table that the brief names empty', () => {
    // The tables W70 was asked for by name. Not the whole 250: most of
    // the rest are feature-specific or filled by a running job, and the
    // report's own class column says which.
    const required = [
      'couples',
      'touchpoints',
      'fragments',
      'couple_progression_events',
      'candidate_matches',
      'weddings',
      'people',
      'tours',
      'lost_deals',
      'engagement_events',
      'reviews',
      'review_language',
      'weather_alerts',
      'weather_climate_norms',
      'weather_climate_annual',
      'commitment_reconciliation',
      'contracts',
      'guest_list',
      'seating_tables',
      'rsvp_responses',
      'timeline',
      'budget_items',
      'booked_vendors',
      'vendor_recommendations',
      'marketing_spend_records',
      'google_ads_connections',
      'meta_ads_connections',
      'tiktok_ads_connections',
      'planning_notes',
      'follow_up_sequences',
      'drafts',
      'lifecycle_transitions',
      'user_profiles',
      'team_invitations',
      'couple_invites',
    ]
    const byName = new Map(rows.map((r) => [r.table, r]))
    const short = required.filter((t) => {
      const row = byName.get(t)
      return !row || row.verdict === 'empty' || row.verdict === 'thin'
    })
    expect(short).toEqual([])
  })

  it('reports more rows than tables, which is the whole point', () => {
    const summary = summarise(rows)
    expect(summary.seededTotal).toBeGreaterThan(summary.tables * 10)
    expect(summary.ok).toBeGreaterThan(80)
  })

  it('leaves nothing half-seeded', () => {
    // A ratchet. Empty is a decision anyone can read off the report; one
    // or two rows is the state that makes a page look broken without
    // anyone noticing it is the seed rather than the reader. Adding a
    // table to the seed set and stopping at three rows fails here.
    const thin = rows.filter(
      (r) => r.read && r.verdict === 'thin' && (r.kind === 'core' || r.kind === 'per-venue'),
    )
    expect(thin.map((r) => r.table)).toEqual([])
  })

  it('does not count a table a later migration renamed away (W72)', () => {
    // Migration 009 creates follow_up_sequence_templates; migration 040
    // renames it to _archived_follow_up_sequence_templates. No migration
    // ever runs a literal DROP TABLE on it, so enumerateDemoTables's own
    // regex would keep it. schema-facts sees the RENAME, and
    // buildStaticCoverage filters through schema-facts precisely so this
    // phantom table cannot show up as a gap (or, worse, as seeded) in
    // the coverage report.
    expect(rows.find((r) => r.table === 'follow_up_sequence_templates')).toBeUndefined()
  })
})
