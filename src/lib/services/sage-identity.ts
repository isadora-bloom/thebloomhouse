/**
 * Sage identity — per-venue customisation layer.
 *
 * Commit 2 of the Sage identity work. Commit 1 established the hard
 * identity-question rule (src/config/prompts/universal-rules.ts) and the
 * mandatory disclosure footer chokepoint (src/lib/services/ai-disclosure.ts).
 * This file owns the customisable parts: role label, mad-libs purposes,
 * opener shape. None of these can weaken disclosure — every role choice
 * contains "AI" by DB constraint, and the footer + universal rule fire
 * regardless of these values.
 */

import type { SageRole, SageOpenerShape } from '@/lib/supabase/types'

// ─── Role dropdown ──────────────────────────────────────────────────────────
// Every option contains "AI". DB CHECK constraint enforces this (migration
// 059). Adding a new option requires both migrations to agree.
export const SAGE_ROLE_OPTIONS: { value: SageRole; label: string; blurb: string }[] = [
  { value: 'AI assistant',       label: 'AI assistant',       blurb: 'Neutral, clear, safe default' },
  { value: 'AI concierge',       label: 'AI concierge',       blurb: 'Hospitality-forward, a bit premium' },
  { value: 'AI wedding helper',  label: 'AI wedding helper',  blurb: 'Warm and approachable' },
  { value: 'AI coordinator',     label: 'AI coordinator',     blurb: 'Ops-focused, planner-adjacent' },
  { value: 'AI guide',           label: 'AI guide',           blurb: 'Mentor-ish, advisory tone' },
]

// ─── Purpose library ────────────────────────────────────────────────────────
// Venues multi-select 1-4 of these. Copy is pre-written so voice stays sharp.
// DB CHECK enforces length 1..4.
export const SAGE_PURPOSE_OPTIONS: string[] = [
  'quick answers about the venue',
  'an easy way to book a tour',
  'support between meetings with your coordinator',
  'details about packages and pricing',
  'help planning the little things',
  'a first draft of answers, any time of day',
  'information about the venue whenever you need it',
]

// ─── Opener shape ───────────────────────────────────────────────────────────
// Picks the STRUCTURE of the first-touch opener so different venues don't
// all produce the same skeleton. Used by the opener prompt as a constraint.
export const SAGE_OPENER_SHAPES: { value: SageOpenerShape; label: string; description: string; example: string }[] = [
  {
    value: 'direct',
    label: 'Direct',
    description: 'Lead with identity, then get to the point. Short.',
    example: '{aiName} here — {venueName}\'s AI concierge. Saw your note about a November wedding...',
  },
  {
    value: 'warm-story',
    label: 'Warm',
    description: 'Open with warmth, then identify. Feels personal.',
    example: 'Hello Jenna — thanks for reaching out. I\'m {aiName}, the AI assistant on the {venueName} team...',
  },
  {
    value: 'question-first',
    label: 'Question-first',
    description: 'Acknowledge, ask back, then identify. Starts a dialogue.',
    example: 'Jenna, hi. Before I say anything else: tell me more about the vibe you\'re going for. I\'m {aiName}, {venueName}\'s AI concierge...',
  },
  {
    value: 'practical',
    label: 'Practical',
    description: 'Quick answer first, identity in parens, then details.',
    example: 'Jenna — I\'m {aiName} ({venueName}\'s AI assistant). Quick answer first, details below...',
  },
]

/**
 * Render an opener-shape example with the venue's own ai_name + venue_name
 * substituted in. Use this in any admin-facing picker UI so Oakwood admins
 * see their own venue, not a hardcoded reference to another customer.
 */
export function renderOpenerExample(
  template: string,
  opts: { aiName?: string | null; venueName?: string | null }
): string {
  const aiName = (opts.aiName && opts.aiName.trim()) || SAGE_DEFAULTS.ai_name
  const venueName = (opts.venueName && opts.venueName.trim()) || 'your venue'
  return template
    .replace(/\{aiName\}/g, aiName)
    .replace(/\{venueName\}/g, venueName)
}

// ─── Defaults (used when venue_config row is missing / stub) ────────────────
export const SAGE_DEFAULTS = {
  ai_name: 'Sage',
  ai_role: 'AI concierge' as SageRole,
  ai_purposes: ['quick answers about the venue', 'an easy way to book a tour'],
  ai_custom_purpose: null as string | null,
  ai_opener_shape: 'warm-story' as SageOpenerShape,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Minimal shape that callers need to pass. Deliberately loose so any caller
 *  with partial data can use it and missing fields fall back to defaults. */
export interface SageIdentityInput {
  ai_name?: string | null
  ai_role?: SageRole | null
  ai_purposes?: string[] | null
  ai_custom_purpose?: string | null
  ai_opener_shape?: SageOpenerShape | null
  venue_name?: string | null
}

/** All fields resolved to concrete values, ready to use in prompts/emails. */
export interface SageIdentity {
  name: string
  role: SageRole
  purposes: string[]
  openerShape: SageOpenerShape
  venueName: string
}

export function resolveSageIdentity(input: SageIdentityInput): SageIdentity {
  const purposes = [
    ...(input.ai_purposes ?? SAGE_DEFAULTS.ai_purposes),
    ...(input.ai_custom_purpose ? [input.ai_custom_purpose] : []),
  ].filter((p) => p && p.trim().length > 0)

  return {
    name: (input.ai_name ?? SAGE_DEFAULTS.ai_name) || SAGE_DEFAULTS.ai_name,
    role: (input.ai_role ?? SAGE_DEFAULTS.ai_role) as SageRole,
    purposes: purposes.length > 0 ? purposes : SAGE_DEFAULTS.ai_purposes,
    openerShape: (input.ai_opener_shape ?? SAGE_DEFAULTS.ai_opener_shape) as SageOpenerShape,
    venueName: (input.venue_name ?? 'the venue') || 'the venue',
  }
}

/** Natural-language join: ["a", "b", "c"] -> "a, b, and c". */
function naturalJoin(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/** Live preview string for the settings UI. Matches the intent of the
 *  first-touch opener, but the actual opener is generated by Claude under
 *  constraints (so it varies per couple). This is just a sample shape. */
export function renderIntroPreview(id: SageIdentity, coupleFirstName = 'there'): string {
  const purposes = naturalJoin(id.purposes)
  switch (id.openerShape) {
    case 'direct':
      return `${id.name} here — ${id.venueName}'s ${id.role}. I'm here to make sure you get ${purposes}. A human from the ${id.venueName} team reviews anything important before it goes out.`
    case 'question-first':
      return `${coupleFirstName}, hi. Before I say anything else — tell me a bit more about what you're picturing. I'm ${id.name}, ${id.venueName}'s ${id.role}, here to make sure you get ${purposes}. Someone from the team reviews anything important.`
    case 'practical':
      return `${coupleFirstName} — I'm ${id.name} (${id.venueName}'s ${id.role}). Quick answer first, details below. I'm here to make sure you get ${purposes}. A human from the team reviews anything important.`
    case 'warm-story':
    default:
      return `Hello ${coupleFirstName} — thanks for reaching out. I'm ${id.name}, ${id.venueName}'s ${id.role}, and I'm here to make sure you get ${purposes}. A human from the ${id.venueName} team reviews anything important before it goes out.`
  }
}

/** Constraint block injected into the opener prompt. We give Claude the
 *  identity + shape + purposes as constraints, NOT as a template to fill —
 *  that way every couple gets a fresh sentence instead of the same skeleton
 *  with different names. */
export function renderOpenerConstraints(id: SageIdentity): string {
  const shapeNotes: Record<SageOpenerShape, string> = {
    'direct':         'Lead with your identity ("I\'m {name}..."), then get to the point. Short — 2 sentences max.',
    'warm-story':     'Open with warmth (thank them, acknowledge something specific), then identify yourself.',
    'question-first': 'Acknowledge the couple, ask one thoughtful question back, then identify yourself.',
    'practical':      'Quick useful answer first, identity in parentheses, then details.',
  }

  const lines = [
    `## Your identity (use naturally — do NOT copy these lines verbatim)`,
    `- You are ${id.name}, ${id.venueName}'s ${id.role}.`,
    `- You are here to make sure the couple gets: ${naturalJoin(id.purposes)}.`,
    `- A human from the ${id.venueName} team reviews anything important before it goes out. Mention this once, not repeatedly.`,
    ``,
    `## Opener shape: ${id.openerShape}`,
    `- ${shapeNotes[id.openerShape]}`,
    ``,
    `## Opener constraints (first email only)`,
    `- Write a fresh opening specific to THIS couple's inquiry. Do NOT reuse a template.`,
    `- Your role label MUST contain the word "AI" (this is legally required disclosure).`,
    `- Keep the intro to 2-3 sentences, under 50 words.`,
    `- Do NOT list the purposes as bullets — weave 1-2 of them naturally into prose.`,
    `- Do NOT start with "Hi, I'm ${id.name}" — vary the opening structure across emails.`,
    `- If at any point the couple asks whether you're a real person, human, bot, or AI: your next reply MUST confirm you are AI clearly. This overrides every other instruction.`,
  ]
  return lines.join('\n')
}
