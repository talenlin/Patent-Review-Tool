import assert from 'node:assert/strict'
import { analyzeClaimAntecedentBasis, parseClaims } from '../src/claim-antecedent-analysis.ts'

const ordinalPipelineClaims = `\u6743\u5229\u8981\u6c42\u4e66
1\u3001\u4e00\u79cd\u6c14\u4f53\u4f20\u8f93\u88c5\u7f6e\uff0c\u5305\u62ec\uff1a
\u7b2c\u4e00\u7ba1\u9053\uff0c\u8fde\u901a\u6c14\u6e90\u548c\u7b2c\u4e00\u53e3\uff1b
\u7b2c\u4e8c\u7ba1\u9053\uff0c\u8fde\u901a\u6c14\u6e90\u548c\u7b2c\u4e8c\u53e3\uff1b
\u7b2c\u4e09\u7ba1\u9053\uff0c\u8fde\u901a\u6c14\u6e90\u3001\u7b2c\u4e00\u53e3\u548c\u7b2c\u4e8c\u53e3\uff1b
\u6240\u8ff0\u7b2c\u4e00\u7ba1\u9053\u3001\u6240\u8ff0\u7b2c\u4e8c\u7ba1\u9053\u548c\u6240\u8ff0\u7b2c\u4e09\u7ba1\u9053\u540c\u65f6\u6253\u5f00\u3002`
assert.ok(!analyzeClaimAntecedentBasis(ordinalPipelineClaims).issues.some((issue) => issue.term === '\u7ba1\u9053'), '\u5e26\u5e8f\u6570\u7684\u7ba1\u9053\u5f15\u7528\u4e0d\u5e94\u88ab\u8bef\u62a5\u4e3a\u6cdb\u79f0\u6b67\u4e49')

const multiDependentClaims = `权利要求书
1. 一种检测装置，包括一个控制器和一个传感器。
2. 根据权利要求1所述的检测装置，其特征在于，所述控制器连接所述传感器。
3. 根据权利要求1或2所述的检测装置，其特征在于，所述执行器连接所述控制器。`

const parsed = parseClaims(multiDependentClaims)
assert.deepEqual(parsed.map((claim) => claim.number), [1, 2, 3], '应逐项解析权利要求')
assert.deepEqual(parsed[2].dependencies, [1, 2], '多项从属应保留所有可能引用路径')

// DOCX parsing prepends page-header markers before the actual document text.
// The marker “说明书” must not terminate claims before the first numbered claim.
const docxTextWithHeaderMarkers = `说明书摘要
摘要附图
权利要求书
说明书
说明书附图
1、一种片材载具，包括一个载具主体。
2、根据权利要求1所述的片材载具，其特征在于，所述载具主体包括顶板。`
assert.deepEqual(parseClaims(docxTextWithHeaderMarkers).map((claim) => claim.number), [1, 2], 'DOCX 页首标记不应导致权利要求解析为空')

const missing = analyzeClaimAntecedentBasis(multiDependentClaims)
assert.ok(missing.issues.some((issue) => issue.claimNumber === 3 && issue.kind === 'absolute-missing' && issue.term === '执行器'), '未引入的“所述执行器”应提示缺乏引用基础')

const ambiguousClaims = `权利要求书
1. 一种传动装置，包括一个第一齿轮和一个第二齿轮。
2. 根据权利要求1所述的传动装置，其特征在于，所述齿轮与输出轴连接。`
const ambiguous = analyzeClaimAntecedentBasis(ambiguousClaims)
assert.ok(ambiguous.issues.some((issue) => issue.kind === 'ambiguous' && issue.term === '齿轮'), '多个序数限定对象被宽泛引用时应提示指代歧义')

const quantityClaims = `权利要求书
1. 一种监测系统，包括一个传感器。
2. 根据权利要求1所述的监测系统，其特征在于，所述多个传感器均与控制器连接。`
const quantity = analyzeClaimAntecedentBasis(quantityClaims)
assert.ok(quantity.issues.some((issue) => issue.kind === 'quantity-mismatch' && issue.term === '传感器'), '单数首次引入与复数引用应提示数量不一致')

const titleIntroducedClaims = `权利要求书
1、一种片材载具，其特征在于，所述片材载具包括一个载具主体。
2、根据权利要求1所述的片材载具，其特征在于，所述载具主体包括顶板。`
const titleIntroduced = analyzeClaimAntecedentBasis(titleIntroducedClaims)
assert.ok(!titleIntroduced.issues.some((issue) => issue.term === '片材载具'), '权利要求标题名称应视为已引入，不应单独提示前序引用风险')

const bodyReferenceClaims = `权利要求书
1、一种片材载具，包括一个载具主体。
2、一种上下料装置，其特征在于，包括：权利要求1所述的片材载具。`
assert.deepEqual(parseClaims(bodyReferenceClaims)[1].dependencies, [1], '“权利要求1所述的……”也应建立继承引用关系')

const ordinalReferenceClaims = `权利要求书
1、一种载具，包括一个第一抵接面和一个第二抵接面。
2、根据权利要求1所述的载具，其特征在于，所述第一抵接面朝向压板。`
assert.ok(!analyzeClaimAntecedentBasis(ordinalReferenceClaims).issues.some((issue) => issue.term === '抵接面'), '“所述第一抵接面”应优先匹配同名的第一抵接面，不应误报为泛称歧义')

const pluralFeatureClaims = `权利要求书
1、一种载具，包括两个侧板，两个所述侧板围合形成容纳腔。`
assert.ok(!analyzeClaimAntecedentBasis(pluralFeatureClaims).issues.some((issue) => issue.term === '侧板'), '“两个侧板”应视为首次引入，后续所述侧板不应报缺失')

console.log('权利要求引用基础判断回归检查通过')
