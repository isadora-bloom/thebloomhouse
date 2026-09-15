#!/usr/bin/env node
/**
 * deploy-secrets.mjs: the four production secrets the 2026-09-14 security
 * merge requires, set in one run by the operator.
 *
 * Run from the repo root, signed in to Vercel as the team owner:
 *
 *   node scripts/deploy-secrets.mjs            dry run: says what it would do
 *   node scripts/deploy-secrets.mjs --apply    does it
 *   node scripts/deploy-secrets.mjs --apply --only calendly   one step only (cron | calendly | stripe)
 *
 * What it does, in order:
 *   1. CRON_SECRET: replaces the 21-character literal with 32 random bytes
 *      (src/lib/cron-auth.ts refuses anything shorter in production).
 *   2. CRON_SECRET_DESTRUCTIVE: 32 random bytes (the destructive cron tier).
 *   3. CALENDLY_WEBHOOK_SECRET: Bloom House never created its own Calendly
 *      webhook subscription, so there is no stored key to pull. This creates
 *      one with Rixey's Calendly token: organisation scope, invitee.created
 *      and invitee.canceled, pointed at the production webhook route, with a
 *      signing key we choose. Any older subscription on the same URL is
 *      removed first (its key cannot be recovered). It also stamps
 *      venue_config.calendly_tokens.user with the host's user URI, which the
 *      webhook route matches on and which was never set.
 *   4. STRIPE_WEBHOOK_SECRET: Stripe is not wired (no STRIPE_SECRET_KEY
 *      anywhere), so this sets a random value. The route then fails closed
 *      on any delivery, which is correct while no endpoint exists. Replace
 *      it with the whsec_ value from Stripe the day an endpoint is created.
 *
 * Never prints a secret value. Reads .env.local for the Supabase service
 * role only (to reach Rixey's Calendly token) and writes nothing to disk.
 */

import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
// --only calendly (or cron, stripe): run one step, leave the others alone.
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : null })()
const want = (step) => !ONLY || ONLY === step
const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const PROD_REF = 'jsxxgwprxuqgcauzlxcb'
const WEBHOOK_URL = 'https://bloom-house-iota.vercel.app/api/webhooks/calendly'
const CALENDLY_EVENTS = ['invitee.created', 'invitee.canceled']

function loadEnv() {
  const env = {}
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '')
  }
  return env
}

function hex32() {
  return randomBytes(32).toString('hex')
}

function vercel(args, input) {
  // On Windows the CLI is vercel.cmd, which needs a shell; pass one quoted
  // command string rather than args-plus-shell (Node warns about the latter).
  const cmd = process.platform === 'win32' ? `vercel ${args.map((a) => `"${a}"`).join(' ')}` : null
  const r = cmd
    ? spawnSync(cmd, { input, encoding: 'utf8', shell: true })
    : spawnSync('vercel', args, { input, encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { ok: r.status === 0, out: out.replace(/[0-9a-f]{40,}/gi, '<redacted>') }
}

function setEnv(name, value) {
  if (!APPLY) {
    console.log(`  would set ${name} (length ${value.length}) in production`)
    return
  }
  vercel(['env', 'rm', name, 'production', '--yes'])
  const r = vercel(['env', 'add', name, 'production'], value)
  console.log(`  ${r.ok ? 'set' : 'FAILED'} ${name} (length ${value.length})`)
  if (!r.ok) console.log('   ', r.out.trim().split('\n').pop())
}

async function calendly(token, method, path, body) {
  const res = await fetch(`https://api.calendly.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text: text.slice(0, 300) }
}

async function main() {
  const env = loadEnv()
  if (!env.NEXT_PUBLIC_SUPABASE_URL?.includes(PROD_REF)) {
    console.error('This script targets production on purpose; .env.local does not point at it. Stopping.')
    process.exit(2)
  }
  console.log(`\nMode: ${APPLY ? 'APPLY' : 'dry run'}\n`)

  // 1 and 2: cron secrets
  if (want('cron')) {
    console.log('1. CRON_SECRET (rotate to 32 random bytes)')
    setEnv('CRON_SECRET', hex32())
    console.log('2. CRON_SECRET_DESTRUCTIVE')
    setEnv('CRON_SECRET_DESTRUCTIVE', hex32())
  }

  // 3: Calendly subscription + user URI stamp
  if (want('calendly')) {
  console.log('3. CALENDLY_WEBHOOK_SECRET (new subscription, our own signing key)')
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const { data: vc, error: vcErr } = await sb
    .from('venue_config')
    .select('calendly_tokens')
    .eq('venue_id', RIXEY_VENUE_ID)
    .maybeSingle()
  // The venue's stored token first; if Calendly rejects it, CALENDLY_API_TOKEN
  // from .env.local (a fresh personal access token from Calendly's
  // Integrations page), which is then stored on the venue so polling works
  // again. On 2026-09-15 the stored token answered 401.
  let token = vc?.calendly_tokens?.access_token ?? null
  let tokenSource = 'venue_config'
  let me = token ? await calendly(token, 'GET', '/users/me') : { status: 0, json: null, text: 'no stored token' }
  if (me.status !== 200 && env.CALENDLY_API_TOKEN) {
    token = env.CALENDLY_API_TOKEN
    tokenSource = '.env.local CALENDLY_API_TOKEN'
    me = await calendly(token, 'GET', '/users/me')
  }
  if (vcErr || !token) {
    console.log('  no Calendly access token available; skipping the Calendly step', vcErr?.message ?? '')
  } else {
    if (me.status !== 200) {
      console.log(`  Calendly /users/me answered ${me.status} for the ${tokenSource} token. Skipping. ${me.text}`)
      console.log('  Fix: create a personal access token in Calendly (Integrations, API and webhooks) and put it in .env.local as CALENDLY_API_TOKEN, then rerun.')
    } else {
      console.log(`  Calendly token source: ${tokenSource}`)
      const userUri = me.json.resource.uri
      const orgUri = me.json.resource.current_organization
      console.log(`  Calendly user: ${me.json.resource.name ?? '(name hidden)'}; organisation and user URIs resolved`)

      const existing = await calendly(token, 'GET', `/webhook_subscriptions?organization=${encodeURIComponent(orgUri)}&scope=organization`)
      const onOurUrl = (existing.json?.collection ?? []).filter((s) => s.callback_url === WEBHOOK_URL)
      console.log(`  existing organisation subscriptions: ${(existing.json?.collection ?? []).length}, on our URL: ${onOurUrl.length}`)

      const signingKey = hex32()
      if (APPLY) {
        for (const s of onOurUrl) {
          const d = await calendly(token, 'DELETE', `/webhook_subscriptions/${s.uri.split('/').pop()}`)
          console.log(`  removed old subscription (${d.status})`)
        }
        const created = await calendly(token, 'POST', '/webhook_subscriptions', {
          url: WEBHOOK_URL,
          events: CALENDLY_EVENTS,
          organization: orgUri,
          scope: 'organization',
          signing_key: signingKey,
        })
        if (created.status !== 201) {
          console.log(`  Calendly refused the subscription (${created.status}): ${created.text}`)
          console.log('  CALENDLY_WEBHOOK_SECRET not set.')
        } else {
          console.log('  subscription created')
          setEnv('CALENDLY_WEBHOOK_SECRET', signingKey)
          // Stamp the host user URI so the webhook route can find Rixey.
          const merged = { ...(vc?.calendly_tokens ?? {}), access_token: token, user: userUri }
          const { error: upErr } = await sb
            .from('venue_config')
            .update({ calendly_tokens: merged })
            .eq('venue_id', RIXEY_VENUE_ID)
          console.log(`  venue_config.calendly_tokens (access_token from ${tokenSource}, user URI) ${upErr ? 'NOT stamped: ' + upErr.message : 'stamped'}`)
        }
      } else {
        console.log(`  would remove ${onOurUrl.length} old subscription(s), create one (organisation scope, ${CALENDLY_EVENTS.join(', ')}), set CALENDLY_WEBHOOK_SECRET, and stamp calendly_tokens.user`)
      }
    }
  }

  }

  // 4: Stripe placeholder that fails closed
  if (want('stripe')) {
    console.log('4. STRIPE_WEBHOOK_SECRET (Stripe not wired; random value so the route fails closed)')
    setEnv('STRIPE_WEBHOOK_SECRET', `nostripe_${hex32()}`)
  }

  console.log(`\n${APPLY ? 'Done. Now: npm run preflight' : 'Dry run only. Rerun with --apply.'}\n`)
}

main().catch((err) => {
  console.error('FATAL:', String(err?.message ?? err).replace(/[0-9a-f]{40,}/gi, '<redacted>'))
  process.exit(1)
})
