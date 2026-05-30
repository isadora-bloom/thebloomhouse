#!/usr/bin/env tsx
/**
 * Unit test — WeddingWire / Zola per-prospect relay key (cascade stage 1c).
 *
 * Same contract as the Knot stage-1b lock: multiple notification emails for
 * ONE inquiry (different relay addresses) must collapse to one couple,
 * while distinct prospects must stay apart. The key is the platform's
 * per-prospect-UNIQUE token / uuid (namespaced), so it can only ADD correct
 * merges — never fuse strangers. If this ever regresses (e.g. keying on a
 * shared component, or cross-platform token collision), the cascade would
 * mint duplicate people + draft duplicate replies.
 *
 * Pure functions, no DB. Run: npx tsx scripts/test-marketplace-relay-id.ts
 */
import {
  extractWeddingWirePersonId,
  extractZolaPersonId,
  extractMarketplacePersonId,
} from '@/lib/services/identity/marketplace-relay-id'
import { cascadeMatch, isRelayEmail } from '@/lib/services/identity/identity-cascade'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

// --- WeddingWire ----------------------------------------------------------
const wwUser = 'user-AB12cd@reply.weddingwire.com'
const wwAuth = 'auth-AB12cd@reply.weddingwire.com' // SAME prospect, role prefix differs
const wwOther = 'user-ZZ99xx@reply.weddingwire.com' // different prospect
const wwSynthetic = 'authsolic-AB12cd@weddingwire.bloom-relay.invalid'

console.log('extractWeddingWirePersonId:')
check('user- + auth- with same token → SAME key (role prefix stripped)',
  extractWeddingWirePersonId(wwUser) === extractWeddingWirePersonId(wwAuth),
  [extractWeddingWirePersonId(wwUser), extractWeddingWirePersonId(wwAuth)])
check('different tokens → DIFFERENT keys',
  extractWeddingWirePersonId(wwUser) !== extractWeddingWirePersonId(wwOther))
check('key is namespaced ww:',
  (extractWeddingWirePersonId(wwUser) ?? '').startsWith('ww:'))
check('case-insensitive token',
  extractWeddingWirePersonId('user-ab12cd@reply.weddingwire.com') === extractWeddingWirePersonId(wwUser))
check('synthetic authsolic relay → ww key', extractWeddingWirePersonId(wwSynthetic) === 'ww:ab12cd')
check('shared messages@weddingwire.com → null', extractWeddingWirePersonId('messages@weddingwire.com') === null)
check('shared notifications@weddingwire.com → null', extractWeddingWirePersonId('notifications@weddingwire.com') === null)

// --- Zola -----------------------------------------------------------------
const zolaA = 'connect-74a458ee-e8ff-40de-9bc5-f1bfa47717c3@vmkt-message.zola.com'
const zolaABare = 'connect-74a458ee-e8ff-40de-9bc5-f1bfa47717c3@zola.com' // same uuid, bare domain
const zolaB = 'connect-11112222-3333-4444-5555-666677778888@vmkt-message.zola.com'

console.log('extractZolaPersonId:')
check('same uuid across bare + subdomain → SAME key',
  extractZolaPersonId(zolaA) === extractZolaPersonId(zolaABare),
  [extractZolaPersonId(zolaA), extractZolaPersonId(zolaABare)])
check('different uuid → DIFFERENT key', extractZolaPersonId(zolaA) !== extractZolaPersonId(zolaB))
check('key is namespaced zola:', (extractZolaPersonId(zolaA) ?? '').startsWith('zola:'))
check('shared weddingvendors@zola.com → null', extractZolaPersonId('weddingvendors@zola.com') === null)

// --- Cross-platform namespacing + garbage ---------------------------------
console.log('extractMarketplacePersonId:')
check('WW key and Zola key never collide (namespaced)',
  extractMarketplacePersonId(wwUser) !== extractMarketplacePersonId(zolaA))
check('Knot relay is NOT handled here (stage 1b owns it) → null',
  extractMarketplacePersonId('tara.simpson.2.772357@member.theknot.com') === null)
check('plain inbox → null', extractMarketplacePersonId('sarah@gmail.com') === null)
check('null / empty → null',
  extractMarketplacePersonId(null) === null && extractMarketplacePersonId('') === null)

// --- isRelayEmail gap closure (medium-tier classification) -----------------
console.log('isRelayEmail (gap closure):')
check('WW reply relay is recognised as relay', isRelayEmail(wwUser) === true)
check('WW synthetic .invalid is recognised as relay', isRelayEmail(wwSynthetic) === true)
check('bare connect-{uuid}@zola.com is recognised as relay', isRelayEmail(zolaABare) === true)
check('plain inbox is NOT a relay', isRelayEmail('sarah@gmail.com') === false)

// --- Cascade stage 1c -----------------------------------------------------
console.log('cascadeMatch (stage 1c):')
const wwBridge = cascadeMatch(
  { primaryEmail: wwAuth, firstName: 'Will', lastName: 'Brown' },
  [{ coupleId: 'W', weddingDate: null, people: [{ firstName: 'Will', lastName: 'Brown', email: wwUser, phone: null }] }],
)
check('WW auth- variant bridges to user- variant (same prospect → 1 couple)',
  wwBridge.matched === true && wwBridge.matched && wwBridge.coupleId === 'W', wwBridge)

const wwViaAlias = cascadeMatch(
  { primaryEmail: wwUser, firstName: 'Will', lastName: 'Brown' },
  [{ coupleId: 'W', weddingDate: null, people: [{ firstName: 'Will', lastName: 'Brown', email: 'will@gmail.com', phone: null, aliasEmails: [wwAuth] }] }],
)
check('WW key matches against a candidate alias_emails entry',
  wwViaAlias.matched === true && wwViaAlias.matched && wwViaAlias.coupleId === 'W', wwViaAlias)

const zolaBridge = cascadeMatch(
  { primaryEmail: zolaABare, firstName: 'Cara', lastName: 'Lee' },
  [{ coupleId: 'Z', weddingDate: null, people: [{ firstName: 'Cara', lastName: 'Lee', email: zolaA, phone: null }] }],
)
check('Zola same-uuid bridges across subdomain change',
  zolaBridge.matched === true && zolaBridge.matched && zolaBridge.coupleId === 'Z', zolaBridge)

const distinct = cascadeMatch(
  { primaryEmail: wwOther, firstName: 'Other', lastName: 'Person' },
  [{ coupleId: 'W', weddingDate: null, people: [{ firstName: 'Will', lastName: 'Brown', email: wwUser, phone: null }] }],
)
check('different WW prospects do NOT match (no over-merge)',
  distinct.matched === false, distinct)

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — WeddingWire / Zola relay per-prospect key`)
process.exit(failures === 0 ? 0 : 1)
