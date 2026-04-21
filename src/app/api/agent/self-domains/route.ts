import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// GET /api/agent/self-domains
//
// Returns the set of domains that represent "this venue's own email". Used
// by the UI to pre-fill the Repair-pipeline prompt so no customer-specific
// string is ever hardcoded in the client. Source of truth:
//   - venue_ai_config.ai_email   (Sage relay)
//   - gmail_connections.email_address  (every linked account)
// Extract the domain from each and dedupe.
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const venueId = auth.venueId
  if (!venueId) return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })

  const supabase = createServiceClient()
  const emails: string[] = []

  const { data: cfg } = await supabase
    .from('venue_ai_config')
    .select('ai_email')
    .eq('venue_id', venueId)
    .maybeSingle()
  const sage = (cfg as { ai_email?: string | null } | null)?.ai_email
  if (sage) emails.push(sage)

  const { data: conns } = await supabase
    .from('gmail_connections')
    .select('email_address')
    .eq('venue_id', venueId)
  for (const c of (conns ?? []) as Array<{ email_address: string }>) {
    if (c.email_address) emails.push(c.email_address)
  }

  const domains = new Set<string>()
  for (const e of emails) {
    const at = e.lastIndexOf('@')
    if (at === -1) continue
    const d = e.slice(at + 1).toLowerCase().trim()
    if (d) domains.add(d)
  }

  return NextResponse.json({ venueId, domains: [...domains], emails })
}
