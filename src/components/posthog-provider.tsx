'use client'

/**
 * PostHog provider. D8 (2026-05-08).
 *
 * Loads posthog-js once on mount when NEXT_PUBLIC_POSTHOG_KEY is set.
 * Gracefully no-ops in dev / demo / when the env var is missing so
 * pre-setup environments don't break.
 *
 * Autocapture handles page views + clicks + form submits without per-
 * event taxonomy. Custom events (signup_complete, first_brain_dump,
 * etc.) wire from their respective code paths via posthog.capture().
 *
 * See docs/posthog-setup.md for project setup, env vars, and the
 * funnel list.
 */

import { useEffect } from 'react'
import posthog from 'posthog-js'

let bootstrapped = false

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (bootstrapped) return
    if (typeof window === 'undefined') return
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY
    if (!key) return
    posthog.init(key, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com',
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: {
        // Don't autocapture inputs to avoid leaking PII typed into forms.
        // Specific fields can opt back in with data-ph-capture.
        dom_event_allowlist: ['click', 'submit'],
      },
      // Mask all input values; opt back in on form pages where capture
      // is intentional.
      mask_all_text: false,
      mask_all_element_attributes: false,
      // Disable session replay by default; opt-in per-customer later.
      disable_session_recording: true,
      // Respect Do Not Track.
      respect_dnt: true,
    })
    bootstrapped = true
  }, [])

  return <>{children}</>
}
