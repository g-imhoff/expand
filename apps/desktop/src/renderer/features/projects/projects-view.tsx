import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useChangeDirectory, useCreateProject, useDeleteProject, useProjects, useRenameProject } from "@yodea/desktop/renderer/features/projects/use-projects"
import { RenameDialog } from "@yodea/desktop/renderer/features/projects/RenameDialog"
import { ChangeDirectoryDialog } from "@yodea/desktop/renderer/features/projects/ChangeDirectoryDialog"
import { DeleteProjectDialog } from "@yodea/desktop/renderer/features/projects/DeleteProjectDialog"

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
  // The default index view hides archived projects, matching the CLI/backend
  // default and the useProjects()→ProjectList({}) refetch path. The live event
  // fold keeps an archived project in PROJECTS_KEY with archived:true until the
  // mutation's invalidation refetches it hidden; filtering here makes the view
  // consistent immediately (no lingering just-archived row). Archived projects
  // stay reachable via the command palette (useAllProjects()) and its Restore.
  const visible = projects.filter((p) => !p.archived)
  return (
    <main style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>Yodea — Projects ({visible.length})</h1>
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
        {visible.map((p) => (
          <li key={p.id}>
            <Link to="/p/$projectId" params={{ projectId: p.id }}>{p.name}</Link>{" "}
            <small style={{ opacity: 0.6 }}>{p.id}</small>{" "}
            <button onClick={() => setRenaming({ id: p.id, name: p.name })}>Rename</button>{" "}
            <button onClick={() => setMovingDir({ id: p.id, name: p.name, directory: p.directory })}>Change directory</button>{" "}
            <button onClick={() => setTarget({ id: p.id, name: p.name })}>Delete</button>
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
      {target !== null && (
        <DeleteProjectDialog
          open
          projectName={target.name}
          pending={del.isPending}
          onOpenChange={(next) => { if (!next) setTarget(null) }}
          onConfirm={() => del.mutate(target.id, { onSuccess: () => setTarget(null) })}
        />
      )}
    </main>
  )
}
