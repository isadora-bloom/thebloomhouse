// Trace the engine's decisions at each gate.
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
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  // Re-implement buildSeries WITHOUT the extracted_identity.platform bug —
  // fall back to source_platform when ei.platform missing.
  const WINDOW = 90
  const now = new Date()
  const start = new Date(now.getTime() - WINDOW * 86400e3)

  function dayKey(d: Date): string { return d.toISOString().split('T')[0] }
  function enumDays(s: Date, e: Date): string[] {
    const out: string[] = []
    const c = new Date(s)
    while (c <= e) { out.push(dayKey(c)); c.setUTCDate(c.getUTCDate() + 1) }
    return out
  }
  const days = enumDays(start, now)

  const series: Array<{ channel: string; values: Map<string, number> }> = []

  // 1. inquiries
  const { data: inq } = await sb
    .from('weddings')
    .select('inquiry_date')
    .eq('venue_id', RIXEY_ID)
    .is('merged_into_id', null)
    .gte('inquiry_date', start.toISOString())
  const inqMap = new Map<string, number>()
  for (const w of inq ?? []) {
    if (!w.inquiry_date) continue
    const k = dayKey(new Date(w.inquiry_date))
    inqMap.set(k, (inqMap.get(k) ?? 0) + 1)
  }
  series.push({ channel: 'inquiries', values: inqMap })

  // 2. tangential_signals — group by source_platform with ei.platform fallback
  const { data: ts } = await sb
    .from('tangential_signals')
    .select('extracted_identity, signal_date, created_at, source_platform')
    .eq('venue_id', RIXEY_ID)
    .or(`signal_date.gte.${start.toISOString()},and(signal_date.is.null,created_at.gte.${start.toISOString()})`)
  const tsByPlat = new Map<string, Map<string, number>>()
  for (const r of ts ?? []) {
    const ei = (r.extracted_identity as any) ?? {}
    const platform = String(ei.platform ?? r.source_platform ?? 'other')
    const when = (r.signal_date as string | null) ?? (r.created_at as string)
    const k = dayKey(new Date(when))
    const sk = `${platform}_signals`
    if (!tsByPlat.has(sk)) tsByPlat.set(sk, new Map())
    const m = tsByPlat.get(sk)!
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  for (const [k, v] of tsByPlat) series.push({ channel: k, values: v })

  // 3. tours per day (treat as additional internal series)
  const { data: tours } = await sb
    .from('tours')
    .select('scheduled_at')
    .eq('venue_id', RIXEY_ID)
    .gte('scheduled_at', start.toISOString())
  const tourMap = new Map<string, number>()
  for (const t of tours ?? []) {
    const k = dayKey(new Date(t.scheduled_at))
    tourMap.set(k, (tourMap.get(k) ?? 0) + 1)
  }
  series.push({ channel: 'tours_scheduled', values: tourMap })

  // 4. external calendar
  const { data: cal } = await sb
    .from('external_calendar_events')
    .select('start_date, category')
    .gte('start_date', start.toISOString().slice(0, 10))
    .lte('start_date', now.toISOString().slice(0, 10))
  const calByCat = new Map<string, Map<string, number>>()
  for (const c of cal ?? []) {
    const ck = `calendar_${c.category}`
    if (!calByCat.has(ck)) calByCat.set(ck, new Map())
    calByCat.get(ck)!.set(c.start_date, (calByCat.get(ck)!.get(c.start_date) ?? 0) + 1)
  }
  for (const [k, v] of calByCat) series.push({ channel: k, values: v })

  // Print series stats
  console.log('SERIES:')
  for (const s of series) {
    const arr = days.map((d) => s.values.get(d) ?? 0)
    const nonZero = arr.filter((v) => v !== 0).length
    const sum = arr.reduce((a, b) => a + b, 0)
    console.log(`  ${s.channel.padEnd(36)} sum=${String(sum).padStart(5)} nonZero=${nonZero}`)
  }

  // Now compute pairwise pearson w/ MIN_NONZERO_DAYS=10 (looser than 20)
  const MIN_NZ = 3
  const LAGS = [0, 3, 5, 7, 14]
  function pearson(xs: number[], ys: number[]): number {
    if (xs.length < 3) return 0
    const n = xs.length
    const mx = xs.reduce((a, b) => a + b, 0) / n
    const my = ys.reduce((a, b) => a + b, 0) / n
    let num = 0, dx2 = 0, dy2 = 0
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my
      num += dx * dy; dx2 += dx * dx; dy2 += dy * dy
    }
    const d = Math.sqrt(dx2 * dy2)
    return d === 0 ? 0 : num / d
  }
  const arrays = new Map<string, number[]>()
  for (const s of series) arrays.set(s.channel, days.map((d) => s.values.get(d) ?? 0))

  const names = Array.from(arrays.keys())
  const results: Array<{a: string; b: string; lag: number; r: number}> = []
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = arrays.get(names[i])!
      const b = arrays.get(names[j])!
      const nzA = a.filter((v) => v !== 0).length
      const nzB = b.filter((v) => v !== 0).length
      if (nzA < MIN_NZ || nzB < MIN_NZ) continue
      let bestR = 0, bestLag = 0
      for (const lag of LAGS) {
        const len = a.length - lag
        const xs = a.slice(0, len)
        const ys = b.slice(lag)
        const r = pearson(xs, ys)
        if (Math.abs(r) > Math.abs(bestR)) { bestR = r; bestLag = lag }
      }
      if (Math.abs(bestR) >= 0.0) {
        results.push({ a: names[i], b: names[j], lag: bestLag, r: bestR })
      }
    }
  }
  results.sort((x, y) => Math.abs(y.r) - Math.abs(x.r))

  console.log()
  console.log(`PAIRS WITH |r| >= 0.4 (MIN_NZ=${MIN_NZ}):`)
  for (const p of results.slice(0, 12)) {
    console.log(`  r=${p.r.toFixed(3)} lag=${p.lag}d  ${p.a}  vs  ${p.b}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
