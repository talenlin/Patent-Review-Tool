import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, BookOpenText, Check, ChevronDown, ChevronRight, ChevronUp, Download, FileText, FolderOpen,
  Cloud, Highlighter, Image, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Plus, QrCode, RefreshCw, Save, Settings2, ShieldCheck, Sparkles, Tag, Trash2, Undo2, X,
} from 'lucide-react'
import './App.css'
import authorQrCodeUrl from './assets/author-qrcode.png?inline'
import brandLogoUrl from './assets/patent-reader-logo.png'
import { recognizeCloudFigureLabels } from './cloud-ocr'
import { recognizeFigureLabels } from './figure-ocr'
import {
  activeOcrSettings, ocrProviderApiLinks, ocrProviderLabels,
  parseStoredOcrSettings, updateOcrProfile, type OcrProvider, type OcrSettingsStore,
} from './ocr-settings'
import type { FigureLabel } from './figure-ocr'
import { bindFigureLabelInteractions, suppressOverlappingSubnumberLabels, uniqueFigureLabels } from './figure-labels'
import {
  base64ToArrayBuffer, detectSections, extractReferenceCandidates, parseDocx,
  type PatentSection, type ReferenceCandidate, type SectionKey,
} from './document-analysis'
import { parsePdf, type PdfPageData } from './pdf-analysis'
import { findDocxSectionTarget, scrollTargetWithin } from './section-navigation'
import { cycleReferenceOccurrence } from './reference-navigation'
import { analyzeClaimAntecedentBasis, type ClaimIssue } from './claim-antecedent-analysis'
import LlmReviewDialog from '@llm-review-dialog'
import { type LlmRunMetadata } from './LlmReviewDialog'
import { type LlmReviewFinding } from './llm-review'
import { reviewRulebook } from './review-rulebook'

// V1 builds turn this flag off at compile time so the LLM review entry points
// and saved LLM review artifacts are unavailable in the local-only edition.
const LLM_REVIEW_ENABLED = import.meta.env.VITE_ENABLE_LLM_REVIEW !== 'false'

type LoadedFile = {
  path: string
  name: string
  extension: 'docx' | 'pdf'
  base64: string
  html: string
  text: string
  markers: string[]
  pageCount: number
  previewUrl: string | null
  pdfPages: PdfPageData[]
  sections: PatentSection[]
}

type Annotation = {
  id: number
  type: string
  severity: string
  status: string
  author: string
  body: string
  location: string
  selectedText: string | null
  selectionAnchor: PatentSelectionAnchor | null
}

type ReferenceGroup = {
  number: string
  options: ReferenceCandidate[]
}

type RatingGrade = '' | 'A' | 'B' | 'C' | 'D'

type PatentRatings = {
  technicalUnderstanding: RatingGrade
  communication: RatingGrade
  patentQuality: RatingGrade
}

type DocxSelectionHighlight = {
  left: number
  top: number
  width: number
  height: number
}

type CloudOcrUsage = {
  provider: OcrProvider
  imageCount: number
  wordCount: number
}

const emptyRatings: PatentRatings = {
  technicalUnderstanding: '',
  communication: '',
  patentQuality: '',
}

const sectionOrder: SectionKey[] = ['abstract', 'claims', 'description', 'drawings']

const sectionCopy: Record<SectionKey, string> = {
  abstract: '用于快速把握技术主题与核心方案。',
  claims: '用于审阅保护范围、从属关系和支持依据。',
  description: '用于核对技术特征、实施方式与图号名称。',
  drawings: '用于查看附图标号、结构关系和图面问题。',
}

function numberSort(first: string, second: string) {
  return first.localeCompare(second, 'zh-CN', { numeric: true })
}

type UpdateCheck = {
  currentVersion: string
  latestVersion: string | null
  releaseUrl: string | null
  releaseName: string | null
  publishedAt: string | null
  updateAvailable: boolean
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function groupReferences(references: ReferenceCandidate[]): ReferenceGroup[] {
  const byNumber = new Map<string, ReferenceCandidate[]>()
  references.forEach((reference) => {
    if (reference.number === '0') return
    const options = byNumber.get(reference.number) ?? []
    const existing = options.find((option) => option.name === reference.name)
    if (existing) existing.mentions += reference.mentions
    else options.push({ ...reference })
    byNumber.set(reference.number, options)
  })
  return [...byNumber.entries()]
    .map(([number, options]) => ({
      number,
      // Keep the confirmation list compact without dropping an entire
      // reference number just because other numbers have more mentions.
      options: options
        .sort((first, second) => (
          Number(Boolean(second.fromLegend)) - Number(Boolean(first.fromLegend))
          || second.mentions - first.mentions
          || first.name.length - second.name.length
        ))
        .slice(0, 6),
    }))
    .sort((first, second) => numberSort(first.number, second.number))
}

function firstSelections(groups: ReferenceGroup[]) {
  return Object.fromEntries(groups.map((group) => [group.number, group.options[0]?.id ?? '']))
}

function waitForImages(images: HTMLImageElement[]) {
  return Promise.all(images.map((image) => {
    if (image.complete && image.naturalWidth > 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true })
      image.addEventListener('error', () => resolve(), { once: true })
    })
  }))
}

function getStoredAnnotationAuthor() {
  return window.localStorage.getItem('patent-reader.annotation-author')?.trim() || '专利阅研'
}

function getStoredOcrSettings(): OcrSettingsStore {
  return parseStoredOcrSettings(window.localStorage.getItem('patent-reader.ocr-settings'))
}

function pdfSectionForPage(pageNumber: number, sections: PatentSection[]) {
  return sections
    .filter((section): section is PatentSection & { start: number } => section.start !== null && section.start <= pageNumber)
    .sort((first, second) => second.start - first.start)[0]?.key ?? null
}

function blocksForClaim(root: HTMLElement, claimNumber: number) {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('p, h1, h2, h3, li'))
  const startPattern = new RegExp(`^\\s*${claimNumber}\\s*[.．、]`)
  const anyClaimPattern = /^\s*\d{1,4}\s*[.．、]/
  const startIndex = blocks.findIndex((block) => startPattern.test(block.textContent ?? ''))
  if (startIndex < 0) return []
  const collected: HTMLElement[] = []
  for (let index = startIndex; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (index > startIndex && anyClaimPattern.test(block.textContent ?? '')) break
    collected.push(block)
  }
  return collected
}

function claimIssueSeverityRank(severity: ClaimIssue['severity']) {
  return severity === '重要' ? 0 : severity === '一般' ? 1 : 2
}

function compactQuote(value: string) {
  return value.replace(/\s+/g, '')
}

function pdfAnchorForQuote(pages: PdfPageData[], quote: string): PatentSelectionAnchor | null {
  const target = compactQuote(quote)
  if (!target) return null
  for (const page of pages) {
    let cursor = 0
    const spans = page.textItems.map((item) => {
      const text = compactQuote(item.text)
      const span = { item, start: cursor, end: cursor + text.length }
      cursor += text.length
      return span
    })
    const pageText = spans.map(({ item }) => compactQuote(item.text)).join('')
    const start = pageText.indexOf(target)
    if (start < 0) continue
    const end = start + target.length
    const rects = spans
      .filter((span) => span.end > start && span.start < end)
      .map(({ item }) => ({
        pageNumber: page.pageNumber,
        left: item.left / page.width,
        top: item.top / page.height,
        width: item.width / page.width,
        height: item.height / page.height,
      }))
    if (rects.length) {
      return {
        startParagraphText: '',
        startOffset: 0,
        endParagraphText: '',
        endOffset: 0,
        pdfRects: rects,
      }
    }
  }
  return null
}

function App() {
  const [file, setFile] = useState<LoadedFile | null>(null)
  const [stage, setStage] = useState<'welcome' | 'structure' | 'workspace'>('welcome')
  const [sections, setSections] = useState<PatentSection[]>([])
  const [activeSection, setActiveSection] = useState<SectionKey>('description')
  const [isSectionNavCollapsed, setIsSectionNavCollapsed] = useState(false)
  const [mode, setMode] = useState<'reading' | 'review'>('reading')
  const [annotation, setAnnotation] = useState({ type: '图文不一致', severity: '一般', status: '待处理', body: '' })
  const [annotationAuthor, setAnnotationAuthor] = useState(getStoredAnnotationAuthor)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [selectedText, setSelectedText] = useState<string | null>(null)
  const [selectionAnchor, setSelectionAnchor] = useState<PatentSelectionAnchor | null>(null)
  const [docxSelectionHighlights, setDocxSelectionHighlights] = useState<DocxSelectionHighlight[]>([])
  const [references, setReferences] = useState<ReferenceCandidate[]>([])
  const [removedNumbers, setRemovedNumbers] = useState<string[]>([])
  const [isCustomReferenceOpen, setIsCustomReferenceOpen] = useState(false)
  const [customReference, setCustomReference] = useState({ number: '', name: '' })
  const [mappingSelections, setMappingSelections] = useState<Record<string, string>>({})
  const [confirmedMappings, setConfirmedMappings] = useState<Record<string, string>>({})
  const [mappingConfirmed, setMappingConfirmed] = useState(false)
  const [activeReference, setActiveReference] = useState<string | null>(null)
  const [activeReferenceOccurrence, setActiveReferenceOccurrence] = useState(0)
  const [referenceOccurrenceCount, setReferenceOccurrenceCount] = useState(0)
  const [figureStatus, setFigureStatus] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle')
  const [figureProgress, setFigureProgress] = useState({ finished: 0, total: 0 })
  const [figureLabels, setFigureLabels] = useState<FigureLabel[]>([])
  const [figureError, setFigureError] = useState('')
  const [ocrSettingsStore, setOcrSettingsStore] = useState<OcrSettingsStore>(getStoredOcrSettings)
  const [ocrDraft, setOcrDraft] = useState<OcrSettingsStore>(getStoredOcrSettings)
  const [rememberOcrSettings, setRememberOcrSettings] = useState(true)
  const [isOcrSettingsOpen, setIsOcrSettingsOpen] = useState(false)
  const [paddlePluginStatus, setPaddlePluginStatus] = useState<PatentOcrPluginStatus | null>(null)
  const [isInstallingPaddlePlugin, setIsInstallingPaddlePlugin] = useState(false)
  const [cloudOcrUsage, setCloudOcrUsage] = useState<CloudOcrUsage | null>(null)
  const [isAssociationCollapsed, setIsAssociationCollapsed] = useState(false)
  const [isClaimBasisCollapsed, setIsClaimBasisCollapsed] = useState(false)
  const [isClaimBasisShowAll, setIsClaimBasisShowAll] = useState(false)
  const [isClaimBasisLowRiskOpen, setIsClaimBasisLowRiskOpen] = useState(false)
  const [isClaimBasisPassedOpen, setIsClaimBasisPassedOpen] = useState(false)
  const [expandedClaimIssueIds, setExpandedClaimIssueIds] = useState<Set<string>>(() => new Set())
  const [activeClaimIssueId, setActiveClaimIssueId] = useState<string | null>(null)
  const [activeClaimIssueOccurrence, setActiveClaimIssueOccurrence] = useState(0)
  const [claimIssueOccurrenceCount, setClaimIssueOccurrenceCount] = useState(0)
  const [ratings, setRatings] = useState<PatentRatings>(emptyRatings)
  const [isLlmReviewOpen, setIsLlmReviewOpen] = useState(false)
  const [isAuthorQrOpen, setIsAuthorQrOpen] = useState(false)
  const [llmFindings, setLlmFindings] = useState<LlmReviewFinding[]>([])
  const [llmRunMetadata, setLlmRunMetadata] = useState<LlmRunMetadata | null>(null)
  const [expandedFigure, setExpandedFigure] = useState<{ source: string; index: number } | null>(null)
  const [expandedFigureScale, setExpandedFigureScale] = useState(1)
  const [notice, setNotice] = useState('')
  const [isOpening, setIsOpening] = useState(false)
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null)
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [isExitConfirmOpen, setIsExitConfirmOpen] = useState(false)
  const [isSavingBeforeExit, setIsSavingBeforeExit] = useState(false)
  const readingRef = useRef<HTMLElement>(null)
  const figuresRef = useRef<HTMLDivElement>(null)
  const labelPositionsRef = useRef<Record<string, { left: number; top: number }>>({})
  const dismissedFigureLabelsRef = useRef<Set<string>>(new Set())

  const detectedCount = useMemo(() => sections.filter((section) => section.start !== null).length, [sections])
  const ocrSettings = useMemo(() => activeOcrSettings(ocrSettingsStore), [ocrSettingsStore])
  const ocrDraftProfile = ocrDraft.profiles[ocrDraft.provider]
  const ocrDisplayName = ocrSettings.provider === 'custom' && ocrSettings.interfaceName.trim()
    ? ocrSettings.interfaceName.trim()
    : ocrProviderLabels[ocrSettings.provider]
  const referenceGroups = useMemo(
    () => groupReferences(references.filter((reference) => !removedNumbers.includes(reference.number))),
    [references, removedNumbers],
  )
  const selectedReferences = useMemo(() => {
    const selected = new Map<string, ReferenceCandidate>()
    referenceGroups.forEach((group) => {
      const id = (mappingConfirmed ? confirmedMappings : mappingSelections)[group.number]
      const candidate = group.options.find((option) => option.id === id) ?? group.options[0]
      if (candidate) selected.set(group.number, candidate)
    })
    return selected
  }, [confirmedMappings, mappingConfirmed, mappingSelections, referenceGroups])
  const claimBasisAnalysis = useMemo(() => analyzeClaimAntecedentBasis(file?.text ?? ''), [file])
  const claimBasisVisibleIssues = useMemo(
    () => claimBasisAnalysis.issues
      .filter((issue) => isClaimBasisShowAll || issue.severity !== '提示')
      .sort((first, second) => first.claimNumber - second.claimNumber || claimIssueSeverityRank(first.severity) - claimIssueSeverityRank(second.severity) || first.highlightText.localeCompare(second.highlightText, 'zh-CN')),
    [claimBasisAnalysis.issues, isClaimBasisShowAll],
  )
  const claimBasisIssueGroups = useMemo(() => {
    const byClaim = new Map<number, ClaimIssue[]>()
    claimBasisVisibleIssues.forEach((issue) => byClaim.set(issue.claimNumber, [...(byClaim.get(issue.claimNumber) ?? []), issue]))
    return [...byClaim.entries()].map(([claimNumber, issues]) => ({ claimNumber, issues }))
  }, [claimBasisVisibleIssues])
  const claimBasisLowRiskIssues = useMemo(() => claimBasisAnalysis.issues.filter((issue) => issue.severity === '提示'), [claimBasisAnalysis.issues])
  const claimBasisPassedClaims = useMemo(() => {
    const withRisk = new Set(claimBasisAnalysis.issues.map((issue) => issue.claimNumber))
    return claimBasisAnalysis.claims.filter((claim) => !withRisk.has(claim.number)).map((claim) => claim.number)
  }, [claimBasisAnalysis])
  const isDesktop = Boolean(window.patentReader)

  async function downloadUserGuide() {
    try {
      if (window.patentReader?.saveUserGuide) {
        const result = await window.patentReader.saveUserGuide()
        if (result.saved && result.path) setNotice(`使用指南已保存到：${result.path}`)
        return
      }
      const link = document.createElement('a')
      link.href = '/guides/专利阅研使用指南.html'
      link.download = '专利阅研使用指南.html'
      document.body.appendChild(link)
      link.click()
      link.remove()
      setNotice('使用指南已开始下载。')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `下载使用指南失败：${String(error)}`)
    }
  }

  async function checkForUpdate(showNotice = true) {
    if (!window.patentReader?.checkForUpdate) {
      if (showNotice) setNotice('当前程序暂不支持在线检查更新；请升级到新版 Windows 客户端。')
      return
    }
    setIsCheckingUpdate(true)
    try {
      const result = await window.patentReader.checkForUpdate()
      setUpdateCheck(result)
      if (result.updateAvailable) {
        setNotice(`发现新版本 ${result.latestVersion}，点击“更新”即可打开下载页面。`)
      } else if (showNotice) {
        setNotice('当前已是最新版本。')
      }
    } catch (error) {
      if (showNotice) setNotice(error instanceof Error ? error.message : `检查更新失败：${String(error)}`)
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  async function handleUpdateAction() {
    if (updateCheck?.updateAvailable && updateCheck.releaseUrl) {
      try {
        if (window.patentReader?.openExternalUrl) await window.patentReader.openExternalUrl(updateCheck.releaseUrl)
        else window.open(updateCheck.releaseUrl, '_blank', 'noopener,noreferrer')
        setNotice(`已在浏览器打开 ${updateCheck.latestVersion} 的下载页面。`)
      } catch (error) {
        setNotice(error instanceof Error ? error.message : `无法打开更新下载页：${String(error)}`)
      }
      return
    }
    await checkForUpdate(true)
  }

  useEffect(() => {
    void checkForUpdate(false)
  }, [])

  async function refreshPaddlePluginStatus() {
    if (!window.patentReader?.ocrPluginStatus) {
      setPaddlePluginStatus({
        installed: false,
        id: 'paddle-ocr-mobile',
        displayName: '本机 PaddleOCR 3（增强插件）',
        version: '',
        message: '当前程序不支持 OCR 插件管理；请使用新版 Windows 客户端。',
      })
      return
    }
    try {
      setPaddlePluginStatus(await window.patentReader.ocrPluginStatus())
    } catch (error) {
      setPaddlePluginStatus({
        installed: false,
        id: 'paddle-ocr-mobile',
        displayName: '本机 PaddleOCR 3（增强插件）',
        version: '',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function installPaddlePlugin() {
    if (!window.patentReader?.installPaddleOcrPlugin) {
      setNotice('当前程序不支持 OCR 插件安装；请使用新版 Windows 客户端。')
      return
    }
    setIsInstallingPaddlePlugin(true)
    try {
      const status = await window.patentReader.installPaddleOcrPlugin()
      setPaddlePluginStatus(status)
      setNotice(`已安装 ${status.displayName}${status.version ? ` ${status.version}` : ''}；可切换为本机 OCR。`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `安装 OCR 插件失败：${String(error)}`)
    } finally {
      setIsInstallingPaddlePlugin(false)
    }
  }

  function clearLockedSelection() {
    window.getSelection()?.removeAllRanges()
    setSelectedText(null)
    setSelectionAnchor(null)
    setDocxSelectionHighlights([])
  }

  // The figures are intentionally moved into their own pane after Mammoth has rendered the DOCX.
  useEffect(() => {
    if (!file || file.extension !== 'docx' || stage !== 'workspace' || !readingRef.current || !figuresRef.current) return
    const textRoot = readingRef.current
    const figureRoot = figuresRef.current
    figureRoot.replaceChildren()
    const images = Array.from(textRoot.querySelectorAll('img'))
    images.forEach((image, index) => {
      const figure = document.createElement('figure')
      figure.className = 'figure-wrapper'
      figure.dataset.figureIndex = String(index)
      image.setAttribute('data-figure-image', String(index))
      image.title = '双击打开附图详情，可放大查看'
      image.ondblclick = () => {
        setExpandedFigure({ source: image.currentSrc || image.src, index })
        setExpandedFigureScale(1)
      }
      figure.append(image)
      const caption = document.createElement('figcaption')
      caption.textContent = `附图 ${index + 1}`
      figure.append(caption)
      figureRoot.append(figure)
    })
  }, [file, stage])

  useEffect(() => {
    if (!expandedFigure) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpandedFigure(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [expandedFigure])

  useEffect(() => {
    if (!isOcrSettingsOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOcrSettingsOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isOcrSettingsOpen])

  useEffect(() => {
    if (!selectedText) return
    const clearOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearLockedSelection()
    }
    window.addEventListener('keydown', clearOnEscape)
    return () => window.removeEventListener('keydown', clearOnEscape)
  }, [selectedText])

  useEffect(() => {
    if (mappingConfirmed && figureStatus === 'done') setIsAssociationCollapsed(true)
  }, [figureStatus, mappingConfirmed])

  // Confirmed mappings are applied to the text as real visual highlights, not merely scrolled to.
  // Individual highlights stay in reading order so a figure label can browse each occurrence.
  useEffect(() => {
    const root = readingRef.current
    if (!root) return
    root.querySelectorAll<HTMLElement>('[data-reference-highlight]').forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent ?? '')))
    root.querySelectorAll<HTMLElement>('.reference-block-highlight').forEach((block) => block.classList.remove('reference-block-highlight'))
    root.querySelectorAll<HTMLElement>('.reference-page-highlight').forEach((page) => page.classList.remove('reference-page-highlight'))
    root.querySelectorAll<HTMLElement>('.reference-text-highlight').forEach((item) => item.classList.remove('reference-text-highlight'))
    if (!mappingConfirmed || !activeReference) {
      setReferenceOccurrenceCount(0)
      setActiveReferenceOccurrence(0)
      return
    }
    const reference = references.find((item) => item.id === activeReference)
    if (!reference) {
      setReferenceOccurrenceCount(0)
      return
    }

    if (file?.extension === 'pdf') {
      const compactId = reference.id.replace(/\s+/g, '')
      const matchingPages = file.pdfPages.filter((page) => page.text.replace(/\s+/g, '').includes(compactId))
      const fallbackPages = matchingPages.length ? matchingPages : file.pdfPages.filter((page) => page.text.includes(reference.name) && page.text.includes(reference.number))
      setReferenceOccurrenceCount(fallbackPages.length)
      const occurrence = Math.max(0, Math.min(activeReferenceOccurrence, fallbackPages.length - 1))
      if (occurrence !== activeReferenceOccurrence) setActiveReferenceOccurrence(occurrence)
      const matchingPage = fallbackPages[occurrence]
      const pageElement = matchingPage
        ? root.querySelector<HTMLElement>(`.pdf-page-shell[data-page-number="${matchingPage.pageNumber}"]`)
        : null
      if (pageElement) {
        pageElement.classList.add('reference-page-highlight')
        pageElement.querySelectorAll<HTMLElement>('.pdf-text-item').forEach((item) => {
          const itemText = item.textContent?.trim() ?? ''
          if (itemText.includes(reference.name) || itemText === reference.number) {
            item.classList.add('reference-text-highlight')
          }
        })
        const scroller = pageElement.closest<HTMLElement>('.text-reader')
        if (scroller) scrollTargetWithin(pageElement, scroller)
        else pageElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      return
    }

    const blocks = Array.from(root.querySelectorAll<HTMLElement>('p, h1, h2, h3, li'))
    const matchingBlocks = blocks.filter((block) => block.textContent?.includes(reference.name) && block.textContent.includes(reference.number))
    matchingBlocks.forEach((block) => block.classList.add('reference-block-highlight'))

    const expression = new RegExp(`${escapeRegExp(reference.name)}\\s*${escapeRegExp(reference.number)}(?![A-Za-z0-9])`, 'g')
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    let node = walker.nextNode()
    while (node) {
      if (node.textContent?.match(expression)) textNodes.push(node as Text)
      node = walker.nextNode()
    }
    const marks: HTMLElement[] = []
    textNodes.forEach((textNode) => {
      const matches = [...(textNode.textContent ?? '').matchAll(expression)]
      const nodeMarks: HTMLElement[] = []
      for (let index = matches.length - 1; index >= 0; index -= 1) {
        const match = matches[index]
        if (match.index === undefined) continue
        const range = document.createRange()
        range.setStart(textNode, match.index)
        range.setEnd(textNode, match.index + match[0].length)
        const mark = document.createElement('mark')
        mark.dataset.referenceHighlight = 'true'
        mark.className = 'reference-highlight'
        range.surroundContents(mark)
        // Ranges are wrapped from right to left so their offsets remain valid.
        // Keep a node-local list, then append it, to retain global document order.
        nodeMarks.unshift(mark)
      }
      marks.push(...nodeMarks)
    })

    const targets = marks.length ? marks : matchingBlocks
    setReferenceOccurrenceCount(targets.length)
    const occurrence = Math.max(0, Math.min(activeReferenceOccurrence, targets.length - 1))
    if (occurrence !== activeReferenceOccurrence) setActiveReferenceOccurrence(occurrence)
    const target = targets[occurrence]
    if (target) {
      const scroller = target.closest<HTMLElement>('.text-reader')
      if (scroller) scrollTargetWithin(target, scroller)
      else target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeReference, activeReferenceOccurrence, file, mappingConfirmed, references, stage])

  // Claim-basis findings are marked at term level so a single diagnostic does
  // not visually imply that the entire claim is defective.
  useEffect(() => {
    const root = readingRef.current
    if (!root) return
    root.querySelectorAll<HTMLElement>('[data-claim-issue-highlight]').forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent ?? '')))
    root.querySelectorAll<HTMLElement>('.claim-issue-text-highlight').forEach((item) => item.classList.remove('claim-issue-text-highlight'))
    if (!activeClaimIssueId) {
      setClaimIssueOccurrenceCount(0)
      return
    }
    const issue = claimBasisAnalysis.issues.find((item) => item.id === activeClaimIssueId)
    if (!issue) return
    const claimStartPattern = new RegExp(`^\\s*${issue.claimNumber}\\s*[.．、]`)
    if (file?.extension === 'pdf') {
      const page = file.pdfPages.find((candidate) => claimStartPattern.test(candidate.text))
      const pageElement = page ? root.querySelector<HTMLElement>(`.pdf-page-shell[data-page-number="${page.pageNumber}"]`) : null
      if (pageElement) {
        const targets = [...pageElement.querySelectorAll<HTMLElement>('.pdf-text-item')]
          .filter((item) => item.textContent?.includes(issue.highlightText))
        setClaimIssueOccurrenceCount(targets.length)
        const occurrence = Math.max(0, Math.min(activeClaimIssueOccurrence, Math.max(0, targets.length - 1)))
        if (occurrence !== activeClaimIssueOccurrence) setActiveClaimIssueOccurrence(occurrence)
        targets.forEach((item, index) => item.classList.toggle('claim-issue-text-highlight', index === occurrence))
        const target = targets[occurrence]
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        else pageElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      return
    }
    const blocks = blocksForClaim(root, issue.claimNumber)
    const marks: HTMLElement[] = []
    for (const block of blocks) {
      const blockMarks: HTMLElement[] = []
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      let node = walker.nextNode()
      while (node) {
        nodes.push(node as Text)
        node = walker.nextNode()
      }
      for (const textNode of nodes) {
        const text = textNode.textContent ?? ''
        const starts: number[] = []
        let start = text.indexOf(issue.highlightText)
        while (start >= 0) {
          starts.push(start)
          start = text.indexOf(issue.highlightText, start + issue.highlightText.length)
        }
        for (const matchStart of starts.reverse()) {
          const range = document.createRange()
          range.setStart(textNode, matchStart)
          range.setEnd(textNode, matchStart + issue.highlightText.length)
          const mark = document.createElement('mark')
          mark.dataset.claimIssueHighlight = 'true'
          mark.className = 'claim-issue-inline-highlight'
          range.surroundContents(mark)
          blockMarks.unshift(mark)
        }
      }
      marks.push(...blockMarks)
    }
    setClaimIssueOccurrenceCount(marks.length)
    const occurrence = Math.max(0, Math.min(activeClaimIssueOccurrence, Math.max(0, marks.length - 1)))
    if (occurrence !== activeClaimIssueOccurrence) setActiveClaimIssueOccurrence(occurrence)
    const target = marks[occurrence]
    if (target) {
      target.classList.add('active')
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeClaimIssueId, activeClaimIssueOccurrence, claimBasisAnalysis, file, stage])

  useEffect(() => {
    const root = figuresRef.current
    if (!root) return
    const figureRoot = root
    figureRoot.querySelectorAll('.figure-label').forEach((label) => label.remove())
    if (!file || !mappingConfirmed || selectedReferences.size === 0) {
      setFigureLabels([])
      setExpandedFigure(null)
      setExpandedFigureScale(1)
      setFigureStatus('idle')
      return
    }
    const images = Array.from(figureRoot.querySelectorAll<HTMLImageElement>('img'))
    if (images.length === 0) return
    let cancelled = false

    async function runFigureRecognition() {
      setFigureStatus('scanning')
      setFigureError('')
      setCloudOcrUsage(null)
      setFigureProgress({ finished: 0, total: images.length })
      try {
        await waitForImages(images)
        if (cancelled) return
        const knownNumbers = new Set(selectedReferences.keys())
        const progress = (finished: number, total: number) => {
          if (!cancelled) setFigureProgress({ finished, total })
        }
        const cloudResult = ocrSettings.provider === 'local'
          ? { labels: await recognizeFigureLabels(images, progress, knownNumbers), wordCount: 0, imageCount: images.length }
          : await recognizeCloudFigureLabels(images, ocrSettings, knownNumbers, progress)
        const rawLabels = cloudResult.labels
        setCloudOcrUsage({
          provider: ocrSettings.provider,
          imageCount: cloudResult.imageCount,
          wordCount: cloudResult.wordCount,
        })
        if (cancelled) return
        const recognizedLabels = uniqueFigureLabels(suppressOverlappingSubnumberLabels(
          rawLabels.filter((label) => selectedReferences.has(label.number)),
        ))
        const labels = recognizedLabels.filter((label) => !dismissedFigureLabelsRef.current.has(`${label.imageIndex}-${label.number}`))
        setFigureLabels(labels)
        labels.forEach((label) => {
          const reference = selectedReferences.get(label.number)
          const figure = figureRoot.querySelector<HTMLElement>(`[data-figure-index="${label.imageIndex}"]`)
          if (!reference || !figure) return
          const labelKey = `${label.imageIndex}-${label.number}`
          const savedPosition = labelPositionsRef.current[labelKey]
          const badge = document.createElement('div')
          badge.className = 'figure-label'
          badge.style.left = `${savedPosition?.left ?? Math.min(Math.max(label.left, 2), 94)}%`
          badge.style.top = `${savedPosition?.top ?? Math.min(Math.max(label.top, 2), 94)}%`
          if (savedPosition) badge.classList.add('is-manually-positioned')
          badge.title = `标号 ${label.number} · 点击高亮正文；按住可拖动标签`
          const labelButton = document.createElement('button')
          labelButton.className = 'figure-label-main'
          labelButton.type = 'button'
          labelButton.textContent = `${reference.name} ${label.number}`
          const dismissButton = document.createElement('button')
          dismissButton.className = 'figure-label-dismiss'
          dismissButton.type = 'button'
          dismissButton.textContent = '×'
          dismissButton.title = `关闭标号 ${label.number}`
          dismissButton.addEventListener('pointerdown', (event) => event.stopPropagation())
          dismissButton.addEventListener('click', (event) => {
            event.stopPropagation()
            dismissedFigureLabelsRef.current.add(labelKey)
            badge.remove()
            setFigureLabels((current) => current.filter((item) => `${item.imageIndex}-${item.number}` !== labelKey))
          })
          badge.append(labelButton, dismissButton)
          bindFigureLabelInteractions(badge, figure, labelKey, labelPositionsRef, () => {
            setActiveReferenceOccurrence(0)
            setActiveReference(reference.id)
            setMode('review')
          })
          figure.append(badge)
        })
        setFigureStatus('done')
      } catch (error) {
        if (!cancelled) {
          setFigureStatus('error')
          setFigureError(error instanceof Error ? error.message : '附图标号识别未完成')
        }
      }
    }

    void runFigureRecognition()
    return () => { cancelled = true }
  }, [file, mappingConfirmed, ocrSettings, selectedReferences, stage])

  function navigateToSection(key: SectionKey) {
    setActiveSection(key)
    requestAnimationFrame(() => {
      const pageNumber = sections.find((section) => section.key === key)?.start
      const target = key === 'drawings'
        ? figuresRef.current?.querySelector('figure, img')
        : file?.extension === 'pdf' && pageNumber
          ? readingRef.current?.querySelector(`.pdf-page-shell[data-page-number="${pageNumber}"]`)
          : readingRef.current ? findDocxSectionTarget(readingRef.current, key) : null
      if (target) {
        const scroller = target.closest<HTMLElement>(key === 'drawings' ? '.figures-reader' : '.text-reader')
        if (scroller) scrollTargetWithin(target, scroller)
        else target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }
      else setNotice('尚未找到这个区段在当前文件中的可滚动位置；可从当前位置继续浏览。')
    })
  }

  function navigateToReference(reference: ReferenceCandidate) {
    if (!mappingConfirmed) {
      setNotice('请先确认“标号—待选特征”映射，再应用跳转与高亮。')
      return
    }
    setActiveReferenceOccurrence(0)
    setActiveReference(reference.id)
    setMode('review')
    setNotice(`已定位并高亮：${reference.name} ${reference.number}`)
  }

  function navigateReferenceOccurrence(direction: -1 | 1) {
    if (referenceOccurrenceCount < 2) return
    setActiveReferenceOccurrence((current) => cycleReferenceOccurrence(current, referenceOccurrenceCount, direction))
  }

  function navigateToClaimIssue(issue: ClaimIssue) {
    setActiveClaimIssueId(issue.id)
    setActiveClaimIssueOccurrence(0)
    setActiveSection('claims')
    setMode('review')
    setNotice(`已定位权利要求 ${issue.claimNumber}：${issue.message}`)
  }

  function navigateClaimIssueOccurrence(direction: -1 | 1) {
    if (claimIssueOccurrenceCount < 2) return
    setActiveClaimIssueOccurrence((current) => cycleReferenceOccurrence(current, claimIssueOccurrenceCount, direction))
  }

  function toggleClaimIssueDetails(issueId: string) {
    setExpandedClaimIssueIds((current) => {
      const next = new Set(current)
      if (next.has(issueId)) next.delete(issueId)
      else next.add(issueId)
      return next
    })
  }

  function chooseCandidate(number: string, id: string) {
    setMappingSelections((current) => ({ ...current, [number]: id }))
    setMappingConfirmed(false)
    setConfirmedMappings({})
    setFigureLabels([])
  }

  function invalidateMappings() {
    setMappingConfirmed(false)
    setConfirmedMappings({})
    setFigureLabels([])
  }

  function removeReferenceNumber(number: string) {
    setRemovedNumbers((current) => current.includes(number) ? current : [...current, number])
    setMappingSelections((current) => {
      const { [number]: _removed, ...remaining } = current
      return remaining
    })
    setActiveReference((current) => references.find((reference) => reference.id === current)?.number === number ? null : current)
    invalidateMappings()
    setNotice(`已从本次图文关联中删除标号 ${number}。`)
  }

  function restoreReferenceNumber(number: string) {
    setRemovedNumbers((current) => current.filter((item) => item !== number))
    invalidateMappings()
    setNotice(`已恢复标号 ${number}，请重新确认映射。`)
  }

  function addCustomReference() {
    const number = customReference.number.replace(/[^0-9A-Za-z]/g, '')
    const name = customReference.name.trim()
    if (!number || !name) {
      setNotice('请同时填写标号和特征名称。')
      return
    }
    if (number === '0') {
      setNotice('数字 0 默认不作为专利附图标号，请填写其他标号。')
      return
    }
    const id = `${name}${number}`
    if (references.some((reference) => reference.id === id)) {
      setNotice(`标号 ${number} 的“${name}”已在映射表中。`)
      return
    }
    const added: ReferenceCandidate = { id, name, number, mentions: 0, confidence: '高' }
    setReferences((current) => [...current, added])
    setRemovedNumbers((current) => current.filter((item) => item !== number))
    setMappingSelections((current) => ({ ...current, [number]: id }))
    setCustomReference({ number: '', name: '' })
    setIsCustomReferenceOpen(false)
    invalidateMappings()
    setNotice(`已补充“${name} ${number}”；重新确认后 OCR 会主动检索该标号。`)
  }

  function applyOcrSettings() {
    const draft = activeOcrSettings(ocrDraft)
    if (draft.provider === 'paddle-local' && !paddlePluginStatus?.installed) {
      setNotice('请先安装“本机 PaddleOCR 3（增强插件）”。')
      return
    }
    if (draft.provider !== 'local' && draft.provider !== 'paddle-local' && !draft.apiKey.trim()) {
      setNotice('请先填写所选云 OCR 的 API Key。')
      return
    }
    if (draft.provider === 'custom' && (!draft.interfaceName.trim() || !draft.endpoint.trim() || !draft.model.trim())) {
      setNotice('自定义 OCR 需要填写接口名称、服务器地址和模型名称。')
      return
    }
    const applied = updateOcrProfile(ocrDraft, draft.provider, {
      apiKey: draft.apiKey.trim(),
      endpoint: draft.endpoint.trim(),
      model: draft.model.trim(),
      interfaceName: draft.interfaceName.trim(),
    })
    setOcrSettingsStore(applied)
    if (rememberOcrSettings) window.localStorage.setItem('patent-reader.ocr-settings', JSON.stringify(applied))
    else window.localStorage.removeItem('patent-reader.ocr-settings')
    setFigureLabels([])
    setIsAssociationCollapsed(false)
    setIsOcrSettingsOpen(false)
    setNotice(draft.provider === 'local' || draft.provider === 'paddle-local'
      ? '已切换为完全本机 OCR。'
      : `已启用 ${draft.provider === 'custom' ? draft.interfaceName : ocrProviderLabels[draft.provider]}；只会上传右侧附图进行识别。`)
  }

  function openOcrSettings() {
    setOcrDraft({
      provider: ocrSettingsStore.provider,
      profiles: Object.fromEntries(
        Object.entries(ocrSettingsStore.profiles).map(([provider, profile]) => [provider, { ...profile }]),
      ) as OcrSettingsStore['profiles'],
    })
    setIsOcrSettingsOpen(true)
    void refreshPaddlePluginStatus()
  }

  async function openOcrApiLink(provider: OcrProvider) {
    const url = ocrProviderApiLinks[provider]
    if (!url) return
    try {
      if (window.patentReader?.openExternalUrl) await window.patentReader.openExternalUrl(url)
      else window.open(url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      setNotice(`无法打开默认浏览器：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function confirmMappings() {
    if (referenceGroups.length === 0) {
      setNotice('尚未识别到可供确认的“标号—待选特征”。')
      return
    }
    const resolved = { ...firstSelections(referenceGroups), ...mappingSelections }
    setConfirmedMappings(resolved)
    setMappingConfirmed(true)
    setIsAssociationCollapsed(false)
    setMode('review')
    const first = referenceGroups[0]?.options.find((item) => item.id === resolved[referenceGroups[0].number]) ?? referenceGroups[0]?.options[0]
    setActiveReferenceOccurrence(0)
    setActiveReference(first?.id ?? null)
    setNotice(`已确认 ${referenceGroups.length} 个标号映射，正在应用到全文和附图。`)
  }

  async function openDocument(skipStructureConfirm = false) {
    if (!window.patentReader) {
      setNotice('请使用桌面应用打开本地 DOCX 或 PDF。')
      return
    }
    setIsOpening(true)
    setNotice('')
    try {
      const selected = await window.patentReader.openDocument()
      if (!selected) return
      const bytes = base64ToArrayBuffer(selected.base64)
      let html = ''
      let text = ''
      let markers: string[] = []
      let pageCount = 0
      let previewUrl: string | null = null
      let pdfPages: PdfPageData[] = []
      if (selected.extension === 'docx') {
        const parsed = await parseDocx(bytes)
        html = parsed.html
        text = parsed.plainText
        markers = parsed.markers
        pageCount = parsed.pageCount
      } else {
        const parsed = await parsePdf(bytes)
        text = parsed.plainText
        markers = parsed.markers
        pageCount = parsed.pages.length
        pdfPages = parsed.pages
      }
      const foundSections = detectSections(text, markers)
      const candidates = extractReferenceCandidates(text)
      const groups = groupReferences(candidates)
      setFile({ ...selected, html, text, markers, pageCount, previewUrl, pdfPages, sections: foundSections })
      setSections(foundSections)
      setReferences(candidates)
      setRemovedNumbers([])
      setIsCustomReferenceOpen(false)
      setCustomReference({ number: '', name: '' })
      setMappingSelections(firstSelections(groups))
      setConfirmedMappings({})
      setMappingConfirmed(false)
      setIsAssociationCollapsed(false)
      setIsClaimBasisCollapsed(false)
      setActiveClaimIssueId(null)
      setActiveReference(null)
      setActiveReferenceOccurrence(0)
      setReferenceOccurrenceCount(0)
      setActiveSection('description')
      setMode('reading')
      setAnnotations([])
      setRatings({ ...emptyRatings })
      setLlmFindings([])
      setLlmRunMetadata(null)
      setIsLlmReviewOpen(false)
      setAnnotation((current) => ({ ...current, body: '' }))
      setSelectedText(null)
      setSelectionAnchor(null)
      setDocxSelectionHighlights([])
      setFigureLabels([])
      setExpandedFigure(null)
      setExpandedFigureScale(1)
      setIsSectionNavCollapsed(false)
      labelPositionsRef.current = {}
      dismissedFigureLabelsRef.current = new Set()
      setFigureStatus('idle')
      setFigureError('')
      setCloudOcrUsage(null)
      setStage(skipStructureConfirm ? 'workspace' : 'structure')
    } catch (error) {
      const detail = error instanceof Error ? error.message : ''
      setNotice(`文件暂时无法读取。请确认它是未加密的 DOCX 或可检索 PDF。${detail ? ` 详情：${detail}` : ''}`)
    } finally {
      setIsOpening(false)
    }
  }

  function updateSectionStart(key: SectionKey, value: string) {
    setSections((current) => current.map((section) => (
      section.key === key
        ? { ...section, start: value ? Number(value) : null, confidence: value ? '高' : '待确认' }
        : section
    )))
  }

  function captureSelection() {
    const selection = window.getSelection()
    const text = selection?.toString()
      .replace(/\r\n?/g, '\n')
      .replace(/[\t \f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim()
    if (!text) return
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (file?.extension === 'pdf' && range && readingRef.current) {
      const root = readingRef.current
      const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer as Element
        : range.startContainer.parentElement
      const endElement = range.endContainer.nodeType === Node.ELEMENT_NODE
        ? range.endContainer as Element
        : range.endContainer.parentElement
      if (startElement?.closest('.pdf-text-layer') && endElement?.closest('.pdf-text-layer')) {
        const pageElements = Array.from(root.querySelectorAll<HTMLElement>('.pdf-page-shell'))
        const rects = Array.from(range.getClientRects())
          .filter((rect) => rect.width > 1 && rect.height > 1)
          .flatMap((rect) => {
            const page = pageElements.find((candidate) => {
              const bounds = candidate.getBoundingClientRect()
              const centerX = rect.left + rect.width / 2
              const centerY = rect.top + rect.height / 2
              return centerX >= bounds.left && centerX <= bounds.right && centerY >= bounds.top && centerY <= bounds.bottom
            })
            const content = page?.querySelector<HTMLElement>('.pdf-page-content')
            if (!page || !content) return []
            const bounds = content.getBoundingClientRect()
            const left = Math.max(0, rect.left - bounds.left)
            const top = Math.max(0, rect.top - bounds.top)
            const right = Math.min(bounds.width, rect.right - bounds.left)
            const bottom = Math.min(bounds.height, rect.bottom - bounds.top)
            if (right <= left || bottom <= top) return []
            return [{
              pageNumber: Number(page.dataset.pageNumber),
              left: left / bounds.width,
              top: top / bounds.height,
              width: (right - left) / bounds.width,
              height: (bottom - top) / bounds.height,
            }]
          })
          .sort((first, second) => first.pageNumber - second.pageNumber || first.top - second.top || first.left - second.left)
          .reduce<NonNullable<PatentSelectionAnchor['pdfRects']>>((merged, rect) => {
            const previous = merged.at(-1)
            const sameLine = previous
              && previous.pageNumber === rect.pageNumber
              && Math.abs(previous.top - rect.top) < 0.008
              && rect.left - (previous.left + previous.width) < 0.02
            if (previous && sameLine) {
              const right = Math.max(previous.left + previous.width, rect.left + rect.width)
              previous.left = Math.min(previous.left, rect.left)
              previous.top = Math.min(previous.top, rect.top)
              previous.width = right - previous.left
              previous.height = Math.max(previous.height, rect.height)
            } else {
              merged.push({ ...rect })
            }
            return merged
          }, [])
        setSelectionAnchor(rects.length ? {
          startParagraphText: '',
          startOffset: 0,
          endParagraphText: '',
          endOffset: 0,
          pdfRects: rects,
        } : null)
        setDocxSelectionHighlights([])
        setSelectedText(text)
        setNotice(`已锁定 PDF 原文选区：“${text.slice(0, 42)}${text.length > 42 ? '…' : ''}”`)
        return
      }
    }
    const getBlock = (node: Node) => {
      const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
      return element?.closest('p, h1, h2, h3, li') ?? null
    }
    const getOffset = (block: Element, node: Node, offset: number) => {
      const prefix = document.createRange()
      prefix.selectNodeContents(block)
      prefix.setEnd(node, offset)
      return prefix.toString().length
    }
    const startBlock = range ? getBlock(range.startContainer) : null
    const endBlock = range ? getBlock(range.endContainer) : null
    if (range && startBlock && endBlock && readingRef.current?.contains(startBlock) && readingRef.current.contains(endBlock)) {
      setSelectionAnchor({
        startParagraphText: startBlock.textContent ?? '',
        startOffset: getOffset(startBlock, range.startContainer, range.startOffset),
        endParagraphText: endBlock.textContent ?? '',
        endOffset: getOffset(endBlock, range.endContainer, range.endOffset),
      })
      const overlayRoot = readingRef.current.parentElement
      const overlayBounds = overlayRoot?.getBoundingClientRect()
      const highlights = overlayBounds
        ? Array.from(range.getClientRects())
          .filter((rect) => rect.width > 1 && rect.height > 1)
          .map((rect) => ({
            left: rect.left - overlayBounds.left,
            top: rect.top - overlayBounds.top,
            width: rect.width,
            height: rect.height,
          }))
        : []
      setDocxSelectionHighlights(highlights)
    } else {
      setSelectionAnchor(null)
      setDocxSelectionHighlights([])
    }
    setSelectedText(text)
    setNotice(`已锁定原文选区：“${text.slice(0, 42)}${text.length > 42 ? '…' : ''}”`)
  }

  function addAnnotation() {
    if (!annotation.body.trim()) {
      setNotice('请先输入批注内容。')
      return
    }
    setAnnotations((current) => [{
      id: Date.now(),
      ...annotation,
      author: annotationAuthor.trim() || '专利阅研',
      selectedText,
      selectionAnchor,
      location: selectedText
        ? `原文：“${selectedText.slice(0, 56)}${selectedText.length > 56 ? '…' : ''}”`
        : activeSection === 'drawings' ? '说明书附图（待圈选区域）' : `${sectionCopy[activeSection].slice(0, 8)}…`,
    }, ...current])
    setAnnotation((current) => ({ ...current, body: '' }))
    clearLockedSelection()
    setNotice('批注已加入本次修订草稿。保存时将写入修订版文件。')
  }

  function updateAnnotationAuthor(value: string) {
    setAnnotationAuthor(value)
    window.localStorage.setItem('patent-reader.annotation-author', value)
  }

  async function saveRevision(): Promise<boolean> {
    if (!file || !window.patentReader) return false
    try {
    const payload: PatentAnnotation[] = annotations.map((item) => ({
      type: item.type,
      severity: item.severity,
      status: item.status,
      author: item.author,
      body: item.body,
      location: item.location,
      selectedText: item.selectedText,
      selectionAnchor: item.selectionAnchor,
    }))
    const ratingLines = [
      ratings.technicalUnderstanding && `技术理解评级：${ratings.technicalUnderstanding}`,
      ratings.communication && `沟通评级：${ratings.communication}`,
      ratings.patentQuality && `专利质量评级：${ratings.patentQuality}`,
    ].filter(Boolean) as string[]
    if (ratingLines.length) {
      payload.push({
        type: '专利评级',
        severity: '评级',
        status: '已评级',
        author: annotationAuthor.trim() || '专利阅研',
        body: ratingLines.join('\n'),
        location: '文档整体评级',
        selectedText: null,
        selectionAnchor: null,
      })
    }
    const acceptedLlmFindings = LLM_REVIEW_ENABLED ? llmFindings.filter((finding) => finding.accepted) : []
    acceptedLlmFindings.forEach((finding) => {
      payload.push({
        type: 'LLM辅助审查',
        severity: finding.severity,
        status: '已采纳',
        author: annotationAuthor.trim() || '专利阅研',
        body: `风险类型：${finding.title.trim() || finding.module}（详情看附件excel）`,
        location: finding.location,
        selectedText: finding.quote || null,
        selectionAnchor: file.extension === 'pdf' ? pdfAnchorForQuote(file.pdfPages, finding.quote) : null,
      })
    })
    const llmReport: PatentLlmReviewReportPayload | null = LLM_REVIEW_ENABLED && llmRunMetadata && llmFindings.length ? {
      technicalField: llmRunMetadata.technicalField,
      rulebookVersion: reviewRulebook.metadata.version,
      rulebookVerifiedAt: reviewRulebook.metadata.lastVerifiedAt,
      provider: llmRunMetadata.provider,
      model: llmRunMetadata.model,
      generatedAt: llmRunMetadata.generatedAt,
      findings: llmFindings.map((finding) => ({
        module: finding.module,
        severity: finding.severity,
        evidenceLevel: finding.evidenceLevel,
        title: finding.title,
        location: finding.location,
        quote: finding.quote,
        analysis: finding.analysis,
        recommendation: finding.recommendation,
        sources: finding.sources.map((source) => `${source.title}${source.url ? `：${source.url}` : ''}`).join('\n'),
        accepted: finding.accepted,
      })),
    } : null
    const claimBasisReport: PatentClaimBasisReportPayload | null = claimBasisAnalysis.claims.length
      ? {
        totalClaims: claimBasisAnalysis.claims.length,
        issues: claimBasisAnalysis.issues
          .filter((issue) => issue.severity !== '提示')
          .map((issue) => ({
            claimNumber: issue.claimNumber,
            severity: issue.severity,
            term: issue.highlightText,
            conclusion: issue.conclusion,
            message: issue.message,
            sources: issue.sources.map((source) => `权${source.claimNumber}“${source.term}”${source.preamble ? '（前序）' : ''}`).join('；'),
            paths: issue.paths.map((path) => path.map((number) => `权${number}`).join(' → ')).join('；'),
          })),
      }
      : null
    const result = await window.patentReader.saveRevision(file.path, payload, {
      technicalUnderstanding: ratings.technicalUnderstanding,
      communication: ratings.communication,
      patentQuality: ratings.patentQuality,
    }, llmReport, claimBasisReport)
    const details = [
      annotations.length ? `${annotations.length} 条人工批注` : '',
      acceptedLlmFindings.length ? `${acceptedLlmFindings.length} 条LLM采纳意见` : '',
      ratingLines.length ? '整体评级' : '',
    ].filter(Boolean).join('及')
    const ratingNotice = result.ratingPath ? `；评分表：${result.ratingPath}` : ''
    const reviewNotice = result.reviewPath ? `；LLM审查报告：${result.reviewPath}` : ''
    setNotice(details
      ? `已生成修订版并写入${details}：${result.revisionPath}${ratingNotice}${reviewNotice}`
      : `已生成修订版：${result.revisionPath}${ratingNotice}${reviewNotice}`)
      return true
    } catch (error) {
      setNotice(error instanceof Error ? `保存修订版失败：${error.message}` : `保存修订版失败：${String(error)}`)
      return false
    }
  }

  async function exitApplication() {
    try {
      if (window.patentReader?.exitApp) {
        await window.patentReader.exitApp()
        return true
      }
      window.close()
      return true
    } catch (error) {
      setNotice(error instanceof Error ? `退出失败：${error.message}` : `退出失败：${String(error)}`)
      return false
    }
  }

  async function saveRevisionAndExit() {
    setIsSavingBeforeExit(true)
    const saved = await saveRevision()
    const exited = saved && await exitApplication()
    if (!exited) setIsSavingBeforeExit(false)
  }

  useEffect(() => {
    if (!window.patentReader?.onExitRequested) return
    let unlisten: (() => void) | undefined
    let disposed = false
    void window.patentReader.onExitRequested(() => {
      if (!file) {
        void exitApplication()
        return
      }
      if (!isSavingBeforeExit) setIsExitConfirmOpen(true)
    }).then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [file, isSavingBeforeExit])

  function cancelExitConfirmation() {
    if (!isSavingBeforeExit) setIsExitConfirmOpen(false)
  }

  async function exitWithoutSaving() {
    setIsSavingBeforeExit(true)
    const exited = await exitApplication()
    if (!exited) setIsSavingBeforeExit(false)
  }

  if (stage === 'welcome') return <>
    <Welcome isOpening={isOpening} isCheckingUpdate={isCheckingUpdate} notice={notice} onOpen={() => { void openDocument(false) }} onDownloadGuide={() => { void downloadUserGuide() }} onFollowAuthor={() => setIsAuthorQrOpen(true)} onUpdate={() => { void handleUpdateAction() }} updateAvailable={Boolean(updateCheck?.updateAvailable)} desktop={isDesktop} />
    {isAuthorQrOpen && <AuthorQrDialog onClose={() => setIsAuthorQrOpen(false)} />}
    {isExitConfirmOpen && <ExitConfirmDialog isSaving={isSavingBeforeExit} onCancel={cancelExitConfirmation} onExitWithoutSaving={() => { void exitWithoutSaving() }} onSaveAndExit={() => { void saveRevisionAndExit() }} />}
  </>

  if (stage === 'structure' && file) {
    return <>
      <StructureConfirm file={file} sections={sections} detectedCount={detectedCount} onBack={() => setStage('welcome')} onUpdate={updateSectionStart} onConfirm={() => setStage('workspace')} />
      {isExitConfirmOpen && <ExitConfirmDialog isSaving={isSavingBeforeExit} onCancel={cancelExitConfirmation} onExitWithoutSaving={() => { void exitWithoutSaving() }} onSaveAndExit={() => { void saveRevisionAndExit() }} />}
    </>
  }

  if (!file) return null
  const pdfDrawingPages = file.pdfPages.filter((page) => (
    pdfSectionForPage(page.pageNumber, sections) === 'drawings' || page.isDrawing
  ))
  const pdfTextPages = file.pdfPages.filter((page) => !pdfDrawingPages.includes(page))

  return (
    <main className="app-shell">
      <header className="app-header">
        <BrandWithAuthor onFollowAuthor={() => setIsAuthorQrOpen(true)} />
        <div className="document-title"><FileText size={16} /><span>{file.name}</span><span className="analysis-pill"><Sparkles size={13} /> 本地分析就绪</span></div>
        <div className="header-actions"><button type="button" className={`header-option-button ${updateCheck?.updateAvailable ? 'has-update' : ''}`} onClick={() => { void handleUpdateAction() }} disabled={isCheckingUpdate} title={updateCheck?.updateAvailable ? `下载新版本 ${updateCheck.latestVersion}` : '检查软件更新'}><RefreshCw size={17} className={isCheckingUpdate ? 'spinning-icon' : ''} /><span>{isCheckingUpdate ? '检查中…' : updateCheck?.updateAvailable ? `更新 ${updateCheck.latestVersion}` : '检查更新'}</span></button>{LLM_REVIEW_ENABLED && <button type="button" className="header-option-button llm-header-button" onClick={() => setIsLlmReviewOpen(true)} title="打开LLM辅助审查"><Sparkles size={17} /><span>LLM 审查{llmFindings.length ? ` · ${llmFindings.length}` : ''}</span></button>}<button type="button" className="header-option-button" onClick={openOcrSettings} title="设置 OCR 识别方式" aria-label={`OCR 设置，当前为${ocrDisplayName}`}><Cloud size={17} /><span>{ocrDisplayName}</span></button><button type="button" className="header-icon-button" onClick={() => { void openDocument(true) }} disabled={isOpening} title="打开新文档" aria-label="打开新文档"><FolderOpen size={18} /></button><button className="quiet-button" onClick={() => setStage('structure')}>文档结构</button><button className="primary-button" onClick={saveRevision}><Save size={16} /> 保存修订版</button></div>
      </header>
      <div className={`workspace ${isSectionNavCollapsed ? 'nav-collapsed' : ''}`}>
        <nav className={`section-nav ${isSectionNavCollapsed ? 'collapsed' : ''}`} aria-label="文档区段">
          {isSectionNavCollapsed ? <button type="button" className="nav-expand-button" onClick={() => setIsSectionNavCollapsed(false)} title="展开结构概览" aria-label="展开结构概览"><PanelLeftOpen size={18} /></button> : <>
            <div className="nav-kicker">本专利</div>
            <div className="nav-overview-row"><button className="overview-link"><BookOpenText size={17} /> 结构概览</button><button type="button" className="nav-collapse-button" onClick={() => setIsSectionNavCollapsed(true)} title="收起结构概览" aria-label="收起结构概览"><PanelLeftClose size={18} /></button></div>
            <div className="nav-kicker">阅读区段</div>
            {sectionOrder.map((key) => {
              const section = sections.find((item) => item.key === key)
              return <button key={key} className={`section-link ${activeSection === key ? 'selected' : ''}`} onClick={() => navigateToSection(key)}>{key === 'drawings' ? <Image size={17} /> : <FileText size={17} />} {section?.label}{section?.start && <span className="position-dot">已识别</span>}</button>
            })}
            <div className="nav-spacer" /><div className="privacy-note">正文与批注仅在本机处理<br />{ocrSettings.provider === 'local' || ocrSettings.provider === 'paddle-local' ? '云端增强未启用' : `仅附图启用 ${ocrProviderLabels[ocrSettings.provider]}`}</div>
          </>}
        </nav>

        <section className="reading-pane">
          <div className="pane-toolbar"><div><span className="eyebrow">{mode === 'reading' ? '理解模式' : '审阅模式'}</span><h1>{sections.find((item) => item.key === activeSection)?.label}</h1></div><div className="mode-tabs"><button className={mode === 'reading' ? 'active' : ''} onClick={() => setMode('reading')}>阅读</button><button className={mode === 'review' ? 'active' : ''} onClick={() => setMode('review')}>审阅</button></div></div>
          <div className="dual-reader">
            <section className="text-reader"><div className="reader-subheader"><FileText size={15} /> 全文阅读 <span>{file.extension === 'pdf' ? `${pdfTextPages.length} 页` : ''}</span>{mappingConfirmed && activeReference && <div className="reference-navigation" aria-label="同一特征定位"><strong>{references.find((reference) => reference.id === activeReference)?.name} {references.find((reference) => reference.id === activeReference)?.number}</strong><span>{referenceOccurrenceCount ? `${activeReferenceOccurrence + 1}/${referenceOccurrenceCount}` : '定位中…'}</span><button type="button" onClick={() => navigateReferenceOccurrence(-1)} disabled={referenceOccurrenceCount < 2} title="上一个相同特征" aria-label="上一个相同特征"><ArrowUp size={15} /></button><button type="button" onClick={() => navigateReferenceOccurrence(1)} disabled={referenceOccurrenceCount < 2} title="下一个相同特征" aria-label="下一个相同特征"><ArrowDown size={15} /></button><button type="button" className="reference-navigation-close" onClick={() => setActiveReference(null)} title="关闭定位" aria-label="关闭定位"><X size={14} /></button></div>}</div>{file.extension === 'pdf'
              ? <article ref={readingRef} className="pdf-reading-pages" onMouseUp={captureSelection}>{pdfTextPages.map((page) => <PdfPageView key={page.pageNumber} page={page} selectable selectionRects={selectionAnchor?.pdfRects?.filter((rect) => rect.pageNumber === page.pageNumber) ?? []} />)}</article>
              : <div className="docx-reading-shell"><article ref={readingRef} className="docx-reading" onMouseUp={captureSelection} dangerouslySetInnerHTML={{ __html: file.html || '<p>文档正文为空。</p>' }} />{docxSelectionHighlights.length > 0 && <div className="persistent-selection-overlays" aria-hidden="true">{docxSelectionHighlights.map((highlight, index) => <span key={`${highlight.left}-${highlight.top}-${index}`} className="persistent-selection-highlight" style={{ left: highlight.left, top: highlight.top, width: highlight.width, height: highlight.height }} />)}</div>}</div>}</section>
            <section className="figures-reader"><div className="reader-subheader"><Image size={15} /> 全部附图 <span>{figureLabels.length ? `${figureLabels.length} 个已标注` : '确认映射后标注'}</span></div><div ref={figuresRef} className="figure-gallery">{file.extension === 'pdf'
              ? pdfDrawingPages.length
                ? pdfDrawingPages.map((page, index) => <figure key={page.pageNumber} className="figure-wrapper" data-figure-index={index}><img src={page.imageDataUrl} alt={`PDF 附图第 ${page.pageNumber} 页`} title="双击打开附图详情，可放大查看" onDoubleClick={() => { setExpandedFigure({ source: page.imageDataUrl, index }); setExpandedFigureScale(1) }} /><figcaption>附图页 {page.pageNumber}</figcaption></figure>)
                : <div className="figures-empty">未识别到说明书附图页，请返回“文档结构”确认附图起始页。</div>
              : <div className="figures-empty">正在整理文档中的附图…</div>}</div></section>
          </div>
        </section>

        <aside className="review-pane">
          <div className="review-heading"><div><span className="eyebrow">图文关联 · 两步确认</span><h2>批注与关联</h2></div><div className="review-heading-actions"><button type="button" className="association-collapse-toggle" onClick={() => setIsAssociationCollapsed((current) => !current)} title={isAssociationCollapsed ? '展开标号映射' : '收起标号映射'} aria-label={isAssociationCollapsed ? '展开标号映射' : '收起标号映射'} aria-expanded={!isAssociationCollapsed}>{isAssociationCollapsed ? <ChevronDown size={17} /> : <ChevronUp size={17} />}</button><span className="annotation-count">{annotations.length}</span></div></div>
          {isAssociationCollapsed
            ? <button type="button" className="association-collapsed-summary" onClick={() => setIsAssociationCollapsed(false)}><Check size={15} /><span>{mappingConfirmed ? `已应用 ${referenceGroups.length} 个标号${figureStatus === 'done' ? `，附图标注 ${figureLabels.length} 处` : ''}${cloudOcrUsage ? ` · ${ocrProviderLabels[cloudOcrUsage.provider]} 已调用` : ''}` : `待确认 ${referenceGroups.length} 个标号`}</span><ChevronDown size={15} /></button>
            : <section className="association-card">
              <div className="mapping-panel">
                <div className="mapping-card-heading"><div><strong>第 1 步：确认标号—特征</strong><p>优先采用说明书附图标记；未提取到时再按正文频次匹配。</p></div><span>{referenceGroups.length} 个标号</span></div>
                <div className="mapping-list">
                  {referenceGroups.length === 0 ? <div className="reference-empty">尚未发现可确认的文字标号候选。</div> : <><div className="mapping-table-head"><span>标号</span><span>确认特征</span><span>操作</span></div>{referenceGroups.map((group) => {
                    const selectedId = mappingSelections[group.number] ?? group.options[0]?.id ?? ''
                    return <section key={group.number} className="mapping-row"><span className="mapping-row-number">{group.number}</span><label className="mapping-select-wrap"><select value={selectedId} onChange={(event) => chooseCandidate(group.number, event.target.value)} aria-label={`选择标号 ${group.number} 的特征`}>{group.options.map((option) => <option key={option.id} value={option.id}>{option.name}{option.fromLegend ? ' · 说明书标记' : option.mentions > 0 ? ` · ${option.mentions}次` : ' · 手动补充'}</option>)}</select><small>{group.options.length > 1 ? `点击查看 ${group.options.length} 个候选` : group.options[0]?.fromLegend ? '已从说明书提取' : '已自动匹配'}</small></label><button type="button" className="mapping-delete" onClick={() => removeReferenceNumber(group.number)} title={`删除标号 ${group.number}`}><Trash2 size={13} /></button></section>
                  })}</>}
                </div>
                {removedNumbers.length > 0 && <div className="removed-references"><span>已删除</span>{removedNumbers.map((number) => <button key={number} type="button" onClick={() => restoreReferenceNumber(number)}><Undo2 size={12} /> {number}</button>)}</div>}
                <div className="custom-reference">
                  <button type="button" className="custom-reference-toggle" onClick={() => setIsCustomReferenceOpen((current) => !current)}><Plus size={15} /> 自定义补充</button>
                  {isCustomReferenceOpen && <div className="custom-reference-form"><label>标号<input inputMode="text" maxLength={8} value={customReference.number} onChange={(event) => setCustomReference((current) => ({ ...current, number: event.target.value.replace(/[^0-9A-Za-z]/g, '') }))} placeholder="如 221 / 11a" /></label><label>特征名称<input value={customReference.name} onChange={(event) => setCustomReference((current) => ({ ...current, name: event.target.value }))} placeholder="如 阀座" /></label><div><button type="button" className="custom-reference-cancel" onClick={() => setIsCustomReferenceOpen(false)}>取消</button><button type="button" className="custom-reference-add" onClick={addCustomReference}><Plus size={14} /> 添加</button></div></div>}
                </div>
                <button className="confirm-mapping-button" disabled={referenceGroups.length === 0} onClick={confirmMappings}><Check size={16} /> {mappingConfirmed ? '重新确认并应用映射' : '确认并应用到全文'}</button>
              </div>
              <div className="association-result">
                <div className={`suggestion-card ${mappingConfirmed ? 'applied' : ''}`}><div className="suggestion-icon"><Sparkles size={16} /></div><div><strong>{!mappingConfirmed ? '第 2 步将在确认后开始' : figureStatus === 'scanning' ? `正在识别附图标号（${figureProgress.finished}/${figureProgress.total}）` : figureStatus === 'done' ? `全文映射已应用，附图已标注 ${figureLabels.length} 处` : figureStatus === 'error' ? '附图标号识别未完成' : '全文映射已应用'}</strong><p>{!mappingConfirmed ? '确认后将高亮正文中的对应特征，并在右侧附图窗口显示浮动标签。' : figureStatus === 'error' ? `${ocrProviderLabels[ocrSettings.provider]} 提示：${figureError || '请重试或保留文件供排查。'}` : cloudOcrUsage ? `${ocrProviderLabels[cloudOcrUsage.provider]} 已调用 ${cloudOcrUsage.imageCount} 张附图，返回 ${cloudOcrUsage.wordCount} 个文字定位，再按映射表生成浮动标签。` : '点击正文或浮动标签，均会定位并高亮对应特征。'}</p></div></div>
                {mappingConfirmed && <div className="applied-reference-list">{[...selectedReferences.values()].map((reference) => <button key={reference.id} className={`reference-item ${activeReference === reference.id ? 'active' : ''}`} onClick={() => navigateToReference(reference)}><span className="reference-number">{reference.number}</span><span className="reference-name">{reference.name}</span><span className="reference-confidence high">已应用</span></button>)}</div>}
              </div>
            </section>}
          <section className={`claim-basis-card ${isClaimBasisCollapsed ? 'collapsed' : ''}`}>
            <div className="claim-basis-heading">
              <div><span className="eyebrow">权利要求 · 离线校验</span><h3>引用基础判断</h3></div>
              <button type="button" className="claim-basis-collapse" onClick={() => setIsClaimBasisCollapsed((current) => !current)} aria-label={isClaimBasisCollapsed ? '展开引用基础判断' : '收起引用基础判断'} title={isClaimBasisCollapsed ? '展开' : '收起'}>{isClaimBasisCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</button>
            </div>
            {isClaimBasisCollapsed
              ? <button type="button" className="claim-basis-summary" onClick={() => setIsClaimBasisCollapsed(false)}><AlertTriangle size={14} /><span>{claimBasisAnalysis.claims.length ? `已校验 ${claimBasisAnalysis.claims.length} 项权利要求${claimBasisAnalysis.issues.filter((issue) => issue.severity !== '提示').length ? `，发现 ${claimBasisAnalysis.issues.filter((issue) => issue.severity !== '提示').length} 项风险` : '，未发现高/中风险'}` : '未识别到权利要求书正文'}</span></button>
              : <>
                <div className="claim-basis-toolbar"><p className="claim-basis-description">仅本地核对权利要求内部的首次引入、指代链与术语一致性。</p><button type="button" onClick={() => setIsClaimBasisShowAll((current) => !current)}>{isClaimBasisShowAll ? '仅看风险' : '显示全部'}</button></div>
                {claimBasisAnalysis.claims.length === 0
                  ? <div className="claim-basis-empty">暂未识别到可解析的权利要求条目。请先在“文档结构”中确认权利要求书位置。</div>
                  : <>
                    {claimBasisIssueGroups.length === 0
                      ? <div className="claim-basis-clear"><Check size={16} /> 已校验 {claimBasisAnalysis.claims.length} 项权利要求，暂未发现高/中风险。</div>
                      : <div className="claim-issue-list">{claimBasisIssueGroups.map((group) => <section key={group.claimNumber} className="claim-issue-group"><div className="claim-issue-group-title"><strong>权利要求 {group.claimNumber}</strong><span>{group.issues.length} 项风险</span></div>{group.issues.map((issue) => {
                        const expanded = expandedClaimIssueIds.has(issue.id)
                        const active = activeClaimIssueId === issue.id
                        return <article key={issue.id} className={`claim-issue ${active ? 'active' : ''}`} onClick={() => navigateToClaimIssue(issue)}>
                          <div className="claim-issue-compact"><span className={`claim-issue-severity ${issue.severity}`}>{issue.severity}</span><strong>{issue.highlightText}</strong><span className="claim-issue-conclusion">{issue.conclusion}</span><button type="button" onClick={(event) => { event.stopPropagation(); toggleClaimIssueDetails(issue.id) }}>{expanded ? '收起详情' : '展开详情'}</button></div>
                          {active && claimIssueOccurrenceCount > 0 && <div className="claim-issue-navigation" onClick={(event) => event.stopPropagation()}><span>{activeClaimIssueOccurrence + 1}/{claimIssueOccurrenceCount}</span><button type="button" onClick={() => navigateClaimIssueOccurrence(-1)} title="上一个相同术语" aria-label="上一个相同术语"><ArrowUp size={13} /></button><button type="button" onClick={() => navigateClaimIssueOccurrence(1)} title="下一个相同术语" aria-label="下一个相同术语"><ArrowDown size={13} /></button></div>}
                          {expanded && <div className="claim-issue-details"><p>{issue.message}</p><small>{issue.sources.length ? `引用基础：${issue.sources.map((source) => `权${source.claimNumber}“${source.term}”${source.preamble ? '（前序）' : ''}`).join('；')}` : `已检查 ${issue.paths.length} 条继承路径，未找到首次引入。`}</small></div>}
                        </article>
                      })}</section>)}</div>}
                    {!isClaimBasisShowAll && claimBasisLowRiskIssues.length > 0 && <section className="claim-basis-folded"><button type="button" onClick={() => setIsClaimBasisLowRiskOpen((current) => !current)}><span>低风险与可优化项</span><span>{claimBasisLowRiskIssues.length} 项 {isClaimBasisLowRiskOpen ? '收起' : '展开'}</span></button>{isClaimBasisLowRiskOpen && <div>{claimBasisLowRiskIssues.map((issue) => <button key={issue.id} type="button" onClick={() => navigateToClaimIssue(issue)}>权 {issue.claimNumber} · {issue.highlightText} · {issue.conclusion}</button>)}</div>}</section>}
                    <section className="claim-basis-folded"><button type="button" onClick={() => setIsClaimBasisPassedOpen((current) => !current)}><span>已通过项</span><span>{claimBasisPassedClaims.length} 项 {isClaimBasisPassedOpen ? '收起' : '展开'}</span></button>{isClaimBasisPassedOpen && <p>{claimBasisPassedClaims.length ? `权利要求 ${claimBasisPassedClaims.join('、')} 未发现需提示的引用基础风险。` : '暂无可单独列示的已通过项。'}</p>}</section>
                  </>}
              </>}
          </section>
          {LLM_REVIEW_ENABLED && <section className="llm-summary-card">
            <div><span><Sparkles size={16} /></span><div><strong>LLM 专利辅助审查</strong><small>{llmFindings.length ? `已生成 ${llmFindings.length} 条，采纳 ${llmFindings.filter((finding) => finding.accepted).length} 条` : `规则库 ${reviewRulebook.metadata.version} 已就绪`}</small></div></div>
            <button type="button" onClick={() => setIsLlmReviewOpen(true)}>{llmFindings.length ? '查看结果' : '开始审查'}</button>
            <p>辅助审查，不构成法律意见。采纳项保存为批注，完整结果另存为 Excel 报告。</p>
          </section>}
          <div className="annotation-form">
            {selectedText ? <div className="selection-context"><div><span>已锁定原文选区</span><p>“{selectedText}”</p></div><button type="button" onClick={clearLockedSelection}>取消</button></div> : <div className="selection-guide">先在全文窗口选中原文；选区会保留在这里，再填写批注。</div>}
            <div className="form-row"><label>类型<select value={annotation.type} onChange={(event) => setAnnotation({ ...annotation, type: event.target.value })}><option>图文不一致</option><option>术语不一致</option><option>缺乏支持</option><option>表述不清楚</option><option>待核实</option><option>理解笔记</option></select></label><label>程度<select value={annotation.severity} onChange={(event) => setAnnotation({ ...annotation, severity: event.target.value })}><option>提示</option><option>一般</option><option>重要</option><option>阻塞</option></select></label></div>
            <label>批注人<input value={annotationAuthor} maxLength={40} onChange={(event) => updateAnnotationAuthor(event.target.value)} placeholder="如 李明" /></label>
            <label>批注内容<textarea value={annotation.body} onChange={(event) => setAnnotation({ ...annotation, body: event.target.value })} placeholder="记录理解、疑点或审阅意见…" /></label>
            <div className="annotation-actions"><span><Tag size={14} /> {annotation.status}</span><button onClick={addAnnotation}><MessageSquarePlus size={16} /> 添加批注</button></div>
          </div>
          <div className="annotation-list">{annotations.length === 0 ? <div className="empty-annotations"><Highlighter size={23} /><p>尚无批注<br />从阅读中发现问题后记录在这里</p></div> : annotations.map((item) => <article key={item.id} className="annotation-item"><div><span className="tag severity">{item.severity}</span><span className="tag">{item.type}</span></div><p>{item.body}</p><small>{item.location} · {item.status}</small></article>)}</div>
          <section className="rating-card">
            <div className="rating-heading"><div><strong>专利整体评级</strong><span>保存修订版时一并写入</span></div><span>A–D</span></div>
            <label><span>技术理解评级</span><select value={ratings.technicalUnderstanding} onChange={(event) => setRatings((current) => ({ ...current, technicalUnderstanding: event.target.value as RatingGrade }))}><option value="">未评级</option><option>A</option><option>B</option><option>C</option><option>D</option></select></label>
            <label><span>沟通评级</span><select value={ratings.communication} onChange={(event) => setRatings((current) => ({ ...current, communication: event.target.value as RatingGrade }))}><option value="">未评级</option><option>A</option><option>B</option><option>C</option><option>D</option></select></label>
            <label><span>专利质量评级</span><select value={ratings.patentQuality} onChange={(event) => setRatings((current) => ({ ...current, patentQuality: event.target.value as RatingGrade }))}><option value="">未评级</option><option>A</option><option>B</option><option>C</option><option>D</option></select></label>
          </section>
          {notice && <div className="notice">{notice}</div>}
        </aside>
      </div>
      {isOcrSettingsOpen && <div className="ocr-modal-backdrop" onMouseDown={() => setIsOcrSettingsOpen(false)}>
        <section className="ocr-modal" role="dialog" aria-modal="true" aria-labelledby="ocr-settings-title" onMouseDown={(event) => event.stopPropagation()}>
          <header className="ocr-modal-header">
            <div className="ocr-modal-title"><span><Settings2 size={18} /></span><div><strong id="ocr-settings-title">OCR 识别方式</strong><small>当前：{ocrDisplayName}</small></div></div>
            <button type="button" onClick={() => setIsOcrSettingsOpen(false)} aria-label="关闭 OCR 设置">×</button>
          </header>
          <div className="ocr-settings-form">
            <label>服务商<select value={ocrDraft.provider} onChange={(event) => setOcrDraft((current) => ({ ...current, provider: event.target.value as OcrProvider }))}>{(Object.keys(ocrProviderLabels) as OcrProvider[]).map((provider) => <option key={provider} value={provider}>{ocrProviderLabels[provider]}</option>)}</select></label>
            {ocrDraft.provider === 'paddle-local' && <div className={`ocr-plugin-status ${paddlePluginStatus?.installed ? 'ready' : 'missing'}`}>
              <div><strong>{paddlePluginStatus?.displayName ?? '本机 PaddleOCR 3（增强插件）'}</strong><span>{paddlePluginStatus?.installed ? `已安装${paddlePluginStatus.version ? ` · ${paddlePluginStatus.version}` : ''}` : '未安装'}</span><p>{paddlePluginStatus?.message ?? '正在检查本机 OCR 插件…'}</p></div>
              <button type="button" className="quiet-button" onClick={() => { void installPaddlePlugin() }} disabled={isInstallingPaddlePlugin}>{isInstallingPaddlePlugin ? '正在安装…' : paddlePluginStatus?.installed ? '重新安装插件' : '选择插件 ZIP 安装'}</button>
            </div>}
            {ocrDraft.provider === 'custom' && <label>接口名称<input value={ocrDraftProfile.interfaceName} onChange={(event) => setOcrDraft((current) => updateOcrProfile(current, current.provider, { interfaceName: event.target.value }))} placeholder="例如：公司内部 OCR" /></label>}
            {ocrDraft.provider === 'custom' && <label>服务器地址<input value={ocrDraftProfile.endpoint} onChange={(event) => setOcrDraft((current) => updateOcrProfile(current, current.provider, { endpoint: event.target.value }))} placeholder="完整的 OpenAI 兼容接口地址" /></label>}
            {ocrDraft.provider !== 'local' && ocrDraft.provider !== 'paddle-local' && <label><span className="ocr-field-label">API Key{ocrProviderApiLinks[ocrDraft.provider] && <button type="button" className="ocr-api-link" aria-label="API 获取" onClick={() => { void openOcrApiLink(ocrDraft.provider) }}>（API 获取）</button>}</span><input type="password" value={ocrDraftProfile.apiKey} onChange={(event) => setOcrDraft((current) => updateOcrProfile(current, current.provider, { apiKey: event.target.value }))} placeholder={ocrDraft.provider === 'paddle-ocr' ? '粘贴 AI Studio Access Token' : '粘贴服务商提供的 API Key'} /></label>}
            {(ocrDraft.provider === 'paddle-ocr' || ocrDraft.provider === 'custom') && <label>模型名称<input value={ocrDraftProfile.model} onChange={(event) => setOcrDraft((current) => updateOcrProfile(current, current.provider, { model: event.target.value }))} placeholder={ocrDraft.provider === 'paddle-ocr' ? 'PP-OCRv6' : '服务器中的视觉/OCR模型名称'} /></label>}
            <label className="ocr-remember"><input type="checkbox" checked={rememberOcrSettings} onChange={(event) => setRememberOcrSettings(event.target.checked)} /> 将设置和密钥保存在本机</label>
          </div>
          <div className="ocr-privacy"><ShieldCheck size={15} /><span>{ocrDraft.provider === 'paddle-local' ? 'Paddle 插件安装后，本机 OCR 完全离线处理；主程序不携带模型和运行时。' : ocrDraft.provider === 'local' ? '基础本机 OCR 完全离线处理；可安装 PaddleOCR 增强插件以提高识别率。' : '云 OCR 只上传右侧附图；正文、权利要求、批注和原始文件不会上传。'}</span></div>
          <footer className="ocr-modal-actions"><button type="button" className="quiet-button" onClick={() => setIsOcrSettingsOpen(false)}>取消</button><button type="button" className="ocr-apply" onClick={applyOcrSettings}>应用识别方式</button></footer>
        </section>
      </div>}
      {LLM_REVIEW_ENABLED && <LlmReviewDialog
        open={isLlmReviewOpen}
        patentText={file.text}
        findings={llmFindings}
        onFindingsChange={(nextFindings, metadata) => {
          setLlmFindings(nextFindings)
          setLlmRunMetadata(metadata)
        }}
        onClose={() => setIsLlmReviewOpen(false)}
        onNotice={setNotice}
      />}
      {expandedFigure && <div className="figure-detail-backdrop" onClick={() => setExpandedFigure(null)}>
        <section className="figure-detail-dialog" role="dialog" aria-modal="true" aria-label={`附图 ${expandedFigure.index + 1} 详情`} onClick={(event) => event.stopPropagation()}>
          <header className="figure-detail-header">
            <div><strong>附图 {expandedFigure.index + 1} · 详情查看</strong><span>滚轮缩放；放大后可拖动滚动条查看细节</span></div>
            <div className="figure-detail-actions">
              <button type="button" onClick={() => setExpandedFigureScale((scale) => Math.max(0.5, scale - 0.25))}>−</button>
              <button type="button" className="figure-detail-scale" onClick={() => setExpandedFigureScale(1)}>{Math.round(expandedFigureScale * 100)}%</button>
              <button type="button" onClick={() => setExpandedFigureScale((scale) => Math.min(4, scale + 0.25))}>＋</button>
              <button type="button" className="figure-detail-close" onClick={() => setExpandedFigure(null)} aria-label="关闭详情">×</button>
            </div>
          </header>
          <div className="figure-detail-stage" onWheel={(event) => {
            event.preventDefault()
            setExpandedFigureScale((scale) => Math.min(4, Math.max(0.5, scale + (event.deltaY < 0 ? 0.15 : -0.15))))
          }}>
            <img src={expandedFigure.source} alt={`附图 ${expandedFigure.index + 1} 放大查看`} style={{ width: `${expandedFigureScale * 100}%` }} />
          </div>
        </section>
      </div>}
      {isAuthorQrOpen && <AuthorQrDialog onClose={() => setIsAuthorQrOpen(false)} />}
      {isExitConfirmOpen && <ExitConfirmDialog isSaving={isSavingBeforeExit} onCancel={cancelExitConfirmation} onExitWithoutSaving={() => { void exitWithoutSaving() }} onSaveAndExit={() => { void saveRevisionAndExit() }} />}
    </main>
  )
}

function ExitConfirmDialog({ isSaving, onCancel, onExitWithoutSaving, onSaveAndExit }: {
  isSaving: boolean
  onCancel: () => void
  onExitWithoutSaving: () => void
  onSaveAndExit: () => void
}) {
  return <div className="exit-confirm-backdrop" role="presentation" onMouseDown={onCancel}>
    <section className="exit-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="exit-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
      <button type="button" className="exit-confirm-close" aria-label="取消退出" onClick={onCancel} disabled={isSaving}><X size={18} /></button>
      <div className="exit-confirm-icon"><Save size={23} /></div>
      <h2 id="exit-confirm-title">退出前是否保存修订版？</h2>
      <p>保存后会在原文件同一目录生成“原文件名-修订版”，不会覆盖原文件。</p>
      <div className="exit-confirm-actions">
        <button type="button" className="exit-confirm-cancel" onClick={onCancel} disabled={isSaving}>取消</button>
        <button type="button" className="exit-confirm-direct" onClick={onExitWithoutSaving} disabled={isSaving}>直接退出</button>
        <button type="button" className="exit-confirm-save" onClick={onSaveAndExit} disabled={isSaving}>{isSaving ? '正在保存修订版…' : '保存修订版再退出'}</button>
      </div>
    </section>
  </div>
}

function PdfPageView({ page, selectable, selectionRects = [] }: { page: PdfPageData; selectable: boolean; selectionRects?: NonNullable<PatentSelectionAnchor['pdfRects']> }) {
  return <section className="pdf-page-shell" data-page-number={page.pageNumber}>
    <div className="pdf-page-content" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
      <img src={page.imageDataUrl} alt={`PDF 第 ${page.pageNumber} 页`} draggable={false} />
      {selectionRects.map((rect, index) => <span key={`${rect.left}-${rect.top}-${index}`} className="persistent-selection-highlight pdf-selection-highlight" style={{ left: `${rect.left * 100}%`, top: `${rect.top * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />)}
      {selectable && <div className="pdf-text-layer" aria-label={`PDF 第 ${page.pageNumber} 页文本层`}>{page.textItems.map((item, index) => <span
        key={`${page.pageNumber}-${index}`}
        className="pdf-text-item"
        style={{
          left: `${(item.left / page.width) * 100}%`,
          top: `${(item.top / page.height) * 100}%`,
          width: `${(item.width / page.width) * 100}%`,
          height: `${(item.height / page.height) * 100}%`,
          fontSize: `${(item.fontSize / page.width) * 100}cqw`,
          fontFamily: item.fontFamily,
          transform: item.angle ? `rotate(${item.angle}rad)` : undefined,
        }}
      >{item.text}</span>)}</div>}
    </div>
    <span className="pdf-page-number">第 {page.pageNumber} 页{page.marker ? ` · ${page.marker}` : ''}</span>
  </section>
}

function BrandWithAuthor({ onFollowAuthor }: { onFollowAuthor: () => void }) {
  return <div className="brand-with-follow">
    <div className="brand"><span className="brand-mark"><img src={brandLogoUrl} alt="" /></span><span>专利阅研</span></div>
    <button type="button" className="follow-author-button" onClick={onFollowAuthor}><QrCode size={14} /> 关注作者</button>
  </div>
}

function AuthorQrDialog({ onClose }: { onClose: () => void }) {
  return <div className="author-qr-backdrop" onMouseDown={onClose}>
    <section className="author-qr-dialog" role="dialog" aria-modal="true" aria-labelledby="author-qr-title" onMouseDown={(event) => event.stopPropagation()}>
      <button type="button" onClick={onClose} aria-label="关闭关注作者弹窗"><X size={18} /></button>
      <span className="eyebrow">关注作者</span>
      <h2 id="author-qr-title">扫码关注，获取更新</h2>
      <img src={authorQrCodeUrl} alt="关注作者公众号二维码" />
      <p>使用微信扫描二维码，关注作者后可及时了解版本更新与使用说明。</p>
    </section>
  </div>
}

function Welcome({ isOpening, isCheckingUpdate, notice, onOpen, onDownloadGuide, onFollowAuthor, onUpdate, updateAvailable, desktop }: { isOpening: boolean; isCheckingUpdate: boolean; notice: string; onOpen: () => void; onDownloadGuide: () => void; onFollowAuthor: () => void; onUpdate: () => void; updateAvailable: boolean; desktop: boolean }) {
  return <main className="welcome-screen">
    <div className="welcome-top">
      <BrandWithAuthor onFollowAuthor={onFollowAuthor} />
      <div className="welcome-top-actions"><span>Windows 本地专利阅读工具</span><button type="button" className={`welcome-update-button ${updateAvailable ? 'has-update' : ''}`} onClick={onUpdate} disabled={isCheckingUpdate}><RefreshCw size={14} className={isCheckingUpdate ? 'spinning-icon' : ''} />{isCheckingUpdate ? '检查中…' : updateAvailable ? '更新可用' : '检查更新'}</button></div>
    </div>
    <section className="welcome-card"><div className="hero-icon"><BookOpenText size={30} /></div><span className="eyebrow">中文专利 · 本地优先</span><h1>从一份文件，读懂一项专利</h1><p>先确认说明书摘要、权利要求书、说明书和附图的位置，再开始图文联动阅读与专业批注。</p><button type="button" className="guide-download-button" onClick={onDownloadGuide}><Download size={15} /> 下载使用说明</button><button className="open-button" onClick={onOpen} disabled={isOpening || !desktop}><FolderOpen size={19} />{isOpening ? '正在读取文件…' : '打开 DOCX 或 PDF'}</button>{!desktop && <p className="desktop-hint">请通过桌面应用运行此工具后打开本地文件。</p>}{notice && <div className="welcome-notice">{notice}</div>}</section>
    <div className="welcome-features"><span><Check size={16} /> 内容仅在本机处理</span><span><Check size={16} /> 原文件不会被覆盖</span><span><Check size={16} /> 生成可交付修订版</span></div>
  </main>
}

function StructureConfirm({ file, sections, detectedCount, onBack, onUpdate, onConfirm }: { file: LoadedFile; sections: PatentSection[]; detectedCount: number; onBack: () => void; onUpdate: (key: SectionKey, value: string) => void; onConfirm: () => void }) {
  const highestDetectedPosition = Math.max(0, ...sections.map((section) => section.start ?? 0))
  const positionCount = Math.max(4, file.pageCount, file.markers.length, highestDetectedPosition)
  const locationOptions = Array.from({ length: positionCount }, (_, index) => {
    const position = index + 1
    const marker = file.markers[index]
    return {
      position,
      label: marker ? `第 ${position} 页 · 页首：${marker}` : `第 ${position} 页 · 未识别页首`,
    }
  })
  return <main className="structure-screen"><header className="structure-header"><div className="brand"><span className="brand-mark">阅</span><span>专利阅研</span></div><button className="quiet-button" onClick={onBack}><ArrowLeft size={16} /> 重新选择文件</button></header><section className="structure-card"><div className="step-badge">01</div><span className="eyebrow">首次打开 · 文档结构确认</span><h1>先确认这份专利的四个阅读区段</h1><p>不同机构的模板和区段顺序可能不同。每个区段以新页的页首为锚点；我们已识别出 <strong>{detectedCount}/4</strong> 个区段。若有误，直接按起始页修正即可。</p><div className="file-chip"><FileText size={17} /> {file.name}<span>{file.extension.toUpperCase()}</span></div><div className="section-cards">{sections.map((section) => <div key={section.key} className="section-card"><div className="section-card-icon">{section.key === 'drawings' ? <Image size={19} /> : <FileText size={19} />}</div><div className="section-card-copy"><strong>{section.label}</strong><span>{sectionCopy[section.key]}</span></div><label>起始页<select value={section.start ?? ''} onChange={(event) => onUpdate(section.key, event.target.value)}><option value="">未识别 / 手动指定</option>{locationOptions.map((option) => <option key={option.position} value={option.position}>{option.label}</option>)}</select></label><span className={`confidence ${section.start ? 'confirmed' : ''}`}>{section.start ? '已识别' : '待确认'}</span></div>)}</div><div className="structure-footer"><span>确认后才会进行本地关联分析，且不会修改原文件。</span><button className="primary-button large" onClick={onConfirm}>确认并开始阅读 <ChevronRight size={17} /></button></div></section></main>
}

export default App
