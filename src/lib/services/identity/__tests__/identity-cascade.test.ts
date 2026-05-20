/**
 * Identity cascade regression tests.
 *
 * Pins the 8-stage doctrine order (IDENTITY-FIRST-ARCHITECTURE.md §C.5
 * cascade reset 2026-05-20). Every deterministic stage gets a positive
 * test (it fires when its conditions are met) and the worst-shaped
 * false-positive gets a negative test (it does not fire when it
 * shouldn't).
 *
 * If a stage's behaviour changes, this file is the contract.
 */

import { describe, it, expect } from 'vitest'
import { cascadeMatch, type CascadeCandidate, type CascadeSignal } from '../identity-cascade'

function couple(
  id: string,
  people: Array<Partial<CascadeCandidate['people'][number]>>,
  weddingDate: string | null = null,
): CascadeCandidate {
  return {
    coupleId: id,
    weddingDate,
    people: people.map((p) => ({
      firstName: p.firstName ?? null,
      lastName: p.lastName ?? null,
      email: p.email ?? null,
      phone: p.phone ?? null,
    })),
  }
}

describe('cascade — stage 1: exact email', () => {
  it('matches when emails are equal (case-insensitive)', () => {
    const sig: CascadeSignal = { primaryEmail: 'Tim@Bloggs.com' }
    const res = cascadeMatch(sig, [couple('c1', [{ email: 'tim@bloggs.com' }])])
    expect(res.matched).toBe(true)
    if (res.matched) expect(res.stage).toBe('exact_email')
  })

  it('does not match when emails differ', () => {
    const sig: CascadeSignal = { primaryEmail: 'tim@bloggs.com' }
    const res = cascadeMatch(sig, [couple('c1', [{ email: 'tom@bloggs.com' }])])
    expect(res.matched).toBe(false)
  })
})

describe('cascade — stage 2: exact full name', () => {
  it('matches Timothy Bloggs to Timothy Bloggs', () => {
    const sig: CascadeSignal = { firstName: 'Timothy', lastName: 'Bloggs' }
    const res = cascadeMatch(sig, [
      couple('c1', [{ firstName: 'Timothy', lastName: 'Bloggs' }]),
    ])
    expect(res.matched).toBe(true)
    if (res.matched) expect(res.stage).toBe('exact_full_name')
  })

  it('does not match Timothy Bloggs to Timothy Smith', () => {
    const sig: CascadeSignal = { firstName: 'Timothy', lastName: 'Bloggs' }
    const res = cascadeMatch(sig, [
      couple('c1', [{ firstName: 'Timothy', lastName: 'Smith' }]),
    ])
    expect(res.matched).toBe(false)
  })
})

describe('cascade — stage 3: nickname + exact last name', () => {
  it('matches Tim Bloggs to Timothy Bloggs', () => {
    const sig: CascadeSignal = { firstName: 'Tim', lastName: 'Bloggs' }
    const res = cascadeMatch(sig, [
      couple('c1', [{ firstName: 'Timothy', lastName: 'Bloggs' }]),
    ])
    expect(res.matched).toBe(true)
    if (res.matched) expect(res.stage).toBe('nickname_plus_last_name')
  })

  it('matches Timmy Bloggs to Timothy Bloggs', () => {
    const sig: CascadeSignal = { firstName: 'Timmy', lastName: 'Bloggs' }
    const res = cascadeMatch(sig, [
      couple('c1', [{ firstName: 'Timothy', lastName: 'Bloggs' }]),
    ])
    expect(res.matched).toBe(true)
    if (res.matched) expect(res.stage).toBe('nickname_plus_last_name')
  })

  it('does NOT match Kayla Williams to Makayla Williams (substring, not nickname)', () => {
    // Kayla is a substring of Makayla but they are distinct first names,
    // not nicknames. The dictionary does not link them, so stage 3 does
    // not fire. The audit 2026-05-20 false-merge bug shape.
    const sig: CascadeSignal = { firstName: 'Kayla', lastName: 'Williams' }
    const res = cascadeMatch(sig, [
      couple('c1', [{ firstName: 'Makayla', lastName: 'Williams' }]),
    ])
    expect(res.matched).toBe(false)
  })

  it('does NOT match Tim Bloggs to Timothy Smith (last name differs)', () => {
    const sig: CascadeSignal = { firstName: 'Tim', lastName: 'Smith' }
    const res = cascadeMatch(sig, [
      couple('c1', [{ firstName: 'Timothy', lastName: 'Bloggs' }]),
    ])
    expect(res.matched).toBe(false)
  })
})

describe('cascade — stage 4: exact phone', () => {
  it('matches normalised E.164 phones', () => {
    const sig: CascadeSignal = { primaryPhone: '+1 (555) 123-4567' }
    const res = cascadeMatch(sig, [couple('c1', [{ phone: '5551234567' }])])
    expect(res.matched).toBe(true)
    if (res.matched) expect(res.stage).toBe('exact_phone')
  })
})

describe('cascade — stage 5: email-localpart logical name', () => {
  it('matches timmy.blogs@gmail.com to timothyblogs@hotmail.com', () => {
    const sig: CascadeSignal = { primaryEmail: 'timmy.blogs@gmail.com' }
    const res = cascadeMatch(sig, [
      couple('c1', [{ email: 'timothyblogs@hotmail.com' }]),
    ])
    expect(res.matched).toBe(true)
    if (res.matched) expect(res.stage).toBe('email_localpart_logical_name')
  })

  it('does not match across different last names', () => {
    const sig: CascadeSignal = { primaryEmail: 'timmy.blogs@gmail.com' }
    const res = cascadeMatch(sig, [
      couple('c1', [{ email: 'timothy.smith@hotmail.com' }]),
    ])
    expect(res.matched).toBe(false)
  })
})

describe('cascade — stage 6: body cross-reference', () => {
  it('matches when an unrelated sender references a known email in body', () => {
    const sig: CascadeSignal = {
      primaryEmail: 'susan@helper.com',
      bodyText:
        "Hi, I'm helping Tim with his wedding planning. " +
        "His email is tim@bloggs.com if you need to reach him directly.",
    }
    const res = cascadeMatch(sig, [
      couple('c1', [
        { firstName: 'Timothy', lastName: 'Bloggs', email: 'tim@bloggs.com' },
      ]),
    ])
    expect(res.matched).toBe(true)
    if (res.matched) expect(res.stage).toBe('body_cross_reference')
  })

  it("does not fire on a sender's own email appearing in their own body", () => {
    const sig: CascadeSignal = {
      primaryEmail: 'tim@bloggs.com',
      bodyText: 'Hi, my email is tim@bloggs.com (the same one I am writing from).',
    }
    const res = cascadeMatch(sig, [
      couple('c1', [
        { firstName: 'Other', lastName: 'Person', email: 'other@elsewhere.com' },
      ]),
    ])
    // stage 1 wouldn't fire (no matching email on candidate), stage 6
    // shouldn't fire because the body email IS the sender's own email.
    expect(res.matched).toBe(false)
  })

  it('matches when body references a known phone', () => {
    const sig: CascadeSignal = {
      primaryEmail: 'susan@helper.com',
      bodyText: "Tim's number is 555-123-4567 if you need to reach him.",
    }
    const res = cascadeMatch(sig, [
      couple('c1', [
        { firstName: 'Timothy', lastName: 'Bloggs', phone: '+15551234567' },
      ]),
    ])
    expect(res.matched).toBe(true)
    if (res.matched) expect(res.stage).toBe('body_cross_reference')
  })
})

describe('cascade — stage 7: paired-name + corroborator', () => {
  it('matches "susan and timothy" + matching wedding date', () => {
    const sig: CascadeSignal = {
      bodyText: "Hi, this is about Susan and Timothy's wedding next year!",
      weddingDate: '2026-09-12',
    }
    const res = cascadeMatch(sig, [
      couple(
        'c1',
        [
          { firstName: 'Susan', lastName: 'Smith' },
          { firstName: 'Timothy', lastName: 'Bloggs' },
        ],
        '2026-09-12',
      ),
    ])
    expect(res.matched).toBe(true)
    if (res.matched) expect(res.stage).toBe('paired_name_with_corroborator')
  })

  it('matches "sue and tim" via nicknames + corroborating phone (stage 6 wins on body phone)', () => {
    // A phone number in the body is itself a deterministic body-cross-
    // reference (stage 6), which runs before stage 7. The couple still
    // resolves correctly; the winning stage is just the deterministic
    // one. Both paths lead to the same couple, but stage 6 is the more
    // specific signal so it wins per doctrine order.
    const sig: CascadeSignal = {
      bodyText:
        "I'm coordinating sue and tim's vendor list, ping us at 555-123-4567 if needed.",
    }
    const res = cascadeMatch(sig, [
      couple('c1', [
        { firstName: 'Susan', lastName: 'Smith', phone: '+15551234567' },
        { firstName: 'Timothy', lastName: 'Bloggs' },
      ]),
    ])
    expect(res.matched).toBe(true)
    if (res.matched) {
      expect(res.coupleId).toBe('c1')
      expect(res.stage).toBe('body_cross_reference')
    }
  })

  it('matches "sue and tim" + matching wedding date when no body identifier exists (stage 7 fires)', () => {
    // With no email / phone identifier in the body, stage 6 does not
    // fire and stage 7 takes the match via paired-name + matching date.
    const sig: CascadeSignal = {
      bodyText: "I'm coordinating sue and tim's vendor list.",
      weddingDate: '2026-09-12',
    }
    const res = cascadeMatch(sig, [
      couple(
        'c1',
        [
          { firstName: 'Susan', lastName: 'Smith' },
          { firstName: 'Timothy', lastName: 'Bloggs' },
        ],
        '2026-09-12',
      ),
    ])
    expect(res.matched).toBe(true)
    if (res.matched) expect(res.stage).toBe('paired_name_with_corroborator')
  })

  it('does NOT match "susan and timothy" with no corroborator', () => {
    // Many couples are named Susan + Timothy. Without a date or a
    // deterministic identifier in the message, this is too weak.
    const sig: CascadeSignal = {
      bodyText: 'Susan and Timothy say hi!',
    }
    const res = cascadeMatch(sig, [
      couple('c1', [
        { firstName: 'Susan', lastName: 'Smith' },
        { firstName: 'Timothy', lastName: 'Bloggs' },
      ]),
    ])
    expect(res.matched).toBe(false)
  })

  it('does NOT cross-link paired-names to a different couple even when a corroborator exists elsewhere', () => {
    // The phone "555-999-9999" belongs to c2 (Maria/Carlos). The body
    // names paired as "Susan and Timothy" belong to c1. The cascade
    // must NOT match the paired-name signal to c2 just because c2
    // happens to have the body phone — that would conflate two
    // different couples.
    //
    // Stage 6 should win on c2 (the body phone is a deterministic
    // cross-reference to c2's phone). The doctrine is that c2 is
    // correctly the match because the body phone IS c2's — the
    // paired-name signal was a red herring written by someone who knows
    // Maria's family.
    const sig: CascadeSignal = {
      bodyText: 'Susan and Timothy say hi! Reach us at 555-999-9999.',
    }
    const res = cascadeMatch(sig, [
      couple('c1', [
        { firstName: 'Susan', lastName: 'Smith' },
        { firstName: 'Timothy', lastName: 'Bloggs' },
      ]),
      couple('c2', [
        { firstName: 'Maria', lastName: 'Garcia', phone: '+15559999999' },
        { firstName: 'Carlos', lastName: 'Garcia' },
      ]),
    ])
    expect(res.matched).toBe(true)
    if (res.matched) {
      expect(res.coupleId).toBe('c2')
      expect(res.stage).toBe('body_cross_reference')
    }
  })
})

describe('cascade — stage 8: family-name + matching date', () => {
  it("matches \"the Bloggs wedding on March 15\" + Bloggs couple with date ±7d", () => {
    const sig: CascadeSignal = {
      bodyText: 'Hi, asking about the Bloggs wedding catering quote.',
      weddingDate: '2026-03-15',
    }
    const res = cascadeMatch(sig, [
      couple(
        'c1',
        [{ firstName: 'Timothy', lastName: 'Bloggs' }],
        '2026-03-15',
      ),
    ])
    expect(res.matched).toBe(true)
    if (res.matched) expect(res.stage).toBe('family_name_plus_date')
  })

  it('does NOT match family-name without a matching date', () => {
    const sig: CascadeSignal = {
      bodyText: 'Asking about the Bloggs wedding.',
      weddingDate: '2026-12-25',
    }
    const res = cascadeMatch(sig, [
      couple('c1', [{ firstName: 'Timothy', lastName: 'Bloggs' }], '2026-03-15'),
    ])
    expect(res.matched).toBe(false)
  })

  it('does NOT match family-name when no date on signal', () => {
    const sig: CascadeSignal = {
      bodyText: 'Asking about the Bloggs wedding.',
    }
    const res = cascadeMatch(sig, [
      couple('c1', [{ firstName: 'Timothy', lastName: 'Bloggs' }], '2026-03-15'),
    ])
    expect(res.matched).toBe(false)
  })
})

describe('cascade — order doctrine', () => {
  it('exact email beats every other signal', () => {
    // Signal has email matching c2, but name + date matching c1. Email
    // wins.
    const sig: CascadeSignal = {
      primaryEmail: 'tim@bloggs.com',
      firstName: 'Susan',
      lastName: 'Smith',
      weddingDate: '2026-09-12',
    }
    const res = cascadeMatch(sig, [
      couple(
        'c1',
        [{ firstName: 'Susan', lastName: 'Smith' }],
        '2026-09-12',
      ),
      couple('c2', [{ email: 'tim@bloggs.com' }]),
    ])
    expect(res.matched).toBe(true)
    if (res.matched) {
      expect(res.coupleId).toBe('c2')
      expect(res.stage).toBe('exact_email')
    }
  })

  it('returns miss when no stage fires', () => {
    const sig: CascadeSignal = { firstName: 'Unknown', lastName: 'Person' }
    const res = cascadeMatch(sig, [
      couple('c1', [{ firstName: 'Other', lastName: 'Stranger' }]),
    ])
    expect(res.matched).toBe(false)
  })

  it('returns miss on an empty candidate list', () => {
    const sig: CascadeSignal = { primaryEmail: 'tim@bloggs.com' }
    const res = cascadeMatch(sig, [])
    expect(res.matched).toBe(false)
  })
})
