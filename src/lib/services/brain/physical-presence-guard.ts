/**
 * Bloom House — physical-presence guard.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority; AI is software, not a body)
 *   - src/config/prompts/universal-rules.ts (PHYSICAL PRESENCE BOUNDARY)
 *   - feedback_deep_fix_vs_bandaid.md (defence in depth — prompts are the
 *     primary fix; a sanitizer is the belt + suspenders for drafts that
 *     slip through anyway)
 *
 * What this does
 * --------------
 * Scans a generated draft for first-person-singular claims that the AI
 * will physically be present ("I'll show you around", "I can't wait to
 * meet you in person"). Returns:
 *   - the rewritten draft with offending phrases swapped to team-collective
 *   - a list of violations the rewriter detected (for telemetry +
 *     operator-facing review banner on /agent/drafts)
 *
 * Pure function. Called at the end of every draft-build path. Cheap (no
 * AI call) — just regex + replacement.
 */

export interface PhysicalPresenceViolation {
  matched: string
  rewrote_to: string
  offset: number
}

export interface PhysicalPresenceScanResult {
  body: string
  violations: PhysicalPresenceViolation[]
}

// Each rule is a regex over the body + a replacement. Word-boundary
// anchored. Order matters: more specific phrases first so they win
// over the catch-all "I'll" rules.
const RULES: Array<{ pattern: RegExp; replace: string }> = [
  // Verbatim phrasings that keep coming up in training samples + drafts.
  {
    pattern: /\bI(?:'m| am) (looking forward|excited|thrilled) to (?:meeting|seeing|hosting) you\b/gi,
    replace: 'the team is $1 to $2 you',
  },
  {
    pattern: /\bI(?:'d| would)\s+love\s+to\s+(show|give|walk|host|tour|greet|welcome|meet)\b/gi,
    replace: "we'd love to $1",
  },
  {
    pattern: /\bI\s+can(?:'t| not)\s+wait\s+to\s+(show|meet|see|host|welcome|greet|tour|walk)\b/gi,
    replace: "we can't wait to $1",
  },
  {
    pattern: /\bI(?:'ll| will)\s+(show|give|walk|host|tour|greet|welcome|meet|see)\s+you\b/gi,
    replace: 'the team will $1 you',
  },
  {
    pattern: /\bI(?:'d| would) be (happy|honored|delighted|thrilled) to (show|give|walk|host|tour|meet)\b/gi,
    replace: "we'd be $1 to $2",
  },
  {
    pattern: /\bwhen I (see|meet|host|tour|greet|welcome) you\b/gi,
    replace: 'when we meet',
  },
  {
    pattern: /\bI(?:'ll| will) (be there|see you there|meet you there|greet you)\b/gi,
    replace: 'the team will $1',
  },
  // "Looking forward to meeting you" is borderline — accept it (it's the
  // venue's voice, not a literal personal-presence claim). Same with
  // "We can't wait to meet you". Only the I/me/my variants get rewritten.
]

// Detector-only pass: returns true if any rule WOULD fire. Used by
// callers that want to flag-not-fix (e.g. operator-facing draft preview
// that wants to show a warning rather than silently rewrite).
export function containsPhysicalPresenceClaim(body: string): boolean {
  if (!body) return false
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(body)) return true
  }
  return false
}

/**
 * Scan + rewrite. Returns the cleaned body + every violation that fired.
 * Idempotent — re-running on a cleaned body produces no further changes.
 */
export function scrubPhysicalPresenceClaims(body: string): PhysicalPresenceScanResult {
  if (!body) return { body, violations: [] }

  const violations: PhysicalPresenceViolation[] = []
  let working = body

  for (const rule of RULES) {
    // Reset regex state per rule (some patterns are /g).
    rule.pattern.lastIndex = 0
    working = working.replace(rule.pattern, (match, ...args) => {
      const offset = typeof args[args.length - 2] === 'number'
        ? (args[args.length - 2] as number)
        : -1
      // Apply the replacement by re-running with a single-shot regex so
      // we can capture the actual replaced string with substitutions
      // resolved.
      const single = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''))
      const rewritten = match.replace(single, rule.replace)
      violations.push({ matched: match, rewrote_to: rewritten, offset })
      return rewritten
    })
  }

  return { body: working, violations }
}
