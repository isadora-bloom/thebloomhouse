import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, forbidden } from '@/lib/api/auth-helpers'

/**
 * GET /api/venue-groups/tree
 *
 * Tier-C #133. Returns the org's venue-group hierarchy as a tree, with
 * venues attached to their direct group. Used by the multi-venue
 * portfolio dashboard so a coordinator can drill from
 * Region → District → Venue without an extra round-trip per node.
 *
 * Authority: org_admin or super_admin. Coordinators / managers see
 * structure read-only via the same endpoint (gated by their org_id).
 *
 * Shape:
 *   {
 *     orgId: string,
 *     roots: TreeNode[],
 *     unassignedVenues: { id, name }[],   // venues not in any group
 *   }
 *
 * Where TreeNode = {
 *   id, name, group_kind, description,
 *   children: TreeNode[],
 *   venues: { id, name }[],
 * }
 */

interface VenueLite {
  id: string
  name: string
}

interface TreeNode {
  id: string
  name: string
  group_kind: string
  description: string | null
  children: TreeNode[]
  venues: VenueLite[]
}

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    return NextResponse.json({ orgId: null, roots: [], unassignedVenues: [], demo: true })
  }

  const supabase = createServiceClient()

  // Resolve the user's org. Service role bypasses RLS, so explicit scope
  // check happens here.
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('org_id, role')
    .eq('id', auth.userId)
    .maybeSingle()
  const orgId = (profile as { org_id?: string } | null)?.org_id
  if (!orgId) return forbidden('user has no org assignment')

  const [groupsRes, venuesRes, membersRes] = await Promise.all([
    supabase
      .from('venue_groups')
      .select('id, name, description, parent_group_id, group_kind')
      .eq('org_id', orgId),
    supabase.from('venues').select('id, name').eq('org_id', orgId),
    supabase.from('venue_group_members').select('group_id, venue_id'),
  ])

  if (groupsRes.error) return NextResponse.json({ error: groupsRes.error.message }, { status: 500 })
  if (venuesRes.error) return NextResponse.json({ error: venuesRes.error.message }, { status: 500 })
  if (membersRes.error) return NextResponse.json({ error: membersRes.error.message }, { status: 500 })

  const groups = (groupsRes.data ?? []) as Array<{
    id: string
    name: string
    description: string | null
    parent_group_id: string | null
    group_kind: string
  }>
  const venues = (venuesRes.data ?? []) as VenueLite[]
  const members = (membersRes.data ?? []) as Array<{ group_id: string; venue_id: string }>

  // Filter members to org-scoped venues + groups so a stale row in another
  // org's slice can't leak in via the membership join.
  const orgGroupIds = new Set(groups.map((g) => g.id))
  const orgVenueIds = new Set(venues.map((v) => v.id))
  const scopedMembers = members.filter(
    (m) => orgGroupIds.has(m.group_id) && orgVenueIds.has(m.venue_id),
  )

  // Build venue-by-group index.
  const venueById = new Map(venues.map((v) => [v.id, v]))
  const venuesByGroup = new Map<string, VenueLite[]>()
  for (const m of scopedMembers) {
    const v = venueById.get(m.venue_id)
    if (!v) continue
    const arr = venuesByGroup.get(m.group_id) ?? []
    arr.push(v)
    venuesByGroup.set(m.group_id, arr)
  }
  const groupedVenueIds = new Set(scopedMembers.map((m) => m.venue_id))
  const unassignedVenues = venues.filter((v) => !groupedVenueIds.has(v.id))

  // Build tree.
  const nodeById = new Map<string, TreeNode>()
  for (const g of groups) {
    nodeById.set(g.id, {
      id: g.id,
      name: g.name,
      group_kind: g.group_kind,
      description: g.description,
      children: [],
      venues: venuesByGroup.get(g.id) ?? [],
    })
  }
  const roots: TreeNode[] = []
  for (const g of groups) {
    const node = nodeById.get(g.id)!
    if (g.parent_group_id && nodeById.has(g.parent_group_id)) {
      nodeById.get(g.parent_group_id)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // Stable order: alphabetical by name at each level.
  const sortRecursive = (n: TreeNode) => {
    n.children.sort((a, b) => a.name.localeCompare(b.name))
    n.children.forEach(sortRecursive)
    n.venues.sort((a, b) => a.name.localeCompare(b.name))
  }
  roots.sort((a, b) => a.name.localeCompare(b.name))
  roots.forEach(sortRecursive)
  unassignedVenues.sort((a, b) => a.name.localeCompare(b.name))

  return NextResponse.json({ orgId, roots, unassignedVenues })
}
