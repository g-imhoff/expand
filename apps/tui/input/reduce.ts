// apps/tui/input/reduce.ts
// Pure module — no ink imports. State transitions + descriptive effects.
// Effects are data; app.tsx's runEffect is the only place they meet useProjects.
import type { Project } from "@expand/contracts/project"
import { emptyTextField, textField, textFieldReduce } from "@expand/ink-input/text-field"
import {
  assertNever, type Action, type Overlay, type UiState
} from "@expand/tui/input/state"

export type DomainEffect =
  | { readonly _tag: "Create"; readonly name: string }
  | { readonly _tag: "Rename"; readonly id: string; readonly name: string }
  | { readonly _tag: "ChangeDirectory"; readonly id: string; readonly directory: string }
  | { readonly _tag: "SetMetadata"; readonly id: string; readonly description: string | null; readonly tags: ReadonlyArray<string> }
  | { readonly _tag: "Archive"; readonly id: string }
  | { readonly _tag: "Restore"; readonly id: string }
  | { readonly _tag: "Delete"; readonly id: string }

export const uiReduce = (ui: UiState, action: Action): Result => {
  switch (action._tag) {
    case "Select":
      return pure({ ...ui, selectedId: action.id, selectedIndex: action.index })
    case "FocusCreate":
      return ui.focus === "create" ? pure(ui) : pure({ ...ui, focus: "create" })
    case "FocusList":
      return ui.focus === "list" ? pure(ui) : pure({ ...ui, focus: "list" })
    case "OpenRename":
      return pure({ ...ui, overlay: { kind: "rename", projectId: action.projectId, field: textField(action.currentName) } })
    case "OpenDirectory":
      return pure({ ...ui, overlay: { kind: "directory", projectId: action.projectId, field: emptyTextField } })
    case "OpenMetadata":
      return pure({
        ...ui,
        overlay: {
          kind: "metadata", projectId: action.projectId, active: "description",
          description: textField(action.description), tags: textField(action.tags)
        }
      })
    case "OpenConfirmDelete":
      return pure({ ...ui, overlay: { kind: "confirmDelete", projectId: action.projectId } })
    case "ToggleArchive":
      return {
        ui,
        effects: [action.currentlyArchived
          ? { _tag: "Restore", id: action.projectId }
          : { _tag: "Archive", id: action.projectId }]
      }
    case "CancelOverlay":
      return ui.overlay === null ? pure(ui) : pure({ ...ui, overlay: null })
    case "SwitchMetadataField":
      return ui.overlay?.kind === "metadata"
        ? pure({ ...ui, overlay: { ...ui.overlay, active: ui.overlay.active === "description" ? "tags" : "description" } })
        : pure(ui)
    case "SubmitOverlay":
      return ui.overlay === null ? pure(ui) : submitOverlay(ui, ui.overlay)
    case "TextKey":
      return pure(editActiveField(ui, action.keyName, action.input))
    case "SubmitCreate": {
      const name = ui.create.value.trim()
      if (name.length === 0) return pure(ui)
      return { ui: { ...ui, create: emptyTextField }, effects: [{ _tag: "Create", name }] }
    }
    case "ClearCreate":
      return pure({ ...ui, create: emptyTextField })
    case "Reconcile":
      return pure(reconcile(ui, action.projects))
    default:
      return assertNever(action)
  }
}

const pure = (ui: UiState): Result => ({ ui, effects: [] })

const parseTags = (raw: string): ReadonlyArray<string> =>
  raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0)

const reconcile = (ui: UiState, projects: ReadonlyArray<Project>): UiState => {
  let next = ui
  if (projects.length === 0) {
    if (next.selectedId !== null || next.selectedIndex !== 0) {
      next = { ...next, selectedId: null, selectedIndex: 0 }
    }
  } else {
    const index = next.selectedId === null ? -1 : projects.findIndex((p) => p.id === next.selectedId)
    if (index === -1) {
      const clamped = Math.max(0, Math.min(next.selectedIndex, projects.length - 1))
      next = { ...next, selectedId: projects[clamped]!.id, selectedIndex: clamped }
    } else if (index !== next.selectedIndex) {
      next = { ...next, selectedIndex: index }
    }
  }
  const overlay = next.overlay
  if (overlay !== null && !projects.some((p) => p.id === overlay.projectId)) {
    next = { ...next, overlay: null }
  }
  return next
}

const submitOverlay = (ui: UiState, overlay: Overlay): Result => {
  switch (overlay.kind) {
    case "rename": {
      const name = overlay.field.value.trim()
      if (name.length === 0) return pure(ui)
      return { ui: { ...ui, overlay: null }, effects: [{ _tag: "Rename", id: overlay.projectId, name }] }
    }
    case "directory": {
      const directory = overlay.field.value.trim()
      if (directory.length === 0) return pure(ui)
      return { ui: { ...ui, overlay: null }, effects: [{ _tag: "ChangeDirectory", id: overlay.projectId, directory }] }
    }
    case "metadata": {
      const description = overlay.description.value.trim()
      return {
        ui: { ...ui, overlay: null },
        effects: [{
          _tag: "SetMetadata", id: overlay.projectId,
          description: description.length === 0 ? null : description, // empty = clear (C8)
          tags: parseTags(overlay.tags.value)
        }]
      }
    }
    case "confirmDelete":
      return { ui: { ...ui, overlay: null }, effects: [{ _tag: "Delete", id: overlay.projectId }] }
    default:
      return assertNever(overlay)
  }
}

const editActiveField = (ui: UiState, keyName: string, input: string): UiState => {
  if (ui.overlay !== null) {
    switch (ui.overlay.kind) {
      case "rename":
      case "directory":
        return { ...ui, overlay: { ...ui.overlay, field: textFieldReduce(ui.overlay.field, keyName, input) } }
      case "metadata":
        return ui.overlay.active === "description"
          ? { ...ui, overlay: { ...ui.overlay, description: textFieldReduce(ui.overlay.description, keyName, input) } }
          : { ...ui, overlay: { ...ui.overlay, tags: textFieldReduce(ui.overlay.tags, keyName, input) } }
      case "confirmDelete":
        return ui // route never emits TextKey under confirmDelete; harmless no-op
      default:
        return assertNever(ui.overlay)
    }
  }
  return { ...ui, create: textFieldReduce(ui.create, keyName, input) }
}

type Result = { readonly ui: UiState; readonly effects: ReadonlyArray<DomainEffect> }
