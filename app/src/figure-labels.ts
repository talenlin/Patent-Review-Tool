import type { FigureLabel } from './figure-ocr'

type LabelPositionStore = {
  current: Record<string, { left: number; top: number }>
}

export function uniqueFigureLabels(labels: FigureLabel[]) {
  const unique = new Map<string, FigureLabel>()
  labels.forEach((label) => {
    const key = `${label.imageIndex}-${label.number}`
    const current = unique.get(key)
    if (!current || label.confidence > current.confidence) unique.set(key, label)
  })
  return [...unique.values()]
}

export function suppressOverlappingSubnumberLabels(labels: FigureLabel[]) {
  const overlapThreshold = 4
  return labels.filter((label) => !labels.some((other) => (
    other.imageIndex === label.imageIndex
    && other.number.length > label.number.length
    && other.number.includes(label.number)
    && Math.abs(other.left - label.left) <= overlapThreshold
    && Math.abs(other.top - label.top) <= overlapThreshold
  )))
}

export function bindFigureLabelInteractions(
  button: HTMLElement,
  figure: HTMLElement,
  labelKey: string,
  positions: LabelPositionStore,
  onActivate: () => void,
) {
  button.addEventListener('click', () => {
    if (button.dataset.dragged === 'true') {
      delete button.dataset.dragged
      return
    }
    onActivate()
  })
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const figureBounds = figure.getBoundingClientRect()
    const startX = event.clientX
    const startY = event.clientY
    let moved = false
    button.classList.add('is-dragging')
    try {
      button.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic events and older embedded browsers can reject capture;
      // document-level listeners below still keep the drag working.
    }

    const move = (moveEvent: PointerEvent) => {
      if (Math.abs(moveEvent.clientX - startX) > 3 || Math.abs(moveEvent.clientY - startY) > 3) moved = true
      if (!moved) return
      const left = Math.min(Math.max(((moveEvent.clientX - figureBounds.left) / figureBounds.width) * 100, 3), 97)
      const top = Math.min(Math.max(((moveEvent.clientY - figureBounds.top) / figureBounds.height) * 100, 3), 97)
      positions.current[labelKey] = { left, top }
      button.style.left = `${left}%`
      button.style.top = `${top}%`
      button.classList.add('is-manually-positioned')
    }
    const stop = () => {
      button.classList.remove('is-dragging')
      if (moved) button.dataset.dragged = 'true'
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', stop)
      document.removeEventListener('pointercancel', stop)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', stop)
    document.addEventListener('pointercancel', stop)
  })
}
