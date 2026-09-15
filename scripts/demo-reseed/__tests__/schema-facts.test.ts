/**
 * Unit tests for the schema-facts static reader (W72).
 *
 * Fixture SQL only — these never touch the real `supabase/migrations/`
 * tree, so a change to the actual migration set cannot make this suite
 * flaky. `plan.test.ts` covers the real tree separately, via
 * `validatePlan`.
 *
 * Every fixture below is modelled on a real shape from this repo's
 * migrations (see the file references in each test), not invented, so a
 * pass here is evidence the reader handles what the repo actually does.
 */

import { describe, it, expect } from 'vitest'
import {
  buildSchemaFacts,
  extractBalanced,
  parseCheckExpr,
  splitStatements,
  sortMigrationFiles,
  stripLineComments,
  topLevelSplit,
  type MigrationFile,
} from '../schema-facts'

function facts(files: MigrationFile[]) {
  return buildSchemaFacts(files)
}

describe('stripLineComments', () => {
  it('drops a trailing comment but keeps the code before it', () => {
    expect(stripLineComments("id uuid, -- primary key\nname text")).toContain('name text')
    expect(stripLineComments('id uuid, -- primary key\nname text')).not.toContain('primary key')
  })

  it('does not treat -- inside a string literal as a comment', () => {
    const sql = "caption text DEFAULT 'see note -- not a comment'"
    expect(stripLineComments(sql)).toContain('see note -- not a comment')
  })
})

describe('splitStatements', () => {
  it('splits on semicolons outside quotes', () => {
    expect(splitStatements('A; B; C')).toHaveLength(3)
  })

  it('does not split on a semicolon inside a string literal', () => {
    const stmts = splitStatements("INSERT INTO x (a) VALUES ('one; two');")
    expect(stmts).toHaveLength(1)
  })
})

describe('topLevelSplit', () => {
  it('does not split inside parens', () => {
    expect(topLevelSplit("a IN ('x', 'y'), b text")).toEqual(["a IN ('x', 'y')", 'b text'])
  })
})

describe('extractBalanced', () => {
  it('finds the matching close paren through nested parens', () => {
    const text = "CHECK (a IN ('x', 'y'))"
    const open = text.indexOf('(')
    const bal = extractBalanced(text, open)
    expect(bal?.inner).toBe("a IN ('x', 'y')")
  })
})

describe('parseCheckExpr', () => {
  it('parses a plain IN-list CHECK', () => {
    expect(parseCheckExpr("trigger_type IN ('post_tour', 'ghosted')")).toEqual({
      column: 'trigger_type',
      values: ['post_tour', 'ghosted'],
      pattern: null,
      patternCaseInsensitive: false,
    })
  })

  it('parses the nullable "col IS NULL OR col IN (...)" shape', () => {
    expect(parseCheckExpr("explanation_source IS NULL\n  OR explanation_source IN ('ai', 'template', 'rule')")).toEqual({
      column: 'explanation_source',
      values: ['ai', 'template', 'rule'],
      pattern: null,
      patternCaseInsensitive: false,
    })
  })

  it('returns null for a CHECK that is neither an IN-list nor a regex', () => {
    expect(parseCheckExpr('end_date > start_date')).toBeNull()
  })

  // W75: the regex shapes migrations 124 and 140 write in plain text.
  it('parses "col ~ \'regex\'"', () => {
    expect(parseCheckExpr("geo_scope ~ '^[a-z]+(?:_[a-z0-9]+){0,2}$'")).toEqual({
      column: 'geo_scope',
      values: null,
      pattern: '^[a-z]+(?:_[a-z0-9]+){0,2}$',
      patternCaseInsensitive: false,
    })
  })

  it('parses the nullable "col IS NULL OR col ~ \'regex\'" shape', () => {
    expect(parseCheckExpr("code_extension IS NULL OR code_extension ~ '^[A-Z]$'")).toEqual({
      column: 'code_extension',
      values: null,
      pattern: '^[A-Z]$',
      patternCaseInsensitive: false,
    })
  })

  it('flags "~*" as case-insensitive', () => {
    expect(parseCheckExpr("slug ~* '^[a-z-]+$'")?.patternCaseInsensitive).toBe(true)
  })
})

describe('buildSchemaFacts — regex CHECK (W75)', () => {
  it('records the pattern and constraint name, and DROP CONSTRAINT clears only that fact', () => {
    const f = facts([
      {
        name: '001.sql',
        sql: `
          CREATE TABLE weddings (
            id uuid PRIMARY KEY,
            status text CHECK (status IN ('lead', 'booked')),
            code_extension text
          );
          ALTER TABLE weddings ADD CONSTRAINT weddings_code_extension_shape
            CHECK (code_extension IS NULL OR code_extension ~ '^[A-Z]$');
        `,
      },
    ])
    const col = f.tables.get('weddings')!.columns.get('code_extension')!
    expect(col.pattern).toBe('^[A-Z]$')
    expect(col.patternConstraint).toBe('weddings_code_extension_shape')
    expect(col.allowedValues).toBeNull()
    expect(f.allowedValues('weddings', 'status')).toEqual(['lead', 'booked'])

    const dropped = facts([
      {
        name: '001.sql',
        sql: `
          CREATE TABLE weddings (id uuid PRIMARY KEY, code_extension text);
          ALTER TABLE weddings ADD CONSTRAINT weddings_code_extension_shape
            CHECK (code_extension ~ '^[A-Z]$');
          ALTER TABLE weddings ADD CONSTRAINT weddings_code_extension_check
            CHECK (code_extension IN ('A', 'B'));
          ALTER TABLE weddings DROP CONSTRAINT weddings_code_extension_shape;
        `,
      },
    ])
    const after = dropped.tables.get('weddings')!.columns.get('code_extension')!
    expect(after.pattern).toBeNull()
    expect(after.patternConstraint).toBeNull()
    expect(after.allowedValues).toEqual(['A', 'B'])
  })
})

describe('buildSchemaFacts — CREATE TABLE', () => {
  it('declares every column, with or without a CHECK', () => {
    const f = facts([
      {
        name: '001_x.sql',
        sql: `
          CREATE TABLE IF NOT EXISTS follow_up_sequences (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
            trigger_type text NOT NULL CHECK (trigger_type IN ('post_tour', 'ghosted', 'custom')),
            is_active boolean DEFAULT true
          );
        `,
      },
    ])
    expect(f.tableExists('follow_up_sequences')).toBe(true)
    expect(f.columnDeclared('follow_up_sequences', 'venue_id')).toBe(true)
    expect(f.columnDeclared('follow_up_sequences', 'is_active')).toBe(true)
    expect(f.allowedValues('follow_up_sequences', 'is_active')).toBeNull()
    expect(f.allowedValues('follow_up_sequences', 'trigger_type')).toEqual([
      'post_tour',
      'ghosted',
      'custom',
    ])
    expect(f.columnDeclared('follow_up_sequences', 'nope')).toBe(false)
  })

  it('treats an undeclared table as not existing', () => {
    const f = facts([])
    expect(f.tableExists('anything')).toBe(false)
    expect(f.columnDeclared('anything', 'id')).toBe(false)
    expect(f.allowedValues('anything', 'id')).toBeNull()
  })
})

describe('buildSchemaFacts — ADD COLUMN with an inline CHECK', () => {
  // Modelled on migration 073 (venue_availability.status).
  it('picks up the CHECK on a later ALTER TABLE ADD COLUMN', () => {
    const f = facts([
      { name: '001_x.sql', sql: 'CREATE TABLE IF NOT EXISTS t (id uuid PRIMARY KEY);' },
      {
        name: '002_x.sql',
        sql: `
          ALTER TABLE public.t
            ADD COLUMN IF NOT EXISTS status text
              CHECK (status IN ('available', 'booked', 'hold'));
        `,
      },
    ])
    expect(f.columnDeclared('t', 'status')).toBe(true)
    expect(f.allowedValues('t', 'status')).toEqual(['available', 'booked', 'hold'])
  })
})

describe('buildSchemaFacts — the DO-block guarded ADD CONSTRAINT shape', () => {
  // Modelled on migration 243 (brand_assets.category): the ALTER TABLE
  // sits inside `DO $$ BEGIN IF NOT EXISTS (...) THEN ... END IF; END
  // $$;`, guarded by a `pg_constraint` existence check rather than an
  // `IF NOT EXISTS` on the column.
  it('finds the CHECK even though it is wrapped in a DO block guard', () => {
    const f = facts([
      {
        name: '001_x.sql',
        sql: 'CREATE TABLE IF NOT EXISTS brand_assets (id uuid PRIMARY KEY, category text);',
      },
      {
        name: '002_x.sql',
        sql: `
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname = 'brand_assets_category_check'
            ) THEN
              ALTER TABLE public.brand_assets
                ADD CONSTRAINT brand_assets_category_check
                CHECK (category IS NULL OR category IN (
                  'ceremony', 'tent', 'reception', 'detail',
                  'aerial', 'venue_exterior', 'staff', 'other'
                ));
            END IF;
          END $$;
        `,
      },
    ])
    expect(f.allowedValues('brand_assets', 'category')).toEqual([
      'ceremony',
      'tent',
      'reception',
      'detail',
      'aerial',
      'venue_exterior',
      'staff',
      'other',
    ])
  })
})

describe('buildSchemaFacts — DROP CONSTRAINT then a wider re-ADD', () => {
  // Modelled on migrations 297 + 318 (follow_up_sequences.trigger_type):
  // a later migration drops the old CHECK by its repo-convention name
  // and adds a wider one under the same name. The LATEST set must win.
  it('replaces the allowed set rather than keeping the first one found', () => {
    const f = facts([
      {
        name: '025_x.sql',
        sql: `
          CREATE TABLE IF NOT EXISTS follow_up_sequences (
            id uuid PRIMARY KEY,
            trigger_type text NOT NULL CHECK (trigger_type IN ('post_tour', 'ghosted'))
          );
        `,
      },
      {
        name: '297_x.sql',
        sql: `
          ALTER TABLE follow_up_sequences DROP CONSTRAINT IF EXISTS follow_up_sequences_trigger_type_check;
          ALTER TABLE follow_up_sequences
            ADD CONSTRAINT follow_up_sequences_trigger_type_check
            CHECK (trigger_type IN ('post_tour', 'ghosted', 'post_booking', 'pre_event', 'custom'));
        `,
      },
    ])
    expect(f.allowedValues('follow_up_sequences', 'trigger_type')).toEqual([
      'post_tour',
      'ghosted',
      'post_booking',
      'pre_event',
      'custom',
    ])
  })

  it('a DROP CONSTRAINT with nothing re-added leaves the column unconstrained', () => {
    const f = facts([
      {
        name: '001_x.sql',
        sql: `
          CREATE TABLE IF NOT EXISTS t (
            id uuid PRIMARY KEY,
            kind text CHECK (kind IN ('a', 'b'))
          );
        `,
      },
      { name: '002_x.sql', sql: 'ALTER TABLE t DROP CONSTRAINT IF EXISTS t_kind_check;' },
    ])
    expect(f.columnDeclared('t', 'kind')).toBe(true)
    expect(f.allowedValues('t', 'kind')).toBeNull()
  })
})

describe('buildSchemaFacts — RENAME TO', () => {
  // Modelled on migration 040: follow_up_sequence_templates renamed to
  // _archived_follow_up_sequence_templates. This is the W72 root cause —
  // a generator that only checks "was this CREATE TABLE'd somewhere"
  // would still think the old name is live.
  it('marks the old name gone and the new name live', () => {
    const f = facts([
      {
        name: '009_x.sql',
        sql: `
          CREATE TABLE IF NOT EXISTS follow_up_sequence_templates (
            id uuid PRIMARY KEY,
            venue_id uuid NOT NULL
          );
        `,
      },
      {
        name: '040_x.sql',
        sql: 'ALTER TABLE follow_up_sequence_templates RENAME TO _archived_follow_up_sequence_templates;',
      },
    ])
    expect(f.tableExists('follow_up_sequence_templates')).toBe(false)
    expect(f.tableExists('_archived_follow_up_sequence_templates')).toBe(true)
    // The renamed table keeps its columns under the new name.
    expect(f.columnDeclared('_archived_follow_up_sequence_templates', 'venue_id')).toBe(true)
  })

  it('does not confuse an ALTER INDEX rename for a table rename', () => {
    const f = facts([
      { name: '001_x.sql', sql: 'CREATE TABLE IF NOT EXISTS t (id uuid PRIMARY KEY);' },
      {
        name: '002_x.sql',
        sql: 'ALTER INDEX public.idx_old RENAME TO idx_new;',
      },
    ])
    expect(f.tableExists('t')).toBe(true)
    expect(f.tableExists('idx_old')).toBe(false)
    expect(f.tableExists('idx_new')).toBe(false)
  })
})

describe('buildSchemaFacts — DROP TABLE', () => {
  it('marks a dropped table as not existing, CASCADE or not', () => {
    const f = facts([
      {
        name: '001_x.sql',
        sql: `
          CREATE TABLE IF NOT EXISTS a (id uuid PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS b (id uuid PRIMARY KEY);
        `,
      },
      {
        name: '002_x.sql',
        sql: `
          DROP TABLE public.a;
          DROP TABLE IF EXISTS public.b CASCADE;
        `,
      },
    ])
    expect(f.tableExists('a')).toBe(false)
    expect(f.tableExists('b')).toBe(false)
  })
})

describe('sortMigrationFiles', () => {
  it('sorts numerically, not lexically', () => {
    expect(sortMigrationFiles(['100_x.sql', '9_y.sql', '25_z.sql'])).toEqual([
      '9_y.sql',
      '25_z.sql',
      '100_x.sql',
    ])
  })
})

// ---------------------------------------------------------------------------
// Provenance (schema-drift, 2026-09-15): which migration introduced what,
// and the two shapes that made production look drifted when it was not.
// ---------------------------------------------------------------------------

describe('provenance: createdIn / declaredIn', () => {
  it('stamps the creating migration on the table and every inline column', () => {
    const f = facts([
      { name: '010_a.sql', sql: 'CREATE TABLE public.t (id uuid PRIMARY KEY, name text);' },
      { name: '020_b.sql', sql: 'ALTER TABLE public.t ADD COLUMN IF NOT EXISTS extra text;' },
    ])
    const t = f.tables.get('t')!
    expect(t.createdIn).toBe('010_a.sql')
    expect(t.columns.get('id')!.declaredIn).toBe('010_a.sql')
    expect(t.columns.get('extra')!.declaredIn).toBe('020_b.sql')
  })

  it('a table renamed away and the renamed-to table are both attributed', () => {
    const f = facts([
      { name: '010_a.sql', sql: 'CREATE TABLE public.old_name (id uuid);' },
      { name: '040_b.sql', sql: 'ALTER TABLE public.old_name RENAME TO new_name;' },
    ])
    expect(f.tableExists('old_name')).toBe(false)
    expect(f.tables.get('new_name')!.createdIn).toBe('040_b.sql')
    expect(f.tables.get('new_name')!.columns.get('id')!.declaredIn).toBe('010_a.sql')
  })
})

describe('RENAME COLUMN (085, 121, 122)', () => {
  it('moves the column fact under the new name and forgets the old one', () => {
    // 085_identity_resolution.sql: client_a_id -> person_a_id
    const f = facts([
      { name: '009_a.sql', sql: 'CREATE TABLE public.client_match_queue (id uuid, client_a_id uuid NOT NULL);' },
      { name: '085_b.sql', sql: 'ALTER TABLE public.client_match_queue RENAME COLUMN client_a_id TO person_a_id;' },
    ])
    expect(f.columnDeclared('client_match_queue', 'client_a_id')).toBe(false)
    expect(f.columnDeclared('client_match_queue', 'person_a_id')).toBe(true)
    expect(f.columnRequired('client_match_queue', 'person_a_id')).toBe(true)
    expect(f.tables.get('client_match_queue')!.columns.get('person_a_id')!.declaredIn).toBe('085_b.sql')
  })

  it('sees the rename inside a guarded DO block (122_audio_capture_abstraction)', () => {
    const f = facts([
      { name: '082_a.sql', sql: 'CREATE TABLE public.tours (id uuid, omi_session_id text);' },
      {
        name: '122_b.sql',
        sql: [
          'DO $$',
          'BEGIN',
          "  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tours' AND column_name = 'omi_session_id') THEN",
          '    ALTER TABLE public.tours RENAME COLUMN omi_session_id TO session_id;',
          '  END IF;',
          'END $$;',
        ].join('\n'),
      },
    ])
    expect(f.columnDeclared('tours', 'omi_session_id')).toBe(false)
    expect(f.columnDeclared('tours', 'session_id')).toBe(true)
  })
})

describe('a column known only through a CHECK constraint name is not declared', () => {
  it('215_pricing_v2: user_profiles_plan_tier_check inside a guarded DO block declares nothing', () => {
    const f = facts([
      { name: '001_a.sql', sql: 'CREATE TABLE public.user_profiles (id uuid);' },
      {
        name: '215_b.sql',
        sql: [
          'DO $$ BEGIN',
          "  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'user_profiles' AND column_name = 'plan_tier') THEN",
          "    EXECUTE $sql$ALTER TABLE user_profiles ADD CONSTRAINT user_profiles_plan_tier_check CHECK (plan_tier IN ('solo', 'growth'))$sql$;",
          '  END IF;',
          'END $$;',
        ].join('\n'),
      },
    ])
    expect(f.columnDeclared('user_profiles', 'plan_tier')).toBe(false)
    // The CHECK is still remembered, so a seed that does write the column is checked.
    expect(f.allowedValues('user_profiles', 'plan_tier')).toEqual(['solo', 'growth'])
  })

  it('059_sage_identity: a length CHECK named <table>_<expr>_check does not mint a column', () => {
    const f = facts([
      { name: '001_a.sql', sql: 'CREATE TABLE public.venue_ai_config (id uuid, ai_purposes text[]);' },
      {
        name: '059_b.sql',
        sql: 'ALTER TABLE public.venue_ai_config ADD CONSTRAINT venue_ai_config_ai_purposes_length_check CHECK (array_length(ai_purposes, 1) <= 6);',
      },
    ])
    expect(f.columnDeclared('venue_ai_config', 'ai_purposes_length')).toBe(false)
    expect(f.columnDeclared('venue_ai_config', 'ai_purposes')).toBe(true)
  })
})
