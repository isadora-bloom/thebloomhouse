/**
 * Vonage adapter (scaffold).
 *
 * Future phone / SMS provider. Adapter shape lands when the first venue
 * requests it.
 */

import type { IntegrationAdapter } from './types'
import { DISCONNECTED_STATUS } from './types'

export const vonageAdapter: IntegrationAdapter = {
  name: 'vonage',
  label: 'Vonage',
  category: 'phone',
  description: 'Programmable voice and SMS via the Vonage Communications API.',
  authShape: 'api_key',
  ready: false,
  deepConfigHref: null,
  iconName: 'Phone',
  async getStatus() {
    return { ...DISCONNECTED_STATUS, statusLine: 'Coming soon' }
  },
}
