/**
 * Whereby adapter (scaffold).
 *
 * Future video provider (browser-based, no-download meetings).
 * Adapter shape lands when the first venue requests it.
 */

import type { IntegrationAdapter } from './types'
import { DISCONNECTED_STATUS } from './types'

export const wherebyAdapter: IntegrationAdapter = {
  name: 'whereby',
  label: 'Whereby',
  category: 'video',
  description: 'Browser-based meetings with API-driven transcripts.',
  authShape: 'api_key',
  ready: false,
  deepConfigHref: null,
  iconName: 'Video',
  async getStatus() {
    return { ...DISCONNECTED_STATUS, statusLine: 'Coming soon' }
  },
}
