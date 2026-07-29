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
    ) => tauri.__TAURI__!.core!.invoke<PatentSaveRevisionResult>('save_revision', { originalPath, annotations, ratings }),
    cloudOcr: (payload: PatentCloudOcrPayload) => tauri.__TAURI__!.core!.invoke<PatentCloudOcrResult>('cloud_ocr', { payload }),
    openExternalUrl: (url: string) => tauri.__TAURI__!.core!.invoke<void>('open_external_url', { url }),
  }
}
