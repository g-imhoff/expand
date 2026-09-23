// @vitest-environment happy-dom
import { useState } from "react"
import { it } from "@effect/vitest"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import { Effect } from "effect"
import {
  PromptInput,
  permissionOptions,
  sandboxModeOptions,
  thinkingOptions,
  type PermissionMode,
  type PromptImageAttachment,
  type PromptMentionItem,
  type PromptSubmitPayload,
  type SandboxMode,
  type ThinkingLevel
} from "@expand/desktop/renderer/features/chat/components/PromptInput"
import { renderScoped } from "./ui-harness"

const fixtureFolders: ReadonlyArray<PromptMentionItem> = [
  { id: "src", label: "src", kind: "folder" },
  { id: "docs", label: "docs", kind: "folder" },
  { id: "package.json", label: "package.json", kind: "file" }
]

const fixtureSkills: ReadonlyArray<PromptMentionItem> = [
  { id: "commit", label: "commit", description: "Draft a commit" },
  { id: "review", label: "review", description: "Review changes" }
]

const models = [
  { id: "atlas", label: "Atlas", provider: "Anthropic" },
  { id: "atlas-mini", label: "Atlas Mini", provider: "Anthropic" },
  { id: "beacon", label: "Beacon", provider: "OpenAI", description: "Long context" }
] as const

interface HarnessProps {
  readonly onSend?: (payload: PromptSubmitPayload) => void
  readonly onImagesChange?: (images: ReadonlyArray<PromptImageAttachment>) => void
  readonly onModelChange?: (modelId: string) => void
  readonly onFavoritesChange?: (modelIds: ReadonlyArray<string>) => void
  readonly onPermissionChange?: (mode: PermissionMode) => void
  readonly onThinkingChange?: (level: ThinkingLevel) => void
  readonly folders?: ReadonlyArray<PromptMentionItem>
  readonly skills?: ReadonlyArray<PromptMentionItem>
  readonly isLoading?: boolean
}

const ComposerHarness = ({
  onSend,
  onImagesChange,
  onModelChange,
  onFavoritesChange,
  onPermissionChange,
  onThinkingChange,
  folders = [...fixtureFolders],
  skills = [...fixtureSkills],
  isLoading = false
}: HarnessProps) => {
  const [selectedModelId, setSelectedModelId] = useState<string>("atlas")
  const [favoriteModelIds, setFavoriteModelIds] = useState<ReadonlyArray<string>>([])
  const [images, setImages] = useState<ReadonlyArray<PromptImageAttachment>>([])
  const [sandbox, setSandbox] = useState<SandboxMode>("workspace")
  const [permission, setPermission] = useState<PermissionMode>("ask")
  const [thinking, setThinking] = useState<ThinkingLevel>("low")
  return (
    <PromptInput
      models={[...models]}
      selectedModelId={selectedModelId}
      onModelChange={(modelId) => {
        setSelectedModelId(modelId)
        onModelChange?.(modelId)
      }}
      favoriteModelIds={favoriteModelIds}
      onFavoritesChange={(ids) => {
        setFavoriteModelIds(ids)
        onFavoritesChange?.(ids)
      }}
      images={images}
      onImagesChange={(next) => {
        setImages(next)
        onImagesChange?.(next)
      }}
      onSend={(payload) => onSend?.(payload)}
      sandbox={sandbox}
      onSandboxChange={setSandbox}
      permission={permission}
      onPermissionChange={(mode) => {
        setPermission(mode)
        onPermissionChange?.(mode)
      }}
      thinking={thinking}
      onThinkingChange={(level) => {
        setThinking(level)
        onThinkingChange?.(level)
      }}
      folders={folders}
      skills={skills}
      isLoading={isLoading}
    />
  )
}

const openModelPicker = () => {
  fireEvent.click(screen.getByRole("button", { name: "Model: Atlas" }))
  return screen.getByPlaceholderText("Search models…")
}

const openComposerOptions = () => {
  const trigger = screen.getByRole("button", { name: "Composer options" })
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" })
}

const typeDraft = (box: HTMLTextAreaElement, text: string) => {
  fireEvent.change(box, { target: { value: text } })
  box.setSelectionRange(text.length, text.length)
  fireEvent.keyUp(box)
}

describe("PromptInput", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:preview") as typeof URL.createObjectURL
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.effect("sends trimmed text on Enter and clears the draft", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSend = vi.fn()
      const { getByLabelText } = yield* renderScoped(<ComposerHarness onSend={onSend} />)
      const box = getByLabelText("Message") as HTMLTextAreaElement
      fireEvent.change(box, { target: { value: "  hello atlas  " } })
      fireEvent.keyDown(box, { key: "Enter", shiftKey: false })
      expect(onSend).toHaveBeenCalledTimes(1)
      const payload = onSend.mock.calls[0]?.[0] as PromptSubmitPayload
      expect(payload.text).toBe("hello atlas")
      expect(payload.modelId).toBe("atlas")
      expect(payload.images).toEqual([])
      expect(box.value).toBe("")
    })))

  it.effect("does not send on Shift+Enter", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSend = vi.fn()
      const { getByLabelText } = yield* renderScoped(<ComposerHarness onSend={onSend} />)
      const box = getByLabelText("Message")
      fireEvent.change(box, { target: { value: "line one" } })
      fireEvent.keyDown(box, { key: "Enter", shiftKey: true })
      expect(onSend).not.toHaveBeenCalled()
    })))

  it.effect("keeps Send disabled for blank input", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSend = vi.fn()
      const { getByLabelText, getByRole } = yield* renderScoped(<ComposerHarness onSend={onSend} />)
      const send = getByRole("button", { name: "Send message" }) as HTMLButtonElement
      expect(send.disabled).toBe(true)
      fireEvent.change(getByLabelText("Message"), { target: { value: "   " } })
      expect(send.disabled).toBe(true)
      fireEvent.click(send)
      expect(onSend).not.toHaveBeenCalled()
    })))

  it.effect("changes the model from the searchable picker grouped by provider", () =>
    Effect.scoped(Effect.gen(function* () {
      const onModelChange = vi.fn()
      yield* renderScoped(<ComposerHarness onModelChange={onModelChange} />)
      openModelPicker()
      expect(screen.getByText("Anthropic")).not.toBeNull()
      expect(screen.getByText("OpenAI")).not.toBeNull()
      const headings = document.querySelectorAll("[cmdk-group-heading]")
      const first = headings.item(0)
      expect(first?.textContent).toContain("Anthropic")
      fireEvent.click(screen.getByRole("option", { name: /Atlas Mini/ }))
      expect(onModelChange).toHaveBeenCalledWith("atlas-mini")
    })))

  it.effect("filters models through the picker search box", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderScoped(<ComposerHarness />)
      openModelPicker()
      const search = screen.getByPlaceholderText("Search models…")
      fireEvent.change(search, { target: { value: "beacon" } })
      expect(screen.queryByRole("option", { name: /Atlas Mini/ })).toBeNull()
      expect(screen.getByRole("option", { name: /Beacon/ })).not.toBeNull()
    })))

  it.effect("toggles model favorites without changing the selection", () =>
    Effect.scoped(Effect.gen(function* () {
      const onModelChange = vi.fn()
      const onFavoritesChange = vi.fn()
      yield* renderScoped(
        <ComposerHarness onModelChange={onModelChange} onFavoritesChange={onFavoritesChange} />
      )
      openModelPicker()
      fireEvent.click(screen.getByRole("button", { name: "Favorite Atlas Mini" }))
      expect(onFavoritesChange).toHaveBeenCalledWith(["atlas-mini"])
      expect(onModelChange).not.toHaveBeenCalled()
    })))

  it.effect("toggles a model favorite with Enter without selecting a model", () =>
    Effect.scoped(Effect.gen(function* () {
      const onModelChange = vi.fn()
      const onFavoritesChange = vi.fn()
      yield* renderScoped(
        <ComposerHarness onModelChange={onModelChange} onFavoritesChange={onFavoritesChange} />
      )
      openModelPicker()
      const favorite = screen.getByRole("button", { name: "Favorite Atlas Mini" })
      favorite.focus()
      expect(fireEvent.keyDown(favorite, { key: "Enter", code: "Enter" })).toBe(true)
      expect(onModelChange).not.toHaveBeenCalled()
      fireEvent.click(favorite)
      expect(onFavoritesChange).toHaveBeenCalledWith(["atlas-mini"])
      expect(onModelChange).not.toHaveBeenCalled()
      expect(screen.getByRole("button", { name: "Unfavorite Atlas Mini" })).not.toBeNull()
    })))

  it.effect("adds images through the file picker and removes them from the chips", () =>
    Effect.scoped(Effect.gen(function* () {
      const onImagesChange = vi.fn()
      const rendered = yield* renderScoped(<ComposerHarness onImagesChange={onImagesChange} />)
      const picker = rendered.getByLabelText("Add images") as HTMLInputElement
      expect(picker.accept).toBe("image/*")
      const file = new File(["fake-bytes"], "shot.png", { type: "image/png" })
      fireEvent.change(picker, { target: { files: [file] } })
      expect(onImagesChange).toHaveBeenCalledTimes(1)
      const added = onImagesChange.mock.calls[0]?.[0] as ReadonlyArray<PromptImageAttachment>
      expect(added).toHaveLength(1)
      expect(added[0]?.name).toBe("shot.png")
      expect(added[0]?.url).toBe("blob:preview")
      expect(rendered.getByLabelText("Attached images").textContent).toContain("shot.png")
      fireEvent.click(rendered.getByRole("button", { name: "Remove shot.png" }))
      expect(onImagesChange).toHaveBeenCalledTimes(2)
      expect(onImagesChange.mock.calls[1]?.[0]).toEqual([])
    })))

  it.effect("keeps re-added images separate after an earlier image is removed", () =>
    Effect.scoped(Effect.gen(function* () {
      const onImagesChange = vi.fn()
      const rendered = yield* renderScoped(<ComposerHarness onImagesChange={onImagesChange} />)
      const picker = rendered.getByLabelText("Add images") as HTMLInputElement
      const first = new File(["first"], "first.png", { type: "image/png" })
      const second = new File(["second"], "second.png", { type: "image/png" })

      fireEvent.change(picker, { target: { files: [first] } })
      fireEvent.change(picker, { target: { files: [second] } })
      fireEvent.click(rendered.getByRole("button", { name: "Remove first.png" }))
      fireEvent.change(picker, { target: { files: [second] } })

      const readded = onImagesChange.mock.lastCall?.[0] as ReadonlyArray<PromptImageAttachment>
      expect(readded).toHaveLength(2)
      expect(new Set(readded.map((image) => image.id)).size).toBe(2)

      fireEvent.click(rendered.getAllByRole("button", { name: "Remove second.png" })[0]!)
      const remaining = onImagesChange.mock.lastCall?.[0] as ReadonlyArray<PromptImageAttachment>
      expect(remaining).toHaveLength(1)
      expect(remaining[0]?.id).toBe(readded[1]?.id)
    })))

  it.effect("opens a larger preview when an image card is clicked", () =>
    Effect.scoped(Effect.gen(function* () {
      const rendered = yield* renderScoped(<ComposerHarness />)
      const picker = rendered.getByLabelText("Add images") as HTMLInputElement
      const file = new File(["fake-bytes"], "shot.png", { type: "image/png" })
      fireEvent.change(picker, { target: { files: [file] } })
      fireEvent.click(rendered.getByRole("button", { name: "Preview shot.png" }))
      const preview = yield* Effect.promise(() => rendered.findByRole("dialog", { name: "shot.png" }))
      const large = preview.querySelector("img") as HTMLImageElement
      expect(large.getAttribute("src")).toBe("blob:preview")
      expect(large.getAttribute("alt")).toBe("shot.png")
      const title = preview.querySelector("h2") as HTMLHeadingElement
      expect(title.className).toContain("truncate")
      expect(title.parentElement?.className).toContain("min-w-0")
      fireEvent.click(rendered.getByRole("button", { name: "Close" }))
      expect(rendered.queryByRole("dialog", { name: "shot.png" })).toBeNull()
    })))

  it.effect("disables the composer and announces status while loading", () =>
    Effect.scoped(Effect.gen(function* () {
      const { getByLabelText, getByRole } = yield* renderScoped(<ComposerHarness isLoading />)
      expect((getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true)
      expect((getByRole("button", { name: "Sending" }) as HTMLButtonElement).disabled).toBe(true)
      expect(getByRole("status").textContent).toBe("Sending…")
    })))

  it.effect("changes the sandbox mode from the options menu", () =>
    Effect.scoped(Effect.gen(function* () {
      const rendered = yield* renderScoped(<ComposerHarness />)
      openComposerOptions()
      const fullAccess = yield* Effect.promise(() => rendered.findByText("Full access"))
      fireEvent.click(fullAccess)
      openComposerOptions()
      const selected = yield* Effect.promise(() =>
        rendered.findByRole("menuitemradio", { name: /Full access/ }))
      expect(selected.getAttribute("aria-checked")).toBe("true")
    })))

  it.effect("sends the selected permission mode to the parent", () =>
    Effect.scoped(Effect.gen(function* () {
      const onPermissionChange = vi.fn()
      const rendered = yield* renderScoped(
        <ComposerHarness onPermissionChange={onPermissionChange} />
      )
      openComposerOptions()
      const readOnly = yield* Effect.promise(() =>
        rendered.findByRole("menuitemradio", { name: /Read-only/ }))
      fireEvent.click(readOnly)
      expect(onPermissionChange).toHaveBeenCalledExactlyOnceWith("read-only")
      openComposerOptions()
      const selected = yield* Effect.promise(() =>
        rendered.findByRole("menuitemradio", { name: /Read-only/ }))
      expect(selected.getAttribute("aria-checked")).toBe("true")
    })))

  it.effect("sends the selected thinking level to the parent", () =>
    Effect.scoped(Effect.gen(function* () {
      const onThinkingChange = vi.fn()
      const rendered = yield* renderScoped(
        <ComposerHarness onThinkingChange={onThinkingChange} />
      )
      openComposerOptions()
      const high = yield* Effect.promise(() =>
        rendered.findByRole("menuitemradio", { name: /High/ }))
      fireEvent.click(high)
      expect(onThinkingChange).toHaveBeenCalledExactlyOnceWith("high")
      openComposerOptions()
      const selected = yield* Effect.promise(() =>
        rendered.findByRole("menuitemradio", { name: /High/ }))
      expect(selected.getAttribute("aria-checked")).toBe("true")
    })))

  it.effect("renders folder and skill mentions as distinct pills", () =>
    Effect.scoped(Effect.gen(function* () {
      const rendered = yield* renderScoped(<ComposerHarness />)
      const box = rendered.getByLabelText("Message") as HTMLTextAreaElement
      typeDraft(box, "use @src and $commit")
      const folder = rendered.container.querySelector('[data-mention="folder"]')
      const skill = rendered.container.querySelector('[data-mention="skill"]')
      expect(folder?.textContent).toBe("@src")
      expect(skill?.textContent).toBe("$commit")
      expect(folder?.className).not.toBe(skill?.className)
    })))

  it.effect("suggests folders after @ and inserts the choice on Enter", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSend = vi.fn()
      const rendered = yield* renderScoped(<ComposerHarness onSend={onSend} />)
      const box = rendered.getByLabelText("Message") as HTMLTextAreaElement
      typeDraft(box, "look @sr")
      expect(rendered.getByRole("listbox", { name: "Folders" })).not.toBeNull()
      expect(rendered.getByRole("option", { name: /src/ })).not.toBeNull()
      expect(rendered.queryByRole("option", { name: /docs/ })).toBeNull()
      expect(rendered.getByRole("option", { name: /src/ }).textContent).toContain("Folder")
      fireEvent.keyDown(box, { key: "Enter", shiftKey: false })
      expect(onSend).not.toHaveBeenCalled()
      expect(box.value).toBe("look @src ")
      expect(rendered.queryByRole("listbox")).toBeNull()
    })))

  it.effect("reports mention suggestions and arrow selection from the focused textarea", () =>
    Effect.scoped(Effect.gen(function* () {
      const rendered = yield* renderScoped(<ComposerHarness />)
      const box = rendered.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement
      box.focus()
      expect(box.getAttribute("aria-autocomplete")).toBe("list")
      expect(box.getAttribute("aria-expanded")).toBe("false")
      expect(box.hasAttribute("aria-controls")).toBe(false)
      expect(box.hasAttribute("aria-activedescendant")).toBe(false)

      typeDraft(box, "open @")
      const listbox = rendered.getByRole("listbox", { name: "Folders" })
      const first = rendered.getByRole("option", { name: /src/ })
      const second = rendered.getByRole("option", { name: /docs/ })
      expect(box.getAttribute("aria-expanded")).toBe("true")
      expect(box.getAttribute("aria-controls")).toBe(listbox.id)
      expect(box.getAttribute("aria-activedescendant")).toBe(first.id)
      expect(first.getAttribute("aria-selected")).toBe("true")

      fireEvent.keyDown(box, { key: "ArrowDown" })
      expect(box.getAttribute("aria-activedescendant")).toBe(second.id)
      expect(first.getAttribute("aria-selected")).toBe("false")
      expect(second.getAttribute("aria-selected")).toBe("true")
      expect(document.activeElement).toBe(box)

      fireEvent.keyDown(box, { key: "ArrowUp" })
      expect(box.getAttribute("aria-activedescendant")).toBe(first.id)

      fireEvent.keyDown(box, { key: "Escape" })
      expect(rendered.queryByRole("listbox")).toBeNull()
      expect(box.getAttribute("aria-expanded")).toBe("false")
      expect(box.hasAttribute("aria-controls")).toBe(false)
      expect(box.hasAttribute("aria-activedescendant")).toBe(false)
      expect(document.activeElement).toBe(box)
    })))

  it.effect("does not report an active option when no mention matches", () =>
    Effect.scoped(Effect.gen(function* () {
      const rendered = yield* renderScoped(<ComposerHarness />)
      const box = rendered.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement
      typeDraft(box, "open @nothing")
      const listbox = rendered.getByRole("listbox", { name: "Folders" })
      expect(box.getAttribute("aria-expanded")).toBe("true")
      expect(box.getAttribute("aria-controls")).toBe(listbox.id)
      expect(box.hasAttribute("aria-activedescendant")).toBe(false)
      expect(rendered.queryByRole("option")).toBeNull()
    })))

  it.effect("suggests skills after $ and inserts the choice on click", () =>
    Effect.scoped(Effect.gen(function* () {
      const rendered = yield* renderScoped(<ComposerHarness />)
      const box = rendered.getByLabelText("Message") as HTMLTextAreaElement
      typeDraft(box, "run $c")
      expect(rendered.getByRole("listbox", { name: "Skills" })).not.toBeNull()
      fireEvent.mouseDown(rendered.getByRole("option", { name: /commit/ }))
      expect(box.value).toBe("run $commit ")
    })))

  it.effect("labels file entries as File in folder suggestions", () =>
    Effect.scoped(Effect.gen(function* () {
      const rendered = yield* renderScoped(<ComposerHarness />)
      const box = rendered.getByLabelText("Message") as HTMLTextAreaElement
      typeDraft(box, "open @package")
      const option = rendered.getByRole("option", { name: /package/ })
      expect(option.textContent).toContain("package.json")
      expect(option.textContent).toContain("File")
    })))

  it.effect("exposes the sandbox, permission and thinking option catalogs", () =>
    Effect.scoped(Effect.gen(function* () {
      expect(sandboxModeOptions.map((option) => option.id)).toEqual(["off", "workspace", "full"])
      expect(permissionOptions.map((option) => option.id)).toEqual(["ask", "auto-approve", "read-only"])
      expect(thinkingOptions.map((option) => option.id)).toEqual(["off", "low", "high"])
    })))

  it.effect("includes typed mentions with offsets in the send payload", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSend = vi.fn()
      const { getByLabelText } = yield* renderScoped(<ComposerHarness onSend={onSend} />)
      const box = getByLabelText("Message") as HTMLTextAreaElement
      typeDraft(box, "fix @src with $review ")
      fireEvent.keyDown(box, { key: "Enter", shiftKey: false })
      expect(onSend).toHaveBeenCalledTimes(1)
      const payload = onSend.mock.calls[0]?.[0] as PromptSubmitPayload
      expect(payload.mentions).toEqual([
        { kind: "folder", key: "src", start: 4, end: 8 },
        { kind: "skill", key: "review", start: 14, end: 21 }
      ])
    })))

  it.effect("keeps selected IDs and offsets for duplicate labels across draft edits", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSend = vi.fn()
      const folders = [
        { id: "folder:first", label: "shared", kind: "folder" },
        { id: "folder:second", label: "shared", kind: "folder" }
      ] as const
      const rendered = yield* renderScoped(<ComposerHarness folders={folders} onSend={onSend} />)
      const box = rendered.getByLabelText("Message") as HTMLTextAreaElement

      typeDraft(box, "  inspect @sha")
      fireEvent.mouseDown(rendered.getAllByRole("option", { name: /shared/ })[1]!)
      expect(box.value).toBe("  inspect @shared ")

      typeDraft(box, "  inspect @shared and @sha")
      fireEvent.mouseDown(rendered.getAllByRole("option", { name: /shared/ })[0]!)
      expect(box.value).toBe("  inspect @shared and @shared ")

      typeDraft(box, "  please inspect @shared and @shared ")
      fireEvent.click(rendered.getByRole("button", { name: "Send message" }))

      const payload = onSend.mock.calls[0]?.[0] as PromptSubmitPayload
      expect(payload.text).toBe("please inspect @shared and @shared")
      expect(payload.mentions).toEqual([
        { kind: "folder", key: "folder:second", start: 15, end: 22 },
        { kind: "folder", key: "folder:first", start: 27, end: 34 }
      ])
    })))

  it.effect("drops a selected ID when its token is edited", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSend = vi.fn()
      const folders = [{ id: "folder:shared", label: "shared", kind: "folder" }] as const
      const rendered = yield* renderScoped(<ComposerHarness folders={folders} onSend={onSend} />)
      const box = rendered.getByLabelText("Message") as HTMLTextAreaElement

      typeDraft(box, "open @sha")
      fireEvent.mouseDown(rendered.getByRole("option", { name: /shared/ }))
      typeDraft(box, "open @shored ")
      fireEvent.click(rendered.getByRole("button", { name: "Send message" }))

      const payload = onSend.mock.calls[0]?.[0] as PromptSubmitPayload
      expect(payload.mentions).toEqual([{ kind: "folder", key: "shored", start: 5, end: 12 }])
    })))

  it.effect("keeps the second selected ID when an identical earlier mention is removed", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSend = vi.fn()
      const folders = [
        { id: "folder:first", label: "shared", kind: "folder" },
        { id: "folder:second", label: "shared", kind: "folder" }
      ] as const
      const rendered = yield* renderScoped(<ComposerHarness folders={folders} onSend={onSend} />)
      const box = rendered.getByLabelText("Message") as HTMLTextAreaElement

      typeDraft(box, "@sha")
      fireEvent.mouseDown(rendered.getAllByRole("option", { name: /shared/ })[0]!)
      typeDraft(box, "@shared @sha")
      fireEvent.mouseDown(rendered.getAllByRole("option", { name: /shared/ })[1]!)

      box.setSelectionRange(0, 8)
      fireEvent.select(box)
      fireEvent.change(box, { target: { value: "@shared ", selectionStart: 0, selectionEnd: 0 } })
      fireEvent.click(rendered.getByRole("button", { name: "Send message" }))

      const payload = onSend.mock.calls[0]?.[0] as PromptSubmitPayload
      expect(payload.mentions).toEqual([
        { kind: "folder", key: "folder:second", start: 0, end: 7 }
      ])
    })))

  it.effect("uses the full selected label when it contains spaces", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSend = vi.fn()
      const folders = [{ id: "folder:my-docs", label: "My docs", kind: "folder" }] as const
      const rendered = yield* renderScoped(<ComposerHarness folders={folders} onSend={onSend} />)
      const box = rendered.getByLabelText("Message") as HTMLTextAreaElement

      typeDraft(box, "open @My")
      fireEvent.mouseDown(rendered.getByRole("option", { name: /My docs/ }))
      expect(box.value).toBe("open @My docs ")
      fireEvent.click(rendered.getByRole("button", { name: "Send message" }))

      const payload = onSend.mock.calls[0]?.[0] as PromptSubmitPayload
      expect(payload.mentions).toEqual([
        { kind: "folder", key: "folder:my-docs", start: 5, end: 13 }
      ])
    })))

  it.effect("sends the selected skill ID while keeping its label in the text", () =>
    Effect.scoped(Effect.gen(function* () {
      const onSend = vi.fn()
      const skills = [{ id: "skill:review", label: "review" }] as const
      const rendered = yield* renderScoped(<ComposerHarness skills={skills} onSend={onSend} />)
      const box = rendered.getByLabelText("Message") as HTMLTextAreaElement

      typeDraft(box, "run $rev")
      fireEvent.mouseDown(rendered.getByRole("option", { name: /review/ }))
      fireEvent.click(rendered.getByRole("button", { name: "Send message" }))

      const payload = onSend.mock.calls[0]?.[0] as PromptSubmitPayload
      expect(payload.text).toBe("run $review")
      expect(payload.mentions).toEqual([
        { kind: "skill", key: "skill:review", start: 4, end: 11 }
      ])
    })))
})
