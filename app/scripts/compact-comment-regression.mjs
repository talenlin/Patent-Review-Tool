import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [app, rust] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../rust-v1/src-tauri/src/lib.rs', import.meta.url), 'utf8'),
])

assert.match(
  app,
  /body: `风险类型：\$\{finding\.title\.trim\(\) \|\| finding\.module\}（详情看附件excel）`/,
  'LLM 批注必须仅保留风险类型及 Excel 查看提示',
)
assert.match(rust, /fn annotation_summary\(/, 'DOCX 与 PDF 必须共用紧凑批注正文规则')
assert.match(rust, /if annotation\.annotation_type == "LLM辅助审查"/, 'LLM 批注不得附加通用标题和状态')
assert.doesNotMatch(rust, /定位：\{\}/, '保存的批注不得重复写入定位文本')

console.log('紧凑批注回归检查通过')
