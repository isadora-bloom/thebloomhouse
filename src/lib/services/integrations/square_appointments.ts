/**
 * Square Appointments adapter (scaffold).
 *
 * Future calendar provider via the Square Appointments API. Adapter
 * shape lands when the first venue requests it.
 */

import type { IntegrationAdapter } from './types'
import { DISCONNECTED_STATUS } from './types'

export const squareAppointmentsAdapter: IntegrationAdapter = {
  name: 'square_appointments',
  label: 'Square Appointments',
  category: 'calendar',
  description: 'Bookings from Square Appointments land as tour touchpoints.',
  authShape: 'oauth',
  ready: false,
  deepConfigHref: null,
  iconName: 'Calendar',
  async getStatus() {
    return { ...DISCONNECTED_STATUS, statusLine: 'Coming soon' }
  },
}
