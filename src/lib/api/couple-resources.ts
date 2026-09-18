/**
 * The couple portal's writable resources, in one place.
 *
 * Every couple-facing page writes straight from the browser with the anon
 * client: 126 write sites across 25 pages and 34 tables. That works, because
 * RLS holds, but it means there is no server-side moment for any write. Nothing
 * logs, nothing validates beyond the column types, and the scope of each row is
 * whatever the browser put in the payload.
 *
 * The cost of that showed up at Rixey. A couple spent three days telling us her
 * wedding party was missing from her website; it was a section toggle, and
 * nobody could see when it had been set or by whom, because saving the website
 * wrote nothing anywhere. The same was true here, for everything a couple
 * touches.
 *
 * Rather than 126 hand-written handlers, one route reads this table:
 * src/app/api/couple/[resource]/route.ts. Each entry says what may be written,
 * what to call the entry in the feed, and which column holds the name to print.
 * A table missing from here cannot be written through the route at all, which
 * is the point: adding a resource is a deliberate line rather than whatever the
 * client happened to send.
 *
 * `src/lib/api/__tests__/couple-resources.test.ts` checks every table and every
 * column named here against src/lib/supabase/types.generated.ts, so a rename in
 * the schema fails the build rather than quietly turning every feed entry into
 * "added an item".
 */

export interface CoupleResource {
  /** The table written. */
  table: string
  /** Columns a couple may set. Anything else in the body is refused. */
  fields: readonly string[]
  /** Stem for the activity type: <stem>_added / _updated / _removed. */
  stem: string
  /** Column holding the thing's name, for the feed's details line. */
  nameColumn: string | null
  /** What to call it when there is no name to use. */
  noun: string
  /**
   * One row per wedding, addressed by wedding rather than by id. These are
   * whole-form saves: the page sends the lot and the route upserts it.
   */
  singleton?: true
  /**
   * What the singleton's unique index is on. Not every one is `wedding_id`:
   * wedding_config, rsvp_config and wedding_worksheets are unique on
   * (venue_id, wedding_id), and upserting with the wrong target inserts a
   * second row instead of updating the first.
   */
  conflictTarget?: string
  /**
   * Rows in other tables that have to go before this one can.
   *
   * The pages did these by hand, in two statements from the browser, so a
   * failure between them left an orphan nobody would notice: deleting a budget
   * item cleared its payments first, and deleting a guest tag cleared its
   * assignments. On the server it is one request that either happens or does
   * not.
   */
  cascades?: readonly { table: string; column: string }[]
  /**
   * Which scope columns the table actually has.
   *
   * Almost everything carries both. `ceremony_chair_plans` carries only
   * `wedding_id`, and writing a venue_id it does not have fails the insert, so
   * the route has to be told rather than assume.
   *
   * A table with neither cannot go through this route at all: there would be
   * nothing to filter on, and the id alone is not proof it belongs to the
   * caller. guest_tag_assignments is that case, and has its own endpoint.
   */
  scope?: 'venue+wedding' | 'wedding'
  /**
   * High-volume tables. The feed takes constant wording for these, with no name
   * and no count, so an evening of edits collapses into one entry rather than
   * two hundred. See coupleActivity below.
   */
  burst?: true
  /**
   * The page owns the whole list and sends it entire.
   *
   * guest_care_notes works this way: the form is a list, and saving it cleared
   * every row for the wedding and re-inserted the lot. Two statements from the
   * browser, so a failure on the second left the couple with none of their
   * notes and nothing saying so. PUT does it in one request.
   */
  replaceAll?: true
  /**
   * A column recording who added the row, filled from the session.
   *
   * inspo_gallery and photo_library both have one, and the pages were sending
   * it themselves, which means it was only ever as trustworthy as the client.
   * Authorship decides who may delete a pin, so it is set here instead.
   */
  ownerColumn?: string
}

export const COUPLE_RESOURCES: Record<string, CoupleResource> = {
  // ---- Row-per-thing ----
  allergies: {
    table: 'allergy_registry',
    fields: ['guest_id', 'guest_name', 'allergy_type', 'severity', 'notes', 'is_important'],
    stem: 'allergy',
    nameColumn: 'guest_name',
    noun: 'an allergy',
  },
  'bar-recipes': {
    table: 'bar_recipes',
    fields: ['cocktail_name', 'ingredients', 'instructions', 'servings', 'scaling_factor'],
    stem: 'bar_recipe',
    nameColumn: 'cocktail_name',
    noun: 'a recipe',
  },
  'bar-shopping': {
    table: 'bar_shopping_list',
    fields: ['item_name', 'category', 'quantity', 'unit', 'estimated_cost', 'purchased', 'notes'],
    stem: 'bar_shopping_item',
    nameColumn: 'item_name',
    noun: 'a bar item',
  },
  bedrooms: {
    table: 'bedroom_assignments',
    fields: ['room_name', 'room_description', 'guests', 'notes'],
    stem: 'bedroom',
    nameColumn: 'room_name',
    noun: 'a bedroom',
  },
  'budget-items': {
    table: 'budget_items',
    fields: ['item_name', 'category', 'budgeted', 'committed', 'paid', 'notes', 'vendor_name'],
    stem: 'budget_item',
    nameColumn: 'item_name',
    noun: 'a budget line',
    // The page cleared the payments itself, in a separate statement, before
    // deleting the line. A failure between the two left payments pointing at
    // nothing.
    cascades: [{ table: 'budget_payments', column: 'budget_item_id' }],
  },
  'ceremony-order': {
    table: 'ceremony_order',
    fields: ['participant_name', 'role', 'section', 'side', 'sort_order', 'notes'],
    stem: 'ceremony_order',
    nameColumn: 'participant_name',
    noun: 'a ceremony order entry',
  },
  checklist: {
    table: 'checklist_items',
    fields: ['title', 'description', 'category', 'due_date', 'is_completed', 'sort_order', 'assigned_to'],
    stem: 'checklist_task',
    nameColumn: 'title',
    noun: 'a task',
  },
  decor: {
    table: 'decor_inventory',
    fields: ['item_name', 'category', 'quantity', 'source', 'vendor_name', 'notes', 'leaving_instructions', 'image_url'],
    stem: 'decor',
    nameColumn: 'item_name',
    noun: 'a decor item',
  },
  'guest-care': {
    table: 'guest_care_notes',
    fields: ['guest_name', 'care_type', 'note'],
    stem: 'guest_care_note',
    nameColumn: 'guest_name',
    noun: 'a note',
    replaceAll: true,
  },
  'guest-tags': {
    table: 'guest_tags',
    fields: ['tag_name', 'color'],
    stem: 'guest_tag',
    nameColumn: 'tag_name',
    noun: 'a guest tag',
    // Same two-step the page did by hand. guest_tag_assignments carries no
    // scope columns of its own, so it can only be reached this way or through
    // the assignments endpoint.
    cascades: [{ table: 'guest_tag_assignments', column: 'tag_id' }],
  },
  'meal-options': {
    table: 'guest_meal_options',
    fields: ['option_name', 'description', 'is_default'],
    stem: 'meal_option',
    nameColumn: 'option_name',
    noun: 'a meal option',
  },
  makeup: {
    table: 'makeup_schedule',
    fields: ['person_name', 'role', 'hair_time', 'hair_duration', 'makeup_time', 'makeup_duration', 'duration', 'notes', 'sort_order'],
    stem: 'makeup_slot',
    nameColumn: 'person_name',
    noun: 'a hair and makeup slot',
  },
  shuttle: {
    table: 'shuttle_schedule',
    fields: ['run_label', 'route_name', 'pickup_time', 'pickup_location', 'dropoff_time', 'dropoff_location', 'capacity', 'notes'],
    stem: 'shuttle_run',
    nameColumn: 'run_label',
    noun: 'a shuttle run',
  },
  'seating-tables': {
    table: 'seating_tables',
    fields: ['table_name', 'table_type', 'capacity', 'sort_order', 'rotation', 'x_position', 'y_position', 'notes'],
    stem: 'seating_table',
    nameColumn: 'table_name',
    noun: 'a table',
  },
  party: {
    table: 'wedding_party',
    fields: ['name', 'role', 'side', 'relationship', 'bio', 'blurb', 'photo_url', 'sort_order'],
    stem: 'wedding_party',
    nameColumn: 'name',
    noun: 'someone',
  },
  inspo: {
    table: 'inspo_gallery',
    fields: ['image_url', 'caption', 'tags'],
    stem: 'inspo',
    nameColumn: 'caption',
    noun: 'an inspiration photo',
    ownerColumn: 'uploaded_by',
  },
  photos: {
    table: 'photo_library',
    fields: ['image_url', 'caption', 'tags', 'people_tags', 'is_hero', 'is_website'],
    stem: 'photo',
    nameColumn: 'caption',
    noun: 'a photo',
    ownerColumn: 'uploaded_by',
  },

  // ---- High volume: one entry per burst, not per row ----
  guests: {
    table: 'guest_list',
    fields: [
      'first_name', 'last_name', 'email', 'phone', 'address', 'group_name',
      'rsvp_status', 'rsvp_responded_at', 'invitation_sent',
      'meal_choice', 'meal_option_id', 'meal_preference', 'dietary_restrictions',
      'age_bracket', 'origin_state', 'accommodation', 'staying_overnight',
      'accessibility_notes', 'needs_accessibility', 'needs_shuttle', 'care_notes',
      'table_assignment', 'table_assignment_id',
      'has_plus_one', 'plus_one', 'plus_one_name', 'plus_one_rsvp',
      'plus_one_meal_choice', 'plus_one_dietary',
    ],
    stem: 'guest_list',
    nameColumn: 'first_name',
    noun: 'a guest',
    burst: true,
  },

  vendors: {
    table: 'booked_vendors',
    fields: [
      'vendor_name', 'vendor_type', 'is_booked', 'contact_name', 'contact_email',
      'contact_phone', 'vendor_contact', 'website', 'instagram', 'notes',
      'arrival_time', 'departure_time', 'worked_here_before',
      'contract_uploaded', 'contract_url', 'contract_date', 'contract_storage_path',
    ],
    stem: 'vendor',
    nameColumn: 'vendor_name',
    noun: 'a vendor',
  },
  'borrow-selections': {
    table: 'borrow_selections',
    fields: ['catalog_item_id', 'quantity', 'notes'],
    stem: 'borrow_selection',
    nameColumn: null,
    noun: 'an item to borrow',
  },
  'budget-payments': {
    table: 'budget_payments',
    fields: ['budget_item_id', 'amount', 'payment_date', 'payment_method', 'notes'],
    stem: 'budget_payment',
    nameColumn: null,
    noun: 'a payment',
  },
  finalisations: {
    table: 'section_finalisations',
    fields: ['section_name', 'couple_signed_off', 'couple_signed_off_at', 'couple_signed_off_by'],
    stem: 'section_finalisation',
    nameColumn: 'section_name',
    noun: 'a section',
  },

  // ---- One row per wedding: whole-form saves ----
  'bar-planning': {
    table: 'bar_planning',
    fields: ['bar_type', 'bartender_count', 'guest_count', 'selected_package_id', 'notes'],
    stem: 'bar_planning',
    nameColumn: null,
    noun: 'their bar plan',
    singleton: true,
  },
  rehearsal: {
    table: 'rehearsal_dinner',
    fields: ['location_name', 'address', 'date', 'start_time', 'end_time', 'guest_count', 'menu_notes', 'special_arrangements'],
    stem: 'rehearsal_dinner',
    nameColumn: null,
    noun: 'their rehearsal dinner',
    singleton: true,
  },
  staffing: {
    table: 'staffing_assignments',
    fields: [
      'answers', 'count', 'person_name', 'role', 'hours', 'hourly_rate',
      'friday_bartenders', 'friday_extra_hands', 'friday_total',
      'saturday_bartenders', 'saturday_extra_hands', 'saturday_total',
      'tip_amount', 'total_cost', 'total_staff', 'notes',
    ],
    stem: 'staffing',
    nameColumn: 'person_name',
    noun: 'a staffing entry',
    // NOT a singleton, though the calculator keeps one row per wedding. Its
    // unique index is partial — (wedding_id) WHERE role = '_calculator',
    // migration 098 — and Postgres will not take a partial index as an upsert
    // conflict target: it answers 42P10 and the save fails. The table also holds
    // real per-person assignments alongside that row, so row-per-thing is the
    // honest shape. The page finds its calculator row and updates it by id.
  },
  website: {
    table: 'wedding_website_settings',
    fields: [
      'slug', 'is_published', 'theme', 'accent_color', 'couple_names',
      'partner1_name', 'partner2_name', 'wedding_date', 'venue_name',
      'venue_address', 'our_story', 'dress_code', 'registry_links', 'faq',
      'things_to_do', 'sections', 'sections_order', 'sections_enabled',
      'site_password',
    ],
    stem: 'website',
    nameColumn: null,
    noun: 'their wedding website',
    singleton: true,
  },
  worksheets: {
    table: 'wedding_worksheets',
    fields: ['section', 'content'],
    stem: 'worksheet',
    nameColumn: 'section',
    noun: 'a worksheet',
    // One row per section, not per wedding: production has three for one
    // wedding. Marked a singleton at first, which would have upserted every
    // section over the same row.
  },
  config: {
    table: 'wedding_config',
    fields: ['total_budget', 'budget_shared', 'custom_categories', 'plated_meal'],
    stem: 'wedding_config',
    nameColumn: null,
    noun: 'their settings',
    singleton: true,
    conflictTarget: 'venue_id,wedding_id',
  },
  'rsvp-config': {
    table: 'rsvp_config',
    fields: [
      'rsvp_deadline', 'allow_maybe', 'attending_message', 'declined_message',
      'custom_questions',
      'ask_email', 'ask_phone', 'ask_address', 'ask_meal_choice', 'ask_dietary',
      'ask_allergies', 'ask_accessibility', 'ask_hotel', 'ask_shuttle',
      'ask_song_request', 'ask_message',
    ],
    stem: 'rsvp_config',
    nameColumn: null,
    noun: 'their RSVP questions',
    singleton: true,
    conflictTarget: 'venue_id,wedding_id',
  },
  'ceremony-chairs': {
    table: 'ceremony_chair_plans',
    fields: ['plan'],
    stem: 'ceremony_chair_plan',
    nameColumn: null,
    noun: 'their ceremony seating',
    singleton: true,
    // This table never got a venue_id. Writing one fails the insert.
    scope: 'wedding',
  },
  onboarding: {
    table: 'onboarding_progress',
    fields: [
      'step', 'completed', 'completed_at',
      'couple_photo_uploaded', 'couple_photo_uploaded_at',
      'first_message_sent', 'first_message_sent_at',
      'inspo_uploaded', 'inspo_uploaded_at',
      'vendor_added', 'vendor_added_at',
      'checklist_item_completed', 'checklist_item_completed_at',
    ],
    stem: 'onboarding',
    nameColumn: 'step',
    noun: 'their getting-started progress',
    // One row per step. Its unique index is partial — (wedding_id) WHERE step
    // IS NULL — so it is not a valid upsert conflict target either: Postgres
    // answers 42P10. Production has five rows for one wedding.
  },
}

export type CoupleResourceKey = keyof typeof COUPLE_RESOURCES

export const COUPLE_RESOURCE_KEYS = Object.keys(COUPLE_RESOURCES)

/** Verbs, in the order a person would read them. */
const VERBS = { added: 'added', updated: 'updated', removed: 'removed' } as const
export type CoupleAction = keyof typeof VERBS

/**
 * Wording for high-volume tables. Deliberately constant: no name, no count,
 * nothing that varies between two edits. The feed's own folding is what keeps a
 * two-hundred-guest import to one line, and that only works when the details
 * match exactly.
 */
const BURST_DETAILS: Record<CoupleAction, string> = {
  added: 'added guests',
  updated: 'edited their guest list',
  removed: 'removed guests',
}

/**
 * The activity type and details for one write.
 *
 * `row` is what the write returned, so it carries the name column. A row with
 * no usable name falls back to the noun rather than printing a bare uuid at
 * somebody.
 */
export function coupleActivity(
  resource: CoupleResource,
  action: CoupleAction,
  row?: Record<string, unknown> | null,
): { activityType: string; details: string } {
  if (resource.burst) {
    return { activityType: `${resource.stem}_${action}`, details: BURST_DETAILS[action] }
  }

  if (resource.singleton) {
    return {
      activityType: `${resource.stem}_updated`,
      details: `updated ${resource.noun}`,
    }
  }

  const raw = resource.nameColumn ? row?.[resource.nameColumn] : null
  const name = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
  return {
    activityType: `${resource.stem}_${action}`,
    details: name ? `${VERBS[action]} ${name}` : `${VERBS[action]} ${resource.noun}`,
  }
}

/**
 * Keep only the columns this resource allows, and report the rest.
 *
 * The leftovers are returned rather than dropped in silence: a form that grows
 * a field nobody wired up should say so in a log, not lose the value and look
 * like it saved.
 */
export function pickFields(
  resource: CoupleResource,
  body: Record<string, unknown>,
): { fields: Record<string, unknown>; refused: string[] } {
  const fields: Record<string, unknown> = {}
  const refused: string[] = []
  for (const [key, value] of Object.entries(body ?? {})) {
    if (key === 'id') continue
    if ((resource.fields as readonly string[]).includes(key)) fields[key] = value
    else refused.push(key)
  }
  return { fields, refused }
}
