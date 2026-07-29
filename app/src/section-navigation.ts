import type { SectionKey } from './document-analysis'

export function findDocxSectionTarget(root: HTMLElement, key: SectionKey) {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('p, h1, h2, h3, li'))
  if (key === 'abstract') return blocks.find((block) => Boolean(block.textContent?.trim())) ?? null
  if (key === 'claims') {
    return blocks.find((block) => /^\s*(?:权利要求书\s*)?1\s*[.、．]/.test(block.textContent?.trim() ?? '')) ?? null
  }
  if (key === 'description') {
    return blocks.find((block) => /^(技术领域|背景技术|发明内容|实用新型内容|具体实施方式|说明书)/.test(block.textContent?.trim() ?? '')) ?? null
  }
  return blocks.find((block) => /^(附图说明|附图标记|图\s*1)/.test(block.textContent?.trim() ?? '')) ?? null
}

export function scrollTargetWithin(target: Element, scroller: HTMLElement) {
  const targetBounds = target.getBoundingClientRect()
  const scrollerBounds = scroller.getBoundingClientRect()
  scroller.scrollTo({
    top: Math.max(0, scroller.scrollTop + targetBounds.top - scrollerBounds.top - 14),
    behavior: 'auto',
  })
}
