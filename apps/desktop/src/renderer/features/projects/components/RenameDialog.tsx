import { useState } from "react"
import { Schema } from "effect"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@yodea/desktop/renderer/components/ui/dialog"

const describeError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && (error as { _tag?: string })._tag === "ProjectInvalidInput") {
    const e = error as { field: string; reason: string }
    return `invalid ${e.field}: ${e.reason}`
  }
  if (Schema.isSchemaError(error)) {
    return `invalid input: ${error.message}`
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String((error as { _tag: unknown })._tag)
  }
  return String(error)
}

export interface RenameDialogProps {
  readonly open: boolean
  readonly project: { readonly id: string; readonly name: string } | null
  readonly onOpenChange: (open: boolean) => void
  readonly onRename: (id: string, name: string) => void
  readonly error?: unknown
}

export const RenameDialog = ({ open, project, onOpenChange, onRename, error }: RenameDialogProps) => {
  const [value, setValue] = useState(project?.name ?? "")
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
        {error != null && (
          <p role="alert" style={{ color: "crimson" }}>{describeError(error)}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
