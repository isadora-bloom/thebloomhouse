/**
 * Google Meet adapter (scaffold).
 *
 * Future video provider via Google's Meet API. Adapter shape lands
 * when the first venue requests it.
 */

import type { IntegrationAdapter } from './types'
import { DISCONNECTED_STATUS } from './types'

export const googleMeetAdapter: IntegrationAdapter = {
  name: 'google_meet',
  label: 'Google Meet',
  category: 'video',
  description: 'Pull meeting transcripts from Google Meet into the lead timeline.',
  authShape: 'oauth',
  ready: false,
  deepConfigHref: null,
  iconName: 'Video',
  async getStatus() {
    return { ...DISCONNECTED_STATUS, statusLine: 'Coming soon' }
  },
}
