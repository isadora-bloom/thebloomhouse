import { describe, it, expect } from 'vitest'
import {
  refuseDemo,
  requireRole,
  roleRank,
  isDemoVenueAllowed,
  ADMIN_ROLES,
  MANAGER_ROLES,
} from '../auth-helpers'

type Auth = Parameters<typeof requireRole>[0]

function auth(over: Partial<Auth> = {}): Auth {
  return {
    userId: 'u1',
    venueId: 'v1',
    orgId: 'o1',
    role: 'coordinator',
    isDemo: false,
    ...over,
  } as Auth
}

describe('refuseDemo', () => {
  it('returns null for a real session', () => {
    expect(refuseDemo(auth())).toBeNull()
  })

  it('returns null for no session at all, so dual-auth routes can call it unconditionally', () => {
    expect(refuseDemo(null)).toBeNull()
    expect(refuseDemo(undefined)).toBeNull()
  })

  it('403s a demo session', async () => {
    const res = refuseDemo(auth({ isDemo: true }))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    await expect(res!.json()).resolves.toEqual({ error: 'Forbidden: the demo is read-only' })
  })
})

describe('requireRole', () => {
  it('lets an allowed role through', () => {
    expect(requireRole(auth({ role: 'org_admin' }), ADMIN_ROLES)).toBeNull()
    expect(requireRole(auth({ role: 'super_admin' }), ADMIN_ROLES)).toBeNull()
    expect(requireRole(auth({ role: 'venue_manager' }), MANAGER_ROLES)).toBeNull()
  })

  it('403s a role outside the list', () => {
    const res = requireRole(auth({ role: 'coordinator' }), ADMIN_ROLES)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('403s a demo session whatever the list says', () => {
    // The demo coordinator has no business in an admin gate even if the
    // gate happens to allow coordinators.
    const res = requireRole(auth({ isDemo: true, role: 'coordinator' }), ['coordinator'])
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })

  it('403s the role string nobody actually carries', () => {
    // 'admin' was tested for in four routes and has never existed.
    expect(roleRank('admin')).toBe(-1)
    const res = requireRole(auth({ role: 'admin' }), ADMIN_ROLES)
    expect(res!.status).toBe(403)
  })
})

describe('roleRank', () => {
  it('orders the real vocabulary', () => {
    expect(roleRank('super_admin')).toBeGreaterThan(roleRank('org_admin'))
    expect(roleRank('org_admin')).toBeGreaterThan(roleRank('venue_manager'))
    expect(roleRank('venue_manager')).toBeGreaterThan(roleRank('coordinator'))
    expect(roleRank('coordinator')).toBeGreaterThan(roleRank('readonly'))
    // 'manager' has never been a user_profiles.role value; it was a
    // phantom in this ladder until 2026-09-15 and now ranks with the
    // unknowns.
    expect(roleRank('manager')).toBe(-1)
  })

  it('ranks an unknown role below everything, so an invite for it is refused', () => {
    expect(roleRank('wedding_planner')).toBe(-1)
    expect(roleRank(null)).toBe(-1)
    expect(roleRank(undefined)).toBe(-1)
    // The invite rule is `roleRank(requested) > roleRank(caller)`, so an
    // unknown caller role cannot mint anything real.
    expect(roleRank('coordinator') > roleRank('mystery')).toBe(true)
  })
})

describe('isDemoVenueAllowed', () => {
  it('accepts the four Crestwood venues and nothing else', () => {
    expect(isDemoVenueAllowed('22222222-2222-2222-2222-222222222201')).toBe(true)
    expect(isDemoVenueAllowed('22222222-2222-2222-2222-222222222204')).toBe(true)
    expect(isDemoVenueAllowed('22222222-2222-2222-2222-222222222205')).toBe(false)
    expect(isDemoVenueAllowed('')).toBe(false)
    expect(isDemoVenueAllowed(null)).toBe(false)
  })
})
