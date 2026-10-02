import { useEffect, useRef } from "react"
import type { PromptImageAttachment } from "@expand/desktop/renderer/features/chat/components/PromptInput"

export const createPromptImageUrl = (file: File): string => {
  const url = URL.createObjectURL(file)
  if (!generatedUrls.has(url)) {
    generatedUrls.set(url, { owners: new Set(), adopted: false, revision: 0 })
  }
  return url
}

export const releasePromptImageUrl = (url: string): void => {
  const record = generatedUrls.get(url)
  if (record !== undefined && record.owners.size === 0) revokePromptImageUrl(url, record)
}

export const releaseUnownedPromptImageUrl = (url: string): void => {
  const record = generatedUrls.get(url)
  if (record !== undefined && !record.adopted && record.owners.size === 0) {
    revokePromptImageUrl(url, record)
  }
}

export const usePromptImageUrlOwnership = (
  retainedImages: ReadonlyArray<PromptImageAttachment>
): void => {
  const owner = useRef(Symbol())
  const heldUrls = useRef(new Set<string>())

  useEffect(() => {
    const retainedUrls = new Set(retainedImages.map((image) => image.url))
    for (const url of retainedUrls) retainPromptImageUrl(url, owner.current)
    for (const url of heldUrls.current) {
      if (!retainedUrls.has(url)) releaseOwnedPromptImageUrl(url, owner.current)
    }
    heldUrls.current = retainedUrls
  })

  useEffect(() => () => {
    for (const url of heldUrls.current) releaseOwnedPromptImageUrl(url, owner.current)
    heldUrls.current.clear()
  }, [])
}

const generatedUrls = new Map<string, { owners: Set<symbol>; adopted: boolean; revision: number }>()

const retainPromptImageUrl = (url: string, owner: symbol): void => {
  const record = generatedUrls.get(url)
  if (record === undefined || record.owners.has(owner)) return
  record.owners.add(owner)
  record.adopted = true
  record.revision++
}

const releaseOwnedPromptImageUrl = (url: string, owner: symbol): void => {
  const record = generatedUrls.get(url)
  if (record === undefined || !record.owners.delete(owner)) return
  if (record.owners.size > 0) return
  const revision = ++record.revision
  queueMicrotask(() => {
    if (generatedUrls.get(url) === record && record.revision === revision && record.owners.size === 0) {
      revokePromptImageUrl(url, record)
    }
  })
}

const revokePromptImageUrl = (
  url: string,
  record: { owners: Set<symbol>; adopted: boolean; revision: number }
): void => {
  if (generatedUrls.get(url) !== record) return
  generatedUrls.delete(url)
  URL.revokeObjectURL(url)
}
