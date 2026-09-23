// @vitest-environment happy-dom
import { useState } from "react"
import { it } from "@effect/vitest"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import { Effect } from "effect"
import {
  PromptInput,
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
  readonly folders?: ReadonlyArray<PromptMentionItem>
  readonly skills?: ReadonlyArray<PromptMentionItem>
  readonly isLoading?: boolean
}

const ComposerHarness = ({
  onSend,
  onImagesChange,
  onModelChange,
  onFavoritesChange,
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
      onPermissionChange={setPermission}
      thinking={thinking}
      onThinkingChange={setThinking}
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
      const trigger = rendered.getByRole("button", { name: "Composer options" })
      const openMenu = () => {
        trigger.focus()
        fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" })
      }
      openMenu()
      const fullAccess = yield* Effect.promise(() => rendered.findByText("Full access"))
      fireEvent.click(fullAccess)
      openMenu()
      const selected = yield* Effect.promise(() =>
        rendered.findByRole("menuitemradio", { name: /Full access/ }))
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
})
