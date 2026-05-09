/**
 * Curated source registry — backs the /intel/sources/track page.
 *
 * Each entry describes:
 *   - The canonical `key` (must align with marketing_spend.source values
 *     so the freshness monitor can find the most-recent spend row).
 *   - A human label, category, and short description for the UI.
 *   - A default cadence in days (most ad/listing platforms report
 *     monthly; some channels are weekly).
 *   - An import guide focused on what the coordinator actually does:
 *     where to find the data, what to export, and how to drop it into
 *     the Bloom brain dump.
 *
 * Add new entries here when a new source becomes trackable. The
 * registry is the source of truth for the curated page; coordinators
 * can still track ad-hoc keys via direct API call (the freshness
 * monitor reads `tracked_sources` rows regardless of whether they
 * appear in the registry), but the curated page only lists registry
 * entries.
 */

export type SourceCategory =
  | 'listing'
  | 'ads'
  | 'organic'
  | 'referral'
  | 'email_marketing'
  | 'other'

export interface SourceImportGuide {
  title: string
  steps: string[]
  screenshots?: string[]
  helpUrl?: string
}

export interface SourceRegistryEntry {
  key: string
  label: string
  category: SourceCategory
  description: string
  defaultCadenceDays: number
  importGuide: SourceImportGuide
  tag?: 'recommended' | 'beta' | 'deprecated'
}

export const SOURCE_REGISTRY: SourceRegistryEntry[] = [
  // ---------------------------------------------------------------
  // LISTING PLATFORMS
  // ---------------------------------------------------------------
  {
    key: 'the_knot',
    label: 'The Knot',
    category: 'listing',
    description:
      'The Knot Pro storefront. Tracks profile views, inquiry volume, and ad-spend on featured placements.',
    defaultCadenceDays: 30,
    tag: 'recommended',
    importGuide: {
      title: 'Pull Knot Pro performance for the month',
      steps: [
        'Sign in to The Knot Pro and open Performance.',
        'Set the date range to "Last Month" (or the month you are reporting).',
        'Export the summary CSV, or take a clean screenshot of the metrics tile.',
        'Open the brain dump and paste the CSV, drop the screenshot, or type "Knot got X inquiries from $Y spend in <month>".',
        'Sage extracts views, inquiries, and spend, and updates Marketing Spend + the source scorecard.',
      ],
      helpUrl: 'https://pro.theknot.com/help/performance',
    },
  },
  {
    key: 'wedding_wire',
    label: 'WeddingWire',
    category: 'listing',
    description:
      'WeddingWire Pro storefront. Mirrors The Knot data; many couples submit on both.',
    defaultCadenceDays: 30,
    tag: 'recommended',
    importGuide: {
      title: 'Pull WeddingWire Pro performance for the month',
      steps: [
        'Sign in to WeddingWire Pro and open the Performance tab.',
        'Set the date range to last month.',
        'Export the CSV (Profile Views, Leads, Spend) or screenshot the dashboard.',
        'Drop the file or screenshot into the brain dump.',
        'Sage extracts impressions, inquiries, and spend.',
      ],
      helpUrl: 'https://www.weddingwire.com/biz/help',
    },
  },
  {
    key: 'zola',
    label: 'Zola',
    category: 'listing',
    description: 'Zola Vendor dashboard. Free + paid placements.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull Zola Vendor metrics',
      steps: [
        'Open Zola Vendor and go to Performance.',
        'Filter by last month.',
        'Screenshot the inquiries + impressions tile.',
        'Drop the screenshot into the brain dump.',
        'Sage extracts inquiry count and any spend.',
      ],
    },
  },
  {
    key: 'here_comes_the_guide',
    label: 'Here Comes The Guide',
    category: 'listing',
    description: 'HCTG paid listing. Reports tend to be quarterly; monthly screenshots also work.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull Here Comes The Guide stats',
      steps: [
        'Sign in to the HCTG vendor portal.',
        'Open the Reports tab and select the month.',
        'Screenshot the inquiry summary or copy the figures.',
        'Drop the screenshot or paste the numbers into the brain dump.',
        'Sage records inquiries + spend (if any).',
      ],
    },
  },
  {
    key: 'wedj',
    label: 'WedJ',
    category: 'listing',
    description: 'WedJ vendor profile. Smaller volume but cheaper per lead in some markets.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull WedJ vendor stats',
      steps: [
        'Sign in to WedJ vendor admin.',
        'Open Insights for the month.',
        'Screenshot the inquiry / impression tile.',
        'Drop the screenshot in the brain dump.',
        'Sage extracts the inquiry count and any spend.',
      ],
    },
  },
  {
    key: 'weddingspot',
    label: 'WeddingSpot',
    category: 'listing',
    description: 'WeddingSpot listing platform. Quote-request driven.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull WeddingSpot quote requests',
      steps: [
        'Open the WeddingSpot vendor dashboard.',
        'Filter quote requests by last month.',
        'Export the CSV or screenshot the totals.',
        'Drop into the brain dump.',
        'Sage extracts quote-request volume and spend.',
      ],
    },
  },
  {
    key: 'eventective',
    label: 'Eventective',
    category: 'listing',
    description: 'Eventective listing. Often grouped with corporate / mitzvah inquiries.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull Eventective monthly stats',
      steps: [
        'Sign in to the Eventective vendor admin.',
        'Open Reports and choose the month.',
        'Screenshot or export the lead summary.',
        'Drop into the brain dump.',
        'Sage extracts inquiry volume.',
      ],
    },
  },
  {
    key: 'partyslate',
    label: 'PartySlate',
    category: 'listing',
    description: 'PartySlate listing. Skews higher-end; portfolio-driven.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull PartySlate insights',
      steps: [
        'Open PartySlate vendor dashboard.',
        'Go to Insights for the month.',
        'Screenshot the inquiry + saves tile.',
        'Drop the screenshot into the brain dump.',
        'Sage records inquiries.',
      ],
    },
  },
  {
    key: 'venue_report',
    label: 'VenueReport',
    category: 'listing',
    description: 'VenueReport listing. Editorial-led; lower volume but higher intent.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull VenueReport stats',
      steps: [
        'Sign in to the VenueReport vendor backend.',
        'Filter inquiries by last month.',
        'Screenshot or export the summary.',
        'Drop into the brain dump.',
        'Sage records inquiries.',
      ],
    },
  },

  // ---------------------------------------------------------------
  // ADS
  // ---------------------------------------------------------------
  {
    key: 'google_ads',
    label: 'Google Ads',
    category: 'ads',
    description: 'Search + Performance Max ads. Spend can shift weekly; check at least monthly.',
    defaultCadenceDays: 30,
    tag: 'recommended',
    importGuide: {
      title: 'Pull Google Ads spend for the month',
      steps: [
        'Open Google Ads and select the property.',
        'Set the date range to last month.',
        'Open Reports → Predefined → Spend, or just screenshot the campaigns table.',
        'Drop the CSV or screenshot into the brain dump, or paste "Google Ads spend was $X in <month>".',
        'Sage extracts spend, impressions, and clicks.',
      ],
      helpUrl: 'https://support.google.com/google-ads/answer/2375435',
    },
  },
  {
    key: 'facebook_ads',
    label: 'Facebook / Meta Ads',
    category: 'ads',
    description: 'Meta Ads Manager (Facebook + Instagram). Cross-posts often hit Instagram, too.',
    defaultCadenceDays: 30,
    tag: 'recommended',
    importGuide: {
      title: 'Pull Meta Ads spend',
      steps: [
        'Open Meta Ads Manager → Reports.',
        'Set the date range to last month and select the property.',
        'Export the campaign-level CSV (Spend, Impressions, Reach).',
        'Drop the CSV into the brain dump.',
        'Sage records monthly spend per campaign and rolls up to the source.',
      ],
      helpUrl: 'https://www.facebook.com/business/help/247955616030023',
    },
  },
  {
    key: 'instagram_ads',
    label: 'Instagram Ads',
    category: 'ads',
    description:
      'Instagram-only ad spend (boosted posts via the Instagram app). Distinct from Meta Ads Manager spend.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull Instagram in-app ad spend',
      steps: [
        'Open Instagram → Professional Dashboard → Ad Tools.',
        'Filter promotions by last month.',
        'Screenshot the totals.',
        'Drop into the brain dump.',
        'Sage records promoted-post spend.',
      ],
    },
  },
  {
    key: 'pinterest_ads',
    label: 'Pinterest Ads',
    category: 'ads',
    description: 'Pinterest Ads dashboard. High inspiration-stage volume.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull Pinterest Ads spend',
      steps: [
        'Open Pinterest Ads Manager → Reporting.',
        'Set the date range to last month.',
        'Export the campaign CSV.',
        'Drop into the brain dump.',
        'Sage records spend, impressions, and saves.',
      ],
    },
  },
  {
    key: 'tiktok_ads',
    label: 'TikTok Ads',
    category: 'ads',
    description: 'TikTok Ads Manager. Trending fast for Gen Z weddings.',
    defaultCadenceDays: 30,
    tag: 'beta',
    importGuide: {
      title: 'Pull TikTok Ads spend',
      steps: [
        'Open TikTok Ads Manager → Reporting.',
        'Set the date range to last month.',
        'Export the campaign-level CSV.',
        'Drop into the brain dump.',
        'Sage records spend and engagement metrics.',
      ],
    },
  },

  // ---------------------------------------------------------------
  // ORGANIC
  // ---------------------------------------------------------------
  {
    key: 'instagram',
    label: 'Instagram (organic)',
    category: 'organic',
    description: 'Organic IG traffic. Usually free; we still want a heartbeat to detect drops.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull Instagram Insights',
      steps: [
        'Open the Instagram app → Professional Dashboard → Insights.',
        'Set the range to last 28 / 30 days.',
        'Screenshot reach, profile visits, and link taps.',
        'Drop the screenshot into the brain dump.',
        'Sage records organic reach as a tangential signal.',
      ],
    },
  },
  {
    key: 'tiktok',
    label: 'TikTok (organic)',
    category: 'organic',
    description: 'Organic TikTok views + profile visits.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull TikTok Analytics',
      steps: [
        'Open TikTok → Profile → Tools → Analytics.',
        'Set the range to last 28 days.',
        'Screenshot the overview tile.',
        'Drop into the brain dump.',
        'Sage records video views + profile visits.',
      ],
    },
  },
  {
    key: 'website_analytics',
    label: 'Website (Google Analytics)',
    category: 'organic',
    description:
      'GA4 sessions, source/medium, and form-fill events. Drives organic-vs-ads attribution.',
    defaultCadenceDays: 30,
    tag: 'recommended',
    importGuide: {
      title: 'Pull GA4 monthly summary',
      steps: [
        'Open Google Analytics → Reports → Acquisition → Traffic acquisition.',
        'Set the date range to last month.',
        'Export the report as CSV.',
        'Drop into the brain dump.',
        'Sage extracts sessions, conversions, and source / medium splits.',
      ],
      helpUrl: 'https://support.google.com/analytics/answer/9213965',
    },
  },
  {
    key: 'blog_seo',
    label: 'Blog / SEO',
    category: 'organic',
    description:
      'Search Console clicks + impressions. Worth tracking when blog content is part of the strategy.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull Google Search Console performance',
      steps: [
        'Open Search Console for the property.',
        'Open the Performance report and set the range to last 28 days.',
        'Export the CSV.',
        'Drop into the brain dump.',
        'Sage records clicks, impressions, and top queries.',
      ],
    },
  },

  // ---------------------------------------------------------------
  // REFERRAL
  // ---------------------------------------------------------------
  {
    key: 'word_of_mouth',
    label: 'Word of Mouth',
    category: 'referral',
    description:
      'Couples referred by past clients or guests. Track to see if hospitality compounds into bookings.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Log word-of-mouth referrals for the month',
      steps: [
        'Open the brain dump.',
        'Type "We had X word-of-mouth inquiries in <month>" or list each name.',
        'Sage links each name to the matching lead and stamps source = word_of_mouth.',
        'Optional: paste any photos or texts from the referrer to support attribution.',
      ],
    },
  },
  {
    key: 'vendor_referral',
    label: 'Vendor Referral',
    category: 'referral',
    description:
      'Inquiries from preferred vendors (planners, photographers, florists). Often the highest converting source.',
    defaultCadenceDays: 30,
    tag: 'recommended',
    importGuide: {
      title: 'Log vendor referrals for the month',
      steps: [
        'Open the brain dump.',
        'For each referral, write the couple name, vendor name, and date.',
        'Sage stamps source = vendor_referral on the matching lead and credits the vendor.',
        'Sage will surface "top referring vendors" on the source scorecard.',
      ],
    },
  },
  {
    key: 'repeat_customer',
    label: 'Repeat / Retention',
    category: 'referral',
    description:
      'Returning hosts (corporate, multi-event, family events). Track to spot the second-event tail.',
    defaultCadenceDays: 60,
    importGuide: {
      title: 'Log repeat hosts',
      steps: [
        'Open the brain dump.',
        'Type "X is back for another event on <date>" with names.',
        'Sage links to the prior wedding / event and stamps source = repeat_customer.',
      ],
    },
  },

  // ---------------------------------------------------------------
  // EMAIL MARKETING
  // ---------------------------------------------------------------
  {
    key: 'mailchimp',
    label: 'Mailchimp',
    category: 'email_marketing',
    description: 'Mailchimp campaigns. Tracks open rate, click rate, and unsubscribes.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull Mailchimp campaign report',
      steps: [
        'Open Mailchimp → Campaigns → choose the campaign.',
        'Open the Report tab.',
        'Export the summary or screenshot the open / click tiles.',
        'Drop into the brain dump.',
        'Sage records sends, opens, clicks, and replies.',
      ],
      helpUrl: 'https://mailchimp.com/help/about-campaign-reports/',
    },
  },
  {
    key: 'klaviyo',
    label: 'Klaviyo',
    category: 'email_marketing',
    description: 'Klaviyo flows + campaigns. Good for nurture sequences.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull Klaviyo campaign metrics',
      steps: [
        'Open Klaviyo → Campaigns.',
        'Filter by sent date last month.',
        'Export the performance CSV.',
        'Drop into the brain dump.',
        'Sage records sends, opens, clicks.',
      ],
    },
  },
  {
    key: 'direct_email',
    label: 'Direct email (Gmail)',
    category: 'email_marketing',
    description:
      'One-off emails sent from your Gmail (cold outreach, follow-ups). Already auto-tracked by the email pipeline.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Confirm Gmail outbound is being captured',
      steps: [
        'No upload needed — outbound from your connected Gmail is auto-tracked.',
        'Optional: paste a list of cold outreach addresses into the brain dump if you want them tagged as a campaign.',
        'Sage groups them under direct_email and surfaces the reply rate.',
      ],
    },
  },

  // ---------------------------------------------------------------
  // OTHER
  // ---------------------------------------------------------------
  {
    key: 'google_business',
    label: 'Google Business Profile',
    category: 'other',
    description:
      'GBP profile views, calls, and direction requests. The closest thing to "walk-in" tracking.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Pull GBP performance',
      steps: [
        'Open Google Business → Performance.',
        'Set the range to last month.',
        'Export the report or screenshot the calls / directions tile.',
        'Drop into the brain dump.',
        'Sage records calls, direction requests, and search impressions.',
      ],
    },
  },
  {
    key: 'walk_in',
    label: 'Walk-in',
    category: 'other',
    description: 'In-person inquiries (open house, drive-by). Manual capture.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Log walk-in inquiries',
      steps: [
        'Open the brain dump.',
        'For each walk-in, write the name, date, and how they heard about you (if known).',
        'Sage stamps source = walk_in and links to any subsequent email thread.',
      ],
    },
  },
  {
    key: 'phone',
    label: 'Phone',
    category: 'other',
    description:
      'Inbound phone inquiries (OpenPhone, mobile, landline). OpenPhone is auto-captured; others are manual.',
    defaultCadenceDays: 30,
    importGuide: {
      title: 'Confirm phone inquiries are captured',
      steps: [
        'OpenPhone integration is auto-captured if connected (Settings → Integrations).',
        'For non-OpenPhone calls, log them in the brain dump: "Took a call from <name> on <date> about <date>".',
        'Sage records source = phone and links to any subsequent email or contract.',
      ],
    },
  },
  {
    key: 'referral_other',
    label: 'Other Referral',
    category: 'referral',
    description:
      'Catch-all for referral sources that do not fit vendor / word-of-mouth / repeat (e.g. tourism boards, hotels, community groups).',
    defaultCadenceDays: 60,
    importGuide: {
      title: 'Log other referrals',
      steps: [
        'Open the brain dump.',
        'Write "Got a referral from <source>" with the couple name.',
        'Sage stamps source = referral_other and tags the source so it can be promoted into its own tracker later.',
      ],
    },
  },
]

/**
 * Lookup helper. Returns null when the key is unrecognized — the
 * curated page only renders registry entries, but the freshness
 * monitor will still respect ad-hoc tracked_sources rows that were
 * inserted directly via the API.
 */
export function getSourceRegistryEntry(key: string): SourceRegistryEntry | null {
  return SOURCE_REGISTRY.find((e) => e.key === key) ?? null
}

export function getSourceLabel(key: string): string {
  return getSourceRegistryEntry(key)?.label ?? key
}

export const CATEGORY_LABELS: Record<SourceCategory, string> = {
  listing: 'Listing platforms',
  ads: 'Paid ads',
  organic: 'Organic',
  referral: 'Referrals',
  email_marketing: 'Email marketing',
  other: 'Other',
}

export const CATEGORY_ORDER: SourceCategory[] = [
  'listing',
  'ads',
  'organic',
  'referral',
  'email_marketing',
  'other',
]
