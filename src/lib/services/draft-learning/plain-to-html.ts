/**
 * Bloom House - Wave 26 plain-text-to-HTML email body converter.
 *
 * Anchor: feedback Wave 26 Item 2. The current Sage flow writes
 * draft_body as plain text and Gmail send uses text/plain MIME.
 * Hyperlinks the operator types (or that Sage proposes) render as bare
 * URLs in the recipient's inbox. The fix is two-sided:
 *   1. Preview side - we render a hyperlinked version of the same
 *      text in the approval UI so the operator sees what the recipient
 *      will see. (Handled in the React component via the same regex.)
 *   2. Send side - we emit a multipart/alternative MIME with both a
 *      text/plain part (the raw body) AND a text/html part where
 *      URLs are <a>-wrapped and newlines become <br>.
 *
 * The HTML is intentionally simple: no fancy CSS, no inline styles
 * beyond a minimal a-tag color. The goal is "links work"; full HTML
 * email theming is a Wave 27+ concern.
 *
 * Detection regex matches:
 *   - http://... and https://...
 *   - bare www.example.com style domains (rendered with auto http://)
 *   - mailto:user@example.com
 *   - bare email addresses (auto-wrapped as mailto:)
 *
 * No external deps - keeps this safe for both the Gmail send path
 * (Node) and the React preview component.
 */

// URL pattern. Match http(s), www., and email addresses.
// Captures the URL/email so the wrapper knows what to link to.
// Trailing punctuation (.,;:!?) is excluded from the match so a
// sentence-ending period doesn't get included in the href.
const URL_PATTERN =
  /\b((?:https?:\/\/|www\.)[^\s<>()"']+[^\s<>()"'.,;:!?\]])|([\w.+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/g

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface LinkSpan {
  /** Inclusive start index in the source body. */
  start: number
  /** Exclusive end index in the source body. */
  end: number
  /** The verbatim text matched (display label). */
  display: string
  /** The href to use (with http:// added for bare www., or mailto: for emails). */
  href: string
}

/** Find every linkable span in a plain-text body. Returned in order
 *  of appearance, non-overlapping. */
export function detectLinks(body: string): LinkSpan[] {
  if (!body) return []
  const spans: LinkSpan[] = []
  // Reset the regex state since it's stateful when /g.
  URL_PATTERN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_PATTERN.exec(body)) !== null) {
    const display = m[0]
    let href: string
    if (m[2]) {
      // Email match.
      href = `mailto:${m[2]}`
    } else {
      // URL match. Auto-prepend http:// for bare www.
      href = display.startsWith('www.') ? `http://${display}` : display
    }
    spans.push({
      start: m.index,
      end: m.index + display.length,
      display,
      href,
    })
  }
  return spans
}

/** Convert a plain-text email body to a minimal HTML rendering with
 *  hyperlinks + line breaks. Used by the Gmail send path so the
 *  recipient's mail client renders URLs as clickable links. */
export function plainTextToEmailHtml(body: string): string {
  if (!body) return ''

  const spans = detectLinks(body)
  if (spans.length === 0) {
    // No links - just escape + line breaks.
    return escapeHtml(body).replace(/\n/g, '<br>\n')
  }

  const out: string[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) {
      out.push(escapeHtml(body.slice(cursor, span.start)))
    }
    const display = escapeHtml(span.display)
    const href = escapeHtml(span.href)
    out.push(
      `<a href="${href}" style="color:#7D8471;text-decoration:underline" target="_blank" rel="noopener noreferrer">${display}</a>`,
    )
    cursor = span.end
  }
  if (cursor < body.length) {
    out.push(escapeHtml(body.slice(cursor)))
  }

  // Wrap in a minimal container so mail clients have a body root.
  // Newlines -> <br> for HTML rendering.
  return out.join('').replace(/\n/g, '<br>\n')
}

/** Convenience wrapper that returns both the plain and HTML parts.
 *  The Gmail send path uses both when building multipart/alternative. */
export function buildEmailBodyParts(body: string): {
  plain: string
  html: string
  hasLinks: boolean
} {
  const spans = detectLinks(body)
  return {
    plain: body,
    html: plainTextToEmailHtml(body),
    hasLinks: spans.length > 0,
  }
}
