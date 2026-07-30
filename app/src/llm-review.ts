import { reviewRulebook, selectRulesForModules, sourceForRule, type ReviewModuleKey } from './review-rulebook'
import type { RetrievalProvider } from './llm-settings'
import type { PriorArtCandidate } from './prior-art-selection'
export { detectTechnicalField, extractClaimsText, technicalFieldsDiffer } from './technical-field'

export type ReviewScope = 'claims' | 'full' | 'full-with-prior-art'
export type ReviewEvidenceLevel = '规则库核验' | '联网来源核验' | 'LLM推断' | '待人工核验'
export type ReviewSeverity = '重要' | '一般' | '提示'

export type ComparisonDocument = {
  name: string
  text: string
}

export type ReviewSource = {
  title: string
  url: string
  sourceType: string
}

export type LlmReviewFinding = {
  id: string
  module: ReviewModuleKey
  title: string
  severity: ReviewSeverity
  evidenceLevel: ReviewEvidenceLevel
  location: string
  quote: string
  analysis: string
  recommendation: string
  sources: ReviewSource[]
  accepted: boolean
}

export type ReviewRunOptions = {
  modules: ReviewModuleKey[]
  scope: ReviewScope
  technicalField: string
  patentText: string
  claimsText: string
  comparisonDocuments: ComparisonDocument[]
  searchEvidence: string
  allowPriorArtNetworkSearch: boolean
  selectedClosestPriorArt?: PriorArtCandidate | null
}

const moduleLabels: Record<ReviewModuleKey, string> = {
  technical: '技术理解与技术缺陷',
  legal: '清楚性、支持性及形式缺陷',
  priorArt: '对比文件的新颖性与创造性',
  enforcement: '确权与维权稳定性',
}

export const reviewModuleInstructions: Record<ReviewModuleKey, string> = {
  technical: `【技术理解与技术缺陷】
先重建技术方案：明确技术问题、构成/步骤、输入输出、作用机理、关键条件和声称的技术效果，再逐项核查：
1. 说明书、权利要求、摘要和附图之间是否存在结构、流程、参数、方向、材料、对象或因果关系矛盾；
2. 技术机理是否违反该技术领域的基本原理，是否遗漏使方案能够工作的必要条件，是否把相关性误写为因果关系；
3. 数值、单位、量纲、范围端点、测试条件和比较基准是否完整且自洽；
4. 声称的技术效果是否能由公开的技术手段合理产生，是否存在效果过度外推、无法复现或缺少验证条件；
5. 本领域技术人员能否按全文实际实施；对确实无法从文本判断的事项，明确列为待核验问题，不得虚构技术事实。
6. 逐项检查极限工况、容差累积、材料相容性、热/力/电/流体耦合、装配与制造可行性、控制状态切换、故障模式和安全边界；正文声称“稳定、可靠、均匀、精确、完全消除”等效果时，必须寻找对应结构、参数或验证依据。
技术事实优先引用联网核验资料；没有可靠来源时只能标注“LLM推断”或“待人工核验”。每个独立技术问题分别形成一张卡片。`,
  legal: `【清楚性、支持性及形式缺陷】
以随请求提供的中国专利规则库为审查基准，按“形式→权利要求→说明书→相互对应关系”完成系统检查：
1. 核查说明书组成、标题、摘要、附图说明、附图标记、段落与术语的一致性，以及权利要求编号、引用关系、多项从属引用和标点格式；
2. 对每项权利要求逐项核查主题类型、首次引入和引用基础、限定对象、语法指向、术语一致性、相对用语、功能性限定、参数和数值范围的清楚性；
3. 核查独立权利要求是否记载解决技术问题所必需的技术特征，从属权利要求是否真正构成进一步限定；
4. 将每一项权利要求的概括与说明书实施方式、附图和实验/效果记载逐项对应，识别不当上位概括、缺少支持、范围端点无依据及选择发明/Markush概括风险；
5. 核查说明书是否清楚、完整并达到能够实现，是否只有目标或结果而缺少实现手段，是否存在前后矛盾、关键参数或实施条件缺失。
6. 对每项权利要求逐一复核：前序基础、引用链、保护主题一致性、必要技术特征、部件之间的完整关系、功能性限定、结果性限定、相对用语、开放/封闭用语、数值范围端点、可选特征混入必要特征及从属权利要求是否真正缩小范围。
不得把标题中的主题名称误判为未引入；不得因短字符串包含关系把不同限定对象混为一谈。每个不同法律问题分别形成卡片并关联最直接规则。`,
  priorArt: `【对比文件的新颖性与创造性】
以用户上传的对比文件和/或经用户确认的联网检索候选文献为评价基础。联网文献必须保留来源、公开日和待人工复核标记。
1. 先拆分每项权利要求的全部技术特征，并为每份对比文件建立逐项特征对应关系；没有明确或必然隐含公开的特征不得视为已公开；
2. 新颖性必须坚持单独对比原则：只有同一份对比文件直接、无歧义地公开全部技术特征时，才能提出缺乏新颖性的风险；
3. 创造性按“三步法”说明最接近现有技术、区别特征、区别特征实际产生的技术效果、实际解决的技术问题及是否存在技术启示；
4. 多文件组合必须说明组合动机、技术领域关联、功能配合和合理成功预期，不得用申请文件作为路线图进行事后诸葛亮式分析；
5. 同时寻找可支撑创造性的因素：预料不到的技术效果、反向教导、技术偏见、参数临界性、长期未解决需求及组合后的协同作用；
6. 分别给出独立权利要求和重要从属权利要求的风险，不得仅作笼统结论；无法确认公开日、文本完整性或对应关系时标记待人工核验。
7. 对最接近现有技术建立逐特征覆盖表，并继续检查每一项从属权利要求新增特征是否已被同一文件公开、是否需要另一文件组合、是否存在明确组合动机；不得只分析权利要求1。
每个“权利要求×对比文件×争点”形成可追溯的独立卡片。`,
  enforcement: `【确权与维权稳定性】
从授权后解释、无效稳定性、侵权比对和实际取证四个角度审查：
1. 识别可能导致保护范围不确定的功能性、结果性、用途、使用环境、相对位置、参数或方法步骤限定，并评估其解释风险；
2. 识别独立权利要求过宽导致的无效风险、过窄导致的易规避风险，以及容易被竞争者替换、省略、调整顺序或改变参数绕开的特征；
3. 评估关键特征能否从被诉产品、公开资料、检测、拆解或工艺记录中取证；对难以观察或仅存在于内部过程的特征提出可取证化建议；
4. 核查权利要求层级是否形成合理保护梯度，重要商业实施方式、替代结构和等同变形是否得到说明书支持及从属权利要求覆盖；
5. 结合禁止反悔、捐献、功能性特征解释、现有技术抗辩和全面覆盖原则，提示修改可能对未来解释和维权造成的影响；
6. 给出兼顾授权、稳定性和保护范围的修改策略，不得为了扩大范围而建议加入原申请没有依据的内容。
7. 对每项独立权利要求和关键从属权利要求分别检查：可观测性、可取证性、侵权主体是否单一、方法步骤是否跨主体实施、必要特征是否容易被替换或省略、参数能否在被诉产品上复现测量，以及建议修改是否可能触发禁止反悔或缩小等同范围。
每个独立的稳定性、规避或取证风险分别形成卡片，并明确属于授权、确权还是维权视角。`,
}

function sourceSummary(sourceIds: string[]) {
  return sourceIds
    .map(sourceForRule)
    .filter((source): source is NonNullable<ReturnType<typeof sourceForRule>> => Boolean(source))
    .map((source) => ({ title: source.title, url: source.url }))
}

function ruleContext(options: ReviewRunOptions) {
  return selectRulesForModules(options.modules, options.patentText)
    .map((rule) => ({
      id: rule.id,
      category: rule.category,
      title: rule.title,
      severity: rule.severityDefault,
      question: rule.reviewQuestion,
      summary: rule.ruleSummary,
      method: rule.reviewMethod,
      evidence: rule.evidenceRequirements,
      antiFalsePositive: rule.notes,
      confidence: rule.confidence,
      sources: sourceSummary(rule.sources),
    }))
}

export function buildReviewMessages(options: ReviewRunOptions) {
  const patentContent = options.scope === 'claims' ? options.claimsText : options.patentText.slice(0, 120_000)
  const comparisonText = options.modules.includes('priorArt')
    ? options.comparisonDocuments.map((document, index) => `【对比文件${index + 1}：${document.name}】\n${document.text.slice(0, 70_000)}`).join('\n\n')
    : ''
  const rules = ruleContext(options)
  const selectedModules = options.modules.map((module) => `${module}: ${moduleLabels[module]}`)
  const selectedInstructions = options.modules.map((module) => reviewModuleInstructions[module])
  return {
    system: `你是资深中国专利工程师和专利代理实务审查助手。你应理解用户确认的具体技术领域，但不得把能力限制在某个预设行业。你熟悉中国专利申请的授权、复审、无效和侵权维权流程，目标是在合理保护范围、授权可行性、确权稳定性与维权可执行性之间取得平衡。你只进行辅助审查，不构成法律意见。

工作方法：
1. 先通读本次发送的全部材料并建立技术方案、权利要求层级、说明书支持关系和附图对应关系，再按所选模块逐项检查；不得只审查开头、独立权利要求或少数显眼问题。
2. 对全部权利要求和相关说明书段落执行覆盖式核查，穷举所有有实质意义且彼此不同的问题，不设固定数量上限，不得因已经找到若干问题而提前停止。
3. 同一根本问题影响多个权利要求时，可合并但必须列明全部受影响权利要求；不同问题不得为凑数合并成一张卡片。
4. 每条结论必须说明“原文—判断依据—风险—可操作建议”的完整链条，并区分确定事实、合理推断和信息不足。

高召回审查协议：
1. 第一遍做“结构拆解”：逐项读取每一项权利要求，按分号、句号、并列词和从属引用拆成技术特征；检查每个主题名称、部件、材料、动作、参数、方向、位置、连接关系、时序关系和技术效果，不得跳过从属权利要求。
2. 第二遍做“交叉核对”：逐项核对权利要求↔说明书、权利要求↔附图、说明书前后段落、摘要↔主文本、术语↔附图标记以及技术手段↔技术效果；相互矛盾、缺少支持、缺少实现条件或对象指向不明的事项分别报告。
3. 第三遍做“对抗性复核”：分别模拟实质审查员、无效请求人和潜在侵权人的质疑路径，检查是否存在可驳回、可无效、易规避、难取证或保护范围不确定的问题。
4. 第四遍做“遗漏复核”：在输出前按“每个权利要求编号×本次所选模块×相关规则类别”建立内部覆盖清单，重新检查尚未产生结果的项目。不得因为已经发现6条、10条或其他任意数量的问题而停止。
5. 对证据充分的问题直接报告；对具有明确原文依据、但仍缺少实验数据、公开文本或技术常识证据的合理风险，也应报告并标记为“待人工核验”，不得仅因不确定而省略。
6. 高召回不等于凑数量：纯文字偏好、没有风险后果的润色建议、同一问题的重复表述以及无法定位原文的猜测不得输出。

严格要求：
1. 只报告能够定位到原文或证据的事项；quote必须是原文中连续、精确、尽量不跨段且不超过120字的短句。找不到精确引文时不得伪造引文。
2. 不得把标题中的主题名称误判为未引入；不得把“第一抵接面”与“抵接面”、“第一管道”与“管道”等不同对象混为一谈。
3. 法律结论优先依据随请求提供的规则库；技术事实必须引用可核验来源，否则标记为“LLM推断”或“待人工核验”。
4. 新颖性和创造性必须以本次提供的对比文件材料为基础。${options.allowPriorArtNetworkSearch ? '联网候选文献可与用户上传文件共同参加最接近现有技术的比较，但必须标明联网来源并提示人工复核公开日、全文和法律状态。' : '本次未启用联网补检，只能使用用户上传的对比文件。'}必须把用户选定或系统明确指定的文件作为最接近现有技术，不得擅自改用其他文件。
5. 风险等级使用“重要/一般/提示”；没有发现问题的模块不要虚构问题。
6. 输出合法JSON，不要使用Markdown围栏，不要输出寒暄、审查过程或JSON以外的文字。

本次所选模块的专项审查指令如下。请把这些指令作为同一套连贯工作流执行，但必须在每条结果的module字段中保留所属模块：

${selectedInstructions.join('\n\n')}`,
    user: JSON.stringify({
      task: '对专利申请初稿进行辅助审查',
      reviewMode: '高召回覆盖式审查：宁可把有明确原文依据但证据尚不完整的合理风险标为待人工核验，也不要静默遗漏；不得虚构或凑数。',
      coverageRequirements: {
        reviewEveryClaim: true,
        includeDependentClaims: true,
        crossCheckSpecificationDrawingsAbstract: true,
        runAdversarialReview: true,
        runFinalOmissionAudit: true,
        noFindingCountLimit: true,
      },
      outputSchema: {
        findings: [{
          module: 'technical|legal|priorArt|enforcement',
          title: '简明问题标题',
          severity: '重要|一般|提示',
          evidenceLevel: '规则库核验|联网来源核验|LLM推断|待人工核验',
          location: '权利要求号、说明书小节或可识别位置',
          quote: '原文精确短句，不超过120字',
          analysis: '问题分析，说明证据与不确定性',
          recommendation: '具体修改或核验建议',
          sources: [{ title: '来源标题', url: 'https://...' }],
        }],
      },
      selectedModules,
      technicalField: options.technicalField,
      rulebook: {
        version: reviewRulebook.metadata.version,
        verifiedAt: reviewRulebook.metadata.lastVerifiedAt,
        rules,
      },
      searchEvidence: options.searchEvidence || '未启用联网技术事实检索',
      selectedClosestPriorArt: options.selectedClosestPriorArt || '本次未启用新颖性与创造性评价',
      patentText: patentContent,
      comparisonDocuments: comparisonText || '未提供用户上传的对比文件',
    }),
  }
}

export function buildSearchPlanMessages(technicalField: string, claimsText: string) {
  return {
    system: '你是专利技术检索规划助手。只生成检索计划，不评价专利性。输出纯文本，不使用Markdown表格。',
    user: `技术领域：${technicalField || '未填写'}
权利要求摘要：
${claimsText.slice(0, 12_000)}

请生成可编辑的技术事实检索计划，必须包含：核心技术问题、中文/英文关键词、同义词、可能的IPC/CPC分类、优先来源（专利/论文/标准/权威机构资料）和建议检索式。不要检索，也不要给出结论。`,
  }
}

export function buildRetrievalQueryMessages(provider: RetrievalProvider, searchPlan: string) {
  const providerRule = provider === 'epo-ops'
    ? `为 EPO OPS 生成1至6条CQL检索式。使用 ti（标题）、ab（摘要）、cl（IPC）、cpc、pa 等字段和 AND/OR；关键词短语使用英文双引号。不要生成自然语言问题。`
    : provider === 'zhipu'
      ? '生成1至6条可直接交给网页搜索引擎的中英文检索词；每条不得超过70个字符。'
      : '生成1至6条适合专利检索MCP执行的简洁检索请求；每条只包含一个明确检索意图。'
  return {
    system: `你是检索式整理助手。只把用户已经确认的检索计划转换为可执行查询，不增加新的检索方向。${providerRule}输出合法JSON，不使用Markdown。`,
    user: JSON.stringify({
      confirmedSearchPlan: searchPlan,
      outputSchema: { queries: ['检索式1', '检索式2'] },
    }),
  }
}

export function parseRetrievalQueries(content: string) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(cleaned) as { queries?: unknown[] }
  const seen = new Set<string>()
  return (parsed.queries ?? []).flatMap((query) => {
    if (typeof query !== 'string') return []
    const normalized = query.trim()
    if (!normalized || seen.has(normalized)) return []
    seen.add(normalized)
    return [normalized]
  }).slice(0, 8)
}

export function parseReviewFindings(content: string, modules: ReviewModuleKey[]): LlmReviewFinding[] {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(cleaned) as { findings?: Array<Partial<LlmReviewFinding>> }
  return (parsed.findings ?? []).flatMap((finding, index) => {
    if (!finding.title || !finding.analysis || !finding.module || !modules.includes(finding.module)) return []
    const evidenceLevel: ReviewEvidenceLevel = ['规则库核验', '联网来源核验', 'LLM推断', '待人工核验'].includes(finding.evidenceLevel ?? '')
      ? finding.evidenceLevel as ReviewEvidenceLevel
      : '待人工核验'
    const severity: ReviewSeverity = ['重要', '一般', '提示'].includes(finding.severity ?? '')
      ? finding.severity as ReviewSeverity
      : '一般'
    return [{
      id: `llm-${Date.now()}-${index}`,
      module: finding.module,
      title: finding.title,
      severity,
      evidenceLevel,
      location: finding.location?.trim() || '待人工定位',
      quote: finding.quote?.trim().slice(0, 120) || '',
      analysis: finding.analysis,
      recommendation: finding.recommendation?.trim() || '建议人工复核。',
      sources: Array.isArray(finding.sources) ? finding.sources.filter((source): source is ReviewSource => Boolean(source?.title)) : [],
      accepted: false,
    }]
  })
}
