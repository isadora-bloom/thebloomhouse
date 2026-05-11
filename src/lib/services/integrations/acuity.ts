/**
 * Acuity Scheduling adapter (scaffold).
 *
 * Future calendar provider (Squarespace's scheduling tool). Tour-import
 * via the existing CRM tour-scheduler adapter (scaffold path) once the
 * first venue requests it.
 */

import type { IntegrationAdapter } from './types'
import { DISCONNECTED_STATUS } from './types'

export const acuityAdapter: IntegrationAdapter = {
  name: 'acuity',
  label: 'Acuity Scheduling',
  category: 'calendar',
  description: 'Bookings from Acuity Scheduling land as tour touchpoints.',
  authShape: 'oauth',
  ready: false,
  deepConfigHref: null,
  iconName: 'Calendar',
  async getStatus() {
    return { ...DISCONNECTED_STATUS, statusLine: 'Coming soon' }
  },
}
