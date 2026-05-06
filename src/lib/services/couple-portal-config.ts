// ---------------------------------------------------------------------------
// Couple-portal venue config loader
// ---------------------------------------------------------------------------
//
// Single source of truth for the venue-specific operational details that
// coordinators enter on the admin side and the couple portal renders. Each
// admin config page (`/portal/<*>-config`) writes a sub-object onto
// `venue_config.feature_flags`, e.g. `feature_flags.bar_config`, and a few
// columns on `venue_config` itself (`bar_model`, `catering_model`). The
// couple portal pages used to spread those reads inline; this helper
// consolidates them so:
//
//  1. Couple pages can ask once for the full config blob and cherry-pick
//     the slice they need.
//  2. Naming drift between admin write and couple read is caught in one
//     place. The 2026-05-06 wiring sweep turned up two real drifts:
//       - rehearsal couple page read `flags.rehearsal_space_options`
//         while admin wrote `flags.rehearsal_config.venue_spaces`.
//       - bar couple page read `flags.bar_config.default_bar_type` /
//         `default_guest_count` which admin never wrote (it writes
//         `bar_mode`, `packages`, `bartender_rate`, ...).
//     This loader maps both shapes onto a single canonical surface.
//  3. RLS: every read takes a `venueId` argument. The caller is responsible
//     for resolving that id from the validated `venue-slug` cookie (couple
//     layout already does this) — never from a client-controlled query
//     param. The browser supabase client honours anon RLS policies so a
//     misuse would still 0-row, but we don't rely on that.
//
// All admin write surfaces live under
// `src/app/(platform)/portal/<*>-config/page.tsx`. When adding a new admin
// config block, update both the relevant admin page and the matching
// `Venue<X>Config` interface here.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BarMode = 'calculator' | 'package' | 'hybrid'

export interface BarPackage {
  id: string
  name: string
  description?: string
  price_per_guest?: number | null
  inclusions?: string[]
}

export interface VenueBarConfig {
  // Top-level venue_config column (in_house | byob | hybrid)
  bar_model: string | null
  // feature_flags.bar_config sub-object (admin-managed)
  bar_mode: BarMode | null
  packages: BarPackage[]
  locations: string[]
  bartender_rate: number | null
  guests_per_bartender: number | null
  notes_to_couples: string
  // Couple-side defaults (legacy keys, kept for backward compat)
  default_bar_type: string | null
  default_guest_count: number | null
}

export interface VenueRehearsalConfig {
  venue_spaces: string[]
  food_options: string[]
  linen_info: string
  max_guests: number | null
  notes_to_couples: string
}

export interface PickupLocation {
  name: string
  address?: string
}

export interface VenueShuttleConfig {
  pickup_locations: PickupLocation[]
  available_shuttles: number | null
  seats_per_shuttle: number | null
  shuttle_provider: string
  arrival_buffer_minutes: number | null
  notes_to_couples: string
}

export interface VenueFloorPlanConfig {
  url: string | null
  venue_width_ft: number | null
  venue_depth_ft: number | null
}

export interface VenueSeatingConfig {
  notes_to_couples: string
  default_table_size: number | null
}

export interface LinenColor {
  id?: string
  name: string
  hex?: string
}

export interface VenueTablesConfig {
  table_types: Record<string, boolean>
  linen_colors: LinenColor[]
  runner_styles: Record<string, boolean>
  max_capacity: number | null
  linen_notes: string
  extra_tables: Record<string, boolean>
}

export interface VenueStaffingConfig {
  staff_rate: number | null
  available_roles: string[]
  custom_roles: string[]
  minimum_staff: number | null
  guests_per_bartender: number | null
  notes_to_couples: string
}

export interface VenueRoomsConfig {
  notes_to_couples: string
  default_block_size: number | null
}

export interface CouplePortalVenueConfig {
  venueId: string
  catering_model: string | null
  bar: VenueBarConfig
  rehearsal: VenueRehearsalConfig
  shuttle: VenueShuttleConfig
  floorPlan: VenueFloorPlanConfig
  seating: VenueSeatingConfig
  tables: VenueTablesConfig
  staffing: VenueStaffingConfig
  rooms: VenueRoomsConfig
  /** Raw feature_flags blob for any consumer that needs unmapped keys. */
  rawFeatureFlags: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Defaults — empty rather than venue-specific. Pages should treat empty
// as "admin hasn't configured this yet" and either render an empty state
// or hide the section.
// ---------------------------------------------------------------------------

export const EMPTY_BAR_CONFIG: VenueBarConfig = {
  bar_model: null,
  bar_mode: null,
  packages: [],
  locations: [],
  bartender_rate: null,
  guests_per_bartender: null,
  notes_to_couples: '',
  default_bar_type: null,
  default_guest_count: null,
}

export const EMPTY_REHEARSAL_CONFIG: VenueRehearsalConfig = {
  venue_spaces: [],
  food_options: [],
  linen_info: '',
  max_guests: null,
  notes_to_couples: '',
}

export const EMPTY_SHUTTLE_CONFIG: VenueShuttleConfig = {
  pickup_locations: [],
  available_shuttles: null,
  seats_per_shuttle: null,
  shuttle_provider: '',
  arrival_buffer_minutes: null,
  notes_to_couples: '',
}

export const EMPTY_FLOOR_PLAN: VenueFloorPlanConfig = {
  url: null,
  venue_width_ft: null,
  venue_depth_ft: null,
}

export const EMPTY_SEATING_CONFIG: VenueSeatingConfig = {
  notes_to_couples: '',
  default_table_size: null,
}

export const EMPTY_TABLES_CONFIG: VenueTablesConfig = {
  table_types: {},
  linen_colors: [],
  runner_styles: {},
  max_capacity: null,
  linen_notes: '',
  extra_tables: {},
}

export const EMPTY_STAFFING_CONFIG: VenueStaffingConfig = {
  staff_rate: null,
  available_roles: [],
  custom_roles: [],
  minimum_staff: null,
  guests_per_bartender: null,
  notes_to_couples: '',
}

export const EMPTY_ROOMS_CONFIG: VenueRoomsConfig = {
  notes_to_couples: '',
  default_block_size: null,
}

// ---------------------------------------------------------------------------
// Mappers — translate the raw feature_flags blob into the typed sub-configs
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

export function mapBarConfig(
  flags: Record<string, unknown>,
  barModel: string | null
): VenueBarConfig {
  const bc = asRecord(flags.bar_config)
  return {
    bar_model: barModel,
    bar_mode: (bc.bar_mode as BarMode) ?? null,
    packages: Array.isArray(bc.packages) ? (bc.packages as BarPackage[]) : [],
    locations: asStringArray(bc.locations),
    bartender_rate: asNumberOrNull(bc.bartender_rate),
    guests_per_bartender: asNumberOrNull(bc.guests_per_bartender),
    notes_to_couples: asString(bc.notes_to_couples),
    default_bar_type: typeof bc.default_bar_type === 'string' ? bc.default_bar_type : null,
    default_guest_count: asNumberOrNull(bc.default_guest_count),
  }
}

export function mapRehearsalConfig(flags: Record<string, unknown>): VenueRehearsalConfig {
  // Canonical: feature_flags.rehearsal_config.venue_spaces (admin write).
  // Legacy: feature_flags.rehearsal_space_options (couple-page read pre-fix).
  // Read both so a venue that was configured against either shape still works.
  const rc = asRecord(flags.rehearsal_config)
  const legacySpaces = asStringArray(flags.rehearsal_space_options)
  const venueSpaces = asStringArray(rc.venue_spaces)
  return {
    venue_spaces: venueSpaces.length > 0 ? venueSpaces : legacySpaces,
    food_options: asStringArray(rc.food_options),
    linen_info: asString(rc.linen_info),
    max_guests: asNumberOrNull(rc.max_guests),
    notes_to_couples: asString(rc.notes_to_couples),
  }
}

export function mapShuttleConfig(flags: Record<string, unknown>): VenueShuttleConfig {
  const sc = asRecord(flags.shuttle_config)
  const rawPickups = Array.isArray(sc.pickup_locations) ? sc.pickup_locations : []
  const pickup_locations: PickupLocation[] = rawPickups
    .map((entry) => {
      if (typeof entry === 'string') return { name: entry }
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>
        const name = asString(e.name)
        if (!name) return null
        return { name, address: typeof e.address === 'string' ? e.address : undefined }
      }
      return null
    })
    .filter((v): v is PickupLocation => v !== null)
  return {
    pickup_locations,
    available_shuttles: asNumberOrNull(sc.available_shuttles),
    seats_per_shuttle: asNumberOrNull(sc.seats_per_shuttle),
    shuttle_provider: asString(sc.shuttle_provider),
    arrival_buffer_minutes: asNumberOrNull(sc.arrival_buffer_minutes),
    notes_to_couples: asString(sc.notes_to_couples),
  }
}

export function mapFloorPlan(flags: Record<string, unknown>): VenueFloorPlanConfig {
  return {
    url: typeof flags.floor_plan_url === 'string' ? (flags.floor_plan_url as string) : null,
    venue_width_ft: asNumberOrNull(flags.floor_plan_venue_width_ft),
    venue_depth_ft: asNumberOrNull(flags.floor_plan_venue_depth_ft),
  }
}

export function mapSeatingConfig(flags: Record<string, unknown>): VenueSeatingConfig {
  const sc = asRecord(flags.seating_config)
  return {
    notes_to_couples: asString(sc.notes_to_couples),
    default_table_size: asNumberOrNull(sc.default_table_size),
  }
}

export function mapTablesConfig(flags: Record<string, unknown>): VenueTablesConfig {
  const tc = asRecord(flags.tables_config)
  return {
    table_types: asRecord(tc.table_types) as Record<string, boolean>,
    linen_colors: Array.isArray(tc.linen_colors) ? (tc.linen_colors as LinenColor[]) : [],
    runner_styles: asRecord(tc.runner_styles) as Record<string, boolean>,
    max_capacity: asNumberOrNull(tc.max_capacity),
    linen_notes: asString(tc.linen_notes),
    extra_tables: asRecord(tc.extra_tables) as Record<string, boolean>,
  }
}

export function mapStaffingConfig(flags: Record<string, unknown>): VenueStaffingConfig {
  const sc = asRecord(flags.staffing_config)
  return {
    staff_rate: asNumberOrNull(sc.staff_rate),
    available_roles: asStringArray(sc.available_roles),
    custom_roles: asStringArray(sc.custom_roles),
    minimum_staff: asNumberOrNull(sc.minimum_staff),
    guests_per_bartender: asNumberOrNull(sc.guests_per_bartender),
    notes_to_couples: asString(sc.notes_to_couples),
  }
}

export function mapRoomsConfig(flags: Record<string, unknown>): VenueRoomsConfig {
  const rc = asRecord(flags.rooms_config)
  return {
    notes_to_couples: asString(rc.notes_to_couples),
    default_block_size: asNumberOrNull(rc.default_block_size),
  }
}

// ---------------------------------------------------------------------------
// loadCoupleVenueConfig — primary entrypoint
// ---------------------------------------------------------------------------

/**
 * Load the full couple-portal venue config in one round-trip.
 *
 * Pass the supabase client the calling page already created (browser anon
 * client for the couple portal) — this function does NOT instantiate its
 * own client so it works in client components, server components, and
 * tests alike.
 *
 * `venueId` MUST come from a trusted source (the validated `venue-slug`
 * cookie, set by middleware, resolved by the couple layout). Never accept
 * a venueId from a query param.
 */
export async function loadCoupleVenueConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>,
  venueId: string
): Promise<CouplePortalVenueConfig> {
  const { data } = await supabase
    .from('venue_config')
    .select('feature_flags, bar_model, catering_model')
    .eq('venue_id', venueId)
    .maybeSingle()

  const flags = (data?.feature_flags ?? {}) as Record<string, unknown>
  const barModel = (data?.bar_model as string | null) ?? null
  const cateringModel = (data?.catering_model as string | null) ?? null

  return {
    venueId,
    catering_model: cateringModel,
    bar: mapBarConfig(flags, barModel),
    rehearsal: mapRehearsalConfig(flags),
    shuttle: mapShuttleConfig(flags),
    floorPlan: mapFloorPlan(flags),
    seating: mapSeatingConfig(flags),
    tables: mapTablesConfig(flags),
    staffing: mapStaffingConfig(flags),
    rooms: mapRoomsConfig(flags),
    rawFeatureFlags: flags,
  }
}

// ---------------------------------------------------------------------------
// Slice loaders — for pages that only need one section. Each takes the
// same supabase client + venueId and returns the typed sub-config.
// ---------------------------------------------------------------------------

async function loadFlags(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>,
  venueId: string,
  extraColumns: string[] = []
): Promise<{ flags: Record<string, unknown>; row: Record<string, unknown> | null }> {
  const select = ['feature_flags', ...extraColumns].join(', ')
  const { data } = await supabase
    .from('venue_config')
    .select(select)
    .eq('venue_id', venueId)
    .maybeSingle()
  const row = (data ?? null) as Record<string, unknown> | null
  const flags = (row?.feature_flags ?? {}) as Record<string, unknown>
  return { flags, row }
}

export async function loadBarConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>,
  venueId: string
): Promise<VenueBarConfig> {
  const { flags, row } = await loadFlags(supabase, venueId, ['bar_model'])
  return mapBarConfig(flags, (row?.bar_model as string | null) ?? null)
}

export async function loadRehearsalConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>,
  venueId: string
): Promise<VenueRehearsalConfig> {
  const { flags } = await loadFlags(supabase, venueId)
  return mapRehearsalConfig(flags)
}

export async function loadShuttleConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>,
  venueId: string
): Promise<VenueShuttleConfig> {
  const { flags } = await loadFlags(supabase, venueId)
  return mapShuttleConfig(flags)
}

export async function loadFloorPlan(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>,
  venueId: string
): Promise<VenueFloorPlanConfig> {
  const { flags } = await loadFlags(supabase, venueId)
  return mapFloorPlan(flags)
}

export async function loadTablesConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>,
  venueId: string
): Promise<VenueTablesConfig> {
  const { flags } = await loadFlags(supabase, venueId)
  return mapTablesConfig(flags)
}

export async function loadStaffingConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>,
  venueId: string
): Promise<VenueStaffingConfig> {
  const { flags } = await loadFlags(supabase, venueId)
  return mapStaffingConfig(flags)
}

export async function loadRoomsConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>,
  venueId: string
): Promise<VenueRoomsConfig> {
  const { flags } = await loadFlags(supabase, venueId)
  return mapRoomsConfig(flags)
}

export async function loadSeatingConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, 'public', any>,
  venueId: string
): Promise<VenueSeatingConfig> {
  const { flags } = await loadFlags(supabase, venueId)
  return mapSeatingConfig(flags)
}
