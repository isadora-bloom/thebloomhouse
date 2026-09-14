/**
 * GET /api/couple/wedding-record
 *
 * W65 of NOVEMBER-PLAN.md wave 9. The couple pages are client
 * components, so a page that needs the wedding record (date, names,
 * guest count, package, event code, lifecycle stage) needs a route; this
 * is that route. All the reading happens in
 * `@/lib/intel/readers/wedding-record`, which is unit-tested without a
 * database.
 *
 * Scope: `getCoupleAuth()` binds both the venue and the wedding. Nothing
 * is taken from the query string, so a couple cannot ask about anybody
 * else's wedding.
 *
 * No writes.
 */

import { NextResponse } from 'next/server'
import { getCoupleAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'
import { getWeddingRecord } from '@/lib/intel/readers/wedding-record'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const record = await getWeddingRecord(auth.weddingId, auth.venueId)
    return NextResponse.json({ record })
  } catch (err) {
    return serverError(err)
  }
}
