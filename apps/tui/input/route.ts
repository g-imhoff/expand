import type { Project } from "@expand/contracts/project"
import type { KeyEvent } from "@expand/ink-input"
import { editTextField } from "@expand/tui/input/text-field"
import { assertNever, type Action, type UiState } from "@expand/tui/input/state"
import { confirmDeleteBindings, createBindings, listBindings, metadataBindings, textOverlayBindings } from "@expand/tui/input/bindings"

export const route = (ui: UiState, projects: ReadonlyArray<Project>, event: KeyEvent): Action | null => {
  const focused = ui.overlay?.kind === "rename" || ui.overlay?.kind === "directory" || ui.overlay?.kind === "metadata" || ui.focus === "create"
  if (focused) {
    const field = ui.overlay?.kind === "metadata" ? ui.overlay.active === "description" ? ui.overlay.description : ui.overlay.tags : ui.overlay?.kind === "rename" || ui.overlay?.kind === "directory" ? ui.overlay.field : ui.create
    const next = editTextField(field, event)
    if (next !== null) return { _tag: "EditField", state: next }
  }
  if (ui.overlay !== null) {
    if (ui.overlay.kind === "confirmDelete") return confirmDeleteBindings.resolve(event)
    return (ui.overlay.kind === "metadata" ? metadataBindings : textOverlayBindings).resolve(event)
  }
  if (ui.focus === "create") return createBindings.resolve(event)
  const intent = listBindings.resolve(event)
  if (intent === null || projects.length === 0 && intent !== "FocusCreate") return null
  if (intent === "FocusCreate") return { _tag: "FocusCreate" }
  const index = ui.selectedId === null ? -1 : projects.findIndex((project) => project.id === ui.selectedId)
  const selected = index < 0 ? null : projects[index] ?? null
  if (selected === null) return null
  switch (intent) {
    case "SelectNext": { const next = Math.min(index + 1, projects.length - 1); return { _tag: "Select", id: projects[next]!.id, index: next } }
    case "SelectPrev": { const next = Math.max(index - 1, 0); return { _tag: "Select", id: projects[next]!.id, index: next } }
    case "OpenRename": return { _tag: "OpenRename", projectId: selected.id, currentName: selected.name }
    case "OpenDirectory": return { _tag: "OpenDirectory", projectId: selected.id }
    case "OpenMetadata": return { _tag: "OpenMetadata", projectId: selected.id, description: selected.description ?? "", tags: selected.tags.join(", ") }
    case "OpenConfirmDelete": return { _tag: "OpenConfirmDelete", projectId: selected.id }
    case "ToggleArchive": return { _tag: "ToggleArchive", projectId: selected.id, currentlyArchived: selected.archived }
    default: return assertNever(intent)
  }
}
