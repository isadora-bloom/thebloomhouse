// Audit what data is missing from Rixey's 51 booked/completed weddings
// before designing a backtrace-from-emails backfill.
//
// For each booked wedding, surface:
//  - source (what we have vs nothing)
//  - booking_value (have / don't have / merged-out)
//  - booked_at / wedding_date (have / don't have)
//  - interactions count + has-html flag
//  - whether any interaction looks like a contract/proposal (regex hint)
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

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Heuristic regex for an interaction body that looks like a contract /
// proposal / signed agreement. Cast wide; we'll narrow in the extractor.
const CONTRACT_HINT_RE = /\b(contract|proposal|agreement|signed|invoice|deposit|booking confirmation|grand total|balance due|service fee|payment due|venue rental|wedding package)\b/i
const DOLLAR_RE = /\$\s?[\d,]+(?:\.\d{2})?/

interface WeddingRow {
  id: string
  source: string | null
  status: string
  booking_value: number | null
  booked_at: string | null
  wedding_date: string | null
  inquiry_date: string | null
  merged_into_id: string | null
  crm_source: string | null
}

interface InteractionRow {
  id: string
  wedding_id: string
  type: string | null
  direction: string | null
  subject: string | null
  body_preview: string | null
  full_body: string | null
  timestamp: string | null
}

async function main() {
  const env = loadEnv()
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

  const { data: rawWed, error } = await sb
    .from('weddings')
    .select('id, source, status, booking_value, booked_at, wedding_date, inquiry_date, merged_into_id, crm_source')
    .eq('venue_id', RIXEY)
    .in('status', ['booked', 'completed'])
    .is('merged_into_id', null)
  if (error) throw error
  const weddings = (rawWed ?? []) as WeddingRow[]
  console.log(`Booked/completed weddings (merged_into_id=NULL): ${weddings.length}\n`)

  // Bucket by what's missing.
  const haveValue = weddings.filter(w => (w.booking_value ?? 0) > 0)
  const noValue = weddings.filter(w => !w.booking_value || w.booking_value === 0)
  const noSource = weddings.filter(w => !w.source)
  const noBookedAt = weddings.filter(w => !w.booked_at)
  const noWeddingDate = weddings.filter(w => !w.wedding_date)

  console.log(`Have booking_value > 0:  ${haveValue.length}`)
  console.log(`Missing booking_value:   ${noValue.length}`)
  console.log(`Missing source:          ${noSource.length}`)
  console.log(`Missing booked_at:       ${noBookedAt.length}`)
  console.log(`Missing wedding_date:    ${noWeddingDate.length}`)

  // Group by source for visibility.
  const bySource = new Map<string, { total: number; missingValue: number; missingDate: number }>()
  for (const w of weddings) {
    const k = w.source ?? '__null__'
    const b = bySource.get(k) ?? { total: 0, missingValue: 0, missingDate: 0 }
    b.total++
    if (!w.booking_value || w.booking_value === 0) b.missingValue++
    if (!w.wedding_date) b.missingDate++
    bySource.set(k, b)
  }
  console.log(`\nBy source:`)
  for (const [src, b] of [...bySource.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${src.padEnd(20)} total=${String(b.total).padStart(3)}  missing_value=${String(b.missingValue).padStart(3)}  missing_date=${String(b.missingDate).padStart(3)}`)
  }

  // For weddings missing data, count their interactions + check for contract-like bodies.
  const fixupTargets = weddings.filter(w =>
    !w.booking_value || w.booking_value === 0 || !w.source || !w.wedding_date
  )
  console.log(`\nFixup-eligible weddings: ${fixupTargets.length}`)

  // Pull interactions for the fixup targets in chunks.
  const ids = fixupTargets.map(w => w.id)
  const interactions: InteractionRow[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const { data, error: e2 } = await sb
      .from('interactions')
      .select('id, wedding_id, type, direction, subject, body_preview, full_body, timestamp')
      .in('wedding_id', chunk)
    if (e2) throw e2
    interactions.push(...((data ?? []) as InteractionRow[]))
  }
  console.log(`Interactions across fixup-eligible weddings: ${interactions.length}`)

  const ixByWedding = new Map<string, InteractionRow[]>()
  for (const ix of interactions) {
    const arr = ixByWedding.get(ix.wedding_id) ?? []
    arr.push(ix)
    ixByWedding.set(ix.wedding_id, arr)
  }

  // Count: of the fixup-eligible weddings, how many have AT LEAST ONE
  // interaction whose body matches the contract hint + has a dollar
  // amount somewhere?
  let extractable = 0
  let extractableWithMissingValue = 0
  for (const w of fixupTargets) {
    const ixs = ixByWedding.get(w.id) ?? []
    const hits = ixs.filter(ix => {
      const text = `${ix.subject ?? ''}\n${ix.body_preview ?? ''}\n${ix.full_body ?? ''}`
      return CONTRACT_HINT_RE.test(text) && DOLLAR_RE.test(text)
    })
    if (hits.length > 0) {
      extractable++
      if (!w.booking_value || w.booking_value === 0) extractableWithMissingValue++
    }
  }

  console.log(`\nWeddings whose interactions look extractable: ${extractable}`)
  console.log(`  ...of which need booking_value: ${extractableWithMissingValue}`)

  // Print 10 sample fixup targets so the user can sanity-check.
  console.log(`\nSample fixup targets (first 10):`)
  for (const w of fixupTargets.slice(0, 10)) {
    const ixs = ixByWedding.get(w.id) ?? []
    const ixHits = ixs.filter(ix => {
      const text = `${ix.subject ?? ''}\n${ix.body_preview ?? ''}\n${ix.full_body ?? ''}`
      return CONTRACT_HINT_RE.test(text)
    })
    console.log(`  ${w.id.slice(0, 8)}…  src=${(w.source ?? '—').padEnd(12)} bv=${w.booking_value ?? '—'}  weddingDate=${w.wedding_date ?? '—'}  ix=${ixs.length}  contractIxHits=${ixHits.length}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
