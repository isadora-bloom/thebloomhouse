import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// Helper: period filter
// ---------------------------------------------------------------------------

function periodCutoff(period: string | null): string | null {
  if (!period || period === 'all') return null
  const days = period === '90d' ? 90 : 30
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

// ---------------------------------------------------------------------------
// GET — List social posts or summary
//   ?platform=instagram|facebook|tiktok|pinterest|youtube
//   ?period=30d|90d|all
//   ?summary=true → per-platform aggregation
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const summary = searchParams.get('summary') === 'true'
    const platform = searchParams.get('platform')
    const period = searchParams.get('period')
    const cutoff = periodCutoff(period)

    const supabase = createServiceClient()

    if (summary) {
      let q = supabase
        .from('social_posts')
        .select('platform, reach, impressions, engagement_rate, is_viral')
        .eq('venue_id', auth.venueId)

      if (cutoff) q = q.gte('posted_at', cutoff)
      if (platform) q = q.eq('platform', platform)

      const { data: posts, error } = await q
      if (error) return serverError(error)

      const rows = posts ?? []
      const platforms = ['instagram', 'facebook', 'tiktok', 'pinterest', 'youtube'] as const
      const result: Record<string, {
        posts: number
        total_reach: number
        total_impressions: number
        avg_engagement_rate: number
        viral_count: number
      }> = {}

      for (const p of platforms) {
        const subset = rows.filter(r => r.platform === p)
        if (subset.length === 0) continue
        result[p] = {
          posts: subset.length,
          total_reach: subset.reduce((s, r) => s + (Number(r.reach) || 0), 0),
          total_impressions: subset.reduce((s, r) => s + (Number(r.impressions) || 0), 0),
          avg_engagement_rate: subset.length > 0
            ? Math.round(
                (subset.reduce((s, r) => s + (Number(r.engagement_rate) || 0), 0) / subset.length) * 100
              ) / 100
            : 0,
          viral_count: subset.filter(r => r.is_viral).length,
        }
      }

      return NextResponse.json({ summary: result })
    }

    // List posts
    let q = supabase
      .from('social_posts')
      .select('*')
      .eq('venue_id', auth.venueId)
      .order('posted_at', { ascending: false })

    if (platform) q = q.eq('platform', platform)
    if (cutoff) q = q.gte('posted_at', cutoff)

    const { data: posts, error } = await q
    if (error) return serverError(error)

    return NextResponse.json({ posts: posts ?? [] })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// POST — Create a social post record
//   Body: { platform, posted_at, caption, post_url, reach, impressions,
//           saves, shares, comments, likes, website_clicks, profile_visits,
//           engagement_rate, is_viral }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const {
      platform, posted_at, caption, post_url,
      reach, impressions, saves, shares, comments, likes,
      website_clicks, profile_visits, engagement_rate, is_viral,
    } = body

    if (!platform) return badRequest('platform is required')

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('social_posts')
      .insert({
        venue_id: auth.venueId,
        platform,
        posted_at: posted_at ?? new Date().toISOString(),
        caption: caption ?? null,
        post_url: post_url ?? null,
        reach: reach ?? 0,
        impressions: impressions ?? 0,
        saves: saves ?? 0,
        shares: shares ?? 0,
        comments: comments ?? 0,
        likes: likes ?? 0,
        website_clicks: website_clicks ?? 0,
        profile_visits: profile_visits ?? 0,
        engagement_rate: engagement_rate ?? null,
        is_viral: is_viral ?? false,
      })
      .select()
      .single()

    if (error) return serverError(error)
    return NextResponse.json({ post: data }, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// PATCH — Update a social post
//   Body: { id, ...fields }
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { id, ...fields } = body

    if (!id) return badRequest('id is required')

    const allowed = [
      'platform', 'posted_at', 'caption', 'post_url',
      'reach', 'impressions', 'saves', 'shares', 'comments', 'likes',
      'website_clicks', 'profile_visits', 'engagement_rate', 'is_viral',
    ]
    const update: Record<string, unknown> = {}
    for (const key of allowed) {
      if (fields[key] !== undefined) update[key] = fields[key]
    }

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('social_posts')
      .update(update)
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .select()
      .single()

    if (error) return serverError(error)
    return NextResponse.json({ post: data })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// DELETE — Delete a social post by id (query param)
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return badRequest('id query param is required')

    const supabase = createServiceClient()
    const { error } = await supabase
      .from('social_posts')
      .delete()
      .eq('id', id)
      .eq('venue_id', auth.venueId)

    if (error) return serverError(error)
    return NextResponse.json({ success: true })
  } catch (err) {
    return serverError(err)
  }
}
