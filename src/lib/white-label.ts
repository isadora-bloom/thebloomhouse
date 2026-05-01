/**
 * Bloom House: white-label text helpers.
 *
 * Single home for the {AI_NAME} placeholder substitution that lives
 * in seed-data and prompt templates. Pre-fix this was three identical
 * `text.replaceAll('{AI_NAME}', aiName)` calls in
 * src/app/_couple-pages/getting-started/page.tsx — fragile because a
 * fourth render site that forgot the wrapper would silently leak the
 * placeholder string to the couple. INV-4.4-A.
 *
 * If the placeholder grammar evolves to add VENUE_NAME / VENUE_PREFIX
 * etc. in the future, extend this helper rather than scattering more
 * replaceAll calls across UI files.
 */

/**
 * Replace {AI_NAME} placeholder with the venue's configured AI name.
 * Falls back to 'Sage' when aiName is empty or undefined — matches
 * the venue_ai_config.ai_name default.
 */
export function substituteAiName(text: string, aiName: string | null | undefined): string {
  if (!text) return text
  const name = aiName && aiName.trim().length > 0 ? aiName : 'Sage'
  return text.replaceAll('{AI_NAME}', name)
}
