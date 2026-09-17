/**
 * Escape text for safe use inside HTML: element content and quoted
 * attribute values. Moved here from the contract templates when Bloom's
 * own contract generation (W57) was removed on 2026-09-17; invitation
 * emails still need it.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
