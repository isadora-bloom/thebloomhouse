/**
 * Aircall adapter (scaffold).
 *
 * Future phone provider (cloud PBX with SMS, call recording, CRM
 * integrations). Adapter shape lands when the first venue requests it.
 */

import type { IntegrationAdapter } from './types'
import { DISCONNECTED_STATUS } from './types'

export const aircallAdapter: IntegrationAdapter = {
  name: 'aircall',
  label: 'Aircall',
  category: 'phone',
  description: 'Cloud phone system with SMS, call recording, and call summaries.',
  authShape: 'api_key',
  ready: false,
  deepConfigHref: null,
  iconName: 'Phone',
  async getStatus() {
    return { ...DISCONNECTED_STATUS, statusLine: 'Coming soon' }
  },
}
