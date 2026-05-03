import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: log } = await sb
    .from('lead_source_derivation_log')
    .select('wedding_id')
    .eq('reason', 'migration_187_adapter_as_facts')
  const ids = (log ?? []).map((r) => r.wedding_id as string)
  console.log(`audit-tagged wedding_ids: ${ids.length}`)

  const tally = new Map<string, number>()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data } = await sb.from('weddings').select('id, source, lead_source').in('id', chunk)
    for (const r of data ?? []) {
      const k = (r.source as string | null) ?? '(NULL)'
      tally.set(k, (tally.get(k) ?? 0) + 1)
    }
  }
  console.log('Current source values for the 225 audit-logged rows:')
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(25)} ${v}`)
  }

  // Also: lead_source for those rows
  const tallyLead = new Map<string, number>()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data } = await sb.from('weddings').select('lead_source').in('id', chunk)
    for (const r of data ?? []) {
      const k = (r.lead_source as string | null) ?? '(NULL)'
      tallyLead.set(k, (tallyLead.get(k) ?? 0) + 1)
    }
  }
  console.log('Current lead_source values for the same 225 rows:')
  for (const [k, v] of [...tallyLead.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(25)} ${v}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
