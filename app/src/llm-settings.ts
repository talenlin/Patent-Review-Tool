export type LlmProvider = 'openai' | 'deepseek' | 'qwen' | 'kimi' | 'custom'

export type LlmProviderProfile = {
  apiKey: string
  endpoint: string
  model: string
  interfaceName: string
}

export type LlmSettingsStore = {
  provider: LlmProvider
  profiles: Record<LlmProvider, LlmProviderProfile>
}

export type RetrievalProvider = 'zhipu' | 'patsnap-mcp' | 'epo-ops' | 'custom-mcp'

export type RetrievalProfile = {
  interfaceName: string
  endpoint: string
  apiKey: string
  clientSecret: string
  searchEngine: string
  count: number
  toolName: string
  argumentTemplate: string
  headersJson: string
  allowedToolNames: string[]
  maxSteps: number
}

export type RetrievalSettings = {
  provider: RetrievalProvider
  profiles: Record<RetrievalProvider, RetrievalProfile>
}

export const llmProviderLabels: Record<LlmProvider, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  qwen: '通义千问',
  kimi: 'Kimi',
  custom: '自定义兼容接口',
}

export const llmProviderApiLinks: Record<LlmProvider, string> = {
  openai: 'https://platform.openai.com/api-keys',
  deepseek: 'https://platform.deepseek.com/api_keys',
  qwen: 'https://bailian.console.aliyun.com/',
  kimi: 'https://platform.moonshot.cn/console/api-keys',
  custom: '',
}

export const defaultLlmSettings: LlmSettingsStore = {
  provider: 'openai',
  profiles: {
    openai: {
      apiKey: '',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-5.6-terra',
      interfaceName: 'OpenAI',
    },
    deepseek: {
      apiKey: '',
      endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-v4-pro',
      interfaceName: 'DeepSeek',
    },
    qwen: {
      apiKey: '',
      endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
      model: 'qwen-plus',
      interfaceName: '通义千问',
    },
    kimi: {
      apiKey: '',
      endpoint: 'https://api.moonshot.cn/v1/chat/completions',
      model: 'kimi-k2.6',
      interfaceName: 'Kimi',
    },
    custom: {
      apiKey: '',
      endpoint: '',
      model: '',
      interfaceName: '',
    },
  },
}

export function modelListEndpointFor(endpoint: string) {
  const normalized = endpoint.trim().replace(/\/+$/, '')
  if (!normalized) return ''
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized.replace(/\/chat\/completions$/i, '/models')
  }
  return `${normalized}/models`
}

export function retrievalProfileCanLoadTools(provider: RetrievalProvider, profile: RetrievalProfile) {
  if (!profile.endpoint.trim()) return false
  if (provider === 'epo-ops') return Boolean(profile.apiKey.trim() && profile.clientSecret.trim())
  if (provider === 'zhipu' || provider === 'patsnap-mcp') return Boolean(profile.apiKey.trim())
  return true
}

export const retrievalProviderLabels: Record<RetrievalProvider, string> = {
  zhipu: '智谱 Web Search',
  'patsnap-mcp': '智慧芽 Patsnap MCP',
  'epo-ops': 'EPO OPS（内置）',
  'custom-mcp': '自定义 Streamable HTTP MCP',
}

export const retrievalProviderApiLinks: Record<RetrievalProvider, string> = {
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
  'patsnap-mcp': 'https://connect.zhihuiya.com/',
  'epo-ops': 'https://developers.epo.org/',
  'custom-mcp': '',
}

export const defaultRetrievalSettings: RetrievalSettings = {
  provider: 'zhipu',
  profiles: {
    zhipu: {
      interfaceName: '智谱 Web Search',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      apiKey: '',
      clientSecret: '',
      searchEngine: 'search_pro',
      count: 10,
      toolName: '',
      argumentTemplate: '',
      headersJson: '',
      allowedToolNames: ['web_search'],
      maxSteps: 8,
    },
    'patsnap-mcp': {
      interfaceName: '智慧芽 Patsnap MCP',
      endpoint: 'https://connect.zhihuiya.com/1458a4/mcp',
      apiKey: '',
      clientSecret: '',
      searchEngine: '',
      count: 10,
      toolName: '',
      argumentTemplate: '',
      headersJson: '',
      allowedToolNames: [],
      maxSteps: 8,
    },
    'epo-ops': {
      interfaceName: 'EPO OPS',
      endpoint: 'https://ops.epo.org/3.2/rest-services',
      apiKey: '',
      clientSecret: '',
      searchEngine: '',
      count: 25,
      toolName: 'ops_search',
      argumentTemplate: '',
      headersJson: '',
      allowedToolNames: [
        'ops_search', 'ops_get_biblio', 'ops_get_abstract', 'ops_get_fulltext',
        'ops_get_family', 'ops_get_equivalents', 'ops_cpc_search', 'ops_convert_number',
      ],
      maxSteps: 8,
    },
    'custom-mcp': {
      interfaceName: '',
      endpoint: '',
      apiKey: '',
      clientSecret: '',
      searchEngine: '',
      count: 10,
      toolName: '',
      argumentTemplate: '',
      headersJson: '',
      allowedToolNames: [],
      maxSteps: 8,
    },
  },
}

function cloneDefaults() {
  return JSON.parse(JSON.stringify(defaultLlmSettings)) as LlmSettingsStore
}

export function parseStoredLlmSettings(value: string | null): LlmSettingsStore {
  if (!value) return cloneDefaults()
  try {
    const parsed = JSON.parse(value) as Partial<LlmSettingsStore>
    const defaults = cloneDefaults()
    const provider = parsed.provider && parsed.provider in defaults.profiles ? parsed.provider : defaults.provider
    for (const key of Object.keys(defaults.profiles) as LlmProvider[]) {
      defaults.profiles[key] = { ...defaults.profiles[key], ...parsed.profiles?.[key] }
    }
    defaults.provider = provider
    return defaults
  } catch {
    return cloneDefaults()
  }
}

export function parseStoredRetrievalSettings(value: string | null): RetrievalSettings {
  const defaults = JSON.parse(JSON.stringify(defaultRetrievalSettings)) as RetrievalSettings
  if (!value) return defaults
  try {
    const parsed = JSON.parse(value) as Partial<RetrievalSettings> & Partial<RetrievalProfile>
    if (parsed.provider && parsed.provider in defaults.profiles) defaults.provider = parsed.provider
    for (const provider of Object.keys(defaults.profiles) as RetrievalProvider[]) {
      defaults.profiles[provider] = { ...defaults.profiles[provider], ...parsed.profiles?.[provider] }
    }
    // Migrate the first experimental flat retrieval configuration into custom MCP.
    if (!parsed.profiles && parsed.endpoint) {
      defaults.provider = 'custom-mcp'
      defaults.profiles['custom-mcp'] = {
        ...defaults.profiles['custom-mcp'],
        interfaceName: parsed.interfaceName ?? '',
        endpoint: parsed.endpoint ?? '',
        apiKey: parsed.apiKey ?? '',
        toolName: parsed.toolName ?? '',
      }
    }
    return defaults
  } catch {
    return defaults
  }
}

export function updateRetrievalProfile(
  store: RetrievalSettings,
  provider: RetrievalProvider,
  update: Partial<RetrievalProfile>,
): RetrievalSettings {
  return {
    ...store,
    profiles: {
      ...store.profiles,
      [provider]: { ...store.profiles[provider], ...update },
    },
  }
}

export function updateLlmProfile(
  store: LlmSettingsStore,
  provider: LlmProvider,
  update: Partial<LlmProviderProfile>,
): LlmSettingsStore {
  return {
    ...store,
    profiles: {
      ...store.profiles,
      [provider]: { ...store.profiles[provider], ...update },
    },
  }
}
