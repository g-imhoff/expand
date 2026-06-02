import { useEffect, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@yodea/desktop/renderer/components/ui/dialog"

export interface RenameDialogProps {
  readonly open: boolean
  readonly project: { readonly id: string; readonly name: string } | null
  readonly onOpenChange: (open: boolean) => void
  readonly onRename: (id: string, name: string) => void
}

export const RenameDialog = ({ open, project, onOpenChange, onRename }: RenameDialogProps) => {
  const [value, setValue] = useState(project?.name ?? "")
  useEffect(() => { setValue(project?.name ?? "") }, [project?.id, project?.name])
  if (project === null) return null
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const next = value.trim()
    if (next === "") return
    onRename(project.id, next)
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>Give “{project.name}” a new name.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <input
            aria-label="new project name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="submit">Rename</button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
