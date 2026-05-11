/**
 * RingCentral adapter (scaffold).
 *
 * Future phone provider. Adapter shape lands when the first venue
 * requests it.
 */

import type { IntegrationAdapter } from './types'
import { DISCONNECTED_STATUS } from './types'

export const ringcentralAdapter: IntegrationAdapter = {
  name: 'ringcentral',
  label: 'RingCentral',
  category: 'phone',
  description: 'Cloud phone, SMS, fax, and video — common in larger venue operations.',
  authShape: 'oauth',
  ready: false,
  deepConfigHref: null,
  iconName: 'Phone',
  async getStatus() {
    return { ...DISCONNECTED_STATUS, statusLine: 'Coming soon' }
  },
}
