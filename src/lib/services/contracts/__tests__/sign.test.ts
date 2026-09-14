/**
 * The public signing path, against the fake database.
 *
 * Four claims, and they are the ones that would hurt if they were wrong:
 *
 *   1. The token is single use for signing. Two taps produce one signature.
 *   2. A contract belonging to another venue is not reachable from a token
 *      that was not minted for it, and the refusal says nothing about what
 *      exists.
 *   3. The page is handed a narrow projection, so it cannot leak a column
 *      that it was never given. This is the test that has to be updated
 *      deliberately when somebody adds a column to `contracts`.
 *   4. A withdrawn contract cannot be signed.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { FakeContractsDb } from './fake-contracts-db'
import {
  hashSignToken,
  loadContractForSigning,
  looksLikeToken,
  mintSignToken,
  signContract,
  signTokenExpired,
  validSignedName,
  SIGN_TOKEN_TTL_DAYS,
  type PublicContractView,
} from '../sign'
import { DEFAULT_CONTRACT_TEMPLATE, type ContractPackageSnapshot } from '../templates'

const SNAPSHOT: ContractPackageSnapshot = {
  venueName: 'Crestwood Farm',
  coordinatorName: 'Sarah Chen',
  coordinatorEmail: 'sarah@crestwood.test',
  coordinatorPhone: null,
  currency: 'USD',
  coupleNames: 'Chloe Barnes and Ryan Okafor',
  weddingDate: '2027-06-12',
  eventCode: 'CW-2706-12',
  guestCount: 120,
  packageName: 'Saturday Full Weekend',
  totalCents: 1_850_000,
  depositCents: 500_000,
  paidCents: 500_000,
  taxCents: null,
  gratuityCents: null,
  checkIn: '10:00am Friday',
  checkOut: '11:00am Sunday',
  weddingHours: '8 hours',
  rehearsalHours: '2 hours',
  maxWeddingGuests: 150,
  maxRehearsalGuests: null,
  overnights: null,
  generatedAt: '2026-09-14T10:30:00Z',
}

const OTHER_VENUE_SNAPSHOT: ContractPackageSnapshot = {
  ...SNAPSHOT,
  venueName: 'Hawthorne Manor',
  coupleNames: 'Someone Else and Their Partner',
  eventCode: 'HM-SECRET-01',
}

function seedContract(
  db: FakeContractsDb,
  overrides: Record<string, unknown> = {},
): { token: string } {
  const { token, tokenHash } = mintSignToken()
  db.seed('contracts', [
    {
      id: overrides.id ?? 'contract-crestwood',
      venue_id: '22222222-2222-2222-2222-222222222202',
      wedding_id: 'wedding-1',
      kind: 'generated',
      status: 'sent',
      filename: 'CW-2706-12-agreement.pdf',
      storage_path: 'wedding-1/1_CW-2706-12-agreement.pdf',
      file_url: 'https://files.test/secret-signed-url',
      extracted_text: 'the whole contract as text',
      sign_token: tokenHash,
      sent_at: '2026-09-14T11:00:00Z',
      viewed_at: null,
      signed_at: null,
      signed_name: null,
      signed_ip: null,
      generated_from: { snapshot: SNAPSHOT, template: DEFAULT_CONTRACT_TEMPLATE },
      ...overrides,
    },
  ])
  return { token }
}

let db: FakeContractsDb

beforeEach(() => {
  db = new FakeContractsDb()
})

describe('token shape', () => {
  it('mints 32 hex characters and stores only the hash', () => {
    const { token, tokenHash } = mintSignToken()
    expect(token).toMatch(/^[a-f0-9]{32}$/)
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(tokenHash).not.toContain(token)
    expect(hashSignToken(token)).toBe(tokenHash)
  })

  it('refuses anything that is not token-shaped before it reaches the database', () => {
    expect(looksLikeToken('')).toBe(false)
    expect(looksLikeToken('../../etc/passwd')).toBe(false)
    expect(looksLikeToken("' OR 1=1 --")).toBe(false)
    expect(looksLikeToken('a'.repeat(31))).toBe(false)
    expect(looksLikeToken('a'.repeat(32))).toBe(true)
  })

  it('mints a different token every time', () => {
    const seen = new Set(
      Array.from({ length: 50 }, () => mintSignToken().token),
    )
    expect(seen.size).toBe(50)
  })
})

describe('validSignedName', () => {
  it('wants an actual name', () => {
    expect(validSignedName('Chloe Barnes')).toBe(true)
    expect(validSignedName('Bo')).toBe(true)
  })

  it('refuses a blank, a single character and a row of punctuation', () => {
    expect(validSignedName('')).toBe(false)
    expect(validSignedName('  ')).toBe(false)
    expect(validSignedName('X')).toBe(false)
    expect(validSignedName('---')).toBe(false)
    expect(validSignedName(42)).toBe(false)
  })
})

describe('loadContractForSigning', () => {
  it('returns the contract and records the first open', async () => {
    const { token } = seedContract(db)
    const result = await loadContractForSigning(token, db.asClient())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.view.venueName).toBe('Crestwood Farm')
    expect(result.view.title).toBe('Wedding agreement')
    expect(result.view.status).toBe('viewed')

    const row = db.table('contracts')[0]
    expect(row.status).toBe('viewed')
    expect(row.viewed_at).toBeTruthy()
  })

  it('does not move a signed contract backwards when they read it again', async () => {
    const { token } = seedContract(db, {
      status: 'signed',
      signed_at: '2026-09-15T09:00:00Z',
      signed_name: 'Chloe Barnes',
    })
    const result = await loadContractForSigning(token, db.asClient())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.view.status).toBe('signed')
    expect(db.table('contracts')[0].status).toBe('signed')
  })

  it('hands over a narrow projection and nothing else', async () => {
    const { token } = seedContract(db)
    const result = await loadContractForSigning(token, db.asClient())
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const expected: Array<keyof PublicContractView> = [
      'venueName',
      'title',
      'html',
      'signaturePrompt',
      'status',
      'statusLabel',
      'signedName',
      'signedAt',
    ]
    expect(Object.keys(result.view).sort()).toEqual([...expected].sort())

    // The row carries ids, a storage path and a signed file URL. None of
    // them may appear anywhere in what the page is handed.
    const serialised = JSON.stringify(result.view)
    expect(serialised).not.toContain('contract-crestwood')
    expect(serialised).not.toContain('wedding-1')
    expect(serialised).not.toContain('22222222')
    expect(serialised).not.toContain('secret-signed-url')
    expect(serialised).not.toContain('storage_path')
  })

  it('refuses a token that belongs to nothing, without saying so', async () => {
    seedContract(db)
    const result = await loadContractForSigning('f'.repeat(32), db.asClient())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/not valid/i)
    // No hint that a contract exists, no venue name, no count.
    expect(result.reason).not.toMatch(/crestwood/i)
  })

  it('refuses an upload, which has no signing lifecycle', async () => {
    const { token } = seedContract(db, { kind: 'uploaded', status: 'analyzed' })
    const result = await loadContractForSigning(token, db.asClient())
    expect(result.ok).toBe(false)
  })
})

describe('venue isolation', () => {
  it('a token minted for one venue never opens another venue’s contract', async () => {
    const crestwood = seedContract(db)

    const other = mintSignToken()
    db.seed('contracts', [
      {
        id: 'contract-hawthorne',
        venue_id: '22222222-2222-2222-2222-222222222201',
        wedding_id: 'wedding-2',
        kind: 'generated',
        status: 'sent',
        filename: 'HM-agreement.pdf',
        sign_token: other.tokenHash,
        // S5 item 7: a live signing link needs a sent_at to measure its
        // thirty days from. Without one the row reads as expired.
        sent_at: new Date().toISOString(),
        generated_from: {
          snapshot: OTHER_VENUE_SNAPSHOT,
          template: DEFAULT_CONTRACT_TEMPLATE,
        },
      },
    ])

    const asCrestwood = await loadContractForSigning(crestwood.token, db.asClient())
    expect(asCrestwood.ok).toBe(true)
    if (!asCrestwood.ok) return
    expect(asCrestwood.view.venueName).toBe('Crestwood Farm')
    expect(JSON.stringify(asCrestwood.view)).not.toContain('Hawthorne')
    expect(JSON.stringify(asCrestwood.view)).not.toContain('HM-SECRET-01')

    const asOther = await loadContractForSigning(other.token, db.asClient())
    expect(asOther.ok).toBe(true)
    if (!asOther.ok) return
    expect(asOther.view.venueName).toBe('Hawthorne Manor')
  })

  it('signing with one venue’s token leaves the other venue’s row alone', async () => {
    const crestwood = seedContract(db)
    const other = mintSignToken()
    db.seed('contracts', [
      {
        id: 'contract-hawthorne',
        venue_id: '22222222-2222-2222-2222-222222222201',
        wedding_id: 'wedding-2',
        kind: 'generated',
        status: 'sent',
        sign_token: other.tokenHash,
        // S5 item 7: a live signing link needs a sent_at to measure its
        // thirty days from. Without one the row reads as expired.
        sent_at: new Date().toISOString(),
        generated_from: {
          snapshot: OTHER_VENUE_SNAPSHOT,
          template: DEFAULT_CONTRACT_TEMPLATE,
        },
      },
    ])

    await signContract({
      token: crestwood.token,
      typedName: 'Chloe Barnes',
      db: db.asClient(),
    })

    const hawthorne = db.table('contracts').find((r) => r.id === 'contract-hawthorne')
    expect(hawthorne?.status).toBe('sent')
    expect(hawthorne?.signed_at).toBeUndefined()
  })
})

describe('signContract', () => {
  it('records the name, the time and the address', async () => {
    const { token } = seedContract(db)
    const result = await signContract({
      token,
      typedName: '  Chloe Barnes  ',
      ip: '203.0.113.7',
      db: db.asClient(),
      now: new Date('2026-09-16T12:00:00Z'),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.view.status).toBe('signed')
    expect(result.view.signedName).toBe('Chloe Barnes')

    const row = db.table('contracts')[0]
    expect(row.status).toBe('signed')
    expect(row.signed_name).toBe('Chloe Barnes')
    expect(row.signed_at).toBe('2026-09-16T12:00:00.000Z')
    expect(row.signed_ip).toBe('203.0.113.7')
  })

  it('is single use: the second attempt is refused', async () => {
    const { token } = seedContract(db)

    const first = await signContract({
      token,
      typedName: 'Chloe Barnes',
      db: db.asClient(),
    })
    expect(first.ok).toBe(true)

    const second = await signContract({
      token,
      typedName: 'Someone Else',
      db: db.asClient(),
    })
    expect(second.ok).toBe(false)
    if (second.ok) return
    // S5 (2026-09-14 audit item 7) changed the refusal a second tap gets.
    // Signing now nulls sign_token, so the second attempt does not resolve
    // to a row at all and gets the deliberately uninformative not-found
    // line rather than "already been signed". The claim the test exists to
    // make — one signature, and the first one stands — is unchanged.
    expect(second.reason).toMatch(/not valid/i)

    // And the first signature is untouched.
    expect(db.table('contracts')[0].signed_name).toBe('Chloe Barnes')
  })

  it('refuses a withdrawn contract', async () => {
    const { token } = seedContract(db, { status: 'void' })
    const result = await signContract({
      token,
      typedName: 'Chloe Barnes',
      db: db.asClient(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/withdrawn/i)
    expect(db.table('contracts')[0].signed_at).toBeNull()
  })

  it('refuses a draft that was never sent', async () => {
    const { token } = seedContract(db, { status: 'draft', sent_at: null })
    const result = await signContract({
      token,
      typedName: 'Chloe Barnes',
      db: db.asClient(),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/not been sent/i)
  })

  it('refuses a blank name before it touches the row', async () => {
    const { token } = seedContract(db)
    const result = await signContract({ token, typedName: '  ', db: db.asClient() })
    expect(result.ok).toBe(false)
    expect(db.table('contracts')[0].status).toBe('sent')
    expect(db.calls).not.toContain('contracts.update')
  })

  it('refuses a token that is not token-shaped', async () => {
    seedContract(db)
    const result = await signContract({
      token: 'nonsense',
      typedName: 'Chloe Barnes',
      db: db.asClient(),
    })
    expect(result.ok).toBe(false)
    expect(db.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// S5 (2026-09-14 security audit, item 7): the link expires, and signing
// retires it.
// ---------------------------------------------------------------------------

const SENT_AT = '2026-09-14T11:00:00Z'
const DAY = 24 * 60 * 60 * 1000

describe('signing link expiry', () => {
  it('signTokenExpired measures thirty days from the send', () => {
    const sent = Date.parse(SENT_AT)
    expect(signTokenExpired(SENT_AT, new Date(sent + 29 * DAY))).toBe(false)
    expect(signTokenExpired(SENT_AT, new Date(sent + SIGN_TOKEN_TTL_DAYS * DAY - 1))).toBe(false)
    expect(signTokenExpired(SENT_AT, new Date(sent + 31 * DAY))).toBe(true)
  })

  it('treats a row with no sent_at, or a junk one, as expired', () => {
    expect(signTokenExpired(null)).toBe(true)
    expect(signTokenExpired(undefined)).toBe(true)
    expect(signTokenExpired('')).toBe(true)
    expect(signTokenExpired('not a date')).toBe(true)
  })

  it('opens on day 29 and refuses on day 31', async () => {
    const { token } = seedContract(db, { sent_at: SENT_AT })
    const sent = Date.parse(SENT_AT)

    const fresh = await loadContractForSigning(
      token,
      db.asClient(),
      new Date(sent + 29 * DAY),
    )
    expect(fresh.ok).toBe(true)

    const stale = await loadContractForSigning(
      token,
      db.asClient(),
      new Date(sent + 31 * DAY),
    )
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.reason).toMatch(/expired/i)
  })

  it('does not render the contract body once the link has expired', async () => {
    const { token } = seedContract(db, { sent_at: SENT_AT })
    const result = await loadContractForSigning(
      token,
      db.asClient(),
      new Date(Date.parse(SENT_AT) + 60 * DAY),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).not.toMatch(/crestwood/i)
    expect(result.reason).not.toMatch(/18,500/)
  })

  it('will not put a signature on an expired link', async () => {
    const { token } = seedContract(db, { sent_at: SENT_AT })
    const result = await signContract({
      token,
      typedName: 'Chloe Barnes',
      db: db.asClient(),
      now: new Date(Date.parse(SENT_AT) + 45 * DAY),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/expired/i)
    const row = db.table('contracts')[0]
    expect(row.status).toBe('sent')
    expect(row.signed_name).toBeNull()
  })
})

describe('the link retires itself once signed', () => {
  it('nulls sign_token on a successful signature', async () => {
    const { token } = seedContract(db, { sent_at: SENT_AT })
    const result = await signContract({
      token,
      typedName: 'Chloe Barnes',
      db: db.asClient(),
      now: new Date(Date.parse(SENT_AT) + DAY),
    })
    expect(result.ok).toBe(true)
    const row = db.table('contracts')[0]
    expect(row.status).toBe('signed')
    expect(row.signed_name).toBe('Chloe Barnes')
    expect(row.sign_token).toBeNull()
  })

  it('the emailed link stops working the moment it has been used', async () => {
    const { token } = seedContract(db, { sent_at: SENT_AT })
    const now = new Date(Date.parse(SENT_AT) + DAY)

    const signed = await signContract({ token, typedName: 'Chloe Barnes', db: db.asClient(), now })
    expect(signed.ok).toBe(true)
    // The signing response still shows them their own signature once.
    if (signed.ok) expect(signed.view.signedName).toBe('Chloe Barnes')

    // A later open of the same URL resolves to nothing at all.
    const reopened = await loadContractForSigning(token, db.asClient(), now)
    expect(reopened.ok).toBe(false)
  })
})
