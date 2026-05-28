/**
 * Couple-portal section registry.
 *
 * Single source of truth describing every page a couple can land on,
 * what it's for, what they actually do there, and the common questions
 * Sage should be ready to answer when context is local to that page.
 *
 * Consumed by:
 *   - sage-brain (injected as PORTAL SECTIONS GUIDE so Sage can route
 *     couples to the right surface — "the Bar Planner is at /bar")
 *   - chat page + floating button (per-section suggested questions)
 *
 * Keep entries TIGHT. Every line here lands in every Sage prompt.
 */

export interface PortalSection {
  slug: string
  label: string
  group: string
  purpose: string
  whatToDo: string
  examples: string[]
}

export const PORTAL_SECTIONS: PortalSection[] = [
  // Onboarding / dashboard
  {
    slug: 'getting-started',
    label: 'Getting Started',
    group: 'Onboarding',
    purpose: 'Onboarding cards for first-time portal users.',
    whatToDo: 'Upload a couple photo, say hi to your AI concierge, and explore the rest of the portal.',
    examples: ['What should I do first?', 'How do I upload my photo?'],
  },

  // Plan
  {
    slug: 'whats-next',
    label: "What's Next",
    group: 'Plan',
    purpose: 'Auto-prioritised list of the 3-5 most actionable items right now.',
    whatToDo: 'Review overdue items, soon-due payments, and recent venue messages.',
    examples: ['What should I work on this week?', 'Anything overdue?'],
  },
  {
    slug: 'availability',
    label: 'Availability',
    group: 'Plan',
    purpose: 'Calendar view of the venue and your planning windows.',
    whatToDo: 'See what dates the venue is holding for tours, walk-throughs, and your event.',
    examples: ['When can I do a final walk-through?'],
  },
  {
    slug: 'checklist',
    label: 'Checklist',
    group: 'Plan',
    purpose: 'Master planning checklist with tasks grouped by category.',
    whatToDo: 'Mark tasks complete, add personal notes, set due dates, filter Essentials vs All.',
    examples: ['What checklist items am I behind on?', 'Add a note to this task'],
  },
  {
    slug: 'timeline',
    label: 'Timeline',
    group: 'Plan',
    purpose: 'Wedding-day schedule of every event (ceremony, formalities, dinner, dancing, send-off).',
    whatToDo: 'Sequence events, set durations, pick first-look/private-vows options, plan the day-of flow.',
    examples: ['Help me build my day-of timeline', 'What time should the ceremony start?'],
  },
  {
    slug: 'budget',
    label: 'Budget',
    group: 'Plan',
    purpose: 'Budget tracker with payment due dates and source assignments.',
    whatToDo: 'Add line items with budgeted vs paid amounts, payment due dates, and who pays.',
    examples: ['Do I have any payments coming up?', 'How much have I spent on flowers?'],
  },
  {
    slug: 'worksheets',
    label: 'Worksheets',
    group: 'Plan',
    purpose: 'Venue-provided planning worksheets and forms.',
    whatToDo: 'Fill in worksheets the venue has assigned (e.g. ceremony script, vendor contacts).',
    examples: ['Which worksheets do I still need to fill out?'],
  },

  // Guests
  {
    slug: 'guests',
    label: 'Guest List',
    group: 'Guests',
    purpose: 'Master guest list with meal choices, dietary needs, and tags.',
    whatToDo: 'Add guests, set the meal-tracking mode (plated/buffet/food-trucks/stations), tag groups.',
    examples: ['How many guests have RSVPd?', 'Mark this guest as vegetarian'],
  },
  {
    slug: 'rsvp-settings',
    label: 'RSVP Settings',
    group: 'Guests',
    purpose: 'Configure how RSVPs are collected (deadline, questions, custom fields).',
    whatToDo: 'Set RSVP deadline, choose meal options, add custom questions for guests.',
    examples: ['When should my RSVP deadline be?'],
  },
  {
    slug: 'seating',
    label: 'Seating',
    group: 'Guests',
    purpose: 'Drag-and-drop seating assignments by guest onto tables.',
    whatToDo: 'Assign each guest to a table; reference the venue floor plan if uploaded.',
    examples: ['Help me figure out where to seat my family'],
  },
  {
    slug: 'table-map',
    label: 'Floor Plan',
    group: 'Guests',
    purpose: 'Visual venue floor plan with table positioning.',
    whatToDo: 'See where tables sit in the room (admin uploads the plan image).',
    examples: ['Where is table 12 in the room?'],
  },
  {
    slug: 'tables',
    label: 'Table Sizes',
    group: 'Guests',
    purpose: 'Decide how many tables of each size you need.',
    whatToDo: 'Pick table counts and sizes; rough guide for venue/planner and linen budget.',
    examples: ['How many 60-inch rounds do I need for 120 guests?'],
  },
  {
    slug: 'party',
    label: 'Wedding Party',
    group: 'Guests',
    purpose: 'Bridesmaids, groomsmen, parents, and other VIP roles.',
    whatToDo: 'Add wedding-party members, contact info, and roles.',
    examples: ['Who is in my wedding party?'],
  },
  {
    slug: 'allergies',
    label: 'Allergies',
    group: 'Guests',
    purpose: 'Master list of guest allergies and dietary restrictions.',
    whatToDo: 'Review every flagged guest restriction in one place; share with caterer.',
    examples: ['Which guests have nut allergies?'],
  },
  {
    slug: 'guest-care',
    label: 'Guest Care',
    group: 'Guests',
    purpose: 'Welcome bags, hotel info, accessibility notes — anything guest-comfort related.',
    whatToDo: 'Plan welcome-bag contents, accessibility accommodations, and out-of-town guest care.',
    examples: ['What should go in welcome bags?'],
  },

  // Day-of
  {
    slug: 'ceremony',
    label: 'Ceremony',
    group: 'Day-of',
    purpose: 'Ceremony details — script, processional order, officiant, readings.',
    whatToDo: 'Plan the order of the ceremony itself (entrance, readings, vows, recessional).',
    examples: ['Help me write our ceremony script'],
  },
  {
    slug: 'ceremony-chairs',
    label: 'Ceremony Chairs',
    group: 'Day-of',
    purpose: 'Chair count + layout for the ceremony space.',
    whatToDo: 'Set chair count, aisle width, reserved-row count for parents/family.',
    examples: ['How many chairs do I need for 120 guests?'],
  },
  {
    slug: 'rehearsal',
    label: 'Rehearsal Dinner',
    group: 'Day-of',
    purpose: 'Rehearsal-dinner planning (location, guest list, menu).',
    whatToDo: 'Pick location type (at venue / restaurant / private home / other) and fill in the rest.',
    examples: ['Where should we host our rehearsal dinner?'],
  },
  {
    slug: 'bar',
    label: 'Bar Planner',
    group: 'Day-of',
    purpose: 'Bar planning — drink levels, shopping list, package selection.',
    whatToDo: 'Pick bar type (beer/wine, specialty, full), estimate quantities by drink-level scale.',
    examples: ['How much wine do I need for 100 guests?', 'What should I stock the bar with?'],
  },
  {
    slug: 'decor',
    label: 'Decor',
    group: 'Day-of',
    purpose: 'Decor and rental inventory planning.',
    whatToDo: 'List what you want on tables, what the venue provides, and what you need to rent.',
    examples: ['What centerpieces do you recommend?'],
  },
  {
    slug: 'photos',
    label: 'Photos',
    group: 'Day-of',
    purpose: 'Shot list and photo planning.',
    whatToDo: 'Plan the photo schedule, family-shot list, and key moments for your photographer.',
    examples: ['What family photos should I plan for?'],
  },
  {
    slug: 'beauty',
    label: 'Hair & Makeup',
    group: 'Day-of',
    purpose: 'Hair and makeup appointment schedule for the wedding party.',
    whatToDo: 'Add appointments with hair/makeup times per person; sort by earliest start.',
    examples: ['When should hair and makeup start?'],
  },
  {
    slug: 'inspo',
    label: 'Inspiration',
    group: 'Day-of',
    purpose: 'Visual inspiration board.',
    whatToDo: 'Save and organize inspiration images and references.',
    examples: ['Help me figure out a color palette'],
  },

  // Logistics
  {
    slug: 'venue-info',
    label: 'Venue Info',
    group: 'Logistics',
    purpose: 'Venue policies, hours, contacts, FAQs.',
    whatToDo: 'Reference venue-provided info — answers to common policy questions live here.',
    examples: ['What time does the venue close?', "What's the rain plan?"],
  },
  {
    slug: 'vendors',
    label: 'Vendors',
    group: 'Logistics',
    purpose: 'Your booked vendors with contact info and contracts.',
    whatToDo: 'Add booked vendors per category; attach contracts and key details.',
    examples: ['Have I booked a photographer yet?'],
  },
  {
    slug: 'preferred-vendors',
    label: 'Preferred Vendors',
    group: 'Logistics',
    purpose: "The venue's curated list of recommended vendors.",
    whatToDo: 'Browse the venue\'s preferred vendor list by category and reach out to ones you like.',
    examples: ['Who do you recommend for florals?'],
  },
  {
    slug: 'rooms',
    label: 'Rooms',
    group: 'Logistics',
    purpose: 'Hotel room blocks + on-site room assignments.',
    whatToDo: 'Capture hotel room blocks first (rate, code, deadline), then assign guests to rooms.',
    examples: ['How do I set up a hotel block?'],
  },
  {
    slug: 'stays',
    label: 'Stays',
    group: 'Logistics',
    purpose: 'Nearby hotels and lodging options for guests.',
    whatToDo: 'Reference nearby stays the venue recommends sharing with out-of-town guests.',
    examples: ['Which hotels are closest to the venue?'],
  },
  {
    slug: 'transportation',
    label: 'Transportation',
    group: 'Logistics',
    purpose: 'Shuttle and transportation schedule.',
    whatToDo: 'Set pickup locations, shuttle count, seat capacity, and run times.',
    examples: ['Do I need a shuttle?', 'How many shuttles for 150 guests?'],
  },
  {
    slug: 'staffing',
    label: 'Staffing',
    group: 'Logistics',
    purpose: 'Day-of staff calculator (bartenders, servers, extra hands).',
    whatToDo: 'Answer a few questions and the calculator suggests staff counts based on venue rates.',
    examples: ['How many bartenders do I need?'],
  },

  // Wedding Details
  {
    slug: 'wedding-details',
    label: 'Wedding Details',
    group: 'Wedding Details',
    purpose: 'Core wedding info — date, ceremony style, sendoff style, custom venue fields.',
    whatToDo: 'Set core preferences; available fields are configured by your venue (e.g. sparkler options if allowed).',
    examples: ['How do I change our sendoff style?'],
  },
  {
    slug: 'addresses',
    label: 'Addresses',
    group: 'Wedding Details',
    purpose: 'Couple + family addresses for thank-yous and hotel block math.',
    whatToDo: 'Capture mailing addresses for both partners and key family members.',
    examples: ['Where do I add my parents address?'],
  },
  {
    slug: 'venue-inventory',
    label: 'Venue Inclusions',
    group: 'Wedding Details',
    purpose: 'Whats included with your venue rental (chairs, linens, tables, etc).',
    whatToDo: 'See whats included so you only rent what you actually need.',
    examples: ['Does the venue include chairs?', 'What linens are included?'],
  },
  {
    slug: 'picks',
    label: 'Recommended Buys',
    group: 'Wedding Details',
    purpose: 'Curated purchase suggestions (signage, favors, day-of kit).',
    whatToDo: 'Browse vetted recommendations the venue has gathered.',
    examples: ['What do I need to buy for the day-of kit?'],
  },

  // Documents & Booking
  {
    slug: 'contracts',
    label: 'Contracts',
    group: 'Documents',
    purpose: 'Upload vendor contracts; AI extracts key terms, dates, and amounts.',
    whatToDo: 'Upload each vendor contract; ask Sage about clauses, payments, cancellation terms.',
    examples: ['What does my photographer\'s contract say about cancellation?', 'When is my next vendor payment due?'],
  },
  {
    slug: 'booking',
    label: 'Booking',
    group: 'Documents',
    purpose: 'Your venue booking details (dates held, contract, payment terms).',
    whatToDo: 'Reference your venue contract and booking terms.',
    examples: ["When is my final venue payment due?"],
  },
  {
    slug: 'final-review',
    label: 'Final Review',
    group: 'Documents',
    purpose: '6-weeks-out final review checklist — surfaces in the last 6 weeks.',
    whatToDo: 'Walk through final-review items the coordinator needs confirmed before the wedding.',
    examples: ['What does the venue still need from me?'],
  },
  {
    slug: 'website',
    label: 'Wedding Website',
    group: 'Documents',
    purpose: 'Wedding-website builder for guests.',
    whatToDo: 'Customize a guest-facing site with details, RSVP link, travel info.',
    examples: ['Help me write our welcome message'],
  },
  {
    slug: 'downloads',
    label: 'Downloads',
    group: 'Documents',
    purpose: 'Downloadable PDFs of your plan (timeline, seating chart, etc).',
    whatToDo: 'Export PDFs to share with vendors or print for the day-of.',
    examples: ['Can I download my timeline?'],
  },
  {
    slug: 'resources',
    label: 'Resources',
    group: 'Documents',
    purpose: 'Venue-provided assets (floor plans, watercolors, favor templates, programs).',
    whatToDo: 'Download couple-facing brand assets your venue has shared.',
    examples: ['Is there a floor plan I can use?'],
  },

  // Communication
  {
    slug: 'messages',
    label: 'Messages',
    group: 'Communication',
    purpose: 'Threaded messages with your venue coordinator.',
    whatToDo: 'Read and respond to messages from your coordinator.',
    examples: ['Has my coordinator messaged me?'],
  },

  // Day-of (last-week only)
  {
    slug: 'day-of',
    label: 'Day-of',
    group: 'This Week',
    purpose: 'Final-week day-of dashboard (vendor contacts, timeline, urgent reminders).',
    whatToDo: 'Reference the day-of view in the last week before the wedding.',
    examples: ['Whats on my day-of checklist?'],
  },
  {
    slug: 'day-of-memories',
    label: 'Day-of Memories',
    group: 'After',
    purpose: 'Post-wedding memory feed (guest uploads, day-of moments).',
    whatToDo: 'Browse what guests captured on the day.',
    examples: ['Where do I see photos from guests?'],
  },

  // Account
  {
    slug: 'privacy',
    label: 'Privacy & Data',
    group: 'Account',
    purpose: 'Privacy settings and data export.',
    whatToDo: 'Manage what data is shared, request exports, control AI features.',
    examples: ['How do I export my data?'],
  },
]

/**
 * Look up a section by slug. Tolerates trailing slashes and query strings.
 */
export function getSectionBySlug(slug: string | null | undefined): PortalSection | null {
  if (!slug) return null
  const clean = slug.replace(/^\/+|\/+$/g, '').split('?')[0]
  return PORTAL_SECTIONS.find((s) => s.slug === clean) ?? null
}

/**
 * Derive the section from a full couple-portal pathname. Strips the
 * `/couple/<venueSlug>/` prefix and matches the first remaining segment.
 *
 * Returns null for `/couple/<slug>/chat` (Sage is the chat) and for the
 * portal root page (handled separately).
 */
export function getSectionFromPath(pathname: string | null | undefined): PortalSection | null {
  if (!pathname) return null
  const match = pathname.match(/^\/couple\/[^/]+\/([^/?#]+)/)
  if (!match) return null
  const seg = match[1]
  if (seg === 'chat') return null
  return getSectionBySlug(seg)
}

/**
 * Compact one-line directory used in Sage's system prompt. Tight on
 * purpose — every line lands in every Sage call.
 */
export function buildSectionsDirectoryBlock(): string {
  const grouped = new Map<string, PortalSection[]>()
  for (const section of PORTAL_SECTIONS) {
    const arr = grouped.get(section.group) ?? []
    arr.push(section)
    grouped.set(section.group, arr)
  }

  const lines: string[] = []
  for (const [group, sections] of grouped) {
    lines.push(`${group}:`)
    for (const s of sections) {
      // Format matches Sage's expected output so the model picks up the
      // pattern by example: "[Bar Planner](/bar) — Bar planning..."
      lines.push(`  - [${s.label}](/${s.slug}) — ${s.purpose}`)
    }
  }
  return lines.join('\n')
}

/**
 * Per-section "you are here" block. Drops a couple of example questions
 * the couple might ask from this surface so Sage can anticipate intent.
 */
export function buildCurrentSectionBlock(section: PortalSection): string {
  return [
    `Couple is currently viewing: ${section.label} (/${section.slug})`,
    `Page purpose: ${section.purpose}`,
    `What couples typically do here: ${section.whatToDo}`,
    `Common questions on this page: ${section.examples.map((q) => `"${q}"`).join(', ')}`,
  ].join('\n')
}
