/**
 * Persona-overlay smoke test. Finds an attribution_events row whose
 * wedding has a couple_intel row, attaches persona, verifies snapshot.
 */

import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv() {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return env
}

async function main() {
  const env = loadEnv()
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY

  const sb = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL!,
    env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  )

  // Find any couple_intel rows + cross-reference with attribution_events.
  const { data: intelRows } = await sb
    .from('couple_intel')
    .select('wedding_id, venue_id, persona_label')
    .not('persona_label', 'is', null)
    .limit(50)

  if (!intelRows || intelRows.length === 0) {
    console.log('No couple_intel.persona rows exist yet (Wave 5A just shipped). Synthesizing fixture.')
    await runFixtureTest(sb)
    return
  }

  console.log(`Found ${intelRows.length} couple_intel rows with persona`)

  // Find one whose wedding has an attribution_events row.
  let target: {
    attributionEventId: string
    weddingId: string
    venueId: string
    expectedPersona: string
  } | null = null

  for (const row of intelRows as Array<{
    wedding_id: string
    venue_id: string
    persona_label: string | null
  }>) {
    if (!row.persona_label) continue
    const { data: attr } = await sb
      .from('attribution_events')
      .select('id')
      .eq('wedding_id', row.wedding_id)
      .is('reverted_at', null)
      .limit(1)
      .maybeSingle()
    if (attr) {
      target = {
        attributionEventId: (attr as { id: string }).id,
        weddingId: row.wedding_id,
        venueId: row.venue_id,
        expectedPersona: row.persona_label,
      }
      break
    }
  }

  if (!target) {
    console.log('No wedding has both couple_intel.persona_label AND attribution_events.')
    console.log('Skipping live persona-overlay verification.')
    process.exit(0)
  }

  console.log('Test target:', target)

  // Reset persona_overlay to null for clean slate.
  await sb
    .from('attribution_events')
    .update({ persona_overlay: null })
    .eq('id', target.attributionEventId)

  const { attachPersonaToAttributionEvent } = await import(
    '../src/lib/services/marketing-spend/persona-overlay'
  )

  // First attach: should insert.
  const r1 = await attachPersonaToAttributionEvent({
    attributionEventId: target.attributionEventId,
  })
  console.log('first attach:', r1)
  if (!r1.attached) throw new Error('expected first attach to succeed')

  // Verify the row.
  const { data: verify } = await sb
    .from('attribution_events')
    .select('persona_overlay')
    .eq('id', target.attributionEventId)
    .maybeSingle()
  const overlay = (verify as { persona_overlay: { persona_label?: string } | null })
    .persona_overlay
  console.log('persona_overlay:', overlay)
  if (!overlay || overlay.persona_label !== target.expectedPersona) {
    throw new Error(
      `expected persona_label=${target.expectedPersona}; got ${JSON.stringify(overlay)}`,
    )
  }

  // Second attach (idempotent): should report unchanged.
  const r2 = await attachPersonaToAttributionEvent({
    attributionEventId: target.attributionEventId,
  })
  console.log('second attach:', r2)
  if (r2.attached) throw new Error('expected second attach to skip (unchanged)')

  console.log('\nWave 6A persona-overlay smoke test PASSED.')
}

// Smoke-test script: relax the heavily-narrowed Supabase generics so we
// can insert/update with literal payloads. Safe — service-role client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runFixtureTest(sb: any) {
  const FIXTURE_PERSONA = 'wave6a-fixture-persona'

  // Find ANY attribution_events row in the system to test against.
  const { data: attrRow } = await sb
    .from('attribution_events')
    .select('id, wedding_id, venue_id, persona_overlay')
    .is('reverted_at', null)
    .limit(1)
    .maybeSingle()

  if (!attrRow) {
    console.log('No attribution_events rows in DB — Phase B has not run on any venue yet')
    console.log('Skipping fixture test; persona-overlay code path is exercised by smoke-wave-6a.ts')
    return
  }

  const target = attrRow as {
    id: string
    wedding_id: string
    venue_id: string
    persona_overlay: unknown
  }
  console.log('Using attribution_events row:', target.id)

  // Snapshot the current persona_overlay so we can restore.
  const originalOverlay = target.persona_overlay

  // Insert a synthetic couple_intel row for that wedding.
  // (Hot column persona_label + jsonb intel.persona.label/confidence_0_100.)
  const { error: cleanupErr } = await sb
    .from('couple_intel')
    .delete()
    .eq('wedding_id', target.wedding_id)
  if (cleanupErr) {
    console.log('cleanup couple_intel pre-test (ok):', cleanupErr.message)
  }

  const { error: insErr } = await sb.from('couple_intel').insert({
    wedding_id: target.wedding_id,
    venue_id: target.venue_id,
    intel: {
      persona: {
        label: FIXTURE_PERSONA,
        description: 'Synthetic fixture for Wave 6A smoke test',
        confidence_0_100: 88,
      },
    },
    persona_label: FIXTURE_PERSONA,
    last_derived_at: new Date().toISOString(),
    prompt_version: 'wave6a-fixture',
  })
  if (insErr) {
    console.error('failed to insert fixture couple_intel:', insErr.message)
    return
  }

  try {
    // Reset persona_overlay.
    await sb
      .from('attribution_events')
      .update({ persona_overlay: null })
      .eq('id', target.id)

    const { attachPersonaToAttributionEvent } = await import(
      '../src/lib/services/marketing-spend/persona-overlay'
    )
    const r1 = await attachPersonaToAttributionEvent({
      attributionEventId: target.id,
    })
    console.log('first attach:', r1)
    if (!r1.attached) throw new Error('expected attach to succeed')

    const { data: verify } = await sb
      .from('attribution_events')
      .select('persona_overlay')
      .eq('id', target.id)
      .maybeSingle()
    const overlay = (verify as { persona_overlay: { persona_label?: string; persona_confidence?: number } | null })
      .persona_overlay
    console.log('persona_overlay:', overlay)
    if (!overlay || overlay.persona_label !== FIXTURE_PERSONA) {
      throw new Error(
        `expected persona_label=${FIXTURE_PERSONA}; got ${JSON.stringify(overlay)}`,
      )
    }
    if (overlay.persona_confidence !== 88) {
      throw new Error(
        `expected persona_confidence=88; got ${overlay.persona_confidence}`,
      )
    }

    // Idempotency check.
    const r2 = await attachPersonaToAttributionEvent({
      attributionEventId: target.id,
    })
    console.log('second attach (should be unchanged):', r2)
    if (r2.attached) throw new Error('expected second attach to skip')

    console.log('\nWave 6A persona-overlay FIXTURE test PASSED.')
  } finally {
    // Restore original state.
    await sb
      .from('couple_intel')
      .delete()
      .eq('wedding_id', target.wedding_id)
    await sb
      .from('attribution_events')
      .update({ persona_overlay: originalOverlay })
      .eq('id', target.id)
    console.log('  (cleanup: removed fixture couple_intel, restored persona_overlay)')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
