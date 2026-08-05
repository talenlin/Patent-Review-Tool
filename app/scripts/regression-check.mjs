import assert from 'node:assert/strict'
import { extractLegendReferenceCandidates, extractReferenceCandidates } from '../src/document-analysis.ts'
import { findDocxSectionTarget, scrollTargetWithin } from '../src/section-navigation.ts'

const similarLabels = extractReferenceCandidates('第一凹槽12，第二凹槽13。')
const labelMap = new Map(similarLabels.map((candidate) => [candidate.number, candidate.name]))

assert.equal(labelMap.get('12'), '第一凹槽', '标号 12 应保留“第一”限定词')
assert.equal(labelMap.get('13'), '第二凹槽', '标号 13 应保留“第二”限定词')

console.log('相似标号回归检查通过')

const numberFirstLegend = extractLegendReferenceCandidates(`附图标记：\n10、调节阀；1、阀座；121、出气孔；101111、第一电机；11a：中间区；X：第一方向。\n具体实施方式`)
const numberFirstMap = new Map(numberFirstLegend.map((candidate) => [candidate.number, candidate.name]))
assert.equal(numberFirstMap.get('121'), '出气孔', '类型1应识别“标号、名称”')
assert.equal(numberFirstMap.get('101111'), '第一电机', '说明书标记表应支持六位标号')
assert.equal(numberFirstMap.get('11a'), '中间区', '说明书标记表应支持字母后缀标号')
assert.equal(numberFirstMap.get('X'), '第一方向', '说明书标记表应支持方向符号')

const hyphenLegend = extractLegendReferenceCandidates(`[0025]附图编号说明：\n[0026]1-半导体衬底；\n[0027]21-第一纹理结构；\n[0028]221-第一掺杂导电层。\n具体实施方式`)
assert.equal(hyphenLegend.find((candidate) => candidate.number === '221')?.name, '第一掺杂导电层', '类型2/3应识别连字符格式和段落号')

const nameFirstLegend = extractLegendReferenceCandidates(`附图标记说明：\n接驳设备100；第一设备200；传送架1；第一导轨11a。\n具体实施方式`)
const nameFirstMap = new Map(nameFirstLegend.map((candidate) => [candidate.number, candidate.name]))
assert.equal(nameFirstMap.get('100'), '接驳设备', '类型3\'应识别“名称+标号”')
assert.equal(nameFirstMap.get('11a'), '第一导轨', '名称在前格式应支持字母后缀')

const legendPriority = extractReferenceCandidates(`附图标记：\n1、阀座；22、阀杆。\n具体实施方式\n正文中错误候选固定件22出现很多次，固定件22再次出现。`)
assert.deepEqual(legendPriority.filter((candidate) => candidate.number === '22').map((candidate) => candidate.name), ['阀杆'], '说明书附图标记应优先于正文频次候选')

console.log('说明书附图标记格式回归检查通过')

const tableLegend = extractLegendReferenceCandidates(`主要元件符号说明：
光伏组件\t100
太阳能板\t10a、10b
容纳腔\tR
水平视场角\tHFOV`)
const tableLegendMap = new Map(tableLegend.map((candidate) => [candidate.number, candidate.name]))
assert.equal(tableLegendMap.get('100'), '光伏组件', '表格型标记说明应识别名称—数字标号')
assert.equal(tableLegendMap.get('10a'), '太阳能板', '一格多个标号应拆分识别')
assert.equal(tableLegendMap.get('10b'), '太阳能板', '一格多个标号应完整保留')
assert.equal(tableLegendMap.get('R'), '容纳腔', '表格型字母标号应识别')
assert.equal(tableLegendMap.get('HFOV'), '水平视场角', '表格型多字母标号应识别')

const liveBlocks = [
  { textContent: '摘要正文' },
  { textContent: '1.一种测试装置' },
  { textContent: '技术领域' },
  { textContent: '附图说明' },
]
const liveRoot = {
  querySelectorAll: () => liveBlocks,
}

assert.equal(findDocxSectionTarget(liveRoot, 'abstract'), liveBlocks[0], '摘要应即时定位到首个正文块')
assert.equal(findDocxSectionTarget(liveRoot, 'claims'), liveBlocks[1], '权利要求书应即时定位到权利要求1')
assert.equal(findDocxSectionTarget(liveRoot, 'description'), liveBlocks[2], '说明书应即时定位到首个说明书标题')
assert.equal(findDocxSectionTarget(liveRoot, 'drawings'), liveBlocks[3], '说明书附图应即时定位到附图说明')

let scrollOptions
const target = { getBoundingClientRect: () => ({ top: 114 }) }
const scroller = {
  scrollTop: 400,
  getBoundingClientRect: () => ({ top: 14 }),
  scrollTo: (options) => { scrollOptions = options },
}
scrollTargetWithin(target, scroller)
assert.deepEqual(scrollOptions, { top: 486, behavior: 'auto' }, '长文档区段跳转应立即到达目标位置')

console.log('阅读区段跳转回归检查通过')
