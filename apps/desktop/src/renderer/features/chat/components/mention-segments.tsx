import { Fragment, type ReactNode } from "react"
import { cn } from "@expand/desktop/renderer/components/ui/class-names"

/** Mirrors composer text with `@folder` / `$skill` tokens wrapped in distinct pills. Whitespace (incl. newlines) passes through untouched. */
export const renderMentionSegments = (text: string): ReactNode => (
  <>
    {text.split(segmentPattern).map((part, index) => {
      const marker = part[0]
      if ((marker === "@" || marker === "$") && part.length > 1) {
        return (
          <span
            key={index}
            data-mention={marker === "@" ? "folder" : "skill"}
            className={cn(
              "rounded",
              marker === "@"
                ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
                : "bg-violet-500/15 text-violet-700 dark:text-violet-300"
            )}
          >
            {part}
          </span>
        )
      }
      return <Fragment key={index}>{part}</Fragment>
    })}
    {text.endsWith("\n") ? "\u200b" : null}
  </>
)

const segmentPattern = /([@$][\w\-.\\/]+)/g
