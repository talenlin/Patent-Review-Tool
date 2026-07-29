import * as pdfjs from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export type PdfTextItem = {
  text: string
  left: number
  top: number
  width: number
  height: number
  fontSize: number
  angle: number
  fontFamily: string
}

export type PdfPageData = {
  pageNumber: number
  text: string
  marker: string
  width: number
  height: number
  imageDataUrl: string
  textItems: PdfTextItem[]
  isDrawing: boolean
}

export type ParsedPdfDocument = {
  plainText: string
  markers: string[]
  pages: PdfPageData[]
}

type PdfJsTextItem = {
  str: string
  dir: string
  transform: number[]
  width: number
  height: number
  fontName: string
  hasEOL: boolean
}

function isPdfTextItem(value: unknown): value is PdfJsTextItem {
  return Boolean(value && typeof value === 'object' && 'str' in value && 'transform' in value)
}

function pageMarker(text: string) {
  const compact = text.replace(/\s+/g, '')
  if (/^说明书摘要/.test(compact)) return '说明书摘要'
  if (/^摘要附图/.test(compact)) return '摘要附图'
  if (/^权利要求书/.test(compact)) return '权利要求书'
  if (/^说明书附图/.test(compact)) return '说明书附图'
  if (/^说明书/.test(compact)) return '说明书'
  return ''
}

function textFromItems(items: PdfJsTextItem[]) {
  let value = ''
  for (const item of items) {
    value += item.str
    if (item.hasEOL) value += '\n'
  }
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function parsePdf(arrayBuffer: ArrayBuffer): Promise<ParsedPdfDocument> {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(arrayBuffer.slice(0)),
    useSystemFonts: true,
  })
  const document = await loadingTask.promise
  const pages: PdfPageData[] = []

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1.25 })
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error(`无法渲染 PDF 第 ${pageNumber} 页`)
    await page.render({ canvas, canvasContext: context, viewport }).promise

    const textContent = await page.getTextContent()
    const sourceItems = textContent.items.filter(isPdfTextItem)
    const text = textFromItems(sourceItems)
    const marker = pageMarker(text)
    const styles = textContent.styles
    const textItems = sourceItems
      .filter((item) => item.str.length > 0)
      .map((item): PdfTextItem => {
        const transform = pdfjs.Util.transform(viewport.transform, item.transform)
        const fontSize = Math.max(1, Math.hypot(transform[2], transform[3]))
        const angle = Math.atan2(transform[1], transform[0])
        return {
          text: item.str,
          left: transform[4],
          top: transform[5] - fontSize,
          width: Math.max(1, item.width * viewport.scale),
          height: Math.max(fontSize, item.height * viewport.scale),
          fontSize,
          angle,
          fontFamily: styles[item.fontName]?.fontFamily || 'sans-serif',
        }
      })

    pages.push({
      pageNumber,
      text,
      marker,
      width: viewport.width,
      height: viewport.height,
      imageDataUrl: canvas.toDataURL('image/jpeg', 0.88),
      textItems,
      isDrawing: marker === '说明书附图' || marker === '摘要附图',
    })
    page.cleanup()
  }

  await document.destroy()
  return {
    plainText: pages.map((page) => page.text).join('\n'),
    markers: pages.map((page) => page.marker),
    pages,
  }
}
