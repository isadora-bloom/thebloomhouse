import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// POST /api/agent/dedupe-interactions
//
// Cleans up the triplicate interactions produced when a venue has multiple
// linked Gmail connections and an inbound email was addressed to more than
// one of them. Each connection stored the message with its own gmail_id,
// so the normal "already processed" check passed and we inserted it N
// times — once per account that received a copy.
//
// Dedup key: (venue_id, from_email, subject, timestamp rounded to 60s).
// We keep the oldest row (lowest interactions.id timestamp) and delete the
// rest. Drafts and engagement_events attached to the survivors stay put;
// drafts attached to doomed rows are re-pointed at the survivor, then
// doomed rows are deleted. Interactions that already share a fingerprint
// with no draft attached are simply deleted.
//
// Idempotent — run it as many times as you like. Returns counts.
// ---------------------------------------------------------------------------

export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const venueId = auth.venueId
  if (!venueId) return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })

  const supabase = createServiceClient()

  const { data: rows, error } = await supabase
    .from('interactions')
    .select('id, from_email, subject, timestamp, gmail_message_id, created_at')
    .eq('venue_id', venueId)
    .eq('type', 'email')
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Bucket by (from_email|subject|minute). Keep the first, delete the rest.
  const buckets = new Map<string, string[]>()
  for (const r of (rows ?? []) as Array<{
    id: string
    from_email: string | null
    subject: string | null
    timestamp: string | null
  }>) {
    if (!r.from_email || !r.timestamp) continue
    const minute = new Date(r.timestamp).toISOString().slice(0, 16) // YYYY-MM-DDTHH:mm
    const key = `${r.from_email.toLowerCase()}|${(r.subject ?? '').trim()}|${minute}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(r.id)
  }

  const toDelete: string[] = []
  const survivors: string[] = []
  for (const ids of buckets.values()) {
    if (ids.length <= 1) {
      survivors.push(ids[0])
      continue
    }
    survivors.push(ids[0])
    toDelete.push(...ids.slice(1))
  }

  let repointedDrafts = 0
  let deletedInteractions = 0

  if (toDelete.length > 0) {
    // Re-point any drafts from doomed interactions onto the corresponding
    // survivor in the same bucket. Do this bucket by bucket so the mapping
    // stays sane even when a bucket has many duplicates.
    for (const ids of buckets.values()) {
      if (ids.length <= 1) continue
      const keeper = ids[0]
      const dead = ids.slice(1)
      const { data: updated } = await supabase
        .from('drafts')
        .update({ interaction_id: keeper })
        .in('interaction_id', dead)
        .select('id')
      repointedDrafts += updated?.length ?? 0
    }

    // Engagement events may also reference interaction_id — null them out
    // for deleted rows so FK doesn't block the delete. We don't bother
    // re-pointing analytics events to a survivor; the signal is preserved
    // via wedding/person links, and the duplicates were noise anyway.
    await supabase
      .from('engagement_events')
      .delete()
      .in('interaction_id', toDelete)

    // Delete in chunks of 500 to stay well under Postgres parameter caps.
    for (let i = 0; i < toDelete.length; i += 500) {
      const slice = toDelete.slice(i, i + 500)
      const { data: deleted, error: delErr } = await supabase
        .from('interactions')
        .delete()
        .in('id', slice)
        .select('id')
      if (delErr) {
        return NextResponse.json(
          {
            error: delErr.message,
            partial: { deletedInteractions, repointedDrafts, toDelete: toDelete.length },
          },
          { status: 500 }
        )
      }
      deletedInteractions += deleted?.length ?? 0
    }
  }

  return NextResponse.json({
    venueId,
    scanned: rows?.length ?? 0,
    buckets: buckets.size,
    duplicatesFound: toDelete.length,
    deletedInteractions,
    repointedDrafts,
    survivors: survivors.length,
  })
}
