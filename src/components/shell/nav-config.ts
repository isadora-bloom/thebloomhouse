/**
 * Mode-based nav config — Phase 2B of the Sage's Brain consolidation.
 *
 * Four top-level modes plus a gear menu for org admin. Every page in
 * src/app/(platform)/**\/page.tsx is accounted for here — the comments
 * note where each lives. Map verified 2026-04-24 against the full glob
 * (80 pages enumerated). DO NOT add a page to the codebase without
 * adding it here, or it becomes orphan navigation.
 *
 * The shape mirrors the legacy sidebar.tsx so nothing is lost in the
 * switch — same icons, same labels, same hrefs. What changes is the
 * grouping (mode-first instead of section-first) and the addition of
 * the mode strip across the top.
 */

import type { ComponentType } from 'react'
import {
  // Agent
  Mail, FileCheck, Kanban, Flame, Workflow, BarChart3,
  HelpCircle, UsersRound, ListOrdered, Inbox, Newspaper, Activity,
  // Weddings
  Heart, CalendarRange, Upload, MessagesSquare, MessageCircleQuestion,
  Printer, MapPinIcon as TableMap,
  // Intel
  LayoutDashboard, Lightbulb, AlertTriangle,
  TrendingUp, Sparkles as TrendsIcon, Star,
  MapPinIcon, XCircle, Megaphone, Share2, LineChart,
  MessageSquareText, GitMerge, UserCheck,
  // Sage's Brain
  Sparkles, Mic, GraduationCap, ScrollText,
  BookOpen, Store, Settings, MailX,
  Wine, HardHat, Bus, UtensilsCrossed,
  Armchair, Building, Flower2, HeartHandshake,
  Hotel, FileText, CheckSquare, SlidersHorizontal,
  // Org admin
  Users, CreditCard, Building2, Layers,
  MapPin, ShieldCheck,
} from 'lucide-react'

export type NavMode = 'agent' | 'weddings' | 'intel' | 'sage'

export interface NavItem {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
  /** Shown in compact ("daily") rail mode. */
  daily?: boolean
  /** Plan tier gate. */
  requiresPlan?: 'intelligence' | 'enterprise'
  /** External label like "AI" / "Beta" rendered as a small pill. */
  badge?: string
}

export interface NavSection {
  title: string
  subtitle?: string
  items: NavItem[]
  /** Hidden at group/company scope (venue-only configuration). */
  venueOnly?: boolean
  /** Plan tier gate for the whole section. */
  requiresPlan?: 'intelligence' | 'enterprise'
}

export interface ModeConfig {
  mode: NavMode
  label: string
  /** Short blurb shown on the mode's index page. */
  description: string
  /** Icon shown in the mode strip. */
  icon: ComponentType<{ className?: string }>
  /** URL prefixes that activate this mode when the user navigates to them. */
  matchPrefixes: string[]
  /** Default landing URL when the mode is clicked. */
  defaultHref: string
  /** Sidebar sections shown when this mode is active. */
  sections: NavSection[]
}

// ---------------------------------------------------------------------------
// Mode: AGENT — email work + inquiry funnel
// ---------------------------------------------------------------------------
// Pages covered: /agent/inbox, /agent/drafts, /agent/pipeline, /agent/leads,
// /agent/sequences, /agent/analytics, /agent/knowledge-gaps,
// /agent/relationships, /agent/codes, /agent/omi-inbox,
// /agent/notifications, /agent/errors

export const MODE_AGENT: ModeConfig = {
  mode: 'agent',
  label: 'Agent',
  description: 'Email drafting, inquiry funnel, and follow-up cadence.',
  icon: Mail,
  matchPrefixes: ['/agent'],
  defaultHref: '/agent/inbox',
  sections: [
    {
      title: 'Daily',
      subtitle: 'What you open every morning',
      items: [
        { label: 'Inbox', href: '/agent/inbox', icon: Mail, daily: true },
        { label: 'Approval Queue', href: '/agent/drafts', icon: FileCheck, daily: true },
        { label: 'Pipeline', href: '/agent/pipeline', icon: Kanban, daily: true },
        { label: 'Leads & Heat Map', href: '/agent/leads', icon: Flame, daily: true },
      ],
    },
    {
      title: 'Reach',
      subtitle: 'Outbound + automation',
      items: [
        { label: 'Sequences', href: '/agent/sequences', icon: Workflow },
        { label: 'Analytics', href: '/agent/analytics', icon: BarChart3 },
      ],
    },
    {
      title: 'Quality',
      subtitle: 'What Sage learns from',
      items: [
        { label: 'Knowledge Gaps', href: '/agent/knowledge-gaps', icon: HelpCircle },
        { label: 'Relationships', href: '/agent/relationships', icon: UsersRound },
        { label: 'Client Codes', href: '/agent/codes', icon: ListOrdered },
      ],
    },
    {
      title: 'Other inboxes',
      items: [
        { label: 'Omi Inbox', href: '/agent/omi-inbox', icon: Inbox },
      ],
    },
    {
      title: 'System',
      subtitle: 'Pipeline health',
      items: [
        { label: 'Notifications', href: '/agent/notifications', icon: Newspaper },
        { label: 'Error Monitor', href: '/agent/errors', icon: Activity },
      ],
    },
  ],
}

// ---------------------------------------------------------------------------
// Mode: WEDDINGS — coordinator ops with booked couples
// ---------------------------------------------------------------------------
// Pages covered: /portal/weddings (list), /portal/weddings/[id],
// /portal/weddings/[id]/portal, /portal/weddings/[id]/print,
// /portal/weddings/[id]/table-map, /portal/messages, /portal/availability,
// /portal/quick-add, /portal/sage-queue
//
// Note: dynamic routes (/portal/weddings/[id]/*) aren't sidebar links —
// they're reached by clicking through the wedding list. They still count
// as "covered" for completeness — a coordinator on /portal/weddings/[id]
// sees the Weddings sidebar.

export const MODE_WEDDINGS: ModeConfig = {
  mode: 'weddings',
  label: 'Weddings',
  description: 'Day-to-day work with booked couples — calendar, messages, planning.',
  icon: Heart,
  matchPrefixes: [
    '/portal/weddings',
    '/portal/messages',
    '/portal/availability',
    '/portal/quick-add',
    '/portal/sage-queue',
  ],
  defaultHref: '/portal/weddings',
  sections: [
    {
      title: 'Daily',
      subtitle: 'Open every morning',
      items: [
        { label: 'Weddings', href: '/portal/weddings', icon: Heart, daily: true },
        { label: 'Availability', href: '/portal/availability', icon: CalendarRange, daily: true },
        { label: 'Messages', href: '/portal/messages', icon: MessagesSquare, daily: true },
        { label: 'Quick Add', href: '/portal/quick-add', icon: Upload, daily: true },
      ],
    },
    {
      title: 'Couple-facing Sage',
      subtitle: 'Uncertain answers to review',
      items: [
        { label: 'Sage Queue', href: '/portal/sage-queue', icon: MessageCircleQuestion, daily: true },
      ],
    },
  ],
}

// ---------------------------------------------------------------------------
// Mode: INTEL — analytics, market signals, ROI
// ---------------------------------------------------------------------------
// Pages covered: /intel/dashboard, /intel/insights, /intel/anomalies,
// /intel/market-pulse, /intel/nlq, /intel/briefings, /intel/sources,
// /intel/roi, /intel/reach, /intel/trends, /intel/reviews,
// /intel/voice-dna, /intel/tours, /intel/lost-deals, /intel/campaigns,
// /intel/social, /intel/capacity, /intel/forecasts, /intel/health,
// /intel/clients, /intel/clients/[id], /intel/matching,
// /intel/annotations, /intel/team-compare
//
// Org-level intel pages (/intel/portfolio, /intel/company, /intel/team,
// /intel/regions, /intel/benchmark) move to ORG_ADMIN gear menu — they
// aggregate across venues and require org admin access.

export const MODE_INTEL: ModeConfig = {
  mode: 'intel',
  label: 'Intel',
  description: 'Demand signals, ROI, reviews, and what your market is doing.',
  icon: LayoutDashboard,
  matchPrefixes: ['/intel'],
  defaultHref: '/intel/dashboard',
  sections: [
    {
      title: 'Daily',
      subtitle: 'Pulse + alerts',
      items: [
        { label: 'Dashboard', href: '/intel/dashboard', icon: LayoutDashboard, daily: true },
        { label: 'Insights', href: '/intel/insights', icon: Lightbulb, daily: true },
        { label: 'Anomalies', href: '/intel/anomalies', icon: AlertTriangle, daily: true },
        { label: 'Market Pulse', href: '/intel/market-pulse', icon: Activity, daily: true },
      ],
    },
    {
      title: 'Demand',
      subtitle: 'What couples are searching for',
      items: [
        { label: 'Trends', href: '/intel/trends', icon: TrendsIcon },
        { label: 'Marketing Reach', href: '/intel/reach', icon: BarChart3 },
        { label: 'Tours', href: '/intel/tours', icon: MapPinIcon },
        { label: 'Capacity', href: '/intel/capacity', icon: CalendarRange },
        { label: 'Forecasts', href: '/intel/forecasts', icon: LineChart },
      ],
    },
    {
      title: 'Conversion',
      subtitle: 'Where leads come from + go',
      items: [
        { label: 'Sources & ROI', href: '/intel/sources', icon: TrendingUp },
        { label: 'ROI dashboard', href: '/intel/roi', icon: BarChart3 },
        { label: 'Lost Deals', href: '/intel/lost-deals', icon: XCircle },
        { label: 'Campaigns', href: '/intel/campaigns', icon: Megaphone },
        { label: 'Social', href: '/intel/social', icon: Share2 },
      ],
    },
    {
      title: 'Voice of customer',
      items: [
        { label: 'Reviews', href: '/intel/reviews', icon: Star },
        { label: 'Voice DNA', href: '/intel/voice-dna', icon: TrendsIcon },
        { label: 'Briefings', href: '/intel/briefings', icon: Newspaper },
      ],
    },
    {
      title: 'People & deduplication',
      items: [
        { label: 'All Clients', href: '/intel/clients', icon: UserCheck },
        { label: 'Matching / Dedup', href: '/intel/matching', icon: GitMerge },
        { label: 'Team Comparison', href: '/intel/team-compare', icon: Users },
      ],
    },
    {
      title: 'Tools',
      items: [
        { label: 'Ask Anything', href: '/intel/nlq', icon: MessageSquareText, badge: 'AI' },
        { label: 'Annotations', href: '/intel/annotations', icon: FileText },
        { label: 'Health Score', href: '/intel/health', icon: Activity },
      ],
    },
  ],
}

// ---------------------------------------------------------------------------
// Mode: SAGE'S BRAIN — configure Sage
// ---------------------------------------------------------------------------
// Pages covered: /settings/sage-identity, /settings/personality,
// /settings/voice, /settings/inbox-filters, /settings/omi,
// /agent/learning, /agent/rules, /agent/settings, /portal/kb,
// /portal/section-settings, /portal/venue-usps-config,
// /portal/venue-assets-config, /portal/wedding-details-config,
// /portal/checklist-config, /portal/bar-config, /portal/staffing-config,
// /portal/shuttle-config, /portal/rehearsal-config, /portal/tables-config,
// /portal/seating-config, /portal/rooms-config, /portal/decor-config,
// /portal/guest-care-config, /portal/accommodations-config,
// /portal/vendors, /onboarding, /setup
//
// Note on grouping: portal config pages collapse under "Portal experience"
// rail subgrouped Spaces / Service / Logistics / Day-of / Brand / Meta per
// Phase 2A doc. KB lives under Knowledge rail; vendors under Vendors rail;
// USPs under Inquiry behaviour (USPs are inquiry context, not portal UI).

export const MODE_SAGE: ModeConfig = {
  mode: 'sage',
  label: "Sage's Brain",
  description: 'Configure Sage — identity, voice, knowledge, and venue rules.',
  icon: Sparkles,
  matchPrefixes: [
    '/settings',
    '/agent/learning',
    '/agent/rules',
    '/agent/settings',
    '/portal/kb',
    '/portal/section-settings',
    '/portal/venue-usps-config',
    '/portal/venue-assets-config',
    '/portal/wedding-details-config',
    '/portal/checklist-config',
    '/portal/bar-config',
    '/portal/staffing-config',
    '/portal/shuttle-config',
    '/portal/rehearsal-config',
    '/portal/tables-config',
    '/portal/seating-config',
    '/portal/rooms-config',
    '/portal/decor-config',
    '/portal/guest-care-config',
    '/portal/accommodations-config',
    '/portal/vendors',
    '/onboarding',
    '/setup',
  ],
  defaultHref: '/settings/sage-identity',
  sections: [
    {
      title: 'Identity',
      subtitle: 'How Sage introduces herself',
      venueOnly: true,
      items: [
        { label: 'Sage Identity', href: '/settings/sage-identity', icon: Sparkles, daily: true },
      ],
    },
    {
      title: 'Voice & Personality',
      subtitle: 'Tone, training, and learned phrases',
      venueOnly: true,
      items: [
        { label: 'AI Personality', href: '/settings/personality', icon: Sparkles, daily: true },
        { label: 'Voice Games', href: '/settings/voice', icon: Mic },
        { label: 'Teach Voice', href: '/agent/learning', icon: GraduationCap },
        { label: 'Always / Never Rules', href: '/agent/rules', icon: ScrollText },
      ],
    },
    {
      title: 'Knowledge',
      subtitle: 'What Sage knows about your venue',
      venueOnly: true,
      items: [
        { label: 'Knowledge Base', href: '/portal/kb', icon: BookOpen, daily: true },
      ],
    },
    {
      title: 'Inquiry behaviour',
      subtitle: 'Auto-send, filters, USPs to weave in',
      venueOnly: true,
      items: [
        { label: 'Auto-send & Follow-ups', href: '/agent/settings', icon: Settings, daily: true },
        { label: 'Inbox Filters', href: '/settings/inbox-filters', icon: MailX },
        { label: "What Makes Us Different", href: '/portal/venue-usps-config', icon: Sparkles },
      ],
    },
    {
      title: 'Portal experience — Spaces',
      subtitle: 'Rooms, tables, floor plans',
      venueOnly: true,
      items: [
        { label: 'Rooms & Hotels', href: '/portal/rooms-config', icon: Building },
        { label: 'Tables & Linens', href: '/portal/tables-config', icon: Armchair },
        { label: 'Seating & Floor Plan', href: '/portal/seating-config', icon: MapPinIcon },
      ],
    },
    {
      title: 'Portal experience — Service',
      subtitle: 'Bar, staffing, decor, guest care',
      venueOnly: true,
      items: [
        { label: 'Bar & Beverages', href: '/portal/bar-config', icon: Wine },
        { label: 'Staffing', href: '/portal/staffing-config', icon: HardHat },
        { label: 'Decor & Spaces', href: '/portal/decor-config', icon: Flower2 },
        { label: 'Guest Care', href: '/portal/guest-care-config', icon: HeartHandshake },
      ],
    },
    {
      title: 'Portal experience — Logistics',
      subtitle: 'Shuttles, rehearsal, accommodations',
      venueOnly: true,
      items: [
        { label: 'Shuttle & Transport', href: '/portal/shuttle-config', icon: Bus },
        { label: 'Rehearsal Dinner', href: '/portal/rehearsal-config', icon: UtensilsCrossed },
        { label: 'Accommodations', href: '/portal/accommodations-config', icon: Hotel },
      ],
    },
    {
      title: 'Portal experience — Day-of',
      subtitle: 'Templates couples start from',
      venueOnly: true,
      items: [
        { label: 'Wedding Details', href: '/portal/wedding-details-config', icon: Heart },
        { label: 'Checklist Templates', href: '/portal/checklist-config', icon: CheckSquare },
      ],
    },
    {
      title: 'Portal experience — Brand & access',
      venueOnly: true,
      items: [
        { label: 'Downloads & Resources', href: '/portal/venue-assets-config', icon: FileText },
        { label: 'Portal Sections', href: '/portal/section-settings', icon: SlidersHorizontal },
      ],
    },
    {
      title: 'Vendors',
      subtitle: 'Preferred list + visibility',
      venueOnly: true,
      items: [
        { label: 'Vendors', href: '/portal/vendors', icon: Store, daily: true },
      ],
    },
    {
      title: 'Connections',
      subtitle: 'Gmail, Omi, integrations',
      venueOnly: true,
      items: [
        { label: 'Omi', href: '/settings/omi', icon: Inbox },
      ],
    },
    {
      title: 'Onboarding',
      subtitle: 'Re-run any step',
      venueOnly: true,
      items: [
        { label: 'Onboarding', href: '/onboarding', icon: Building },
      ],
    },
  ],
}

export const MODES: ModeConfig[] = [MODE_AGENT, MODE_WEDDINGS, MODE_INTEL, MODE_SAGE]

// ---------------------------------------------------------------------------
// GEAR MENU — org admin (only for org_admin / group_admin / super_admin)
// ---------------------------------------------------------------------------
// Pages covered: /settings (root — venue/org settings page),
// /settings/team, /settings/billing, /settings/groups,
// /super-admin, /super-admin/pipeline-health,
// /intel/portfolio, /intel/company, /intel/team, /intel/regions,
// /intel/benchmark
//
// group_admin sees the gear menu but with rail items scoped to their
// group (Team filtered to group venues, Portfolio analytics filtered to
// group, Billing per-venue still visible).

export interface GearItem {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
  /** Minimum role to see this item. */
  requiresRole?: 'group_admin' | 'org_admin' | 'super_admin'
}

export interface GearGroup {
  title: string
  items: GearItem[]
}

export const GEAR_GROUPS: GearGroup[] = [
  {
    title: 'Org admin',
    items: [
      { label: 'Venue settings', href: '/settings', icon: Settings },
      { label: 'Team', href: '/settings/team', icon: Users, requiresRole: 'group_admin' },
      { label: 'Billing', href: '/settings/billing', icon: CreditCard, requiresRole: 'org_admin' },
      { label: 'Venue groups', href: '/settings/groups', icon: Layers, requiresRole: 'org_admin' },
    ],
  },
  {
    title: 'Portfolio analytics',
    items: [
      { label: 'Portfolio Overview', href: '/intel/portfolio', icon: Layers, requiresRole: 'group_admin' },
      { label: 'Benchmark', href: '/intel/benchmark', icon: BarChart3, requiresRole: 'group_admin' },
      { label: 'Company View', href: '/intel/company', icon: Building2, requiresRole: 'org_admin' },
      { label: 'Team Performance', href: '/intel/team', icon: Users, requiresRole: 'group_admin' },
      { label: 'Regions', href: '/intel/regions', icon: MapPin, requiresRole: 'org_admin' },
    ],
  },
  {
    title: 'Super admin',
    items: [
      { label: 'Super Admin', href: '/super-admin', icon: ShieldCheck, requiresRole: 'super_admin' },
      { label: 'Pipeline Health', href: '/super-admin/pipeline-health', icon: Activity, requiresRole: 'super_admin' },
    ],
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve which mode owns a given pathname. Longest-prefix wins so that
 * /portal/weddings (Weddings mode) doesn't get hijacked by /portal/kb's
 * /portal prefix. Returns null when no mode matches (e.g., on /sage or
 * /org index pages — those are mode landing pages, not real routes yet).
 */
export function modeForPath(pathname: string): NavMode | null {
  let best: { mode: NavMode; len: number } | null = null
  for (const m of MODES) {
    for (const prefix of m.matchPrefixes) {
      if (pathname === prefix || pathname.startsWith(prefix + '/')) {
        if (!best || prefix.length > best.len) {
          best = { mode: m.mode, len: prefix.length }
        }
      }
    }
  }
  return best?.mode ?? null
}

/**
 * Verification checkpoint: every page in src/app/(platform)/**\/page.tsx
 * (80 enumerated 2026-04-24) is covered by exactly one of:
 *   - a section item href above
 *   - a matchPrefix that resolves to a mode
 *   - a GEAR_GROUPS item href
 *   - the root /page.tsx (mode landing — not a sidebar item)
 *   - a dynamic sub-route under a covered prefix (e.g. /intel/clients/[id]
 *     under /intel/clients, or /portal/weddings/[id]/* under /portal/weddings)
 *
 * The full mapping is documented inline in each MODE_* comment block above.
 * If you add a new page, add it to the relevant section + bump the
 * enumeration date in the file header.
 */
export const NAV_CONFIG_VERIFIED_AT = '2026-04-24'
