/**
 * Bloom House — Wave 19 knowledge-gaps service barrel.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority — captures are
 *     authoritative; gap detection is a signal, never an answer)
 *   - memory/feedback_deep_fix_vs_bandaid.md Pattern 8 (close the
 *     loop: detect → capture → fold-in)
 *
 * Re-exports the three Wave 19 surfaces so callers can import from
 * `@/lib/services/knowledge-gaps` without reaching into sub-files.
 */

export {
  detectKnowledgeGapsFromDraft,
  type DetectFromDraftInput,
  type DetectFromDraftResult,
} from './detect-from-draft'

export {
  captureKnowledge,
  dismissKnowledgeGap,
  type CaptureKnowledgeInput,
  type CaptureKnowledgeResult,
} from './capture'

export {
  buildVenueKnowledgeBlock,
  inferContextTags,
  type FoldInOptions,
  type FoldInResult,
} from './fold-in'
