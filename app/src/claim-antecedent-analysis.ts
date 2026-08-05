export type ClaimIssueKind = 'absolute-missing' | 'ambiguous' | 'quantity-mismatch' | 'preamble-only'

export type ClaimIssue = {
  id: string
  claimNumber: number
  term: string
  highlightText: string
  kind: ClaimIssueKind
  severity: '重要' | '一般' | '提示'
  conclusion: '缺乏引入' | '指代不清' | '多重引入' | '术语不一致' | '引用关系错误' | '范围跳变'
  message: string
  sources: Array<{ claimNumber: number; term: string; preamble: boolean }>
  paths: number[][]
}

export type ParsedClaim = {
  number: number
  text: string
  dependencies: number[]
}

export type ClaimAntecedentAnalysis = {
  claims: ParsedClaim[]
  issues: ClaimIssue[]
}

type TechnicalTerm = {
  term: string
  base: string
  quantity: 'single' | 'plural' | 'neutral'
  preamble: boolean
  claimTitle: boolean
  offset: number
  claimNumber?: number
}

const claimHeading = /^权\s*利\s*要\s*求\s*书$/
const claimBoundary = /^(?:说明书(?:摘要|附图)?|发明名称|技术领域|背景技术|具体实施方式|实施方式|附图说明)$/
const claimStart = /^\s*(\d{1,4})\s*[.．、]\s*(.+)$/
const referencePrefix = /(?:所述|上述|前述|该)\s*(?:的\s*)?/g
const introducingPrefix = /(?:一种|一个|一套|一台|一组|一对|一条|一件|一端|一部|一块|一根|一层|一片|一孔|一腔|一阀|一管|一路|一面|一体|一轴|至少一个|至少一|多个|若干|每个|两个|两)\s*/g
const ordinalPrefix = /^(?:第[一二三四五六七八九十百零〇\d]+|[一二三四五六七八九十\d]+)\s*/
const ignoredBases = new Set(['特征', '部分', '方式', '装置', '方法', '系统', '部件', '组件', '机构', '结构', '本体', '产品', '权利要求', '实施例'])
const technicalNounHeads = [
  '控制装置', '制冷设备', '循环管路', '阀芯组件', '流通间隙', '封堵面积', '横截面积', '最小间隙',
  '第一方向', '第二方向', '初始温度', '第一温度', '第二温度', '初始长度', '第一长度', '第二长度',
  '固定件', '调节阀', '波纹管', '弹性件', '导流孔', '出气孔', '阀座', '阀杆', '阀头', '流道',
  '氦气', '进口', '出口', '侧板', '顶板', '底板', '容纳腔', '导向孔', '抵接部', '抵接面', '导杆', '面积', '长度', '温度', '方向', '压力',
].sort((first, second) => second.length - first.length)

function compact(value: string) {
  return value.replace(/[\s\u00a0]/g, '').replace(/[，,；;。、:：()（）]/g, '')
}

function baseTerm(value: string) {
  return compact(value)
    .replace(/^(?:所述|上述|前述|该|其|的)+/, '')
    .replace(/^(?:多个|若干|至少一个|至少一|一个|一种|一套|一台|一组|一对|一条|一件|一端|一部|一块|一根|一层|一片|一孔|一腔|一阀|一管|一路|一面|一体|一轴)/, '')
    .replace(ordinalPrefix, '')
}

function quantity(value: string): TechnicalTerm['quantity'] {
  if (/(?:多个|若干|至少两|两个以上|两?个以上|数个|多组|多条|多件|多层|多片|两个|两)/.test(value)) return 'plural'
  if (/(?:一个|一种|一套|一台|一组|一对|一条|一件|一端|一部|一块|一根|一层|一片|一孔|一腔|一阀|一管|一路|一面|一体|一轴|至少一个|至少一)/.test(value)) return 'single'
  return 'neutral'
}

function isUsableBase(value: string) {
  return value.length >= 2 && value.length <= 18 && !ignoredBases.has(value)
}

function cutPhrase(value: string) {
  const boundary = value.search(/(?:[，,；;。、:：]|(?:包括|包含|具有|连接|设置|形成|配置|安装|位于|用于|以便|从而|并且|或者|以及|与|和|及|或|其中|的|被|为|能|可|均|会|并|且|向|朝|远离|大于|小于|至|由|受|处于))/)
  return (boundary >= 0 ? value.slice(0, boundary) : value).trim()
}

function extractIntroducedTerms(text: string) {
  const terms: TechnicalTerm[] = []
  const preambleEnd = (() => {
    const transition = text.search(/(?:包括|包含|具有|其特征在于|，|,|；|;|:|：)/)
    return transition < 0 ? Math.min(text.length, 36) : transition
  })()
  const add = (raw: string, offset: number, preamble: boolean, claimTitle = false) => {
    const term = cutPhrase(raw).replace(introducingPrefix, '')
    const base = baseTerm(term)
    if (!isUsableBase(base)) return
    const existing = terms.find((item) => item.base === base && item.offset === offset)
    if (existing) existing.claimTitle ||= claimTitle
    else terms.push({ term, base, quantity: quantity(raw), preamble, claimTitle, offset })
  }

  // The first noun phrase in an independent claim is often introduced as
  // “一种……装置”; retaining it lets the UI warn about preamble-only support.
  const opening = text.match(/^\s*一(?:种|个|套|台|组|对|条|件)?\s*([\u4e00-\u9fff]{2,30})/)
  if (opening?.[1]) add(opening[1], 0, true, true)

  const pattern = /(?:一种|一个|一套|一台|一组|一对|一条|一件|一端|一部|一块|一根|一层|一片|一孔|一腔|一阀|一管|一路|一面|一体|一轴|至少一个|至少一|多个|若干|每个|两个|两)\s*((?:第[一二三四五六七八九十百零〇\d]+)?[\u4e00-\u9fff]{1,30}?)(?=(?:和|与|及|或|、|，|,|；|;|。|\.|包括|包含|具有|连接|设置|形成|配置|安装|位于|用于|以便|从而|并且|其中|$))/g
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue
    add(match[0], match.index, match.index < preambleEnd)
  }
  const bareFeature = /(?:^|[\n；;：:])\s*((?:第[一二三四五六七八九十百零〇\d]+)?[\u4e00-\u9fff]{2,18})(?=[，,；;])/g
  for (const match of text.matchAll(bareFeature)) {
    if (match.index === undefined) continue
    add(match[1], match.index, match.index < preambleEnd)
  }
  const appliedFeature = /(?:应用于|供)\s*((?:第[一二三四五六七八九十百零〇\d]+)?[\u4e00-\u9fff]{2,18}?)(?=(?:循环|流动|，|,|；|;|。))/g
  for (const match of text.matchAll(appliedFeature)) {
    if (match.index === undefined) continue
    add(match[1], match.index, match.index < preambleEnd)
  }
  return terms
}

function findKnownBase(raw: string, known: TechnicalTerm[]) {
  const directRaw = compact(raw)
  const directCandidates = known.filter((term) => directRaw.startsWith(compact(term.term)))
  if (directCandidates.length) return { base: directCandidates[0].base, candidates: directCandidates, displayTerm: directCandidates[0].term, exactMatch: true }
  const compactRaw = baseTerm(raw)
  const candidates = known.filter((term) => compactRaw.startsWith(term.base))
  if (candidates.length) return { base: candidates[0].base, candidates, displayTerm: baseTerm(cutPhrase(raw)), exactMatch: false }
  const derived = technicalNounHeads.find((term) => compactRaw.startsWith(term)) ?? baseTerm(cutPhrase(raw))
  return { base: derived, candidates: [] as TechnicalTerm[], displayTerm: derived, exactMatch: false }
}

function ordinalOf(value: string) {
  return compact(value).match(ordinalPrefix)?.[0] ?? ''
}

function extractReferringTerms(text: string, known: TechnicalTerm[]) {
  const references: Array<{ term: string; base: string; quantity: TechnicalTerm['quantity']; offset: number; known: TechnicalTerm[]; exactMatch: boolean; ordinal: string }> = []
  for (const match of text.matchAll(referencePrefix)) {
    if (match.index === undefined) continue
    const raw = text.slice(match.index + match[0].length, match.index + match[0].length + 36)
    const found = findKnownBase(raw, known)
    if (!isUsableBase(found.base)) continue
    references.push({
      term: found.displayTerm,
      base: found.base,
      quantity: quantity(raw),
      offset: match.index,
      known: found.candidates,
      exactMatch: found.exactMatch,
      ordinal: ordinalOf(raw),
    })
  }
  return references
}

function parseDependencyNumbers(text: string) {
  const dependencyMatch = text.match(/(?:(?:根据|按照|依照)\s*)?权利要求\s*([^，。；;]*?)\s*(?:所述|所示)/)
  if (!dependencyMatch) return []
  const expression = dependencyMatch[1]
  const numbers: number[] = []
  const rangePattern = /(\d{1,4})\s*(?:至|到|[-—–~～])\s*(\d{1,4})/g
  const covered = new Set<number>()
  for (const range of expression.matchAll(rangePattern)) {
    const start = Number(range[1])
    const end = Number(range[2])
    if (start && end && Math.abs(end - start) <= 40) {
      for (let value = Math.min(start, end); value <= Math.max(start, end); value += 1) {
        numbers.push(value)
        covered.add(value)
      }
    }
  }
  for (const match of expression.matchAll(/\d{1,4}/g)) {
    const value = Number(match[0])
    if (value && !covered.has(value)) numbers.push(value)
  }
  return [...new Set(numbers)]
}

export function parseClaims(text: string): ParsedClaim[] {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean)
  const headingIndex = lines.findIndex((line) => claimHeading.test(compact(line)))
  const candidateLines = headingIndex >= 0 ? lines.slice(headingIndex + 1) : lines
  // DOCX headers are prepended to the text for section detection. Their
  // “说明书/说明书附图” labels may follow “权利要求书” before any actual claim.
  // A section boundary only becomes meaningful after the first numbered claim.
  const claimLines: string[] = []
  let sawClaimStart = false
  for (const line of candidateLines) {
    if (claimStart.test(line)) sawClaimStart = true
    if (claimBoundary.test(compact(line))) {
      if (sawClaimStart) break
      continue
    }
    claimLines.push(line)
  }
  const claims: ParsedClaim[] = []
  let current: { number: number; fragments: string[] } | null = null
  const flush = () => {
    if (!current) return
    const claimText = current.fragments.join('\n').replace(/[ \t]+/g, ' ').trim()
    if (claimText) claims.push({ number: current.number, text: claimText, dependencies: parseDependencyNumbers(claimText) })
    current = null
  }
  for (const line of claimLines) {
    const descriptionStart = line.search(/(?:^|\s)(?:技术领域|背景技术|发明内容|实用新型内容|附图说明|具体实施方式|实施方式)(?:\s|$)/)
    if (descriptionStart >= 0) {
      if (current && line.slice(0, descriptionStart).trim()) current.fragments.push(line.slice(0, descriptionStart))
      flush()
      break
    }
    const start = line.match(claimStart)
    if (start) {
      flush()
      current = { number: Number(start[1]), fragments: [start[2]] }
    } else if (current) {
      current.fragments.push(line)
    }
  }
  flush()
  return claims
}

function inferredBareSource(claim: ParsedClaim, base: string, beforeOffset = Number.MAX_SAFE_INTEGER): TechnicalTerm | null {
  const sourceText = claim.text.slice(0, beforeOffset)
  let offset = sourceText.indexOf(base)
  while (offset >= 0) {
    const prefix = sourceText.slice(Math.max(0, offset - 3), offset)
    if (!/(?:所述|上述|前述|该)$/.test(prefix)) {
      const preambleEnd = sourceText.search(/(?:包括|包含|具有|其特征在于|，|,|；|;|:|：)/)
      return { term: base, base, quantity: 'neutral', preamble: preambleEnd >= 0 && offset < preambleEnd, claimTitle: false, offset, claimNumber: claim.number }
    }
    offset = sourceText.indexOf(base, offset + base.length)
  }
  return null
}

function dependencyPaths(claimNumber: number, byNumber: Map<number, ParsedClaim>, trail: number[] = []): number[][] {
  if (trail.includes(claimNumber)) return []
  const claim = byNumber.get(claimNumber)
  if (!claim) return [[]]
  if (!claim.dependencies.length) return [[claim.number]]
  const paths = claim.dependencies.flatMap((dependency) => dependencyPaths(dependency, byNumber, [...trail, claimNumber]))
  return paths.length ? paths.map((path) => [...path, claim.number]) : [[claim.number]]
}

function issueMeta(kind: ClaimIssueKind, term: string, claimNumber: number) {
  switch (kind) {
    case 'absolute-missing':
      return { severity: '重要' as const, conclusion: '缺乏引入' as const, message: `权利要求 ${claimNumber} 中“所述${term}”未找到可继承的首次引入，可能缺乏引用基础。` }
    case 'ambiguous':
      return { severity: '一般' as const, conclusion: '多重引入' as const, message: `权利要求 ${claimNumber} 中“所述${term}”对应多个前驱对象，指代不够明确。` }
    case 'quantity-mismatch':
      return { severity: '一般' as const, conclusion: '术语不一致' as const, message: `权利要求 ${claimNumber} 中“所述${term}”与首次引入的数量表述不一致。` }
    case 'preamble-only':
      return { severity: '提示' as const, conclusion: '范围跳变' as const, message: `权利要求 ${claimNumber} 中“所述${term}”仅能追溯到前序部分，建议确认不会不当限缩保护范围。` }
  }
}

export function analyzeClaimAntecedentBasis(text: string): ClaimAntecedentAnalysis {
  const claims = parseClaims(text)
  const byNumber = new Map(claims.map((claim) => [claim.number, claim]))
  const introducedByClaim = new Map(claims.map((claim) => [claim.number, extractIntroducedTerms(claim.text)]))
  const issues: ClaimIssue[] = []
  const seen = new Set<string>()

  for (const claim of claims) {
    const paths = dependencyPaths(claim.number, byNumber)
    const availableTerms = paths.flatMap((path) => path.flatMap((number) => introducedByClaim.get(number) ?? []))
    const referring = extractReferringTerms(claim.text, availableTerms)
    for (const reference of referring) {
      const sourcesForPath = paths.map((path) => {
        const explicit = path
        .flatMap((number) => (introducedByClaim.get(number) ?? []).map((term) => ({ ...term, claimNumber: number })))
        .filter((term) => term.base === reference.base
          && (!reference.exactMatch || reference.known.some((candidate) => candidate.term === term.term))
          && (!reference.ordinal || ordinalOf(term.term) === reference.ordinal)
          && (term.claimNumber !== claim.number || term.offset < reference.offset))
        if (explicit.length) return explicit
        return path.flatMap((number) => {
          const sourceClaim = byNumber.get(number)
          if (!sourceClaim) return []
          const inferred = inferredBareSource(sourceClaim, reference.base, number === claim.number ? reference.offset : undefined)
          return inferred ? [inferred] : []
        })
      })
      const allSources = sourcesForPath.flat()
      let kind: ClaimIssueKind | null = null
      if (!sourcesForPath.length || sourcesForPath.some((sources) => sources.length === 0)) kind = 'absolute-missing'
      else {
        const distinctTerms = new Set(allSources.map((source) => source.term))
        if (distinctTerms.size > 1 && allSources.every((source) => ordinalPrefix.test(source.term))) kind = 'ambiguous'
        else if (reference.quantity === 'plural' && allSources.every((source) => source.quantity === 'single')) kind = 'quantity-mismatch'
        // A dependent claim may legitimately refer back to the name introduced
        // in its parent claim's preamble. Warn only when the current claim
        // itself introduces the term solely in its own preamble and later
        // relies on that wording in the limitation body.
        else if (allSources.every((source) => source.preamble) && allSources.some((source) => source.claimNumber === claim.number) && !allSources.some((source) => source.claimTitle)) kind = 'preamble-only'
      }
      if (!kind) continue
      const key = `${claim.number}:${kind}:${reference.base}`
      if (seen.has(key)) continue
      seen.add(key)
      const meta = issueMeta(kind, reference.term, claim.number)
      issues.push({
        id: key,
        claimNumber: claim.number,
        term: reference.base,
        highlightText: reference.term,
        kind,
        severity: meta.severity,
        conclusion: meta.conclusion,
        message: meta.message,
        sources: allSources.map((source) => ({ claimNumber: source.claimNumber ?? claim.number, term: source.term, preamble: source.preamble })),
        paths,
      })
    }
  }
  return { claims, issues }
}
