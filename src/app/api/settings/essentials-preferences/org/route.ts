/**
 * /api/settings/essentials-preferences/org (T5-followup-Z).
 *
 * Org-level Essentials slider default. Read by anyone in the org;
 * written by coordinator-and-above (no role-management exists yet, so
 * we gate to the platform-auth role list at the API layer).
 *
 * GET   — current org default + caller's org id
 * PUT   — set / replace the org default
 * DELETE — clear the org default (revert to platform default)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { ESSENTIALS_LEVELS, type EssentialsLevel } from '@/lib/hooks/use-essentials-level'

interface OrgPrefsRow {
  id: string
  org_id: string
  default_level: EssentialsLevel
  updated_by: string | null
  created_at: string
  updated_at: string
}

const ROLES_THAT_CAN_WRITE = new Set(['coordinator', 'manager', 'org_admin', 'super_admin'])

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!auth.orgId) {
    return NextResponse.json({ org_id: null, default_level: null })
  }
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('org_essentials_preferences')
    .select('*')
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({
    org_id: auth.orgId,
    default_level: (data as OrgPrefsRow | null)?.default_level ?? null,
    updated_by: (data as OrgPrefsRow | null)?.updated_by ?? null,
    updated_at: (data as OrgPrefsRow | null)?.updated_at ?? null,
  })
}

export async function PUT(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!auth.orgId) {
    return NextResponse.json({ error: 'no_org' }, { status: 400 })
  }
  if (!ROLES_THAT_CAN_WRITE.has(auth.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { default_level?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const lvl = body.default_level
  if (!lvl || !ESSENTIALS_LEVELS.includes(lvl as EssentialsLevel)) {
    return NextResponse.json({ error: 'invalid_default_level' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('org_essentials_preferences')
    .upsert(
      {
        org_id: auth.orgId,
        default_level: lvl,
        updated_by: auth.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'org_id' },
    )
    .select('*')
    .single()
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'update_failed' }, { status: 500 })
  }
  return NextResponse.json(data)
}

export async function DELETE() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!auth.orgId) {
    return NextResponse.json({ error: 'no_org' }, { status: 400 })
  }
  if (!ROLES_THAT_CAN_WRITE.has(auth.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('org_essentials_preferences')
    .delete()
    .eq('org_id', auth.orgId)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
