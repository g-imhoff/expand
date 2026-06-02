import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@yodea/desktop/renderer/components/ui/dialog"

export interface DeleteProjectDialogProps {
  readonly open: boolean
  readonly projectName: string
  readonly pending: boolean
  readonly onOpenChange: (next: boolean) => void
  readonly onConfirm: () => void
}

export const DeleteProjectDialog = ({
  open,
  projectName,
  pending,
  onOpenChange,
  onConfirm
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
    </DialogContent>
  </Dialog>
)
