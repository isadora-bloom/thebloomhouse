import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  USER_ROLES,
  PLATFORM_ROLES,
  ADMIN_ROLES,
  MANAGER_ROLES,
  ROLE_RANK,
  isPlatformRole,
  consumerRequesterRole,
} from '../roles'

/**
 * The vocabulary is derived from the migrations, not remembered. If a
 * migration widens or renames a role this test fails until roles.ts is
 * brought level, which is the point: the 2026-09-15 lockout happened
 * because a hand-typed list drifted from the CHECK for months.
 */
const MIGRATIONS = join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations')

function checkValues(file: string, column: string): string[] {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
  const re = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i')
  const m = sql.match(re)
  if (!m) throw new Error(`${file}: no CHECK (${column} IN (...)) found`)
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
}

describe('role vocabulary matches the database', () => {
  it('USER_ROLES is exactly the user_profiles.role CHECK from migration 051', () => {
    const fromSql = checkValues('051_schema_fixes.sql', 'role')
    expect([...USER_ROLES].sort()).toEqual([...fromSql].sort())
  })

  it('every admitted or ranked role is a real one', () => {
    const real = new Set<string>(USER_ROLES)
    for (const r of [...PLATFORM_ROLES, ...ADMIN_ROLES, ...MANAGER_ROLES, ...Object.keys(ROLE_RANK)]) {
      expect(real.has(r), `'${r}' is not a user_profiles.role value`).toBe(true)
    }
  })

  it('the venue manager is admitted and the phantom is not', () => {
    expect(isPlatformRole('venue_manager')).toBe(true)
    expect(isPlatformRole('manager')).toBe(false)
    expect(isPlatformRole('couple')).toBe(false)
    expect(isPlatformRole(null)).toBe(false)
  })

  it('consumerRequesterRole only emits values consumer_requests accepts', () => {
    const allowed = new Set(checkValues('231_consumer_requests.sql', 'requester_role'))
    for (const r of USER_ROLES) {
      expect(allowed.has(consumerRequesterRole(r)), `mapping for '${r}'`).toBe(true)
    }
    expect(consumerRequesterRole('venue_manager')).toBe('manager')
    expect(consumerRequesterRole('readonly')).toBe('coordinator')
  })
})
