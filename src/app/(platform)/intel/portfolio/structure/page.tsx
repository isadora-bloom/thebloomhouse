'use client'

/**
 * Multi-venue hierarchy dashboard. Tier-C #134.
 *
 * Reads the org's venue-group tree from /api/venue-groups/tree and
 * renders Region → District → Venue with venue counts at each node.
 * Drill-through to /intel/portfolio for venue-level dashboards uses
 * the existing scope cookie.
 *
 * Today this is a structure-only view — counts of venues per node and
 * the unassigned-venue list. Per-node revenue / inquiries / bookings
 * rollups land in a follow-up since they need the same query the
 * portfolio page already runs (and that's a substantial port).
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Layers, Building2, ChevronRight, AlertCircle, Loader2, ArrowLeft } from 'lucide-react'

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

interface TreeResponse {
  orgId: string | null
  roots: TreeNode[]
  unassignedVenues: VenueLite[]
  demo?: boolean
}

function totalVenuesUnder(node: TreeNode): number {
  return node.venues.length + node.children.reduce((s, c) => s + totalVenuesUnder(c), 0)
}

function NodeCard({ node, depth }: { node: TreeNode; depth: number }) {
  const total = totalVenuesUnder(node)
  return (
    <div
      className="bg-surface border border-border rounded-xl p-5 space-y-3"
      style={{ marginLeft: depth * 16 }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-sage-800 flex items-center gap-2">
            <Layers className="w-4 h-4 text-teal-600" />
            {node.name}
            <span className="text-xs uppercase tracking-wider text-sage-500 bg-sage-50 px-2 py-0.5 rounded">
              {node.group_kind}
            </span>
          </h3>
          {node.description && (
            <p className="text-sm text-sage-500 mt-1">{node.description}</p>
          )}
        </div>
        <div className="text-right">
          <p className="text-sage-800 font-semibold">{total}</p>
          <p className="text-xs text-sage-400">venues total</p>
        </div>
      </div>

      {node.venues.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-3 border-t border-border">
          {node.venues.map((v) => (
            <Link
              key={v.id}
              href={`/intel/portfolio?venue=${v.id}`}
              className="px-3 py-1 text-xs rounded-full bg-warm-white text-sage-700 border border-border hover:bg-sage-50 transition-colors flex items-center gap-1.5"
            >
              <Building2 className="w-3 h-3" />
              {v.name}
            </Link>
          ))}
        </div>
      )}

      {node.children.length > 0 && (
        <div className="space-y-3 pt-3">
          {node.children.map((c) => (
            <NodeCard key={c.id} node={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function PortfolioStructurePage() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [data, setData] = useState<TreeResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/venue-groups/tree')
        if (!res.ok) throw new Error(`Tree API returned ${res.status}`)
        const json = (await res.json()) as TreeResponse
        if (!cancelled) setData(json)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="w-6 h-6 animate-spin text-sage-400" />
      </div>
    )
  }

  if (err) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-rose-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-rose-700">
            Could not load portfolio structure: {err}
          </div>
        </div>
      </div>
    )
  }

  const tree = data!
  const empty = tree.roots.length === 0 && tree.unassignedVenues.length === 0

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            href="/intel/portfolio"
            className="p-2 rounded-lg hover:bg-sage-50 text-sage-500 hover:text-sage-800"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-serif text-sage-900">Portfolio structure</h1>
            <p className="text-sm text-sage-500 mt-0.5">
              Region, District, and Venue hierarchy. Click any venue to drill into its dashboard.
            </p>
          </div>
        </div>
        <Link
          href="/settings/groups"
          className="px-4 py-2 text-sm bg-sage-600 text-white rounded-lg hover:bg-sage-700"
        >
          Manage groups
        </Link>
      </div>

      {tree.demo && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
          Demo mode shows an empty structure. Sign in with a real account to see your venue hierarchy.
        </div>
      )}

      {empty && !tree.demo && (
        <div className="p-10 bg-surface border border-border rounded-xl text-center">
          <Layers className="w-10 h-10 text-sage-300 mx-auto mb-3" />
          <h3 className="text-sage-800 font-medium mb-1">No structure yet</h3>
          <p className="text-sm text-sage-500 mb-4">
            Create your first group at /settings/groups. Use group level (region / district / cluster) to nest the hierarchy.
          </p>
          <Link
            href="/settings/groups"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-sage-600 text-white rounded-lg hover:bg-sage-700"
          >
            Manage groups
            <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      )}

      {tree.roots.map((root) => (
        <NodeCard key={root.id} node={root} depth={0} />
      ))}

      {tree.unassignedVenues.length > 0 && (
        <div className="bg-surface border border-dashed border-border rounded-xl p-5 space-y-3">
          <h3 className="text-base font-semibold text-sage-800">Unassigned venues</h3>
          <p className="text-sm text-sage-500">
            {tree.unassignedVenues.length} venue{tree.unassignedVenues.length === 1 ? '' : 's'} not in any group. Add to a group at /settings/groups.
          </p>
          <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
            {tree.unassignedVenues.map((v) => (
              <Link
                key={v.id}
                href={`/intel/portfolio?venue=${v.id}`}
                className="px-3 py-1 text-xs rounded-full bg-warm-white text-sage-700 border border-border hover:bg-sage-50 flex items-center gap-1.5"
              >
                <Building2 className="w-3 h-3" />
                {v.name}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
