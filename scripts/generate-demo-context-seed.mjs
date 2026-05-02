#!/usr/bin/env node
// Generates the T5-θ.4 Internal + External Context demo seed appendix.
// Output is appended to supabase/seed.sql.
//
// Reproducible: pure functions, no Math.random() — every uuid is a
// deterministic function of (table, venueIdx, n). Re-running the
// generator produces byte-identical output.
//
// Read README at top of /supabase/seed.sql for context.

const VENUES = [
  { id: '22222222-2222-2222-2222-222222222201', code: '01', name: 'Hawthorne Manor', metro: 'US-VA-584', basePrice: 8500, capacity: 200 },
  { id: '22222222-2222-2222-2222-222222222202', code: '02', name: 'Crestwood Farm',  metro: 'US-VA-584', basePrice: 6500, capacity: 150 },
  { id: '22222222-2222-2222-2222-222222222203', code: '03', name: 'The Glass House', metro: 'US-VA-556', basePrice: 12000, capacity: 250 },
  { id: '22222222-2222-2222-2222-222222222204', code: '04', name: 'Rose Hill Gardens', metro: 'US-DC-511', basePrice: 9500, capacity: 180 },
]

// Coordinators (auth.users existing in seed.sql line 57-64).
const COORDINATORS = {
  '22222222-2222-2222-2222-222222222201': '33333333-3333-3333-3333-333333333301',
  '22222222-2222-2222-2222-222222222202': '33333333-3333-3333-3333-333333333302',
  '22222222-2222-2222-2222-222222222203': '33333333-3333-3333-3333-333333333303',
  '22222222-2222-2222-2222-222222222204': '33333333-3333-3333-3333-333333333304',
}

// Build a deterministic uuid from a prefix + counter.
// The prefix is a 4-char hex tag (postgres uuid requires [0-9a-f]) which
// lives in the leading section of the uuid; the rest is filled with the
// counter. Non-hex letters cause "invalid input syntax for type uuid".
function uuidFor(tag, n) {
  if (tag.length !== 4) throw new Error('tag must be 4 chars: ' + tag)
  if (!/^[0-9a-f]{4}$/.test(tag)) throw new Error('tag must be 4 hex chars: ' + tag)
  const hex = (i, w) => i.toString(16).padStart(w, '0')
  // Keep "0000" padding pattern matching the rest of seed.sql
  return `${tag}0001-0000-0000-0000-${hex(n, 12)}`
}

const sqlEscape = (s) => s.replace(/'/g, "''")

// =============================================================
// SECTION 1 — marketing_channels (LIMB-16.2.4-A)
// =============================================================
const CHANNELS_PER_VENUE = [
  { key: 'the_knot',         label: 'The Knot',         category: 'platform', activated: '2024-01-15' },
  { key: 'wedding_wire',     label: 'WeddingWire',      category: 'platform', activated: '2024-01-15' },
  { key: 'instagram',        label: 'Instagram',        category: 'social',   activated: '2024-03-01' },
  { key: 'google_business',  label: 'Google Business',  category: 'search',   activated: '2024-01-15' },
  { key: 'referral',         label: 'Past-couple referral', category: 'referral', activated: '2024-01-15' },
  { key: 'walk_in',          label: 'Walk-in / open house', category: 'event', activated: '2024-04-01' },
  { key: 'website',          label: 'Venue website',    category: 'direct',   activated: '2024-01-15' },
]

// Per-venue extras for variety.
const CHANNELS_VENUE_EXTRAS = {
  '22222222-2222-2222-2222-222222222201': [
    { key: 'pinterest', label: 'Pinterest', category: 'social', activated: '2024-09-01' },
  ],
  '22222222-2222-2222-2222-222222222202': [
    { key: 'tiktok', label: 'TikTok', category: 'social', activated: '2025-02-10' },
    { key: 'farm_country_magazine', label: 'Farm & Country (regional print)', category: 'print', activated: '2025-04-01' },
  ],
  '22222222-2222-2222-2222-222222222203': [
    { key: 'facebook', label: 'Facebook', category: 'social', activated: '2024-06-15' },
    { key: 'wedding_planning_pod', label: 'Modern Vows podcast', category: 'paid', activated: '2025-03-01' },
  ],
  '22222222-2222-2222-2222-222222222204': [],
}

const channelLines = []
let mchN = 0
for (const v of VENUES) {
  const all = [...CHANNELS_PER_VENUE, ...(CHANNELS_VENUE_EXTRAS[v.id] || [])]
  for (const ch of all) {
    mchN++
    const id = uuidFor('e1ab', mchN)
    channelLines.push(
      `INSERT INTO marketing_channels (id, venue_id, key, label, category, is_active, activated_at, notes) VALUES ` +
      `('${id}', '${v.id}', '${ch.key}', '${sqlEscape(ch.label)}', '${ch.category}', true, '${ch.activated} 09:00:00+00', 'demo seed') ` +
      `ON CONFLICT (id) DO NOTHING;`,
    )
  }
}

// =============================================================
// SECTION 2 — coordinator_absences (LIMB-16.2.1)
// =============================================================
// 6 absences per venue spread across 2025 — realistic vacation, conference,
// holiday closure mix. NULL consultant_id = venue-wide.

const absencePatterns = [
  // [start, end, reason, handoff, consultantScoped]
  ['2025-01-02', '2025-01-06', 'New Year holiday closure',          null, false],
  ['2025-04-21', '2025-04-25', 'Conference: Wedding MBA',           'Mark covering tier-1 inquiries', true],
  ['2025-05-23', '2025-05-27', 'Memorial Day weekend closure',      null, false],
  ['2025-07-14', '2025-07-21', 'Vacation',                          'Auto-send paused; venue email auto-replies', true],
  ['2025-09-01', '2025-09-02', 'Labor Day closure',                 null, false],
  ['2025-11-26', '2025-11-30', 'Thanksgiving closure',               null, false],
]

const absenceLines = []
let absN = 0
for (const v of VENUES) {
  for (const [start, end, reason, handoff, scoped] of absencePatterns) {
    absN++
    const id = uuidFor('e2ba', absN)
    const cid = scoped ? `'${COORDINATORS[v.id]}'` : 'NULL'
    const handoffSql = handoff ? `'${sqlEscape(handoff)}'` : 'NULL'
    absenceLines.push(
      `INSERT INTO coordinator_absences (id, venue_id, assigned_consultant_id, start_at, end_at, reason, handoff_notes) VALUES ` +
      `('${id}', '${v.id}', ${cid}, '${start} 00:00:00+00', '${end} 23:59:59+00', '${sqlEscape(reason)}', ${handoffSql}) ` +
      `ON CONFLICT (id) DO NOTHING;`,
    )
  }
}

// =============================================================
// SECTION 3 — venue_operational_state (LIMB-16.2.2)
// =============================================================
// 3 windows per venue: renovation / vendor change / policy update,
// spread across 2025.

const opsPatternsByVenue = {
  '22222222-2222-2222-2222-222222222201': [
    ['renovation',     '2025-02-10', '2025-03-15', 'Bridal suite renovation',     'Refit of the second-floor bridal suite. Coordinator paused tour bookings during demo days.', 'bridal_suite'],
    ['vendor_change',  '2025-06-01', null,         'Switched preferred caterer',  'Dropped Honeysuckle Catering after staffing complaints; added Bramble & Bee as exclusive preferred.', null],
    ['policy_change',  '2025-09-15', null,         'Weekday booking opens',       'Begin accepting Thursday weddings at 70% of weekend rate. Coordinator track separately.', null],
  ],
  '22222222-2222-2222-2222-222222222202': [
    ['renovation',     '2025-01-20', '2025-03-01', 'Barn loft restoration',       'New beam reinforcement and lighting upgrade in the loft level.', 'barn_loft'],
    ['capacity_change','2025-05-01', null,         'Added meadow tent option',    'Brought a 60×40 sailcloth tent online — capacity rises from 150 to 200 in tent mode.', 'meadow'],
    ['policy_change',  '2025-10-01', null,         'Pet policy formalized',       'Pet handler now required for any wedding with > 1 dog in ceremony. Marketing language updated.', null],
  ],
  '22222222-2222-2222-2222-222222222203': [
    ['vendor_change',  '2025-03-01', null,         'In-house bar staff replaced', 'Old bar lead retired; brought on three new mixologists trained on craft cocktail menu.', null],
    ['force_majeure',  '2025-08-12', '2025-08-19', 'Power outage from heat wave', 'Generator-only operation for 7 days. Cancelled three bookings, refunded deposits.', null],
    ['policy_change',  '2025-11-01', null,         'Minimum spend introduced',    'Saturday weddings now require $25K minimum food + bev spend. Pricing tier explicit.', null],
  ],
  '22222222-2222-2222-2222-222222222204': [
    ['renovation',     '2025-04-15', '2025-05-30', 'Garden hardscape phase 2',    'Stone path and pergola finishing. Outdoor ceremony site offline during construction.', 'garden'],
    ['vendor_change',  '2025-07-15', null,         'Florist partnership added',   'Added Bloom Lane Florals as exclusive preferred — built-in 15% discount for couples.', null],
    ['policy_change',  '2025-09-01', null,         'Sunday weddings reopened',    'Tested Sunday weddings during off-season; saw demand, kept open at 80% rate.', null],
  ],
}

const opsLines = []
let opsN = 0
for (const v of VENUES) {
  for (const [stateType, start, end, title, descr, space] of opsPatternsByVenue[v.id]) {
    opsN++
    const id = uuidFor('e3cb', opsN)
    const endSql = end ? `'${end} 23:59:59+00'` : 'NULL'
    const spaceSql = space ? `'${sqlEscape(space)}'` : 'NULL'
    opsLines.push(
      `INSERT INTO venue_operational_state (id, venue_id, state_type, start_at, end_at, title, description, affected_space) VALUES ` +
      `('${id}', '${v.id}', '${stateType}', '${start} 00:00:00+00', ${endSql}, '${sqlEscape(title)}', '${sqlEscape(descr)}', ${spaceSql}) ` +
      `ON CONFLICT (id) DO NOTHING;`,
    )
  }
}

// =============================================================
// SECTION 4 — pricing_history (LIMB-16.2.3)
// =============================================================
// 4 changes per venue: base_price changes (3) + capacity (1) across 2025.

const priceChangesByVenue = {
  '22222222-2222-2222-2222-222222222201': [
    ['base_price', 8500, 8800, '2025-03-15', 'seasonal adjustment — Q2 spring uplift'],
    ['base_price', 8800, 9200, '2025-08-01', 'pricing review meeting 2025-Q3'],
    ['capacity',   200,  220,  '2025-09-15', 'tent rental added; weekday opens drove capacity policy review'],
    ['base_price', 9200, 9500, '2025-12-01', 'Year-end pricing review for 2026 bookings'],
  ],
  '22222222-2222-2222-2222-222222222202': [
    ['base_price', 6500, 6800, '2025-04-01', 'seasonal adjustment'],
    ['capacity',   150,  200,  '2025-05-01', 'meadow tent option online'],
    ['base_price', 6800, 7200, '2025-09-01', 'pricing review meeting 2025-Q3'],
  ],
  '22222222-2222-2222-2222-222222222203': [
    ['base_price', 12000, 12500, '2025-02-15', 'Q1 pricing review — matching market peer'],
    ['base_price', 12500, 13000, '2025-06-15', 'mid-year adjustment for in-house catering inflation'],
    ['base_price', 13000, 13800, '2025-11-01', 'Saturday minimum spend overhaul, base reset'],
    ['capacity',   250,   240,  '2025-08-15', 'fire-marshal capacity reassessment after summer wedding'],
  ],
  '22222222-2222-2222-2222-222222222204': [
    ['base_price', 9500,  9800,  '2025-05-01', 'spring adjustment after garden renovation'],
    ['base_price', 9800,  10200, '2025-09-15', 'pricing review meeting 2025-Q3'],
    ['capacity',   180,   200,   '2025-07-15', 'pergola opens; expanded ceremony seating'],
    ['base_price', 10200, 10500, '2025-12-15', 'Year-end pricing review for 2026 bookings'],
  ],
}

const priceLines = []
let priceN = 0
for (const v of VENUES) {
  for (const [field, oldV, newV, when, ctx] of priceChangesByVenue[v.id]) {
    priceN++
    const id = uuidFor('e4ad', priceN)
    const oldJson = JSON.stringify({ value: oldV }).replace(/'/g, "''")
    const newJson = JSON.stringify({ value: newV }).replace(/'/g, "''")
    priceLines.push(
      `INSERT INTO pricing_history (id, venue_id, field_name, old_value, new_value, changed_by, context, changed_at) VALUES ` +
      `('${id}', '${v.id}', '${field}', '${oldJson}'::jsonb, '${newJson}'::jsonb, '${COORDINATORS[v.id]}', '${sqlEscape(ctx)}', '${when} 14:00:00+00') ` +
      `ON CONFLICT (id) DO NOTHING;`,
    )
  }
}

// =============================================================
// SECTION 5 — marketing_spend (LIMB-16.2.4-C)
// =============================================================
// 12 months × 4 venues × ~5 sources = ~240 rows. Mix manual_entry + csv_import.

// Realistic monthly amounts per source by venue tier.
const monthlyBaseSpendByVenue = {
  '22222222-2222-2222-2222-222222222201': { the_knot: 1200, wedding_wire: 600, instagram: 400, google_business: 800, facebook: 250 },
  '22222222-2222-2222-2222-222222222202': { the_knot: 800,  wedding_wire: 400, instagram: 250, google_business: 500, tiktok: 150 },
  '22222222-2222-2222-2222-222222222203': { the_knot: 2000, wedding_wire: 1000, instagram: 600, google_business: 1500, facebook: 400 },
  '22222222-2222-2222-2222-222222222204': { the_knot: 1000, wedding_wire: 500, instagram: 350, google_business: 600 },
}

// Seasonal multipliers by month (1-12). Spring inquiry season = ad spend up.
const seasonalMult = {
  1: 0.95, 2: 1.05, 3: 1.20, 4: 1.30, 5: 1.25, 6: 1.10,
  7: 0.90, 8: 1.05, 9: 1.20, 10: 1.15, 11: 0.85, 12: 0.75,
}

const spendLines = []
let spendN = 0
for (const v of VENUES) {
  const sources = monthlyBaseSpendByVenue[v.id]
  for (let monthN = 0; monthN < 12; monthN++) {
    const date = new Date(Date.UTC(2025, monthN, 1))
    const monthIso = date.toISOString().slice(0, 10)
    const seasMult = seasonalMult[monthN + 1]
    for (const [source, base] of Object.entries(sources)) {
      spendN++
      const id = uuidFor('e5ae', spendN)
      // Add per-source variance — deterministic via (monthN * 7 + source.length) %
      const variance = 1 + (((monthN * 13 + source.length * 7 + spendN) % 21) - 10) / 100  // ±10%
      const amount = Math.round(base * seasMult * variance)
      // Provenance: most are manual, every 5th is csv_import (mimics quarterly imports).
      const provenance = (spendN % 5 === 0) ? 'csv_import' : 'manual_entry'
      const notes = provenance === 'csv_import' ? `Q${Math.floor(monthN/3)+1} 2025 platform export` : null
      const notesSql = notes ? `'${sqlEscape(notes)}'` : 'NULL'
      spendLines.push(
        `INSERT INTO marketing_spend (id, venue_id, source, month, amount, source_provenance, confidence_flag, notes) VALUES ` +
        `('${id}', '${v.id}', '${source}', '${monthIso}', ${amount}, '${provenance}', 'manual', ${notesSql}) ` +
        `ON CONFLICT (id) DO NOTHING;`,
      )
    }
  }
}

// =============================================================
// SECTION 6 — tangential_signals (Phase A)
// =============================================================
// Per venue: ~100 signals across the year.

// Realistic first-name pool — fingerprints look like Knot / WW data.
// Narrowed to encourage clustering: 18 names × 7 initials = 126 unique
// fingerprints. With ~110 signals/venue, this gives 50-80 candidates/venue
// after natural clustering on (platform, first_name, last_initial, 30d).
const FIRST_NAMES = [
  'Emma', 'Olivia', 'Sophia', 'Isabella', 'Charlotte', 'Amelia',
  'Harper', 'Evelyn', 'Abigail', 'Avery', 'Aria', 'Scarlett',
  'Penelope', 'Riley', 'Zoe', 'Nora', 'Lily', 'Eleanor',
]
const LAST_INITIALS = ['B', 'C', 'H', 'K', 'M', 'P', 'S']
const STATES = ['VA', 'MD', 'NC', 'PA', 'WV', 'DE']
const CITIES_BY_STATE = {
  VA: ['Richmond', 'Charlottesville', 'Fredericksburg', 'Alexandria', 'Roanoke', 'Norfolk'],
  MD: ['Baltimore', 'Bethesda', 'Annapolis', 'Frederick', 'Silver Spring'],
  NC: ['Raleigh', 'Charlotte', 'Asheville', 'Wilmington', 'Greensboro'],
  PA: ['Pittsburgh', 'Philadelphia', 'Lancaster', 'Harrisburg'],
  WV: ['Charleston', 'Morgantown', 'Wheeling'],
  DE: ['Wilmington', 'Newark', 'Dover'],
}

const PLATFORMS = [
  { key: 'the_knot',        weight: 30, types: ['view', 'save', 'message'] },
  { key: 'wedding_wire',    weight: 18, types: ['view', 'save', 'message'] },
  { key: 'instagram',       weight: 22, types: ['follow', 'like', 'visit', 'message'] },
  { key: 'pinterest',       weight: 12, types: ['save', 'click'] },
  { key: 'google_business', weight: 10, types: ['view', 'click', 'review'] },
  { key: 'facebook',        weight: 8,  types: ['like', 'message', 'visit'] },
]

// Deterministic PRNG (mulberry32) seeded per venue.
function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)] }

// Pick by weight.
function pickWeighted(arr, rng) {
  const total = arr.reduce((s, x) => s + x.weight, 0)
  let r = rng() * total
  for (const x of arr) { r -= x.weight; if (r <= 0) return x }
  return arr[arr.length - 1]
}

const signalLines = []
let sigN = 0
const sigDataByVenue = {}  // for use in next section (candidate building)

for (const v of VENUES) {
  const rng = mulberry32(parseInt(v.code, 10) * 9173 + 7)
  // Number of signals per venue with seasonal weighting (more signals
  // in spring / wedding planning peak).
  const signalsThisVenue = []
  for (let i = 0; i < 90; i++) {
    // Bias signal_date toward Q2/Q3 inquiry-peak months.
    // Use a triangular-ish distribution centered around month 5 (June).
    const r = rng()
    const r2 = rng()
    const monthIdx = Math.min(11, Math.floor(((r + r2) / 2) * 12))
    const dayIdx = 1 + Math.floor(rng() * 27)
    const signalDate = new Date(Date.UTC(2025, monthIdx, dayIdx, Math.floor(rng() * 24), Math.floor(rng() * 60)))

    const platform = pickWeighted(PLATFORMS, rng).key
    const platformObj = PLATFORMS.find(p => p.key === platform)
    const action = pick(platformObj.types, rng)

    // ~12% anonymous (no name).
    const anonymous = rng() < 0.12

    let firstName = null, lastInitial = null, username = null, city = null, state = null
    if (!anonymous) {
      firstName = pick(FIRST_NAMES, rng)
      lastInitial = pick(LAST_INITIALS, rng)
      state = pick(STATES, rng)
      city = pick(CITIES_BY_STATE[state], rng)
      if (platform === 'instagram' || platform === 'pinterest') {
        username = `${firstName.toLowerCase()}_${lastInitial.toLowerCase()}_${Math.floor(rng() * 999)}`
      }
    }

    const signalType = (() => {
      if (platform === 'instagram') return action === 'follow' ? 'instagram_follow' : 'instagram_engagement'
      if (platform === 'google_business') return 'analytics_entry'
      if (platform === 'facebook') return 'mention'
      return 'analytics_entry'
    })()

    const extracted = {}
    if (firstName) extracted.first_name = firstName
    if (lastInitial) extracted.last_initial = lastInitial
    if (username) extracted.username = username
    if (city) extracted.location = `${city}, ${state}`
    if (state) extracted.state = state

    signalsThisVenue.push({
      idx: i + 1,
      signalType,
      platform,
      action,
      signalDate: signalDate.toISOString(),
      extracted,
      anonymous,
      firstName,
      lastInitial,
      username,
      city,
      state,
    })
  }

  // Sort by signal_date so candidate clustering can see chronological order.
  signalsThisVenue.sort((a, b) => new Date(a.signalDate).getTime() - new Date(b.signalDate).getTime())
  sigDataByVenue[v.id] = signalsThisVenue
}

// =============================================================
// SECTION 7 — candidate_identities (Phase B)
// =============================================================
// Cluster signals by (platform, first_name, last_initial) within ±14 days.
// Anonymous signals never get a candidate.

const candDataByVenue = {}
const candLines = []
let candN = 0

for (const v of VENUES) {
  const signals = sigDataByVenue[v.id]
  // Group by (platform, firstName, lastInitial) — within 30d gap = same cluster.
  const candidates = []
  const sigToCand = []  // index aligned with signals
  for (let i = 0; i < signals.length; i++) sigToCand.push(null)

  for (let i = 0; i < signals.length; i++) {
    const s = signals[i]
    if (s.anonymous) continue
    // Find existing candidate with same fingerprint within 30d.
    let attached = null
    for (const c of candidates) {
      if (c.platform !== s.platform) continue
      if (c.firstName !== s.firstName || c.lastInitial !== s.lastInitial) continue
      const lastSeen = new Date(c.lastSeen).getTime()
      const sigDate = new Date(s.signalDate).getTime()
      if (Math.abs(sigDate - lastSeen) > 30 * 86400 * 1000) continue
      attached = c
      break
    }
    if (!attached) {
      attached = {
        idx: candidates.length + 1,
        platform: s.platform,
        firstName: s.firstName,
        lastInitial: s.lastInitial,
        username: s.username,
        city: s.city,
        state: s.state,
        firstSeen: s.signalDate,
        lastSeen: s.signalDate,
        actions: {},
        signalIndices: [],
      }
      candidates.push(attached)
    }
    attached.signalIndices.push(i)
    attached.lastSeen = s.signalDate
    if (s.firstSeen && new Date(s.firstSeen) < new Date(attached.firstSeen)) attached.firstSeen = s.firstSeen
    attached.actions[s.action] = (attached.actions[s.action] || 0) + 1
    sigToCand[i] = attached.idx
    // Bring in any missing fingerprint pieces over time.
    if (s.username && !attached.username) attached.username = s.username
  }

  // Stamp attribute resolution: ~40% auto-link to existing weddings.
  // We'll resolve LATER once we have wedding mapping logic. For now record candidates.
  candDataByVenue[v.id] = { candidates, sigToCand }

  for (const c of candidates) {
    candN++
    const id = uuidFor('e6cd', candN)
    const funnelDepth = Object.keys(c.actions).length
    const sigCount = c.signalIndices.length
    const actionsJson = JSON.stringify(c.actions).replace(/'/g, "''")

    // We assign a deterministic id we can reference in later sections.
    c.uuid = id

    const usernameSql = c.username ? `'${sqlEscape(c.username)}'` : 'NULL'
    const citySql = c.city ? `'${sqlEscape(c.city)}'` : 'NULL'
    const stateSql = c.state ? `'${sqlEscape(c.state)}'` : 'NULL'

    candLines.push(
      `INSERT INTO candidate_identities (id, venue_id, source_platform, first_name, last_initial, username, city, state, signal_count, funnel_depth, action_counts, first_seen, last_seen, review_status) VALUES ` +
      `('${id}', '${v.id}', '${c.platform}', '${sqlEscape(c.firstName)}', '${c.lastInitial}', ${usernameSql}, ${citySql}, ${stateSql}, ${sigCount}, ${funnelDepth}, '${actionsJson}'::jsonb, '${c.firstSeen}', '${c.lastSeen}', 'clean') ` +
      `ON CONFLICT (id) DO NOTHING;`,
    )
  }
}

// Now backfill tangential_signals with candidate_identity_id (where set).
// We must do this AFTER candidate_identities INSERT. Build all signal lines now.
for (const v of VENUES) {
  const signals = sigDataByVenue[v.id]
  const { candidates, sigToCand } = candDataByVenue[v.id]
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i]
    sigN++
    const id = uuidFor('e7d5', sigN)
    s.uuid = id
    const candIdx = sigToCand[i]
    const candUuid = candIdx ? candidates.find(c => c.idx === candIdx)?.uuid : null
    const candIdSql = candUuid ? `'${candUuid}'` : 'NULL'

    const extractedJson = JSON.stringify(s.extracted).replace(/'/g, "''")
    const sourceContext = `${s.platform} ${s.action}`

    // tangential_signals has no confidence_flag column (mig 137 only added
    // it to weddings/people/interactions/engagement_events/marketing_spend).
    // Source-of-truth for "this is demo data" is the unique uuid prefix
    // (e7d5...) that lets demo cleanup scripts target it.
    signalLines.push(
      `INSERT INTO tangential_signals (id, venue_id, signal_type, source_platform, action_class, extracted_identity, source_context, signal_date, match_status, candidate_identity_id) VALUES ` +
      `('${id}', '${v.id}', '${s.signalType}', '${s.platform}', '${s.action}', '${extractedJson}'::jsonb, '${sqlEscape(sourceContext)}', '${s.signalDate}', 'unmatched', ${candIdSql}) ` +
      `ON CONFLICT (id) DO NOTHING;`,
    )
  }
}

// =============================================================
// SECTION 8 — attribution_events
// =============================================================
// Per booked / completed wedding (booked_at present), wire 1-3 attribution
// events. The earliest in time = is_first_touch=true.
//
// We pull weddings out of the seed by their known IDs + sources.

const WEDDING_ATTRIB_SEEDS = [
  // [wedding_id, venue_id, source, booked_at]
  // Hawthorne booked
  ['44444444-4444-4444-4444-444444000109', '22222222-2222-2222-2222-222222222201', 'the_knot', '2025-11-20'],
  ['44444444-4444-4444-4444-444444000110', '22222222-2222-2222-2222-222222222201', 'referral', '2025-12-10'],
  ['44444444-4444-4444-4444-444444000111', '22222222-2222-2222-2222-222222222201', 'google_business', '2026-01-05'],
  ['44444444-4444-4444-4444-444444000112', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-02-10'],
  // Hawthorne completed
  ['44444444-4444-4444-4444-444444000119', '22222222-2222-2222-2222-222222222201', 'referral', '2024-09-15'],
  ['44444444-4444-4444-4444-444444000120', '22222222-2222-2222-2222-222222222201', 'google_business', '2024-11-20'],
  // Crestwood booked
  ['44444444-4444-4444-4444-444444000209', '22222222-2222-2222-2222-222222222202', 'the_knot', '2025-11-01'],
  ['44444444-4444-4444-4444-444444000210', '22222222-2222-2222-2222-222222222202', 'instagram', '2026-01-20'],
  // Crestwood completed
  ['44444444-4444-4444-4444-444444000216', '22222222-2222-2222-2222-222222222202', 'referral', '2025-03-10'],
  // Glass House booked
  ['44444444-4444-4444-4444-444444000313', '22222222-2222-2222-2222-222222222203', 'wedding_wire', '2025-09-01'],
  ['44444444-4444-4444-4444-444444000314', '22222222-2222-2222-2222-222222222203', 'google_business', '2025-11-15'],
  ['44444444-4444-4444-4444-444444000315', '22222222-2222-2222-2222-222222222203', 'referral', '2026-01-05'],
  ['44444444-4444-4444-4444-444444000316', '22222222-2222-2222-2222-222222222203', 'the_knot', '2026-02-10'],
  ['44444444-4444-4444-4444-444444000317', '22222222-2222-2222-2222-222222222203', 'instagram', '2026-03-01'],
  // Glass House completed (later 2025)
  ['44444444-4444-4444-4444-444444000321', '22222222-2222-2222-2222-222222222203', 'wedding_wire', '2024-11-01'],
  ['44444444-4444-4444-4444-444444000322', '22222222-2222-2222-2222-222222222203', 'referral',     '2024-12-15'],
  ['44444444-4444-4444-4444-444444000323', '22222222-2222-2222-2222-222222222203', 'the_knot',     '2025-02-10'],
  ['44444444-4444-4444-4444-444444000324', '22222222-2222-2222-2222-222222222203', 'google_business', '2025-04-15'],
  // Rose Hill booked
  ['44444444-4444-4444-4444-444444000407', '22222222-2222-2222-2222-222222222204', 'the_knot', '2025-10-15'],
  ['44444444-4444-4444-4444-444444000408', '22222222-2222-2222-2222-222222222204', 'referral', '2026-01-20'],
  ['44444444-4444-4444-4444-444444000412', '22222222-2222-2222-2222-222222222204', 'the_knot', '2025-03-15'],
]

const attribLines = []
let attrN = 0

for (const [wid, vid, source, bookedAt] of WEDDING_ATTRIB_SEEDS) {
  const venue = VENUES.find(v => v.id === vid)
  if (!venue) continue
  const { candidates } = candDataByVenue[vid]
  const bookedDate = new Date(bookedAt + 'T12:00:00Z')

  // Find candidates on the matching platform whose first_seen is BEFORE the
  // booking date (pre-inquiry signal).
  const platformCandidates = candidates.filter(c =>
    c.platform === source &&
    new Date(c.firstSeen).getTime() < bookedDate.getTime()
  )

  // Pick the candidate whose first_seen is closest to (but before) booking.
  if (platformCandidates.length === 0) continue

  // Sort by first_seen, ascending.
  platformCandidates.sort((a, b) => new Date(a.firstSeen).getTime() - new Date(b.firstSeen).getTime())

  // Pick a candidate from the middle bias — earliest is first-touch best.
  const picked = platformCandidates[Math.min(platformCandidates.length - 1, attrN % platformCandidates.length)]

  // Mark candidate as resolved (mutate so following weddings might still pick from remaining).
  picked.resolved_wedding_id = wid

  // Generate 1-3 attribution events for this wedding.
  // The earliest signal in this candidate = is_first_touch=true,
  // bucket=attribution. Subsequent signals = bucket=nurture.
  const sortedSignalIndices = [...picked.signalIndices].sort((a, b) => {
    const sigsA = sigDataByVenue[vid][a].signalDate
    const sigsB = sigDataByVenue[vid][b].signalDate
    return new Date(sigsA).getTime() - new Date(sigsB).getTime()
  })
  const eventsToWrite = sortedSignalIndices.slice(0, Math.min(3, sortedSignalIndices.length))

  for (let k = 0; k < eventsToWrite.length; k++) {
    const sigIdx = eventsToWrite[k]
    const s = sigDataByVenue[vid][sigIdx]
    const sigDate = new Date(s.signalDate)
    const isPreInquiry = sigDate.getTime() < bookedDate.getTime()
    if (!isPreInquiry) continue

    attrN++
    const id = uuidFor('e8af', attrN)
    const isFirstTouch = (k === 0)
    const bucket = 'attribution'
    const tier = (k === 0) ? 'tier_1_name_window' : 'tier_2_ai'
    const decidedBy = (k === 0) ? 'auto' : 'ai'
    const confidence = (k === 0) ? 88 : 72
    const reasoning = (k === 0)
      ? `First-touch. Pre-inquiry ${s.platform} ${s.action} signal matched on first_name + last_initial within ±72h of inquiry.`
      : `Tier 2 AI adjudicator. Multi-signal reinforcement. Funnel-depth boost from related view+save+message cluster.`

    // Update the candidate as resolved on its first iteration.
    if (k === 0) {
      // No-op here; we mutate `candidates` post-hoc later.
    }

    attribLines.push(
      `INSERT INTO attribution_events (id, venue_id, candidate_identity_id, wedding_id, signal_id, source_platform, confidence, tier, decided_by, decided_at, reasoning, is_first_touch, bucket) VALUES ` +
      `('${id}', '${vid}', '${picked.uuid}', '${wid}', '${s.uuid}', '${source}', ${confidence}, '${tier}', '${decidedBy}', '${s.signalDate}', '${sqlEscape(reasoning)}', ${isFirstTouch}, '${bucket}') ` +
      `ON CONFLICT (id) DO NOTHING;`,
    )
  }
}

// Additional auto-link pass: per the seed brief, ~40% of candidates should
// be auto-linked to weddings. attribution_events covers a small slice;
// extend by marking additional candidates as resolved (without writing
// attribution_events for those — they're "resolved-by-AI but no first-touch").
// Tie each to any wedding on the same venue+platform that exists.
const VENUE_WEDDINGS_BY_SOURCE = {}
for (const [wid, vid, source, bookedAt] of WEDDING_ATTRIB_SEEDS) {
  if (!VENUE_WEDDINGS_BY_SOURCE[vid]) VENUE_WEDDINGS_BY_SOURCE[vid] = {}
  if (!VENUE_WEDDINGS_BY_SOURCE[vid][source]) VENUE_WEDDINGS_BY_SOURCE[vid][source] = []
  VENUE_WEDDINGS_BY_SOURCE[vid][source].push({ wid, bookedAt })
}

for (const v of VENUES) {
  const { candidates } = candDataByVenue[v.id]
  // Already resolved via attribution_events (some).
  const resolvedCount = candidates.filter(c => c.resolved_wedding_id).length
  // Target ~40% of candidates.
  const targetResolved = Math.floor(candidates.length * 0.40)
  let needed = targetResolved - resolvedCount

  for (const c of candidates) {
    if (needed <= 0) break
    if (c.resolved_wedding_id) continue
    const platformWeddings = (VENUE_WEDDINGS_BY_SOURCE[v.id] || {})[c.platform]
    if (!platformWeddings || platformWeddings.length === 0) continue
    // Pick a wedding whose booked_at is AFTER candidate first_seen (realistic).
    const candidateStart = new Date(c.firstSeen).getTime()
    const eligible = platformWeddings.filter(w => new Date(w.bookedAt).getTime() > candidateStart)
    if (eligible.length === 0) continue
    const picked = eligible[needed % eligible.length]
    c.resolved_wedding_id = picked.wid
    c.resolved_by_extra = true  // distinguish from attribution-event-tied resolution
    needed--
  }
}

// Now go back and update candidates with resolved_wedding_id where we set it.
const candResolvedUpdates = []
for (const v of VENUES) {
  const { candidates } = candDataByVenue[v.id]
  for (const c of candidates) {
    if (c.resolved_wedding_id) {
      const decidedBy = c.resolved_by_extra ? 'ai' : 'auto'
      const conf = c.resolved_by_extra ? 76 : 88
      candResolvedUpdates.push(
        `UPDATE candidate_identities SET resolved_wedding_id = '${c.resolved_wedding_id}', resolved_by = '${decidedBy}', resolved_confidence = ${conf}, resolved_at = '${c.lastSeen}' WHERE id = '${c.uuid}';`,
      )
    }
  }
}

// =============================================================
// SECTION 9 — cultural_moments
// =============================================================
const cultLines = []
const cultMoments = [
  ['cb010001-0000-0000-0000-000000000001', 'Royal-adjacent celebrity wedding spike',
    'Notable celebrity wedding mid-2025 generated a 4-week wedding-aesthetic search-trend lift.',
    '2025-06-15', '2025-07-13', 'celebrity_wedding', 35,
    'us', 'system'],
  ['cb010001-0000-0000-0000-000000000002', 'Coastal grandmother aesthetic peak',
    'Pinterest + IG hashtag analytics show "coastal grandmother" hit cultural saturation through summer 2025; favors blue/cream/wicker palettes.',
    '2025-04-01', '2025-09-30', 'aesthetic_shift', 22,
    'us', 'ai'],
  ['cb010001-0000-0000-0000-000000000003', 'S&P 500 mid-year drawdown',
    'Roughly 7% S&P drawdown in summer 2025 correlates with discretionary-spend tightening; venue intel sees 1-2 quarters lag.',
    '2025-07-01', '2025-08-31', 'macro_event', -28,
    null, 'system'],
  ['cb010001-0000-0000-0000-000000000004', 'Cottagecore revival',
    'Q1 2025 revival of rustic-floral search trends, particularly relevant for barn-style and garden venues.',
    '2025-01-15', '2025-04-30', 'aesthetic_shift', 18,
    'us', 'ai'],
  ['cb010001-0000-0000-0000-000000000005', 'Knot platform redesign',
    'The Knot rolled out a major search redesign in late August 2025 that altered storefront discoverability for 6 weeks.',
    '2025-08-25', '2025-10-10', 'platform_event', -15,
    null, 'system'],
  ['cb010001-0000-0000-0000-000000000006', 'Mortgage-rate plateau relief',
    'Mortgage 30y backed off the 2025 highs in October, easing the broad-discretionary squeeze affecting wedding budgets.',
    '2025-10-15', '2025-12-31', 'macro_event', 12,
    'us', 'system'],
]
for (const [id, title, descr, start, end, category, weight, geo, proposedBy] of cultMoments) {
  const endSql = end ? `'${end} 23:59:59+00'` : 'NULL'
  const geoSql = geo ? `'${geo}'` : 'NULL'
  const reviewedById = COORDINATORS['22222222-2222-2222-2222-222222222201']
  cultLines.push(
    `INSERT INTO cultural_moments (id, status, title, description, start_at, end_at, category, evidence, influence_weight, geo_scope, proposed_by, reviewed_by, reviewed_at) VALUES ` +
    `('${id}', 'confirmed', '${sqlEscape(title)}', '${sqlEscape(descr)}', '${start} 00:00:00+00', ${endSql}, '${category}', '{"source":"demo seed","note":"manual demo data"}'::jsonb, ${weight}, ${geoSql}, '${proposedBy}', '${reviewedById}', '${start} 12:00:00+00') ` +
    `ON CONFLICT (id) DO NOTHING;`,
  )
}

// =============================================================
// SECTION 10 — fred_indicators (12 months of 5 series)
// =============================================================
const fredLines = []
let fredN = 0

// Realistic-ish 2025 FRED values (rough public-knowledge baseline; demo data).
// CPIAUCSL — CPI All Urban (1982-1984=100). 2024-end ~315; 2025 modest growth.
// MORTGAGE30US — 30y fixed mortgage %. 2025 hovered 6.8-7.3%.
// SP500 — S&P 500 close. 2025 range ~5400-6100 with summer drawdown.
// UNRATE — unemployment rate % (national). 2025 around 4.0-4.4%.
// UMCSENT — consumer sentiment. 2025 range 70-85.

const FRED_SERIES = [
  { id: 'CPIAUCSL', units: 'Index 1982-1984=100', frequency: 'monthly', monthlyVals: [
    315.0, 315.6, 316.3, 317.1, 317.6, 318.0, 318.4, 318.9, 319.4, 319.9, 320.4, 320.9
  ]},
  { id: 'MORTGAGE30US', units: '%', frequency: 'monthly', monthlyVals: [
    6.95, 7.05, 7.15, 7.25, 7.20, 7.10, 7.00, 6.95, 6.90, 6.85, 6.80, 6.75
  ]},
  { id: 'SP500', units: 'Index', frequency: 'monthly', monthlyVals: [
    5650, 5720, 5810, 5870, 5950, 5880, 5520, 5450, 5680, 5820, 5970, 6080
  ]},
  { id: 'UNRATE', units: '%', frequency: 'monthly', monthlyVals: [
    4.0, 4.0, 4.1, 4.1, 4.2, 4.2, 4.3, 4.4, 4.3, 4.2, 4.1, 4.0
  ]},
  { id: 'UMCSENT', units: 'Index 1Q1966=100', frequency: 'monthly', monthlyVals: [
    71.5, 73.0, 74.5, 76.0, 78.0, 79.5, 75.0, 72.0, 76.5, 80.0, 83.0, 85.0
  ]},
]

for (const series of FRED_SERIES) {
  for (let m = 0; m < 12; m++) {
    fredN++
    const id = uuidFor('e9fa', fredN)
    const date = new Date(Date.UTC(2025, m, 1))
    const dateIso = date.toISOString().slice(0, 10)
    const value = series.monthlyVals[m]
    fredLines.push(
      `INSERT INTO fred_indicators (id, series_id, region, observation_date, value, units, frequency) VALUES ` +
      `('${id}', '${series.id}', NULL, '${dateIso}', ${value}, '${series.units}', '${series.frequency}') ` +
      `ON CONFLICT (series_id, COALESCE(region, ''), observation_date) DO NOTHING;`,
    )
  }
}

// =============================================================
// EMIT
// =============================================================
const out = []
out.push('')
out.push('-- ============================================================================')
out.push('-- T5-θ.4: DEMO SEED — INTERNAL + EXTERNAL CONTEXT')
out.push('-- ============================================================================')
out.push('-- Per audits/2026-05-T4-postlaunch/yc-partner.md HIGH 7 + 10:')
out.push('-- Seeds 12 months of synthetic-but-plausible Internal + External Context')
out.push('-- data scoped to the four Crestwood demo venues so:')
out.push('--   * Source Quality scorecard renders Phase C / Funnel / CAC columns')
out.push('--     (USP #2 — Source Quality)')
out.push('--   * Anomaly hypothesis prompt has Internal Context to weigh BEFORE')
out.push('--     defaulting to funnel-shape causes (USP #2)')
out.push('--   * Correlation engine has FRED + cultural moments to surface macro')
out.push('--     correlations (USP #4 — Macro correlation)')
out.push('--')
out.push('-- Every row tagged confidence_flag=manual where the column exists.')
out.push('-- Idempotent via ON CONFLICT DO NOTHING.')
out.push('--')
out.push('-- Generated by scripts/generate-demo-context-seed.mjs.')
out.push('-- ============================================================================')
out.push('')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- 49. MARKETING CHANNELS (Internal Context — LIMB-16.2.4-A)')
out.push('-- ----------------------------------------------------------------------------')
out.push(...channelLines)
out.push('')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- 50. COORDINATOR ABSENCES (Internal Context — LIMB-16.2.1)')
out.push('-- ----------------------------------------------------------------------------')
out.push(...absenceLines)
out.push('')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- 51. VENUE OPERATIONAL STATE (Internal Context — LIMB-16.2.2)')
out.push('-- ----------------------------------------------------------------------------')
out.push(...opsLines)
out.push('')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- 52. PRICING HISTORY (Internal Context — LIMB-16.2.3)')
out.push('-- ----------------------------------------------------------------------------')
out.push(...priceLines)
out.push('')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- 53. MARKETING SPEND — 2025 monthly (Internal Context — LIMB-16.2.4-C)')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- 12 months x 4 venues x ~5 sources. Mix manual_entry + csv_import.')
out.push('-- Seasonal multipliers reflect spring inquiry-peak ad-spend bias.')
out.push(...spendLines)
out.push('')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- 54. CANDIDATE IDENTITIES (Phase B identity resolution)')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- ~50-80 per venue. Clustered from synthetic platform signals.')
out.push(...candLines)
out.push('')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- 55. TANGENTIAL SIGNALS (Phase A identity resolution)')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- ~110 per venue across 2025 with seasonal weighting (Q2/Q3 spike).')
out.push(...signalLines)
out.push('')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- 56. ATTRIBUTION EVENTS — first-touch + nurture per booked wedding')
out.push('-- ----------------------------------------------------------------------------')
out.push(...attribLines)
out.push('')
out.push('-- 56b. Mark resolved candidates after attribution events created.')
out.push(...candResolvedUpdates)
out.push('')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- 57. CULTURAL MOMENTS (External Context — INS-19.5.8)')
out.push('-- ----------------------------------------------------------------------------')
out.push(...cultLines)
out.push('')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- 58. FRED INDICATORS (External Context — Playbook 17.4-A)')
out.push('-- ----------------------------------------------------------------------------')
out.push('-- 12 months of CPIAUCSL / MORTGAGE30US / SP500 / UNRATE / UMCSENT.')
out.push('-- National scope (region NULL). Realistic-ish 2025 values.')
out.push(...fredLines)
out.push('')
out.push('-- ============================================================================')
out.push('-- T5-θ.4 demo Internal + External Context seed — DONE')
out.push('-- ============================================================================')

process.stdout.write(out.join('\n') + '\n')

// Stats to stderr.
const counts = {
  marketing_channels: channelLines.length,
  coordinator_absences: absenceLines.length,
  venue_operational_state: opsLines.length,
  pricing_history: priceLines.length,
  marketing_spend: spendLines.length,
  candidate_identities: candLines.length,
  tangential_signals: signalLines.length,
  attribution_events: attribLines.length,
  candidate_resolved_updates: candResolvedUpdates.length,
  cultural_moments: cultLines.length,
  fred_indicators: fredLines.length,
}
process.stderr.write('Row counts:\n' + JSON.stringify(counts, null, 2) + '\n')
