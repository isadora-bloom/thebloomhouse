/**
 * Wave 6B — persona-channel-rollup service barrel.
 */

export {
  computePersonaChannelRollups,
  type ComputePersonaChannelRollupsInput,
  type ComputePersonaChannelRollupsResult,
} from './compute'

export {
  runPersonaChannelRollupSweep,
  type PersonaChannelRollupSweepResult,
  type RunPersonaChannelRollupSweepOptions,
} from './sweep'
