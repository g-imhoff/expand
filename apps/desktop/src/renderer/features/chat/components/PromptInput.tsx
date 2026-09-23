import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { ArrowUpIcon, PlusIcon, XIcon } from "lucide-react"
import { cn } from "@expand/desktop/renderer/components/ui/class-names"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@expand/desktop/renderer/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@expand/desktop/renderer/components/ui/dropdown-menu"
import { ModelPicker } from "@expand/desktop/renderer/features/chat/components/ModelPicker"
import { renderMentionSegments } from "@expand/desktop/renderer/features/chat/components/mention-segments"
import {
  filterMentionItems,
  findActiveMention,
  findMentionTokenEnd,
  reconcileSelectedMentions,
  resolveMentions,
  type ActiveMention,
  type PromptMention,
  type PromptMentionItem,
  type SelectedPromptMention
} from "@expand/desktop/renderer/features/chat/components/prompt-mentions"

export interface PromptModelOption {
  readonly id: string
  readonly label: string
  readonly provider: string
  readonly description?: string
  readonly disabled?: boolean
}

export interface PromptImageAttachment {
  readonly id: string
  readonly name: string
  readonly url: string
}

export interface PromptSubmitPayload {
  readonly text: string
  readonly modelId: string
  readonly images: ReadonlyArray<PromptImageAttachment>
  readonly mentions: ReadonlyArray<PromptMention>
}

export interface PromptInputProps {
  readonly models: ReadonlyArray<PromptModelOption>
  readonly selectedModelId: string
  readonly onModelChange: (modelId: string) => void
  readonly favoriteModelIds: ReadonlyArray<string>
  readonly onFavoritesChange: (modelIds: ReadonlyArray<string>) => void
  readonly images: ReadonlyArray<PromptImageAttachment>
  readonly onImagesChange: (images: ReadonlyArray<PromptImageAttachment>) => void
  readonly onSend: (payload: PromptSubmitPayload) => void
  readonly sandbox: SandboxMode
  readonly onSandboxChange: (mode: SandboxMode) => void
  readonly permission: PermissionMode
  readonly onPermissionChange: (mode: PermissionMode) => void
  readonly thinking: ThinkingLevel
  readonly onThinkingChange: (level: ThinkingLevel) => void
  readonly folders?: ReadonlyArray<PromptMentionItem>
  readonly skills?: ReadonlyArray<PromptMentionItem>
  readonly isLoading?: boolean
  readonly placeholder?: string
}

export type SandboxMode = "off" | "workspace" | "full"

export type PermissionMode = "ask" | "auto-approve" | "read-only"

export type ThinkingLevel = "off" | "low" | "high"

export const sandboxModeOptions: ReadonlyArray<{
  readonly id: SandboxMode
  readonly label: string
  readonly description: string
}> = [
  { id: "off", label: "Sandbox off", description: "No filesystem access" },
  { id: "workspace", label: "Workspace", description: "Current project only" },
  { id: "full", label: "Full access", description: "Whole machine" }
]

export const permissionOptions: ReadonlyArray<{
  readonly id: PermissionMode
  readonly label: string
  readonly description: string
}> = [
  { id: "ask", label: "Ask first", description: "Confirm each action" },
  { id: "auto-approve", label: "Auto-approve", description: "Run without asking" },
  { id: "read-only", label: "Read-only", description: "Never modify files" }
]

export const thinkingOptions: ReadonlyArray<{
  readonly id: ThinkingLevel
  readonly label: string
  readonly description: string
}> = [
  { id: "off", label: "No thinking", description: "Answer directly" },
  { id: "low", label: "Low", description: "Brief reasoning" },
  { id: "high", label: "High", description: "Deep reasoning" }
]

export const PromptInput = ({
  models,
  selectedModelId,
  onModelChange,
  favoriteModelIds,
  onFavoritesChange,
  images,
  onImagesChange,
  onSend,
  sandbox,
  onSandboxChange,
  permission,
  onPermissionChange,
  thinking,
  onThinkingChange,
  folders = [],
  skills = [],
  isLoading = false,
  placeholder = "Message…  ·  @ for folders  ·  $ for skills"
}: PromptInputProps) => {
  const [draft, setDraft] = useState("")
  const [selectedMentions, setSelectedMentions] = useState<ReadonlyArray<SelectedPromptMention>>([])
  const [caret, setCaret] = useState(0)
  const [selectionEnd, setSelectionEnd] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionClosed, setMentionClosed] = useState(false)
  const [previewImage, setPreviewImage] = useState<PromptImageAttachment | null>(null)
  const mentionListboxId = useId()
  const textareaId = `${mentionListboxId}-textarea`
  const nextImageId = useRef(0)
  const ownedImageUrls = useRef(new Map<string, { url: string; observed: boolean }>())
  const composingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const backdropRef = useRef<HTMLDivElement | null>(null)
  const canSend = draft.trim() !== "" && !isLoading

  const mentionCaret = Math.max(caret, selectionEnd)
  const mentionCandidate = findActiveMention(draft, mentionCaret)
  const activeMention: ActiveMention | null =
    mentionCandidate !== null && caret >= mentionCandidate.start
      ? {
          ...mentionCandidate,
          query: selectionEnd > caret
            ? draft.slice(mentionCandidate.start + 1, caret)
            : mentionCandidate.query
        }
      : null
  const mentionItems = activeMention === null || activeMention.kind === "folder" ? folders : skills
  const mentionMatches =
    activeMention === null ? [] : filterMentionItems(mentionItems, activeMention.query)
  const mentionOpen = activeMention !== null && !mentionClosed && !isLoading
  const activeMentionIndex =
    mentionOpen && mentionMatches.length > 0 ? Math.min(mentionIndex, mentionMatches.length - 1) : null
  const activeMentionOptionId =
    activeMentionIndex === null ? undefined : `${mentionListboxId}-option-${activeMentionIndex}`

  useEffect(() => {
    setMentionIndex(0)
  }, [activeMention?.kind, activeMention?.query])

  useEffect(() => {
    setPreviewImage((current) =>
      current !== null && !images.some((image) => image.id === current.id && image.url === current.url)
        ? null
        : current
    )
    for (const [id, owned] of ownedImageUrls.current) {
      if (images.some((image) => image.id === id && image.url === owned.url)) {
        owned.observed = true
      } else if (owned.observed) {
        URL.revokeObjectURL(owned.url)
        ownedImageUrls.current.delete(id)
      }
    }
  }, [images])

  useEffect(() => () => {
    for (const owned of ownedImageUrls.current.values()) {
      URL.revokeObjectURL(owned.url)
    }
    ownedImageUrls.current.clear()
  }, [])

  const send = () => {
    const text = draft.trim()
    if (text === "" || isLoading) return
    const leadingWhitespace = draft.length - draft.trimStart().length
    const shiftedSelections = selectedMentions.map((mention) => ({
      ...mention,
      start: mention.start - leadingWhitespace,
      end: mention.end - leadingWhitespace
    }))
    onSend({
      text,
      modelId: selectedModelId,
      images,
      mentions: resolveMentions(text, shiftedSelections)
    })
    setDraft("")
    setSelectedMentions([])
    setCaret(0)
    setSelectionEnd(0)
    setMentionClosed(false)
  }

  const acceptMention = (item: PromptMentionItem, active: ActiveMention) => {
    const marker = active.kind === "folder" ? "@" : "$"
    const token = `${marker}${item.label}`
    const selectedEnd = selectedMentions.find(
      (mention) => mention.start === active.start && mention.end >= active.caret
    )?.end ?? active.caret
    const replacementEnd = Math.max(findMentionTokenEnd(draft, active.caret), selectedEnd)
    const suffix = draft.slice(replacementEnd)
    const replacement = `${token}${suffix === "" ? " " : ""}`
    const next = draft.slice(0, active.start) + replacement + suffix
    const nextCaret = active.start + replacement.length + (/^\s/.test(suffix) ? 1 : 0)
    const shift = replacement.length - (replacementEnd - active.start)
    setSelectedMentions((current) => [
      ...current.flatMap((mention) => {
        if (mention.end <= active.start) return [mention]
        if (mention.start >= replacementEnd) {
          return [{ ...mention, start: mention.start + shift, end: mention.end + shift }]
        }
        return []
      }),
      { kind: active.kind, key: item.id, start: active.start, end: active.start + token.length, token }
    ])
    setDraft(next)
    setCaret(nextCaret)
    setSelectionEnd(nextCaret)
    setMentionClosed(false)
    const focusTarget = textareaRef.current
    focusTarget?.focus()
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        focusTarget?.setSelectionRange(nextCaret, nextCaret)
      })
    } else {
      focusTarget?.setSelectionRange(nextCaret, nextCaret)
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return
    }
    if (mentionOpen) {
      if (event.key === "Escape") {
        event.preventDefault()
        setMentionClosed(true)
        return
      }
      if (mentionMatches.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault()
          setMentionIndex((index) => (index + 1) % mentionMatches.length)
          return
        }
        if (event.key === "ArrowUp") {
          event.preventDefault()
          setMentionIndex((index) => (index - 1 + mentionMatches.length) % mentionMatches.length)
          return
        }
        if ((event.key === "Enter" || event.key === "Tab") && activeMention !== null) {
          event.preventDefault()
          const item = mentionMatches[activeMentionIndex ?? 0]
          if (item !== undefined) acceptMention(item, activeMention)
          return
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  const handleFiles = (files: FileList | null) => {
    if (files === null) return
    const next = [...images]
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue
      let id: string
      do {
        id = `prompt-image-${nextImageId.current++}`
      } while (next.some((image) => image.id === id))
      const url = URL.createObjectURL(file)
      ownedImageUrls.current.set(id, { url, observed: false })
      next.push({ id, name: file.name, url })
    }
    if (next.length !== images.length) onImagesChange(next)
    if (fileInputRef.current !== null) fileInputRef.current.value = ""
  }

  const removeImage = (id: string) => {
    onImagesChange(images.filter((image) => image.id !== id))
  }

  return (
    <div className="bg-background w-full rounded-xl border shadow-sm">
      {images.length > 0 && (
        <ul aria-label="Attached images" className="flex flex-wrap gap-2 px-3 pt-3">
          {images.map((image) => (
            <li key={image.id} className="relative size-16">
              <button
                type="button"
                onClick={() => setPreviewImage(image)}
                aria-label={`Preview ${image.name}`}
                className="border-border focus-visible:outline-ring block size-16 overflow-hidden rounded-md border outline-none focus-visible:outline-2"
              >
                <img
                  src={image.url}
                  alt=""
                  aria-hidden="true"
                  className="size-full object-cover"
                />
                <span
                  aria-hidden="true"
                  className="absolute inset-0 flex items-end bg-gradient-to-t from-black/70 to-transparent p-1 opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
                >
                  <span className="truncate text-[10px] font-medium text-white">{image.name}</span>
                </span>
              </button>
              <button
                type="button"
                aria-label={`Remove ${image.name}`}
                onClick={() => removeImage(image.id)}
                className="bg-background border-border text-muted-foreground hover:text-foreground focus-visible:outline-ring absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border shadow-sm outline-none focus-visible:outline-2"
              >
                <XIcon className="size-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={previewImage !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewImage(null)
        }}
      >
        <DialogContent className="rounded-xl sm:max-w-xl">
          <DialogHeader className="min-w-0">
            <DialogTitle className="min-w-0 truncate pr-6">{previewImage?.name ?? "Image preview"}</DialogTitle>
            <DialogDescription>Full-size preview of the attached image.</DialogDescription>
          </DialogHeader>
          {previewImage !== null && (
            <img
              src={previewImage.url}
              alt={previewImage.name}
              className="max-h-[60vh] w-full rounded-md object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
      <label htmlFor={textareaId} className="sr-only">
        Message
      </label>
      <div className="relative">
        <div
          aria-hidden="true"
          ref={backdropRef}
          className="text-foreground pointer-events-none absolute inset-0 overflow-hidden px-3 py-2.5 text-sm break-words whitespace-pre-wrap"
        >
          {renderMentionSegments(draft, selectedMentions)}
        </div>
        <textarea
          id={textareaId}
          ref={textareaRef}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={mentionOpen}
          aria-controls={mentionOpen ? mentionListboxId : undefined}
          aria-activedescendant={activeMentionOptionId}
          value={draft}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          onChange={(event) => {
            const nextDraft = event.target.value
            const nextCaret = event.target.selectionStart ?? nextDraft.length
            setSelectedMentions((current) =>
              reconcileSelectedMentions(draft, nextDraft, current, {
                previousStart: caret,
                previousEnd: selectionEnd,
                nextCaret
              })
            )
            setDraft(nextDraft)
            setCaret(nextCaret)
            setSelectionEnd(event.target.selectionEnd ?? nextCaret)
            setMentionClosed(false)
          }}
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart ?? 0)
            setSelectionEnd(event.currentTarget.selectionEnd ?? 0)
          }}
          onKeyUp={(event) => {
            setCaret(event.currentTarget.selectionStart ?? 0)
            setSelectionEnd(event.currentTarget.selectionEnd ?? 0)
          }}
          onScroll={(event) => {
            if (backdropRef.current !== null) {
              backdropRef.current.scrollTop = event.currentTarget.scrollTop
            }
          }}
          onKeyDown={handleKeyDown}
          rows={2}
          disabled={isLoading}
          placeholder={placeholder}
          className="text-foreground placeholder:text-muted-foreground relative w-full resize-none overflow-y-auto bg-transparent px-3 py-2.5 text-sm text-transparent caret-foreground outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        {mentionOpen && activeMention !== null && (
          <div
            id={mentionListboxId}
            role="listbox"
            aria-label={activeMention.kind === "folder" ? "Folders" : "Skills"}
            className="bg-popover border-border absolute bottom-full left-3 z-10 mb-1 max-h-56 w-64 overflow-auto rounded-md border p-1 shadow-md"
          >
            {mentionMatches.length === 0 ? (
              <p className="text-muted-foreground px-2 py-1.5 text-sm">
                No {activeMention.kind === "folder" ? "folders" : "skills"} match “{activeMention.query}”.
              </p>
            ) : (
              mentionMatches.map((item, index) => (
                <div
                  key={item.id}
                  id={`${mentionListboxId}-option-${index}`}
                  role="option"
                  aria-selected={index === activeMentionIndex}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    acceptMention(item, activeMention)
                  }}
                  onMouseEnter={() => setMentionIndex(index)}
                  className={cn(
                    "flex cursor-pointer flex-col rounded-sm px-2 py-1.5 text-sm",
                    index === mentionIndex && "bg-accent"
                  )}
                >
                  <span>
                    <span aria-hidden="true" className="text-muted-foreground">
                      {activeMention.kind === "folder" ? "@" : "$"}
                    </span>
                    {item.label}
                  </span>
                  {activeMention.kind === "folder" ? (
                    <span className="text-muted-foreground text-xs">
                      {item.kind === "file" ? "File" : "Folder"}
                    </span>
                  ) : (
                    item.description !== undefined && (
                      <span className="text-muted-foreground text-xs">{item.description}</span>
                    )
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 pb-3">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Composer options"
            className="border-border text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:outline-ring flex size-9 items-center justify-center rounded-md border outline-none focus-visible:outline-2"
          >
            <PlusIcon className="size-4" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                Add image…
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Sandbox</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuRadioGroup
                value={sandbox}
                onValueChange={(value) => onSandboxChange(value as SandboxMode)}
              >
                {sandboxModeOptions.map((option) => (
                  <DropdownMenuRadioItem key={option.id} value={option.id}>
                    <span className="flex flex-col">
                      <span>{option.label}</span>
                      <span className="text-muted-foreground text-xs">{option.description}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Permissions</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuRadioGroup
                value={permission}
                onValueChange={(value) => onPermissionChange(value as PermissionMode)}
              >
                {permissionOptions.map((option) => (
                  <DropdownMenuRadioItem key={option.id} value={option.id}>
                    <span className="flex flex-col">
                      <span>{option.label}</span>
                      <span className="text-muted-foreground text-xs">{option.description}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Thinking</DropdownMenuLabel>
            <DropdownMenuGroup>
              <DropdownMenuRadioGroup
                value={thinking}
                onValueChange={(value) => onThinkingChange(value as ThinkingLevel)}
              >
                {thinkingOptions.map((option) => (
                  <DropdownMenuRadioItem key={option.id} value={option.id}>
                    <span className="flex flex-col">
                      <span>{option.label}</span>
                      <span className="text-muted-foreground text-xs">{option.description}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <ModelPicker
          models={models}
          selectedModelId={selectedModelId}
          onModelChange={onModelChange}
          favoriteModelIds={favoriteModelIds}
          onFavoritesChange={onFavoritesChange}
          disabled={isLoading}
        />
        <span className="min-w-0 flex-1" aria-hidden="true" />
        {isLoading && (
          <span role="status" className="sr-only">
            Sending…
          </span>
        )}
        <button
          type="button"
          aria-label={isLoading ? "Sending" : "Send message"}
          disabled={!canSend}
          onClick={send}
          className={cn(
            "bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-full outline-none",
            "hover:opacity-85 focus-visible:outline-ring focus-visible:outline-2",
            "disabled:cursor-not-allowed disabled:opacity-30"
          )}
        >
          {isLoading ? (
            <span
              aria-hidden="true"
              className="border-primary-foreground/40 border-t-primary-foreground size-4 rounded-full border-2 motion-safe:animate-spin"
            />
          ) : (
            <ArrowUpIcon className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        aria-label="Add images"
        onChange={(event) => handleFiles(event.target.files)}
        className="sr-only"
        tabIndex={-1}
      />
    </div>
  )
}

export type {
  PromptMention,
  PromptMentionItem,
  PromptMentionKind
} from "@expand/desktop/renderer/features/chat/components/prompt-mentions"
