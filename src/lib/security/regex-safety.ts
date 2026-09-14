/**
 * Operator-supplied regular expressions, made safe enough to run.
 *
 * S5 (2026-09-14 security audit, item 4).
 *
 * The listing-platform detector runs coordinator-curated regexes from
 * `listing_platform_patterns` against the subject + preview + full body of
 * every inbound interaction. Before this module the add endpoint only
 * checked that the pattern COMPILED, and the detector ran it with no
 * bound on either the pattern or the haystack. `^(a+)+$` compiles fine and
 * then eats the ingestion worker alive on a 40kb email body: catastrophic
 * backtracking, one CPU pegged, every other couple's mail queued behind it.
 *
 * Node has no way to interrupt a regex mid-match. `vm` with a timeout
 * cannot help either, because the regex engine does not yield. So the
 * defence is two-sided and both sides are cheap:
 *
 *   1. Refuse the shapes that backtrack, at the moment a coordinator adds
 *      the pattern. Nested quantifiers (a quantified group whose body is
 *      itself quantified) and backreferences are the two constructs that
 *      turn linear matching exponential. Neither has ever appeared in a
 *      legitimate "this is The Knot's footer" pattern.
 *   2. Cap what the pattern is allowed to see. A bounded haystack bounds
 *      the blow-up even for a pattern that predates this check, because
 *      the exponent is over input length.
 *
 * Existing rows are NOT retro-validated at write time — there is no
 * migration in this workstream — so `safeRegexTest` re-runs the same check
 * at match time and skips a pattern that fails it. That is the belt to the
 * add endpoint's braces, and it is what actually protects the worker from
 * anything already stored.
 */

/** Longest operator-supplied pattern we will store or run. */
export const MAX_PATTERN_LENGTH = 200

/**
 * Longest haystack a stored pattern is allowed to see. Listing-platform
 * chrome lives at the top of an email; 20k characters is several screens
 * of it and well past where any real footer pattern matches.
 */
export const MAX_HAYSTACK_CHARS = 20_000

export type RegexVerdict =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Is the character at `i` escaped by a backslash? Counts the run, because
 * `\\+` is a literal backslash followed by a real quantifier while `\+` is
 * a literal plus.
 */
function isEscaped(source: string, i: number): boolean {
  let backslashes = 0
  for (let j = i - 1; j >= 0 && source[j] === '\\'; j--) backslashes++
  return backslashes % 2 === 1
}

/**
 * Walk the pattern once and report the first disqualifying construct.
 *
 * Deliberately conservative: it does not try to decide whether a given
 * nested quantifier is the exponential kind. Any quantified group holding
 * a quantifier is refused, and the coordinator is told to flatten it.
 */
export function assessRegexSafety(source: string): RegexVerdict {
  if (typeof source !== 'string' || source.length === 0) {
    return { ok: false, reason: 'pattern is empty' }
  }
  if (source.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      reason: `pattern is ${source.length} characters; cap is ${MAX_PATTERN_LENGTH}`,
    }
  }
  if (!compiles(source)) {
    return { ok: false, reason: 'pattern does not compile' }
  }

  // Backreferences: \1..\9 and the named form \k<name>. A backreference
  // forces the engine to remember and re-compare captured text, which is
  // the other classic route into exponential matching.
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '\\' || isEscaped(source, i)) continue
    const next = source[i + 1]
    if (next && next >= '1' && next <= '9') {
      return { ok: false, reason: 'backreferences are not allowed' }
    }
    if (next === 'k' && source[i + 2] === '<') {
      return { ok: false, reason: 'backreferences are not allowed' }
    }
  }

  const nested = findNestedQuantifier(source)
  if (nested) {
    return {
      ok: false,
      reason: `nested quantifier at "${nested}" — a quantified group containing a quantifier backtracks exponentially; flatten it`,
    }
  }

  return { ok: true }
}

/**
 * True when a group closes, is immediately quantified, and its own body
 * carries an unescaped quantifier. `(a+)+`, `(?:\d*)*`, `(ab{2,})+` all
 * trip; `(abc)+`, `a+b+`, `(?:foo|bar)?` do not.
 */
function findNestedQuantifier(source: string): string | null {
  const openStack: number[] = []
  let inClass = false

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (isEscaped(source, i)) continue

    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      continue
    }
    if (ch === '(') {
      openStack.push(i)
      continue
    }
    if (ch !== ')') continue

    const open = openStack.pop()
    if (open === undefined) continue // unbalanced; compile() already passed, so ignore

    const after = source[i + 1]
    const quantified =
      after === '*' || after === '+' || after === '?' || after === '{'
    if (!quantified) continue

    const body = source.slice(open + 1, i)
    if (bodyHasQuantifier(body)) {
      return source.slice(open, Math.min(i + 2, source.length))
    }
  }

  return null
}

/**
 * A quantifier inside a group body, ignoring escaped characters, anything
 * inside a character class, and the `?` that only marks a group flavour
 * (`(?:`, `(?=`, `(?<name>`) rather than repeating anything.
 */
function bodyHasQuantifier(body: string): boolean {
  let inClass = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (isEscaped(body, i)) continue
    if (inClass) {
      if (ch === ']') inClass = false
      continue
    }
    if (ch === '[') {
      inClass = true
      continue
    }
    if (ch === '*' || ch === '+' || ch === '{') return true
    if (ch === '?') {
      // `(?:`, `(?=`, `(?!`, `(?<` — flavour marker, not a repetition.
      if (i > 0 && body[i - 1] === '(') continue
      return true
    }
  }
  return false
}

function compiles(source: string): boolean {
  try {
    new RegExp(source, 'im')
    return true
  } catch {
    return false
  }
}

/**
 * Run a stored pattern against a haystack, bounded on both sides.
 *
 * Returns false rather than throwing for every failure mode — a bad
 * pattern must not be able to fail an ingestion run, only to score
 * nothing. `onSkip` lets the caller log which pattern was refused.
 */
export function safeRegexTest(
  source: string,
  haystack: string,
  onSkip?: (reason: string) => void,
): boolean {
  const verdict = assessRegexSafety(source)
  if (!verdict.ok) {
    onSkip?.(verdict.reason)
    return false
  }
  const bounded =
    haystack.length > MAX_HAYSTACK_CHARS
      ? haystack.slice(0, MAX_HAYSTACK_CHARS)
      : haystack
  try {
    return new RegExp(source, 'im').test(bounded)
  } catch {
    onSkip?.('pattern threw at match time')
    return false
  }
}
