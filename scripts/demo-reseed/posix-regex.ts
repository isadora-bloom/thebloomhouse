/**
 * demo-reseed — Postgres regex (`col ~ 'pattern'`) to JS RegExp, conservatively.
 *
 * W75. Postgres CHECK constraints written as `col ~ '...'` use its ARE
 * flavour (POSIX ERE plus a few Tcl extensions). JS regexes overlap with
 * that dialect on the shapes this repo actually uses (anchors, groups,
 * alternation, bracket ranges, `\d`/`\w`/`\s`, counted repeats) and
 * differ on others (`[[:alpha:]]` classes, `\m`/`\y` word boundaries,
 * `\b` meaning backspace, `***` directors, `[[=e=]]` equivalence
 * classes). Rather than translate by hand-waving, this module walks the
 * pattern with an allow-list: anything it can map faithfully it emits,
 * anything else marks the whole pattern untranslatable so the caller
 * skips it with a note instead of pretending to check.
 *
 * Flags: `s` is always set so `.` matches a newline, which is what
 * Postgres does by default (its regexes are not newline-sensitive
 * unless the `n` embedded option is used, and this repo does not use
 * it). `i` is set when the caller says the operator was `~*`.
 */

export type PosixTranslation =
  | { ok: true; regex: RegExp; source: string }
  | { ok: false; reason: string }

/** Escapes allowed outside AND inside a bracket expression. Postgres
 *  ARE treats backslash as an escape in both places, same as JS. The
 *  class escapes are included: `\d \s \w` (and negations) mean the same
 *  thing in both engines for ASCII input, which is all a seed file's
 *  literal values contain. `\b` is deliberately absent, it means
 *  backspace in ARE and word boundary in JS. */
const ESCAPES_ALLOWED = new Set(['d', 'D', 's', 'S', 'w', 'W', 'n', 'r', 't', 'f', 'v'])
const PUNCT_ESCAPES_ALLOWED = new Set(['.', '\\', '/', '^', '$', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '-', "'", '"', ' '])

export function posixEreToJs(pattern: string, caseInsensitive = false): PosixTranslation {
  const untranslatable = (reason: string): PosixTranslation => ({ ok: false, reason })

  if (pattern.startsWith('***')) return untranslatable('ARE `***` director prefix')

  let out = ''
  let i = 0
  const n = pattern.length

  const takeEscape = (): string | null => {
    // pattern[i] === '\\'
    const c = pattern[i + 1]
    if (c === undefined) return null
    if (ESCAPES_ALLOWED.has(c)) {
      i += 2
      return `\\${c}`
    }
    if (PUNCT_ESCAPES_ALLOWED.has(c)) {
      i += 2
      // A backslash-escaped quote or space is just the literal in JS.
      if (c === "'" || c === '"' || c === ' ') return c
      return `\\${c}`
    }
    return null
  }

  while (i < n) {
    const c = pattern[i]!

    if (c === '\\') {
      const esc = takeEscape()
      if (esc === null) return untranslatable(`escape \\${pattern[i + 1] ?? '<end>'} has no faithful JS form`)
      out += esc
      continue
    }

    if (c === '[') {
      // Bracket expression. Walk to the matching `]`, refusing POSIX
      // classes, equivalence classes and collating elements on the way.
      let j = i + 1
      let body = ''
      if (pattern[j] === '^') {
        body += '^'
        j++
      }
      // A `]` first in the bracket is a literal in POSIX; JS needs it escaped.
      if (pattern[j] === ']') {
        body += '\\]'
        j++
      }
      let closed = false
      while (j < n) {
        const d = pattern[j]!
        if (d === ']') {
          closed = true
          j++
          break
        }
        if (d === '[') {
          const next = pattern[j + 1]
          if (next === ':' || next === '=' || next === '.') {
            return untranslatable(`POSIX bracket class \`[${next}...${next}]\` inside a bracket expression`)
          }
          body += '\\['
          j++
          continue
        }
        if (d === '\\') {
          i = j
          const esc = takeEscape()
          if (esc === null) return untranslatable(`escape \\${pattern[j + 1] ?? '<end>'} inside a bracket expression`)
          body += esc
          j = i
          continue
        }
        body += d
        j++
      }
      if (!closed) return untranslatable('unterminated bracket expression')
      out += `[${body}]`
      i = j
      continue
    }

    if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i))
      if (!m) return untranslatable('`{` that is not a counted repeat')
      out += m[0]
      i += m[0].length
      continue
    }

    if (c === '(') {
      if (pattern[i + 1] === '?') {
        const k = pattern[i + 2]
        // Non-capturing group and lookahead read the same in both engines.
        // Anything else after `(?` (embedded options like `(?i)`, named
        // groups, lookbehind) is not translated.
        if (k === ':' || k === '=' || k === '!') {
          out += `(?${k}`
          i += 3
          continue
        }
        return untranslatable(`\`(?${k ?? ''}\` group syntax`)
      }
      out += '('
      i++
      continue
    }

    // Everything else: anchors, `.`, quantifiers, alternation, `)` and
    // literal characters read the same in both engines. A `/` is not
    // special to `new RegExp`, so it needs no escaping.
    out += c
    i++
  }

  const flags = `s${caseInsensitive ? 'i' : ''}`
  try {
    return { ok: true, regex: new RegExp(out, flags), source: out }
  } catch (e) {
    return untranslatable(`JS RegExp rejected the translation: ${e instanceof Error ? e.message : String(e)}`)
  }
}
