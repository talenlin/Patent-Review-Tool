import type { FigureLabel } from './figure-ocr'
import type { OcrSettings } from './ocr-settings'

type CloudOcrWord = {
  text: string
  left: number
  top: number
  width: number
  height: number
  confidence: number
}

function imageDataUrl(image: HTMLImageElement) {
  const source = image.currentSrc || image.src
  if (source.startsWith('data:image/')) return source
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth || image.width
  canvas.height = image.naturalHeight || image.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法准备云 OCR 附图')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

function exactKnownNumbers(text: string, knownNumbers: ReadonlySet<string>) {
  const normalised = text.replace(/[Oo]/g, '0')
  const tokens = normalised.match(/[A-Za-z]?\d{1,8}[A-Za-z]?|[A-Za-z]/g) ?? []
  return [...new Set(tokens.filter((token) => token !== '0' && knownNumbers.has(token)))]
}

export async function recognizeCloudFigureLabels(
  images: HTMLImageElement[],
  settings: OcrSettings,
  knownNumbers: ReadonlySet<string>,
  onProgress: (finished: number, total: number) => void,
): Promise<{ labels: FigureLabel[]; wordCount: number; imageCount: number }> {
  if (!window.patentReader?.cloudOcr) throw new Error('当前桌面程序尚未启用本机 PaddleOCR / 云 OCR 桥接')
  const labels: FigureLabel[] = []
  let wordCount = 0
  for (const [imageIndex, image] of images.entries()) {
    const result = await window.patentReader.cloudOcr({
      ...settings,
      imageDataUrl: imageDataUrl(image),
      imageWidth: image.naturalWidth || image.width,
      imageHeight: image.naturalHeight || image.height,
    })
    wordCount += result.words.length
    for (const word of result.words as CloudOcrWord[]) {
      for (const number of exactKnownNumbers(word.text, knownNumbers)) {
        labels.push({
          imageIndex,
          number,
          left: Math.min(96, Math.max(2, word.left)),
          top: Math.min(96, Math.max(2, word.top)),
          confidence: word.confidence,
        })
      }
    }
    onProgress(imageIndex + 1, images.length)
  }
  return { labels, wordCount, imageCount: images.length }
}
