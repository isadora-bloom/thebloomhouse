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
// HTML sanitization
// ---------------------------------------------------------------------------

const DANGEROUS_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'textarea',
  'select',
  'button',
  'applet',
  'meta',
  'link',
  'base',
  'style',
]

/**
 * Strips dangerous HTML tags (script, iframe, object, embed, form elements,
 * etc.) from a string. Keeps safe tags like p, br, strong, em, a, ul, li.
 */
export function sanitizeHtml(html: string): string {
  let sanitized = html

  for (const tag of DANGEROUS_TAGS) {
    // Remove opening tags with attributes
    const openPattern = new RegExp(`<${tag}[^>]*>`, 'gi')
    sanitized = sanitized.replace(openPattern, '')

    // Remove closing tags
    const closePattern = new RegExp(`</${tag}>`, 'gi')
    sanitized = sanitized.replace(closePattern, '')
  }

  // Remove event handlers from remaining tags
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
  sanitized = sanitized.replace(/\s+on\w+\s*=\s*\S+/gi, '')

  // Remove javascript: URLs
  sanitized = sanitized.replace(/javascript\s*:/gi, '')

  return sanitized
}

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
