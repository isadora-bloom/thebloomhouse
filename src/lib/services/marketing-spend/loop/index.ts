/**
 * Wave 6D — marketing loop service barrel.
 */

export {
  detectMarketingFlags,
  listMarketingFlags,
  getMarketingFlag,
  acknowledgeMarketingFlag,
  dismissMarketingFlag,
  actionMarketingFlag,
  type DetectMarketingFlagsInput,
  type DetectMarketingFlagsResult,
  type StoredMarketingSpendFlagRow,
  type ListFlagsOptions,
} from './flag-detector'

export {
  createAbTest,
  assignVariantToAttributionEvent,
  concludeAbTest,
  listAbTests,
  getAbTest,
  type CreateAbTestInput,
  type CreateAbTestResult,
  type AssignVariantInput,
  type AssignVariantResult,
  type ConcludeAbTestInput,
  type ConcludeAbTestResult,
  type StoredAbTestRow,
  type ListAbTestsOptions,
} from './ab-tests'

export {
  buildWeeklyDigest,
  getLatestDigest,
  listDigests,
  MARKETING_DIGEST_PROMPT_VERSION,
  type BuildWeeklyDigestOptions,
  type BuildWeeklyDigestResult,
  type StoredMarketingDigestRow,
} from './digest-builder'

export {
  runSpendLoopFlagSweep,
  type SpendLoopFlagSweepResult,
  type RunSpendLoopFlagSweepOptions,
} from './flag-sweep'

export {
  runMarketingDigestSweep,
  type MarketingDigestSweepResult,
  type RunMarketingDigestSweepOptions,
} from './digest-sweep'
