export type PriorArtSourceDocument = {
  name: string
  text: string
}

export type PriorArtCandidate = {
  id: string
  sourceType: 'uploaded' | 'network'
  name: string
  publicationNumber: string
  publicationDate: string
  coveragePercent: number
  matchedFeatures: string[]
  missingFeatures: string[]
  reason: string
}

export type PriorArtSourceMode = 'unavailable' | 'uploaded-only' | 'network-only' | 'uploaded-and-network'

export function resolvePriorArtSourceMode(uploadedDocumentCount: number, networkEnabled: boolean): PriorArtSourceMode {
  if (uploadedDocumentCount > 0 && networkEnabled) return 'uploaded-and-network'
  if (uploadedDocumentCount > 0) return 'uploaded-only'
  if (networkEnabled) return 'network-only'
  return 'unavailable'
}

export function buildPriorArtCandidateMessages(
  claimsText: string,
  comparisonDocuments: PriorArtSourceDocument[],
  searchEvidence: string,
) {
  const uploaded = comparisonDocuments.map((document) => ({
    name: document.name,
    text: document.text.slice(0, 45_000),
  }))
  return {
    system: `你是专利检索结果整理助手。请比较申请权利要求与用户上传文件、联网检索候选文献，列出最适合作为“最接近现有技术”的候选项。
要求：
1. 用户上传文件和联网候选文献必须放在同一候选池中比较，不得遗漏；
2. coveragePercent表示对申请独立权利要求核心技术特征的估算覆盖率，范围0至100；
3. 优先考虑技术领域、技术问题、用途、结构和技术效果的接近程度，不得只按关键词数量排序；
4. 不得虚构文献号、名称、公开日或技术内容；无法确认的字段留空；
5. 最多返回8项，按推荐程度由高到低排序；
6. 只输出合法JSON，不要使用Markdown。`,
    user: JSON.stringify({
      claimsText: claimsText.slice(0, 20_000),
      uploadedDocuments: uploaded,
      networkSearchEvidence: searchEvidence || '未启用联网检索',
      outputSchema: {
        candidates: [{
          sourceType: 'uploaded|network',
          name: '文件名或文献标题',
          publicationNumber: '公开号；用户上传文件无法确认时留空',
          publicationDate: 'YYYY-MM-DD；无法确认时留空',
          coveragePercent: 0,
          matchedFeatures: ['已覆盖的核心特征'],
          missingFeatures: ['未覆盖或尚未确认的核心特征'],
          reason: '适合作为最接近现有技术的理由及待核验事项',
        }],
      },
    }),
  }
}

export function parsePriorArtCandidates(content: string): PriorArtCandidate[] {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(cleaned) as { candidates?: Array<Partial<PriorArtCandidate>> }
  const seen = new Set<string>()
  return (parsed.candidates ?? []).flatMap((candidate, index) => {
    if (!candidate.name?.trim()) return []
    const sourceType: PriorArtCandidate['sourceType'] = candidate.sourceType === 'network' ? 'network' : 'uploaded'
    const publicationNumber = candidate.publicationNumber?.trim() || ''
    const identity = `${sourceType}:${publicationNumber || candidate.name.trim()}`.toLowerCase()
    if (seen.has(identity)) return []
    seen.add(identity)
    return [{
      id: `prior-art-${index}-${identity.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').slice(0, 48)}`,
      sourceType,
      name: candidate.name.trim(),
      publicationNumber,
      publicationDate: candidate.publicationDate?.trim() || '',
      coveragePercent: Math.max(0, Math.min(100, Math.round(Number(candidate.coveragePercent) || 0))),
      matchedFeatures: Array.isArray(candidate.matchedFeatures)
        ? candidate.matchedFeatures.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()).slice(0, 12)
        : [],
      missingFeatures: Array.isArray(candidate.missingFeatures)
        ? candidate.missingFeatures.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()).slice(0, 12)
        : [],
      reason: candidate.reason?.trim() || '请人工复核该文献与申请主文本的接近程度。',
    }]
  }).sort((left, right) => right.coveragePercent - left.coveragePercent).slice(0, 8)
}
