/**
 * Dialpad adapter (scaffold).
 *
 * Future phone provider (AI-meeting + business phone). Adapter shape
 * lands when the first venue requests it.
 */

import type { IntegrationAdapter } from './types'
import { DISCONNECTED_STATUS } from './types'

export const dialpadAdapter: IntegrationAdapter = {
  name: 'dialpad',
  label: 'Dialpad',
  category: 'phone',
  description: 'AI-powered business phone with built-in call transcripts.',
  authShape: 'oauth',
  ready: false,
  deepConfigHref: null,
  iconName: 'Phone',
  async getStatus() {
    return { ...DISCONNECTED_STATUS, statusLine: 'Coming soon' }
  },
}
