/**
 * Universal shape every platform detector emits per CSV row.
 *
 * Phase A captures EVERYTHING — we don't yet know which fields Phase B's
 * matcher / Phase D's ROI math will need, so the row preserves the
 * original raw_row alongside the parsed fields. extracted_identity in
 * tangential_signals stores all of this.
 */
export interface UniversalSignalRow {
  /** Raw name string as captured by the CSV — "Kara P.", " .", "Sarah  P." */
  name_raw: string | null
  first_name: string | null
  /** Single-letter last initial when only "Sarah P." was provided. */
  last_initial: string | null
  /** Full last name when the platform exposes it. */
  last_name: string | null
  /** Platform-specific handle/username (Instagram @sarah_p, Pinterest pinner). */
  username: string | null
  /** Email when present (Google Business sometimes shows it). */
  email: string | null
  /** Free-text city/state/region — used for fuzzy match disambiguation. */
  city: string | null
  state: string | null
  country: string | null
  /** Action class — view / save / message / follow / etc. See migration 104. */
  action_class: string
  /** ISO date — already parsed by parseVendorDate. Null when format unknown. */
  signal_date: string | null
  /** Free text describing the signal: "Storefront View on the_knot" or
   *  "Followed @rixeymanor on Instagram". Surfaced in the journey timeline. */
  source_context: string
  /** Original CSV row, untouched, in case Phase B needs a column we
   *  didn't think to extract. Stored verbatim in the jsonb. */
  raw_row: Record<string, string>
}

/**
 * The detector contract. Each platform exports an instance of this.
 */
export interface PlatformDetector {
  /** Canonical platform key. Matches normalize-source CANONICAL_SOURCES. */
  key: string
  /** Human-readable label — shown to coordinator on confirmation. */
  displayName: string
  /**
   * Inspect headers + sample rows. Returns null for "not my CSV", or a
   * confidence score (0-100) plus evidence strings the coordinator can
   * see ("matched 'Action Taken' header", "row 3 contains literal
   * 'Storefront View' phrase").
   */
  detect(headers: readonly string[], sampleRows: readonly string[][]): {
    confidence: number
    evidence: string[]
  } | null
  /**
   * Map one CSV row to the universal shape. headers are passed in the
   * same order as row so the detector can locate columns by name.
   */
  mapRow(headers: readonly string[], row: readonly string[]): UniversalSignalRow
}
