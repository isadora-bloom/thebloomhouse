/**
 * Split a Postgres SQL script into top-level statements.
 *
 * Handles:
 *   - Single-quoted string literals: 'foo''bar' → one literal
 *   - Dollar-quoted strings: $$...$$, $tag$...$tag$ (Postgres-specific)
 *   - Line comments: -- ... \n
 *   - Block comments: /* ... *\/ (Postgres allows nesting; we track depth)
 *
 * Splits on semicolons that appear at top level (not inside any quoted /
 * commented region). Trims surrounding whitespace from each chunk.
 * Drops chunks that are empty or comment-only.
 *
 * NOT a full SQL parser — handles patterns observed in this repo's
 * migrations. If a future migration uses C-style escape strings (E'...')
 * with backslash escapes that hide a closing quote, this splitter will
 * mis-handle it. Add a test fixture if that case shows up.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = []
  let buf = ''
  let i = 0
  const n = sql.length

  type State =
    | { kind: 'top' }
    | { kind: 'sq' } // inside '...'
    | { kind: 'dq'; tag: string } // inside $tag$...$tag$
    | { kind: 'line' } // inside -- ...
    | { kind: 'block'; depth: number } // inside /* ... */

  let state: State = { kind: 'top' }

  function peek(off = 0): string {
    return i + off < n ? sql[i + off] : ''
  }

  // Match a dollar-quote opener at position i; returns the tag (or null).
  function matchDollarTag(): string | null {
    if (sql[i] !== '$') return null
    // Dollar-quote tag is [A-Za-z_][A-Za-z_0-9]* OR empty.
    let j = i + 1
    while (j < n && /[A-Za-z0-9_]/.test(sql[j]!)) j++
    if (j >= n || sql[j] !== '$') return null
    return sql.slice(i + 1, j)
  }

  while (i < n) {
    const c = sql[i]!
    const c2 = c + (peek(1) || '')

    if (state.kind === 'top') {
      // Check for state transitions.
      if (c2 === '--') {
        state = { kind: 'line' }
        buf += c2
        i += 2
        continue
      }
      if (c2 === '/*') {
        state = { kind: 'block', depth: 1 }
        buf += c2
        i += 2
        continue
      }
      if (c === "'") {
        state = { kind: 'sq' }
        buf += c
        i++
        continue
      }
      if (c === '$') {
        const tag = matchDollarTag()
        if (tag !== null) {
          state = { kind: 'dq', tag }
          const opener = `$${tag}$`
          buf += opener
          i += opener.length
          continue
        }
      }
      if (c === ';') {
        // Top-level statement terminator.
        const trimmed = buf.trim()
        if (trimmed && !isCommentOnly(trimmed)) {
          out.push(trimmed)
        }
        buf = ''
        i++
        continue
      }
      buf += c
      i++
      continue
    }

    if (state.kind === 'sq') {
      buf += c
      i++
      // Doubled '' inside a literal is an escape, not a terminator.
      if (c === "'") {
        if (peek(0) === "'") {
          buf += peek(0)
          i++
          continue
        }
        state = { kind: 'top' }
      }
      continue
    }

    if (state.kind === 'dq') {
      // Look for the matching $tag$.
      if (c === '$') {
        const closer = `$${state.tag}$`
        if (sql.startsWith(closer, i)) {
          buf += closer
          i += closer.length
          state = { kind: 'top' }
          continue
        }
      }
      buf += c
      i++
      continue
    }

    if (state.kind === 'line') {
      buf += c
      i++
      if (c === '\n') {
        state = { kind: 'top' }
      }
      continue
    }

    if (state.kind === 'block') {
      if (c2 === '/*') {
        state = { kind: 'block', depth: state.depth + 1 }
        buf += c2
        i += 2
        continue
      }
      if (c2 === '*/') {
        const newDepth: number = state.depth - 1
        buf += c2
        i += 2
        state = newDepth === 0 ? { kind: 'top' } : { kind: 'block', depth: newDepth }
        continue
      }
      buf += c
      i++
      continue
    }
  }

  const tail = buf.trim()
  if (tail && !isCommentOnly(tail)) {
    out.push(tail)
  }
  return out
}

function isCommentOnly(s: string): boolean {
  // Strip leading line/block comments, see if anything is left.
  let i = 0
  const n = s.length
  while (i < n) {
    // skip whitespace
    while (i < n && /\s/.test(s[i]!)) i++
    if (i >= n) return true
    if (s[i] === '-' && s[i + 1] === '-') {
      while (i < n && s[i] !== '\n') i++
      continue
    }
    if (s[i] === '/' && s[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (s[i] === '/' && s[i + 1] === '*') { depth++; i += 2; continue }
        if (s[i] === '*' && s[i + 1] === '/') { depth--; i += 2; continue }
        i++
      }
      continue
    }
    return false
  }
  return true
}
