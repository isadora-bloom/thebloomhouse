// Trace what replyTargetEmail SHOULD have been per current code,
// given the actual stored interaction body. If this prints the
// connect-vmkt address, the bug must have been a stale deploy at the
// moment of ingestion (since-fixed in 7d68f37). If it still prints
// weddingvendors@zola.com, there's a deeper bug in current HEAD.

import { createClient } from '@supabase/supabase-js'
import { detectFormRelay } from '../src/lib/services/ingestion/form-relay-parsers'
import { extractIdentityFromEmail, isPerProspectRelay, isRelayAddress } from '../src/lib/services/identity/body-extract'

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const { data: i } = await sb.from('interactions')
    .select('from_email, from_name, subject, full_body, body_preview, to_email')
    .eq('id', 'ef7e49fc-8c4f-4a15-aa5b-4180cc879323').single()
  if (!i) { console.log('not found'); return }

  const body = (i.full_body as string | null) || (i.body_preview as string | null) || ''
  const rawFromEmail = (i.from_email as string).toLowerCase()
  const from = i.from_name ? `${i.from_name} <${rawFromEmail}>` : rawFromEmail

  // Simulate the pipeline's resolution chain.
  const formLead = detectFormRelay({ from, to: i.to_email as string | null, subject: i.subject as string, body }, new Set())
  const baseExtractedIdentity = extractIdentityFromEmail({ subject: i.subject as string, body }, { ownEmails: new Set() })
  const extractedPrimaryEmail = typeof baseExtractedIdentity.primary_email === 'string'
    ? baseExtractedIdentity.primary_email : null
  const useExtractedFallback = extractedPrimaryEmail !== null && /^messages@(weddingwire|theknotww)\.com$/i.test(rawFromEmail)
  const fromEmail = formLead?.leadEmail ?? null ?? (useExtractedFallback ? extractedPrimaryEmail : rawFromEmail)
  const replyTargetEmail = formLead?.replyToEmail ?? null ?? fromEmail

  console.log('=== detectFormRelay ===')
  console.log('source:', formLead?.source)
  console.log('leadEmail:', formLead?.leadEmail)
  console.log('replyToEmail:', formLead?.replyToEmail)
  console.log()
  console.log('=== body-extract identity ===')
  console.log('emails[]:', baseExtractedIdentity.emails)
  console.log('primary_email:', baseExtractedIdentity.primary_email)
  console.log()
  console.log('=== isRelayAddress / isPerProspectRelay for connect-vmkt ===')
  const connect = 'connect-74a458ee-e8ff-40de-9bc5-f1bfa47717c3@vmkt-message.zola.com'
  console.log(`isRelayAddress(${connect}):`, isRelayAddress(connect))
  console.log(`isPerProspectRelay(${connect}):`, isPerProspectRelay(connect))
  console.log()
  console.log('=== final pipeline resolution ===')
  console.log('rawFromEmail:', rawFromEmail)
  console.log('fromEmail:', fromEmail)
  console.log('replyTargetEmail (would-be):', replyTargetEmail)
  console.log()
  console.log('=== actual draft has to_email ===')
  console.log('weddingvendors@zola.com (the wrong one)')
}

main().catch((err) => { console.error(err); process.exit(1) })
