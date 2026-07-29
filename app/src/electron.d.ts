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

  type PatentSaveRevisionResult = {
    revisionPath: string
    ratingPath: string | null
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
      ) => Promise<PatentSaveRevisionResult>
      cloudOcr?: (payload: PatentCloudOcrPayload) => Promise<PatentCloudOcrResult>
      openExternalUrl?: (url: string) => Promise<void>
    }
  }
}
