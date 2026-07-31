import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { detectTechnicalField, extractClaimsText, technicalFieldsDiffer } from '../src/technical-field.ts'
import { runMcpResearchAgent } from '../src/mcp-research-agent.ts'
import {
  buildTechnicalFactPlanMessages, formatTechnicalFactEvidence, parseTechnicalFactEvidence,
  retrievalProviderSupportsTechnicalFacts, selectTechnicalFactToolNames, technicalFactResearchBudget,
} from '../src/technical-fact-research.ts'
import {
  buildReviewDiagnostic,
  completedModulesForPackets,
  createReviewWorkPackets,
  formatReviewProgress,
  mergeReviewFindings,
  partitionReviewModules,
  remainingReviewModules,
  remainingReviewPackets,
} from '../src/review-execution.ts'
import { parsePriorArtCandidates, resolvePriorArtSourceMode } from '../src/prior-art-selection.ts'
import { sortReviewFindings } from '../src/review-finding-sort.ts'
import { extractJsonObject } from '../src/json-extraction.ts'
import {
  createLlmReviewSessionKey, loadLlmReviewSession, saveLlmReviewSession,
} from '../src/llm-review-session.ts'
import {
  modelListEndpointFor, parseStoredLlmSettings, parseStoredRetrievalSettings,
  retrievalProfileCanLoadTools, updateLlmProfile, updateRetrievalProfile,
} from '../src/llm-settings.ts'

const rulebook = JSON.parse(await readFile(new URL('../src/data/patent-review-rulebook.json', import.meta.url), 'utf8'))
assert.equal(rulebook.rules.length, 77, '内置规则库应包含77条规则')
assert.equal(rulebook.sources.length, 8, '内置规则库应只保留8个官方来源')
assert.ok(!rulebook.sources.some((source) => source.id === 'source-004'), '非官方法律注释不得进入内置规则库')
const sequenceRule = rulebook.rules.find((rule) => rule.id === 'formal-004')
assert.match(sequenceRule.ruleSummary, /2022年7月1日/)
assert.match(sequenceRule.ruleSummary, /ST\.26/)
assert.ok(sequenceRule.sources.includes('source-009'), '序列表规则应关联CNIPA第485号公告')

const patentText = `技术领域
本发明涉及太阳能电池及光伏组件封装技术领域。
背景技术
现有组件存在水汽侵入问题。
权 利 要 求 书
1. 一种太阳能电池组件，包括电池片和封装胶膜。
说 明 书
技术领域`
assert.equal(detectTechnicalField(patentText), '本发明涉及太阳能电池及光伏组件封装技术领域。')
assert.ok(technicalFieldsDiffer('机械传动机构', detectTechnicalField(patentText)), '差异较大的技术领域应触发人工确认')
assert.ok(!technicalFieldsDiffer('光伏组件封装', detectTechnicalField(patentText)), '相近技术领域不应触发误报')
assert.match(extractClaimsText(patentText), /太阳能电池组件/)

const settings = parseStoredLlmSettings(null)
assert.equal(settings.profiles.deepseek.endpoint, 'https://api.deepseek.com/chat/completions')
assert.equal(settings.profiles.deepseek.model, 'deepseek-v4-pro')
assert.equal(settings.profiles.kimi.endpoint, 'https://api.moonshot.cn/v1/chat/completions')
assert.equal(settings.profiles.kimi.model, 'kimi-k2.6')
assert.equal(modelListEndpointFor(settings.profiles.deepseek.endpoint), 'https://api.deepseek.com/models')
assert.equal(modelListEndpointFor(settings.profiles.kimi.endpoint), 'https://api.moonshot.cn/v1/models')
const withOpenAiKey = updateLlmProfile(settings, 'openai', { apiKey: 'openai-only' })
assert.equal(withOpenAiKey.profiles.openai.apiKey, 'openai-only')
assert.equal(withOpenAiKey.profiles.deepseek.apiKey, '', '不同LLM服务商不得共享API Key')
assert.equal(withOpenAiKey.profiles.kimi.apiKey, '', 'Kimi必须使用独立API Key')

const retrieval = parseStoredRetrievalSettings(null)
assert.equal(retrieval.profiles.zhipu.endpoint, 'https://open.bigmodel.cn/api/paas/v4/web_search')
assert.equal(retrieval.profiles['patsnap-mcp'].endpoint, 'https://connect.zhihuiya.com/1458a4/mcp')
assert.equal(retrieval.profiles['epo-ops'].endpoint, 'https://ops.epo.org/3.2/rest-services')
const withZhipuKey = updateRetrievalProfile(retrieval, 'zhipu', { apiKey: 'zhipu-only' })
const withPatsnapKey = updateRetrievalProfile(withZhipuKey, 'patsnap-mcp', { apiKey: 'patsnap-only' })
assert.equal(withPatsnapKey.profiles.zhipu.apiKey, 'zhipu-only')
assert.equal(withPatsnapKey.profiles['patsnap-mcp'].apiKey, 'patsnap-only')
assert.equal(withPatsnapKey.profiles['epo-ops'].apiKey, '', '不同检索服务不得共享访问凭证')
assert.equal(withPatsnapKey.profiles['epo-ops'].clientSecret, '', 'EPO Secret必须独立保存')
assert.equal(retrievalProfileCanLoadTools('patsnap-mcp', withPatsnapKey.profiles['patsnap-mcp']), true)
assert.equal(retrievalProfileCanLoadTools('epo-ops', withPatsnapKey.profiles['epo-ops']), false, 'EPO缺少Key或Secret时不得提前自动连接')
assert.equal(retrievalProfileCanLoadTools('custom-mcp', { ...withPatsnapKey.profiles['custom-mcp'], endpoint: 'https://example.com/mcp' }), true, '自定义MCP允许无密钥公开服务')

const sessionValues = new Map()
const sessionStorageMock = {
  getItem: (key) => sessionValues.get(key) ?? null,
  setItem: (key, value) => sessionValues.set(key, value),
  removeItem: (key) => sessionValues.delete(key),
}
const reviewSessionKey = createLlmReviewSessionKey(patentText)
saveLlmReviewSession(sessionStorageMock, reviewSessionKey, {
  manualField: '光伏组件封装',
  technicalSearchEnabled: true,
  technicalSearchPlan: '核验水汽透过率与封装失效边界',
  technicalResearchTrace: [{ step: 1, toolName: 'web_search', arguments: { query: 'WVTR encapsulant failure' }, resultPreview: '检索进行中' }],
  technicalResearchSummary: '已取得一项工程手册证据',
  status: 'reviewing',
})
const restoredReviewSession = loadLlmReviewSession(sessionStorageMock, reviewSessionKey)
assert.equal(restoredReviewSession?.technicalSearchPlan, '核验水汽透过率与封装失效边界', 'LLM审查模块重新挂载后必须恢复用户已经确认的检索内容')
assert.equal(restoredReviewSession?.technicalResearchTrace.length, 1, '最小化恢复后不得清空正在运行任务已经取得的轨迹')
assert.equal(restoredReviewSession?.status, 'idle', '页面重载后不能伪装已经丢失的网络请求仍在运行')
assert.equal(restoredReviewSession?.wasInterrupted, true, '恢复运行中草稿时应明确标记任务曾被中断')
assert.notEqual(createLlmReviewSessionKey(`${patentText}\n另一份专利`), reviewSessionKey, '不同专利不得复用同一份LLM审查草稿')

const reviewPromptSource = await readFile(new URL('../src/llm-review.ts', import.meta.url), 'utf8')
const priorArtSelectionSource = await readFile(new URL('../src/prior-art-selection.ts', import.meta.url), 'utf8')
const reviewDialogSource = await readFile(new URL('../src/LlmReviewDialog.tsx', import.meta.url), 'utf8')
const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
assert.match(reviewDialogSource, /loadLlmReviewSession\(window\.sessionStorage/, 'LLM审查弹窗重新挂载时必须恢复当前专利的会话草稿')
assert.match(reviewDialogSource, /saveLlmReviewSession\(window\.sessionStorage/, 'LLM审查运行过程中必须持续保存当前专利的会话草稿')
assert.doesNotMatch(appSource, /\{isLlmReviewOpen\s*&&\s*<LlmReviewDialog/, '关闭LLM弹窗只能隐藏界面，不能卸载正在运行的审查任务')
assert.match(appSource, /<LlmReviewDialog\s+open=\{isLlmReviewOpen\}/, 'LLM弹窗必须始终挂载并通过open属性控制显示')
assert.match(reviewDialogSource, /if\s*\(!open\)\s*return null/, '隐藏LLM弹窗时必须保留组件状态和后台任务')
assert.doesNotMatch(reviewDialogSource, /技术事实检索另设硬预算/, '界面不再显示技术事实检索硬预算说明')
assert.match(reviewDialogSource, /technical-fact-review-error/, '后续审查失败时必须在外部证据弹窗内直接显示错误原因')
assert.match(reviewPromptSource, /if\s*\(!Array\.isArray\(parsed\.findings\)\)/, '缺少findings字段的非结构化响应必须明确报错')
assert.doesNotMatch(reviewDialogSource, /if\s*\(!batchFindings\.length\)/, '结构正确的空findings数组表示该模块未发现问题，不应阻断其他模块')
assert.match(reviewDialogSource, /onFindingsChange\(\[\.\.\.nextFindings\]/, '每个审查模块完成后必须立即保留阶段卡片，后续模块失败时不得全部丢失')
for (const moduleTitle of ['技术理解与技术缺陷', '清楚性、支持性及形式缺陷', '对比文件的新颖性与创造性', '确权与维权稳定性']) {
  assert.ok(reviewPromptSource.includes(`【${moduleTitle}】`), `${moduleTitle}应具有独立审查提示词`)
}
assert.match(reviewPromptSource, /穷举所有有实质意义且彼此不同的问题/)
assert.match(reviewPromptSource, /高召回审查协议/, '提示词应采用高召回多轮核查')
assert.match(reviewPromptSource, /每个权利要求编号×本次所选模块×相关规则类别/, '输出前应按权利要求和规则类别执行遗漏复核')
assert.match(reviewPromptSource, /不得因为已经发现6条、10条或其他任意数量的问题而停止/, '不得因已有少量结果提前结束')
assert.match(reviewPromptSource, /reviewEveryClaim/, '请求应显式要求遍历全部权利要求')
assert.match(reviewPromptSource, /每条不得超过70个字符/, '智谱检索词必须满足官方长度限制')
assert.match(reviewPromptSource, /CQL/, 'EPO检索应生成CQL查询')
assert.match(priorArtSelectionSource, /用户上传文件和联网候选文献必须放在同一候选池中比较/, '上传文件与联网候选应共同参加最接近现有技术排序')
assert.match(reviewPromptSource, /必须把用户选定或系统明确指定的文件作为最接近现有技术/, '正式审查应服从用户确认的最接近现有技术')
assert.match(reviewPromptSource, /technicalFactEvidence/, '技术事实证据必须使用独立字段')
assert.match(reviewPromptSource, /priorArtSearchEvidence/, '候选对比文件证据必须使用独立字段')
const proseWrappedReview = JSON.parse(extractJsonObject(`审查完成，以下是结构化结果：
\`\`\`json
${JSON.stringify({
  findings: [{
    module: 'technical',
    title: '参数边界缺失',
    severity: '重要',
    evidenceLevel: '联网来源核验',
    location: '说明书',
    analysis: '未给出成立条件。',
    recommendation: '补充参数范围。',
    sources: [],
  }],
})}
\`\`\``))
assert.equal(proseWrappedReview.findings.length, 1, '审查结果被中文说明和JSON代码块包裹时仍应提取卡片')
assert.match(reviewPromptSource, /extractJsonObject\(content\)/, '审查卡片解析必须使用可容忍中文前言和JSON代码块的提取器')

const technicalPlan = buildTechnicalFactPlanMessages('超低温流体控制', '波纹管受冷缩短，带动阀杆移动并调节流量。')
assert.match(technicalPlan.system, /工程技术事实检索规划助手/)
assert.match(technicalPlan.system, /不是专利现有技术检索助手/)
assert.match(technicalPlan.user, /基本理论/)
assert.match(technicalPlan.user, /工程做法/)
assert.match(technicalPlan.user, /不生成IPC\/CPC分类号/)
assert.match(technicalPlan.system, /不得寻找相似专利/)
assert.equal(retrievalProviderSupportsTechnicalFacts('zhipu'), true)
assert.equal(retrievalProviderSupportsTechnicalFacts('custom-mcp'), true)
assert.equal(retrievalProviderSupportsTechnicalFacts('patsnap-mcp'), false)
assert.equal(retrievalProviderSupportsTechnicalFacts('epo-ops'), false)
const mixedResearchTools = [
  { name: 'web_search', description: '搜索互联网技术资料', inputSchema: {} },
  { name: 'read_page', description: '读取网页正文内容', inputSchema: {} },
  { name: 'search_patents', description: '检索专利候选', inputSchema: {} },
  { name: 'claims', description: '读取权利要求', inputSchema: {} },
]
assert.deepEqual(
  selectTechnicalFactToolNames(mixedResearchTools, mixedResearchTools.map((tool) => tool.name)),
  ['web_search', 'read_page'],
  '技术事实检索只能使用通用网页搜索和正文读取工具',
)
const zhipuWebSearchTool = {
  name: 'web_search',
  description: '使用智谱Web Search检索网页、论文、标准、专利线索和权威技术资料。可根据前次结果改写query继续检索。',
  inputSchema: {},
}
assert.deepEqual(
  selectTechnicalFactToolNames([zhipuWebSearchTool], ['web_search']),
  ['web_search'],
  '智谱web_search即使说明提到可返回专利线索，也仍应作为通用技术事实检索工具',
)
const factBundle = parseTechnicalFactEvidence(JSON.stringify({
  summary: '已核验低温工况下的材料和位移命题。',
  items: [{
    category: '参数与工况',
    proposition: '波纹管冷缩量足以直接驱动阀杆达到目标行程',
    patentQuote: '波纹管根据氦气温度变化沿第一方向伸缩',
    verdict: '缺少必要参数',
    analysis: '主文本没有给出热膨胀系数、有效长度、温差与所需阀杆行程。',
    missingConditions: ['波纹管有效长度', '材料低温热膨胀系数', '目标阀杆行程'],
    risk: '无法判断冷缩位移是否足够。',
    sources: [{
      title: '低温材料数据手册',
      url: 'https://example.com/cryogenic-materials',
      sourceLevel: '工程资料',
      excerpt: '材料收缩量取决于温区和材料。',
    }],
  }],
  uncoveredQuestions: ['密封材料在液氦温区的相容性'],
}))
assert.equal(factBundle.items.length, 1)
assert.equal(factBundle.items[0].verdict, '缺少必要参数')
assert.match(formatTechnicalFactEvidence(factBundle, [factBundle.items[0].id]), /经用户确认的技术事实检索证据/)
assert.doesNotMatch(formatTechnicalFactEvidence(factBundle, []), /低温材料数据手册/)
const proseWrappedFactBundle = parseTechnicalFactEvidence(`我已完成全部关键检索，以下是整理结果：
\`\`\`json
${JSON.stringify({
  summary: '已核验关键技术命题。',
  items: [{
    category: '基本理论',
    proposition: '模型返回说明文字后仍应读取其中JSON',
    patentQuote: '波纹管冷缩带动阀杆',
    verdict: '证据不足待核验',
    analysis: '返回值包含前导说明文字。',
    missingConditions: [],
    risk: '解析失败会中断审查。',
    sources: [],
  }],
  uncoveredQuestions: [],
})}
\`\`\``)
assert.equal(proseWrappedFactBundle.items.length, 1, '技术事实结果带有中文前言和JSON代码块时仍应完成解析')
const sourceUrlBundle = parseTechnicalFactEvidence(JSON.stringify({
  items: [{
    category: '工程做法',
    proposition: '来源链接应可由默认浏览器直接打开',
    verdict: '现有证据支持',
    analysis: 'LLM有时会把来源URL包装成Markdown链接。',
    risk: '未规范化时，桌面后端会拒绝打开来源。',
    sources: [
      { title: 'Markdown链接', url: '[打开原文](https://example.com/engineering-handbook)', sourceLevel: '工程资料', excerpt: '正文片段' },
      { title: '无效链接', url: '未提供可访问地址', sourceLevel: '搜索摘要', excerpt: '仅有摘要' },
    ],
  }],
}))
assert.equal(sourceUrlBundle.items[0].sources[0].url, 'https://example.com/engineering-handbook', 'Markdown包装的来源URL应先规范化再交给默认浏览器')
assert.equal(sourceUrlBundle.items[0].sources[1].url, '', '没有HTTP(S)地址的来源不应显示“打开来源”按钮')

const candidates = parsePriorArtCandidates(JSON.stringify({
  candidates: [
    {
      sourceType: 'network',
      name: '候选专利A',
      publicationNumber: 'CN100000001A',
      coveragePercent: 82.4,
      matchedFeatures: ['特征一', '特征二'],
      missingFeatures: ['特征三'],
      reason: '技术问题与主体结构最接近',
    },
    {
      sourceType: 'uploaded',
      name: '用户对比文件.docx',
      coveragePercent: 67,
      matchedFeatures: ['特征一'],
      missingFeatures: ['特征二'],
      reason: '用户上传文件',
    },
  ],
}))
assert.equal(candidates[0].publicationNumber, 'CN100000001A')
assert.equal(candidates[0].coveragePercent, 82)
assert.equal(candidates[1].sourceType, 'uploaded')
assert.equal(resolvePriorArtSourceMode(0, false), 'unavailable')
assert.equal(resolvePriorArtSourceMode(2, false), 'uploaded-only')
assert.equal(resolvePriorArtSourceMode(0, true), 'network-only')
assert.equal(resolvePriorArtSourceMode(2, true), 'uploaded-and-network')

const sortableFindings = [
  { id: 'late-legal', module: 'legal', severity: '一般', location: '说明书[0032]段', quote: '靠后的说明书问题' },
  { id: 'early-technical', module: 'technical', severity: '提示', location: '权利要求1', quote: '最早出现的技术问题' },
  { id: 'middle-enforcement', module: 'enforcement', severity: '重要', location: '权利要求2', quote: '中间出现的维权问题' },
]
const sortablePatentText = '权利要求书\n1. 最早出现的技术问题。\n2. 中间出现的维权问题。\n说明书\n[0032]靠后的说明书问题。'
assert.deepEqual(sortReviewFindings(sortableFindings, 'document', sortablePatentText).map((item) => item.id), ['early-technical', 'middle-enforcement', 'late-legal'])
assert.deepEqual(sortReviewFindings(sortableFindings, 'severity', sortablePatentText).map((item) => item.id), ['middle-enforcement', 'late-legal', 'early-technical'])
assert.deepEqual(sortReviewFindings(sortableFindings, 'category', sortablePatentText).map((item) => item.id), ['early-technical', 'late-legal', 'middle-enforcement'])
assert.match(reviewPromptSource, /联网候选文献可与用户上传文件共同参加/, '未上传对比文件时联网候选也应能启动新颖性与创造性评价')
assert.match(reviewPromptSource, /selectedClosestPriorArt/, '选定的最接近现有技术必须发送给正式审查')
assert.match(reviewDialogSource, /联网检索需视检索情况额外支付检索费用/, '开始联网检索前必须提示可能产生费用')
assert.match(reviewDialogSource, /取消联网检索并继续/, '费用提示必须允许取消联网后继续')
assert.match(reviewDialogSource, /选择最接近的现有技术/, '联网检索结束后必须停留在候选文献人工选择步骤')
assert.match(reviewDialogSource, /retrieval-tools-collapsible/, '大量MCP工具应放入可折叠设置')
assert.match(reviewDialogSource, /connectRetrievalMcp\(\{ automatic: true \}\)/, '凭证完整后应自动加载可调用工具')
assert.match(reviewDialogSource, /technicalSearchPlan/, '技术事实检索必须使用独立检索计划')
assert.match(reviewDialogSource, /priorArtSearchPlan/, '候选对比文件必须使用独立检索计划')
assert.match(reviewDialogSource, /技术事实检索已完成 · 人工确认/, '技术事实检索结束后必须经过人工证据确认')
assert.match(reviewDialogSource, /不作为新颖性或创造性的对比文件/, '界面必须明确技术事实证据的使用边界')

const researchTools = [
  { name: 'ops_search', description: '检索专利', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'ops_get_abstract', description: '获取摘要详情', inputSchema: { type: 'object', properties: { number: { type: 'string' } } } },
]
let agentTurnIndex = 0
const calledTools = []
const agentResult = await runMcpResearchAgent({
  technicalField: '超低温节流阀',
  confirmedSearchPlan: '波纹管驱动低温调节阀',
  claimsText: '一种调节阀，包括波纹管和阀杆。',
  tools: researchTools,
  allowedToolNames: researchTools.map((tool) => tool.name),
  maxSteps: 6,
}, {
  turn: async () => {
    agentTurnIndex += 1
    if (agentTurnIndex === 1) {
      return {
        content: '',
        assistantMessage: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'ops_search', arguments: '{"query":"ti=(bellows valve)"}' } }],
        },
        toolCalls: [{ id: 'call-1', name: 'ops_search', arguments: { query: 'ti=(bellows valve)' } }],
      }
    }
    if (agentTurnIndex === 2) {
      return { content: '仅凭标题给出结果', assistantMessage: { role: 'assistant', content: '仅凭标题给出结果' }, toolCalls: [] }
    }
    if (agentTurnIndex === 3) {
      return {
        content: '',
        assistantMessage: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'ops_get_abstract', arguments: '{"number":"EP1000000"}' } }],
        },
        toolCalls: [{ id: 'call-2', name: 'ops_get_abstract', arguments: { number: 'EP1000000' } }],
      }
    }
    return {
      content: '【候选对比文件】EP1000000；已读取摘要并列出区别特征。',
      assistantMessage: { role: 'assistant', content: '【候选对比文件】EP1000000；已读取摘要并列出区别特征。' },
      toolCalls: [],
    }
  },
  callTool: async (name) => {
    calledTools.push(name)
    return name === 'ops_search' ? 'EP1000000 candidate' : 'abstract text'
  },
})
assert.deepEqual(calledTools, ['ops_search', 'ops_get_abstract'], '检索代理应先搜索再读取候选文献详情')
assert.equal(agentResult.toolCallCount, 2)
assert.match(agentResult.evidence, /EP1000000/)

let technicalAgentTurnIndex = 0
const calledTechnicalTools = []
const technicalAgentResult = await runMcpResearchAgent({
  intent: 'technical-facts',
  technicalField: '超低温流体控制',
  confirmedSearchPlan: '核验波纹管在4K附近的热收缩量与工程应用边界',
  claimsText: '一种调节阀，包括波纹管和阀杆。',
  patentText: '说明书声称波纹管冷缩能够直接带动阀杆达到最大行程。',
  tools: mixedResearchTools,
  allowedToolNames: ['web_search', 'read_page'],
  maxSteps: 6,
}, {
  turn: async () => {
    technicalAgentTurnIndex += 1
    if (technicalAgentTurnIndex === 1) {
      return {
        content: '',
        assistantMessage: { role: 'assistant', content: null, tool_calls: [{ id: 'fact-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"cryogenic bellows thermal contraction engineering handbook"}' } }] },
        toolCalls: [{ id: 'fact-1', name: 'web_search', arguments: { query: 'cryogenic bellows thermal contraction engineering handbook' } }],
      }
    }
    if (technicalAgentTurnIndex === 2) {
      return {
        content: '',
        assistantMessage: { role: 'assistant', content: null, tool_calls: [{ id: 'fact-2', type: 'function', function: { name: 'read_page', arguments: '{"url":"https://example.com/handbook"}' } }] },
        toolCalls: [{ id: 'fact-2', name: 'read_page', arguments: { url: 'https://example.com/handbook' } }],
      }
    }
    return {
      content: JSON.stringify({
        summary: '已核验一个命题',
        items: [{
          category: '参数与工况',
          proposition: '冷缩位移足以达到目标行程',
          patentQuote: '波纹管冷缩带动阀杆',
          verdict: '缺少必要参数',
          analysis: '缺少长度、材料和行程数据。',
          missingConditions: ['有效长度'],
          risk: '可能无法达到目标行程。',
          sources: [{ title: 'Engineering handbook', url: 'https://example.com/handbook', sourceLevel: '工程资料', excerpt: 'Contraction depends on material and temperature.' }],
        }],
        uncoveredQuestions: [],
      }),
      assistantMessage: { role: 'assistant', content: 'technical facts JSON' },
      toolCalls: [],
    }
  },
  callTool: async (name) => {
    calledTechnicalTools.push(name)
    return name === 'web_search' ? 'handbook result' : 'engineering handbook body'
  },
})
assert.deepEqual(calledTechnicalTools, ['web_search', 'read_page'], '技术事实代理应先搜索再读取工程资料正文')
assert.doesNotMatch(technicalAgentResult.evidence, /候选对比文件/)
assert.equal(parseTechnicalFactEvidence(technicalAgentResult.evidence).items.length, 1)

let technicalRepairTurnIndex = 0
const repairedTechnicalAgentResult = await runMcpResearchAgent({
  intent: 'technical-facts',
  technicalField: '超低温流体控制',
  confirmedSearchPlan: '核验节流过程基本理论',
  claimsText: '一种低温节流阀。',
  patentText: '主文本声称节流后温度必然降低。',
  tools: [zhipuWebSearchTool],
  allowedToolNames: ['web_search'],
  maxSteps: 5,
}, {
  turn: async () => {
    technicalRepairTurnIndex += 1
    if (technicalRepairTurnIndex === 1) {
      return {
        content: '',
        assistantMessage: { role: 'assistant', content: null, tool_calls: [{ id: 'repair-1', type: 'function', function: { name: 'web_search', arguments: '{"query":"Joule Thomson coefficient helium temperature"}' } }] },
        toolCalls: [{ id: 'repair-1', name: 'web_search', arguments: { query: 'Joule Thomson coefficient helium temperature' } }],
      }
    }
    if (technicalRepairTurnIndex === 2) {
      return {
        content: '我已完成全部关键检索，将基于资料给出审查意见。',
        assistantMessage: { role: 'assistant', content: '我已完成全部关键检索，将基于资料给出审查意见。' },
        toolCalls: [],
      }
    }
    return {
      content: JSON.stringify({
        summary: '格式纠正完成。',
        items: [{
          category: '基本理论',
          proposition: '氦气节流后的温度变化取决于初始状态',
          patentQuote: '节流后温度必然降低',
          verdict: '仅在特定条件下成立',
          analysis: '焦耳—汤姆孙系数随温度和压力状态变化。',
          missingConditions: ['入口温度', '入口压力'],
          risk: '绝对化表述可能构成技术误解。',
          sources: [],
        }],
        uncoveredQuestions: [],
      }),
      assistantMessage: { role: 'assistant', content: 'corrected JSON' },
      toolCalls: [],
    }
  },
  callTool: async () => 'web search result',
})
assert.equal(technicalRepairTurnIndex, 3, '技术事实代理返回纯中文总结时应追加一次无工具JSON格式纠正')
assert.equal(parseTechnicalFactEvidence(repairedTechnicalAgentResult.evidence).items.length, 1)

let budgetedTurnIndex = 0
const budgetedToolCalls = []
const budgetedTechnicalResult = await runMcpResearchAgent({
  intent: 'technical-facts',
  technicalField: '超低温流体控制',
  confirmedSearchPlan: '分别核验基本理论、参数边界和失效风险',
  claimsText: '一种低温调节阀。',
  patentText: '说明书声称调节阀可在不同温区稳定工作。',
  tools: [zhipuWebSearchTool],
  allowedToolNames: ['web_search'],
  maxSteps: 8,
  maxToolCalls: 4,
  maxToolResultChars: 200,
  maxTotalToolResultChars: 800,
}, {
  turn: async (messages, tools) => {
    budgetedTurnIndex += 1
    const carriedContentLength = messages.reduce((total, message) => total + (message.content?.length ?? 0), 0)
    if (carriedContentLength > 5_000) {
      throw new Error('LLM检索会话超过安全传输上限，请减少工具调用轮次。')
    }
    if (!tools.length) {
      return {
        content: JSON.stringify({
          summary: '已在预算内完成关键技术事实核验。',
          items: [{
            category: '参数与工况',
            proposition: '不同温区下稳定工作需要明确适用边界',
            patentQuote: '可在不同温区稳定工作',
            verdict: '缺少必要参数',
            analysis: '温度和压力边界尚未明确。',
            missingConditions: ['温度范围', '压力范围'],
            risk: '无法判断全部工况下是否成立。',
            sources: [],
          }],
          uncoveredQuestions: ['极限低温工况'],
        }),
        assistantMessage: { role: 'assistant', content: 'budgeted technical JSON' },
        toolCalls: [],
      }
    }
    const toolCalls = Array.from({ length: 3 }, (_, index) => ({
      id: `budget-${budgetedTurnIndex}-${index}`,
      name: 'web_search',
      arguments: { query: `technical fact ${budgetedTurnIndex}-${index}` },
    }))
    return {
      content: '',
      assistantMessage: {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      },
      toolCalls,
    }
  },
  callTool: async (_name, argumentsValue) => {
    budgetedToolCalls.push(argumentsValue.query)
    return `检索结果：${'技术资料正文'.repeat(400)}`
  },
})
assert.equal(budgetedToolCalls.length, 4, '技术事实检索必须限制累计工具调用次数，而不能只限制对话轮次')
assert.equal(budgetedTechnicalResult.toolCallCount, 4, '达到工具调用预算后应基于已有证据整理结果')
assert.equal(parseTechnicalFactEvidence(budgetedTechnicalResult.evidence).items.length, 1)
assert.deepEqual(
  partitionReviewModules(['technical', 'legal', 'priorArt', 'enforcement']),
  [['technical'], ['legal'], ['priorArt'], ['enforcement']],
  '四个审查模块必须分别调用，避免单次输出过长或某一模块失败导致全部结果丢失',
)
const packetClaims = `1. 一种调节阀，包括阀座和阀杆。
2. 根据权利要求1所述的调节阀，其特征在于，还包括弹性件。
3. 根据权利要求2所述的调节阀，其特征在于，所述弹性件为弹簧。
4. 一种制冷设备，包括权利要求1所述的调节阀。`
const reviewPackets = createReviewWorkPackets(
  ['technical', 'legal', 'priorArt', 'enforcement'],
  packetClaims,
)
assert.equal(
  reviewPackets.filter((packet) => packet.module === 'legal').length,
  3,
  '清楚性、支持性及形式缺陷必须拆成三个独立思考任务，避免单次输出耗尽上下文',
)
assert.deepEqual(
  reviewPackets.filter((packet) => packet.module === 'priorArt').map((packet) => packet.claimNumber),
  ['1', '4', undefined],
  '新颖性与创造性应按独立权利要求分别审查，并另设从属保护层复核任务',
)
assert.equal(new Set(reviewPackets.map((packet) => packet.id)).size, reviewPackets.length, '审查任务包ID必须稳定且不重复')
const completedPacketIds = reviewPackets.slice(0, 2).map((packet) => packet.id)
assert.deepEqual(
  remainingReviewPackets(reviewPackets, completedPacketIds).map((packet) => packet.id),
  reviewPackets.slice(2).map((packet) => packet.id),
  '重试时只能继续尚未完成的任务包',
)
assert.deepEqual(
  completedModulesForPackets(reviewPackets, completedPacketIds),
  ['technical'],
  '只有模块内全部任务包完成后，模块才可标记为完成',
)
const duplicateFinding = {
  id: 'old',
  module: 'legal',
  title: '术语不一致',
  location: '权利要求 1',
  quote: '所述阀杆',
  analysis: '旧分析',
}
assert.deepEqual(
  mergeReviewFindings(
    [duplicateFinding],
    [{ ...duplicateFinding, id: 'new', analysis: '重复分析' }],
  ),
  [duplicateFinding],
  '不同任务包发现同一原文问题时必须在本地去重，避免重复卡片',
)
assert.deepEqual(
  remainingReviewModules(
    ['technical', 'legal', 'priorArt', 'enforcement'],
    ['technical', 'legal'],
  ),
  ['priorArt', 'enforcement'],
  '重试后续审查时只能继续尚未完成的模块，不能重新调用已经生成卡片的模块',
)
assert.equal(
  formatReviewProgress({
    current: 3,
    total: 4,
    moduleName: '新颖性与创造性',
    completed: 2,
    generatedCards: 13,
  }),
  '正在生成 3/4：新颖性与创造性；已完成 2/4，累计 13 张卡片。',
  '技术证据确认窗口必须显示当前模块、总步骤和累计卡片数',
)
assert.match(reviewDialogSource, /technical-fact-review-progress[\s\S]*reviewProgressLabel/, '箭头所指的提示栏必须显示逐模块审查进度')
assert.match(reviewDialogSource, /createReviewWorkPackets\(reviewModules, claimsText\)/, '辅助审查必须按可恢复任务包运行，不能只按四个大模块运行')
assert.match(reviewDialogSource, /completedReviewPacketIds/, '会话必须保存已完成任务包，失败后只重试当前及后续任务')
assert.match(reviewPromptSource, /workPacket/, '每次LLM调用必须携带当前任务包的聚焦范围')
const reviewDiagnostic = buildReviewDiagnostic({
  provider: 'DeepSeek',
  model: 'deepseek-chat',
  error: 'DeepSeek返回了空结果。',
  progress: {
    current: 4,
    total: 4,
    moduleName: '确权与维权稳定性',
    completed: 3,
    generatedCards: 13,
  },
  completedModules: ['technical', 'legal', 'priorArt'],
})
assert.match(reviewDiagnostic, /确权与维权稳定性/, '诊断信息必须标出发生错误的审查模块')
assert.match(reviewDiagnostic, /DeepSeek返回了空结果/, '诊断信息必须保留原始错误')
assert.equal(Object.hasOwn(JSON.parse(reviewDiagnostic), 'apiKey'), false, '诊断信息不得包含API Key字段')
assert.match(reviewDialogSource, /复制诊断信息/, '测试版错误栏必须提供临时诊断信息复制入口')
assert.equal(technicalFactResearchBudget.maxToolCalls, 6, '技术事实检索应采用独立的累计工具调用上限')
assert.ok(technicalFactResearchBudget.maxTotalToolResultChars <= 24_000, '技术事实检索累计正文应限制在安全上下文预算内')
assert.match(reviewDialogSource, /Math\.min\(retrievalProfile\.count,\s*5\)/, '技术事实检索每次返回结果数量应单独收紧')

console.log('LLM审查与内置规则库回归检查通过')
