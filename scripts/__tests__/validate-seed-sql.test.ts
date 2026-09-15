/**
 * Unit tests for the seed-SQL validator (W74).
 *
 * Fixture migrations + fixture seed SQL only — never touches the real
 * `supabase/migrations/` or `supabase/seed*.sql` trees, so a change to
 * either cannot make this suite flaky. The real trees are exercised by
 * `npm run check:seed-sql` itself (wired into `check:governance` and CI),
 * not by this file.
 */

import { describe, it, expect } from 'vitest'
import { buildSchemaFacts, type MigrationFile } from '../demo-reseed/schema-facts'
import {
  parseSeedInserts,
  classifySeedValue,
  validateSeedInsert,
  validateSeedSql,
  formatFindings,
  type SeedFinding,
} from '../validate-seed-sql'

function facts(files: MigrationFile[]) {
  return buildSchemaFacts(files)
}

// A schema modelled on the real bug: venues.plan_tier gets a CHECK, and
// interactions.signal_class becomes NOT NULL with no DEFAULT after an
// ADD COLUMN ... DROP DEFAULT pair, same shape as migration 192.
const FIXTURE_MIGRATIONS: MigrationFile[] = [
  {
    name: '001_base.sql',
    sql: `
      CREATE TABLE venues (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        plan_tier text DEFAULT 'starter' CHECK (plan_tier IN ('starter', 'enterprise'))
      );
      CREATE TABLE interactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        venue_id uuid NOT NULL,
        type text NOT NULL,
        note text
      );
    `,
  },
  {
    name: '002_plan_tier_v2.sql',
    sql: `
      ALTER TABLE venues DROP CONSTRAINT IF EXISTS venues_plan_tier_check;
      ALTER TABLE venues ADD CONSTRAINT venues_plan_tier_check
        CHECK (plan_tier IN ('solo', 'growth', 'enterprise'));
    `,
  },
  {
    name: '003_signal_class.sql',
    sql: `
      ALTER TABLE interactions
        ADD COLUMN signal_class text NOT NULL DEFAULT 'unclassified'
          CHECK (signal_class IN ('source', 'touchpoint', 'unclassified'));
      ALTER TABLE interactions ALTER COLUMN signal_class DROP DEFAULT;
    `,
  },
]

describe('parseSeedInserts', () => {
  it('parses a single-row insert with a trailing ON CONFLICT tail', () => {
    const sql = `INSERT INTO venues (id, name, plan_tier) VALUES ('v1', 'Test Venue', 'solo') ON CONFLICT (id) DO NOTHING;`
    const inserts = parseSeedInserts('fixture.sql', sql)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toMatchObject({ table: 'venues', columns: ['id', 'name', 'plan_tier'] })
    expect(inserts[0]!.rows).toEqual([["'v1'", "'Test Venue'", "'solo'"]])
    expect(inserts[0]!.statementIndex).toBe(1)
  })

  it('parses a multi-row VALUES clause into one row per tuple', () => {
    const sql = `
      INSERT INTO venues (id, name, plan_tier) VALUES
        ('v1', 'One', 'solo'),
        ('v2', 'Two', 'growth'),
        ('v3', 'Three', 'enterprise');
    `
    const inserts = parseSeedInserts('fixture.sql', sql)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.rows).toHaveLength(3)
    expect(inserts[0]!.rows[1]).toEqual(["'v2'", "'Two'", "'growth'"])
  })

  it('unquotes an escaped single quote inside a string literal', () => {
    const sql = `INSERT INTO venues (id, name, plan_tier) VALUES ('v1', 'O''Brien''s Barn', 'solo');`
    const inserts = parseSeedInserts('fixture.sql', sql)
    const value = classifySeedValue(inserts[0]!.rows[0]![1]!)
    expect(value).toEqual({ kind: 'string', value: "O'Brien's Barn" })
  })

  it('does not split inside an ARRAY[...] literal', () => {
    const sql = `INSERT INTO venues (id, name, plan_tier) VALUES ('v1', 'Test', 'solo');`
    // Sanity check on a table that actually carries an array value, using
    // the real shape (`knowledge_base.keywords ARRAY[...]`) this reader
    // must not miscount as extra columns.
    const arraySql = `INSERT INTO interactions (id, venue_id, type, note) VALUES ('i1', 'ven1', 'email', 'ok');`
    void sql
    const inserts = parseSeedInserts('fixture.sql', arraySql)
    expect(inserts[0]!.rows[0]).toHaveLength(4)

    const withArray = `INSERT INTO interactions (id, venue_id, type, note) VALUES ('i1', 'ven1', 'email', ARRAY['a', 'b', 'c']);`
    const parsed = parseSeedInserts('fixture.sql', withArray)
    expect(parsed[0]!.rows[0]).toHaveLength(4)
    expect(parsed[0]!.rows[0]![3]).toContain('ARRAY[')
  })

  it('skips an INSERT ... SELECT statement (no VALUES clause)', () => {
    const sql = `INSERT INTO venues (id, name, plan_tier) SELECT 'v1', 'Test', 'solo' WHERE NOT EXISTS (SELECT 1 FROM venues WHERE id = 'v1');`
    const inserts = parseSeedInserts('fixture.sql', sql)
    expect(inserts).toHaveLength(0)
  })

  it('gives every statement (including non-inserts) a 1-based index in file order', () => {
    const sql = `
      -- a comment statement is not a statement at all once split, this is
      DELETE FROM venues WHERE id = 'gone';
      INSERT INTO venues (id, name, plan_tier) VALUES ('v1', 'Test', 'solo');
    `
    const inserts = parseSeedInserts('fixture.sql', sql)
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.statementIndex).toBe(2)
  })
})

describe('classifySeedValue', () => {
  it('classifies NULL case-insensitively', () => {
    expect(classifySeedValue('NULL')).toEqual({ kind: 'null' })
    expect(classifySeedValue('null')).toEqual({ kind: 'null' })
  })

  it('classifies a string literal with a trailing cast', () => {
    expect(classifySeedValue("'unclassified'::text")).toEqual({ kind: 'string', value: 'unclassified' })
  })

  it('classifies a bare expression as other', () => {
    expect(classifySeedValue('now()').kind).toBe('other')
    expect(classifySeedValue('42').kind).toBe('other')
  })
})

describe('validateSeedInsert — rule 1: missing table', () => {
  it('flags a table no migration creates', () => {
    const f = facts(FIXTURE_MIGRATIONS)
    const inserts = parseSeedInserts('fixture.sql', `INSERT INTO ghost_table (id) VALUES ('x');`)
    const findings = validateSeedInsert(inserts[0]!, f)
    expect(findings.map((x) => x.kind)).toEqual(['missing-table'])
  })
})

describe('validateSeedInsert — rule 2: undeclared column', () => {
  it('flags a column no migration declares on that table', () => {
    const f = facts(FIXTURE_MIGRATIONS)
    const inserts = parseSeedInserts(
      'fixture.sql',
      `INSERT INTO venues (id, name, plan_tier, heat_score) VALUES ('v1', 'X', 'solo', 5);`,
    )
    const findings = validateSeedInsert(inserts[0]!, f)
    expect(findings.some((x) => x.kind === 'undeclared-column' && x.column === 'heat_score')).toBe(true)
  })
})

describe('validateSeedInsert — rule 3: CHECK violation', () => {
  it('flags a value outside the latest CHECK set', () => {
    const f = facts(FIXTURE_MIGRATIONS)
    const inserts = parseSeedInserts(
      'fixture.sql',
      `INSERT INTO venues (id, name, plan_tier) VALUES ('v1', 'X', 'intelligence');`,
    )
    const findings = validateSeedInsert(inserts[0]!, f)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'check-violation', column: 'plan_tier', value: 'intelligence' })
    expect(findings[0]!.allowed).toEqual(['solo', 'growth', 'enterprise'])
  })

  it('accepts a value in the latest set even though an old value existed pre-migration', () => {
    const f = facts(FIXTURE_MIGRATIONS)
    const inserts = parseSeedInserts(
      'fixture.sql',
      `INSERT INTO venues (id, name, plan_tier) VALUES ('v1', 'X', 'growth');`,
    )
    expect(validateSeedInsert(inserts[0]!, f)).toHaveLength(0)
  })

  it('does not flag a literal NULL against a CHECK set (Postgres passes CHECK on NULL)', () => {
    const f = facts(FIXTURE_MIGRATIONS)
    const inserts = parseSeedInserts(
      'fixture.sql',
      `INSERT INTO venues (id, name, plan_tier) VALUES ('v1', 'X', NULL);`,
    )
    // plan_tier is nullable in the fixture (no NOT NULL), so NULL is
    // valid on both the CHECK and the required-column rule.
    expect(validateSeedInsert(inserts[0]!, f)).toHaveLength(0)
  })
})

describe('validateSeedInsert — rule 4: NOT NULL column with no DEFAULT missing from the column list', () => {
  it('flags the omission and names the migration that made it required', () => {
    const f = facts(FIXTURE_MIGRATIONS)
    const inserts = parseSeedInserts(
      'fixture.sql',
      `INSERT INTO interactions (id, venue_id, type, note) VALUES ('i1', 'ven1', 'email', 'hi');`,
    )
    const findings = validateSeedInsert(inserts[0]!, f)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      kind: 'missing-required-column',
      column: 'signal_class',
      requiredSince: '003_signal_class.sql',
    })
  })

  it('passes once the required column is supplied with an allowed value', () => {
    const f = facts(FIXTURE_MIGRATIONS)
    const inserts = parseSeedInserts(
      'fixture.sql',
      `INSERT INTO interactions (id, venue_id, type, note, signal_class) VALUES ('i1', 'ven1', 'email', 'hi', 'source');`,
    )
    expect(validateSeedInsert(inserts[0]!, f)).toHaveLength(0)
  })

  it('flags a literal NULL supplied for a NOT NULL column as the same 23502 class', () => {
    const f = facts(FIXTURE_MIGRATIONS)
    const inserts = parseSeedInserts(
      'fixture.sql',
      `INSERT INTO interactions (id, venue_id, type, note, signal_class) VALUES ('i1', 'ven1', 'email', 'hi', NULL);`,
    )
    const findings = validateSeedInsert(inserts[0]!, f)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'null-in-required-column', column: 'signal_class' })
  })
})

describe('validateSeedInsert — schema qualification', () => {
  it('treats public.<table> the same as the unqualified table', () => {
    const f = facts(FIXTURE_MIGRATIONS)
    const inserts = parseSeedInserts(
      'fixture.sql',
      `INSERT INTO public.venues (id, name, plan_tier) VALUES ('v1', 'X', 'intelligence');`,
    )
    expect(inserts[0]!.table).toBe('venues')
    expect(validateSeedInsert(inserts[0]!, f)[0]!.kind).toBe('check-violation')
  })

  it('is out of scope for a non-public schema (auth.users)', () => {
    const f = facts(FIXTURE_MIGRATIONS)
    const inserts = parseSeedInserts(
      'fixture.sql',
      `INSERT INTO auth.users (id, email) VALUES ('u1', 'nobody@example.com');`,
    )
    expect(inserts[0]!.schema).toBe('auth')
    expect(validateSeedInsert(inserts[0]!, f)).toHaveLength(0)
  })
})

describe('validateSeedSql + formatFindings', () => {
  it('aggregates findings across every insert in a file and dedupes exact repeats', () => {
    const f = facts(FIXTURE_MIGRATIONS)
    const sql = `
      INSERT INTO venues (id, name, plan_tier) VALUES ('v1', 'X', 'intelligence');
      INSERT INTO interactions (id, venue_id, type, note) VALUES ('i1', 'ven1', 'email', 'hi');
      INSERT INTO venues (id, name, plan_tier) VALUES ('v2', 'Y', 'growth');
    `
    const findings = validateSeedSql('fixture.sql', sql, f)
    expect(findings.map((x) => x.kind).sort()).toEqual(['check-violation', 'missing-required-column'])
  })

  it('formats a passing result distinctly from a failing one', () => {
    expect(formatFindings([])).toContain('PASS')
    const finding: SeedFinding = {
      kind: 'missing-table',
      file: 'x.sql',
      statementIndex: 1,
      table: 'ghost',
      message: 'boom',
    }
    const formatted = formatFindings([finding])
    expect(formatted).toContain('FAIL')
    expect(formatted).toContain('boom')
  })
})
