// Unit test — Phase 2 operator-column re-merge matching/fill core (no DB).
// Run: node scripts/test-phase2-remerge.mjs
import { planRemerge, fillOnly } from './phase2-remerge-operator-columns.mjs'

let fail = 0
const ok = (name, cond, got) => {
  if (cond) console.log(`  ✓ ${name}`)
  else { fail++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

// OLD export fixtures (pre-wipe).
const oldWeddings = [
  // W1: has calendly_qa + owner note; primary contact via people P1
  { id: 'W1', primary_contact_email: 'amy@x.com', partner_contact_email: null, calendly_qa: { q: 'a' }, owner_note_to_couples: 'hi amy', owner_photo_url: null, lead_source: null },
  // W2: matched via PARTNER email only (case-different); owner_photo
  { id: 'W2', primary_contact_email: null, partner_contact_email: 'Ben@X.com', calendly_qa: null, owner_note_to_couples: null, owner_photo_url: 'http://p/2.jpg', lead_source: null },
  // W3: operator data but its couple was NOT reimported -> unmatched
  { id: 'W3', primary_contact_email: 'gone@x.com', partner_contact_email: null, calendly_qa: { q: 'c' }, owner_note_to_couples: null, owner_photo_url: null, lead_source: null },
  // W4: email shared by TWO new weddings -> ambiguous
  { id: 'W4', primary_contact_email: 'dup@x.com', partner_contact_email: null, calendly_qa: { q: 'd' }, owner_note_to_couples: null, owner_photo_url: null, lead_source: null },
  // W5: NO operator-typed values -> nothing to carry
  { id: 'W5', primary_contact_email: 'eve@x.com', partner_contact_email: null, calendly_qa: null, owner_note_to_couples: null, owner_photo_url: null, lead_source: null },
  // W6: lead_source manual override; matched
  { id: 'W6', primary_contact_email: 'fay@x.com', partner_contact_email: null, calendly_qa: null, owner_note_to_couples: null, owner_photo_url: null, lead_source: 'referral: venue tour' },
]
const oldPeople = [
  { wedding_id: 'W1', email: 'amy@x.com' },
  { wedding_id: 'W2', email: 'ben@x.com' },
]

// NEW couples (post-reimport), keyed on new wedding ids via source_wedding_id.
const newCouples = [
  { source_wedding_id: 'NW1', primary_contact_email: 'amy@x.com', partner_contact_email: null, merged_into_id: null },
  { source_wedding_id: 'NW2', primary_contact_email: 'someone@x.com', partner_contact_email: 'ben@x.com', merged_into_id: null },
  // dup@x.com appears on two distinct new weddings -> ambiguous
  { source_wedding_id: 'NW4a', primary_contact_email: 'dup@x.com', partner_contact_email: null, merged_into_id: null },
  { source_wedding_id: 'NW4b', primary_contact_email: 'dup@x.com', partner_contact_email: null, merged_into_id: null },
  { source_wedding_id: 'NW5', primary_contact_email: 'eve@x.com', partner_contact_email: null, merged_into_id: null },
  { source_wedding_id: 'NW6', primary_contact_email: 'fay@x.com', partner_contact_email: null, merged_into_id: null },
  // a MERGED couple pointing at amy's email must be ignored (no false ambiguity)
  { source_wedding_id: 'NW_merged', primary_contact_email: 'amy@x.com', partner_contact_email: null, merged_into_id: 'NW1' },
]

const plan = planRemerge({ oldWeddings, oldPeople, newCouples })

const u1 = plan.updates.find((u) => u.oldWeddingId === 'W1')
ok('W1 matches NW1 (primary email)', u1?.newWeddingId === 'NW1', u1)
ok('W1 carries calendly_qa + owner_note only', u1 && JSON.stringify(Object.keys(u1.fields).sort()) === JSON.stringify(['calendly_qa', 'owner_note_to_couples']), u1?.fields)
ok('W1 not made ambiguous by the MERGED amy couple', plan.ambiguous.every((a) => a.oldWeddingId !== 'W1'))

const u2 = plan.updates.find((u) => u.oldWeddingId === 'W2')
ok('W2 matches NW2 via PARTNER email, case-insensitive', u2?.newWeddingId === 'NW2', u2)
ok('W2 carries owner_photo_url only', u2 && JSON.stringify(Object.keys(u2.fields)) === JSON.stringify(['owner_photo_url']), u2?.fields)

ok('W3 unmatched (couple not reimported)', plan.unmatched.some((u) => u.oldWeddingId === 'W3'))
ok('W4 ambiguous (email on 2 new weddings)', plan.ambiguous.some((a) => a.oldWeddingId === 'W4'))
ok('W5 nothing-to-carry', plan.nothingToCarry.includes('W5'))

const u6 = plan.updates.find((u) => u.oldWeddingId === 'W6')
ok('W6 matches NW6 + carries lead_source', u6?.newWeddingId === 'NW6' && u6.fields.lead_source === 'referral: venue tour', u6)

// fillOnly: never clobber a value the reimport already set.
ok('fillOnly skips a column NEW already has', JSON.stringify(fillOnly({ calendly_qa: { q: 'a' }, owner_note_to_couples: 'hi' }, { calendly_qa: { existing: 1 }, owner_note_to_couples: null })) === JSON.stringify({ owner_note_to_couples: 'hi' }))
ok('fillOnly empty when NEW has everything', Object.keys(fillOnly({ lead_source: 'x' }, { lead_source: 'derived' })).length === 0)
ok('fillOnly treats empty-string / {} as fillable', JSON.stringify(fillOnly({ owner_note_to_couples: 'n', calendly_qa: { q: 1 } }, { owner_note_to_couples: '  ', calendly_qa: {} })) === JSON.stringify({ owner_note_to_couples: 'n', calendly_qa: { q: 1 } }))

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — phase2-remerge (${fail} failures)`)
process.exit(fail === 0 ? 0 : 1)
