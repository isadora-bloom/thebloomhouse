import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  COUPLE_RESOURCES,
  COUPLE_RESOURCE_KEYS,
  coupleActivity,
  pickFields,
} from '../couple-resources'

// ---------------------------------------------------------------------------
// The schema, read the same way the generator writes it
// ---------------------------------------------------------------------------

const types = readFileSync(
  resolve(process.cwd(), 'src/lib/supabase/types.generated.ts'),
  'utf8',
)

/** Columns on a table's Row type, or null when the table does not exist. */
function columnsOf(table: string): string[] | null {
  const at = types.indexOf(`      ${table}: {`)
  if (at === -1) return null
  const rowStart = types.indexOf('Row: {', at)
  const rowEnd = types.indexOf('        }', rowStart)
  if (rowStart === -1 || rowEnd === -1) return null
  return [...types.slice(rowStart, rowEnd).matchAll(/^\s+([a-z0-9_]+):/gm)]
    .map((m) => m[1])
    .filter((c) => c !== 'Row')
}

// ---------------------------------------------------------------------------
// The config has to describe the real database
//
// A wrong name column is the failure worth guarding: it does not throw, it just
// makes every feed entry read "added an item" for ever.
// ---------------------------------------------------------------------------

describe('every configured resource matches the schema', () => {
  it('names a table that exists', () => {
    for (const [key, r] of Object.entries(COUPLE_RESOURCES)) {
      expect(columnsOf(r.table), `${key} → ${r.table} is not a table`).not.toBeNull()
    }
  })

  it('every table is scoped, and says so when it lacks a venue_id', () => {
    for (const [key, r] of Object.entries(COUPLE_RESOURCES)) {
      const cols = columnsOf(r.table)!
      // wedding_id is not optional. Without it there is nothing tying the row
      // to the caller, and an id on its own is not proof of ownership.
      expect(cols, `${key} → ${r.table} has no wedding_id`).toContain('wedding_id')
      if (r.scope === 'wedding') {
        expect(cols, `${key} is marked wedding-only but ${r.table} does have a venue_id`).not.toContain('venue_id')
      } else {
        expect(cols, `${key} → ${r.table} has no venue_id, so it needs scope: 'wedding'`).toContain('venue_id')
      }
    }
  })

  it('every cascade names a real table and a real column on it', () => {
    for (const [key, r] of Object.entries(COUPLE_RESOURCES)) {
      for (const c of r.cascades ?? []) {
        const cols = columnsOf(c.table)
        expect(cols, `${key} cascades to ${c.table}, which is not a table`).not.toBeNull()
        expect(cols!, `${key} cascades on ${c.table}.${c.column}, which does not exist`).toContain(c.column)
      }
    }
  })

  it('a singleton names the unique index it upserts against', () => {
    // Upserting against the wrong target inserts a second row instead of
    // updating the first, and the page then reads whichever comes back first.
    for (const [key, r] of Object.entries(COUPLE_RESOURCES)) {
      if (!r.singleton) continue
      const target = r.conflictTarget ?? 'wedding_id'
      const cols = columnsOf(r.table)!
      for (const part of target.split(',')) {
        expect(cols, `${key} upserts on ${part}, which is not a column of ${r.table}`).toContain(part.trim())
      }
    }
  })

  it('only a singleton carries a conflict target', () => {
    for (const [key, r] of Object.entries(COUPLE_RESOURCES)) {
      if (r.conflictTarget) {
        expect(r.singleton, `${key} sets conflictTarget but is not a singleton, so nothing reads it`).toBe(true)
      }
    }
  })

  it('every writable field is a real column', () => {
    for (const [key, r] of Object.entries(COUPLE_RESOURCES)) {
      const cols = columnsOf(r.table)!
      for (const f of r.fields) {
        expect(cols, `${key}: ${r.table}.${f} does not exist`).toContain(f)
      }
    }
  })

  it('every name column is a real column', () => {
    for (const [key, r] of Object.entries(COUPLE_RESOURCES)) {
      if (!r.nameColumn) continue
      const cols = columnsOf(r.table)!
      expect(cols, `${key}: ${r.table}.${r.nameColumn} does not exist, so every entry would say "${r.noun}"`).toContain(r.nameColumn)
    }
  })

  it('no resource lets a couple set its own scope or primary key', () => {
    for (const [key, r] of Object.entries(COUPLE_RESOURCES)) {
      for (const forbidden of ['id', 'venue_id', 'wedding_id', 'created_at']) {
        expect(r.fields, `${key} must not accept ${forbidden} from the client`).not.toContain(forbidden)
      }
    }
  })

  it('every resource key is url-safe, since it is a path segment', () => {
    for (const key of COUPLE_RESOURCE_KEYS) {
      expect(key, `${key} is not a clean path segment`).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })

  it('a table is configured once, so two keys cannot disagree about it', () => {
    const seen = new Map<string, string>()
    for (const [key, r] of Object.entries(COUPLE_RESOURCES)) {
      const prior = seen.get(r.table)
      expect(prior, `${r.table} is configured as both ${prior} and ${key}`).toBeUndefined()
      seen.set(r.table, key)
    }
  })
})

// ---------------------------------------------------------------------------
// The feed entries
// ---------------------------------------------------------------------------

describe('coupleActivity', () => {
  it('names the thing when it can', () => {
    const e = coupleActivity(COUPLE_RESOURCES.party, 'added', { name: 'Rebecka Graves' })
    expect(e).toEqual({ activityType: 'wedding_party_added', details: 'added Rebecka Graves' })
  })

  it('reads as removed, not deleted', () => {
    const e = coupleActivity(COUPLE_RESOURCES.decor, 'removed', { item_name: 'Lanterns' })
    expect(e.details).toBe('removed Lanterns')
  })

  it('falls back to the noun rather than a bare id', () => {
    const e = coupleActivity(COUPLE_RESOURCES.shuttle, 'added', { id: 'c0ffee' })
    expect(e.details).toBe('added a shuttle run')
    expect(e.details).not.toContain('c0ffee')
  })

  it('treats a blank or whitespace name as no name', () => {
    expect(coupleActivity(COUPLE_RESOURCES.decor, 'added', { item_name: '   ' }).details).toBe('added a decor item')
    expect(coupleActivity(COUPLE_RESOURCES.decor, 'added', null).details).toBe('added a decor item')
  })

  it('a whole-form save reads as one update however it was reached', () => {
    for (const action of ['added', 'updated'] as const) {
      const e = coupleActivity(COUPLE_RESOURCES.website, action, {})
      expect(e.activityType).toBe('website_updated')
      expect(e.details).toBe('updated their wedding website')
    }
  })

  it('a high-volume table takes constant wording, so the feed can fold it', () => {
    const a = coupleActivity(COUPLE_RESOURCES.guests, 'updated', { first_name: 'Ada' })
    const b = coupleActivity(COUPLE_RESOURCES.guests, 'updated', { first_name: 'Grace' })
    expect(a).toEqual(b)
    // A name or a count here would stop two edits folding into one entry.
    expect(a.details).not.toMatch(/Ada|Grace|\d/)
  })

  it('adding, editing and removing stay distinguishable', () => {
    const seen = new Set<string>()
    for (const action of ['added', 'updated', 'removed'] as const) {
      const { details } = coupleActivity(COUPLE_RESOURCES.guests, action)
      expect(seen.has(details), `${action} reads the same as another action`).toBe(false)
      seen.add(details)
    }
  })
})

// ---------------------------------------------------------------------------
// The field filter
// ---------------------------------------------------------------------------

describe('pickFields', () => {
  it('keeps what is allowed and reports the rest', () => {
    const { fields, refused } = pickFields(COUPLE_RESOURCES.decor, {
      item_name: 'Lanterns',
      quantity: 12,
      venue_id: 'someone-elses-venue',
      nonsense: true,
    })
    expect(fields).toEqual({ item_name: 'Lanterns', quantity: 12 })
    expect(refused.sort()).toEqual(['nonsense', 'venue_id'])
  })

  it('drops id silently, because clients legitimately round-trip it', () => {
    const { fields, refused } = pickFields(COUPLE_RESOURCES.decor, { id: 'abc', item_name: 'x' })
    expect(fields).toEqual({ item_name: 'x' })
    expect(refused).toEqual([])
  })

  it('a client cannot reassign a row to another wedding', () => {
    const { fields } = pickFields(COUPLE_RESOURCES.party, {
      name: 'Someone',
      wedding_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(fields).not.toHaveProperty('wedding_id')
  })

  it('an empty or missing body is not a crash', () => {
    expect(pickFields(COUPLE_RESOURCES.decor, {}).fields).toEqual({})
    expect(pickFields(COUPLE_RESOURCES.decor, undefined as never).fields).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Upsert targets
//
// Postgres will not accept a PARTIAL unique index as an ON CONFLICT target: it
// answers 42P10 and the save fails. Two resources were configured as singletons
// before this test existed, and both would have failed every save.
// staffing_assignments is unique on (wedding_id) only WHERE role =
// '_calculator', and onboarding_progress only WHERE step IS NULL. Production had
// five onboarding rows for one wedding and three worksheet rows for another,
// which is what gave it away.
//
// Checked with plain string work over each statement rather than one large
// regex, because three of this session's wrong answers came from a regex that
// looked right and matched nothing.
// ---------------------------------------------------------------------------

/** Every statement in the migrations, semicolon-separated, whitespace squashed. */
function statements(): string[] {
  const dir = resolve(process.cwd(), 'supabase/migrations')
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(resolve(dir, f), 'utf8'))
    .join('\n')
  return sql
    .split(';')
    // `UNIQUE(a, b)` and `UNIQUE (a, b)` are the same thing and both appear in
    // the migrations, so the space and the comma spacing are normalised once
    // here rather than at each check.
    .map((st) =>
      st
        .replace(/--[^\n]*/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/unique\s*\(/gi, 'unique (')
        .replace(/\s*,\s*/g, ', ')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean)
}

describe('a singleton upserts against a constraint that actually exists', () => {
  const sts = statements()

  it('has a matching unique constraint, and it is not partial', () => {
    for (const [key, r] of Object.entries(COUPLE_RESOURCES)) {
      if (!r.singleton) continue
      const target = (r.conflictTarget ?? 'wedding_id').split(',').map((c) => c.trim())
      const cols = '(' + target.join(', ') + ')'
      const table = r.table.toLowerCase()

      const unique = sts.filter(
        (st) =>
          st.includes('create unique index') &&
          (st.includes(' on ' + table + ' ') || st.includes(' on public.' + table + ' ')) &&
          st.replace(/\s*,\s*/g, ', ').includes(cols),
      )
      // The statement has to be the one that creates THIS table. Merely
      // mentioning it is not enough: `UNIQUE (venue_id, wedding_id)` appears in
      // a dozen other CREATE TABLEs, so a looser check passes everything.
      const createsThis = (st: string) =>
        st.includes('create table ' + table + ' (') ||
        st.includes('create table if not exists ' + table + ' (') ||
        st.includes('create table public.' + table + ' (') ||
        st.includes('create table if not exists public.' + table + ' (')

      const inline = sts.some((st) => createsThis(st) && st.includes('unique ' + cols))
      // `wedding_id uuid NOT NULL UNIQUE REFERENCES ...` — a UNIQUE on the
      // column itself rather than a table constraint.
      const singleColumnUnique =
        target.length === 1 &&
        sts.some(
          (st) =>
            createsThis(st) &&
            new RegExp(target[0] + '\\s+\\w+[^,]*unique').test(st),
        )

      expect(
        unique.length > 0 || inline || singleColumnUnique,
        key + ' upserts on ' + cols + ' but nothing in the migrations makes that unique on ' + r.table + '. Postgres answers 42P10.',
      ).toBe(true)

      for (const st of unique) {
        expect(
          st.includes(' where '),
          key + ': the unique index on ' + r.table + ' ' + cols + ' is partial, so it cannot be an upsert target.',
        ).toBe(false)
      }
    }
  })
})
