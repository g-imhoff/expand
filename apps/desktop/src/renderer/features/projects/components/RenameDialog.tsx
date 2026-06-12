import { useEffect, useState } from "react"
import type { ProjectId } from "@yodea/contracts/project"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@yodea/desktop/renderer/components/ui/dialog"

const describeError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String((error as { _tag: unknown })._tag)
  }
  return String(error)
}

export interface RenameDialogProps {
  readonly open: boolean
  readonly project: { readonly id: ProjectId; readonly name: string } | null
  readonly onOpenChange: (open: boolean) => void
  readonly onRename: (id: ProjectId, name: string) => void
  readonly error?: unknown
}

export const RenameDialog = ({ open, project, onOpenChange, onRename, error }: RenameDialogProps) => {
  const [value, setValue] = useState(project?.name ?? "")
  useEffect(() => { setValue(project?.name ?? "") }, [project?.id, project?.name])
  if (project === null) return null
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const next = value.trim()
    if (next === "") return
    onRename(project.id, next)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>Give "{project.name}" a new name.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <input
            aria-label="new project name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="submit">Rename</button>
        </form>
        {error != null && (
          <p role="alert" style={{ color: "crimson" }}>{describeError(error)}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
