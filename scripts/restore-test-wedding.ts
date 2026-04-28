import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

async function main() {
  const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  // Find the wedding our test munged: source='other' with backtraced metadata
  const { data: rows } = await sb
    .from('wedding_touchpoints')
    .select('wedding_id, source, metadata')
    .eq('venue_id', RIXEY)
    .eq('touch_type', 'inquiry')
    .eq('source', 'other')
  for (const r of (rows ?? []) as Array<{ wedding_id: string; metadata: Record<string, unknown> }>) {
    const meta = r.metadata ?? {}
    if (meta.backtraced_by === 'selfreview-restore' || meta.backtraced_by === 'selfreview-override') {
      console.log('Restoring', r.wedding_id, 'to calendly')
      await sb.from('weddings').update({ source: 'calendly' }).eq('id', r.wedding_id)
      await sb
        .from('wedding_touchpoints')
        .update({
          source: 'calendly',
          metadata: { ...meta, backtraced_from: null, backtraced_to: null, backtraced_at: null, backtraced_by: null },
        })
        .eq('wedding_id', r.wedding_id)
        .eq('touch_type', 'inquiry')
    }
  }
  console.log('done')
}

main().catch((err) => { console.error(err); process.exit(1) })
