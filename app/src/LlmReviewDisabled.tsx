import type { LlmReviewDialogProps } from './LlmReviewDialog'

// The local-only edition resolves the review-dialog import to this component
// at build time. Keeping the props identical lets App stay edition-agnostic
// while excluding the LLM UI, settings and review workflow from the bundle.
export default function LlmReviewDisabled(props: LlmReviewDialogProps) {
  void props
  return null
}
