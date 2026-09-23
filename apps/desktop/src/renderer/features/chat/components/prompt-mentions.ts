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

export interface ActiveMention {
  readonly kind: PromptMentionKind
  readonly query: string
  /** Offset of the `@` / `$` trigger character in the draft. */
  readonly start: number
  /** Caret offset the trigger was detected from. */
  readonly caret: number
}

export type PromptMentionKind = "folder" | "skill"

/** All `@folder` / `$skill` tokens in the text, with offsets. Unknown keys are kept — the consumer resolves them. */
export const parseMentions = (text: string): ReadonlyArray<PromptMention> => {
  const mentions: Array<PromptMention> = []
  for (const match of text.matchAll(mentionPattern)) {
    const start = match.index ?? 0
    mentions.push({
      kind: match[1] === "@" ? "folder" : "skill",
      key: match[0].slice(1),
      start,
      end: start + match[0].length
    })
  }
  return mentions
}

/** The mention token under the caret, if the caret sits right behind `@query` / `$query`. */
export const findActiveMention = (text: string, caret: number): ActiveMention | null => {
  const match = triggerPattern.exec(text.slice(0, caret))
  if (match === null) return null
  const query = match[3] ?? ""
  return {
    kind: match[2] === "@" ? "folder" : "skill",
    query,
    start: caret - query.length - 1,
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

const mentionPattern = /([@$])[A-Za-z0-9_][\w\-.\\/]*/g

const triggerPattern = /(^|\s)([@$])([\w\-.\\/]*)$/
