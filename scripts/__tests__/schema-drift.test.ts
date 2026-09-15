/**
 * schema-drift (2026-09-15): the live database compared with what the
 * migrations declare, grouped by the migration to apply. Fixture facts
 * and a fixture "live" map only; the network reader is not exercised.
 */
import { describe, it, expect } from 'vitest'
import { buildSchemaFacts } from '../demo-reseed/schema-facts'
import { computeDrift } from '../schema-drift'

const FACTS = buildSchemaFacts([
  { name: '010_base.sql', sql: 'CREATE TABLE public.venues (id uuid PRIMARY KEY, name text);' },
  { name: '304_agencies.sql', sql: 'CREATE TABLE public.marketing_agencies (id uuid PRIMARY KEY, venue_id uuid);' },
  { name: '305_link.sql', sql: 'ALTER TABLE public.marketing_agencies ADD COLUMN IF NOT EXISTS notes text;' },
  { name: '386_flag.sql', sql: 'ALTER TABLE public.venues ADD COLUMN IF NOT EXISTS worked_here_before boolean;' },
  { name: '400_gone.sql', sql: 'DROP TABLE IF EXISTS public.retired;' },
])

const live = (m: Record<string, string[]>) => new Map(Object.entries(m).map(([t, c]) => [t, new Set(c)] as const))

describe('computeDrift', () => {
  it('reports nothing when every declared table and column is live', () => {
    const r = computeDrift(
      FACTS,
      live({ venues: ['id', 'name', 'worked_here_before'], marketing_agencies: ['id', 'venue_id', 'notes'] }),
      'p',
    )
    expect(r.missingTables).toEqual([])
    expect(r.missingColumns).toEqual([])
    expect(r.migrationsToApply).toEqual([])
  })

  it('a missing table pulls in its CREATE and every later ADD COLUMN, in numeric order', () => {
    const r = computeDrift(FACTS, live({ venues: ['id', 'name', 'worked_here_before'] }), 'p')
    expect(r.missingTables).toEqual([{ table: 'marketing_agencies', migration: '304_agencies.sql' }])
    expect(r.migrationsToApply).toEqual(['304_agencies.sql', '305_link.sql'])
  })

  it('a missing column names the migration that declared it', () => {
    const r = computeDrift(FACTS, live({ venues: ['id', 'name'], marketing_agencies: ['id', 'venue_id', 'notes'] }), 'p')
    expect(r.missingColumns).toEqual([{ table: 'venues', column: 'worked_here_before', migration: '386_flag.sql' }])
    expect(r.migrationsToApply).toEqual(['386_flag.sql'])
  })

  it('live relations no migration creates are listed, not counted as drift', () => {
    const r = computeDrift(
      FACTS,
      live({ venues: ['id', 'name', 'worked_here_before'], marketing_agencies: ['id', 'venue_id', 'notes'], wedding_heat: ['id'] }),
      'p',
    )
    expect(r.migrationsToApply).toEqual([])
    expect(r.unexplained).toEqual(['wedding_heat'])
  })
})
