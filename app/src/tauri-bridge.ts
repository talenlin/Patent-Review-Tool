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
      claimBasisReport: PatentClaimBasisReportPayload | null,
    ) => tauri.__TAURI__!.core!.invoke<PatentSaveRevisionResult>('save_revision', {
      originalPath,
      annotations,
      ratings,
      llmReport,
      claimBasisReport,
    }),
    openComparisonDocuments: () => tauri.__TAURI__!.core!.invoke<TauriDocument[]>('open_comparison_documents'),
    cloudOcr: (payload: PatentCloudOcrPayload) => tauri.__TAURI__!.core!.invoke<PatentCloudOcrResult>('cloud_ocr', { payload }),
    ocrPluginStatus: () => tauri.__TAURI__!.core!.invoke<PatentOcrPluginStatus>('ocr_plugin_status'),
    installPaddleOcrPlugin: () => tauri.__TAURI__!.core!.invoke<PatentOcrPluginStatus>('install_paddle_ocr_plugin'),
    llmCompletion: (payload: PatentLlmCompletionPayload) => tauri.__TAURI__!.core!.invoke<{ content: string }>('llm_completion', { payload }),
    llmListModels: (payload: PatentLlmModelListPayload) => tauri.__TAURI__!.core!.invoke<{ models: string[] }>('llm_list_models', { payload }),
    llmAgentTurn: (payload: PatentLlmAgentTurnPayload) => tauri.__TAURI__!.core!.invoke<PatentLlmAgentTurnResult>('llm_agent_turn', { payload }),
    mcpListTools: (payload: PatentMcpListToolsPayload) => tauri.__TAURI__!.core!.invoke<{ tools: PatentMcpTool[] }>('mcp_list_tools', { payload }),
    retrievalListTools: (payload: PatentResearchListToolsPayload) => tauri.__TAURI__!.core!.invoke<{ tools: PatentMcpTool[] }>('retrieval_list_tools', { payload }),
    retrievalCallTool: (payload: PatentResearchToolCallPayload) => tauri.__TAURI__!.core!.invoke<{ content: string }>('retrieval_call_tool', { payload }),
    retrievalExecute: (payload: PatentRetrievalExecutePayload) => tauri.__TAURI__!.core!.invoke<{ content: string }>('retrieval_execute', { payload }),
    openExternalUrl: (url: string) => tauri.__TAURI__!.core!.invoke<void>('open_external_url', { url }),
    saveUserGuide: () => tauri.__TAURI__!.core!.invoke<{ saved: boolean; path: string | null }>('save_user_guide'),
    checkForUpdate: () => tauri.__TAURI__!.core!.invoke<PatentUpdateCheck>('check_for_update'),
    onExitRequested: (handler: () => void) => {
      let checking = false
      let disposed = false
      const checkForCloseRequest = () => {
        if (checking || disposed) return
        checking = true
        void tauri.__TAURI__!.core!.invoke<boolean>('take_close_request')
          .then((requested) => { if (requested) handler() })
          .finally(() => { checking = false })
      }
      checkForCloseRequest()
      const timer = window.setInterval(checkForCloseRequest, 180)
      return Promise.resolve(() => {
        disposed = true
        window.clearInterval(timer)
      })
    },
    exitApp: () => tauri.__TAURI__!.core!.invoke<void>('exit_app'),
  }
}
