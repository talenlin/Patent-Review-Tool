import { createWorker, PSM } from 'tesseract.js'
import { preprocessPatentDrawingPixels } from './patent-image-preprocess'
import { expandOcrNumberFragments, resolveKnownNumber, type OcrNumberFragment } from './ocr-number-resolution'

export type FigureLabel = {
  imageIndex: number
  number: string
  left: number
  top: number
  confidence: number
}

type PreparedFigure = {
  canvas: HTMLCanvasElement
  filteredSource: string
  width: number
  height: number
}

type OcrRegion = {
  source: string
  width: number
  height: number
  offsetX: number
  offsetY: number
  scaleX: number
  scaleY: number
  modes: PSM[]
  acceptsLowConfidenceKnownNumbers?: boolean
  recoverRepeatedDigitCandidate?: boolean
}

function assetPath(relativePath: string) {
  return new URL(relativePath, window.location.href).toString()
}

function wordsFromBlocks(blocks: Tesseract.Block[] | null): OcrNumberFragment[] {
  if (!blocks) return []
  return blocks.flatMap((block) => block.paragraphs)
    .flatMap((paragraph) => paragraph.lines)
    .flatMap((line) => expandOcrNumberFragments(line.words.map((word) => ({
      text: word.text,
      confidence: word.confidence,
      bbox: word.bbox,
    }))))
}

function strengthenThinDrawingLines(context: CanvasRenderingContext2D, width: number, height: number) {
  const pixels = context.getImageData(0, 0, width, height)
  const foreground = new Uint8Array(width * height)

  // Patent figures commonly use one-pixel, outlined numerals. Binarising and
  // widening the ink by one pixel preserves every digit before Tesseract sees
  // it, especially in labels such as 122 and 221 beside leader lines.
  for (let pixelIndex = 0; pixelIndex < foreground.length; pixelIndex += 1) {
    const channelIndex = pixelIndex * 4
    foreground[pixelIndex] = pixels.data[channelIndex]
      + pixels.data[channelIndex + 1]
      + pixels.data[channelIndex + 2] < 690 ? 1 : 0
  }

  const strengthened = new Uint8Array(foreground)
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (foreground[(y + offsetY) * width + x + offsetX]) {
            strengthened[y * width + x] = 1
          }
        }
      }
    }
  }

  for (let pixelIndex = 0; pixelIndex < strengthened.length; pixelIndex += 1) {
    const channelIndex = pixelIndex * 4
    const value = strengthened[pixelIndex] ? 0 : 255
    pixels.data[channelIndex] = value
    pixels.data[channelIndex + 1] = value
    pixels.data[channelIndex + 2] = value
    pixels.data[channelIndex + 3] = 255
  }
  context.putImageData(pixels, 0, 0)
}

function binariseThinDrawingLines(context: CanvasRenderingContext2D, width: number, height: number) {
  const pixels = context.getImageData(0, 0, width, height)
  for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += 1) {
    const channelIndex = pixelIndex * 4
    const value = pixels.data[channelIndex] + pixels.data[channelIndex + 1] + pixels.data[channelIndex + 2] < 690 ? 0 : 255
    pixels.data[channelIndex] = value
    pixels.data[channelIndex + 1] = value
    pixels.data[channelIndex + 2] = value
    pixels.data[channelIndex + 3] = 255
  }
  context.putImageData(pixels, 0, 0)
}

function prepareForOcr(image: HTMLImageElement): PreparedFigure {
  // Keep enough pixels for the thin outlined numerals used in Chinese patent drawings.
  const scale = 3
  const canvas = document.createElement('canvas')
  canvas.width = (image.naturalWidth || image.width) * scale
  canvas.height = (image.naturalHeight || image.height) * scale
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('无法创建附图识别画布')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  strengthenThinDrawingLines(context, canvas.width, canvas.height)

  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  const sourceCanvas = document.createElement('canvas')
  sourceCanvas.width = sourceWidth
  sourceCanvas.height = sourceHeight
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
  if (!sourceContext) throw new Error('无法创建附图预处理画布')
  sourceContext.drawImage(image, 0, 0, sourceWidth, sourceHeight)
  const sourcePixels = sourceContext.getImageData(0, 0, sourceWidth, sourceHeight)
  const filtered = preprocessPatentDrawingPixels(sourcePixels.data, sourceWidth, sourceHeight)
  const filteredPixels = new Uint8ClampedArray(filtered.data.length)
  filteredPixels.set(filtered.data)
  sourceContext.putImageData(new ImageData(filteredPixels, sourceWidth, sourceHeight), 0, 0)
  const filteredCanvas = document.createElement('canvas')
  filteredCanvas.width = canvas.width
  filteredCanvas.height = canvas.height
  const filteredContext = filteredCanvas.getContext('2d', { willReadFrequently: true })
  if (!filteredContext) throw new Error('无法创建附图文字候选画布')
  filteredContext.imageSmoothingEnabled = false
  filteredContext.drawImage(sourceCanvas, 0, 0, filteredCanvas.width, filteredCanvas.height)
  strengthenThinDrawingLines(filteredContext, filteredCanvas.width, filteredCanvas.height)
  return {
    canvas,
    filteredSource: filteredCanvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
  }
}

function cropRegion(figure: PreparedFigure, left: number, top: number, right: number, bottom: number, modes: PSM[]): OcrRegion {
  const cropLeft = Math.max(0, Math.floor(left))
  const cropTop = Math.max(0, Math.floor(top))
  const cropRight = Math.min(figure.width, Math.ceil(right))
  const cropBottom = Math.min(figure.height, Math.ceil(bottom))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, cropRight - cropLeft)
  canvas.height = Math.max(1, cropBottom - cropTop)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建附图局部识别画布')
  context.drawImage(figure.canvas, cropLeft, cropTop, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
  return {
    source: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
    offsetX: cropLeft,
    offsetY: cropTop,
    scaleX: 1,
    scaleY: 1,
    modes,
  }
}

function cropOriginalMargin(
  image: HTMLImageElement,
  figure: PreparedFigure,
  left: number,
  top: number,
  right: number,
  bottom: number,
  modes: PSM[] = [PSM.SINGLE_BLOCK],
  scale = 4,
  preserveFineContours = false,
  recoverRepeatedDigitCandidate = false,
): OcrRegion {
  const cropLeft = Math.max(0, Math.floor(left))
  const cropTop = Math.max(0, Math.floor(top))
  const cropRight = Math.min(image.naturalWidth, Math.ceil(right))
  const cropBottom = Math.min(image.naturalHeight, Math.ceil(bottom))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, (cropRight - cropLeft) * scale)
  canvas.height = Math.max(1, (cropBottom - cropTop) * scale)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Unable to create patent figure margin canvas')
  context.drawImage(
    image,
    cropLeft,
    cropTop,
    cropRight - cropLeft,
    cropBottom - cropTop,
    0,
    0,
    canvas.width,
    canvas.height,
  )
  // The outlined digits in some drawings (notably the small top-right “22”)
  // lose their inner white space if every line is dilated. Keep one enlarged
  // source pass untouched so those contours remain distinguishable.
  if (preserveFineContours) binariseThinDrawingLines(context, canvas.width, canvas.height)
  else strengthenThinDrawingLines(context, canvas.width, canvas.height)

  return {
    source: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
    offsetX: cropLeft * (figure.width / image.naturalWidth),
    offsetY: cropTop * (figure.height / image.naturalHeight),
    scaleX: figure.width / image.naturalWidth / scale,
    scaleY: figure.height / image.naturalHeight / scale,
    modes,
    acceptsLowConfidenceKnownNumbers: true,
    recoverRepeatedDigitCandidate,
  }
}

function buildOcrRegions(figure: PreparedFigure, image: HTMLImageElement, originalSource: string, originalWidth: number, originalHeight: number): OcrRegion[] {
  const allModes = [PSM.AUTO, PSM.SPARSE_TEXT, PSM.SINGLE_BLOCK]
  const regions: OcrRegion[] = [{
    source: originalSource,
    width: originalWidth,
    height: originalHeight,
    offsetX: 0,
    offsetY: 0,
    scaleX: figure.width / originalWidth,
    scaleY: figure.height / originalHeight,
    modes: allModes,
  }, {
    source: figure.filteredSource,
    width: figure.width,
    height: figure.height,
    offsetX: 0,
    offsetY: 0,
    scaleX: 1,
    scaleY: 1,
    modes: [PSM.AUTO, PSM.SPARSE_TEXT, PSM.SINGLE_BLOCK],
    acceptsLowConfidenceKnownNumbers: true,
  }, {
    source: figure.canvas.toDataURL('image/png'),
    width: figure.width,
    height: figure.height,
    offsetX: 0,
    offsetY: 0,
    scaleX: 1,
    scaleY: 1,
    modes: allModes,
  }]

  // Patent drawings put most labels at the margins. Local crops let the OCR separate them
  // from leader lines and section hatching without changing the original figure.
  regions.push(
    cropRegion(figure, 0, 0, figure.width * 0.6, figure.height, [PSM.SINGLE_BLOCK]),
    cropRegion(figure, figure.width * 0.4, 0, figure.width, figure.height, [PSM.SINGLE_BLOCK]),
    // Reference numerals are normally arranged around the outer edge of a
    // patent drawing. These enlarged margin passes retain thin, outlined
    // multi-digit labels that a full-figure pass can split or truncate.
    cropOriginalMargin(image, figure, 0, 0, originalWidth * 0.18, originalHeight),
    cropOriginalMargin(image, figure, originalWidth * 0.83, 0, originalWidth, originalHeight),
    // The upper-right callouts often sit inside the drawing bounds instead of
    // at the page edge. Scan this band separately so 22 / 3 style labels do
    // not get lost among leader lines and spring hatching.
    cropOriginalMargin(
      image,
      figure,
      originalWidth * 0.58,
      0,
      originalWidth,
      originalHeight * 0.42,
      [PSM.AUTO, PSM.SPARSE_TEXT, PSM.SINGLE_BLOCK],
    ),
    cropOriginalMargin(
      image,
      figure,
      originalWidth * 0.68,
      0,
      originalWidth,
      originalHeight * 0.18,
      [PSM.SINGLE_BLOCK, PSM.SINGLE_LINE, PSM.SINGLE_WORD],
      6,
    ),
    cropOriginalMargin(
      image,
      figure,
      originalWidth * 0.7,
      0,
      originalWidth * 0.92,
      originalHeight * 0.11,
      [PSM.SINGLE_WORD],
      8,
    ),
    // A high-resolution, contour-preserving pass for compact callouts near
    // the upper-right of a sectional drawing. It complements the general
    // margin pass rather than narrowing the set of labels we enumerate.
    cropOriginalMargin(
      image,
      figure,
      originalWidth * 0.77,
      originalHeight * 0.045,
      originalWidth * 0.94,
      originalHeight * 0.12,
      [PSM.SINGLE_LINE, PSM.SINGLE_WORD, PSM.SPARSE_TEXT],
      10,
      true,
      true,
    ),
  )
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const overlap = 0.08
      regions.push(cropRegion(
        figure,
        (column / 3 - overlap) * figure.width,
        (row / 3 - overlap) * figure.height,
        ((column + 1) / 3 + overlap) * figure.width,
        ((row + 1) / 3 + overlap) * figure.height,
        [PSM.SINGLE_BLOCK],
      ))
    }
  }
  return regions
}

export async function recognizeFigureLabels(
  images: HTMLImageElement[],
  onProgress: (finished: number, total: number) => void,
  knownNumbers: ReadonlySet<string> = new Set(),
): Promise<FigureLabel[]> {
  if (images.length === 0) return []

  const worker = await createWorker('eng', 1, {
    workerPath: assetPath('ocr/worker.min.js'),
    corePath: assetPath('ocr/tesseract-core-simd-lstm.wasm.js'),
    langPath: assetPath('tessdata/'),
    gzip: false,
    workerBlobURL: false,
  })

  try {
    const labels: FigureLabel[] = []
    for (const [imageIndex, image] of images.entries()) {
      const figure = prepareForOcr(image)
      const imageLabels = new Map<string, FigureLabel>()
      for (const region of buildOcrRegions(figure, image, image.currentSrc || image.src, image.naturalWidth, image.naturalHeight)) {
        for (const mode of region.modes) {
          await worker.setParameters({
            tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
            tessedit_pageseg_mode: mode,
          })
          const result = await worker.recognize(region.source, {}, { blocks: true })
          for (const word of wordsFromBlocks(result.data.blocks)) {
            const number = resolveKnownNumber(
              word.text,
              knownNumbers,
              region.recoverRepeatedDigitCandidate,
              word.confidence,
            )
            // Treat a solitary 0 as background/OCR noise by default. Values
            // such as 10 and 100 remain valid reference numerals.
            if (number === '0') continue
            if (knownNumbers.size > 0 && !knownNumbers.has(number)) continue
            const minimumConfidence = region.acceptsLowConfidenceKnownNumbers && number.length > 1
              ? 0
              : knownNumbers.has(number) ? 30 : 55
            if (!/^(?:[A-Za-z]?\d{1,8}[A-Za-z]?|[A-Za-z])$/.test(number) || word.confidence < minimumConfidence) continue
            const label: FigureLabel = {
              imageIndex,
              number,
              left: ((word.bbox.x0 * region.scaleX + region.offsetX) / figure.width) * 100,
              top: ((word.bbox.y0 * region.scaleY + region.offsetY) / figure.height) * 100,
              confidence: word.confidence,
            }
            const key = `${number}-${Math.round(label.left / 3)}-${Math.round(label.top / 3)}`
            const current = imageLabels.get(key)
            if (!current || current.confidence < label.confidence) imageLabels.set(key, label)
          }
        }
      }
      labels.push(...imageLabels.values())
      onProgress(imageIndex + 1, images.length)
    }
    return labels
  } finally {
    await worker.terminate()
  }
}
