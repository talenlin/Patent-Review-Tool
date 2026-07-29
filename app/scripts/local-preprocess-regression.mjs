import assert from 'node:assert/strict'
import { preprocessPatentDrawingPixels } from '../src/patent-image-preprocess.ts'

const width = 80
const height = 40
const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
const ink = (x, y) => {
  const index = (y * width + x) * 4
  pixels[index] = 0
  pixels[index + 1] = 0
  pixels[index + 2] = 0
  pixels[index + 3] = 255
}

for (let x = 0; x < width; x += 1) ink(x, 24)
for (const [x, y] of [[9, 6], [10, 6], [11, 6], [11, 7], [10, 8], [9, 9], [10, 10], [11, 10]]) ink(x, y)

const result = preprocessPatentDrawingPixels(pixels, width, height)
assert.ok(result.longLinePixelsRemoved >= width, '长直参考线应从 OCR 图层中移除')
assert.ok(result.candidatePixelsKept > 0, '孤立数字候选应保留在 Alpha-Shape ROI 中')
assert.equal(result.data[(24 * width + 40) * 4], 255, '被移除的长直线应恢复为白色背景')

console.log('专利附图本地 OCR 预处理回归检查通过')
