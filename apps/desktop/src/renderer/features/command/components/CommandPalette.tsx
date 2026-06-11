import { Fragment, useState } from "react"
import { PlusIcon } from "lucide-react"
import { useNavigate } from "@tanstack/react-router"
import type { Project } from "@yodea/contracts/project"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "@yodea/desktop/renderer/components/ui/command"
import { useAllProjects, useArchiveProject, useCreateProject, useRenameProject, useRestoreProject, useSetMetadata } from "@yodea/desktop/renderer/features/projects/data/use-projects"
import { RenameDialog } from "@yodea/desktop/renderer/features/projects/components/RenameDialog"
import { EditMetadataDialog } from "@yodea/desktop/renderer/features/projects/components/EditMetadataDialog"
import { useCommandPalette } from "@yodea/desktop/renderer/features/command/model/command-store"
import { useCommandPaletteHotkey } from "@yodea/desktop/renderer/features/command/model/use-command-palette-hotkey"

export const CommandPalette = () => {
  useCommandPaletteHotkey()
  const open = useCommandPalette((state) => state.open)
  const setOpen = useCommandPalette((state) => state.setOpen)
  const navigate = useNavigate()
  const { data: projects = [] } = useAllProjects()
  const createProject = useCreateProject()
  const renameProject = useRenameProject()
  const archiveProject = useArchiveProject()
  const restoreProject = useRestoreProject()
  const setMetadata = useSetMetadata()
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [editing, setEditing] = useState<Project | null>(null)
  const [query, setQuery] = useState("")
  const [error, setError] = useState<string | null>(null)
  const trimmed = query.trim()

  const handleCreate = async () => {
    if (trimmed === "") return
    try {
      await createProject.mutateAsync(trimmed)
      setError(null)
      setQuery("")
      setOpen(false)
    } catch (cause) {
      setError(`Could not create “${trimmed}”: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  const openProject = (projectId: string) => {
    setOpen(false)
    void navigate({ to: "/p/$projectId", params: { projectId } })
  }

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) setError(null)
  }

  return (
    <>
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput value={query} onValueChange={setQuery} placeholder="Type a project name or search…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {trimmed !== "" && (
          <CommandGroup heading="Actions">
            <CommandItem value={query} onSelect={handleCreate}>
              <PlusIcon className="size-4" />
              <span>Create project “{trimmed}”</span>
            </CommandItem>
          </CommandGroup>
        )}
        {projects.length > 0 && (
          <CommandGroup heading="Projects">
            {projects.map((project) => (
              <Fragment key={project.id}>
                <CommandItem value={project.name} onSelect={() => openProject(project.id)}>
                  {project.name}{project.archived ? " (archived)" : ""}
                </CommandItem>
                <CommandItem
                  value={`rename ${project.name}`}
                  onSelect={() => { setOpen(false); setRenaming({ id: project.id, name: project.name }) }}
                >
                  <span>Rename “{project.name}”</span>
                </CommandItem>
                <CommandItem
                  value={`edit ${project.name}`}
                  onSelect={() => { setOpen(false); setEditing(project) }}
                >
                  <span>Edit metadata “{project.name}”</span>
                </CommandItem>
                <CommandItem
                  value={`${project.name} ${project.archived ? "restore" : "archive"}`}
                  onSelect={() => {
                    const action = project.archived ? restoreProject : archiveProject
                    action.mutate(project.id, {
                      onError: (cause: unknown) =>
                        setError(`Could not ${project.archived ? "restore" : "archive"} “${project.name}”: ${cause instanceof Error ? cause.message : String(cause)}`)
                    })
                    setOpen(false)
                  }}
                >
                  <span>{project.archived ? "Restore" : "Archive"} “{project.name}”{project.archived ? " (archived)" : ""}</span>
                </CommandItem>
              </Fragment>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      {error !== null && (
        <div role="alert" className="border-t px-3 py-2 text-sm text-red-600">
          {error}
        </div>
      )}
    </CommandDialog>
    <RenameDialog
      open={renaming !== null}
      project={renaming}
      error={renameProject.error}
      onOpenChange={(o) => { if (!o) { setRenaming(null); renameProject.reset() } }}
      onRename={(id, name) => renameProject.mutate({ id, name }, { onSuccess: () => setRenaming(null) })}
    />
    {editing !== null && (
      <EditMetadataDialog
        open
        project={editing}
        onOpenChange={(o) => { if (!o) setEditing(null) }}
        onSubmit={(patch) => setMetadata.mutateAsync({ id: editing.id, ...patch })}
      />
    )}
    </>
  )
}
