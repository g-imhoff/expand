import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@expand/desktop/renderer/components/ui/dialog"

export interface DeleteProjectDialogProps {
  readonly open: boolean
  readonly projectName: string
  readonly pending: boolean
  readonly onOpenChange: (next: boolean) => void
  readonly onConfirm: () => void
  readonly error?: unknown
}

export const DeleteProjectDialog = ({
  open,
  projectName,
  pending,
  onOpenChange,
  onConfirm,
  error
}: DeleteProjectDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Delete project</DialogTitle>
        <DialogDescription>
          Delete “{projectName}”? This removes it from your project list.
        </DialogDescription>
      </DialogHeader>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => onOpenChange(false)}>Cancel</button>
        <button type="button" disabled={pending} onClick={onConfirm}>Delete</button>
      </div>
      {error != null && (
        <p role="alert" style={{ color: "crimson" }}>{describeError(error)}</p>
      )}
    </DialogContent>
  </Dialog>
)

const describeError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    return String((error as { _tag: unknown })._tag)
  }
  return String(error)
}
