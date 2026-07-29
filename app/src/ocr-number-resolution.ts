export function normaliseRecognizedNumber(value: string) {
  const trimmed = value.trim().replace(/[Oo]/g, '0')
  // OCR commonly mistakes the last outlined 1 for lowercase l / uppercase I.
  // Only make that substitution in a token that is already numeric, so
  // genuine identifiers such as M1 remain untouched.
  return /\d/.test(trimmed) ? trimmed.replace(/[Il|]/g, '1') : trimmed
}

export type OcrNumberFragment = {
  text: string
  confidence: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

function canJoinFragments(first: OcrNumberFragment, next: OcrNumberFragment) {
  if (!/^[A-Za-z0-9]+$/.test(first.text) || !/^[A-Za-z0-9]+$/.test(next.text)) return false
  const firstHeight = Math.max(1, first.bbox.y1 - first.bbox.y0)
  const nextHeight = Math.max(1, next.bbox.y1 - next.bbox.y0)
  const sameBaseline = Math.abs(first.bbox.y0 - next.bbox.y0) <= Math.max(3, Math.max(firstHeight, nextHeight) * 0.45)
  const gap = next.bbox.x0 - first.bbox.x1
  const closeEnough = gap >= -2 && gap <= Math.max(5, Math.max(firstHeight, nextHeight) * 0.45)
  return sameBaseline && closeEnough
}

// A long callout such as 2011 may arrive as two OCR words ("201" + "1")
// because a leader line cuts through its final digit. Retain the original
// words and add only tightly-adjacent merged alternatives for map matching.
export function expandOcrNumberFragments(words: OcrNumberFragment[]) {
  const expanded = [...words]
  for (let start = 0; start < words.length; start += 1) {
    let merged = words[start]
    for (let index = start + 1; index < Math.min(words.length, start + 3); index += 1) {
      const next = words[index]
      if (!canJoinFragments(merged, next)) break
      const text = `${merged.text}${next.text}`
      if (text.length > 8) break
      merged = {
        text,
        confidence: Math.min(merged.confidence, next.confidence),
        bbox: {
          x0: merged.bbox.x0,
          y0: Math.min(merged.bbox.y0, next.bbox.y0),
          x1: next.bbox.x1,
          y1: Math.max(merged.bbox.y1, next.bbox.y1),
        },
      }
      expanded.push(merged)
    }
  }
  return expanded
}

export function resolveKnownNumber(
  value: string,
  knownNumbers: ReadonlySet<string>,
  recoverRepeatedDigitCandidate = false,
  confidence = 100,
) {
  const recognised = normaliseRecognizedNumber(value)

  if (knownNumbers.has(recognised) || knownNumbers.size === 0) return recognised

  // Thin outlined 2s may be classified as 0s by the English digit model.
  // In a deliberately isolated, single-callout crop, a weak one-digit/zero
  // result can safely recover only when exactly one repeated-digit reference
  // from the user's confirmed map begins with that digit. Other OCR regions
  // always retain their literal result.
  if (recoverRepeatedDigitCandidate && confidence < 55 && /^\d{1,3}$/.test(recognised)) {
    const repeatedCandidates = [...knownNumbers].filter((number) => (
      /^(\d)\1+$/.test(number)
      && number.length > recognised.length
      && number[0] === recognised[0]
    ))
    if (repeatedCandidates.length === 1) return repeatedCandidates[0]
  }
  // Recover a uniquely identifiable missing tail, for example a sparse OCR
  // pass reading 201 instead of an otherwise unambiguous 2011. If more than
  // one confirmed number shares that prefix, do not guess: nearby-word
  // merging above must provide the decisive final digit instead.
  if (/^\d{2,7}$/.test(recognised)) {
    const tailCandidates = [...knownNumbers].filter((number) => (
      /^\d{3,8}$/.test(number)
      && number.startsWith(recognised)
      && number.length - recognised.length <= 2
    ))
    if (tailCandidates.length === 1) return tailCandidates[0]
  }
  return recognised
}
