export type LlmReviewSessionStatus =
  | 'idle'
  | 'planning'
  | 'loading-files'
  | 'loading-models'
  | 'connecting-retrieval'
  | 'reviewing'

export type LlmReviewSessionDraft = {
  manualField?: string
  fieldChoice?: 'manual' | 'detected'
  modules?: Record<string, boolean>
  scope?: string
  comparisonDocuments?: Array<{ name: string; text: string }>
  technicalSearchEnabled?: boolean
  priorArtSearchEnabled?: boolean
  technicalSearchPlan?: string
  technicalSearchPlanConfirmed?: boolean
  priorArtSearchPlan?: string
  priorArtSearchPlanConfirmed?: boolean
  technicalResearchTrace?: unknown[]
  priorArtResearchTrace?: unknown[]
  technicalResearchSummary?: string
  priorArtResearchSummary?: string
  technicalFactBundle?: unknown
  selectedTechnicalFactIds?: string[]
  findingSort?: string
  priorArtCandidates?: unknown[]
  selectedPriorArtId?: string
  pendingTechnicalEvidence?: string
  pendingPriorArtEvidence?: string
  pendingReviewModules?: string[]
  completedReviewModules?: string[]
  completedReviewPacketIds?: string[]
  reviewProgress?: {
    current: number
    total: number
    moduleName: string
    completed: number
    generatedCards: number
  } | null
  pendingPriorArtSearchEnabled?: boolean
  status?: LlmReviewSessionStatus
}

export type RestoredLlmReviewSession = LlmReviewSessionDraft & {
  status: 'idle'
  wasInterrupted: boolean
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const sessionVersion = 1
const sessionPrefix = 'patent-reader.llm-review-session.'

function fingerprint(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${value.length.toString(36)}-${(hash >>> 0).toString(36)}`
}

export function createLlmReviewSessionKey(patentText: string) {
  return `${sessionPrefix}${fingerprint(patentText)}`
}

export function saveLlmReviewSession(
  storage: StorageLike,
  key: string,
  draft: LlmReviewSessionDraft,
) {
  try {
    storage.setItem(key, JSON.stringify({
      version: sessionVersion,
      savedAt: new Date().toISOString(),
      draft,
    }))
    return true
  } catch {
    return false
  }
}

export function loadLlmReviewSession(
  storage: StorageLike,
  key: string,
): RestoredLlmReviewSession | null {
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      version?: number
      draft?: LlmReviewSessionDraft
    }
    if (parsed.version !== sessionVersion || !parsed.draft || typeof parsed.draft !== 'object') {
      storage.removeItem(key)
      return null
    }
    const status = parsed.draft.status ?? 'idle'
    return {
      ...parsed.draft,
      status: 'idle',
      wasInterrupted: status !== 'idle',
    }
  } catch {
    storage.removeItem(key)
    return null
  }
}
