/**
 * Unit tests for the live CHECK constraint reader (W75): the deparsed
 * definition parser, the POSIX-to-JS regex translation, the probe fetch
 * (injected fetch, no network) and the merge into schema facts, plus
 * rule 5 in the seed validator on top of merged facts.
 *
 * Fixture migrations only. The real trees are exercised by
 * `npm run check:seed-sql` (offline) and `validate-seed-sql.ts --live
 * .env.test` (operator, against the test branch), not here.
 */

import { describe, it, expect } from 'vitest'
import { buildSchemaFacts, type MigrationFile } from '../demo-reseed/schema-facts'
import { posixEreToJs } from '../demo-reseed/posix-regex'
import {
  parseConstraintDefinition,
  fetchLiveCheckConstraints,
  mergeLiveConstraints,
  LIVE_CHECK_PROBE_SQL,
  PROBE_MARKER,
  type LiveCheckConstraint,
} from '../demo-reseed/live-constraints'
import { parseSeedInserts, validateSeedInsert } from '../validate-seed-sql'

const FIXTURE_MIGRATIONS: MigrationFile[] = [
  {
    name: '001_base.sql',
    sql: `
      CREATE TABLE meta_ads_connections (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        venue_id uuid NOT NULL,
        token_env_key text,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'revoked'))
      );
      CREATE TABLE weddings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code_extension text,
        start_date date,
        end_date date
      );
    `,
  },
]

// What pg_get_constraintdef prints for the three shapes that matter.
const DEF_REGEX_NULLABLE =
  "CHECK (((token_env_key IS NULL) OR (token_env_key ~ '^(META_ADS|TIKTOK_ADS|INSTAGRAM)_VENUE_[A-Z0-9_]+$'::text)))"
const DEF_IN_LIST = "CHECK ((status = ANY (ARRAY['pending'::text, 'connected'::text, 'revoked'::text])))"
const DEF_IN_LIST_VARCHAR =
  "CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'connected'::character varying])::text[])))"
const DEF_REGEX_CI = "CHECK ((slug ~* '^[a-z][a-z0-9-]*$'::text))"
const DEF_POSIX_CLASS = "CHECK ((code ~ '^[[:alpha:]]{2}$'::text))"
const DEF_MULTI_COLUMN = 'CHECK ((end_date > start_date))'

describe('parseConstraintDefinition', () => {
  it('parses a deparsed IN-list (= ANY (ARRAY[...]))', () => {
    expect(parseConstraintDefinition(DEF_IN_LIST)).toEqual({
      kind: 'values',
      column: 'status',
      values: ['pending', 'connected', 'revoked'],
    })
  })

  it('parses the varchar deparse with its double cast', () => {
    expect(parseConstraintDefinition(DEF_IN_LIST_VARCHAR)).toEqual({
      kind: 'values',
      column: 'status',
      values: ['pending', 'connected'],
    })
  })

  it('parses "col IS NULL OR col ~ regex" (migration 411 shape)', () => {
    const parsed = parseConstraintDefinition(DEF_REGEX_NULLABLE)
    expect(parsed.kind).toBe('pattern')
    if (parsed.kind !== 'pattern') return
    expect(parsed.column).toBe('token_env_key')
    expect(parsed.pattern).toBe('^(META_ADS|TIKTOK_ADS|INSTAGRAM)_VENUE_[A-Z0-9_]+$')
    expect(parsed.caseInsensitive).toBe(false)
    expect(parsed.regex.test('META_ADS_VENUE_HAWTHORNE_MANOR')).toBe(true)
    expect(parsed.regex.test('META_ADS_ACCESS_TOKEN')).toBe(false)
  })

  it('parses "col ~* regex" as case-insensitive', () => {
    const parsed = parseConstraintDefinition(DEF_REGEX_CI)
    expect(parsed.kind).toBe('pattern')
    if (parsed.kind !== 'pattern') return
    expect(parsed.caseInsensitive).toBe(true)
    expect(parsed.regex.test('Hawthorne-Manor')).toBe(true)
  })

  it('marks a POSIX bracket class untranslatable with the reason, rather than guessing', () => {
    const parsed = parseConstraintDefinition(DEF_POSIX_CLASS)
    expect(parsed.kind).toBe('untranslatable')
    if (parsed.kind !== 'untranslatable') return
    expect(parsed.column).toBe('code')
    expect(parsed.reason).toMatch(/POSIX bracket class/)
  })

  it('returns unrecognised for a cross-column comparison', () => {
    expect(parseConstraintDefinition(DEF_MULTI_COLUMN)).toEqual({ kind: 'unrecognised' })
  })

  it('tolerates a trailing NOT VALID', () => {
    expect(parseConstraintDefinition(`${DEF_IN_LIST} NOT VALID`).kind).toBe('values')
  })
})

describe('posixEreToJs', () => {
  it('translates the shapes this repo uses, with the s flag for Postgres newline semantics', () => {
    const t = posixEreToJs('^[a-z]+(?:_[a-z0-9]+){0,2}$')
    expect(t.ok).toBe(true)
    if (!t.ok) return
    expect(t.regex.flags).toBe('s')
    expect(t.regex.test('us_va_richmond')).toBe(true)
    expect(t.regex.test('us_va_richmond_extra')).toBe(false)
  })

  it('adds the i flag when asked', () => {
    const t = posixEreToJs('^abc$', true)
    expect(t.ok && t.regex.test('ABC')).toBe(true)
  })

  it('escapes a leading ] inside a bracket expression (literal in POSIX, empty class in JS)', () => {
    const t = posixEreToJs('^[]a]+$')
    expect(t.ok).toBe(true)
    if (!t.ok) return
    expect(t.regex.test(']a]')).toBe(true)
    expect(t.regex.test('b')).toBe(false)
  })

  it('refuses \\b (backspace in ARE, word boundary in JS)', () => {
    const t = posixEreToJs('\\bword\\b')
    expect(t.ok).toBe(false)
    if (t.ok) return
    expect(t.reason).toMatch(/escape \\b/)
  })

  it('refuses [[:alpha:]], [[=e=]] and [[.x.]]', () => {
    expect(posixEreToJs('[[:alpha:]]').ok).toBe(false)
    expect(posixEreToJs('[[=e=]]').ok).toBe(false)
    expect(posixEreToJs('[[.hyphen.]]').ok).toBe(false)
  })

  it('refuses the *** director prefix and embedded options', () => {
    expect(posixEreToJs('***=literal').ok).toBe(false)
    expect(posixEreToJs('(?i)abc').ok).toBe(false)
  })

  it('accepts \\d, \\s, \\w and escaped punctuation', () => {
    const t = posixEreToJs('^\\d{3}-\\w+\\.\\s?$')
    expect(t.ok).toBe(true)
    if (!t.ok) return
    expect(t.regex.test('123-abc. ')).toBe(true)
    expect(t.regex.test('12-abc.')).toBe(false)
  })
})

describe('fetchLiveCheckConstraints', () => {
  const env = { url: 'https://example.supabase.co', serviceRoleKey: 'service-key' }

  function fakeFetch(body: unknown, status = 200) {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response
    }
    return { fetchImpl, calls }
  }

  it('posts the probe to exec_sql and parses the payload out of the raised error', async () => {
    const rows: LiveCheckConstraint[] = [
      {
        table: 'meta_ads_connections',
        column: 'token_env_key',
        name: 'meta_ads_connections_token_env_key_shape',
        definition: DEF_REGEX_NULLABLE,
      },
      { table: 'weddings', column: null, name: 'weddings_dates', definition: DEF_MULTI_COLUMN },
    ]
    const { fetchImpl, calls } = fakeFetch({
      ok: false,
      error: `${PROBE_MARKER}${JSON.stringify(rows)}`,
      state: 'P0001',
    })
    const out = await fetchLiveCheckConstraints(env, fetchImpl)
    expect(out).toEqual(rows)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://example.supabase.co/rest/v1/rpc/exec_sql')
    const sent = JSON.parse(String(calls[0]!.init?.body)) as { sql: string }
    expect(sent.sql).toBe(LIVE_CHECK_PROBE_SQL)
    // Read-only by construction: one SELECT, one RAISE, nothing else.
    expect(sent.sql).toMatch(/pg_get_constraintdef/)
    expect(sent.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i)
  })

  it('throws when exec_sql answers ok:true (no payload, probe did not raise)', async () => {
    const { fetchImpl } = fakeFetch({ ok: true })
    await expect(fetchLiveCheckConstraints(env, fetchImpl)).rejects.toThrow(/no probe payload/)
  })

  it('throws on a non-2xx response', async () => {
    const { fetchImpl } = fakeFetch({}, 401)
    await expect(fetchLiveCheckConstraints(env, fetchImpl)).rejects.toThrow(/HTTP 401/)
  })

  it('throws when the error is a real database error, not the probe marker', async () => {
    const { fetchImpl } = fakeFetch({ ok: false, error: 'permission denied for table pg_constraint' })
    await expect(fetchLiveCheckConstraints(env, fetchImpl)).rejects.toThrow(/failed inside the database/)
  })
})

describe('mergeLiveConstraints', () => {
  const live: LiveCheckConstraint[] = [
    {
      table: 'meta_ads_connections',
      column: 'token_env_key',
      name: 'meta_ads_connections_token_env_key_shape',
      definition: DEF_REGEX_NULLABLE,
    },
    {
      table: 'meta_ads_connections',
      column: 'status',
      name: 'meta_ads_connections_status_check',
      // Live has one value fewer than the fixture migration: live wins.
      definition: "CHECK ((status = ANY (ARRAY['pending'::text, 'connected'::text])))",
    },
    { table: 'weddings', column: null, name: 'weddings_dates', definition: DEF_MULTI_COLUMN },
    {
      table: 'weddings',
      column: 'code_extension',
      name: 'weddings_code_extension_shape',
      definition: "CHECK ((code_extension ~ '^[[:alpha:]]{2}$'::text))",
    },
    { table: 'not_in_migrations', column: 'x', name: 'x_check', definition: DEF_IN_LIST },
    {
      // Catalog and definition disagree on the column: skipped with a note.
      table: 'weddings',
      column: 'start_date',
      name: 'weddings_mismatch',
      definition: DEF_POSIX_CLASS,
    },
  ]

  it('writes live IN-lists and patterns over the migration facts, live winning', () => {
    const merged = mergeLiveConstraints(buildSchemaFacts(FIXTURE_MIGRATIONS), live)
    expect(merged.read).toBe(6)
    expect(merged.valuesApplied).toBe(1)
    expect(merged.patternsApplied).toBe(1)
    expect(merged.facts.allowedValues('meta_ads_connections', 'status')).toEqual(['pending', 'connected'])
    const col = merged.facts.tables.get('meta_ads_connections')!.columns.get('token_env_key')!
    expect(col.pattern).toBe('^(META_ADS|TIKTOK_ADS|INSTAGRAM)_VENUE_[A-Z0-9_]+$')
    expect(col.patternConstraint).toBe('meta_ads_connections_token_env_key_shape')
  })

  it('ignores a multi-column constraint (column null) and notes the untranslatable and unknown-table ones', () => {
    const merged = mergeLiveConstraints(buildSchemaFacts(FIXTURE_MIGRATIONS), live)
    expect(merged.facts.tables.get('weddings')!.columns.get('code_extension')!.pattern).toBeNull()
    expect(merged.notes.some((n) => n.includes('weddings.code_extension') && n.includes('NOT checked'))).toBe(true)
    expect(merged.notes.some((n) => n.includes('not_in_migrations'))).toBe(true)
    expect(merged.facts.tableExists('not_in_migrations')).toBe(false)
    expect(merged.notes.some((n) => n.includes('weddings_mismatch') && n.includes('catalog says'))).toBe(true)
    expect(merged.facts.tables.get('weddings')!.columns.get('start_date')!.pattern).toBeNull()
  })
})

describe('validateSeedInsert — rule 5: regex CHECK (pattern-violation)', () => {
  function mergedFacts() {
    return mergeLiveConstraints(buildSchemaFacts(FIXTURE_MIGRATIONS), [
      {
        table: 'meta_ads_connections',
        column: 'token_env_key',
        name: 'meta_ads_connections_token_env_key_shape',
        definition: DEF_REGEX_NULLABLE,
      },
    ]).facts
  }

  it('passes a value that matches the pattern', () => {
    const inserts = parseSeedInserts(
      'fixture.sql',
      `INSERT INTO meta_ads_connections (id, venue_id, token_env_key, status)
       SELECT 'c1', 'v1', 'META_ADS_VENUE_HAWTHORNE_MANOR', 'connected'
       WHERE NOT EXISTS (SELECT 1 FROM meta_ads_connections WHERE id = 'c1');`,
    )
    expect(validateSeedInsert(inserts[0]!, mergedFacts())).toHaveLength(0)
  })

  it('fails a value that does not match, naming the constraint and the pattern', () => {
    const inserts = parseSeedInserts(
      'fixture.sql',
      `INSERT INTO meta_ads_connections (id, venue_id, token_env_key, status)
       SELECT 'c1', 'v1', 'META_ADS_ACCESS_TOKEN', 'connected'
       WHERE NOT EXISTS (SELECT 1 FROM meta_ads_connections WHERE id = 'c1');`,
    )
    const findings = validateSeedInsert(inserts[0]!, mergedFacts())
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      kind: 'pattern-violation',
      column: 'token_env_key',
      value: 'META_ADS_ACCESS_TOKEN',
      constraint: 'meta_ads_connections_token_env_key_shape',
      pattern: '^(META_ADS|TIKTOK_ADS|INSTAGRAM)_VENUE_[A-Z0-9_]+$',
    })
    expect(findings[0]!.message).toContain('meta_ads_connections_token_env_key_shape')
    expect(findings[0]!.message).toContain("~ '^(META_ADS|TIKTOK_ADS|INSTAGRAM)_VENUE_[A-Z0-9_]+$'")
    expect(findings[0]!.message).toContain('23514')
  })

  it('passes a literal NULL (CHECK passes on NULL)', () => {
    const inserts = parseSeedInserts(
      'fixture.sql',
      `INSERT INTO meta_ads_connections (id, venue_id, token_env_key, status) VALUES ('c1', 'v1', NULL, 'connected');`,
    )
    expect(validateSeedInsert(inserts[0]!, mergedFacts())).toHaveLength(0)
  })

  it('also enforces a pattern the migration text itself declares, without any live merge', () => {
    const facts = buildSchemaFacts([
      ...FIXTURE_MIGRATIONS,
      {
        name: '002_code_extension.sql',
        sql: `ALTER TABLE weddings ADD CONSTRAINT weddings_code_extension_shape
                CHECK (code_extension IS NULL OR code_extension ~ '^[A-Z]$');`,
      },
    ])
    const bad = parseSeedInserts('fixture.sql', `INSERT INTO weddings (id, code_extension) VALUES ('w1', 'ab');`)
    const good = parseSeedInserts('fixture.sql', `INSERT INTO weddings (id, code_extension) VALUES ('w1', 'B');`)
    expect(validateSeedInsert(bad[0]!, facts).map((f) => f.kind)).toEqual(['pattern-violation'])
    expect(validateSeedInsert(good[0]!, facts)).toHaveLength(0)
  })
})
