import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { Input } from "@expand/desktop/renderer/components/ui/input"
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
    <main className="min-w-0 p-6 font-sans">
      <h1 className="text-2xl font-semibold">Expand — Projects ({visible.length})</h1>
      <form onSubmit={submit} className="mt-6 flex max-w-md flex-wrap gap-2">
        <Input
          className="min-w-0 flex-1 basis-48"
          aria-label="project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="new project name"
        />
        <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Create</button>
      </form>
      {Boolean(error ?? create.error) && (
        <p role="alert" className="mt-4 text-sm text-destructive">{String(error ?? create.error)}</p>
      )}
      <ul data-testid="project-list" className="mt-6 divide-y rounded-lg border bg-card empty:border-0">
        {visible.map((p) => (
          <li key={p.id} className="flex min-w-0 flex-wrap items-center gap-3 p-4">
            <div className="min-w-0 flex-1 basis-48">
              <Link to="/p/$projectId" params={{ projectId: p.id }} className="break-words font-medium text-primary underline-offset-4 hover:underline">{p.name}</Link>
              <small className="mt-1 block break-all text-muted-foreground">{p.id}</small>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="rounded-md border px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setRenaming({ id: p.id, name: p.name })}>Rename</button>
              <button type="button" className="rounded-md border px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setMovingDir({ id: p.id, name: p.name, directory: p.directory })}>Change directory</button>
              <button type="button" className="rounded-md px-3 py-2 text-sm text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setTarget({ id: p.id, name: p.name })}>Delete</button>
            </div>
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
