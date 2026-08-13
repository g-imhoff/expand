import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useChangeDirectory, useCreateProject, useDeleteProject, useProjects, useRenameProject } from "@expand/desktop/renderer/features/projects/data/use-projects"
import { RenameDialog } from "@expand/desktop/renderer/features/projects/components/RenameDialog"
import { ChangeDirectoryDialog } from "@expand/desktop/renderer/features/projects/components/ChangeDirectoryDialog"
import { DeleteProjectDialog } from "@expand/desktop/renderer/features/projects/components/DeleteProjectDialog"

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
    </main>
  )
}
