// Bloom number formatter — pre-zero base code + post-graduation extension.
//
// Per Playbook INV-2.3-B / BUILD-PLAN T1-C: a wedding's Bloom number is
// `client_codes.code` (e.g. "HM-0847") until it graduates to booked, at
// which point `weddings.code_extension` carries a single-letter suffix
// (e.g. "B") that gets appended. Render sites should never concatenate
// manually — call this so future graduation kinds (C, D, …) flow through.
//
// Returns '' for missing code; the empty render is the caller's job to
// gate (most call sites already do `code && (...)`).

export function formatBloomNumber(
  code: string | null | undefined,
  extension: string | null | undefined,
): string {
  if (!code) return ''
  if (!extension) return code
  return `${code}.${extension}`
}
