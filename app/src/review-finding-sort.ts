export type ReviewFindingSort = 'document' | 'severity' | 'category'

type SortableReviewFinding = {
  module: string
  severity: string
  location: string
  quote: string
}

const severityOrder: Record<string, number> = {
  重要: 0,
  一般: 1,
  提示: 2,
}

const categoryOrder: Record<string, number> = {
  technical: 0,
  legal: 1,
  priorArt: 2,
  enforcement: 3,
}

function compactText(value: string) {
  return value.replace(/[\s\u00a0]+/g, '')
}

function documentPosition(finding: SortableReviewFinding, patentText: string) {
  const compactPatent = compactText(patentText)
  const compactQuote = compactText(finding.quote)
  if (compactQuote) {
    const quotePosition = compactPatent.indexOf(compactQuote)
    if (quotePosition >= 0) return quotePosition
  }

  const paragraph = finding.location.match(/(?:第\s*)?\[?(\d{3,5})\]?\s*段/)
  if (paragraph) {
    const markerPosition = compactPatent.indexOf(`[${paragraph[1]}]`)
    if (markerPosition >= 0) return markerPosition
  }

  const claim = finding.location.match(/权利要求\s*(\d+)/)
  if (claim) {
    const claimHeading = compactPatent.search(/权利要求书/)
    const claimText = compactPatent.slice(Math.max(0, claimHeading))
    const claimPattern = new RegExp(`(?:^|\\n)${claim[1]}[.．、]`)
    const match = claimPattern.exec(claimText)
    if (match) return Math.max(0, claimHeading) + match.index
  }

  const locationText = compactText(finding.location)
  if (locationText) {
    const locationPosition = compactPatent.indexOf(locationText)
    if (locationPosition >= 0) return locationPosition
  }
  return Number.MAX_SAFE_INTEGER
}

export function sortReviewFindings<T extends SortableReviewFinding>(
  findings: T[],
  sort: ReviewFindingSort,
  patentText: string,
) {
  return findings.map((finding, index) => ({
    finding,
    index,
    position: documentPosition(finding, patentText),
    severity: severityOrder[finding.severity] ?? 99,
    category: categoryOrder[finding.module] ?? 99,
  })).sort((left, right) => {
    if (sort === 'severity') {
      return left.severity - right.severity || left.position - right.position || left.index - right.index
    }
    if (sort === 'category') {
      return left.category - right.category || left.severity - right.severity || left.position - right.position || left.index - right.index
    }
    return left.position - right.position || left.severity - right.severity || left.index - right.index
  }).map((entry) => entry.finding)
}
