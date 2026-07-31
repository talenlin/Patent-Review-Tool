export type ReviewModuleName = 'technical' | 'legal' | 'priorArt' | 'enforcement'

export type ReviewContextMode = 'claims' | 'full' | 'technical' | 'prior-art'

export type ReviewWorkPacket = {
  id: string
  module: ReviewModuleName
  title: string
  focus: string
  ruleCategories: string[]
  contextMode: ReviewContextMode
  claimNumber?: string
}

export type ReviewProgress = {
  current: number
  total: number
  moduleName: string
  completed: number
  generatedCards: number
}

export function partitionReviewModules(modules: ReviewModuleName[]): ReviewModuleName[][] {
  return modules
    .filter((module, index) => modules.indexOf(module) === index)
    .map((module) => [module])
}

export function remainingReviewModules(
  modules: ReviewModuleName[],
  completedModules: ReviewModuleName[],
) {
  const completed = new Set(completedModules)
  return modules.filter((module, index) => modules.indexOf(module) === index && !completed.has(module))
}

type ParsedClaim = {
  number: string
  text: string
  dependent: boolean
}

function parseClaims(claimsText: string): ParsedClaim[] {
  const matches = [...claimsText.matchAll(/(?:^|\n)\s*(\d+)\s*[.．、]\s*/g)]
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = matches[index + 1]?.index ?? claimsText.length
    const text = claimsText.slice(start, end).trim()
    return {
      number: match[1],
      text,
      dependent: /^(?:根据|如|按照)\s*权利要求\s*\d/.test(text),
    }
  })
}

const modulePackets: Record<Exclude<ReviewModuleName, 'priorArt'>, ReviewWorkPacket[]> = {
  technical: [
    {
      id: 'technical-principles',
      module: 'technical',
      title: '技术原理、因果链与成立条件',
      focus: '逐项核验核心技术命题的基本原理、作用机理、因果链以及成立所需的隐含条件；只输出这一焦点内的问题。',
      ruleCategories: [],
      contextMode: 'technical',
    },
    {
      id: 'technical-engineering-risks',
      module: 'technical',
      title: '参数边界、工程实现与失效风险',
      focus: '逐项核验参数和单位、极限工况、材料与结构可行性、制造装配、控制状态、容差累积和失效风险；只输出这一焦点内的问题。',
      ruleCategories: [],
      contextMode: 'technical',
    },
  ],
  legal: [
    {
      id: 'legal-claims-clarity',
      module: 'legal',
      title: '权利要求清楚性、引用与术语',
      focus: '逐项审查全部权利要求的主题名称、首次引入、引用基础、语法指向、术语一致性、相对用语、功能限定和数值范围。',
      ruleCategories: ['清楚性'],
      contextMode: 'claims',
    },
    {
      id: 'legal-support-disclosure',
      module: 'legal',
      title: '说明书支持、充分公开与必要特征',
      focus: '逐项建立权利要求与说明书实施方式、技术效果和实验数据的对应关系，审查概括范围、必要技术特征、支持性和充分公开。',
      ruleCategories: ['支持性', '充分公开', '实用性'],
      contextMode: 'full',
    },
    {
      id: 'legal-formality-consistency',
      module: 'legal',
      title: '形式要求、单一性与全文一致性',
      focus: '审查说明书组成、摘要、附图说明、附图标记、段落与术语一致性、单一性以及可能的修改超范围风险。',
      ruleCategories: ['形式缺陷', '单一性', '修改超范围'],
      contextMode: 'full',
    },
  ],
  enforcement: [
    {
      id: 'enforcement-scope-stability',
      module: 'enforcement',
      title: '保护范围解释与无效稳定性',
      focus: '按独立权利要求和保护层级审查范围不确定、过宽、过窄、功能性限定、禁止反悔和无效稳定性风险。',
      ruleCategories: ['权利要求解释', '无效稳定性'],
      contextMode: 'claims',
    },
    {
      id: 'enforcement-evidence-design-around',
      module: 'enforcement',
      title: '侵权取证、规避路径与保护梯度',
      focus: '审查技术特征的可观察性、可取证性、跨主体实施、替换省略规避路径以及从属权利要求的保护梯度。',
      ruleCategories: ['侵权维权'],
      contextMode: 'claims',
    },
  ],
}

function priorArtPackets(claimsText: string): ReviewWorkPacket[] {
  const claims = parseClaims(claimsText)
  const independentClaims = claims.filter((claim) => !claim.dependent)
  const packets = (independentClaims.length ? independentClaims : [{ number: '', text: '', dependent: false }])
    .map((claim): ReviewWorkPacket => ({
      id: claim.number ? `prior-art-claim-${claim.number}` : 'prior-art-independent-claims',
      module: 'priorArt',
      title: claim.number ? `权利要求${claim.number}的新颖性与创造性` : '独立权利要求的新颖性与创造性',
      focus: claim.number
        ? `仅围绕独立权利要求${claim.number}建立逐特征对照，分别评价新颖性和创造性，并明确区别特征、技术效果和技术启示。`
        : '围绕全部独立权利要求建立逐特征对照，分别评价新颖性和创造性。',
      ruleCategories: ['新颖性', '创造性', '对比文件比对'],
      contextMode: 'prior-art',
      claimNumber: claim.number || undefined,
    }))
  if (claims.some((claim) => claim.dependent)) {
    packets.push({
      id: 'prior-art-dependent-claims',
      module: 'priorArt',
      title: '从属权利要求新增特征与保护层级',
      focus: '逐项检查全部从属权利要求新增特征是否被最接近现有技术公开、是否需要组合文献以及是否形成有效保护梯度。',
      ruleCategories: ['新颖性', '创造性', '对比文件比对'],
      contextMode: 'prior-art',
    })
  }
  return packets
}

export function createReviewWorkPackets(
  modules: ReviewModuleName[],
  claimsText: string,
): ReviewWorkPacket[] {
  const uniqueModules = modules.filter((module, index) => modules.indexOf(module) === index)
  return uniqueModules.flatMap((module) => (
    module === 'priorArt'
      ? priorArtPackets(claimsText)
      : modulePackets[module].map((packet) => ({ ...packet, ruleCategories: [...packet.ruleCategories] }))
  ))
}

export function remainingReviewPackets(
  packets: ReviewWorkPacket[],
  completedPacketIds: string[],
) {
  const completed = new Set(completedPacketIds)
  return packets.filter((packet) => !completed.has(packet.id))
}

export function completedModulesForPackets(
  packets: ReviewWorkPacket[],
  completedPacketIds: string[],
): ReviewModuleName[] {
  const completed = new Set(completedPacketIds)
  const modules = packets.map((packet) => packet.module)
    .filter((module, index, all) => all.indexOf(module) === index)
  return modules.filter((module) => (
    packets.filter((packet) => packet.module === module).every((packet) => completed.has(packet.id))
  ))
}

type ReviewFindingIdentity = {
  module: string
  title: string
  location: string
  quote: string
}

function normalizeFindingIdentity(value: string) {
  return value.toLocaleLowerCase().replace(/[\s，。；、：:（）()【】“”'"《》]/g, '')
}

function findingIdentity(finding: ReviewFindingIdentity) {
  return [finding.module, finding.title, finding.location, finding.quote]
    .map((value) => normalizeFindingIdentity(value))
    .join('|')
}

export function mergeReviewFindings<T extends ReviewFindingIdentity>(existing: T[], incoming: T[]): T[] {
  const merged = [...existing]
  const identities = new Set(existing.map(findingIdentity))
  for (const finding of incoming) {
    const identity = findingIdentity(finding)
    if (identities.has(identity)) continue
    identities.add(identity)
    merged.push(finding)
  }
  return merged
}

export function formatReviewProgress(progress: ReviewProgress) {
  return `正在生成 ${progress.current}/${progress.total}：${progress.moduleName}；已完成 ${progress.completed}/${progress.total}，累计 ${progress.generatedCards} 张卡片。`
}

export function buildReviewDiagnostic(input: {
  provider: string
  model: string
  error: string
  progress: ReviewProgress | null
  completedModules: ReviewModuleName[]
  completedPacketIds?: string[]
}) {
  const progress = input.progress
  return JSON.stringify({
    diagnosticVersion: 1,
    occurredAt: new Date().toISOString(),
    provider: input.provider,
    model: input.model,
    error: input.error,
    stage: progress ? {
      current: progress.current,
      total: progress.total,
      moduleName: progress.moduleName,
      completed: progress.completed,
      generatedCards: progress.generatedCards,
    } : null,
    completedModules: input.completedModules,
    completedPacketIds: input.completedPacketIds ?? [],
    privacy: '不包含API Key、专利正文、检索证据和对比文件内容',
  }, null, 2)
}
