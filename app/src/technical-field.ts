export function detectTechnicalField(text: string) {
  const normalized = text.replace(/\r/g, '')
  const match = normalized.match(/(?:^|\n)\s*技术领域\s*(?:\n|[:：])([\s\S]{0,600}?)(?=\n\s*(?:背景技术|发明内容|实用新型内容|现有技术)\s*(?:\n|[:：])|$)/)
  if (match?.[1]?.trim()) {
    return match[1].replace(/\s+/g, ' ').trim().slice(0, 180)
  }
  const sentence = normalized.match(/本(?:发明|实用新型|申请)(?:涉及|属于)([^。\n]{2,80}(?:领域|技术))/)
  return sentence?.[1]?.trim() ?? ''
}

function bigrams(value: string) {
  const compact = value.replace(/[，。；、：:“”"'（）()\s]/g, '')
  const result = new Set<string>()
  for (let index = 0; index < compact.length - 1; index += 1) result.add(compact.slice(index, index + 2))
  return result
}

export function technicalFieldsDiffer(manual: string, detected: string) {
  if (!manual.trim() || !detected.trim()) return false
  if (manual.includes(detected) || detected.includes(manual)) return false
  const first = bigrams(manual)
  const second = bigrams(detected)
  const overlap = [...first].filter((item) => second.has(item)).length
  return overlap / Math.max(1, Math.min(first.size, second.size)) < 0.22
}

export function extractClaimsText(text: string) {
  const normalized = text.replace(/\r/g, '')
  const claimStart = normalized.search(/(?:^|\n)\s*权\s*利\s*要\s*求\s*书\s*(?:\n|$)/)
  if (claimStart < 0) return normalized.slice(0, 40_000)
  const remainder = normalized.slice(claimStart)
  const end = remainder.search(/\n\s*(?:说\s*明\s*书|技术领域|说明书附图)\s*(?:\n|$)/)
  return (end > 0 ? remainder.slice(0, end) : remainder).slice(0, 60_000)
}
