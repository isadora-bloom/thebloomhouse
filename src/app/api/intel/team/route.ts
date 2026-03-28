import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// Helper: period filter date
// ---------------------------------------------------------------------------

function periodCutoff(period: string | null): string | null {
  if (!period || period === 'all') return null
  const days = period === '90d' ? 90 : 30
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

// ---------------------------------------------------------------------------
// GET — Team performance metrics
//   ?period=30d|90d|all
//   ?compare=id1,id2  → side-by-side comparison
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const period = searchParams.get('period')
    const compare = searchParams.get('compare')
    const cutoff = periodCutoff(period)

    const supabase = createServiceClient()

    // Fetch team members (coordinators and managers)
    const { data: members, error: membersErr } = await supabase
      .from('user_profiles')
      .select('id, first_name, last_name, role')
      .eq('venue_id', auth.venueId)
      .in('role', ['coordinator', 'manager', 'venue_manager', 'org_admin'])

    if (membersErr) return serverError(membersErr)
    if (!members || members.length === 0) {
      return NextResponse.json({ team: [] })
    }

    const memberIds = members.map(m => m.id)

    // If compare mode, filter to only those two
    let targetIds = memberIds
    if (compare) {
      const compareIds = compare.split(',').map(s => s.trim())
      if (compareIds.length !== 2) return badRequest('compare requires exactly two comma-separated IDs')
      targetIds = compareIds
    }

    // Fetch drafts by approver
    let draftsQ = supabase
      .from('drafts')
      .select('id, status, approved_by, created_at')
      .eq('venue_id', auth.venueId)
      .in('status', ['approved', 'rejected'])
      .in('approved_by', targetIds)

    if (cutoff) draftsQ = draftsQ.gte('created_at', cutoff)

    // Fetch tours conducted by team members
    let toursQ = supabase
      .from('tours')
      .select('id, conducted_by, outcome, wedding_id')
      .eq('venue_id', auth.venueId)
      .in('conducted_by', targetIds)

    if (cutoff) toursQ = toursQ.gte('created_at', cutoff)

    // Fetch active weddings per consultant
    const weddingsQ = supabase
      .from('weddings')
      .select('id, assigned_consultant_id, status')
      .eq('venue_id', auth.venueId)
      .in('assigned_consultant_id', targetIds)
      .not('status', 'in', '("completed","lost","cancelled")')

    // Fetch interactions for response time
    let interactionsQ = supabase
      .from('interactions')
      .select('wedding_id, direction, timestamp')
      .eq('venue_id', auth.venueId)
      .order('timestamp', { ascending: true })

    if (cutoff) interactionsQ = interactionsQ.gte('timestamp', cutoff)

    // Fetch drafts for response time (all, not just those approved by targetIds)
    let responseDraftsQ = supabase
      .from('drafts')
      .select('wedding_id, created_at, approved_by')
      .eq('venue_id', auth.venueId)
      .in('approved_by', targetIds)
      .order('created_at', { ascending: true })

    if (cutoff) responseDraftsQ = responseDraftsQ.gte('created_at', cutoff)

    const [draftsRes, toursRes, weddingsRes, interactionsRes, responseDraftsRes] = await Promise.all([
      draftsQ, toursQ, weddingsQ, interactionsQ, responseDraftsQ,
    ])

    const allDrafts = draftsRes.data ?? []
    const allTours = toursRes.data ?? []
    const allWeddings = weddingsRes.data ?? []
    const allInteractions = interactionsRes.data ?? []
    const allResponseDrafts = responseDraftsRes.data ?? []

    // Build first inbound timestamp per wedding
    const firstInbound: Record<string, string> = {}
    for (const i of allInteractions) {
      if (i.direction === 'inbound' && i.wedding_id && !firstInbound[i.wedding_id]) {
        firstInbound[i.wedding_id] = i.timestamp
      }
    }

    // Compute per-member metrics
    const team = members
      .filter(m => targetIds.includes(m.id))
      .map(m => {
        const memberDrafts = allDrafts.filter(d => d.approved_by === m.id)
        const memberTours = allTours.filter(t => t.conducted_by === m.id)
        const memberWeddings = allWeddings.filter(w => w.assigned_consultant_id === m.id)
        const memberResponseDrafts = allResponseDrafts.filter(d => d.approved_by === m.id)

        // Response times
        const responseTimes: number[] = []
        for (const d of memberResponseDrafts) {
          if (d.wedding_id && firstInbound[d.wedding_id]) {
            const diffMs = new Date(d.created_at).getTime() - new Date(firstInbound[d.wedding_id]).getTime()
            if (diffMs > 0) {
              responseTimes.push(diffMs / 60000)
            }
          }
        }

        // Tours that led to booked weddings
        const completedTourWeddingIds = memberTours
          .filter(t => t.outcome === 'completed' && t.wedding_id)
          .map(t => t.wedding_id)
        const toursConverted = allWeddings.filter(
          w => completedTourWeddingIds.includes(w.id) && ['booked', 'completed'].includes(w.status)
        ).length

        return {
          id: m.id,
          name: [m.first_name, m.last_name].filter(Boolean).join(' '),
          role: m.role,
          drafts_approved: memberDrafts.filter(d => d.status === 'approved').length,
          drafts_rejected: memberDrafts.filter(d => d.status === 'rejected').length,
          tours_conducted: memberTours.length,
          tours_converted: toursConverted,
          avg_response_time: responseTimes.length > 0
            ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
            : null,
          active_weddings: memberWeddings.length,
        }
      })

    if (compare) {
      return NextResponse.json({ comparison: team })
    }

    return NextResponse.json({ team })
  } catch (err) {
    return serverError(err)
  }
}
