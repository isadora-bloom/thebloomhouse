/**
 * Instagram followers parser.
 *
 * The /intel/social-integration capture modal accepts text the operator
 * gathered from the Instagram web UI. There are three realistic paste
 * shapes:
 *
 *   1. One handle per line (output of the JS snippet the modal shows):
 *
 *        rosie.hoyle
 *        jen_bee
 *        mconn
 *
 *   2. The native Instagram web UI followers list, where each row is
 *      something like:
 *
 *        rosie.hoyle
 *        Rosie Hoyle
 *        Followed by jen_bee and 3 others
 *
 *      or the inline single-line variant:
 *
 *        rosie.hoyle  Rosie Hoyle  Followed by jen_bee and 3 others
 *
 *   3. Tab-separated handle + name (rare; some clipboard managers do
 *      this):
 *
 *        rosie.hoyle\tRosie Hoyle
 *
 * Normalization rules
 * -------------------
 *  - Lowercase handle, strip leading @, strip whitespace.
 *  - Drop tokens that contain a dot followed by more than two chars
 *    (looks like a URL, not a handle: example.com) but keep handles
 *    that contain a single dot like rosie.hoyle (this is a real IG
 *    handle shape).
 *  - Drop tokens shorter than 2 characters.
 *  - Drop "Verified", "Followed by …", "Loading…", "Search" stopwords.
 *  - Dedup on handle within the same capture.
 *
 * Returns {handle, display_name?}[] in original order (dedup keeps the
 * first occurrence so the display_name from the richer paste wins).
 */

export interface ParsedFollower {
  handle: string
  display_name: string | null
}

const STOPWORDS = new Set([
  'verified',
  'followed',
  'follow',
  'loading',
  'search',
  'message',
  'remove',
  'suggested',
  'for',
  'you',
])

const FOLLOWED_BY_PREFIX = /^followed by /i

/** Returns true when token looks like a plausible IG handle. */
function isHandleShape(token: string): boolean {
  if (token.length < 2 || token.length > 30) return false
  // IG handles can only contain a-z 0-9 . _ (after lowercasing).
  if (!/^[a-z0-9._]+$/.test(token)) return false
  // URL-like (contains a TLD-shaped tail).
  if (/\.(com|net|org|io|co|app|us|uk|tv|me|ai)\b/.test(token)) return false
  // Numbers only is not a real handle.
  if (/^[0-9._]+$/.test(token)) return false
  return true
}

/** Strip leading @ + whitespace + lowercase. */
function normalize(raw: string): string {
  return raw.replace(/^@/, '').trim().toLowerCase()
}

/** True if line looks like a display-name line ("Rosie Hoyle") -- has a
 *  capital letter and a space and no @ / dot. Used by shape #2. */
function looksLikeDisplayName(line: string): boolean {
  const t = line.trim()
  if (t.length === 0 || t.length > 80) return false
  if (t.includes('@')) return false
  // At least one space + at least one uppercase letter.
  if (!/\s/.test(t)) return false
  if (!/[A-Z]/.test(t)) return false
  return true
}

/** True if line is one of Instagram''s UI strings we should ignore. */
function isUiNoise(line: string): boolean {
  const t = line.trim().toLowerCase()
  if (t.length === 0) return true
  if (FOLLOWED_BY_PREFIX.test(t)) return true
  if (STOPWORDS.has(t)) return true
  // Pure number ("3 others", "1,234").
  if (/^[\d, ]+(others?)?$/.test(t)) return true
  return false
}

/**
 * Parse a single line for shape #3 (tab-separated handle\tname).
 * Returns the handle/name pair or null if the line is not tab-separated.
 */
function parseTabSeparated(line: string): ParsedFollower | null {
  if (!line.includes('\t')) return null
  const parts = line.split('\t').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const handle = normalize(parts[0])
  if (!isHandleShape(handle)) return null
  const display_name = parts[1] && /[A-Za-z]/.test(parts[1]) ? parts[1] : null
  return { handle, display_name }
}

/**
 * Parse a single line for the inline IG shape:
 *
 *   rosie.hoyle  Rosie Hoyle  Followed by jen_bee and 3 others
 *
 * The first token is the handle; the remainder up to "Followed by" or
 * end-of-line is the display name.
 */
function parseInlineUi(line: string): ParsedFollower | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  // Split on 2+ spaces (the Instagram UI uses multiple spaces between cells).
  const cells = trimmed.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean)
  if (cells.length < 2) return null
  const handle = normalize(cells[0])
  if (!isHandleShape(handle)) return null
  // Look at the next cell; if it''s a display-name shape, use it. Otherwise
  // see if it''s "Followed by ..." -- skip.
  const second = cells[1]
  if (FOLLOWED_BY_PREFIX.test(second)) {
    return { handle, display_name: null }
  }
  if (looksLikeDisplayName(second)) {
    return { handle, display_name: second }
  }
  return { handle, display_name: null }
}

/**
 * Parse plain-text Instagram followers paste. Handles all three shapes
 * described in the module docstring.
 */
export function parseInstagramFollowersText(text: string): ParsedFollower[] {
  if (!text || typeof text !== 'string') return []

  const lines = text.split(/\r?\n/)
  const result: ParsedFollower[] = []
  const seen = new Set<string>()

  // First pass: shape #3 (tab-separated) + shape #2 (inline with 2+ spaces).
  // We process line by line and track a "previous handle" so shape #2 in
  // its multi-line variant can attach the next non-noise display-name line.
  let pendingHandle: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue

    // Skip blank / UI-noise lines, but flush pending handle if we hit
    // a "Followed by ..." (it terminates the multi-line record).
    if (isUiNoise(line)) {
      if (pendingHandle) {
        pushIfNew(result, seen, { handle: pendingHandle, display_name: null })
        pendingHandle = null
      }
      continue
    }

    // Tab-separated takes priority.
    const tab = parseTabSeparated(line)
    if (tab) {
      // Flush a pending handle as standalone first.
      if (pendingHandle) {
        pushIfNew(result, seen, { handle: pendingHandle, display_name: null })
        pendingHandle = null
      }
      pushIfNew(result, seen, tab)
      continue
    }

    // Inline UI shape (multiple spaces).
    const inline = parseInlineUi(line)
    if (inline) {
      if (pendingHandle) {
        pushIfNew(result, seen, { handle: pendingHandle, display_name: null })
        pendingHandle = null
      }
      pushIfNew(result, seen, inline)
      continue
    }

    // Otherwise: single-token line. Could be:
    //   - a handle on its own (shape #1)
    //   - a display name following the previous handle (shape #2 multi-line)
    const trimmed = line.trim()
    const candidate = normalize(trimmed)
    if (pendingHandle && looksLikeDisplayName(trimmed)) {
      pushIfNew(result, seen, { handle: pendingHandle, display_name: trimmed })
      pendingHandle = null
      continue
    }

    if (isHandleShape(candidate)) {
      if (pendingHandle) {
        // Previous pending handle had no display-name follow-up; flush it.
        pushIfNew(result, seen, { handle: pendingHandle, display_name: null })
      }
      pendingHandle = candidate
      continue
    }

    // Unrecognized line type -- flush any pending and move on.
    if (pendingHandle) {
      pushIfNew(result, seen, { handle: pendingHandle, display_name: null })
      pendingHandle = null
    }
  }

  if (pendingHandle) {
    pushIfNew(result, seen, { handle: pendingHandle, display_name: null })
  }

  return result
}

function pushIfNew(
  out: ParsedFollower[],
  seen: Set<string>,
  row: ParsedFollower,
) {
  if (seen.has(row.handle)) return
  seen.add(row.handle)
  out.push(row)
}
