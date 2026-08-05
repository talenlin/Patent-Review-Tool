import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const agentSource = await readFile(new URL('../src/mcp-research-agent.ts', import.meta.url), 'utf8')
const dialogSource = await readFile(new URL('../src/LlmReviewDialog.tsx', import.meta.url), 'utf8')
const reviewSource = await readFile(new URL('../src/llm-review.ts', import.meta.url), 'utf8')

assert.match(agentSource, /patsnapMcpSearchSyntax/, '应提供智慧芽 MCP 的专用检索语法说明')
assert.match(agentSource, /TAC（标题\/摘要\/权利要求）/, '默认字段应为 TAC')
assert.match(agentSource, /TACD（标题\/摘要\/权利要求\/说明书）/, '全文扩大召回应使用 TACD')
assert.match(agentSource, /ICLMS（独立权利要求）/, '应支持独立权利要求字段')
assert.match(agentSource, /IPC、CPC、ALL_AN/, '应保留常用分类和申请人字段')
assert.match(agentSource, /不得使用 TACD_ALL、AP、PA/, '不得诱导模型使用未验证字段')
assert.match(agentSource, /禁止 \$FREQn、AND NOT、下划线分隔符/, '应明确禁止已知不兼容语法')
assert.match(agentSource, /最多 2–4 个特征块/, '检索式应限制特征块数量以控制复杂度')
assert.match(dialogSource, /patsnapSyntax: retrieval\.provider === 'patsnap-mcp'/, '仅智慧芽流程应启用专用语法')
assert.match(reviewSource, /provider === 'patsnap-mcp'/, '检索式生成提示也应识别智慧芽服务商')

console.log('Patsnap query syntax regression checks passed.')
