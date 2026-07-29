export type PatentImagePreprocessResult = {
  data: Uint8ClampedArray
  longLinePixelsRemoved: number
  dashedLinePixelsRemoved: number
  closedRegionPixelsRemoved: number
  candidatePixelsKept: number
}

function adaptiveBinary(data: Uint8ClampedArray, width: number, height: number) {
  const gray = new Uint8Array(width * height)
  const integral = new Uint32Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const channel = index * 4
      gray[index] = Math.round(data[channel] * 0.299 + data[channel + 1] * 0.587 + data[channel + 2] * 0.114)
      rowSum += gray[index]
      integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + rowSum
    }
  }
  const binary = new Uint8Array(width * height)
  const radius = Math.max(4, Math.round(Math.min(width, height) * 0.018))
  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - radius)
    const bottom = Math.min(height - 1, y + radius)
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius)
      const right = Math.min(width - 1, x + radius)
      const sum = integral[(bottom + 1) * (width + 1) + right + 1]
        - integral[top * (width + 1) + right + 1]
        - integral[(bottom + 1) * (width + 1) + left]
        + integral[top * (width + 1) + left]
      const mean = sum / ((right - left + 1) * (bottom - top + 1))
      binary[y * width + x] = gray[y * width + x] < Math.min(220, mean - 10) ? 1 : 0
    }
  }
  return binary
}

function eraseMarked(binary: Uint8Array, marked: Uint8Array, width: number, height: number) {
  let removed = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!marked[y * width + x]) continue
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const targetX = x + offsetX
          const targetY = y + offsetY
          if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) continue
          const target = targetY * width + targetX
          if (binary[target]) {
            binary[target] = 0
            removed += 1
          }
        }
      }
    }
  }
  return removed
}

function scanLine(binary: Uint8Array, points: number[], minimumRun: number, marked: Uint8Array) {
  let start = -1
  for (let position = 0; position <= points.length; position += 1) {
    const dark = position < points.length && binary[points[position]] === 1
    if (dark && start < 0) start = position
    if ((!dark || position === points.length) && start >= 0) {
      if (position - start >= minimumRun) {
        for (let index = start; index < position; index += 1) marked[points[index]] = 1
      }
      start = -1
    }
  }
}

function removeLongStraightLines(binary: Uint8Array, width: number, height: number) {
  const marked = new Uint8Array(binary.length)
  const minimumRun = Math.max(18, Math.round(Math.min(width, height) * 0.12))
  for (let y = 0; y < height; y += 1) {
    scanLine(binary, Array.from({ length: width }, (_, x) => y * width + x), minimumRun, marked)
  }
  for (let x = 0; x < width; x += 1) {
    scanLine(binary, Array.from({ length: height }, (_, y) => y * width + x), minimumRun, marked)
  }
  for (const slope of [1, -1, 2, -2, 0.5, -0.5]) {
    const starts: Array<[number, number]> = []
    for (let x = 0; x < width; x += 1) starts.push([x, slope > 0 ? 0 : height - 1])
    for (let y = 1; y < height - 1; y += 1) starts.push([0, y])
    for (const [startX, startY] of starts) {
      const points: number[] = []
      for (let step = 0; step < Math.max(width, height); step += 1) {
        const x = Math.round(startX + step)
        const y = Math.round(startY + step * slope)
        if (x < 0 || y < 0 || x >= width || y >= height) break
        const index = y * width + x
        if (points.at(-1) !== index) points.push(index)
      }
      scanLine(binary, points, minimumRun, marked)
    }
  }
  return eraseMarked(binary, marked, width, height)
}

function markDashedSequence(points: number[], binary: Uint8Array, marked: Uint8Array, minimumSpan: number) {
  const runs: Array<{ start: number; end: number }> = []
  let start = -1
  for (let position = 0; position <= points.length; position += 1) {
    const dark = position < points.length && binary[points[position]] === 1
    if (dark && start < 0) start = position
    if ((!dark || position === points.length) && start >= 0) {
      runs.push({ start, end: position })
      start = -1
    }
  }
  for (let index = 0; index + 2 < runs.length; index += 1) {
    const group = runs.slice(index, index + 6)
    const lengths = group.map((run) => run.end - run.start)
    const gaps = group.slice(1).map((run, runIndex) => run.start - group[runIndex].end)
    const meanLength = lengths.reduce((sum, value) => sum + value, 0) / lengths.length
    const meanGap = gaps.reduce((sum, value) => sum + value, 0) / Math.max(1, gaps.length)
    const consistent = group.length >= 3
      && meanLength >= 1
      && meanGap >= 1
      && lengths.every((value) => Math.abs(value - meanLength) <= Math.max(2, meanLength * 0.55))
      && gaps.every((value) => Math.abs(value - meanGap) <= Math.max(2, meanGap * 0.55))
      && group.at(-1)!.end - group[0].start >= minimumSpan
    if (!consistent) continue
    for (const run of group) {
      for (let position = run.start; position < run.end; position += 1) marked[points[position]] = 1
    }
  }
}

function removeDashedLines(binary: Uint8Array, width: number, height: number) {
  const marked = new Uint8Array(binary.length)
  for (let y = 0; y < height; y += 1) {
    markDashedSequence(Array.from({ length: width }, (_, x) => y * width + x), binary, marked, Math.max(18, width * 0.12))
  }
  for (let x = 0; x < width; x += 1) {
    markDashedSequence(Array.from({ length: height }, (_, y) => y * width + x), binary, marked, Math.max(18, height * 0.12))
  }
  return eraseMarked(binary, marked, width, height)
}

function removeLargeClosedRegions(binary: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(binary.length)
  const marked = new Uint8Array(binary.length)
  const minimumArea = Math.max(24, Math.round(width * height * 0.00045))
  const maximumArea = Math.round(width * height * 0.03)
  for (let seed = 0; seed < binary.length; seed += 1) {
    if (binary[seed] || visited[seed]) continue
    const queue = [seed]
    visited[seed] = 1
    const component: number[] = []
    let touchesBorder = false
    let minX = width
    let maxX = 0
    let minY = height
    let maxY = 0
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]
      component.push(index)
      const x = index % width
      const y = Math.floor(index / width)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nextX = x + dx
        const nextY = y + dy
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
        const next = nextY * width + nextX
        if (!binary[next] && !visited[next]) {
          visited[next] = 1
          queue.push(next)
        }
      }
    }
    const boxWidth = maxX - minX + 1
    const boxHeight = maxY - minY + 1
    const aspect = boxWidth / Math.max(1, boxHeight)
    if (touchesBorder || component.length < minimumArea || component.length > maximumArea || aspect < 0.35 || aspect > 2.8) continue
    for (let y = Math.max(0, minY - 2); y <= Math.min(height - 1, maxY + 2); y += 1) {
      for (let x = Math.max(0, minX - 2); x <= Math.min(width - 1, maxX + 2); x += 1) {
        if (binary[y * width + x]) marked[y * width + x] = 1
      }
    }
  }
  return eraseMarked(binary, marked, width, height)
}

function buildCandidateMask(binary: Uint8Array, width: number, height: number) {
  const visited = new Uint8Array(binary.length)
  const mask = new Uint8Array(binary.length)
  const minimumHeight = Math.max(2, Math.round(Math.min(width, height) * 0.004))
  const maximumHeight = Math.max(12, Math.round(height * 0.13))
  for (let seed = 0; seed < binary.length; seed += 1) {
    if (!binary[seed] || visited[seed]) continue
    const queue = [seed]
    visited[seed] = 1
    let minX = width
    let maxX = 0
    let minY = height
    let maxY = 0
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]
      const x = index % width
      const y = Math.floor(index / width)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nextX = x + dx
          const nextY = y + dy
          if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue
          const next = nextY * width + nextX
          if (binary[next] && !visited[next]) {
            visited[next] = 1
            queue.push(next)
          }
        }
      }
    }
    const boxWidth = maxX - minX + 1
    const boxHeight = maxY - minY + 1
    const density = queue.length / Math.max(1, boxWidth * boxHeight)
    if (queue.length < 3 || boxHeight < minimumHeight || boxHeight > maximumHeight || boxWidth > width * 0.18 || density < 0.025) continue
    for (const index of queue) mask[index] = 1
  }

  // Repeated short dilations create a tight concave envelope around nearby
  // character components. This is the practical raster equivalent of the
  // Alpha-Shape ROI mask without pulling in a heavyweight geometry library.
  let expanded = mask
  const rounds = Math.max(1, Math.min(4, Math.round(Math.min(width, height) * 0.004)))
  for (let round = 0; round < rounds; round += 1) {
    const next = new Uint8Array(expanded)
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x
        if (expanded[index]) continue
        if (expanded[index - 1] || expanded[index + 1] || expanded[index - width] || expanded[index + width]) next[index] = 1
      }
    }
    expanded = next
  }
  return expanded
}

export function preprocessPatentDrawingPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): PatentImagePreprocessResult {
  const binary = adaptiveBinary(data, width, height)
  const longLinePixelsRemoved = removeLongStraightLines(binary, width, height)
  const dashedLinePixelsRemoved = removeDashedLines(binary, width, height)
  const closedRegionPixelsRemoved = removeLargeClosedRegions(binary, width, height)
  const mask = buildCandidateMask(binary, width, height)
  const output = new Uint8ClampedArray(width * height * 4)
  let candidatePixelsKept = 0
  for (let index = 0; index < binary.length; index += 1) {
    const keep = binary[index] && mask[index]
    if (keep) candidatePixelsKept += 1
    const value = keep ? 0 : 255
    output[index * 4] = value
    output[index * 4 + 1] = value
    output[index * 4 + 2] = value
    output[index * 4 + 3] = 255
  }
  return { data: output, longLinePixelsRemoved, dashedLinePixelsRemoved, closedRegionPixelsRemoved, candidatePixelsKept }
}
