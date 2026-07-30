import rawRulebook from './data/patent-review-rulebook.json?raw'

export type RulebookSource = {
  id: string
  title: string
  issuer: string
  sourceType: string
  effectiveDate: string
  url: string
  accessedAt: string
}

export type ReviewRule = {
  id: string
  category: string
  title: string
  applicableTo: string[]
  severityDefault: string
  reviewQuestion: string
  ruleSummary: string
  triggerPatterns: string[]
  reviewMethod: string[]
  riskExplanation: string
  recommendedActions: string[]
  evidenceRequirements: string[]
  sources: string[]
  confidence: string
  notes: string
}

type Rulebook = {
  metadata: {
    title: string
    version: string
    lastVerifiedAt: string
    disclaimer: string
  }
  sources: RulebookSource[]
  rules: ReviewRule[]
}

export const reviewRulebook = JSON.parse(rawRulebook) as Rulebook

const categoriesByModule = {
  technical: [],
  legal: ['清楚性', '支持性', '充分公开', '修改超范围', '形式缺陷', '单一性', '实用性'],
  priorArt: ['新颖性', '创造性', '对比文件比对'],
  enforcement: ['权利要求解释', '侵权维权', '无效稳定性'],
} as const

export type ReviewModuleKey = keyof typeof categoriesByModule

function severityRank(value: string) {
  return value === '高' ? 3 : value === '中' ? 2 : 1
}

function textMatchScore(rule: ReviewRule, text: string) {
  const compact = text.replace(/\s+/g, '')
  const patternHits = rule.triggerPatterns.reduce((score, pattern) => {
    const pieces = pattern.split(/[，。；、\s]+/).filter((piece) => piece.length >= 2)
    return score + Math.min(3, pieces.filter((piece) => compact.includes(piece)).length)
  }, 0)
  return patternHits * 4 + severityRank(rule.severityDefault)
}

export function selectRulesForModules(
  modules: ReviewModuleKey[],
  patentText: string,
  limit = 36,
) {
  const categories = new Set(modules.flatMap((module) => [...categoriesByModule[module]]))
  return reviewRulebook.rules
    .filter((rule) => categories.has(rule.category as never))
    .map((rule) => ({ rule, score: textMatchScore(rule, patentText) }))
    .sort((first, second) => second.score - first.score || first.rule.id.localeCompare(second.rule.id))
    .slice(0, limit)
    .map(({ rule }) => rule)
}

export function sourceForRule(sourceId: string) {
  return reviewRulebook.sources.find((source) => source.id === sourceId)
}
