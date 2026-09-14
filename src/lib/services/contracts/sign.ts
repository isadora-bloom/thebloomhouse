/**
 * The couple's side: open a contract from a link, read it, agree to it.
 *
 * The link is the only credential. There is no login on the signing page,
 * because a couple who have to remember a password to sign their venue
 * contract will ring the coordinator instead, which is the problem this
 * whole workstream exists to remove.
 *
 * What keeps that safe:
 *
 *   - The token is 128 bits of randomness, minted at send time. Only its
 *     sha256 is stored (`contracts.sign_token`), the same way
 *     couple_invites.token_hash works. Reading the column does not let
 *     anybody sign.
 *   - The lookup is by hash and returns exactly one row, or nothing. There
 *     is no venue, wedding or couple parameter anywhere in the flow, so
 *     there is nothing to tamper with and nothing to enumerate.
 *   - What comes back is a NARROW projection, built field by field in
 *     `toPublicView` below. Not the row. The page cannot leak a column it
 *     was never handed: no ids, no storage path, no couple email, no other
 *     contract, nothing about the venue beyond its name.
 *   - Signing is single use. The update is conditional on the row still
 *     being open, so two taps on a slow phone produce one signature.
 *
 * Rate limiting is the caller's job (the public route) and uses
 * src/lib/rate-limit.ts keyed on the token hash, so hammering one link
 * cannot cost another couple anything.
 */

import { createHash, randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { redactError } from '@/lib/observability/redact'
import { renderContract, renderContractHtml } from './templates'
import { readGeneratedFrom } from './generate'
import {
  asContractStatus,
  canSign,
  openForSigning,
  statusLabel,
  statusOnView,
  type ContractStatus,
} from './status'

type Db = SupabaseClient

/** The columns the signing flow reads. Nothing else is ever selected. */
const SIGNING_COLUMNS =
  'id, filename, status, kind, generated_from, sent_at, viewed_at, signed_at, signed_name'

export function hashSignToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** A fresh signing credential: the token for the email, the hash for the row. */
export function mintSignToken(): { token: string; tokenHash: string } {
  const token = randomBytes(16).toString('hex')
  return { token, tokenHash: hashSignToken(token) }
}

/** A token is 32 hex characters. Anything else never reaches the database. */
export function looksLikeToken(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[a-f0-9]{32}$/i.test(raw.trim())
}

// ---------------------------------------------------------------------------
// What the public page is allowed to know
// ---------------------------------------------------------------------------

/**
 * Everything the signing page renders, and nothing else. Built field by
 * field on purpose: a projection that spread the row would leak the next
 * column somebody adds to `contracts`.
 */
export interface PublicContractView {
  /** The venue's own name. Not its id. */
  venueName: string
  title: string
  /** The contract body as escaped HTML, re-rendered from the frozen blob. */
  html: string
  signaturePrompt: string
  status: ContractStatus
  statusLabel: string
  /** Set only once signed, so the page can show them their own signature. */
  signedName: string | null
  signedAt: string | null
}

export type SignLookup =
  | { ok: true; view: PublicContractView }
  | { ok: false; reason: string }

const NOT_FOUND = {
  ok: false as const,
  // Deliberately the same message for a bad token, a deleted row and an
  // upload that was never a generated contract. A page that distinguishes
  // them is a page that answers questions for whoever is guessing.
  reason: 'This link is not valid. Ask the venue to send it again.',
}

function toPublicView(row: Record<string, unknown>): PublicContractView | null {
  const status = asContractStatus(row.status)
  if (status === null) return null
  const frozen = readGeneratedFrom(row.generated_from)
  if (!frozen) return null

  const doc = renderContract(frozen.template, frozen.snapshot)
  return {
    venueName: frozen.snapshot.venueName,
    title: doc.title,
    html: renderContractHtml(doc),
    signaturePrompt: doc.signaturePrompt,
    status,
    statusLabel: statusLabel(status),
    signedName: typeof row.signed_name === 'string' ? row.signed_name : null,
    signedAt: typeof row.signed_at === 'string' ? row.signed_at : null,
  }
}

// ---------------------------------------------------------------------------
// Opening the link
// ---------------------------------------------------------------------------

/**
 * Look the contract up and, the first time, record that they opened it.
 *
 * A void contract is deliberately still readable: the couple clicked a
 * link they were sent, and a blank page would tell them nothing. They see
 * it marked withdrawn, which is the truth.
 */
export async function loadContractForSigning(
  rawToken: string,
  db: Db = createServiceClient(),
  now: Date = new Date(),
): Promise<SignLookup> {
  if (!looksLikeToken(rawToken)) return NOT_FOUND

  const tokenHash = hashSignToken(rawToken.trim())

  const { data: row, error } = await db
    .from('contracts')
    .select(SIGNING_COLUMNS)
    .eq('sign_token', tokenHash)
    .eq('kind', 'generated')
    .maybeSingle()

  if (error) {
    console.error('[contracts/sign] lookup failed:', redactError(error))
    return { ok: false, reason: 'We could not open that just now. Try again in a moment.' }
  }
  if (!row) return NOT_FOUND

  const record = row as unknown as Record<string, unknown>
  const view = toPublicView(record)
  if (!view) return NOT_FOUND

  // First open only. statusOnView moves 'sent' to 'viewed' and leaves
  // everything else where it is, and the update is conditional on the row
  // still being in 'sent', so re-reading a signed contract never moves it
  // backwards even if two tabs race.
  const next = statusOnView(view.status)
  if (next !== null && next !== view.status) {
    const { error: viewErr } = await db
      .from('contracts')
      .update({ status: next, viewed_at: now.toISOString() })
      .eq('id', record.id as string)
      .eq('status', view.status)
    if (viewErr) {
      // Not fatal. They can still read and sign; the venue loses one
      // timestamp, which is worth less than the page failing to load.
      console.warn('[contracts/sign] could not record the open:', redactError(viewErr))
    } else {
      return { ok: true, view: { ...view, status: next, statusLabel: statusLabel(next) } }
    }
  }

  return { ok: true, view }
}

// ---------------------------------------------------------------------------
// Agreeing
// ---------------------------------------------------------------------------

export type SignOutcome =
  | { ok: true; view: PublicContractView }
  | { ok: false; reason: string }

/** A typed name has to be a name. Two characters and a letter in it. */
export function validSignedName(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  const t = raw.trim()
  return t.length >= 2 && t.length <= 120 && /\p{L}/u.test(t)
}

/**
 * Record the agreement.
 *
 * Single use enforced at the database, not in the read-then-write gap: the
 * update filters on the row still being open, and an update that changes
 * nothing means somebody else already signed it. Two taps on a slow phone
 * produce one signature and one honest "already signed" on the second.
 */
export async function signContract(input: {
  token: string
  typedName: string
  ip?: string | null
  db?: Db
  now?: Date
}): Promise<SignOutcome> {
  const db = input.db ?? createServiceClient()
  const now = input.now ?? new Date()

  if (!looksLikeToken(input.token)) return NOT_FOUND
  if (!validSignedName(input.typedName)) {
    return { ok: false, reason: 'Please type your full name to agree.' }
  }

  const tokenHash = hashSignToken(input.token.trim())

  const { data: row, error } = await db
    .from('contracts')
    .select(SIGNING_COLUMNS)
    .eq('sign_token', tokenHash)
    .eq('kind', 'generated')
    .maybeSingle()

  if (error) {
    console.error('[contracts/sign] lookup before signing failed:', redactError(error))
    return { ok: false, reason: 'We could not record that just now. Try again in a moment.' }
  }
  if (!row) return NOT_FOUND

  const record = row as unknown as Record<string, unknown>
  const view = toPublicView(record)
  if (!view) return NOT_FOUND

  const permission = canSign(view.status)
  if (!permission.ok) return { ok: false, reason: permission.reason }

  const signedName = input.typedName.trim()
  const signedAt = now.toISOString()

  const { data: updated, error: updateError } = await db
    .from('contracts')
    .update({
      status: 'signed',
      signed_at: signedAt,
      signed_name: signedName,
      signed_ip: input.ip?.slice(0, 64) ?? null,
    })
    .eq('id', record.id as string)
    // The single-use guard. Anything already signed or withdrawn matches
    // nothing and comes back as an empty update.
    .in('status', openForSigning() as unknown as string[])
    .select('id')

  if (updateError) {
    console.error('[contracts/sign] could not record the signature:', redactError(updateError))
    return { ok: false, reason: 'We could not record that just now. Try again in a moment.' }
  }
  if (!updated || updated.length === 0) {
    return { ok: false, reason: 'This contract has already been signed.' }
  }

  return {
    ok: true,
    view: {
      ...view,
      status: 'signed',
      statusLabel: statusLabel('signed'),
      signedName,
      signedAt,
    },
  }
}
