import { createClient } from '@supabase/supabase-js'
import { detectFormRelay } from '../src/lib/services/ingestion/form-relay-parsers'

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const { data: i } = await sb.from('interactions')
    .select('from_email, from_name, subject, full_body, body_preview')
    .eq('id', 'ef7e49fc-8c4f-4a15-aa5b-4180cc879323')
    .single()
  if (!i) { console.log('not found'); return }

  const body = (i.full_body as string | null) || (i.body_preview as string | null) || ''
  const from = i.from_name ? `${i.from_name} <${i.from_email}>` : (i.from_email as string)

  console.log('Input from:', from)
  console.log('Body length:', body.length)
  console.log('Body has "Zola for Vendors":', /Zola for Vendors/i.test(body))
  console.log('Body has connect-*:', /connect-[a-f0-9-]+@/i.test(body))
  console.log('Body has "sent you an inquiry":', /sent you an inquiry/i.test(body))
  console.log()

  const result = detectFormRelay(
    { from, to: null, subject: i.subject as string, body },
    new Set(),
  )
  console.log('detectFormRelay result:')
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => { console.error(err); process.exit(1) })
