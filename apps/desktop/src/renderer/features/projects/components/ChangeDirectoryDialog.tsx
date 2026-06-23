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
  if (Schema.isSchemaError(error)) {
    return `invalid input: ${error.message}`
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String((error as { _tag: unknown })._tag)
  }
  return String(error)
}

export interface ChangeDirectoryDialogProps {
  readonly open: boolean
  readonly project: { readonly id: string; readonly name: string; readonly directory: string | null } | null
  readonly onOpenChange: (open: boolean) => void
  readonly onChangeDirectory: (id: string, directory: string) => void
  readonly error?: unknown
}

export const ChangeDirectoryDialog = ({
  open,
  project,
  onOpenChange,
  onChangeDirectory,
  error
}: ChangeDirectoryDialogProps) => {
  const [value, setValue] = useState(project?.directory ?? "")
  if (project === null) return null
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const next = value.trim()
    if (next === "") return
    onChangeDirectory(project.id, next)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change directory</DialogTitle>
          <DialogDescription>Set the working directory for “{project.name}”.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <input
            aria-label="project directory"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={project.directory ?? "/absolute/path"}
          />
          <button type="submit">Save</button>
        </form>
        {error != null && (
          <p role="alert" style={{ color: "crimson" }}>{describeError(error)}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
