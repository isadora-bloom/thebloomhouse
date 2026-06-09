/**
 * scripts/reprocess-knot-orphan-inquiries.ts
 * ===========================================
 * Identity-link the orphan Knot inbound inquiries that never bound to a couple.
 *
 * THE GAP (diagnosed 2026-06-09 vs prod ref `jsxxgwprxuqgcauzlxcb`)
 * ----------------------------------------------------------------
 * Rixey has 419 rows in legacy `interactions` with:
 *   from_email ILIKE '%member.theknot.com%'  (Knot relay address)
 *   wedding_id IS NULL                        (never bound to a wedding/couple)
 *   type = 'email', direction = 'inbound'
 *   intent_class: 324 new_inquiry / 92 inquiry_followup / 3 auto_reply
 * They predate (or fell through) the live cascade `linkSignal` wiring, so the
 * couples/touchpoints spine never saw them. This routes each through the SAME
 * identity layer the live pipeline uses (`emailToNormalizedSignal` + cascade
 * `linkSignal`) so they mint/attach to couples + land as touchpoints.
 *
 * MODE: IDENTITY-LINK ONLY (operator decision 2026-06-09)
 * ------------------------------------------------------
 * This calls `linkSignal` (the Forwards Linker) DIRECTLY — the identity layer.
 * It does NOT call `processIncomingEmail`, so it NEVER drafts or sends a Sage
 * reply. Routing months-old inquiries through the full pipeline could email
 * real prospects; this path cannot. Writes are limited to the spine
 * (couples / touchpoints / fragments / candidate_matches / progression /
 * telemetry) + are reversible (merge/unmerge), never outbound.
 *
 * IDEMPOTENCY
 * -----------
 * The signal's external_id is `gmail_message_id ?? interaction.id` — the SAME
 * key the live inbound adapter uses (email-to-signal.ts). UNIQUE(venue_id,
 * channel, external_id) on touchpoints makes a re-run a no-op (linkSignal
 * returns action='duplicate').
 *
 * SAFETY
 * ------
 *   - Dry-run by DEFAULT (read-only: previews the matcher's best couple + tier
 *     + would-be action per orphan; writes nothing).
 *   - `--apply` performs the real linkSignal writes.
 *   - `--allow-prod` REQUIRED when --apply AND the URL is the prod ref.
 *   - BACKFILL_VENUE_ID scopes to one venue (default: Rixey).
 *   - LIMIT=N caps how many orphans to process (default: all).
 *
 * USAGE
 *   npx tsx scripts/reprocess-knot-orphan-inquiries.ts              # dry-run, Rixey
 *   npx tsx scripts/reprocess-knot-orphan-inquiries.ts --apply --allow-prod
 *   LIMIT=20 npx tsx scripts/reprocess-knot-orphan-inquiries.ts     # dry-run first 20
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import type { CoupleForMatch } from '../src/lib/services/identity/tracer'

// --- env (mirror .env.local onto process.env; BRANCH_URL/KEY override) ------
if (existsSync('.env.local')) {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  ) as Record<string, string>
  for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v
}

const URL = process.env.BRANCH_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const KEY = process.env.BRANCH_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const PROD_REF = 'jsxxgwprxuqgcauzlxcb'
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const APPLY = process.argv.includes('--apply')
const ALLOW_PROD = process.argv.includes('--allow-prod')
const VENUE_ID = process.env.BACKFILL_VENUE_ID ?? RIXEY
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity

interface OrphanRow {
  id: string
  from_email: string | null
  from_name: string | null
  subject: string | null
  full_body: string | null
  body_preview: string | null
  timestamp: string | null
  created_at: string | null
  gmail_message_id: string | null
  gmail_thread_id: string | null
  rfc2822_headers: Record<string, unknown> | string | null
  intent_class: string | null
}

/** "📩 Doug Loxtercamp sent you a new message" → "Doug Loxtercamp". */
function nameFromSubject(subject: string | null, fallback: string | null): string | null {
  if (subject) {
    const m = subject.replace(/^\s*(?:Fwd:\s*)?📩?\s*/i, '').match(/^(.+?)\s+sent you a/i)
    if (m && m[1].trim()) return m[1].trim()
  }
  return fallback && fallback.trim() ? fallback.trim() : null
}

/**
 * Whether a Knot relay address belongs to the named prospect. The legacy
 * `interactions.from_email` is UNRELIABLE for ~6.5% of these orphans — a
 * "Kyle Duffy" message can carry `john.dubbelde.772357@member.theknot.com`
 * (a different prospect's relay). The relay localpart is
 * `firstname.lastname[.seq].venueId`, so we trust the relay email as the
 * per-prospect key ONLY when its localpart starts with `<first>.<last>` of the
 * subject name. Otherwise we drop it and match on name alone — the relay email
 * is exact-matched by the cascade, so a mismatched one silently fuses two
 * couples (the bug that forced the 2026-06-09 rollback).
 */
function relayEmailTrustworthy(fromEmail: string | null, name: string | null): boolean {
  if (!fromEmail || !name) return false
  const localpart = fromEmail.split('@')[0]?.toLowerCase() ?? ''
  const tokens = name.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return false
  const expectedPrefix = `${tokens[0]}.${tokens[tokens.length - 1]}` // first.last
  return localpart.startsWith(expectedPrefix)
}

async function main() {
  if (!URL || !KEY) {
    console.error('[reprocess-knot] missing Supabase URL/key (set .env.local or BRANCH_URL/BRANCH_KEY).')
    process.exit(1)
  }
  const isProd = URL.includes(PROD_REF)
  if (APPLY && isProd && !ALLOW_PROD) {
    console.error(`[reprocess-knot] REFUSING --apply against prod (${URL}) without --allow-prod.`)
    process.exit(1)
  }

  const supabase: SupabaseClient = createClient(URL, KEY, { auth: { persistSession: false } })
  const { emailToNormalizedSignal } = await import('../src/lib/services/identity/email-to-signal')
  const { linkSignal } = await import('../src/lib/services/identity/forwards-linker')
  const { signalToMatchableRecord, coupleToMatchableRecord, loadRecentCouples } = await import(
    '../src/lib/services/identity/tracer'
  )
  const { scoreCandidate } = await import('../src/lib/services/identity/matcher')
  const { hardContradiction } = await import('../src/lib/services/identity/identity-cascade')
  const { hasSufficientIdentity } = await import('../src/lib/services/identity/mint-couple')

  console.log(
    `[reprocess-knot] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} env=${isProd ? 'PROD' : 'branch'} venue=${VENUE_ID}`,
  )

  // 1. Load orphan Knot inbound inquiries.
  const { data: orphanData, error } = await supabase
    .from('interactions')
    .select(
      'id, from_email, from_name, subject, full_body, body_preview, timestamp, created_at, gmail_message_id, gmail_thread_id, rfc2822_headers, intent_class',
    )
    .eq('venue_id', VENUE_ID)
    .is('wedding_id', null)
    .eq('type', 'email')
    .eq('direction', 'inbound')
    .ilike('from_email', '%member.theknot.com%')
    .order('timestamp', { ascending: true })
    .limit(5000)
  if (error) {
    console.error('[reprocess-knot] load error:', error.message)
    process.exit(1)
  }
  const orphans = ((orphanData ?? []) as OrphanRow[]).slice(0, LIMIT)
  console.log(`[reprocess-knot] ${orphans.length} orphan Knot inbound inquiries to process.\n`)

  // For the dry-run preview, load the venue's couples once and then ACCUMULATE
  // this-run mints into the same array — linkSignal runs with bypassCache:true
  // so each call sees couples minted by earlier orphans. A static snapshot
  // would miss within-run mint→attach dynamics (exactly the Kyle→John fusion
  // that forced the rollback), so the preview must be stateful to be faithful.
  const couples = await loadRecentCouples(supabase, VENUE_ID)
  const mintedThisRun = new Set<string>()
  const nameOf = (c: CoupleForMatch) => (c.primary_name ?? '').toLowerCase().trim()

  const summary: Record<string, number> = {}
  const fusions: string[] = [] // attaches onto a DIFFERENT-named this-run mint
  let synthSeq = 0
  let i = 0
  for (const o of orphans) {
    i++
    const occurredAt = o.timestamp ?? o.created_at ?? new Date().toISOString()
    const prospectName = nameFromSubject(o.subject, o.from_name)
    // Trust the relay address as the per-prospect key ONLY when its localpart
    // matches the subject name; otherwise drop it (legacy from_email is
    // mismatched for ~6.5% of these orphans) and match on name alone.
    const trustedEmail = relayEmailTrustworthy(o.from_email, prospectName) ? o.from_email : null
    const signal = emailToNormalizedSignal({
      email: { messageId: o.gmail_message_id, threadId: o.gmail_thread_id, subject: o.subject },
      interactionId: o.id,
      emailDate: occurredAt,
      rawFromName: prospectName,
      rawFromEmail: trustedEmail, // null when the relay address ≠ the subject name
      weddingId: null,
      fullBody: o.full_body ?? o.body_preview ?? null,
      rfc2822Headers: o.rfc2822_headers ?? null,
      channelOverride: 'knot',
      actionTypeOverride: 'channel_inquiry',
    })

    if (APPLY) {
      try {
        const r = await linkSignal({
          supabase,
          venueId: VENUE_ID,
          signal,
          bypassCache: true,
          source: 'reprocess:knot_orphan_inquiry',
        })
        summary[r.action] = (summary[r.action] ?? 0) + 1
        console.log(
          `  [${i}/${orphans.length}] ${prospectName ?? o.from_email} → ${r.action}` +
            ` couple=${r.matched_couple_id?.slice(0, 8) ?? 'none'} tier=${r.tier ?? '-'}`,
        )
      } catch (e) {
        summary['error'] = (summary['error'] ?? 0) + 1
        console.error(`  [${i}/${orphans.length}] ${prospectName ?? o.from_email} → ERROR ${(e as Error).message}`)
      }
    } else {
      // Stateful read-only preview mirroring linkSignal: score against the
      // accumulating couples, apply the Tier-1.5 hardContradiction demote,
      // route by tier, and ADD a synthetic couple to the array on a mint so
      // later orphans can match it (the within-run dynamic).
      const sigRec = signalToMatchableRecord(signal)
      let best: { c: CoupleForMatch; score: number; tier: string } | null = null
      for (const c of couples) {
        const v = scoreCandidate(sigRec, coupleToMatchableRecord(c))
        if (!best || v.score > best.score) best = { c, score: v.score, tier: v.tier }
      }
      let tier = best?.tier ?? 'below_threshold'
      // Tier-1.5 guard (mirror forwards-linker): a hard contradiction demotes.
      if (best && tier !== 'below_threshold') {
        const contradiction = hardContradiction(
          signal.primary_email,
          signal.wedding_date,
          [best.c.primary_email, best.c.partner_email],
          best.c.wedding_date,
          {
            signalPrimaryName: signal.primary_name,
            signalPartnerName: signal.partner_name,
            candidateNames: [best.c.primary_name, best.c.partner_name],
          },
        )
        if (contradiction) tier = 'below_threshold'
      }
      let action: string
      if (best && tier === 'high') {
        action = 'attach'
        // Fusion check: attaching onto a couple MINTED earlier in this run
        // whose name differs from this prospect = a wrong fuse (the bug).
        if (mintedThisRun.has(best.c.id) && nameOf(best.c) !== (prospectName ?? '').toLowerCase().trim()) {
          fusions.push(`${prospectName ?? o.from_email} → ${best.c.primary_name} (couple ${best.c.id})`)
        }
      } else if (best && (tier === 'medium' || tier === 'low')) {
        action = `candidate_${tier}`
      } else if (hasSufficientIdentity(signal)) {
        action = 'mint'
        // Synthesize the minted couple so subsequent orphans can match it.
        const synth: CoupleForMatch = {
          id: `synth-${synthSeq++}`,
          primary_name: signal.primary_name,
          primary_email: signal.primary_email,
          primary_phone: signal.primary_phone,
          partner_name: signal.partner_name,
          partner_email: signal.partner_email,
          partner_phone: signal.partner_phone,
          wedding_date: signal.wedding_date,
          source_wedding_id: null,
        }
        couples.push(synth)
        mintedThisRun.add(synth.id)
      } else {
        action = 'fragment'
      }
      summary[action] = (summary[action] ?? 0) + 1
      console.log(
        `  [${i}/${orphans.length}] ${prospectName ?? o.from_email} → ~${action}` +
          ` best=${best?.c.id.slice(0, 8) ?? 'none'} score=${best?.score ?? 0} tier=${tier}`,
      )
    }
  }

  console.log(`\n[reprocess-knot] ${APPLY ? 'APPLIED' : 'DRY-RUN'} summary:`)
  for (const [k, v] of Object.entries(summary).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k}: ${v}`)
  }
  if (!APPLY) {
    console.log(
      `\n  cross-name fusions onto this-run mints: ${fusions.length}` +
        (fusions.length ? '  ← REVIEW (should be 0):' : '  ✓'),
    )
    for (const f of fusions.slice(0, 20)) console.log(`    ⚠ ${f}`)
    console.log('\n  (dry-run: nothing written. Re-run with --apply --allow-prod to link.)')
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('[reprocess-knot] fatal:', e)
    process.exit(1)
  },
)
