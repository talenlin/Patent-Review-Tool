import assert from 'node:assert/strict'
import { cycleReferenceOccurrence } from '../src/reference-navigation.ts'

assert.equal(cycleReferenceOccurrence(0, 17, -1), 16, '上箭头在第 1 处应循环到第 17 处')
assert.equal(cycleReferenceOccurrence(16, 17, 1), 0, '下箭头在第 17 处应循环到第 1 处')
assert.equal(cycleReferenceOccurrence(8, 17, -1), 7, '上箭头应定位上一处')
assert.equal(cycleReferenceOccurrence(8, 17, 1), 9, '下箭头应定位下一处')
assert.equal(cycleReferenceOccurrence(0, 1, 1), 0, '只有一处命中时应保持当前位置')

console.log('同一特征连续定位回归检查通过')
