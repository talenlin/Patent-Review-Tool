import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(scriptDirectory, '..', '..')
const sourcePath = resolve(repositoryRoot, 'patent-review-rulebook.json')
const destinationPath = resolve(repositoryRoot, 'app', 'src', 'data', 'patent-review-rulebook.json')

const rulebook = JSON.parse(await readFile(sourcePath, 'utf8'))

rulebook.metadata.version = '1.0.1'
rulebook.metadata.lastVerifiedAt = '2026-07-30'
rulebook.metadata.changeNotes = [
  '移除非官方法律注释来源《中国专利法详解》。',
  '序列表规则按申请日区分 WIPO ST.25 与 ST.26。',
]

rulebook.sources = rulebook.sources.filter((source) => source.id !== 'source-004')
rulebook.sources.push({
  id: 'source-009',
  title: '关于调整核苷酸或氨基酸序列表电子文件标准的公告（第485号）',
  issuer: '国家知识产权局',
  sourceType: '公告',
  effectiveDate: '2022-07-01',
  url: 'https://www.cnipa.gov.cn/art/2022/6/14/art_74_176021.html',
  accessedAt: '2026-07-30',
})

for (const rule of rulebook.rules) {
  rule.sources = rule.sources.filter((sourceId) => sourceId !== 'source-004')
  if (rule.id !== 'formal-004') continue
  rule.ruleSummary = '根据国家知识产权局第485号公告，申请日在2022年7月1日及以后的国家专利申请和PCT国际申请，序列表电子文件应符合WIPO ST.26标准；申请日在此日期之前的申请仍按原有ST.25相关标准处理。序列表应与说明书中的序列信息一致。'
  rule.triggerPatterns = [
    '专利申请涉及基因序列、蛋白质序列、抗体序列等',
    '申请日在2022年7月1日及以后但序列表不符合WIPO ST.26标准',
    '申请日在2022年7月1日之前但未按当时适用的序列表标准提交',
    '序列表中序列编号与说明书中引用的编号不一致',
  ]
  rule.reviewMethod = [
    '确认申请是否涉及需要序列表的发明',
    '确认专利申请日是否早于2022年7月1日',
    '依据申请日选择ST.25或ST.26标准进行检查',
    '核对序列表中的序列信息是否与说明书一致',
    '确认序列表的完整性',
  ]
  rule.recommendedActions = [
    '申请日在2022年7月1日及以后的，使用WIPO Sequence生成符合ST.26标准的XML序列表',
    '申请日在2022年7月1日之前的，按当时适用的ST.25相关标准核验',
    '核实序列表与说明书的一致性',
  ]
  rule.sources = [...new Set([...rule.sources, 'source-009'])]
  rule.notes = '本规则主要适用于生物技术领域。申请日是选择ST.25或ST.26标准的关键；不涉及生物序列的申请可以跳过。'
}

await mkdir(dirname(destinationPath), { recursive: true })
await writeFile(destinationPath, `${JSON.stringify(rulebook, null, 2)}\n`, 'utf8')
console.log(`Built ${rulebook.rules.length} rules from ${rulebook.sources.length} official sources.`)
