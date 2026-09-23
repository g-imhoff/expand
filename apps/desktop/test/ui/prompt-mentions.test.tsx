import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { renderMentionSegments } from "@expand/desktop/renderer/features/chat/components/mention-segments"
import {
  findActiveMention,
  reconcileSelectedMentions,
  resolveMentions,
  type SelectedPromptMention
} from "@expand/desktop/renderer/features/chat/components/prompt-mentions"

describe("prompt mentions", () => {
  it("opens suggestions only for mention tokens at the start or after whitespace", () => {
    expect(findActiveMention("alice@example.com", 17)).toBeNull()
    expect(findActiveMention("cost $100", 9)).toBeNull()
    expect(findActiveMention("@src", 4)).toEqual({
      kind: "folder",
      query: "src",
      start: 0,
      caret: 4
    })
    expect(findActiveMention("open @src", 9)).toEqual({
      kind: "folder",
      query: "src",
      start: 5,
      caret: 9
    })
    expect(findActiveMention("$commit", 7)).toEqual({
      kind: "skill",
      query: "commit",
      start: 0,
      caret: 7
    })
    expect(findActiveMention("run $", 5)).toEqual({
      kind: "skill",
      query: "",
      start: 4,
      caret: 5
    })
  })

  it("parses and highlights valid mentions without tagging email or currency", () => {
    const text = "alice@example.com costs $100; use @src and $commit"
    expect(resolveMentions(text, [])).toEqual([
      { kind: "folder", key: "src", start: 34, end: 38 },
      { kind: "skill", key: "commit", start: 43, end: 50 }
    ])

    const markup = renderToStaticMarkup(renderMentionSegments(text))
    expect(markup).toContain("alice@example.com costs $100; use ")
    expect(markup.match(/data-mention=/g)).toHaveLength(2)
    expect(markup).toMatch(/data-mention="folder"[^>]*>@src<\/span>/)
    expect(markup).toMatch(/data-mention="skill"[^>]*>\$commit<\/span>/)
  })

  it("keeps selected IDs at valid boundaries and drops them after a boundary edit", () => {
    const selected: SelectedPromptMention = {
      kind: "folder",
      key: "folder:src",
      start: 5,
      end: 9,
      token: "@src"
    }
    expect(resolveMentions("open @src", [selected])).toEqual([
      { kind: "folder", key: "folder:src", start: 5, end: 9 }
    ])
    expect(
      reconcileSelectedMentions("open @src", "open x@src", [selected], {
        previousStart: 5,
        previousEnd: 5,
        nextCaret: 6
      })
    ).toEqual([])
    expect(resolveMentions("open x@src", [{ ...selected, start: 6, end: 10 }])).toEqual([])
  })

  it("highlights a selected numeric skill while leaving ordinary currency plain", () => {
    const text = "pay $100 with $100"
    const selected: SelectedPromptMention = {
      kind: "skill",
      key: "skill:100",
      start: 14,
      end: 18,
      token: "$100"
    }
    expect(resolveMentions(text, [selected])).toEqual([
      { kind: "skill", key: "skill:100", start: 14, end: 18 }
    ])

    const markup = renderToStaticMarkup(renderMentionSegments(text, [selected]))
    expect(markup).toContain("pay $100 with ")
    expect(markup.match(/data-mention="skill"/g)).toHaveLength(1)
    expect(markup).toMatch(/data-mention="skill"[^>]*>\$100<\/span>/)
    expect(markup.replace(/<[^>]*>/g, "")).toBe(text)
  })

  it("highlights the full selected label and leaves email plain", () => {
    const text = "alice@example.com opens @My docs"
    const selected: SelectedPromptMention = {
      kind: "folder",
      key: "folder:my-docs",
      start: 24,
      end: 32,
      token: "@My docs"
    }
    expect(resolveMentions(text, [selected])).toEqual([
      { kind: "folder", key: "folder:my-docs", start: 24, end: 32 }
    ])

    const markup = renderToStaticMarkup(renderMentionSegments(text, [selected]))
    expect(markup).toContain("alice@example.com opens ")
    expect(markup.match(/data-mention="folder"/g)).toHaveLength(1)
    expect(markup).toMatch(/data-mention="folder"[^>]*>@My docs<\/span>/)
    expect(markup.replace(/<[^>]*>/g, "")).toBe(text)
  })
})
