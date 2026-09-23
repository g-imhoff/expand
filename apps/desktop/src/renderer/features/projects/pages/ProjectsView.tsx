import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useChangeDirectory, useCreateProject, useDeleteProject, useProjects, useRenameProject } from "@expand/desktop/renderer/features/projects/data/use-projects"
import { RenameDialog } from "@expand/desktop/renderer/features/projects/components/RenameDialog"
import { ChangeDirectoryDialog } from "@expand/desktop/renderer/features/projects/components/ChangeDirectoryDialog"
import { DeleteProjectDialog } from "@expand/desktop/renderer/features/projects/components/DeleteProjectDialog"
import {
  PromptInput,
  type PermissionMode,
  type PromptImageAttachment,
  type PromptMentionItem,
  type PromptSubmitPayload,
  type SandboxMode,
  type ThinkingLevel
} from "@expand/desktop/renderer/features/chat/components/PromptInput"

export const ProjectsView = () => {
  const { data: projects = [], error } = useProjects()
  const create = useCreateProject()
  const rename = useRenameProject()
  const changeDirectory = useChangeDirectory()
  const del = useDeleteProject()
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null)
  const [movingDir, setMovingDir] = useState<{ id: string; name: string; directory: string | null } | null>(null)
  const [name, setName] = useState("")
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    create.mutate(n, { onSuccess: () => setName("") })
  }
  const visible = projects.filter((p) => !p.archived)
  return (
    <main style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>Expand — Projects ({visible.length})</h1>
      <form onSubmit={submit}>
        <input
          aria-label="project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new project name"
        />
        <button type="submit">Create</button>
      </form>
      {Boolean(error ?? create.error) && (
        <p role="alert" style={{ color: "crimson" }}>{String(error ?? create.error)}</p>
      )}
      <ul data-testid="project-list">
        {visible.map((p) => (
          <li key={p.id}>
            <Link to="/p/$projectId" params={{ projectId: p.id }}>{p.name}</Link>{" "}
            <small style={{ opacity: 0.6 }}>{p.id}</small>{" "}
            <button type="button" onClick={() => setRenaming({ id: p.id, name: p.name })}>Rename</button>{" "}
            <button type="button" onClick={() => setMovingDir({ id: p.id, name: p.name, directory: p.directory })}>Change directory</button>{" "}
            <button type="button" onClick={() => setTarget({ id: p.id, name: p.name })}>Delete</button>
          </li>
        ))}
      </ul>
      <RenameDialog
        key={renaming?.id}
        open={renaming !== null}
        project={renaming}
        error={rename.error}
        onOpenChange={(o) => { if (!o) { setRenaming(null); rename.reset() } }}
        onRename={(id, name) => rename.mutate({ id, name }, { onSuccess: () => setRenaming(null) })}
      />
      <ChangeDirectoryDialog
        key={movingDir?.id}
        open={movingDir !== null}
        project={movingDir}
        error={changeDirectory.error}
        onOpenChange={(o) => { if (!o) { setMovingDir(null); changeDirectory.reset() } }}
        onChangeDirectory={(id, directory) =>
          changeDirectory.mutate({ id, directory }, { onSuccess: () => setMovingDir(null) })}
      />
      {target !== null && (
        <DeleteProjectDialog
          open
          projectName={target.name}
          pending={del.isPending}
          error={del.error}
          onOpenChange={(next) => { if (!next) { setTarget(null); del.reset() } }}
          onConfirm={() => del.mutate(target.id, { onSuccess: () => setTarget(null) })}
        />
      )}
      <ComposerPreview />
    </main>
  )
}

const composerModels = [
  { id: "atlas", label: "Atlas", provider: "Anthropic" },
  { id: "atlas-mini", label: "Atlas Mini", provider: "Anthropic" },
  { id: "beacon", label: "Beacon", provider: "OpenAI", description: "Long context" }
]

const composerFolders: ReadonlyArray<PromptMentionItem> = [
  { id: "src", label: "src", kind: "folder" },
  { id: "docs", label: "docs", kind: "folder" }
]

const composerSkills: ReadonlyArray<PromptMentionItem> = [
  { id: "commit", label: "commit", description: "Draft a commit message" },
  { id: "review", label: "review", description: "Review the working tree" }
]

const ComposerPreview = () => {
  const [modelId, setModelId] = useState("atlas")
  const [favoriteModelIds, setFavoriteModelIds] = useState<ReadonlyArray<string>>([])
  const [images, setImages] = useState<ReadonlyArray<PromptImageAttachment>>([])
  const [sandbox, setSandbox] = useState<SandboxMode>("workspace")
  const [permission, setPermission] = useState<PermissionMode>("ask")
  const [thinking, setThinking] = useState<ThinkingLevel>("low")
  const [lastSent, setLastSent] = useState<PromptSubmitPayload | null>(null)
  return (
    <section aria-label="AI composer preview" style={{ marginTop: 32, maxWidth: 640 }}>
      <h2>New conversation</h2>
      <PromptInput
        models={composerModels}
        selectedModelId={modelId}
        onModelChange={setModelId}
        favoriteModelIds={favoriteModelIds}
        onFavoritesChange={setFavoriteModelIds}
        images={images}
        onImagesChange={setImages}
        onSend={setLastSent}
        sandbox={sandbox}
        onSandboxChange={setSandbox}
        permission={permission}
        onPermissionChange={setPermission}
        thinking={thinking}
        onThinkingChange={setThinking}
        folders={composerFolders}
        skills={composerSkills}
      />
      {lastSent !== null && (
        <p data-testid="composer-last-sent">
          Sent to {lastSent.modelId}: {lastSent.text}
        </p>
      )}
    </section>
  )
}
