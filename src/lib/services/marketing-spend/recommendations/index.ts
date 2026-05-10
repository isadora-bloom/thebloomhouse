/**
 * Wave 6C — marketing recommendations service barrel.
 */

export {
  generateMarketingRecommendations,
  listMarketingRecommendations,
  getMarketingRecommendation,
  decideMarketingRecommendation,
  measureMarketingRecommendation,
  MARKETING_RECOMMENDATIONS_PROMPT_VERSION,
  type GenerateMarketingRecommendationsOptions,
  type GenerateMarketingRecommendationsResult,
  type StoredMarketingRecommendationRow,
  type ListRecommendationsOptions,
  type DecideRecommendationInput,
  type MarketingRecommendation,
  type RecommendationRefusal,
} from './generate'

export {
  runMarketingRecommendationSweep,
  type MarketingRecommendationSweepResult,
  type RunMarketingRecommendationSweepOptions,
} from './sweep'
