import assert from 'node:assert/strict'
import { expandOcrNumberFragments, resolveKnownNumber } from '../src/ocr-number-resolution.ts'

const knownNumbers = new Set(['2011', '30'])

// On dense circuit figures the final outlined digit is commonly detached or
// lost by a local OCR pass. The confirmed mapping must recover the uniquely
// compatible four-digit reference instead of dropping the label.
assert.equal(
  resolveKnownNumber('201', knownNumbers, false, 42),
  '2011',
  '已确认的四位标号 2011 不应因 OCR 漏读末位而被过滤',
)

assert.equal(
  resolveKnownNumber('201l', new Set(['2011']), false, 42),
  '2011',
  '四位标号末位被识别为字母 l 时，应恢复为数字 1',
)

assert.equal(
  resolveKnownNumber('201', new Set(['2011', '2012']), false, 42),
  '201',
  '同时存在 2011 和 2012 时，不得盲目猜测末位',
)

const joined = expandOcrNumberFragments([
  { text: '201', confidence: 71, bbox: { x0: 100, y0: 50, x1: 132, y1: 66 } },
  { text: '1', confidence: 64, bbox: { x0: 134, y0: 50, x1: 143, y1: 66 } },
])
assert.ok(joined.some((item) => item.text === '2011'), '相邻的 OCR 片段“201”与“1”应合并为四位标号')

console.log('四位标号 OCR 回归检查通过')
