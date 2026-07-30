import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { detectTechnicalField, extractClaimsText, technicalFieldsDiffer } from '../src/technical-field.ts'
import { runMcpResearchAgent } from '../src/mcp-research-agent.ts'
import { parsePriorArtCandidates, resolvePriorArtSourceMode } from '../src/prior-art-selection.ts'
import { sortReviewFindings } from '../src/review-finding-sort.ts'
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

const reviewPromptSource = await readFile(new URL('../src/llm-review.ts', import.meta.url), 'utf8')
const priorArtSelectionSource = await readFile(new URL('../src/prior-art-selection.ts', import.meta.url), 'utf8')
const reviewDialogSource = await readFile(new URL('../src/LlmReviewDialog.tsx', import.meta.url), 'utf8')
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

console.log('LLM审查与内置规则库回归检查通过')
