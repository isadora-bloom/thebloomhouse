/**
 * Test Wave 20 voice-DNA derivation on Rixey end-to-end.
 *
 * Usage:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-wave20-derive.ts
 */

import { createClient } from '@supabase/supabase-js'
import { deriveVoiceDNA } from '../src/lib/services/voice-dna/derive'
import { applyDerivation } from '../src/lib/services/voice-dna/apply'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  // Resolve Rixey venue.
  const { data: rixey } = await sb
    .from('venues')
    .select('id, name')
    .ilike('name', '%rixey%')
    .limit(1)
    .maybeSingle()

  if (!rixey) {
    console.error('Rixey venue not found')
    process.exit(1)
  }
  console.log('Rixey venue:', rixey.id, '|', rixey.name)
  console.log('')

  console.log('=== deriveVoiceDNA ===')
  const t0 = Date.now()
  const result = await deriveVoiceDNA({
    venueId: rixey.id as string,
    supabase: sb,
    windowDays: 365,
    actor: 'script:test-wave20-derive',
  })
  const elapsed = Date.now() - t0
  console.log('elapsed ms:', elapsed)
  console.log('')

  if (!result.ok) {
    console.error('derive FAILED:', result.reason, result.details ?? '')
    process.exit(1)
  }

  console.log('derivation id:', result.derivationId)
  console.log('cost dollars: $' + (result.costCents ?? 0).toFixed(4))
  console.log('source summary:', JSON.stringify(result.sourceSummary, null, 2))
  console.log('')

  console.log('--- TOP 3 BANNED PHRASES ---')
  for (const p of result.derivation.banned_phrases.slice(0, 3)) {
    console.log(`  [${p.confidence}%] ${p.phrase}`)
    console.log(`        evidence: "${p.evidence_quote.slice(0, 150)}"`)
  }
  console.log('')

  console.log('--- TOP 3 APPROVED PHRASES ---')
  for (const p of result.derivation.approved_phrases.slice(0, 3)) {
    console.log(`  [${p.confidence}%] ${p.phrase}`)
    console.log(`        evidence: "${p.evidence_quote.slice(0, 150)}"`)
  }
  console.log('')

  console.log('--- TONE DESCRIPTORS ---')
  for (const t of result.derivation.tone_descriptors) {
    console.log(`  [${t.confidence}%] ${t.descriptor}`)
    console.log(`        evidence: "${t.evidence_quote.slice(0, 150)}"`)
  }
  console.log('')

  console.log('--- VOICE PRINCIPLES ---')
  for (const r of result.derivation.voice_principles) {
    console.log(`  [${r.confidence}%] ${r.principle}`)
    console.log(`        reasoning: ${r.reasoning.slice(0, 200)}`)
  }
  console.log('')

  // Confirm row landed.
  const { data: row } = await sb
    .from('voice_dna_derivations')
    .select('id, applied, applied_fields, cost_cents, prompt_version')
    .eq('id', result.derivationId)
    .single()
  console.log('persisted row:', JSON.stringify(row, null, 2))
  console.log('')

  // === Test applyDerivation ===
  console.log('=== applyDerivation (all fields) ===')
  const beforePrefs = await sb
    .from('voice_preferences')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', rixey.id as string)
  console.log('voice_preferences rows before apply:', beforePrefs.count)

  const applyResult = await applyDerivation({
    derivationId: result.derivationId,
    fields: ['banned_phrases', 'approved_phrases', 'tone_descriptors', 'voice_principles'],
    userId: undefined,  // null operator (system)
    supabase: sb,
  })

  console.log('apply result:', JSON.stringify(applyResult, null, 2))

  const afterPrefs = await sb
    .from('voice_preferences')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', rixey.id as string)
  console.log('voice_preferences rows after apply:', afterPrefs.count)

  // Show some of the newly-merged rows.
  const { data: newPrefs } = await sb
    .from('voice_preferences')
    .select('preference_type, content, confidence_flag, source_reference')
    .eq('venue_id', rixey.id as string)
    .eq('source_reference', `voice_dna_derivation:${result.derivationId}`)
    .limit(10)
  console.log('')
  console.log('--- new voice_preferences rows (sample) ---')
  for (const p of newPrefs ?? []) {
    console.log(`  [${p.preference_type}] ${p.content}`)
  }

  // Confirm derivation marked applied.
  const { data: appliedRow } = await sb
    .from('voice_dna_derivations')
    .select('id, applied, applied_fields, applied_at')
    .eq('id', result.derivationId)
    .single()
  console.log('')
  console.log('derivation after apply:', JSON.stringify(appliedRow, null, 2))
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
