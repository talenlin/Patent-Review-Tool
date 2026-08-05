export function cycleReferenceOccurrence(current: number, total: number, direction: -1 | 1) {
  if (total <= 1) return 0
  return (current + direction + total) % total
}
