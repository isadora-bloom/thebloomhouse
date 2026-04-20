/**
 * Bloom House: Supabase Database Types (Placeholder)
 *
 * Replace with `supabase gen types typescript` output for full type safety.
 * This file provides basic type coverage for the most-used tables so that
 * service files can reference column shapes without `as unknown`.
 */

// ---------------------------------------------------------------------------
// Core venue tables
// ---------------------------------------------------------------------------

export interface Venue {
  id: string
  org_id: string
  name: string
  slug: string
  website: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  timezone: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface VenueConfig {
  id: string
  venue_id: string
  website_url: string | null
  phone_number: string | null
  tour_booking_url: string | null
  pricing_calculator_url: string | null
  gmail_credentials: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface VenueAIConfig {
  id: string
  venue_id: string
  ai_name: string
  ai_emoji: string
  ai_email: string | null
  owner_name: string
  owner_title: string
  warmth_level: number
  formality_level: number
  playfulness_level: number
  brevity_level: number
  enthusiasm_level: number
  uses_contractions: boolean
  uses_exclamation_points: boolean
  emoji_level: string
  phrase_style: string
  follow_up_style: string
  max_follow_ups: number
  escalation_style: string
  sales_approach: string
  vibe: string
  signature_expressions: string[]
  signature_greeting: string | null
  signature_closer: string | null
  signoff: string
  // Sage identity (migration 059). ai_name already exists above.
  // ai_role is CHECK-constrained to an "AI <noun>" label.
  // ai_opener_shape controls structural variation across first-touch openers.
  ai_role: SageRole
  ai_purposes: string[]
  ai_custom_purpose: string | null
  ai_opener_shape: SageOpenerShape
  created_at: string
  updated_at: string
}

export type SageRole =
  | 'AI assistant'
  | 'AI concierge'
  | 'AI wedding helper'
  | 'AI coordinator'
  | 'AI guide'

export type SageOpenerShape =
  | 'direct'
  | 'warm-story'
  | 'question-first'
  | 'practical'

// ---------------------------------------------------------------------------
// Wedding & people
// ---------------------------------------------------------------------------

export interface Wedding {
  id: string
  venue_id: string
  source: string | null
  status: string
  wedding_date: string | null
  guest_count: number | null
  total_budget: number | null
  total_revenue: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Person {
  id: string
  wedding_id: string
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  role: string
  created_at: string
}

export interface Contact {
  id: string
  venue_id: string
  email: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  type: string
  wedding_id: string | null
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------
// Agent tables
// ---------------------------------------------------------------------------

export interface Interaction {
  id: string
  venue_id: string
  contact_id: string
  wedding_id: string | null
  direction: 'inbound' | 'outbound'
  channel: string
  subject: string | null
  body: string
  gmail_message_id: string | null
  gmail_thread_id: string | null
  created_at: string
}

export interface Draft {
  id: string
  venue_id: string
  interaction_id: string | null
  contact_id: string
  wedding_id: string | null
  subject: string
  body: string
  status: 'pending' | 'approved' | 'sent' | 'rejected'
  confidence: number
  task_type: string
  tokens_used: number
  cost: number
  approved_by: string | null
  sent_at: string | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Knowledge & intelligence
// ---------------------------------------------------------------------------

export interface SearchTrend {
  id: string
  venue_id: string
  term: string
  category: string
  volume: number
  change_percent: number
  period: string
  source: string
  created_at: string
}

export interface EconomicIndicator {
  id: string
  indicator_name: string
  value: number
  period: string
  source: string
  created_at: string
}

export interface AnomalyAlert {
  id: string
  venue_id: string
  alert_type: string
  metric_name: string
  expected_value: number
  actual_value: number
  severity: string
  ai_explanation: string | null
  acknowledged: boolean
  created_at: string
}

// ---------------------------------------------------------------------------
// Portal tables
// ---------------------------------------------------------------------------

export interface TimelineItem {
  id: string
  wedding_id: string
  title: string
  description: string | null
  start_time: string | null
  end_time: string | null
  type: string
  is_complete: boolean
  sort_order: number
  created_at: string
}

export interface BudgetItem {
  id: string
  wedding_id: string
  category: string
  vendor_name: string | null
  estimated_cost: number
  actual_cost: number | null
  is_paid: boolean
  notes: string | null
  created_at: string
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  confidence: number | null
  tokens_used: number | null
  cost: number | null
  created_at: string
}

// ---------------------------------------------------------------------------
// Database type (simplified)
// ---------------------------------------------------------------------------

export interface Database {
  public: {
    Tables: {
      venues: { Row: Venue }
      venue_config: { Row: VenueConfig }
      venue_ai_config: { Row: VenueAIConfig }
      weddings: { Row: Wedding }
      people: { Row: Person }
      contacts: { Row: Contact }
      interactions: { Row: Interaction }
      drafts: { Row: Draft }
      search_trends: { Row: SearchTrend }
      economic_indicators: { Row: EconomicIndicator }
      anomaly_alerts: { Row: AnomalyAlert }
      timeline: { Row: TimelineItem }
      budget: { Row: BudgetItem }
      messages: { Row: Message }
    }
  }
}
