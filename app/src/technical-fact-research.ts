import type { RetrievalProvider } from './llm-settings.ts'
import type { ResearchTool } from './mcp-research-agent.ts'

export type TechnicalFactVerdict =
  | '现有证据支持'
  | '仅在特定条件下成立'
  | '缺少必要参数'
  | '声称效果依据不足'
  | '可能与基本原理矛盾'
  | '存在工程实施风险'
  | '证据不足待核验'

export type TechnicalFactCategory =
  | '基本理论'
  | '工程做法'
  | '参数与工况'
  | '材料与相容性'
  | '失效与安全'
  | '标准与验证'

export type TechnicalFactSourceLevel =
  | '标准或权威来源'
  | '同行评审来源'
  | '工程资料'
  | '搜索摘要'
  | '待人工核验'

export type TechnicalFactSource = {
  title: string
  url: string
  sourceLevel: TechnicalFactSourceLevel
  excerpt: string
}

export type TechnicalFactItem = {
  id: string
  category: TechnicalFactCategory
  proposition: string
  patentQuote: string
  verdict: TechnicalFactVerdict
  analysis: string
  missingConditions: string[]
  risk: string
  sources: TechnicalFactSource[]
}

export type TechnicalFactEvidenceBundle = {
  summary: string
  items: TechnicalFactItem[]
  uncoveredQuestions: string[]
}

export const technicalFactResearchBudget = {
  maxToolCalls: 6,
  maxToolResultChars: 6_000,
  maxTotalToolResultChars: 24_000,
} as const

type TechnicalFactAgentPromptOptions = {
  technicalField: string
  confirmedSearchPlan: string
  patentText: string
}

const verdicts: TechnicalFactVerdict[] = [
  '现有证据支持',
  '仅在特定条件下成立',
  '缺少必要参数',
  '声称效果依据不足',
  '可能与基本原理矛盾',
  '存在工程实施风险',
  '证据不足待核验',
]

const categories: TechnicalFactCategory[] = [
  '基本理论',
  '工程做法',
  '参数与工况',
  '材料与相容性',
  '失效与安全',
  '标准与验证',
]

const sourceLevels: TechnicalFactSourceLevel[] = [
  '标准或权威来源',
  '同行评审来源',
  '工程资料',
  '搜索摘要',
  '待人工核验',
]

function cleanJson(content: string) {
  const trimmed = content.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim()
  const candidate = fenced || trimmed
  const start = candidate.indexOf('{')
  if (start < 0) return candidate
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < candidate.length; index += 1) {
    const character = candidate[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return candidate.slice(start, index + 1)
    }
  }
  return candidate.slice(start)
}

function stringArray(value: unknown, limit = 12) {
  return Array.isArray(value)
    ? value
      .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      .map((item) => item.trim())
      .slice(0, limit)
    : []
}

export function normalizeExternalSourceUrl(value: unknown) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  if (!text) return ''
  const markdownUrl = text.match(/\]\(\s*(https?:\/\/[^)\s]+)\s*\)/i)?.[1]
  const plainUrl = text.match(/https?:\/\/[^\s<>"'）】]+/i)?.[0]
  const candidate = (markdownUrl || plainUrl || '').replace(/[.,，。；;、]+$/u, '')
  if (!candidate) return ''
  try {
    const parsed = new URL(candidate)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : ''
  } catch {
    return ''
  }
}

export function buildTechnicalFactPlanMessages(technicalField: string, patentText: string) {
  return {
    system: `你是工程技术事实检索规划助手，不是专利现有技术检索助手。
你的目标是核验专利主文本中的技术说法是否符合基本理论和工程实践，以及这些说法成立所需的条件；不得寻找相似专利，不得评价新颖性或创造性。
输出中文纯文本，不使用Markdown表格。`,
    user: `技术领域：${technicalField || '未填写'}
专利主文本：
${patentText.slice(0, 30_000)}

请生成一份可编辑的“技术事实检索计划”：
1. 从全文提取5至10个可被外部资料核验的技术命题，优先选择作用机理、因果关系、关键参数、材料相容性、极限工况、制造装配、控制状态、故障安全和声称效果；
2. 每个命题必须列出对应的专利原文短句、需要查明的问题和风险优先级；
3. 每个命题分别给出“基本理论”“工程做法/标准”“参数与边界条件”三类中英文检索词；
4. 来源优先级为：国家/国际标准与权威机构资料、教材/工程手册、同行评审论文或综述、厂商技术手册与材料数据表、一般技术网页；
5. 不生成IPC/CPC分类号，不使用“专利”“权利要求”“prior art”等对比文件检索词；专利文献即使被搜索到，也只能作为工程做法示例。
只生成检索计划，不执行检索，不作技术结论。`,
  }
}

export function technicalFactResearchSystemPrompt() {
  return `你是工程技术事实检索代理，不是专利现有技术检索代理。你可以调用获准的通用网络搜索和页面读取工具。

目标是取得可核验的基本理论、行业通行做法、标准要求、参数范围、材料数据、极限工况和失效风险，用于判断专利主文本中的技术命题是否成立以及成立条件。严格禁止把任务改写成相似专利、文献号、IPC/CPC或最接近现有技术检索。

执行闭环：
1. 按确认的检索计划逐项核验高风险技术命题，不得只搜索产品名称或整句权利要求；
2. 每个命题至少尝试基本理论和工程实践两类检索方向；涉及参数、材料或安全时增加对应检索方向；
3. 来源优先级为标准/权威机构、教材/工程手册、同行评审资料、厂商手册/材料数据表、一般技术网页；
4. 能读取正文时必须提取直接相关的原文片段；只有搜索摘要时明确标为“搜索摘要”，不得假装已经阅读全文；
5. 同一关键结论尽量由两个相互独立来源交叉验证；若只有一个弱来源，必须降低结论强度；
6. 检索偶然出现的专利只能作为工程实施示例，不得作为候选对比文件，不得评价新颖性或创造性；
7. 不得虚构来源、URL、标准编号、数值、引文或实验结论。
8. source.url只填写可直接打开的完整HTTP(S)地址，不使用Markdown链接、不填写“未提供”“官网”等说明文字；没有地址时填写空字符串。

最终只输出合法JSON，不使用Markdown。结论必须采用以下之一：
“现有证据支持”“仅在特定条件下成立”“缺少必要参数”“声称效果依据不足”“可能与基本原理矛盾”“存在工程实施风险”“证据不足待核验”。`
}

export function technicalFactResearchUserPrompt(options: TechnicalFactAgentPromptOptions) {
  return JSON.stringify({
    task: '检索基本理论和工程做法，核验专利主文本中的技术命题；不得检索候选对比文件',
    technicalField: options.technicalField,
    confirmedSearchPlan: options.confirmedSearchPlan,
    patentText: options.patentText.slice(0, 40_000),
    outputSchema: {
      summary: '本次技术事实核验的总体说明',
      items: [{
        category: '基本理论|工程做法|参数与工况|材料与相容性|失效与安全|标准与验证',
        proposition: '被核验的技术命题',
        patentQuote: '专利原文中的连续短句，不超过160字',
        verdict: '现有证据支持|仅在特定条件下成立|缺少必要参数|声称效果依据不足|可能与基本原理矛盾|存在工程实施风险|证据不足待核验',
        analysis: '外部技术事实与专利说法之间的关系，以及结论的不确定性',
        missingConditions: ['专利文本尚未说明、但会影响命题成立的条件'],
        risk: '该问题可能导致的技术理解、实施或效果风险',
        sources: [{
          title: '来源标题',
          url: 'https://...',
          sourceLevel: '标准或权威来源|同行评审来源|工程资料|搜索摘要|待人工核验',
          excerpt: '实际取得的相关片段；只有摘要时明确说明',
        }],
      }],
      uncoveredQuestions: ['尚未取得充分证据、需要继续检索或实验的问题'],
    },
  })
}

export function technicalFactFinalReminder() {
  return '工具调用轮次已达到上限。请停止调用工具，按指定JSON结构整理技术事实证据；不得输出候选对比文件、文献覆盖率、新颖性或创造性结论。'
}

export function parseTechnicalFactEvidence(content: string): TechnicalFactEvidenceBundle {
  const parsed = JSON.parse(cleanJson(content)) as {
    summary?: unknown
    items?: Array<Record<string, unknown>>
    uncoveredQuestions?: unknown
  }
  const items = (parsed.items ?? []).flatMap((item, index) => {
    const proposition = typeof item.proposition === 'string' ? item.proposition.trim() : ''
    const analysis = typeof item.analysis === 'string' ? item.analysis.trim() : ''
    if (!proposition || !analysis) return []
    const category = categories.includes(item.category as TechnicalFactCategory)
      ? item.category as TechnicalFactCategory
      : '工程做法'
    const verdict = verdicts.includes(item.verdict as TechnicalFactVerdict)
      ? item.verdict as TechnicalFactVerdict
      : '证据不足待核验'
    const sources = Array.isArray(item.sources)
      ? item.sources.flatMap((source) => {
        if (!source || typeof source !== 'object') return []
        const value = source as Record<string, unknown>
        const title = typeof value.title === 'string' ? value.title.trim() : ''
        if (!title) return []
        const sourceLevel = sourceLevels.includes(value.sourceLevel as TechnicalFactSourceLevel)
          ? value.sourceLevel as TechnicalFactSourceLevel
          : '待人工核验'
        return [{
          title,
          url: normalizeExternalSourceUrl(value.url),
          sourceLevel,
          excerpt: typeof value.excerpt === 'string' ? value.excerpt.trim().slice(0, 800) : '',
        }]
      }).slice(0, 8)
      : []
    return [{
      id: `technical-fact-${index}-${proposition.replace(/\s+/g, '-').slice(0, 36)}`,
      category,
      proposition,
      patentQuote: typeof item.patentQuote === 'string' ? item.patentQuote.trim().slice(0, 160) : '',
      verdict,
      analysis,
      missingConditions: stringArray(item.missingConditions),
      risk: typeof item.risk === 'string' ? item.risk.trim() : '请人工结合专利全文复核该技术命题。',
      sources,
    }]
  }).slice(0, 12)
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    items,
    uncoveredQuestions: stringArray(parsed.uncoveredQuestions),
  }
}

export function formatTechnicalFactEvidence(bundle: TechnicalFactEvidenceBundle, selectedIds: Iterable<string>) {
  const selected = new Set(selectedIds)
  const items = bundle.items.filter((item) => selected.has(item.id))
  if (!items.length) return ''
  return [
    '【经用户确认的技术事实检索证据】',
    bundle.summary,
    ...items.map((item, index) => [
      `${index + 1}. ${item.category}｜${item.verdict}｜${item.proposition}`,
      item.patentQuote ? `专利原文：${item.patentQuote}` : '',
      `分析：${item.analysis}`,
      item.missingConditions.length ? `缺少或限制条件：${item.missingConditions.join('；')}` : '',
      `风险：${item.risk}`,
      ...item.sources.map((source) => `来源[${source.sourceLevel}]：${source.title}${source.url ? ` ${source.url}` : ''}${source.excerpt ? `\n相关片段：${source.excerpt}` : ''}`),
    ].filter(Boolean).join('\n')),
    bundle.uncoveredQuestions.length ? `尚未覆盖：${bundle.uncoveredQuestions.join('；')}` : '',
  ].filter(Boolean).join('\n\n')
}

export function retrievalProviderSupportsTechnicalFacts(provider: RetrievalProvider) {
  return provider === 'zhipu' || provider === 'custom-mcp'
}

export function selectTechnicalFactToolNames(tools: ResearchTool[], manuallyAllowedNames: string[]) {
  const manuallyAllowed = new Set(manuallyAllowedNames)
  const patentOnlyName = /patent|claim|family|biblio|legal|cpc|ipc|专利|权利要求|同族|书目|法律状态/i
  const patentOnlyDescription = /(?:仅|专门|只用于).{0,8}(?:专利|权利要求|同族|书目|法律状态)|专利(?:检索|权利要求|同族|书目|法律状态)/i
  const generalResearch = /web|search|query|fetch|read|page|browse|http|document|搜索|检索|网页|读取|抓取|正文|内容/i
  return tools
    .filter((tool) => manuallyAllowed.has(tool.name))
    .filter((tool) => {
      const description = `${tool.name} ${tool.description}`
      return generalResearch.test(description)
        && !patentOnlyName.test(tool.name)
        && !patentOnlyDescription.test(tool.description)
    })
    .map((tool) => tool.name)
}
