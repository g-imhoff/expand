import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useChangeDirectory, useCreateProject, useProjects, useRenameProject } from "@yodea/desktop/renderer/features/projects/use-projects"
import { RenameDialog } from "@yodea/desktop/renderer/features/projects/RenameDialog"
import { ChangeDirectoryDialog } from "@yodea/desktop/renderer/features/projects/ChangeDirectoryDialog"

export const ProjectsView = () => {
  const { data: projects = [], error } = useProjects()
  const create = useCreateProject()
  const rename = useRenameProject()
  const changeDirectory = useChangeDirectory()
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [movingDir, setMovingDir] = useState<{ id: string; name: string; directory: string | null } | null>(null)
  const [name, setName] = useState("")
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    create.mutate(n, { onSuccess: () => setName("") })
  }
  return (
    <main style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>Yodea — Projects ({projects.length})</h1>
      <form onSubmit={submit}>
        <input
          aria-label="project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new project name"
        />
        <button type="submit">Create</button>
      </form>
      {(error || create.error) && (
        <p role="alert" style={{ color: "crimson" }}>{String(error ?? create.error)}</p>
      )}
      <ul data-testid="project-list">
        {projects.map((p) => (
          <li key={p.id}>
            <Link to="/p/$projectId" params={{ projectId: p.id }}>{p.name}</Link>{" "}
            <small style={{ opacity: 0.6 }}>{p.id}</small>{" "}
            <button onClick={() => setRenaming({ id: p.id, name: p.name })}>Rename</button>{" "}
            <button onClick={() => setMovingDir({ id: p.id, name: p.name, directory: p.directory })}>Change directory</button>
          </li>
        ))}
      </ul>
      <RenameDialog
        open={renaming !== null}
        project={renaming}
        onOpenChange={(o) => { if (!o) setRenaming(null) }}
        onRename={(id, name) => rename.mutate({ id, name })}
      />
      <ChangeDirectoryDialog
        open={movingDir !== null}
        project={movingDir}
        error={changeDirectory.error}
        onOpenChange={(o) => { if (!o) { setMovingDir(null); changeDirectory.reset() } }}
        onChangeDirectory={(id, directory) =>
          changeDirectory.mutate({ id, directory }, { onSuccess: () => setMovingDir(null) })}
      />
    </main>
  )
}
