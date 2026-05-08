/**
 * Brain-dump help-mode answers.
 *
 * Added 2026-05-08 (Isadora feedback): the brain-dump should answer
 * "where do I do X" / "how do I X" questions inline, with click-through
 * links to the right surface, instead of sending the coordinator to
 * notifications. Help-mode does NOT propose-and-confirm — it returns
 * an answer + links and stamps the entry as confirmed immediately.
 *
 * The classifier promotes a free-text submission to intent='help_question'
 * when the text is question-shaped ("where do I", "how do I", "I can't
 * find", "is there a way to"). This module then does a focused Claude
 * call with the curated surface map below and returns
 * {body, links}. The route surfaces both fields back to the bubble.
 *
 * The surface map is a hand-curated index of Bloom routes derived from
 * src/components/shell/nav-config.ts. It's intentionally smaller than
 * the full nav so the LLM has a tight reference; if a question doesn't
 * match anything here, the model is instructed to admit it doesn't know
 * rather than hallucinate a path.
 */

import { callAIJson } from '@/lib/ai/client'

export const BRAIN_DUMP_HELP_PROMPT_VERSION = 'brain-dump-help.prompt.v1.0'

export interface BrainDumpHelpAnswer {
  body: string
  links: Array<{ label: string; href: string }>
}

/**
 * Curated surface map. ~40 entries grouped by topic. Each entry is a
 * (topic, summary) pair the LLM consults when composing the answer.
 * Keep paths in sync with nav-config.ts — when a route moves, update
 * here too. Routes that take a slug (e.g. /couple/[slug]/...) are
 * documented as templates so the LLM doesn't fabricate a UUID.
 */
export const HELP_SURFACE_MAP: Array<{
  topic: string
  href: string
  summary: string
  aliases?: string[]
}> = [
  // Reviews
  {
    topic: 'Bulk paste reviews',
    href: '/intel/reviews/paste',
    summary: 'Paste a wall of reviews from any source and Sage extracts each one. Use this for backlog import.',
    aliases: ['upload reviews', 'add reviews', 'paste reviews', 'import reviews'],
  },
  {
    topic: 'Reviews list',
    href: '/intel/reviews',
    summary: 'See every review with sentiment + phrase mining. The "Extract one" button on this page also adds a single review at a time. Screenshots of review pages also work via the brain dump.',
    aliases: ['see reviews', 'view reviews', 'reviews page'],
  },

  // Voice
  {
    topic: 'Voice DNA',
    href: '/intel/voice-dna',
    summary: 'The phrases and tone Sage learned from your past replies and confirmed reviews.',
    aliases: ['voice', 'tone', 'phrases sage uses'],
  },
  {
    topic: 'Teach Sage voice',
    href: '/agent/learning',
    summary: 'Drop sample replies + reviews so Sage can learn your house voice.',
    aliases: ['teach voice', 'voice training', 'train sage'],
  },
  {
    topic: 'Voice Games',
    href: '/settings/voice',
    summary: 'Quick games that pin down your tone (warmer vs more formal) without writing a full essay.',
    aliases: ['voice games', 'tone training game'],
  },
  {
    topic: 'Always / Never rules',
    href: '/agent/rules',
    summary: 'Hard rules Sage follows in every draft.',
    aliases: ['rules', 'never say', 'always say'],
  },

  // Gmail / connections
  {
    topic: 'Gmail connection',
    href: '/settings/gmail',
    summary: 'Disconnect, reconnect, or add an additional Gmail account here. Reconnecting Gmail: open this page, click Disconnect, then Add Gmail account.',
    aliases: ['reconnect gmail', 'gmail oauth', 'gmail integration'],
  },
  {
    topic: 'Audio capture',
    href: '/settings/audio-capture',
    summary: 'Wearable / mic provider settings (Omi, etc.) for transcript capture.',
    aliases: ['audio settings', 'omi', 'transcript capture'],
  },
  {
    topic: 'OpenPhone / SMS',
    href: '/settings/openphone',
    summary: 'Connect OpenPhone so SMS conversations land in the inbox.',
    aliases: ['sms', 'phone', 'openphone'],
  },

  // Tours
  {
    topic: 'Tours',
    href: '/intel/tours',
    summary: 'Upcoming tours, who is coming, conversion stats by source.',
    aliases: ['tour list', 'who is touring', 'tour schedule'],
  },

  // Leads / pipeline
  {
    topic: 'Leads & Heat Map',
    href: '/agent/leads',
    summary: 'Every active lead with heat score. Click into a lead for full forensic record.',
    aliases: ['leads', 'heat map', 'hot leads'],
  },
  {
    topic: 'Pipeline',
    href: '/agent/pipeline',
    summary: 'Kanban view of inquiries → tour → proposal → booked.',
    aliases: ['pipeline', 'funnel', 'kanban'],
  },
  {
    topic: 'Inbox',
    href: '/agent/inbox',
    summary: 'All inbound email threads.',
    aliases: ['inbox', 'emails', 'inquiries'],
  },
  {
    topic: 'Approval queue',
    href: '/agent/drafts',
    summary: 'Drafts waiting for human approval before send.',
    aliases: ['drafts', 'approval', 'review drafts'],
  },
  {
    topic: 'Lost Deals',
    href: '/intel/lost-deals',
    summary: 'Inquiries that did not convert plus the reason where Sage could infer it.',
    aliases: ['lost', 'no booking', 'why lost'],
  },
  {
    topic: 'Re-engagement',
    href: '/intel/reengagement',
    summary: 'Cold leads worth a second touch.',
    aliases: ['re-engagement', 'reengage', 'cold leads'],
  },

  // Brain dump
  {
    topic: 'Brain dump log',
    href: '/settings/brain-dump-log',
    summary: 'Every brain dump entry, whether confirmed, dismissed, or pending.',
    aliases: ['brain dump history', 'past dumps', 'dump log'],
  },
  {
    topic: 'Notifications',
    href: '/agent/notifications',
    summary: 'Anything Sage parked for clarification, plus payment alerts. Brain-dump confirmations now land inline in the bubble, but older parked items still live here.',
    aliases: ['notifications', 'pending confirmations'],
  },

  // Knowledge
  {
    topic: 'Knowledge base',
    href: '/portal/kb',
    summary: 'Q/A pairs Sage uses to answer couple and inquiry questions. Add an entry by typing the Q/A in the brain dump or by importing a CSV.',
    aliases: ['kb', 'knowledge', 'faq'],
  },
  {
    topic: 'Knowledge gaps',
    href: '/agent/knowledge-gaps',
    summary: 'Questions Sage was not sure about. Operational notes filed via the brain dump also surface here.',
    aliases: ['gaps', 'operational notes', 'sage uncertain'],
  },

  // Vendors
  {
    topic: 'Vendors',
    href: '/portal/vendors',
    summary: 'Preferred vendor list shown to couples in their portal.',
    aliases: ['vendors', 'preferred list'],
  },

  // Couples / portal
  {
    topic: 'All clients',
    href: '/intel/clients',
    summary: 'Every couple, booked or not. Click a couple for the full record. Each couple has their own portal at /couple/[slug].',
    aliases: ['couples', 'clients', 'all couples'],
  },
  {
    topic: 'Couple addresses',
    href: '/couple/[slug]/addresses',
    summary: 'Each couple has their own portal at /couple/<their-slug>/addresses where they enter shipping addresses, RSVP info, etc. The slug is on their lead detail page.',
    aliases: ['address', 'couple address', 'rsvp address'],
  },
  {
    topic: 'Couple timeline',
    href: '/couple/[slug]/timeline',
    summary: 'Each couple has a timeline at /couple/<slug>/timeline they edit themselves.',
    aliases: ['timeline', 'day-of timeline', 'wedding day timeline'],
  },
  {
    topic: 'Couple budget',
    href: '/couple/[slug]/budget',
    summary: 'Per-couple budget tracker at /couple/<slug>/budget.',
    aliases: ['budget'],
  },
  {
    topic: 'Couple checklist',
    href: '/couple/[slug]/checklist',
    summary: 'Per-couple planning checklist at /couple/<slug>/checklist. Templates for what shows up here are at /portal/checklist-config.',
    aliases: ['checklist', 'planning list'],
  },
  {
    topic: 'Weddings list',
    href: '/portal/weddings',
    summary: 'Coordinator view of every booked wedding.',
    aliases: ['weddings', 'booked weddings', 'my weddings'],
  },

  // Configs
  {
    topic: 'Wedding details template',
    href: '/portal/wedding-details-config',
    summary: 'The wedding-details form couples fill in.',
    aliases: ['wedding details', 'detail form'],
  },
  {
    topic: 'Checklist templates',
    href: '/portal/checklist-config',
    summary: 'Default checklist tasks shown to every new couple.',
    aliases: ['checklist template', 'task template'],
  },
  {
    topic: 'Tables & linens',
    href: '/portal/tables-config',
    summary: 'Table sizes and linen options the couple chooses from.',
    aliases: ['tables', 'linens'],
  },
  {
    topic: 'Bar config',
    href: '/portal/bar-config',
    summary: 'Bar packages and beverage options.',
    aliases: ['bar', 'beverages', 'drinks'],
  },
  {
    topic: 'Shuttles',
    href: '/portal/shuttle-config',
    summary: 'Transport / shuttle settings shown to couples.',
    aliases: ['shuttle', 'transport'],
  },
  {
    topic: 'Rehearsal',
    href: '/portal/rehearsal-config',
    summary: 'Rehearsal-dinner options.',
    aliases: ['rehearsal', 'rehearsal dinner'],
  },
  {
    topic: 'Floor plan / seating',
    href: '/portal/seating-config',
    summary: 'Seating chart and floor plan templates.',
    aliases: ['seating', 'floor plan', 'chart'],
  },
  {
    topic: 'Rooms & hotels',
    href: '/portal/rooms-config',
    summary: 'On-site rooms and partner-hotel block info.',
    aliases: ['rooms', 'hotels', 'room block'],
  },

  // Pricing / billing
  {
    topic: 'Pricing history',
    href: '/intel/pricing-history',
    summary: 'Every change to your pricing with notes.',
    aliases: ['pricing', 'pricing log'],
  },
  {
    topic: 'Billing',
    href: '/settings/billing',
    summary: 'Plan, invoices, payment method.',
    aliases: ['billing', 'subscription', 'invoice', 'payment'],
  },

  // Sage identity & venue info
  {
    topic: 'Sage identity',
    href: '/settings/sage-identity',
    summary: 'Sage\'s name, voice, signature, and how she introduces herself.',
    aliases: ['sage name', 'rename sage', 'ai name'],
  },
  {
    topic: 'Venue info & owner note',
    href: '/settings/venue-info',
    summary: 'Venue name, address, and the owner-note Sage uses for context.',
    aliases: ['venue settings', 'venue info', 'owner note'],
  },
  {
    topic: 'Venue logo / assets',
    href: '/portal/venue-assets-config',
    summary: 'Venue logo + downloadable resources couples see in their portal.',
    aliases: ['logo', 'venue logo', 'venue branding'],
  },
  {
    topic: 'What makes us different',
    href: '/portal/venue-usps-config',
    summary: 'USPs Sage weaves into outbound replies.',
    aliases: ['usps', 'unique selling points', 'differentiators'],
  },

  // Ops
  {
    topic: 'Auto-send & Follow-ups',
    href: '/agent/settings',
    summary: 'When Sage may auto-send vs queue for approval, plus follow-up cadence.',
    aliases: ['auto send', 'follow up', 'cadence'],
  },
  {
    topic: 'Auto-send shadow review',
    href: '/agent/auto-send-shadow',
    summary: 'Audit of what Sage was about to auto-send (shadow mode).',
    aliases: ['shadow', 'shadow review'],
  },
  {
    topic: 'Forbidden topics',
    href: '/agent/forbidden-topics',
    summary: 'Keywords that escalate a draft instead of auto-sending.',
    aliases: ['forbidden', 'escalate', 'never reply about'],
  },

  // Sources / ROI
  {
    topic: 'Sources & ROI',
    href: '/intel/sources',
    summary: 'Lead sources with cost-per-inquiry and book rate. Marketing-spend rows from the brain dump land here.',
    aliases: ['sources', 'roi', 'attribution', 'spend', 'marketing spend'],
  },
  {
    topic: 'Marketing channels',
    href: '/portal/marketing-channels-config',
    summary: 'The list of channels you actually use (Knot, WeddingWire, Instagram, Google, etc.).',
    aliases: ['channels', 'marketing channels'],
  },

  // Availability
  {
    topic: 'Availability',
    href: '/portal/availability',
    summary: 'Calendar of held / blocked / booked / open dates. Date changes proposed via the brain dump apply here on confirm.',
    aliases: ['availability', 'calendar', 'date blocks'],
  },

  // Observability
  {
    topic: 'Error monitor',
    href: '/agent/errors',
    summary: 'Pipeline errors and dropped emails.',
    aliases: ['errors', 'error log'],
  },
  {
    topic: 'Pipeline health',
    href: '/super-admin/pipeline-health',
    summary: 'Per-stage throughput for the email + classification pipeline. Super-admin only.',
    aliases: ['pipeline health', 'observability'],
  },
]

/**
 * Answer a help-shaped brain-dump question.
 *
 * Runs a focused Claude call with the surface map embedded. The model
 * is constrained to return only links from the curated map — if it
 * can't find a match, the body says so plainly rather than guessing.
 */
export async function answerHelpQuestion(args: {
  venueId: string
  question: string
}): Promise<BrainDumpHelpAnswer> {
  const { venueId, question } = args

  const surfaceList = HELP_SURFACE_MAP.map((s, i) => {
    const aliasNote = s.aliases?.length ? ` (also: ${s.aliases.join(', ')})` : ''
    return `${i + 1}. [${s.href}] ${s.topic}${aliasNote} - ${s.summary}`
  }).join('\n')

  const systemPrompt = `You answer "where do I" / "how do I" questions about The Bloom House, a wedding-venue intelligence platform. You have a curated map of every relevant surface below. Use ONLY hrefs from this list. If no entry matches, say "I'm not sure where that lives. The closest pages are: ..." and suggest the two or three nearest items.

Never invent a path. Never use markdown. Never use em-dashes. Return JSON matching exactly:
{
  "body": "two to four sentences answering the question in plain English",
  "links": [{"label": "<short button label>", "href": "<path from the list>"}]
}

Rules:
- Pick at most 3 links, in priority order. Prefer one direct answer + one or two adjacent surfaces.
- For paths with [slug] templates, keep the [slug] placeholder and explain it in the body.
- The body should answer the question first, then briefly mention the link(s).
- Keep the answer tight: a coordinator wants a click-through, not an essay.

Surface map:
${surfaceList}`

  const userPrompt = `Question: "${question}"\n\nReturn JSON only.`

  const parsed = await callAIJson<BrainDumpHelpAnswer>({
    systemPrompt,
    userPrompt,
    venueId,
    taskType: 'brain_dump_help_answer',
    maxTokens: 600,
    contentTier: 3,
    tier: 'haiku',
    promptVersion: BRAIN_DUMP_HELP_PROMPT_VERSION,
  })

  // Defensive normalisation: drop links that didn't come from the map.
  // The model occasionally returns close-but-wrong paths (e.g.
  // /intel/reviews-paste vs /intel/reviews/paste). We only allow paths
  // that match a known prefix or template.
  const allowedHrefs = new Set(HELP_SURFACE_MAP.map((s) => s.href))
  const safeLinks = (Array.isArray(parsed.links) ? parsed.links : [])
    .filter((l): l is { label: string; href: string } =>
      typeof l?.label === 'string' && typeof l?.href === 'string')
    .filter((l) => {
      if (allowedHrefs.has(l.href)) return true
      // Permit /couple/[slug]/... templates the model may have left unsubstituted.
      if (l.href.startsWith('/couple/[slug]/')) return true
      return false
    })
    .slice(0, 3)

  return {
    body: typeof parsed.body === 'string' && parsed.body.trim()
      ? parsed.body.trim()
      : "I'm not sure where that lives in the platform.",
    links: safeLinks,
  }
}
