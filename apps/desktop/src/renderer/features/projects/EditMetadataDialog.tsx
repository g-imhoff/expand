import { useState } from "react"
import type { Project } from "@yodea/contracts/project"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@yodea/desktop/renderer/components/ui/dialog"

// Parse a comma-separated tags input into a deduped, trimmed, non-empty list.
const parseTags = (raw: string): ReadonlyArray<string> =>
  [...new Set(raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0))]

export interface EditMetadataDialogProps {
  readonly open: boolean
  readonly project: Project
  readonly onOpenChange: (next: boolean) => void
  readonly onSubmit: (patch: { description: string | null; tags: ReadonlyArray<string> }) => Promise<unknown>
}

// Controlled metadata editor. Decoupled from RPC via an injected `onSubmit` so it
// is unit-testable; the wiring component passes
// `(patch) => setMetadata.mutateAsync({ id: project.id, ...patch })`. An empty
// description trims to null (clears it); the tags input parses to a deduped list
// (empty input => [] => clears tags).
export const EditMetadataDialog = ({ open, project, onOpenChange, onSubmit }: EditMetadataDialogProps) => {
  const [description, setDescription] = useState(project.description ?? "")
  const [tagsRaw, setTagsRaw] = useState(project.tags.join(", "))
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    try {
      await onSubmit({ description: description.trim() === "" ? null : description, tags: parseTags(tagsRaw) })
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit metadata — {project.name}</DialogTitle>
          <DialogDescription>Update the project description and tags.</DialogDescription>
        </DialogHeader>
        <label>
          <span>description</span>
          <textarea aria-label="description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2048} />
        </label>
        <label>
          <span>tags</span>
          <input aria-label="tags" value={tagsRaw} onChange={(e) => setTagsRaw(e.target.value)} placeholder="comma, separated" />
        </label>
        {error !== null && <p role="alert" style={{ color: "crimson" }}>{error}</p>}
        <button type="button" onClick={save}>Save</button>
      </DialogContent>
    </Dialog>
  )
}
