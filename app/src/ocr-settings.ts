export type OcrProvider = 'local' | 'ocr-space' | 'google-vision' | 'paddle-ocr' | 'custom'

export type OcrProfile = {
  apiKey: string
  endpoint: string
  model: string
  interfaceName: string
}

export type OcrSettingsStore = {
  provider: OcrProvider
  profiles: Record<OcrProvider, OcrProfile>
}

export type OcrSettings = OcrProfile & {
  provider: OcrProvider
}

export const ocrProviderLabels: Record<OcrProvider, string> = {
  local: '本机 OCR',
  'ocr-space': 'OCR.Space',
  'google-vision': 'Google Cloud Vision',
  'paddle-ocr': 'PaddleOCR',
  custom: '自定义 OCR',
}

export const ocrProviderApiLinks: Partial<Record<OcrProvider, string>> = {
  'ocr-space': 'https://ocr.space/ocrapi/freekey',
  'google-vision': 'https://console.cloud.google.com/apis/credentials',
  'paddle-ocr': 'https://aistudio.baidu.com/account/accessToken',
}

const defaultProfiles: Record<OcrProvider, OcrProfile> = {
  local: { apiKey: '', endpoint: '', model: '', interfaceName: '本机 OCR' },
  'ocr-space': { apiKey: '', endpoint: 'https://api.ocr.space/parse/image', model: 'OCREngine 2', interfaceName: 'OCR.Space' },
  'google-vision': { apiKey: '', endpoint: 'https://vision.googleapis.com/v1/images:annotate', model: 'TEXT_DETECTION', interfaceName: 'Google Cloud Vision' },
  'paddle-ocr': { apiKey: '', endpoint: 'https://paddleocr.aistudio-app.com', model: 'PP-OCRv6', interfaceName: 'PaddleOCR' },
  custom: { apiKey: '', endpoint: '', model: '', interfaceName: '' },
}

export function createDefaultOcrSettingsStore(): OcrSettingsStore {
  return {
    provider: 'local',
    profiles: Object.fromEntries(
      Object.entries(defaultProfiles).map(([provider, profile]) => [provider, { ...profile }]),
    ) as Record<OcrProvider, OcrProfile>,
  }
}

export function activeOcrSettings(store: OcrSettingsStore): OcrSettings {
  return { provider: store.provider, ...store.profiles[store.provider] }
}

export function updateOcrProfile(
  store: OcrSettingsStore,
  provider: OcrProvider,
  patch: Partial<OcrProfile>,
): OcrSettingsStore {
  return {
    ...store,
    profiles: {
      ...store.profiles,
      [provider]: { ...store.profiles[provider], ...patch },
    },
  }
}

export function parseStoredOcrSettings(value: string | null): OcrSettingsStore {
  const fallback = createDefaultOcrSettingsStore()
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value) as Partial<OcrSettingsStore> & Partial<OcrSettings>
    if (parsed.profiles && parsed.provider && parsed.provider in ocrProviderLabels) {
      const provider = parsed.provider as OcrProvider
      const profiles = { ...fallback.profiles }
      for (const key of Object.keys(ocrProviderLabels) as OcrProvider[]) {
        const storedProfile = parsed.profiles[key]
        if (storedProfile) profiles[key] = { ...profiles[key], ...storedProfile }
      }
      return { provider, profiles }
    }

    // Migrate the pre-1.2.3 flat record. Its credential belongs only to the
    // provider that was active when it was saved, so it must never be copied
    // into another provider's profile.
    if (parsed.provider && parsed.provider in ocrProviderLabels) {
      const provider = parsed.provider as OcrProvider
      return updateOcrProfile(
        { ...fallback, provider },
        provider,
        {
          apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
          model: typeof parsed.model === 'string' ? parsed.model : fallback.profiles[provider].model,
        },
      )
    }
  } catch {
    // Ignore malformed local data and use safe defaults.
  }
  return fallback
}
