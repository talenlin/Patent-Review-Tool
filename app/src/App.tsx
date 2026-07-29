import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle, ArrowLeft, BookOpenText, Check, ChevronDown, ChevronRight, ChevronUp, FileText, FolderOpen,
  Cloud, Highlighter, Image, MessageSquarePlus, PanelLeftClose, PanelLeftOpen, Plus, Save, Settings2, ShieldCheck, Sparkles, Tag, Trash2, Undo2,
} from 'lucide-react'
import './App.css'
import { recognizeCloudFigureLabels } from './cloud-ocr'
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
import { analyzeClaimAntecedentBasis, type ClaimIssue } from './claim-antecedent-analysis'

type LoadedFile = {
  path: string
  name: string
  extension: 'docx' | 'pdf'
  base64: string
  html: string
  text: string
  markers: string[]
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
  const [figureStatus, setFigureStatus] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle')
  const [figureProgress, setFigureProgress] = useState({ finished: 0, total: 0 })
  const [figureLabels, setFigureLabels] = useState<FigureLabel[]>([])
  const [figureError, setFigureError] = useState('')
  const [ocrSettingsStore, setOcrSettingsStore] = useState<OcrSettingsStore>(getStoredOcrSettings)
  const [ocrDraft, setOcrDraft] = useState<OcrSettingsStore>(getStoredOcrSettings)
  const [rememberOcrSettings, setRememberOcrSettings] = useState(true)
  const [isOcrSettingsOpen, setIsOcrSettingsOpen] = useState(false)
  const [cloudOcrUsage, setCloudOcrUsage] = useState<CloudOcrUsage | null>(null)
  const [isAssociationCollapsed, setIsAssociationCollapsed] = useState(false)
  const [isClaimBasisCollapsed, setIsClaimBasisCollapsed] = useState(false)
  const [activeClaimIssueId, setActiveClaimIssueId] = useState<string | null>(null)
  const [ratings, setRatings] = useState<PatentRatings>(emptyRatings)
  const [expandedFigure, setExpandedFigure] = useState<{ source: string; index: number } | null>(null)
  const [expandedFigureScale, setExpandedFigureScale] = useState(1)
  const [notice, setNotice] = useState('')
  const [isOpening, setIsOpening] = useState(false)
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
  const isDesktop = Boolean(window.patentReader)

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
  useEffect(() => {
    const root = readingRef.current
    if (!root) return
    root.querySelectorAll<HTMLElement>('[data-reference-highlight]').forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent ?? '')))
    root.querySelectorAll<HTMLElement>('.reference-block-highlight').forEach((block) => block.classList.remove('reference-block-highlight'))
    root.querySelectorAll<HTMLElement>('.reference-page-highlight').forEach((page) => page.classList.remove('reference-page-highlight'))
    root.querySelectorAll<HTMLElement>('.reference-text-highlight').forEach((item) => item.classList.remove('reference-text-highlight'))
    if (!mappingConfirmed || !activeReference) return
    const reference = references.find((item) => item.id === activeReference)
    if (!reference) return

    if (file?.extension === 'pdf') {
      const compactId = reference.id.replace(/\s+/g, '')
      const matchingPage = file.pdfPages.find((page) => page.text.replace(/\s+/g, '').includes(compactId))
        ?? file.pdfPages.find((page) => page.text.includes(reference.name) && page.text.includes(reference.number))
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
        pageElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      return
    }

    const blocks = Array.from(root.querySelectorAll<HTMLElement>('p, h1, h2, h3, li'))
    const matchingBlocks = blocks.filter((block) => block.textContent?.includes(reference.name) && block.textContent.includes(reference.number))
    matchingBlocks.forEach((block) => block.classList.add('reference-block-highlight'))

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    let node = walker.nextNode()
    while (node) {
      if (node.textContent?.includes(reference.id)) textNodes.push(node as Text)
      node = walker.nextNode()
    }
    textNodes.forEach((textNode) => {
      const start = textNode.textContent?.indexOf(reference.id) ?? -1
      if (start < 0) return
      const range = document.createRange()
      range.setStart(textNode, start)
      range.setEnd(textNode, start + reference.id.length)
      const mark = document.createElement('mark')
      mark.dataset.referenceHighlight = 'true'
      mark.className = 'reference-highlight'
      range.surroundContents(mark)
    })

    const target = root.querySelector<HTMLElement>('[data-reference-highlight], .reference-block-highlight')
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeReference, file, mappingConfirmed, references, stage])

  // Claim-basis findings are marked at term level so a single diagnostic does
  // not visually imply that the entire claim is defective.
  useEffect(() => {
    const root = readingRef.current
    if (!root) return
    root.querySelectorAll<HTMLElement>('[data-claim-issue-highlight]').forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent ?? '')))
    root.querySelectorAll<HTMLElement>('.claim-issue-text-highlight').forEach((item) => item.classList.remove('claim-issue-text-highlight'))
    if (!activeClaimIssueId) return
    const issue = claimBasisAnalysis.issues.find((item) => item.id === activeClaimIssueId)
    if (!issue) return
    const claimStartPattern = new RegExp(`^\\s*${issue.claimNumber}\\s*[.．、]`)
    if (file?.extension === 'pdf') {
      const page = file.pdfPages.find((candidate) => claimStartPattern.test(candidate.text))
      const pageElement = page ? root.querySelector<HTMLElement>(`.pdf-page-shell[data-page-number="${page.pageNumber}"]`) : null
      if (pageElement) {
        pageElement.querySelectorAll<HTMLElement>('.pdf-text-item').forEach((item) => {
          if (item.textContent?.includes(issue.term)) item.classList.add('claim-issue-text-highlight')
        })
        pageElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
      return
    }
    const block = Array.from(root.querySelectorAll<HTMLElement>('p, h1, h2, h3, li'))
      .find((candidate) => claimStartPattern.test(candidate.textContent ?? ''))
    if (block) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        const textNode = node as Text
        const start = textNode.textContent?.indexOf(issue.term) ?? -1
        if (start >= 0) {
          const range = document.createRange()
          range.setStart(textNode, start)
          range.setEnd(textNode, start + issue.term.length)
          const mark = document.createElement('mark')
          mark.dataset.claimIssueHighlight = 'true'
          mark.className = 'claim-issue-inline-highlight'
          range.surroundContents(mark)
          break
        }
        node = walker.nextNode()
      }
      block.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [activeClaimIssueId, claimBasisAnalysis, file, stage])

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
        let rawLabels: FigureLabel[]
        if (ocrSettings.provider === 'local') {
          rawLabels = await import('./figure-ocr').then(({ recognizeFigureLabels }) => recognizeFigureLabels(images, progress, knownNumbers))
        } else {
          const cloudResult = await recognizeCloudFigureLabels(images, ocrSettings, knownNumbers, progress)
          rawLabels = cloudResult.labels
          setCloudOcrUsage({
            provider: ocrSettings.provider,
            imageCount: cloudResult.imageCount,
            wordCount: cloudResult.wordCount,
          })
        }
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
    setActiveReference(reference.id)
    setMode('review')
    setNotice(`已定位并高亮：${reference.name} ${reference.number}`)
  }

  function navigateToClaimIssue(issue: ClaimIssue) {
    setActiveClaimIssueId(issue.id)
    setActiveSection('claims')
    setMode('review')
    setNotice(`已定位权利要求 ${issue.claimNumber}：${issue.message}`)
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
    if (draft.provider !== 'local' && !draft.apiKey.trim()) {
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
    setNotice(draft.provider === 'local'
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
      let previewUrl: string | null = null
      let pdfPages: PdfPageData[] = []
      if (selected.extension === 'docx') {
        const parsed = await parseDocx(bytes)
        html = parsed.html
        text = parsed.plainText
        markers = parsed.markers
      } else {
        const parsed = await parsePdf(bytes)
        text = parsed.plainText
        markers = parsed.markers
        pdfPages = parsed.pages
      }
      const foundSections = detectSections(text, markers)
      const candidates = extractReferenceCandidates(text)
      const groups = groupReferences(candidates)
      setFile({ ...selected, html, text, markers, previewUrl, pdfPages, sections: foundSections })
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
      setActiveSection('description')
      setMode('reading')
      setAnnotations([])
      setRatings({ ...emptyRatings })
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

  async function saveRevision() {
    if (!file || !window.patentReader) return
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
    const result = await window.patentReader.saveRevision(file.path, payload, {
      technicalUnderstanding: ratings.technicalUnderstanding,
      communication: ratings.communication,
      patentQuality: ratings.patentQuality,
    })
    const details = [annotations.length ? `${annotations.length} 条批注` : '', ratingLines.length ? '整体评级' : ''].filter(Boolean).join('及')
    const ratingNotice = result.ratingPath ? `；评分表：${result.ratingPath}` : ''
    setNotice(details
      ? `已生成修订版并写入${details}：${result.revisionPath}${ratingNotice}`
      : `已生成修订版：${result.revisionPath}${ratingNotice}`)
  }

  if (stage === 'welcome') return <Welcome isOpening={isOpening} notice={notice} onOpen={() => { void openDocument(false) }} desktop={isDesktop} />

  if (stage === 'structure' && file) {
    return <StructureConfirm file={file} sections={sections} detectedCount={detectedCount} onBack={() => setStage('welcome')} onUpdate={updateSectionStart} onConfirm={() => setStage('workspace')} />
  }

  if (!file) return null
  const pdfDrawingPages = file.pdfPages.filter((page) => (
    pdfSectionForPage(page.pageNumber, sections) === 'drawings' || page.isDrawing
  ))
  const pdfTextPages = file.pdfPages.filter((page) => !pdfDrawingPages.includes(page))

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand"><span className="brand-mark">阅</span><span>专利阅研</span></div>
        <div className="document-title"><FileText size={16} /><span>{file.name}</span><span className="analysis-pill"><Sparkles size={13} /> 本地分析就绪</span></div>
        <div className="header-actions"><button type="button" className="header-option-button" onClick={openOcrSettings} title="设置 OCR 识别方式" aria-label={`OCR 设置，当前为${ocrDisplayName}`}><Cloud size={17} /><span>{ocrDisplayName}</span></button><button type="button" className="header-icon-button" onClick={() => { void openDocument(true) }} disabled={isOpening} title="打开新文档" aria-label="打开新文档"><FolderOpen size={18} /></button><button className="quiet-button" onClick={() => setStage('structure')}>文档结构</button><button className="primary-button" onClick={saveRevision}><Save size={16} /> 保存修订版</button></div>
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
            <div className="nav-spacer" /><div className="privacy-note">正文与批注仅在本机处理<br />{ocrSettings.provider === 'local' ? '云端增强未启用' : `仅附图启用 ${ocrProviderLabels[ocrSettings.provider]}`}</div>
          </>}
        </nav>

        <section className="reading-pane">
          <div className="pane-toolbar"><div><span className="eyebrow">{mode === 'reading' ? '理解模式' : '审阅模式'}</span><h1>{sections.find((item) => item.key === activeSection)?.label}</h1></div><div className="mode-tabs"><button className={mode === 'reading' ? 'active' : ''} onClick={() => setMode('reading')}>阅读</button><button className={mode === 'review' ? 'active' : ''} onClick={() => setMode('review')}>审阅</button></div></div>
          <div className="dual-reader">
            <section className="text-reader"><div className="reader-subheader"><FileText size={15} /> 全文阅读 <span>{file.extension === 'pdf' ? `${pdfTextPages.length} 页` : ''}</span></div>{file.extension === 'pdf'
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
              ? <button type="button" className="claim-basis-summary" onClick={() => setIsClaimBasisCollapsed(false)}><AlertTriangle size={14} /><span>{claimBasisAnalysis.claims.length ? `已校验 ${claimBasisAnalysis.claims.length} 项权利要求${claimBasisAnalysis.issues.length ? `，发现 ${claimBasisAnalysis.issues.length} 项待核对` : '，未发现需提示事项'}` : '未识别到权利要求书正文'}</span></button>
              : <>
                <p className="claim-basis-description">核对“所述 / 该 / 上述”等定指用语是否能沿从属引用链追溯到首次引入；多项从属按每条路径分别校验。</p>
                {claimBasisAnalysis.claims.length === 0
                  ? <div className="claim-basis-empty">暂未识别到可解析的权利要求条目。请先在“文档结构”中确认权利要求书位置。</div>
                  : claimBasisAnalysis.issues.length === 0
                    ? <div className="claim-basis-clear"><Check size={16} /> 已校验 {claimBasisAnalysis.claims.length} 项权利要求，暂未发现需要人工核对的引用基础问题。</div>
                    : <div className="claim-issue-list">{claimBasisAnalysis.issues.map((issue) => <button key={issue.id} type="button" className={`claim-issue ${activeClaimIssueId === issue.id ? 'active' : ''}`} onClick={() => navigateToClaimIssue(issue)}><div><span className={`claim-issue-severity ${issue.severity}`}>{issue.severity}</span><strong>权 {issue.claimNumber} · {issue.term}</strong></div><p>{issue.message}</p><small>{issue.sources.length ? `引用基础：${issue.sources.map((source) => `权${source.claimNumber}“${source.term}”${source.preamble ? '（前序）' : ''}`).join('；')}` : `已检查 ${issue.paths.length} 条继承路径，未找到首次引入。`}</small></button>)}</div>}
              </>}
          </section>
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
            {ocrDraft.provider === 'custom' && <label>接口名称<input value={ocrDraftProfile.interfaceName} onChange={(event) => setOcrDraft((current) => updateOcrProfile(current, current.provider, { interfaceName: event.target.value }))} placeholder="例如：公司内部 OCR" /></label>}
            {ocrDraft.provider === 'custom' && <label>服务器地址<input value={ocrDraftProfile.endpoint} onChange={(event) => setOcrDraft((current) => updateOcrProfile(current, current.provider, { endpoint: event.target.value }))} placeholder="完整的 OpenAI 兼容接口地址" /></label>}
            {ocrDraft.provider !== 'local' && <label><span className="ocr-field-label">API Key{ocrProviderApiLinks[ocrDraft.provider] && <button type="button" className="ocr-api-link" aria-label="API 获取" onClick={() => { void openOcrApiLink(ocrDraft.provider) }}>（API 获取）</button>}</span><input type="password" value={ocrDraftProfile.apiKey} onChange={(event) => setOcrDraft((current) => updateOcrProfile(current, current.provider, { apiKey: event.target.value }))} placeholder={ocrDraft.provider === 'paddle-ocr' ? '粘贴 AI Studio Access Token' : '粘贴服务商提供的 API Key'} /></label>}
            {(ocrDraft.provider === 'paddle-ocr' || ocrDraft.provider === 'custom') && <label>模型名称<input value={ocrDraftProfile.model} onChange={(event) => setOcrDraft((current) => updateOcrProfile(current, current.provider, { model: event.target.value }))} placeholder={ocrDraft.provider === 'paddle-ocr' ? 'PP-OCRv6' : '服务器中的视觉/OCR模型名称'} /></label>}
            <label className="ocr-remember"><input type="checkbox" checked={rememberOcrSettings} onChange={(event) => setRememberOcrSettings(event.target.checked)} /> 将设置和密钥保存在本机</label>
          </div>
          <div className="ocr-privacy"><ShieldCheck size={15} /><span>{ocrDraft.provider === 'local' ? '本机 OCR 完全离线处理。' : '云 OCR 只上传右侧附图；正文、权利要求、批注和原始文件不会上传。'}</span></div>
          <footer className="ocr-modal-actions"><button type="button" className="quiet-button" onClick={() => setIsOcrSettingsOpen(false)}>取消</button><button type="button" className="ocr-apply" onClick={applyOcrSettings}>应用识别方式</button></footer>
        </section>
      </div>}
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
    </main>
  )
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

function Welcome({ isOpening, notice, onOpen, desktop }: { isOpening: boolean; notice: string; onOpen: () => void; desktop: boolean }) {
  return <main className="welcome-screen"><div className="welcome-top"><div className="brand"><span className="brand-mark">阅</span><span>专利阅研</span></div><span>Windows 本地专利阅读工具</span></div><section className="welcome-card"><div className="hero-icon"><BookOpenText size={30} /></div><span className="eyebrow">中文专利 · 本地优先</span><h1>从一份文件，读懂一项专利</h1><p>先确认说明书摘要、权利要求书、说明书和附图的位置，再开始图文联动阅读与专业批注。</p><button className="open-button" onClick={onOpen} disabled={isOpening || !desktop}><FolderOpen size={19} />{isOpening ? '正在读取文件…' : '打开 DOCX 或 PDF'}</button>{!desktop && <p className="desktop-hint">请通过桌面应用运行此工具后打开本地文件。</p>}{notice && <div className="welcome-notice">{notice}</div>}</section><div className="welcome-features"><span><Check size={16} /> 内容仅在本机处理</span><span><Check size={16} /> 原文件不会被覆盖</span><span><Check size={16} /> 生成可交付修订版</span></div></main>
}

function StructureConfirm({ file, sections, detectedCount, onBack, onUpdate, onConfirm }: { file: LoadedFile; sections: PatentSection[]; detectedCount: number; onBack: () => void; onUpdate: (key: SectionKey, value: string) => void; onConfirm: () => void }) {
  const highestDetectedPosition = Math.max(0, ...sections.map((section) => section.start ?? 0))
  const positionCount = Math.max(4, file.markers.length, highestDetectedPosition)
  const locationOptions = Array.from({ length: positionCount }, (_, index) => {
    const position = index + 1
    const marker = file.markers[index]
    return {
      position,
      label: file.extension === 'pdf'
        ? `第 ${position} 页：${marker || '未识别页首'}`
        : marker ? `第 ${position} 个页首：${marker}` : `第 ${position} 个页首/标题`,
    }
  })
  return <main className="structure-screen"><header className="structure-header"><div className="brand"><span className="brand-mark">阅</span><span>专利阅研</span></div><button className="quiet-button" onClick={onBack}><ArrowLeft size={16} /> 重新选择文件</button></header><section className="structure-card"><div className="step-badge">01</div><span className="eyebrow">首次打开 · 文档结构确认</span><h1>先确认这份专利的四个阅读区段</h1><p>不同机构的模板和区段顺序可能不同。我们已按页首与标题识别出 <strong>{detectedCount}/4</strong> 个区段；请花几秒核对后再开始分析。</p><div className="file-chip"><FileText size={17} /> {file.name}<span>{file.extension.toUpperCase()}</span></div><div className="section-cards">{sections.map((section) => <div key={section.key} className="section-card"><div className="section-card-icon">{section.key === 'drawings' ? <Image size={19} /> : <FileText size={19} />}</div><div className="section-card-copy"><strong>{section.label}</strong><span>{sectionCopy[section.key]}</span></div><label>识别位置<select value={section.start ?? ''} onChange={(event) => onUpdate(section.key, event.target.value)}><option value="">未识别 / 手动指定</option>{locationOptions.map((option) => <option key={option.position} value={option.position}>{option.label}</option>)}</select></label><span className={`confidence ${section.start ? 'confirmed' : ''}`}>{section.start ? '已识别' : '待确认'}</span></div>)}</div><div className="structure-footer"><span>确认后才会进行本地关联分析，且不会修改原文件。</span><button className="primary-button large" onClick={onConfirm}>确认并开始阅读 <ChevronRight size={17} /></button></div></section></main>
}

export default App
