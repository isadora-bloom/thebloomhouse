/**
 * Integration-adapter registry.
 *
 * Single source of truth for the Settings → Integrations hub. Pattern
 * mirrors src/lib/services/crm-import/index.ts: a flat array of
 * adapters plus a couple of helpers.
 *
 * To add a new provider:
 *   1. Create src/lib/services/integrations/<name>.ts exporting an
 *      IntegrationAdapter (see types.ts).
 *   2. Import it here and add it to INTEGRATION_ADAPTERS in its
 *      category cluster (the hub renders categories in the order
 *      they appear in CATEGORY_ORDER).
 *   3. If the adapter is ready=true and needs a deep-config page,
 *      add it under src/app/(platform)/settings/<name>/ or under
 *      src/app/(platform)/settings/integrations/<name>/.
 */

import type { IntegrationAdapter, IntegrationCategory } from './types'

import { gmailAdapter } from './gmail'
import { openphoneAdapter } from './openphone'
import { twilioAdapter } from './twilio'
import { aircallAdapter } from './aircall'
import { dialpadAdapter } from './dialpad'
import { ringcentralAdapter } from './ringcentral'
import { vonageAdapter } from './vonage'
import { zoomAdapter } from './zoom'
import { googleMeetAdapter } from './google_meet'
import { msTeamsAdapter } from './ms_teams'
import { wherebyAdapter } from './whereby'
import { calendlyAdapter } from './calendly'
import { acuityAdapter } from './acuity'
import { squareAppointmentsAdapter } from './square_appointments'
import { audioCaptureAdapter } from './audio_capture'
import { honeybookAdapter } from './honeybook'
import { dubsadoAdapter } from './dubsado'
import { aislePlannerAdapter } from './aisle_planner'

export const INTEGRATION_ADAPTERS: ReadonlyArray<IntegrationAdapter> = [
  // email
  gmailAdapter,
  // phone (OpenPhone is the recommended default; Twilio is the
  // webhook-style alternative; the rest are scaffolds).
  openphoneAdapter,
  twilioAdapter,
  aircallAdapter,
  dialpadAdapter,
  ringcentralAdapter,
  vonageAdapter,
  // video
  zoomAdapter,
  googleMeetAdapter,
  msTeamsAdapter,
  wherebyAdapter,
  // calendar
  calendlyAdapter,
  acuityAdapter,
  squareAppointmentsAdapter,
  // audio capture (one entry for Omi + Plaud; provider switch is
  // surfaced inside /settings/audio-capture).
  audioCaptureAdapter,
  // crm (presence-only on the hub; the real import flow lives at
  // /onboarding/crm-import).
  honeybookAdapter,
  dubsadoAdapter,
  aislePlannerAdapter,
]

/** Render order on the hub. Email first, then real-time channels, then
 *  scheduled-event channels, then offline imports. */
export const CATEGORY_ORDER: ReadonlyArray<IntegrationCategory> = [
  'email',
  'phone',
  'video',
  'calendar',
  'audio_capture',
  'crm',
  'sms_webhook',
]

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  email: 'Email',
  phone: 'Phone',
  video: 'Video',
  calendar: 'Calendar',
  audio_capture: 'Audio Capture',
  crm: 'CRM',
  sms_webhook: 'SMS (webhook)',
}

export const CATEGORY_BLURBS: Record<IntegrationCategory, string> = {
  email: 'Where Sage sends and receives on your behalf.',
  phone: 'SMS, voicemail, and call summaries on the lead timeline.',
  video: 'Meeting transcripts auto-attach to the matching tour.',
  calendar: 'Tour bookings show up the moment a couple picks a time.',
  audio_capture: 'Wearable transcripts attach to the tour they happened on.',
  crm: 'Pull historical leads, bookings, and communications from your existing CRM.',
  sms_webhook: 'Push-style SMS pipelines for venues already on another phone stack.',
}

export function adaptersByCategory(category: IntegrationCategory): IntegrationAdapter[] {
  return INTEGRATION_ADAPTERS.filter((a) => a.category === category)
}

export function findAdapter(name: string): IntegrationAdapter | null {
  return INTEGRATION_ADAPTERS.find((a) => a.name === name) ?? null
}
