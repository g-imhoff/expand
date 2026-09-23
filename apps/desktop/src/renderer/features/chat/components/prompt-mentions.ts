export interface PromptMentionItem {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly kind?: "file" | "folder"
}

export interface PromptMention {
  readonly kind: PromptMentionKind
  readonly key: string
  readonly start: number
  readonly end: number
}

export interface SelectedPromptMention extends PromptMention {
  readonly token: string
}

export interface PromptTextEdit {
  readonly previousStart: number
  readonly previousEnd: number
  readonly nextCaret: number
}

export interface ActiveMention {
  readonly kind: PromptMentionKind
  readonly query: string
  readonly start: number
  readonly caret: number
}

export type PromptMentionKind = "folder" | "skill"

export const reconcileSelectedMentions = (
  previousText: string,
  nextText: string,
  selected: ReadonlyArray<SelectedPromptMention>,
  edit: PromptTextEdit
): ReadonlyArray<SelectedPromptMention> => {
  let prefix = 0
  while (
    prefix < previousText.length &&
    prefix < nextText.length &&
    previousText[prefix] === nextText[prefix]
  ) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < previousText.length - prefix &&
    suffix < nextText.length - prefix &&
    previousText[previousText.length - suffix - 1] === nextText[nextText.length - suffix - 1]
  ) {
    suffix++
  }

  const shift = nextText.length - previousText.length
  let changeStart = prefix
  let previousEnd = previousText.length - suffix
  const candidateStart = Math.min(edit.previousStart, edit.nextCaret)
  const candidateEnd = edit.nextCaret - shift
  if (
    candidateStart >= 0 &&
    candidateStart <= edit.previousStart &&
    candidateEnd >= edit.previousEnd &&
    candidateEnd <= previousText.length &&
    nextText.startsWith(previousText.slice(0, candidateStart)) &&
    nextText.endsWith(previousText.slice(candidateEnd))
  ) {
    changeStart = candidateStart
    previousEnd = candidateEnd
  }
  return selected.flatMap((mention) => {
    const nextMention =
      mention.end <= changeStart
        ? mention
        : mention.start >= previousEnd
          ? { ...mention, start: mention.start + shift, end: mention.end + shift }
          : null
    if (
      nextMention === null ||
      nextText.slice(nextMention.start, nextMention.end) !== nextMention.token ||
      !hasMentionBoundary(nextText, nextMention.start) ||
      mentionContinuationPattern.test(nextText[nextMention.end] ?? "")
    ) {
      return []
    }
    return [nextMention]
  })
}

export const resolveMentions = (
  text: string,
  selected: ReadonlyArray<SelectedPromptMention>
): ReadonlyArray<PromptMention> => {
  const valid = selected.filter(
    (mention) =>
      mention.start >= 0 &&
      mention.end <= text.length &&
      text.slice(mention.start, mention.end) === mention.token &&
      hasMentionBoundary(text, mention.start) &&
      !mentionContinuationPattern.test(text[mention.end] ?? "")
  )
  const typed = parseMentions(text).filter(
    (mention) => !valid.some((chosen) => mention.start < chosen.end && chosen.start < mention.end)
  )
  return [
    ...typed,
    ...valid.map(({ kind, key, start, end }) => ({ kind, key, start, end }))
  ].sort((left, right) => left.start - right.start)
}

export const findActiveMention = (text: string, caret: number): ActiveMention | null => {
  const match = triggerPattern.exec(text.slice(0, caret))
  if (match === null) return null
  const token = match[2] ?? ""
  const query = token.slice(1)
  return {
    kind: token[0] === "@" ? "folder" : "skill",
    query,
    start: caret - token.length,
    caret
  }
}

export const filterMentionItems = (
  items: ReadonlyArray<PromptMentionItem>,
  query: string
): ReadonlyArray<PromptMentionItem> => {
  const needle = query.toLowerCase()
  if (needle === "") return items
  return items.filter((item) => item.label.toLowerCase().includes(needle))
}

const parseMentions = (text: string): ReadonlyArray<PromptMention> => {
  const mentions: Array<PromptMention> = []
  for (const match of text.matchAll(mentionPattern)) {
    const prefix = match[1] ?? ""
    const token = match[0].slice(prefix.length)
    const start = (match.index ?? 0) + prefix.length
    mentions.push({
      kind: token[0] === "@" ? "folder" : "skill",
      key: token.slice(1),
      start,
      end: start + token.length
    })
  }
  return mentions
}

const hasMentionBoundary = (text: string, start: number): boolean =>
  start === 0 || /\s/.test(text[start - 1] ?? "")

const mentionPattern = /(^|\s)(@[A-Za-z0-9_][\w\-.\\/]*|\$[A-Za-z_][\w\-.\\/]*)/g

const mentionContinuationPattern = /[\w\-.\\/]/

const triggerPattern = /(^|\s)(@([A-Za-z0-9_][\w\-.\\/]*)?|\$([A-Za-z_][\w\-.\\/]*)?)$/
