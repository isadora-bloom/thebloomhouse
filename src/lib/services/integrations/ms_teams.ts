/**
 * Microsoft Teams adapter (scaffold).
 *
 * Future video provider for venues on Microsoft 365. Adapter shape
 * lands when the first venue requests it.
 */

import type { IntegrationAdapter } from './types'
import { DISCONNECTED_STATUS } from './types'

export const msTeamsAdapter: IntegrationAdapter = {
  name: 'ms_teams',
  label: 'Microsoft Teams',
  category: 'video',
  description: 'Pull meeting transcripts from Microsoft Teams into the lead timeline.',
  authShape: 'oauth',
  ready: false,
  deepConfigHref: null,
  iconName: 'Video',
  async getStatus() {
    return { ...DISCONNECTED_STATUS, statusLine: 'Coming soon' }
  },
}
