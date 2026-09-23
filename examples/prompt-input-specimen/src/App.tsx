import { useState } from "react"
import {
  PromptInput,
  type PermissionMode,
  type PromptImageAttachment,
  type PromptMentionItem,
  type PromptSubmitPayload,
  type SandboxMode,
  type ThinkingLevel
} from "@expand/desktop/renderer/features/chat/components/PromptInput"

export const App = () => {
  const [dark, setDark] = useState(false)
  const [sent, setSent] = useState<ReadonlyArray<PromptSubmitPayload>>([])
  if (dark) document.documentElement.classList.add("dark")
  else document.documentElement.classList.remove("dark")
  return (
    <div className="bg-background text-foreground mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-8 px-4 py-8">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">PromptInput specimen</h1>
          <p className="text-muted-foreground text-sm">
            Synthetic fixtures only. Enter sends, Shift+Enter adds a newline. Viewport width:{" "}
            {typeof window === "undefined" ? "?" : window.innerWidth}px.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDark(!dark)}
          className="border-border focus-visible:outline-ring rounded-md border px-3 py-1.5 text-sm outline-none focus-visible:outline-2"
        >
          {dark ? "Light theme" : "Dark theme"}
        </button>
      </header>
      <section aria-labelledby="spec-live" className="flex flex-col gap-2">
        <h2 id="spec-live" className="text-sm font-medium">
          Live composer (prefilled images, send log)
        </h2>
        <LiveComposer onSent={(payload) => setSent([...sent, payload])} />
        <div aria-live="polite" className="text-muted-foreground text-xs">
          {sent.length === 0
            ? "No messages sent yet."
            : `Sent ${sent.length}: “${sent[sent.length - 1]?.text}” with model ${sent[sent.length - 1]?.modelId} and ${sent[sent.length - 1]?.images.length} image(s).`}
        </div>
      </section>
      <section aria-labelledby="spec-empty" className="flex flex-col gap-2">
        <h2 id="spec-empty" className="text-sm font-medium">
          Empty state (send disabled)
        </h2>
        <EmptyComposer />
      </section>
      <section aria-labelledby="spec-loading" className="flex flex-col gap-2">
        <h2 id="spec-loading" className="text-sm font-medium">
          Loading state (composer disabled)
        </h2>
        <LoadingComposer />
      </section>
    </div>
  )
}

interface FixtureModels {
  readonly id: string
  readonly label: string
  readonly provider: string
  readonly disabled?: boolean
}

const fixtureModels: ReadonlyArray<FixtureModels> = [
  { id: "atlas", label: "Atlas", provider: "Anthropic" },
  { id: "atlas-mini", label: "Atlas Mini", provider: "Anthropic" },
  { id: "atlas-legacy", label: "Atlas Legacy (retired)", provider: "OpenAI", disabled: true }
]

const fixtureFolders: ReadonlyArray<PromptMentionItem> = [
  { id: "src", label: "src", kind: "folder" },
  { id: "docs", label: "docs", kind: "folder" },
  { id: "tests", label: "tests", kind: "folder" },
  { id: "package.json", label: "package.json", kind: "file" }
]

const fixtureSkills: ReadonlyArray<PromptMentionItem> = [
  { id: "commit", label: "commit", description: "Draft a commit message" },
  { id: "review", label: "review", description: "Review the working tree" }
]

const svgThumb = (fill: string, glyph: string): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="${fill}"/><text x="40" y="48" font-size="28" text-anchor="middle" fill="white">${glyph}</text></svg>`)}`

const fixtureImages: ReadonlyArray<PromptImageAttachment> = [
  { id: "shot-arch", name: "whiteboard-architecture-diagram.png", url: svgThumb("#4f46e5", "A") },
  { id: "shot-err", name: "a-very-long-screenshot-filename-that-must-truncate-gracefully-in-the-chip.png", url: svgThumb("#0d9488", "E") }
]

interface ComposerState {
  readonly modelId: string
  readonly favoriteModelIds: ReadonlyArray<string>
  readonly images: ReadonlyArray<PromptImageAttachment>
  readonly sandbox: SandboxMode
  readonly permission: PermissionMode
  readonly thinking: ThinkingLevel
}

const initialState: ComposerState = {
  modelId: "atlas",
  favoriteModelIds: [],
  images: [],
  sandbox: "workspace",
  permission: "ask",
  thinking: "low"
}

const LiveComposer = ({ onSent }: { readonly onSent: (payload: PromptSubmitPayload) => void }) => {
  const [state, setState] = useState<ComposerState>({ ...initialState, images: [...fixtureImages] })
  return (
    <PromptInput
      models={[...fixtureModels]}
      selectedModelId={state.modelId}
      onModelChange={(modelId) => setState({ ...state, modelId })}
      favoriteModelIds={state.favoriteModelIds}
      onFavoritesChange={(favoriteModelIds) => setState({ ...state, favoriteModelIds })}
      images={state.images}
      onImagesChange={(images) => setState({ ...state, images })}
      onSend={onSent}
      sandbox={state.sandbox}
      onSandboxChange={(sandbox) => setState({ ...state, sandbox })}
      permission={state.permission}
      onPermissionChange={(permission) => setState({ ...state, permission })}
      thinking={state.thinking}
      onThinkingChange={(thinking) => setState({ ...state, thinking })}
      folders={[...fixtureFolders]}
      skills={[...fixtureSkills]}
    />
  )
}

const LoadingComposer = () => {
  const [state, setState] = useState<ComposerState>(initialState)
  return (
    <PromptInput
      models={[...fixtureModels]}
      selectedModelId={state.modelId}
      onModelChange={(modelId) => setState({ ...state, modelId })}
      favoriteModelIds={state.favoriteModelIds}
      onFavoritesChange={(favoriteModelIds) => setState({ ...state, favoriteModelIds })}
      images={state.images}
      onImagesChange={(images) => setState({ ...state, images })}
      onSend={() => {}}
      sandbox={state.sandbox}
      onSandboxChange={(sandbox) => setState({ ...state, sandbox })}
      permission={state.permission}
      onPermissionChange={(permission) => setState({ ...state, permission })}
      thinking={state.thinking}
      onThinkingChange={(thinking) => setState({ ...state, thinking })}
      folders={[...fixtureFolders]}
      skills={[...fixtureSkills]}
      isLoading
    />
  )
}

const EmptyComposer = () => {
  const [state, setState] = useState<ComposerState>(initialState)
  return (
    <PromptInput
      models={[...fixtureModels]}
      selectedModelId={state.modelId}
      onModelChange={(modelId) => setState({ ...state, modelId })}
      favoriteModelIds={state.favoriteModelIds}
      onFavoritesChange={(favoriteModelIds) => setState({ ...state, favoriteModelIds })}
      images={state.images}
      onImagesChange={(images) => setState({ ...state, images })}
      onSend={() => {}}
      sandbox={state.sandbox}
      onSandboxChange={(sandbox) => setState({ ...state, sandbox })}
      permission={state.permission}
      onPermissionChange={(permission) => setState({ ...state, permission })}
      thinking={state.thinking}
      onThinkingChange={(thinking) => setState({ ...state, thinking })}
      folders={[...fixtureFolders]}
      skills={[...fixtureSkills]}
    />
  )
}

