/**
 * The role vocabulary, in one place.
 *
 * `user_profiles.role` is CHECK-constrained (migration 001, widened by
 * 049 and 051) to exactly the six strings in USER_ROLES. Until
 * 2026-09-15 the server-side gate in getPlatformAuth admitted 'manager',
 * a value no row can carry, and not 'venue_manager', the one the invite
 * flow, the seed and the billing routes all use. A venue manager signed
 * in fine, because the middleware knew the real name, then got 401 from
 * every API route and a bounce to /login from every page. The §31
 * Playwright journey on the e2e project found it (trial-status 401 after
 * a manager login). Fifteen other server-side lists carried the same
 * phantom; they now all read from here, and
 * scripts/check-role-vocab.mjs refuses a new one.
 *
 * Edge-safe: constants and pure functions only, so middleware.ts and
 * client components can import it.
 */

/** Every value user_profiles.role may hold. Mirrors migration 051. */
export const USER_ROLES = [
  'super_admin',
  'org_admin',
  'venue_manager',
  'coordinator',
  'readonly',
  'couple',
] as const
export type UserRole = (typeof USER_ROLES)[number]

/**
 * Roles getPlatformAuth admits and the middleware lets onto platform
 * pages.
 *
 * `readonly` is a real DB value and an option on the team invite form,
 * but it is not admitted here. 372 API routes call getPlatformAuth and
 * only 7 add requireRole on top, so admitting it would let a read-only
 * invitee write through the other 365. Until there is a central write
 * guard, a readonly profile is turned away at /login exactly as before
 * this module existed. Flagged for a decision, not decided here.
 */
export const PLATFORM_ROLES = [
  'super_admin',
  'org_admin',
  'venue_manager',
  'coordinator',
] as const
export type PlatformRole = (typeof PLATFORM_ROLES)[number]

export function isPlatformRole(role: unknown): role is PlatformRole {
  return typeof role === 'string' && (PLATFORM_ROLES as readonly string[]).includes(role)
}

/** Roles allowed to change org- or venue-wide configuration. */
export const ADMIN_ROLES = ['org_admin', 'super_admin'] as const

/** Admin roles plus the venue-level manager, for billing and venue settings. */
export const MANAGER_ROLES = ['org_admin', 'super_admin', 'venue_manager'] as const

/**
 * Seniority ladder for the roles a team invitation can carry. Higher
 * number = more authority. Used to stop an org_admin minting an
 * invitation for a role above their own. Unknown roles rank -1, below
 * everything, so an invite for one is refused.
 */
export const ROLE_RANK: Readonly<Record<string, number>> = {
  readonly: 0,
  coordinator: 1,
  venue_manager: 2,
  org_admin: 3,
  super_admin: 4,
}

export function roleRank(role: string | null | undefined): number {
  return ROLE_RANK[role ?? ''] ?? -1
}

/**
 * consumer_requests.requester_role (migration 231) has its own CHECK:
 * couple, coordinator, manager, org_admin, super_admin. That column
 * predates the rename and its 'manager' means the venue manager. Map at
 * the boundary here; nothing else compares auth.role against 'manager'.
 */
export type ConsumerRequesterRole = 'coordinator' | 'manager' | 'org_admin' | 'super_admin'

export function consumerRequesterRole(role: string): ConsumerRequesterRole {
  switch (role) {
    case 'venue_manager':
      return 'manager'
    case 'org_admin':
      return 'org_admin'
    case 'super_admin':
      return 'super_admin'
    default:
      return 'coordinator'
  }
}
