/**
 * One-shot: print full interaction UUIDs for the 2 disambiguated backlog
 * picks so we can feed them to a --pick override on replay-backlog-drafts.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

try {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
      }),
  )
  for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
} catch {}

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function pick(label: string, fromEmail: string, anchor: string) {
  const lo = new Date(new Date(anchor).getTime() - 2 * 86400_000).toISOString()
  const hi = new Date(new Date(anchor).getTime() + 2 * 86400_000).toISOString()
  const { data } = await supa
    .from('interactions')
    .select('id, timestamp, from_email, subject, intent_class, wedding_id, gmail_thread_id')
    .eq('venue_id', RIXEY)
    .eq('direction', 'inbound')
    .eq('from_email', fromEmail)
    .gte('timestamp', lo)
    .lte('timestamp', hi)
    .order('timestamp', { ascending: true })
  console.log(`\n${label} <${fromEmail}>`)
  for (const r of data ?? []) {
    console.log(
      `  ${(r as any).id}  ${new Date((r as any).timestamp).toISOString().slice(0, 16)}  intent=${(r as any).intent_class}  wedding=${((r as any).wedding_id || '').slice(0, 8)}  | ${((r as any).subject || '').slice(0, 70)}`,
    )
  }
}

async function main() {
  await pick('Rachel (Racheljessica)', 'racheljessica202@gmail.com', '2026-05-11T19:13:00Z')
  await pick('Emma Bergstedt', 'emma.bergstedt@icloud.com', '2026-05-14T17:38:00Z')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
