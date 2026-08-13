import { defineBindings, type Bindings } from "@expand/ink-input"
import type { Action, ListIntent, UiState } from "@expand/tui/input/state"

export const listBindings = defineBindings<ListIntent>([
  { keys: ["j", "down"], label: "next", action: "SelectNext" }, { keys: ["k", "up"], label: "prev", action: "SelectPrev" },
  { keys: ["r"], label: "rename", action: "OpenRename" }, { keys: ["d"], label: "dir", action: "OpenDirectory" },
  { keys: ["m"], label: "meta", action: "OpenMetadata" }, { keys: ["a"], label: "archive", action: "ToggleArchive" },
  { keys: ["x", "delete"], label: "delete", action: "OpenConfirmDelete" }, { keys: ["n", "tab"], label: "new", action: "FocusCreate" }
])
export const createBindings = defineBindings<Action>([
  { keys: ["return"], label: "create", action: { _tag: "SubmitCreate" } }, { keys: ["escape"], label: "clear", action: { _tag: "ClearCreate" } }, { keys: ["tab"], label: "to list", action: { _tag: "FocusList" } }
])
export const textOverlayBindings = defineBindings<Action>([
  { keys: ["return"], label: "submit", action: { _tag: "SubmitOverlay" } }, { keys: ["escape"], label: "cancel", action: { _tag: "CancelOverlay" } }
])
export const metadataBindings = defineBindings<Action>([
  { keys: ["return"], label: "submit", action: { _tag: "SubmitOverlay" } }, { keys: ["escape"], label: "cancel", action: { _tag: "CancelOverlay" } }, { keys: ["tab"], label: "switch field", action: { _tag: "SwitchMetadataField" } }
])
export const confirmDeleteBindings = defineBindings<Action>([
  { keys: ["y", "shift+Y", "return"], label: "confirm", action: { _tag: "SubmitOverlay" } }, { keys: ["n", "shift+N", "escape"], label: "cancel", action: { _tag: "CancelOverlay" } }
])
export const activeBindings = (ui: UiState): Bindings<unknown> => ui.overlay === null ? ui.focus === "create" ? createBindings : listBindings : ui.overlay.kind === "confirmDelete" ? confirmDeleteBindings : ui.overlay.kind === "metadata" ? metadataBindings : textOverlayBindings
