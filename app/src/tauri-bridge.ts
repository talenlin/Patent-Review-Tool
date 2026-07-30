type TauriDocument = {
  path: string
  name: string
  extension: 'docx' | 'pdf'
  base64: string
}

type TauriWindow = Window & {
  __TAURI__?: {
    core?: {
      invoke: <T>(command: string, payload?: Record<string, unknown>) => Promise<T>
    }
  }
}

const tauri = window as TauriWindow

// Electron keeps providing this bridge itself. Tauri gets the same small UI-facing
// contract while Rust owns the actual local file operations.
if (!window.patentReader && tauri.__TAURI__?.core?.invoke) {
  window.patentReader = {
    openDocument: () => tauri.__TAURI__!.core!.invoke<TauriDocument | null>('open_document'),
    saveRevision: (
      originalPath: string,
      annotations: PatentAnnotation[],
      ratings: PatentRatingsPayload,
      llmReport: PatentLlmReviewReportPayload | null,
    ) => tauri.__TAURI__!.core!.invoke<PatentSaveRevisionResult>('save_revision', {
      originalPath,
      annotations,
      ratings,
      llmReport,
    }),
    openComparisonDocuments: () => tauri.__TAURI__!.core!.invoke<TauriDocument[]>('open_comparison_documents'),
    cloudOcr: (payload: PatentCloudOcrPayload) => tauri.__TAURI__!.core!.invoke<PatentCloudOcrResult>('cloud_ocr', { payload }),
    llmCompletion: (payload: PatentLlmCompletionPayload) => tauri.__TAURI__!.core!.invoke<{ content: string }>('llm_completion', { payload }),
    llmListModels: (payload: PatentLlmModelListPayload) => tauri.__TAURI__!.core!.invoke<{ models: string[] }>('llm_list_models', { payload }),
    llmAgentTurn: (payload: PatentLlmAgentTurnPayload) => tauri.__TAURI__!.core!.invoke<PatentLlmAgentTurnResult>('llm_agent_turn', { payload }),
    mcpListTools: (payload: PatentMcpListToolsPayload) => tauri.__TAURI__!.core!.invoke<{ tools: PatentMcpTool[] }>('mcp_list_tools', { payload }),
    retrievalListTools: (payload: PatentResearchListToolsPayload) => tauri.__TAURI__!.core!.invoke<{ tools: PatentMcpTool[] }>('retrieval_list_tools', { payload }),
    retrievalCallTool: (payload: PatentResearchToolCallPayload) => tauri.__TAURI__!.core!.invoke<{ content: string }>('retrieval_call_tool', { payload }),
    retrievalExecute: (payload: PatentRetrievalExecutePayload) => tauri.__TAURI__!.core!.invoke<{ content: string }>('retrieval_execute', { payload }),
    openExternalUrl: (url: string) => tauri.__TAURI__!.core!.invoke<void>('open_external_url', { url }),
  }
}
