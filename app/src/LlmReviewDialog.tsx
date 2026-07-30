import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowUpDown, BookOpenText, Check, ChevronDown, ExternalLink, FilePlus2, LoaderCircle,
  Search, Settings2, ShieldCheck, Sparkles, X,
} from 'lucide-react'
import {
  buildReviewMessages, buildSearchPlanMessages, parseReviewFindings,
  type ComparisonDocument, type LlmReviewFinding,
  type ReviewScope,
} from './llm-review'
import {
  buildPriorArtCandidateMessages, parsePriorArtCandidates, resolvePriorArtSourceMode, type PriorArtCandidate,
} from './prior-art-selection'
import {
  runMcpResearchAgent, type ResearchTraceEntry, type ResearchTool,
} from './mcp-research-agent'
import { detectTechnicalField, extractClaimsText, technicalFieldsDiffer } from './technical-field'
import {
  llmProviderApiLinks, llmProviderLabels, modelListEndpointFor, parseStoredLlmSettings, parseStoredRetrievalSettings,
  retrievalProfileCanLoadTools, retrievalProviderApiLinks, retrievalProviderLabels, updateLlmProfile, updateRetrievalProfile,
  type LlmProvider, type LlmSettingsStore, type RetrievalProvider, type RetrievalSettings,
} from './llm-settings'
import { reviewRulebook, type ReviewModuleKey } from './review-rulebook'
import { sortReviewFindings, type ReviewFindingSort } from './review-finding-sort'
import { base64ToArrayBuffer, parseDocx } from './document-analysis'
import { parsePdf } from './pdf-analysis'

export type LlmRunMetadata = {
  technicalField: string
  provider: string
  model: string
  generatedAt: string
}

type LlmReviewDialogProps = {
  patentText: string
  findings: LlmReviewFinding[]
  onFindingsChange: (findings: LlmReviewFinding[], metadata: LlmRunMetadata) => void
  onClose: () => void
  onNotice: (notice: string) => void
}

const moduleCopy: Array<{ key: ReviewModuleKey; title: string; description: string }> = [
  { key: 'technical', title: '技术理解与技术缺陷', description: '核对技术原理、行业常识和可能的技术误解。' },
  { key: 'legal', title: '清楚性、支持性及形式缺陷', description: '以内置中国专利审核规则库为主要依据。' },
  { key: 'priorArt', title: '新颖性与创造性', description: '上传对比文件或启用联网检索，满足一项即可启动。' },
  { key: 'enforcement', title: '确权与维权稳定性', description: '评估保护范围、稳定性和维权风险。' },
]

function activeProfile(settings: LlmSettingsStore) {
  return settings.profiles[settings.provider]
}

function storedLlmSettings() {
  return parseStoredLlmSettings(window.localStorage.getItem('patent-reader.llm-settings'))
}

function storedRetrievalSettings() {
  return parseStoredRetrievalSettings(window.localStorage.getItem('patent-reader.retrieval-settings'))
}

function activeRetrievalProfile(settings: RetrievalSettings) {
  return settings.profiles[settings.provider]
}

function sourceText(finding: LlmReviewFinding) {
  return finding.sources.map((source) => `${source.title}${source.url ? `：${source.url}` : ''}`).join('\n')
}

export default function LlmReviewDialog({
  patentText,
  findings,
  onFindingsChange,
  onClose,
  onNotice,
}: LlmReviewDialogProps) {
  const detectedField = useMemo(() => detectTechnicalField(patentText), [patentText])
  const claimsText = useMemo(() => extractClaimsText(patentText), [patentText])
  const [settings, setSettings] = useState<LlmSettingsStore>(storedLlmSettings)
  const [retrieval, setRetrieval] = useState<RetrievalSettings>(storedRetrievalSettings)
  const [rememberSettings, setRememberSettings] = useState(true)
  const [manualField, setManualField] = useState(detectedField)
  const [fieldChoice, setFieldChoice] = useState<'manual' | 'detected'>('manual')
  const [modules, setModules] = useState<Record<ReviewModuleKey, boolean>>({
    technical: true,
    legal: true,
    priorArt: true,
    enforcement: true,
  })
  const [scope, setScope] = useState<ReviewScope>('full')
  const [comparisonDocuments, setComparisonDocuments] = useState<ComparisonDocument[]>([])
  const [technicalSearchEnabled, setTechnicalSearchEnabled] = useState(false)
  const [priorArtSearchEnabled, setPriorArtSearchEnabled] = useState(false)
  const [searchPlan, setSearchPlan] = useState('')
  const [searchPlanConfirmed, setSearchPlanConfirmed] = useState(false)
  const [availableModels, setAvailableModels] = useState<Partial<Record<LlmProvider, string[]>>>({})
  const [mcpTools, setMcpTools] = useState<Partial<Record<RetrievalProvider, PatentMcpTool[]>>>({})
  const [researchTrace, setResearchTrace] = useState<ResearchTraceEntry[]>([])
  const [researchSummary, setResearchSummary] = useState('')
  const [findingSort, setFindingSort] = useState<ReviewFindingSort>('document')
  const [priorArtCandidates, setPriorArtCandidates] = useState<PriorArtCandidate[]>([])
  const [selectedPriorArtId, setSelectedPriorArtId] = useState('')
  const [pendingSearchEvidence, setPendingSearchEvidence] = useState('')
  const [pendingReviewModules, setPendingReviewModules] = useState<ReviewModuleKey[]>([])
  const [isSearchCostConfirmOpen, setIsSearchCostConfirmOpen] = useState(false)
  const [status, setStatus] = useState<'idle' | 'planning' | 'loading-files' | 'loading-models' | 'connecting-retrieval' | 'reviewing'>('idle')
  const [error, setError] = useState('')
  const lastAutoToolLoadRef = useRef('')

  const profile = activeProfile(settings)
  const retrievalProfile = activeRetrievalProfile(retrieval)
  const fieldConflict = technicalFieldsDiffer(manualField, detectedField)
  const technicalField = fieldChoice === 'detected' ? detectedField : manualField
  const selectedModules = moduleCopy.filter((item) => modules[item.key]).map((item) => item.key)
  const searchEnabled = technicalSearchEnabled || priorArtSearchEnabled
  const retrievalTools = mcpTools[retrieval.provider] ?? []
  const allowedRetrievalTools = new Set(retrievalProfile.allowedToolNames)
  const sortedFindings = useMemo(
    () => sortReviewFindings(findings, findingSort, patentText),
    [findingSort, findings, patentText],
  )

  function persistSettings() {
    if (rememberSettings) {
      window.localStorage.setItem('patent-reader.llm-settings', JSON.stringify(settings))
      window.localStorage.setItem('patent-reader.retrieval-settings', JSON.stringify(retrieval))
    } else {
      window.localStorage.removeItem('patent-reader.llm-settings')
      window.localStorage.removeItem('patent-reader.retrieval-settings')
    }
  }

  async function openExternal(url: string) {
    if (!url) return
    try {
      if (window.patentReader?.openExternalUrl) await window.patentReader.openExternalUrl(url)
      else window.open(url, '_blank', 'noopener,noreferrer')
    } catch (reason) {
      setError(`无法打开默认浏览器：${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }

  async function complete(
    provider: string,
    endpoint: string,
    apiKey: string,
    model: string,
    system: string,
    user: string,
    purpose: string,
  ) {
    if (!window.patentReader?.llmCompletion) throw new Error('当前桌面后端尚未加载LLM接口，请重启工具。')
    const result = await window.patentReader.llmCompletion({
      provider,
      endpoint,
      apiKey,
      model,
      system,
      user,
      purpose,
    })
    return result.content
  }

  async function loadAvailableModels() {
    if (!profile.apiKey.trim() || !profile.endpoint.trim()) {
      setError('请先填写当前服务商的API Key和服务器地址。')
      return
    }
    if (!window.patentReader?.llmListModels) {
      setError('当前桌面后端尚未加载模型查询功能，请重启工具。')
      return
    }
    setStatus('loading-models')
    setError('')
    try {
      const result = await window.patentReader.llmListModels({
        provider: llmProviderLabels[settings.provider],
        endpoint: modelListEndpointFor(profile.endpoint),
        apiKey: profile.apiKey,
      })
      setAvailableModels((current) => ({ ...current, [settings.provider]: result.models }))
      if (!result.models.includes(profile.model)) {
        setSettings((current) => updateLlmProfile(current, current.provider, { model: result.models[0] }))
      }
      onNotice(`已连接 ${llmProviderLabels[settings.provider]}，读取到 ${result.models.length} 个可用模型。`)
    } catch (reason) {
      setError(`模型列表读取失败：${reason instanceof Error ? reason.message : String(reason)}；你仍可手工填写模型ID。`)
    } finally {
      setStatus('idle')
    }
  }

  const connectRetrievalMcp = useCallback(async (options: { automatic?: boolean } = {}) => {
    if (!retrievalProfile.endpoint.trim()) {
      setError('请先填写检索服务地址。')
      return
    }
    if (!window.patentReader?.retrievalListTools) {
      setError('当前桌面后端尚未加载检索工具发现功能，请重启工具。')
      return
    }
    setStatus('connecting-retrieval')
    setError('')
    try {
      const result = await window.patentReader.retrievalListTools({
        provider: retrieval.provider,
        endpoint: retrievalProfile.endpoint,
        apiKey: retrievalProfile.apiKey,
        clientSecret: retrievalProfile.clientSecret,
        headersJson: retrievalProfile.headersJson,
      })
      setMcpTools((current) => ({ ...current, [retrieval.provider]: result.tools }))
      const availableNames = new Set(result.tools.map((tool) => tool.name))
      const retained = retrievalProfile.allowedToolNames.filter((name) => availableNames.has(name))
      const allowedToolNames = retained.length ? retained : result.tools.map((tool) => tool.name)
      setRetrieval((current) => updateRetrievalProfile(current, current.provider, { allowedToolNames }))
      onNotice(`${options.automatic ? '已自动加载' : '检索连接成功，发现'} ${result.tools.length} 个可供LLM调用的只读工具。`)
    } catch (reason) {
      setError(`检索工具连接失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setStatus('idle')
    }
  }, [
    onNotice,
    retrieval.provider,
    retrievalProfile.allowedToolNames,
    retrievalProfile.apiKey,
    retrievalProfile.clientSecret,
    retrievalProfile.endpoint,
    retrievalProfile.headersJson,
  ])

  useEffect(() => {
    if (!searchEnabled || status !== 'idle' || !retrievalProfileCanLoadTools(retrieval.provider, retrievalProfile)) return
    const signature = JSON.stringify({
      provider: retrieval.provider,
      endpoint: retrievalProfile.endpoint.trim(),
      apiKey: retrievalProfile.apiKey.trim(),
      clientSecret: retrievalProfile.clientSecret.trim(),
      headersJson: retrievalProfile.headersJson.trim(),
    })
    if (lastAutoToolLoadRef.current === signature) return
    const timer = window.setTimeout(() => {
      lastAutoToolLoadRef.current = signature
      void connectRetrievalMcp({ automatic: true })
    }, 500)
    return () => window.clearTimeout(timer)
  }, [
    retrieval.provider,
    retrievalProfile.apiKey,
    retrievalProfile.clientSecret,
    retrievalProfile.endpoint,
    retrievalProfile.headersJson,
    retrievalProfile,
    searchEnabled,
    status,
    connectRetrievalMcp,
  ])

  async function addComparisonDocuments() {
    if (!window.patentReader?.openComparisonDocuments) {
      setError('当前桌面后端尚未加载对比文件选择功能，请重启工具。')
      return
    }
    setStatus('loading-files')
    setError('')
    try {
      const selected = await window.patentReader.openComparisonDocuments()
      const parsed = await Promise.all(selected.map(async (document): Promise<ComparisonDocument> => {
        const bytes = base64ToArrayBuffer(document.base64)
        if (document.extension === 'docx') {
          const content = await parseDocx(bytes)
          return { name: document.name, text: content.plainText }
        }
        const content = await parsePdf(bytes)
        return { name: document.name, text: content.plainText }
      }))
      setComparisonDocuments((current) => {
        const byName = new Map(current.map((document) => [document.name, document]))
        parsed.forEach((document) => byName.set(document.name, document))
        return [...byName.values()]
      })
      if (parsed.length) setScope('full-with-prior-art')
    } catch (reason) {
      setError(`无法读取对比文件：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setStatus('idle')
    }
  }

  async function generateSearchPlan() {
    if (!profile.apiKey.trim() || !profile.endpoint.trim() || !profile.model.trim()) {
      setError('请先完整填写LLM接口设置。')
      return
    }
    setStatus('planning')
    setError('')
    try {
      const messages = buildSearchPlanMessages(technicalField, claimsText)
      const content = await complete(
        llmProviderLabels[settings.provider],
        profile.endpoint,
        profile.apiKey,
        profile.model,
        messages.system,
        messages.user,
        '生成检索方案',
      )
      setSearchPlan(content)
      setSearchPlanConfirmed(false)
      persistSettings()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setStatus('idle')
    }
  }

  async function finishReview(
    reviewModules: ReviewModuleKey[],
    searchEvidence: string,
    networkPriorArtEnabled: boolean,
    selectedClosestPriorArt: PriorArtCandidate | null,
  ) {
    const messages = buildReviewMessages({
      modules: reviewModules,
      scope,
      technicalField,
      patentText,
      claimsText,
      comparisonDocuments,
      searchEvidence,
      allowPriorArtNetworkSearch: networkPriorArtEnabled,
      selectedClosestPriorArt,
    })
    const content = await complete(
      llmProviderLabels[settings.provider],
      profile.endpoint,
      profile.apiKey,
      profile.model,
      messages.system,
      messages.user,
      '专利辅助审查',
    )
    const nextFindings = parseReviewFindings(content, reviewModules)
    const metadata = {
      technicalField,
      provider: settings.provider === 'custom' ? profile.interfaceName || '自定义接口' : llmProviderLabels[settings.provider],
      model: profile.model,
      generatedAt: new Date().toISOString(),
    }
    onFindingsChange(nextFindings, metadata)
    onNotice(`LLM审查完成：生成 ${nextFindings.length} 条审查卡片，请逐条确认是否采纳。`)
  }

  async function rankPriorArtCandidates(searchEvidence: string) {
    const messages = buildPriorArtCandidateMessages(claimsText, comparisonDocuments, searchEvidence)
    const content = await complete(
      llmProviderLabels[settings.provider],
      profile.endpoint,
      profile.apiKey,
      profile.model,
      messages.system,
      messages.user,
      '最接近现有技术候选排序',
    )
    const candidates = parsePriorArtCandidates(content)
    if (!candidates.length) throw new Error('未能从上传文件或联网检索结果中整理出可选对比文件，请调整检索方案后重试。')
    return candidates
  }

  function beginReview() {
    if (searchEnabled) {
      setIsSearchCostConfirmOpen(true)
      return
    }
    void runReview()
  }

  async function runReview(options: { disableNetwork?: boolean } = {}) {
    setError('')
    const effectiveSearchEnabled = options.disableNetwork ? false : searchEnabled
    const effectivePriorArtSearchEnabled = options.disableNetwork ? false : priorArtSearchEnabled
    const effectiveModules = options.disableNetwork && comparisonDocuments.length === 0
      ? selectedModules.filter((module) => module !== 'priorArt')
      : selectedModules
    const priorArtSourceMode = resolvePriorArtSourceMode(comparisonDocuments.length, effectivePriorArtSearchEnabled)
    if (!effectiveModules.length) {
      setError('请至少选择一个审查模块。')
      return
    }
    if (!technicalField.trim()) {
      setError('请确认本次审查的技术领域。')
      return
    }
    if (!profile.apiKey.trim() || !profile.endpoint.trim() || !profile.model.trim()) {
      setError('请完整填写LLM的API Key、服务器地址和模型名称。')
      return
    }
    if (effectiveModules.includes('priorArt') && priorArtSourceMode === 'unavailable') {
      setError('新颖性与创造性模块需要上传对比文件，或明确开启联网检索。')
      return
    }
    if (effectiveModules.includes('priorArt') && comparisonDocuments.length > 0 && scope !== 'full-with-prior-art') {
      setError('启用新颖性与创造性时，外传范围必须明确选择“全文＋对比文件”。')
      return
    }
    if (effectiveSearchEnabled) {
      if (!retrievalProfile.endpoint.trim()) {
        setError('请填写当前联网检索服务的服务器地址。')
        return
      }
      if (retrieval.provider === 'zhipu' && !retrievalProfile.apiKey.trim()) {
        setError('请填写智谱Web Search的API Key。')
        return
      }
      if (retrieval.provider === 'patsnap-mcp' && !retrievalProfile.apiKey.trim()) {
        setError('请填写智慧芽MCP的访问Key。')
        return
      }
      if (retrieval.provider === 'epo-ops' && (!retrievalProfile.apiKey.trim() || !retrievalProfile.clientSecret.trim())) {
        setError('请填写EPO OPS Consumer Key和Consumer Secret。')
        return
      }
      if (!searchPlan.trim() || !searchPlanConfirmed) {
        setError('请先生成或填写检索方案，并勾选“已确认”。')
        return
      }
    }
    setStatus('reviewing')
    try {
      persistSettings()
      let searchEvidence = ''
      if (effectiveSearchEnabled) {
        if (!window.patentReader?.retrievalListTools || !window.patentReader?.retrievalCallTool || !window.patentReader?.llmAgentTurn) {
          throw new Error('当前桌面后端尚未加载LLM检索代理，请重启工具。')
        }
        let tools = retrievalTools
        if (!tools.length) {
          const listed = await window.patentReader.retrievalListTools({
            provider: retrieval.provider,
            endpoint: retrievalProfile.endpoint,
            apiKey: retrievalProfile.apiKey,
            clientSecret: retrievalProfile.clientSecret,
            headersJson: retrievalProfile.headersJson,
          })
          tools = listed.tools
          setMcpTools((current) => ({ ...current, [retrieval.provider]: tools }))
        }
        const availableNames = new Set(tools.map((tool) => tool.name))
        const configuredNames = retrievalProfile.allowedToolNames.filter((name) => availableNames.has(name))
        const allowedToolNames = configuredNames.length ? configuredNames : tools.map((tool) => tool.name)
        setRetrieval((current) => updateRetrievalProfile(current, current.provider, { allowedToolNames }))
        setResearchTrace([])
        setResearchSummary('')
        const result = await runMcpResearchAgent({
          technicalField,
          confirmedSearchPlan: searchPlan,
          claimsText,
          tools: tools as ResearchTool[],
          allowedToolNames,
          maxSteps: retrievalProfile.maxSteps,
        }, {
          turn: async (messages, agentTools) => window.patentReader!.llmAgentTurn!({
            provider: llmProviderLabels[settings.provider],
            endpoint: profile.endpoint,
            apiKey: profile.apiKey,
            model: profile.model,
            purpose: '专利MCP迭代检索',
            messages: messages as PatentLlmAgentMessage[],
            tools: agentTools,
          }),
          callTool: async (toolName, argumentsValue) => {
            const response = await window.patentReader!.retrievalCallTool!({
              provider: retrieval.provider,
              endpoint: retrievalProfile.endpoint,
              apiKey: retrievalProfile.apiKey,
              clientSecret: retrievalProfile.clientSecret,
              headersJson: retrievalProfile.headersJson,
              searchEngine: retrievalProfile.searchEngine,
              count: retrievalProfile.count,
              toolName,
              arguments: argumentsValue,
            })
            return response.content
          },
          onProgress: (entry) => setResearchTrace((current) => [...current, entry]),
        })
        setResearchSummary(result.evidence)
        onNotice(`MCP迭代检索完成：LLM调用工具 ${result.toolCallCount} 次，已形成候选对比文件证据。`)
        searchEvidence = `检索服务：${retrievalProviderLabels[retrieval.provider]}
检索方式：LLM自主选择并连续调用专利检索/详情工具
检索边界：${effectivePriorArtSearchEnabled ? '联网结果与用户上传文件共同形成候选池，由用户选定最接近现有技术；联网结果仍须人工复核公开日、全文和法律地位' : '仅核验技术事实，不把联网结果作为正式对比文件'}
工具调用次数：${result.toolCallCount}
${result.evidence}`
      }

      if (effectiveModules.includes('priorArt')) {
        const candidates = await rankPriorArtCandidates(effectivePriorArtSearchEnabled ? searchEvidence : '')
        if (effectivePriorArtSearchEnabled) {
          setPriorArtCandidates(candidates)
          setSelectedPriorArtId(candidates[0].id)
          setPendingSearchEvidence(searchEvidence)
          setPendingReviewModules(effectiveModules)
          onNotice(`检索完成：整理出 ${candidates.length} 项候选对比文件，请选择最接近现有技术后继续。`)
          return
        }
        await finishReview(effectiveModules, searchEvidence, false, candidates[0])
      } else {
        await finishReview(effectiveModules, searchEvidence, false, null)
      }
    } catch (reason) {
      setError(`审查未完成：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setStatus('idle')
    }
  }

  async function continueAfterPriorArtSelection() {
    const selected = priorArtCandidates.find((candidate) => candidate.id === selectedPriorArtId)
    if (!selected) {
      setError('请选择一份文件作为最接近现有技术。')
      return
    }
    setStatus('reviewing')
    setError('')
    try {
      await finishReview(pendingReviewModules, pendingSearchEvidence, true, selected)
      setPriorArtCandidates([])
      setSelectedPriorArtId('')
      setPendingSearchEvidence('')
      setPendingReviewModules([])
    } catch (reason) {
      setError(`审查未完成：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setStatus('idle')
    }
  }

  function toggleFinding(id: string) {
    const next = findings.map((finding) => finding.id === id ? { ...finding, accepted: !finding.accepted } : finding)
    onFindingsChange(next, {
      technicalField,
      provider: settings.provider === 'custom' ? profile.interfaceName || '自定义接口' : llmProviderLabels[settings.provider],
      model: profile.model,
      generatedAt: new Date().toISOString(),
    })
  }

  return <div className="llm-review-backdrop" onMouseDown={onClose}>
    <section className="llm-review-dialog" role="dialog" aria-modal="true" aria-labelledby="llm-review-title" onMouseDown={(event) => event.stopPropagation()}>
      <header className="llm-review-header">
        <div><span><Sparkles size={19} /></span><div><strong id="llm-review-title">LLM 专利辅助审查</strong><small>规则库 {reviewRulebook.metadata.version} · 核验于 {reviewRulebook.metadata.lastVerifiedAt}</small></div></div>
        <button type="button" onClick={onClose} aria-label="关闭LLM审查"><X size={19} /></button>
      </header>
      <div className="llm-review-body">
        <div className="llm-review-setup">
          <section className="llm-setup-section">
            <h3><Settings2 size={15} /> 模型接口</h3>
            <div className="llm-form-grid">
              <label>服务商<select value={settings.provider} onChange={(event) => setSettings((current) => ({ ...current, provider: event.target.value as LlmProvider }))}>{(Object.keys(llmProviderLabels) as LlmProvider[]).map((provider) => <option key={provider} value={provider}>{llmProviderLabels[provider]}</option>)}</select></label>
              {settings.provider === 'custom' && <label>接口名称<input value={profile.interfaceName} onChange={(event) => setSettings((current) => updateLlmProfile(current, current.provider, { interfaceName: event.target.value }))} placeholder="例如：公司私有模型" /></label>}
              <label className="span-2">服务器地址<input value={profile.endpoint} onChange={(event) => setSettings((current) => updateLlmProfile(current, current.provider, { endpoint: event.target.value }))} placeholder="https://.../v1/chat/completions" /></label>
              <label>
                <span>模型名称 <button type="button" className="llm-link-button" onClick={() => { void loadAvailableModels() }} disabled={status !== 'idle'}>{status === 'loading-models' ? <LoaderCircle className="spin" size={11} /> : <Search size={11} />}连接获取</button></span>
                {(availableModels[settings.provider]?.length ?? 0) > 0
                  ? <select value={profile.model} onChange={(event) => setSettings((current) => updateLlmProfile(current, current.provider, { model: event.target.value }))}>{availableModels[settings.provider]?.map((model) => <option key={model} value={model}>{model}</option>)}</select>
                  : <input value={profile.model} onChange={(event) => setSettings((current) => updateLlmProfile(current, current.provider, { model: event.target.value }))} placeholder="可手工填写，或连接后选择" />}
              </label>
              <label><span>API Key {llmProviderApiLinks[settings.provider] && <button type="button" className="llm-link-button" onClick={() => { void openExternal(llmProviderApiLinks[settings.provider]) }}>获取 <ExternalLink size={11} /></button>}</span><input type="password" value={profile.apiKey} onChange={(event) => setSettings((current) => updateLlmProfile(current, current.provider, { apiKey: event.target.value }))} /></label>
              <label className="llm-check span-2"><input type="checkbox" checked={rememberSettings} onChange={(event) => setRememberSettings(event.target.checked)} /> 将接口设置和密钥保存在本机</label>
            </div>
          </section>

          <section className="llm-setup-section">
            <h3><BookOpenText size={15} /> 技术领域与审查范围</h3>
            <label className="llm-field-label">自定义技术领域<input value={manualField} onChange={(event) => setManualField(event.target.value)} placeholder="例如：太阳能电池、光伏组件封装" /></label>
            <div className="detected-field"><span>说明书识别</span><p>{detectedField || '未从技术领域段落识别到内容，请人工填写。'}</p></div>
            {fieldConflict && <div className="field-conflict"><AlertTriangle size={15} /><div><strong>两项技术领域差异较大，请选择</strong><label><input type="radio" checked={fieldChoice === 'manual'} onChange={() => setFieldChoice('manual')} /> 使用自定义技术领域</label><label><input type="radio" checked={fieldChoice === 'detected'} onChange={() => setFieldChoice('detected')} /> 使用说明书识别结果</label></div></div>}
            <div className="llm-module-grid">{moduleCopy.map((item) => <label key={item.key} className={modules[item.key] ? 'selected' : ''}><input type="checkbox" checked={modules[item.key]} onChange={(event) => setModules((current) => ({ ...current, [item.key]: event.target.checked }))} /><span><strong>{item.title}</strong><small>{item.description}</small></span></label>)}</div>
            <label className="llm-field-label">本次发送范围<select value={scope} onChange={(event) => setScope(event.target.value as ReviewScope)}><option value="claims">仅权利要求书</option><option value="full">专利全文</option><option value="full-with-prior-art">专利全文＋对比文件</option></select></label>
            <div className="comparison-files"><div><strong>对比文件</strong><button type="button" onClick={() => { void addComparisonDocuments() }} disabled={status !== 'idle'}><FilePlus2 size={14} /> 添加 DOCX/PDF</button></div>{comparisonDocuments.length ? <ul>{comparisonDocuments.map((document) => <li key={document.name}>{document.name}</li>)}</ul> : <p>尚未添加。也可开启MCP补检候选对比文件，但联网候选必须人工复核。</p>}</div>
          </section>

          <section className="llm-setup-section">
            <h3><Search size={15} /> 联网检索（可选）</h3>
            <label className="llm-check"><input type="checkbox" checked={technicalSearchEnabled} onChange={(event) => setTechnicalSearchEnabled(event.target.checked)} /> 检索技术事实</label>
            <label className="llm-check"><input type="checkbox" checked={priorArtSearchEnabled} onChange={(event) => setPriorArtSearchEnabled(event.target.checked)} /> 补检潜在对比文件（与用户上传文件分开标记）</label>
            {searchEnabled && <div className="retrieval-settings">
              <label className="span-2">检索服务
                <select value={retrieval.provider} onChange={(event) => setRetrieval((current) => ({ ...current, provider: event.target.value as RetrievalProvider }))}>
                  {(Object.keys(retrievalProviderLabels) as RetrievalProvider[]).map((provider) => <option key={provider} value={provider}>{retrievalProviderLabels[provider]}</option>)}
                </select>
              </label>
              {retrieval.provider === 'custom-mcp' && <label>接口名称<input value={retrievalProfile.interfaceName} onChange={(event) => setRetrieval((current) => updateRetrievalProfile(current, current.provider, { interfaceName: event.target.value }))} placeholder="例如：企业专利检索 MCP" /></label>}
              <label className={retrieval.provider === 'custom-mcp' ? '' : 'span-2'}>服务器地址
                <input value={retrievalProfile.endpoint} onChange={(event) => setRetrieval((current) => updateRetrievalProfile(current, current.provider, { endpoint: event.target.value }))} placeholder="https://..." />
              </label>
              <label>
                <span>{retrieval.provider === 'epo-ops' ? 'Consumer Key' : 'API Key'} {retrievalProviderApiLinks[retrieval.provider] && <button type="button" className="llm-link-button" onClick={() => { void openExternal(retrievalProviderApiLinks[retrieval.provider]) }}>获取 <ExternalLink size={11} /></button>}</span>
                <input type="password" value={retrievalProfile.apiKey} onChange={(event) => setRetrieval((current) => updateRetrievalProfile(current, current.provider, { apiKey: event.target.value }))} />
              </label>
              {retrieval.provider === 'epo-ops' && <label>Consumer Secret<input type="password" value={retrievalProfile.clientSecret} onChange={(event) => setRetrieval((current) => updateRetrievalProfile(current, current.provider, { clientSecret: event.target.value }))} /></label>}
              {retrieval.provider === 'zhipu' && <>
                <label>搜索引擎
                  <select value={retrievalProfile.searchEngine} onChange={(event) => setRetrieval((current) => updateRetrievalProfile(current, current.provider, { searchEngine: event.target.value }))}>
                    <option value="search_pro">search_pro（推荐）</option>
                    <option value="search_std">search_std</option>
                    <option value="search_pro_sogou">search_pro_sogou</option>
                    <option value="search_pro_quark">search_pro_quark</option>
                  </select>
                </label>
                <label>每条检索式返回数量<input type="number" min="1" max="50" value={retrievalProfile.count} onChange={(event) => setRetrieval((current) => updateRetrievalProfile(current, current.provider, { count: Math.max(1, Math.min(50, Number(event.target.value) || 10)) }))} /></label>
              </>}
              {retrieval.provider === 'epo-ops' && <>
                <label>每条 CQL 返回数量<input type="number" min="1" max="100" value={retrievalProfile.count} onChange={(event) => setRetrieval((current) => updateRetrievalProfile(current, current.provider, { count: Math.max(1, Math.min(100, Number(event.target.value) || 25)) }))} /></label>
                <p className="retrieval-note span-2">内置与 epo-ops-mcp 同名同参数的核心检索工具，可由LLM连续调用搜索、摘要、全文和同族工具；无需另装Python。</p>
              </>}
              {retrieval.provider === 'custom-mcp' && <label className="span-2">自定义请求头（可选）
                <textarea value={retrievalProfile.headersJson} onChange={(event) => setRetrieval((current) => updateRetrievalProfile(current, current.provider, { headersJson: event.target.value }))} placeholder={'JSON 对象，例如：{"X-API-Key":"..."}；Bearer Key 请直接填写上方 API Key'} />
              </label>}
              <details className="retrieval-tools-collapsible span-2">
                <summary><span><ChevronDown size={14} /> 可调用工具设置</span><small>{status === 'connecting-retrieval' ? '正在自动加载…' : retrievalTools.length ? `已加载 ${retrievalTools.length} 个工具` : '凭证完整后自动加载'}</small></summary>
                <div className="retrieval-connect">
                  <button type="button" onClick={() => { void connectRetrievalMcp() }} disabled={status !== 'idle'}>
                    {status === 'connecting-retrieval' ? <LoaderCircle className="spin" size={13} /> : <Search size={13} />} 加载可调用工具
                  </button>
                  <small>{retrieval.provider === 'patsnap-mcp' || retrieval.provider === 'custom-mcp' ? '读取MCP tools/list，仅保留只读工具。' : '加载内置专利检索工具。'}</small>
                </div>
                {retrievalTools.length > 0 && <div className="retrieval-agent-tools">
                  <div><strong>允许LLM自主调用</strong><small>可多选；LLM会先搜索，再按需读取候选文献详情。</small></div>
                  {retrievalTools.map((tool) => <label key={tool.name}>
                    <input
                      type="checkbox"
                      checked={allowedRetrievalTools.has(tool.name)}
                      onChange={(event) => setRetrieval((current) => {
                        const currentNames = new Set(current.profiles[current.provider].allowedToolNames)
                        if (event.target.checked) currentNames.add(tool.name)
                        else currentNames.delete(tool.name)
                        return updateRetrievalProfile(current, current.provider, { allowedToolNames: [...currentNames] })
                      })}
                    />
                    <span><strong>{tool.name}</strong><small>{tool.description || '未提供工具说明'}</small></span>
                    <details><summary>参数</summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>
                  </label>)}
                </div>}
              </details>
              <label>最多工具调用轮次<input type="number" min="2" max="12" value={retrievalProfile.maxSteps} onChange={(event) => setRetrieval((current) => updateRetrievalProfile(current, current.provider, { maxSteps: Math.max(2, Math.min(12, Number(event.target.value) || 8)) }))} /></label>
              <p className="retrieval-note">同一参数最多重复调用两次，达到轮次上限后自动整理已有证据。</p>
              <div className="search-plan-heading"><strong>检索方案</strong><button type="button" onClick={() => { void generateSearchPlan() }} disabled={status !== 'idle'}>{status === 'planning' ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />} 由LLM生成</button></div>
              <textarea value={searchPlan} onChange={(event) => { setSearchPlan(event.target.value); setSearchPlanConfirmed(false) }} placeholder="可手工填写或由LLM生成，再修改确认。" />
              <label className="llm-check"><input type="checkbox" checked={searchPlanConfirmed} onChange={(event) => setSearchPlanConfirmed(event.target.checked)} /> 已检查并确认本次检索方案</label>
              {researchTrace.length > 0 && <details className="retrieval-research-trace span-2" open>
                <summary>LLM已调用 {researchTrace.length} 次检索工具</summary>
                <ol>{researchTrace.map((entry, index) => <li key={`${entry.step}-${entry.toolName}-${index}`}><strong>{entry.toolName}</strong><code>{JSON.stringify(entry.arguments)}</code><small>{entry.resultPreview}</small></li>)}</ol>
              </details>}
              {researchSummary && <details className="retrieval-research-summary span-2"><summary>查看候选对比文件检索总结</summary><pre>{researchSummary}</pre></details>}
            </div>}
          </section>

          <div className="llm-privacy"><ShieldCheck size={16} /><span>正文和权利要求仅发送到你选择的LLM；MCP服务器只接收LLM生成的工具参数，不接收整篇专利正文。</span></div>
          {error && <div className="llm-error"><AlertTriangle size={15} />{error}</div>}
          <button type="button" className="llm-run-button" onClick={beginReview} disabled={status !== 'idle'}>{status === 'reviewing' ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{status === 'reviewing' ? '正在审查，请稍候…' : '开始辅助审查'}</button>
        </div>

        <div className="llm-review-results">
          <div className="llm-results-heading">
            <div><span className="eyebrow">人工确认后写回</span><h3>审查卡片</h3></div>
            <div className="llm-results-controls">
              <label><ArrowUpDown size={13} /><span>排序</span><select value={findingSort} onChange={(event) => setFindingSort(event.target.value as ReviewFindingSort)}><option value="document">按主文本位置</option><option value="severity">按重要程度</option><option value="category">按问题分类</option></select></label>
              <strong>{findings.length} 条</strong>
            </div>
          </div>
          <div className="llm-disclaimer">辅助审查，不构成法律意见。采纳的卡片写入修订版批注；全部卡片写入审查报告。</div>
          {findings.length === 0
            ? <div className="llm-empty"><Sparkles size={25} /><p>完成设置并开始审查后，结果会显示在这里。</p></div>
            : <div className="llm-finding-list">{sortedFindings.map((finding) => <article key={finding.id} className={`llm-finding ${finding.accepted ? 'accepted' : ''}`}>
              <header><label><input type="checkbox" checked={finding.accepted} onChange={() => toggleFinding(finding.id)} /><span>{finding.accepted ? '已采纳' : '待确认'}</span></label><div><span className={`llm-severity ${finding.severity}`}>{finding.severity}</span><span className="llm-evidence">{finding.evidenceLevel}</span></div></header>
              <h4>{finding.title}</h4>
              <small>{moduleCopy.find((item) => item.key === finding.module)?.title} · {finding.location}</small>
              {finding.quote && <blockquote>“{finding.quote}”</blockquote>}
              <p>{finding.analysis}</p>
              <div className="llm-recommendation"><strong>建议</strong>{finding.recommendation}</div>
              {finding.sources.length > 0 && <details><summary>查看 {finding.sources.length} 项来源</summary><pre>{sourceText(finding)}</pre></details>}
            </article>)}</div>}
          {findings.length > 0 && <div className="llm-results-footer"><Check size={15} /> 已采纳 {findings.filter((finding) => finding.accepted).length} 条；保存修订版时一并处理。</div>}
        </div>
      </div>
      {isSearchCostConfirmOpen && <div className="llm-step-backdrop" onMouseDown={(event) => event.stopPropagation()}>
        <section className="llm-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="search-cost-title">
          <div className="llm-confirm-icon"><AlertTriangle size={22} /></div>
          <h3 id="search-cost-title">联网检索可能产生额外费用</h3>
          <p>联网检索需视检索情况额外支付检索费用，是否继续进行？具体费用由所选检索服务商收取。</p>
          <div className="llm-confirm-actions">
            <button type="button" className="quiet-button" onClick={() => {
              setIsSearchCostConfirmOpen(false)
              setTechnicalSearchEnabled(false)
              setPriorArtSearchEnabled(false)
              if (!comparisonDocuments.length) setModules((current) => ({ ...current, priorArt: false }))
              void runReview({ disableNetwork: true })
            }}>取消联网检索并继续</button>
            <button type="button" className="primary-button" onClick={() => {
              setIsSearchCostConfirmOpen(false)
              void runReview()
            }}>继续进行</button>
          </div>
        </section>
      </div>}
      {priorArtCandidates.length > 0 && <div className="llm-step-backdrop" onMouseDown={(event) => event.stopPropagation()}>
        <section className="prior-art-selection-dialog" role="dialog" aria-modal="true" aria-labelledby="prior-art-selection-title">
          <header>
            <div><span className="eyebrow">联网检索已完成 · 人工确认</span><h3 id="prior-art-selection-title">选择最接近的现有技术</h3></div>
            <button type="button" onClick={() => {
              setPriorArtCandidates([])
              setSelectedPriorArtId('')
              setPendingSearchEvidence('')
              setPendingReviewModules([])
            }} aria-label="关闭候选对比文件选择"><X size={18} /></button>
          </header>
          <p className="prior-art-selection-note">已将用户上传文件和联网候选文献放入同一候选池，并按独立权利要求核心特征覆盖率排序。请选择一项，后续新颖性和创造性分析将以它作为最接近现有技术。</p>
          <div className="prior-art-candidate-list">
            {priorArtCandidates.map((candidate) => <label key={candidate.id} className={selectedPriorArtId === candidate.id ? 'selected' : ''}>
              <input type="radio" name="closest-prior-art" checked={selectedPriorArtId === candidate.id} onChange={() => setSelectedPriorArtId(candidate.id)} />
              <div className="prior-art-candidate-main">
                <div className="prior-art-candidate-heading"><strong>{candidate.name}</strong><span>{candidate.sourceType === 'uploaded' ? '用户上传' : '联网检索'}</span></div>
                <small>{[candidate.publicationNumber, candidate.publicationDate].filter(Boolean).join(' · ') || '文献号/公开日待人工核验'}</small>
                <div className="coverage-row"><span>核心特征覆盖率</span><div><i style={{ width: `${candidate.coveragePercent}%` }} /></div><strong>{candidate.coveragePercent}%</strong></div>
                <p>{candidate.reason}</p>
                <div className="candidate-feature-columns">
                  <div><strong>已覆盖</strong><span>{candidate.matchedFeatures.join('；') || '待核验'}</span></div>
                  <div><strong>未覆盖/待确认</strong><span>{candidate.missingFeatures.join('；') || '暂无'}</span></div>
                </div>
              </div>
            </label>)}
          </div>
          <footer>
            <span><AlertTriangle size={14} /> 联网文献仍需人工核对公开日、全文及法律状态。</span>
            <button type="button" className="primary-button" onClick={() => { void continueAfterPriorArtSelection() }} disabled={status !== 'idle'}>
              {status === 'reviewing' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} 确认并继续辅助审查
            </button>
          </footer>
        </section>
      </div>}
    </section>
  </div>
}
