export type ResearchTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ResearchToolCall = {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type ResearchAgentMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export type ResearchAgentTurn = {
  content: string
  assistantMessage: ResearchAgentMessage
  toolCalls: ResearchToolCall[]
}

export type ResearchTraceEntry = {
  step: number
  toolName: string
  arguments: Record<string, unknown>
  resultPreview: string
}

export type ResearchAgentResult = {
  evidence: string
  trace: ResearchTraceEntry[]
  toolCallCount: number
}

type ResearchAgentOptions = {
  technicalField: string
  confirmedSearchPlan: string
  claimsText: string
  tools: ResearchTool[]
  allowedToolNames: string[]
  maxSteps: number
}

type ResearchAgentDependencies = {
  turn: (messages: ResearchAgentMessage[], tools: ResearchTool[]) => Promise<ResearchAgentTurn>
  callTool: (toolName: string, argumentsValue: Record<string, unknown>) => Promise<string>
  onProgress?: (entry: ResearchTraceEntry) => void
}

function researchSystemPrompt() {
  return `你是专利现有技术检索代理。你可以自主调用已提供的专利检索工具，并根据每次结果继续调整检索策略。

目标不是做一次关键词搜索，而是形成可追溯的对比文件候选集。必须执行以下闭环：
1. 从确认的检索方案和权利要求中提取核心发明构思、必要技术特征、同义词和可能分类号；
2. 先进行宽窄结合的候选检索；结果过多时增加特征或分类号，结果过少时改用同义词、上位概念、英文词或拆分特征；
3. 对高相关候选继续调用书目、摘要、权利要求、说明书或同族工具，不能仅凭标题判断；
4. 记录文献号、标题、公开日/优先权日、与本案对应的技术特征、缺失特征及来源工具；
5. 不得把没有通过工具取得的文献或内容写成事实，不得伪造文献号、日期或引文；
6. 联网取得的文献是“候选对比文件”，公开日、全文和法律地位仍需人工复核；不得直接下最终新颖性或创造性法律结论；
7. 找到若干结果后仍应判断是否需要换检索方向，避免因首批命中而提前停止。

完成检索时输出中文纯文本，至少包含：
【检索策略与迭代】
【候选对比文件】逐篇列出文献号、标题、日期、命中特征、区别/缺失特征、相关性和证据来源
【未覆盖的检索方向】
【人工复核事项】
不要使用未经工具返回支持的事实。`
}

function researchUserPrompt(options: ResearchAgentOptions) {
  return JSON.stringify({
    task: '通过专利检索工具迭代寻找候选对比文件',
    technicalField: options.technicalField,
    confirmedSearchPlan: options.confirmedSearchPlan,
    claimsForFeatureDecomposition: options.claimsText.slice(0, 18_000),
    instruction: '请先调用检索工具，不要直接给结论。搜索后应选择高相关文献继续获取摘要、权利要求、说明书或书目信息。',
  })
}

function normalizedCallKey(call: ResearchToolCall) {
  return `${call.name}:${JSON.stringify(call.arguments)}`
}

function truncateToolResult(value: string) {
  const trimmed = value.trim()
  return trimmed.length > 100_000 ? `${trimmed.slice(0, 100_000)}\n[工具结果过长，已截断]` : trimmed
}

function toolMatches(tool: ResearchTool, keywords: string[]) {
  const text = `${tool.name} ${tool.description}`.toLowerCase()
  return keywords.some((keyword) => text.includes(keyword))
}

export async function runMcpResearchAgent(
  options: ResearchAgentOptions,
  dependencies: ResearchAgentDependencies,
): Promise<ResearchAgentResult> {
  const allowed = new Set(options.allowedToolNames)
  const tools = options.tools.filter((tool) => allowed.has(tool.name))
  if (!tools.length) throw new Error('没有允许LLM调用的专利检索工具。')

  const messages: ResearchAgentMessage[] = [
    { role: 'system', content: researchSystemPrompt() },
    { role: 'user', content: researchUserPrompt(options) },
  ]
  const trace: ResearchTraceEntry[] = []
  const callCounts = new Map<string, number>()
  let noToolReminderUsed = false
  let depthReminderUsed = false
  const maxSteps = Math.max(2, Math.min(12, options.maxSteps || 8))
  const searchToolNames = new Set(tools
    .filter((tool) => toolMatches(tool, ['search', 'query', '检索', '搜索']))
    .map((tool) => tool.name))
  const detailToolNames = new Set(tools
    .filter((tool) => toolMatches(tool, ['abstract', 'fulltext', 'claim', 'biblio', 'detail', 'family', '摘要', '全文', '权利要求', '书目', '详情', '同族']))
    .map((tool) => tool.name))

  for (let step = 1; step <= maxSteps; step += 1) {
    const turn = await dependencies.turn(messages, tools)
    messages.push(turn.assistantMessage)
    if (!turn.toolCalls.length) {
      const usedSearch = trace.some((entry) => searchToolNames.has(entry.toolName))
      const usedDetail = trace.some((entry) => detailToolNames.has(entry.toolName))
      if ((!trace.length || (searchToolNames.size > 0 && !usedSearch)) && !noToolReminderUsed) {
        noToolReminderUsed = true
        messages.push({
          role: 'user',
          content: '你尚未调用任何检索工具。请先实际调用至少一个搜索工具，再根据结果调用详情类工具；不得直接结束。',
        })
        continue
      }
      if (detailToolNames.size > 0 && !usedDetail && !depthReminderUsed) {
        depthReminderUsed = true
        messages.push({
          role: 'user',
          content: '你只完成了候选搜索，尚未读取高相关文献的摘要、书目、权利要求、说明书或同族信息。请先调用至少一个详情类工具核查候选，不得仅凭标题结束。',
        })
        continue
      }
      if (!turn.content.trim()) throw new Error('检索代理结束时没有返回可读取的候选对比文件说明。')
      return { evidence: turn.content.trim(), trace, toolCallCount: trace.length }
    }

    for (const call of turn.toolCalls) {
      if (!allowed.has(call.name)) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `工具调用被拒绝：${call.name}不在本次人工允许的工具列表中。`,
        })
        continue
      }
      const key = normalizedCallKey(call)
      const repeated = (callCounts.get(key) ?? 0) + 1
      callCounts.set(key, repeated)
      if (repeated > 2) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: '相同参数已经调用两次，请调整检索式或改用其他详情工具。',
        })
        continue
      }
      const result = truncateToolResult(await dependencies.callTool(call.name, call.arguments))
      const entry: ResearchTraceEntry = {
        step,
        toolName: call.name,
        arguments: call.arguments,
        resultPreview: result.slice(0, 500),
      }
      trace.push(entry)
      dependencies.onProgress?.(entry)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result || '工具调用成功，但未返回可读取内容。',
      })
    }
  }

  const finalTurn = await dependencies.turn([
    ...messages,
    {
      role: 'user',
      content: '工具调用轮次已达到上限。请停止调用工具，基于已经取得的结果输出候选对比文件、区别特征、未覆盖方向和人工复核事项。',
    },
  ], [])
  if (!finalTurn.content.trim()) throw new Error('检索代理达到轮次上限，但未能整理检索结果。')
  return { evidence: finalTurn.content.trim(), trace, toolCallCount: trace.length }
}
