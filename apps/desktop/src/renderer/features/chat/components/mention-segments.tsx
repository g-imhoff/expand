import type { ReactNode } from "react"
import { cn } from "@expand/desktop/renderer/components/ui/class-names"
import {
  resolveMentions,
  type SelectedPromptMention
} from "@expand/desktop/renderer/features/chat/components/prompt-mentions"

export const renderMentionSegments = (
  text: string,
  selected: ReadonlyArray<SelectedPromptMention> = []
): ReactNode => {
  const segments: Array<ReactNode> = []
  let cursor = 0
  for (const mention of resolveMentions(text, selected)) {
    segments.push(text.slice(cursor, mention.start))
    segments.push(
      <span
        key={mention.start}
        data-mention={mention.kind}
        className={cn(
          "rounded",
          mention.kind === "folder"
            ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
            : "bg-violet-500/15 text-violet-700 dark:text-violet-300"
        )}
      >
        {text.slice(mention.start, mention.end)}
      </span>
    )
    cursor = mention.end
  }
  segments.push(text.slice(cursor))
  return <>{segments}{text.endsWith("\n") ? "\u200b" : null}</>
}
