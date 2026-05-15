/**
 * /api/admin/data-fields
 *
 * The surface + create-field loop for un-homed imported data.
 *
 * GET  — returns, for the caller's venue:
 *          tracked[]   the fields the operator has already promoted
 *                      (tracked_data_fields), each with a sample value
 *          unmapped[]  raw-jsonb keys NOT yet tracked, each with an
 *                      LLM-suggested label / type and sample values
 * POST — promote one unmapped key into a tracked_data_fields row
 *          (the operator pressed "Track this field").
 *
 * Anchor: the silent-field-drop sweep. Imports preserve every column
 * in a raw jsonb (migrations 351 / 352 / 353); this endpoint makes
 * those columns visible and lets the operator give them a home.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { labelUnmappedFields, type UnmappedKeyInput } from '@/lib/services/data-fields/labeler'

// entity_type → { table, jsonb column }. The jsonb column is the raw
// catchall an importer preserves un-homed columns into.
const ENTITY_SOURCES: Record<string, { table: string; column: string }> = {
  wedding: { table: 'weddings', column: 'raw_import_row' },
  review: { table: 'reviews', column: 'raw_import_row' },
  marketing_spend: { table: 'marketing_spend', column: 'raw_import_row' },
  knowledge_base: { table: 'knowledge_base', column: 'raw_import_row' },
  wedding_details: { table: 'wedding_details', column: 'extra_fields' },
  wedding_tables: { table: 'wedding_tables', column: 'extra_fields' },
}

const VALID_TYPES = new Set(['text', 'number', 'money', 'date', 'boolean'])

interface TrackedRow {
  id: string
  entity_type: string
  source_key: string
  label: string
  data_type: string
  llm_suggestion: string | null
  created_at: string
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const venueId = auth.venueId
  if (!venueId) {
    return NextResponse.json({ error: 'no venue in scope' }, { status: 400 })
  }
  const supabase = createServiceClient()

  // Already-tracked fields.
  const { data: trackedData } = await supabase
    .from('tracked_data_fields')
    .select('id, entity_type, source_key, label, data_type, llm_suggestion, created_at')
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
  const tracked = (trackedData ?? []) as TrackedRow[]
  const trackedSet = new Set(tracked.map((t) => `${t.entity_type}::${t.source_key}`))

  // Scan each entity's raw jsonb for distinct keys + sample values.
  const unmappedByEntity: Array<{
    entity_type: string
    key: string
    samples: string[]
  }> = []

  for (const [entityType, src] of Object.entries(ENTITY_SOURCES)) {
    const { data: rows } = await supabase
      .from(src.table)
      .select(src.column)
      .eq('venue_id', venueId)
      .not(src.column, 'is', null)
      .limit(300)
    const keySamples = new Map<string, Set<string>>()
    for (const r of ((rows ?? []) as unknown[]) as Array<Record<string, unknown>>) {
      const blob = r[src.column]
      if (!blob || typeof blob !== 'object') continue
      for (const [k, v] of Object.entries(blob as Record<string, unknown>)) {
        if (v == null || v === '') continue
        const set = keySamples.get(k) ?? new Set<string>()
        if (set.size < 5) set.add(String(v).slice(0, 80))
        keySamples.set(k, set)
      }
    }
    for (const [key, samples] of keySamples) {
      if (trackedSet.has(`${entityType}::${key}`)) continue
      unmappedByEntity.push({
        entity_type: entityType,
        key,
        samples: Array.from(samples),
      })
    }
  }

  // LLM-label the unmapped keys. Dedupe the labeler call by key (the
  // same column name across entities gets one label).
  const distinctKeys = new Map<string, UnmappedKeyInput>()
  for (const u of unmappedByEntity) {
    if (!distinctKeys.has(u.key)) {
      distinctKeys.set(u.key, { key: u.key, samples: u.samples })
    }
  }
  const suggestions = await labelUnmappedFields(
    venueId,
    Array.from(distinctKeys.values()),
  )
  const suggestionByKey = new Map(suggestions.map((s) => [s.key, s]))

  const unmapped = unmappedByEntity.map((u) => {
    const s = suggestionByKey.get(u.key)
    return {
      entity_type: u.entity_type,
      source_key: u.key,
      samples: u.samples,
      suggested_label: s?.suggested_label ?? u.key,
      suggested_type: s?.suggested_type ?? 'text',
      what_it_looks_like: s?.what_it_looks_like ?? '',
    }
  })

  // Attach one sample value to each tracked field for display.
  return NextResponse.json({ tracked, unmapped })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const venueId = auth.venueId
  if (!venueId) {
    return NextResponse.json({ error: 'no venue in scope' }, { status: 400 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    entity_type?: string
    source_key?: string
    label?: string
    data_type?: string
    llm_suggestion?: string
  }
  if (!body.entity_type || !ENTITY_SOURCES[body.entity_type]) {
    return NextResponse.json({ error: 'invalid entity_type' }, { status: 400 })
  }
  if (!body.source_key || !body.source_key.trim()) {
    return NextResponse.json({ error: 'source_key required' }, { status: 400 })
  }
  if (!body.label || !body.label.trim()) {
    return NextResponse.json({ error: 'label required' }, { status: 400 })
  }
  const dataType =
    body.data_type && VALID_TYPES.has(body.data_type) ? body.data_type : 'text'

  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('tracked_data_fields')
    .upsert(
      {
        venue_id: venueId,
        entity_type: body.entity_type,
        source_key: body.source_key.trim(),
        label: body.label.trim().slice(0, 80),
        data_type: dataType,
        llm_suggestion: body.llm_suggestion?.slice(0, 240) ?? null,
        created_by: auth.userId ?? null,
      },
      { onConflict: 'venue_id,entity_type,source_key', ignoreDuplicates: false },
    )
    .select('id')
    .single()
  if (error) {
    return NextResponse.json(
      { error: 'create_failed', detail: error.message },
      { status: 500 },
    )
  }
  return NextResponse.json({ ok: true, id: (data as { id: string }).id })
}
