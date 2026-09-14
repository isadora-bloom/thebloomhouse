import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, secondsUntil } from '@/lib/rate-limit'
import { clientIpForRateLimit } from '@/lib/security/client-ip'
import {
  hashSignToken,
  loadContractForSigning,
  looksLikeToken,
  signContract,
} from '@/lib/services/contracts/sign'

/**
 * /api/contracts/sign/[token] — the couple's side. No auth.
 *
 * GET  — the contract behind this link, and a note that they opened it.
 * POST — { name } records the agreement.
 *
 * Public on purpose. The link IS the credential: a couple who have to
 * remember a password to sign their venue contract will ring the
 * coordinator instead, which is the problem this exists to remove. What
 * makes that safe lives in the service (a hashed 128-bit token, a
 * single-row lookup, and a projection built field by field so the page
 * cannot leak a column it was never handed).
 *
 * Under /api/, which src/middleware.ts already treats as public, so
 * nothing in the middleware changes for this route.
 *
 * Rate limited twice: once on the link, so hammering one contract cannot
 * cost another couple anything, and once on the caller, so somebody
 * guessing tokens runs out of attempts long before they run out of
 * guesses. Neither key is shared.
 */

interface Params {
  params: Promise<{ token: string }>
}

const BAD_LINK = 'This link is not valid. Ask the venue to send it again.'

/**
 * The IP to write onto the signature. Separate from the rate-limit
 * identifier, which invents a per-request UUID when it cannot tell who is
 * calling — right for a bucket, wrong for a record of agreement. Here an
 * unknown caller records nothing rather than something made up.
 */
function recordableIp(req: NextRequest): string | null {
  const xff = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (xff) return xff
  const real = req.headers.get('x-real-ip')?.trim()
  if (real) return real
  const cf = req.headers.get('cf-connecting-ip')?.trim()
  return cf || null
}

async function guard(req: NextRequest, token: string, limit: number) {
  // Key on the hash, never the token: rate-limit keys end up in logs and
  // metrics dimensions, and the token is a credential.
  const linkKey = `contract-sign:${hashSignToken(token)}`
  const callerKey = `contract-sign-ip:${clientIpForRateLimit(req)}`

  for (const [key, max] of [
    [linkKey, limit],
    [callerKey, limit * 2],
  ] as const) {
    const rl = await checkRateLimit({ key, limit: max, windowSec: 300 })
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Too many attempts. Give it a few minutes and try again.' },
        { status: 429, headers: { 'Retry-After': String(secondsUntil(rl.resetAt)) } },
      )
    }
  }
  return null
}

export async function GET(req: NextRequest, { params }: Params) {
  const { token } = await params
  if (!looksLikeToken(token)) {
    return NextResponse.json({ error: BAD_LINK }, { status: 404 })
  }

  const limited = await guard(req, token, 20)
  if (limited) return limited

  const result = await loadContractForSigning(token)
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 404 })
  }
  return NextResponse.json({ contract: result.view })
}

export async function POST(req: NextRequest, { params }: Params) {
  const { token } = await params
  if (!looksLikeToken(token)) {
    return NextResponse.json({ error: BAD_LINK }, { status: 404 })
  }

  const limited = await guard(req, token, 10)
  if (limited) return limited

  const body = await req.json().catch(() => null)
  const typedName = typeof body?.name === 'string' ? body.name : ''

  const result = await signContract({
    token,
    typedName,
    ip: recordableIp(req),
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 409 })
  }
  return NextResponse.json({ contract: result.view })
}
