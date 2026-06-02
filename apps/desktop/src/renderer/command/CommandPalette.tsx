import { Fragment, useState } from "react"
import { PlusIcon } from "lucide-react"
import { useNavigate } from "@tanstack/react-router"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "../components/ui/command"
import { useCreateProject, useProjects, useRenameProject } from "@yodea/desktop/renderer/features/projects/use-projects"
import { RenameDialog } from "@yodea/desktop/renderer/features/projects/RenameDialog"
import { useCommandPalette } from "./store"
import { useCommandPaletteHotkey } from "./use-command-palette-hotkey"

// Pure UI (I-1): reaches the backend only through the renderer's own TanStack
// hooks (which ride the preload-brokered RPC client) — never client-core/main.
// Mounted once in the root route layout, so the Ctrl/Cmd+Shift+P listener is
// active on every route and the palette has Router + Query + RPC context.
export const CommandPalette = () => {
  useCommandPaletteHotkey()
  const open = useCommandPalette((state) => state.open)
  const setOpen = useCommandPalette((state) => state.setOpen)
  const navigate = useNavigate()
  const { data: projects = [] } = useProjects()
  const createProject = useCreateProject()
  const renameProject = useRenameProject()
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
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
            {/* value={query} (the live cmdk search) → exact filter match, so this
                action is always visible while the user is typing. */}
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
                  {project.name}
                </CommandItem>
                <CommandItem
                  value={`rename ${project.name}`}
                  onSelect={() => { setOpen(false); setRenaming({ id: project.id, name: project.name }) }}
                >
                  <span>Rename “{project.name}”</span>
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
      onOpenChange={(o) => { if (!o) setRenaming(null) }}
      onRename={(id, name) => renameProject.mutate({ id, name })}
    />
    </>
  )
}
