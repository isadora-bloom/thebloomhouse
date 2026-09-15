#!/usr/bin/env node
/**
 * Guard: no phantom role name on a server-side decision surface.
 *
 * The bug class, 2026-09-15: getPlatformAuth admitted 'manager', a value
 * user_profiles.role cannot hold, and not 'venue_manager', the value it
 * does hold. Every venue manager signed in and then got 401 from all
 * 372 API routes. Fifteen more lists across the API carried the same
 * name. The vocabulary now lives in src/lib/auth/roles.ts and this
 * script refuses a new hand-typed copy.
 *
 * 'admin', 'owner' and 'viewer' are not checked: 'admin' is a real word
 * in the email local-part lists under src/lib/services/identity, and
 * none of the three has ever been compared against a role on a server
 * surface. Add a name here the day it turns up in one.
 *
 * Usage:
 *
 *   node scripts/check-role-vocab.mjs
 *
 * Exit 0 = clean. Exit 1 = a phantom is back.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

const SURFACES = [
  join(REPO_ROOT, 'src', 'app', 'api'),
  join(REPO_ROOT, 'src', 'lib', 'api'),
  join(REPO_ROOT, 'src', 'lib', 'auth'),
  join(REPO_ROOT, 'src', 'lib', 'services'),
  join(REPO_ROOT, 'src', 'middleware.ts'),
]

/** The only file allowed to spell a phantom, because it maps it. */
const EXEMPT = new Set([join(REPO_ROOT, 'src', 'lib', 'auth', 'roles.ts')])

const PHANTOMS = ['manager', 'group_admin']
const PATTERN = new RegExp(`['"\`](${PHANTOMS.join('|')})['"\`]`)

/** A line that only mentions the name in prose. */
const COMMENT = /^\s*(\/\/|\*|\/\*)/

const OFFENDERS = []

function scan(file) {
  if (EXEMPT.has(file)) return
  if (file.includes('__tests__')) return
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    if (COMMENT.test(line)) return
    if (PATTERN.test(line)) OFFENDERS.push(`${relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`)
  })
}

function walk(path) {
  const st = statSync(path)
  if (st.isFile()) {
    if (/\.(ts|tsx)$/.test(path)) scan(path)
    return
  }
  for (const entry of readdirSync(path)) {
    if (entry === 'node_modules' || entry === '.next') continue
    walk(join(path, entry))
  }
}

for (const s of SURFACES) walk(s)

if (OFFENDERS.length) {
  console.error('check-role-vocab: phantom role name on a server surface.')
  console.error('user_profiles.role never holds these; read from src/lib/auth/roles.ts instead.\n')
  for (const o of OFFENDERS) console.error('  ' + o)
  process.exit(1)
}
console.log('check-role-vocab: clean')
