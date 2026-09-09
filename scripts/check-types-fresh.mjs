#!/usr/bin/env node
/**
 * Informational check: types.generated.ts freshness.
 *
 * Validates that the auto-generated Supabase types file was regenerated
 * more recently than the most recent migration. If a migration has been
 * added since types were last generated, this warns (but does not fail CI).
 *
 * Exit code: 0 (fresh), 1 (stale) — both are non-fatal (continue-on-error in CI).
 *
 * Regenerate via:
 *   npx supabase gen types typescript --linked > src/lib/supabase/types.generated.ts
 *
 * This requires SUPABASE_ACCESS_TOKEN for the --linked schema introspection.
 * In CI, this step is optional and skipped if the Supabase CLI is unavailable.
 */

import { statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]):\//, '$1:/')
const TYPES_GENERATED_PATH = join(REPO_ROOT, 'src', 'lib', 'supabase', 'types.generated.ts')
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations')

try {
  const typesStat = statSync(TYPES_GENERATED_PATH)
  const migrationsFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  if (migrationsFiles.length === 0) {
    console.log('[types-fresh] No migrations found; types are fresh.')
    process.exit(0)
  }

  const newestMigration = migrationsFiles[migrationsFiles.length - 1]
  const newestMigrationPath = join(MIGRATIONS_DIR, newestMigration)
  const migrationStat = statSync(newestMigrationPath)

  if (typesStat.mtime >= migrationStat.mtime) {
    console.log('[types-fresh] OK — types.generated.ts is current.')
    console.log(`  Generated: ${typesStat.mtime.toISOString()}`)
    console.log(`  Newest migration (${newestMigration}): ${migrationStat.mtime.toISOString()}`)
    process.exit(0)
  }

  console.warn(
    '\n[types-fresh] ⚠ types.generated.ts is stale\n'
    + `  Types generated: ${typesStat.mtime.toISOString()}\n`
    + `  Newest migration (${newestMigration}): ${migrationStat.mtime.toISOString()}\n`
    + '\nRegenerate with:\n'
    + '  npx supabase gen types typescript --linked > src/lib/supabase/types.generated.ts\n'
    + '(Requires SUPABASE_ACCESS_TOKEN in env.)\n',
  )
  process.exit(1)
} catch (err) {
  console.warn(`[types-fresh] Could not check freshness: ${err.message}\n`)
  process.exit(1)
}
