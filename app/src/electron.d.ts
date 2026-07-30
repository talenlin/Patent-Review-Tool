export {}

declare global {
  type PatentSelectionAnchor = {
    startParagraphText: string
    startOffset: number
    endParagraphText: string
    endOffset: number
    pdfRects?: Array<{
      pageNumber: number
      left: number
      top: number
      width: number
      height: number
    }>
  }

  type PatentAnnotation = {
    type: string
    severity: string
    status: string
    author: string
    body: string
    location: string
    selectedText: string | null
    selectionAnchor: PatentSelectionAnchor | null
  }

  type PatentCloudOcrPayload = {
    provider: 'local' | 'ocr-space' | 'google-vision' | 'paddle-ocr' | 'custom'
    imageDataUrl: string
    imageWidth: number
    imageHeight: number
    apiKey: string
    endpoint: string
    model: string
    interfaceName: string
  }

  type PatentCloudOcrResult = {
    words: Array<{
      text: string
      left: number
      top: number
      width: number
      height: number
      confidence: number
    }>
  }

  type PatentRatingsPayload = {
    technicalUnderstanding: string
    communication: string
    patentQuality: string
  }

  type PatentLlmCompletionPayload = {
    provider: string
    endpoint: string
    apiKey: string
    model: string
    system: string
    user: string
    purpose: string
  }

  type PatentLlmModelListPayload = {
    provider: string
    endpoint: string
    apiKey: string
  }

  type PatentMcpTool = {
    name: string
    description: string
    inputSchema: Record<string, unknown>
  }

  type PatentMcpListToolsPayload = {
    endpoint: string
    apiKey: string
    headersJson: string
  }

  type PatentResearchListToolsPayload = {
    provider: 'zhipu' | 'patsnap-mcp' | 'epo-ops' | 'custom-mcp'
    endpoint: string
    apiKey: string
    clientSecret: string
    headersJson: string
  }

  type PatentResearchToolCallPayload = PatentResearchListToolsPayload & {
    searchEngine: string
    count: number
    toolName: string
    arguments: Record<string, unknown>
  }

  type PatentLlmAgentMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | null
    tool_call_id?: string
    tool_calls?: Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
  }

  type PatentLlmAgentTurnPayload = {
    provider: string
    endpoint: string
    apiKey: string
    model: string
    purpose: string
    messages: PatentLlmAgentMessage[]
    tools: PatentMcpTool[]
  }

  type PatentLlmAgentTurnResult = {
    content: string
    assistantMessage: PatentLlmAgentMessage
    toolCalls: Array<{
      id: string
      name: string
      arguments: Record<string, unknown>
    }>
  }

  type PatentRetrievalExecutePayload = {
    provider: 'zhipu' | 'patsnap-mcp' | 'epo-ops' | 'custom-mcp'
    endpoint: string
    apiKey: string
    clientSecret: string
    searchEngine: string
    count: number
    toolName: string
    argumentTemplate: string
    headersJson: string
    queries: string[]
  }

  type PatentLlmReviewFindingPayload = {
    module: string
    severity: string
    evidenceLevel: string
    title: string
    location: string
    quote: string
    analysis: string
    recommendation: string
    sources: string
    accepted: boolean
  }

  type PatentLlmReviewReportPayload = {
    technicalField: string
    rulebookVersion: string
    rulebookVerifiedAt: string
    provider: string
    model: string
    generatedAt: string
    findings: PatentLlmReviewFindingPayload[]
  }

  type PatentSaveRevisionResult = {
    revisionPath: string
    ratingPath: string | null
    reviewPath: string | null
  }

  interface Window {
    patentReader?: {
      openDocument: () => Promise<{
        path: string
        name: string
        extension: 'docx' | 'pdf'
        base64: string
      } | null>
      saveRevision: (
        originalPath: string,
        annotations: PatentAnnotation[],
        ratings: PatentRatingsPayload,
        llmReport: PatentLlmReviewReportPayload | null,
      ) => Promise<PatentSaveRevisionResult>
      openComparisonDocuments?: () => Promise<Array<{
        path: string
        name: string
        extension: 'docx' | 'pdf'
        base64: string
      }>>
      cloudOcr?: (payload: PatentCloudOcrPayload) => Promise<PatentCloudOcrResult>
      llmCompletion?: (payload: PatentLlmCompletionPayload) => Promise<{ content: string }>
      llmListModels?: (payload: PatentLlmModelListPayload) => Promise<{ models: string[] }>
      llmAgentTurn?: (payload: PatentLlmAgentTurnPayload) => Promise<PatentLlmAgentTurnResult>
      mcpListTools?: (payload: PatentMcpListToolsPayload) => Promise<{ tools: PatentMcpTool[] }>
      retrievalListTools?: (payload: PatentResearchListToolsPayload) => Promise<{ tools: PatentMcpTool[] }>
      retrievalCallTool?: (payload: PatentResearchToolCallPayload) => Promise<{ content: string }>
      retrievalExecute?: (payload: PatentRetrievalExecutePayload) => Promise<{ content: string }>
      openExternalUrl?: (url: string) => Promise<void>
    }
  }
}
