import mammoth from 'mammoth'
import JSZip from 'jszip'

export type SectionKey = 'abstract' | 'claims' | 'description' | 'drawings'

export type PatentSection = {
  key: SectionKey
  label: string
  start: number | null
  confidence: '高' | '待确认'
}

export type ParsedDocument = {
  html: string
  plainText: string
  markers: string[]
  pageCount: number
}

export type ReferenceCandidate = {
  id: string
  name: string
  number: string
  mentions: number
  confidence: '高' | '中'
  fromLegend?: boolean
}

const sectionDefinitions: Array<{ key: SectionKey; label: string; patterns: RegExp[] }> = [
  { key: 'abstract', label: '说明书摘要', patterns: [/^说明书摘要$/, /^摘要$/] },
  { key: 'claims', label: '权利要求书', patterns: [/^权\s*利\s*要\s*求\s*书$/] },
  { key: 'description', label: '说明书', patterns: [/^说\s*明\s*书$/, /^发明名称$/] },
  { key: 'drawings', label: '说明书附图', patterns: [/^说明书附图$/, /^附图说明$/] },
]

function normaliseLine(line: string) {
  return line.replace(/\u00a0/g, ' ').replace(/[：:]/g, '').trim()
}

function matchesDefinition(line: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(line))
}

export function detectSections(text: string, markers: string[] = []): PatentSection[] {
  const lines = text.split(/\n+/).map(normaliseLine).filter(Boolean)
  // Preserve empty page markers for PDF files so the marker index remains the
  // actual one-based page number. DOCX header lists contain no empty entries.
  const normalisedMarkers = markers.map(normaliseLine)

  return sectionDefinitions.map((definition) => {
    const headerIndex = normalisedMarkers.findIndex((marker) => matchesDefinition(marker, definition.patterns))
    const textIndex = lines.findIndex((line) => matchesDefinition(line, definition.patterns))
    const start = headerIndex >= 0 ? headerIndex + 1 : textIndex >= 0 ? textIndex + 1 : null
    return {
      key: definition.key,
      label: definition.label,
      start,
      confidence: start !== null ? '高' : '待确认',
    }
  })
}

function normaliseReferenceName(rawName: string) {
  let name = rawName.replace(/^(?:(?:所述|该|本|上述|其中|包括|以及|及|和|与|如图|至图|根据|相对|为|在|由|一种|一个))+/, '')
  const afterPossessive = name.split('的').at(-1)
  if (afterPossessive && afterPossessive.length >= 2) name = afterPossessive
  // Ordinal qualifiers are part of the feature name. Removing them merges
  // distinct patent features such as “第一凹槽12” and “第二凹槽13”.
  return name.slice(-12)
}

const legendHeadingPattern = /^(?:附图标记(?:说明)?|附图编号说明|主要元件符号说明|图中标识|图中)\s*[：:]?/
const legendBoundaryPattern = /^(?:具体实施方式|具体实施例|实施方式|实施例(?:一|二|三|四|五|六|七|八|九|十|\d+)?|工业实用性|权利要求书|说明书摘要|说明书附图)/
const referenceTokenSource = '(?:[A-Za-z]?\\d{1,8}[A-Za-z]?|[A-Za-z])'

function stripPatentParagraphNumber(line: string) {
  return line.replace(/^\s*\[\d{3,6}\]\s*/, '').trim()
}

function extractLegendText(text: string) {
  const sections: string[] = []
  let active = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripPatentParagraphNumber(rawLine)
    if (!line) continue
    const heading = line.match(legendHeadingPattern)
    if (heading?.index !== undefined) {
      active = true
      const trailing = line.slice(heading.index + heading[0].length).trim()
      if (trailing) sections.push(trailing)
      continue
    }
    if (active && legendBoundaryPattern.test(line)) {
      active = false
      continue
    }
    if (active) sections.push(line)
  }
  return sections.join('\n')
}

function cleanLegendName(rawName: string) {
  return rawName
    .trim()
    .replace(/^[、，,；;。:：\-—]+|[、，,；;。:：\-—]+$/g, '')
    .replace(/^(?:所述|该|本|上述)+/, '')
    .slice(0, 30)
}

export function extractLegendReferenceCandidates(text: string): ReferenceCandidate[] {
  const legendText = extractLegendText(text)
  if (!legendText) return []
  const candidates = new Map<string, ReferenceCandidate>()
  const add = (rawName: string, rawNumber: string) => {
    const name = cleanLegendName(rawName)
    const number = rawNumber.trim()
    if (!name || number === '0' || /^\[?\d{3,6}\]?$/.test(number) && rawNumber.startsWith('[')) return
    const id = `${name}${number}`
    const current = candidates.get(id)
    if (current) current.mentions += 1
    else candidates.set(id, { id, name, number, mentions: 1, confidence: '高', fromLegend: true })
  }

  const numberFirst = new RegExp(`^\\s*(${referenceTokenSource})\\s*[、:：\\-—]\\s*(.{1,40})$`)
  const nameFirst = new RegExp(`(?:^|、)\\s*([\\u4e00-\\u9fffA-Za-z·（）()]{1,30}?)\\s*(${referenceTokenSource})(?=\\s*(?:、|$))`, 'g')
  for (const segment of legendText.split(/[；;,，。\n]+/).map((item) => item.trim()).filter(Boolean)) {
    const leadingNumber = segment.match(numberFirst)
    if (leadingNumber) {
      add(leadingNumber[2], leadingNumber[1])
      continue
    }
    // Some agencies write the feature before its reference sign, for example
    // “接驳设备100；第一设备200” or “龙门架100、龙门支柱101”.
    for (const match of segment.matchAll(nameFirst)) add(match[1], match[2])
  }

  return [...candidates.values()].sort((first, second) => (
    first.number.localeCompare(second.number, 'zh-CN', { numeric: true })
    || first.name.localeCompare(second.name, 'zh-CN')
  ))
}

export function extractReferenceCandidates(text: string): ReferenceCandidate[] {
  const legendCandidates = extractLegendReferenceCandidates(text)
  if (legendCandidates.length > 0) return legendCandidates

  const candidates = new Map<string, ReferenceCandidate>()
  // PDF text layers often split a feature name and its numeral into adjacent
  // text items with a visual-space separator (for example “反应炉 110”).
  const pattern = /([\u4e00-\u9fff]{2,24})\s*([A-Za-z]?\d{1,8}[A-Za-z]?)(?![\dA-Za-z])(?!\s*(?:毫米|厘米|米|千米|摄氏度|度|秒|分钟|小时|天|年|月|日|个|行|列|次|页|项|℃|％|%|K|Pa|MPa|mm|cm|m))/g
  const excluded = /^(?:权利要求|图|实施例|温度|压力|长度|面积|浓度|数量|时间|比例|百分比|大于|小于|等于|尺寸|范围|方向|页码|编号)/

  const addCandidate = (rawName: string, number: string) => {
    const name = normaliseReferenceName(rawName)
    if (
      number === '0'
      || name.length < 2
      || excluded.test(name)
      || /(?:图|米|米或者|围为)$/.test(name)
    ) return
    const id = `${name}${number}`
    const current = candidates.get(id)
    if (current) {
      current.mentions += 1
    } else {
      candidates.set(id, { id, name, number, mentions: 1, confidence: '中' })
    }
  }

  for (const match of text.matchAll(pattern)) {
    addCandidate(match[1], match[2])
  }

  return [...candidates.values()]
    .map((candidate): ReferenceCandidate => ({
      ...candidate,
      confidence: candidate.mentions >= 2 ? '高' : '中',
    }))
    .sort((first, second) => second.mentions - first.mentions || first.number.localeCompare(second.number, 'zh-CN', { numeric: true }))
}

function headerOrder(path: string) {
  return Number(path.match(/header(\d+)\.xml$/i)?.[1] ?? Number.MAX_SAFE_INTEGER)
}

function wordXmlText(xml: string) {
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  return Array.from(document.getElementsByTagNameNS(namespace, 'p'))
    .map((paragraph) => Array.from(paragraph.getElementsByTagNameNS(namespace, 't'))
      .map((node) => node.textContent ?? '')
      .join(''))
    .filter(Boolean)
    .join('\n')
}

export async function parseDocx(arrayBuffer: ArrayBuffer): Promise<ParsedDocument> {
  const [result, zip] = await Promise.all([
    mammoth.convertToHtml({ arrayBuffer }),
    JSZip.loadAsync(arrayBuffer),
  ])
  const documentXml = await zip.file('word/document.xml')?.async('text')
  const plainText = documentXml
    ? wordXmlText(documentXml)
    : new DOMParser().parseFromString(result.value, 'text/html').body.textContent ?? ''
  const headerPaths = Object.keys(zip.files)
    .filter((filePath) => /^word\/header\d+\.xml$/i.test(filePath))
    .sort((first, second) => headerOrder(first) - headerOrder(second))
  const headerTexts = await Promise.all(headerPaths.map(async (filePath) => {
    const xml = await zip.file(filePath)?.async('text')
    if (!xml) return ''
    return wordXmlText(xml)
  }))
  const markers = headerTexts.map(normaliseLine).filter(Boolean)
  return {
    html: result.value,
    plainText: `${markers.join('\n')}\n${plainText}`.trim(),
    markers,
    pageCount: 0,
  }
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

export function base64ToBlob(base64: string, type: string) {
  return new Blob([base64ToArrayBuffer(base64)], { type })
}
