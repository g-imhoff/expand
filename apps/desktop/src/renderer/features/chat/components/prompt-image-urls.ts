import { useEffect, useRef } from "react"
import type { PromptImageAttachment } from "@expand/desktop/renderer/features/chat/components/PromptInput"

export const createPromptImageUrl = (file: File): string => {
  const url = URL.createObjectURL(file)
  generatedUrls.add(url)
  return url
}

export const releasePromptImageUrl = (url: string): void => {
  if (generatedUrls.delete(url)) URL.revokeObjectURL(url)
  adoptedUrls.delete(url)
}

export const releaseUnownedPromptImageUrl = (url: string): void => {
  if (!adoptedUrls.has(url)) releasePromptImageUrl(url)
}

export const usePromptImageUrlOwnership = (
  retainedImages: ReadonlyArray<PromptImageAttachment>
): void => {
  const previousImages = useRef<ReadonlyArray<PromptImageAttachment>>([])
  const pendingRelease = useRef<{ cancelled: boolean } | null>(null)

  useEffect(() => {
    if (pendingRelease.current !== null) pendingRelease.current.cancelled = true
    pendingRelease.current = null
    const retainedUrls = new Set(retainedImages.map((image) => image.url))
    for (const url of retainedUrls) {
      if (generatedUrls.has(url)) adoptedUrls.add(url)
    }
    for (const image of previousImages.current) {
      if (!retainedUrls.has(image.url)) releasePromptImageUrl(image.url)
    }
    previousImages.current = retainedImages
  })

  useEffect(() => () => {
    const pending = { cancelled: false }
    pendingRelease.current = pending
    queueMicrotask(() => {
      if (pending.cancelled) return
      for (const image of previousImages.current) releasePromptImageUrl(image.url)
      previousImages.current = []
    })
  }, [])
}

const generatedUrls = new Set<string>()
const adoptedUrls = new Set<string>()
