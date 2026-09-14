/**
 * Bloom House: Validation Utilities
 *
 * Common validation and sanitization helpers used across the platform.
 */

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Validates an email address format.
 */
export function isValidEmail(email: string): boolean {
  const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return pattern.test(email.trim())
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/**
 * Basic phone validation. Accepts US formats:
 * (555) 123-4567, 555-123-4567, 5551234567, +1-555-123-4567
 */
export function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 15
}

// ---------------------------------------------------------------------------
// Hex color
// ---------------------------------------------------------------------------

/**
 * Validates a hex color string (#RGB, #RRGGBB, #RRGGBBAA).
 */
export function isValidHexColor(color: string): boolean {
  return /^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(color)
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/**
 * Validates a URL string.
 */
export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ['http:', 'https:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// HTML sanitization — REMOVED (S5, 2026-09-14 security audit, item 12)
// ---------------------------------------------------------------------------
//
// `sanitizeHtml` lived here: a denylist of tag names, stripped with
// `new RegExp('<' + tag + '[^>]*>')`, plus a pass over `on*=` attributes
// and the literal string `javascript:`.
//
// It did not work, and it could not have. A regex denylist over HTML
// loses to the parser every time:
//
//   <scr<script>ipt>   the inner match is removed and the outer halves
//                      join back up into a live <script>
//   <img src=x onerror = alert(1)>
//                      the attribute pass wants `\s+on\w+\s*=`; a
//                      newline or an unquoted value past the first
//                      space walks straight through
//   <a href="java&#115;cript:...">
//                      entity-encoded, so the `javascript:` strip never
//                      sees it, and the browser decodes it anyway
//   <svg/onload=alert(1)>
//                      no space before the handler at all
//
// A function named "sanitize" that does not sanitize is worse than no
// function, because the next person to need one finds it and stops
// looking. It had no importers anywhere in the repo — it was a loaded
// gun on a shelf, not a live hole — so it is deleted rather than
// rewritten.
//
// If you need to render untrusted HTML: don't. Escape it
// (`escapeHtml` in src/lib/services/contracts/templates.ts) or strip it
// to text (`htmlToText` in src/lib/utils/html-text.ts, which is explicit
// that it produces TEXT and is not a sanitiser). If a surface genuinely
// has to render rich HTML from a stranger, that needs a real parser-based
// sanitiser and its own review, not a helper added back here.

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/**
 * Truncates text to maxLength characters, adding ellipsis if truncated.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 1).trimEnd() + '\u2026'
}

/**
 * Converts text to a URL-safe slug.
 * "The Bloom House!" -> "the-bloom-house"
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')   // Remove non-word chars (except spaces and hyphens)
    .replace(/[\s_]+/g, '-')     // Replace spaces and underscores with hyphens
    .replace(/-+/g, '-')         // Collapse multiple hyphens
    .replace(/^-+|-+$/g, '')     // Trim leading/trailing hyphens
}
