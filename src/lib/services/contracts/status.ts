/**
 * The lifecycle of a generated contract, as rules rather than as ifs
 * scattered through three routes.
 *
 * `contracts.status` is one column shared by two kinds of row. An upload
 * moves uploaded -> extracted -> analyzed and has nothing to do with any
 * of this. A generated contract moves:
 *
 *     draft ──send──> sent ──open──> viewed ──agree──> signed
 *       │                │              │
 *       └────────────────┴──────────────┴────void────> void
 *
 * Two rules matter enough that they are the reason this file is pure and
 * tested rather than inline: a signed contract can never be sent again,
 * and a void one can never be signed. Both are the kind of thing that
 * looks obvious until a coordinator clicks the button twice.
 *
 * Nothing here touches the database, React, or the network.
 */

export type ContractStatus = 'draft' | 'sent' | 'viewed' | 'signed' | 'void'

export const CONTRACT_STATUSES: readonly ContractStatus[] = [
  'draft',
  'sent',
  'viewed',
  'signed',
  'void',
]

/** Statuses from which the signing link is live. */
const OPEN_FOR_SIGNING: readonly ContractStatus[] = ['sent', 'viewed']

export type Refusal = { ok: false; reason: string }
export type Permission = { ok: true } | Refusal

/**
 * Read a raw status column into the generated lifecycle. Anything that
 * is not one of the five (including an upload's 'analyzed') comes back
 * null, which callers read as "this is not a generated contract" rather
 * than guessing.
 */
export function asContractStatus(raw: unknown): ContractStatus | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  return (CONTRACT_STATUSES as readonly string[]).includes(v)
    ? (v as ContractStatus)
    : null
}

/**
 * May this contract be emailed to the couple?
 *
 * Re-sending a sent or viewed contract is allowed and expected: the first
 * email goes to spam, the couple asks for it again, the coordinator
 * presses send. What is refused is sending one they have already agreed
 * to, and sending one the venue has withdrawn.
 */
export function canSend(status: ContractStatus | null): Permission {
  if (status === null) {
    return { ok: false, reason: 'This is not a generated contract.' }
  }
  if (status === 'signed') {
    return {
      ok: false,
      reason:
        'They have already signed this one. Generate a new contract if the terms have changed.',
    }
  }
  if (status === 'void') {
    return {
      ok: false,
      reason: 'This contract was withdrawn. Generate a new one to send.',
    }
  }
  return { ok: true }
}

/**
 * May this contract be signed?
 *
 * Only after it has been sent. A draft has never left the building, so a
 * link to it should not exist; if one somehow does, it is refused rather
 * than honoured.
 */
export function canSign(status: ContractStatus | null): Permission {
  if (status === null) {
    return { ok: false, reason: 'This is not a generated contract.' }
  }
  if (status === 'signed') {
    return { ok: false, reason: 'This contract has already been signed.' }
  }
  if (status === 'void') {
    return { ok: false, reason: 'This contract was withdrawn by the venue.' }
  }
  if (status === 'draft') {
    return { ok: false, reason: 'This contract has not been sent yet.' }
  }
  return { ok: true }
}

/** May the venue withdraw it? Anything that is not already signed or void. */
export function canVoid(status: ContractStatus | null): Permission {
  if (status === null) {
    return { ok: false, reason: 'This is not a generated contract.' }
  }
  if (status === 'signed') {
    return {
      ok: false,
      reason: 'They have signed this one. It stays on the record.',
    }
  }
  if (status === 'void') {
    return { ok: false, reason: 'This contract is already withdrawn.' }
  }
  return { ok: true }
}

/** The statuses a signing link may be opened from, for a query filter. */
export function openForSigning(): readonly ContractStatus[] {
  return OPEN_FOR_SIGNING
}

/**
 * What the status becomes when the couple opens the link. Only the first
 * open moves anything: sent becomes viewed, and everything else stays put
 * so a couple re-reading a signed contract does not un-sign it.
 */
export function statusOnView(status: ContractStatus | null): ContractStatus | null {
  return status === 'sent' ? 'viewed' : status
}

/** Plain-English label for a pill. No engineering words. */
export function statusLabel(status: ContractStatus | null): string {
  switch (status) {
    case 'draft':
      return 'Not sent yet'
    case 'sent':
      return 'Sent'
    case 'viewed':
      return 'Opened'
    case 'signed':
      return 'Signed'
    case 'void':
      return 'Withdrawn'
    default:
      return 'Unknown'
  }
}

/**
 * One sentence a coordinator can read at a glance, built from the real
 * event columns rather than from created_at. Returns null when there is
 * nothing honest to say yet.
 */
export function statusTrailLine(row: {
  status: ContractStatus | null
  sent_at?: string | null
  viewed_at?: string | null
  signed_at?: string | null
  signed_name?: string | null
}): string | null {
  if (row.status === 'signed' && row.signed_at) {
    const who = row.signed_name?.trim()
    return who
      ? `Signed by ${who} on ${formatStamp(row.signed_at)}`
      : `Signed on ${formatStamp(row.signed_at)}`
  }
  if (row.status === 'viewed' && row.viewed_at) {
    return `Opened on ${formatStamp(row.viewed_at)}`
  }
  if ((row.status === 'sent' || row.status === 'viewed') && row.sent_at) {
    return `Sent on ${formatStamp(row.sent_at)}`
  }
  if (row.status === 'void') {
    return 'Withdrawn by the venue'
  }
  return null
}

/** 2026-09-14T09:00:00Z -> "14 September 2026". */
export function formatStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}
