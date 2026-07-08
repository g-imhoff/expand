// apps/tui/input/bindings.ts
// Pure module — no ink imports. The concrete key tables. These same arrays
// drive the router (route.ts) and the hint bar (app.tsx): help cannot drift
// from behavior.
import type { Binding } from "@expand/ink-input/bindings"
import { assertNever, type Action, type ListIntent, type UiState } from "@expand/tui/input/state"

export const listBindings: ReadonlyArray<Binding<ListIntent>> = [
  { keys: ["j", "down"], label: "next", action: "SelectNext" },
  { keys: ["k", "up"], label: "prev", action: "SelectPrev" },
  { keys: ["r"], label: "rename", action: "OpenRename" },
  { keys: ["d"], label: "dir", action: "OpenDirectory" },
  { keys: ["m"], label: "meta", action: "OpenMetadata" },
  { keys: ["a"], label: "archive", action: "ToggleArchive" },
  { keys: ["x", "delete"], label: "delete", action: "OpenConfirmDelete" },
  { keys: ["n", "tab"], label: "new", action: "FocusCreate" }
]

export const createBindings: ReadonlyArray<Binding<Action>> = [
  { keys: ["return"], label: "create", action: { _tag: "SubmitCreate" } },
  { keys: ["escape"], label: "clear", action: { _tag: "ClearCreate" } },
  { keys: ["tab"], label: "to list", action: { _tag: "FocusList" } }
]

export const textOverlayBindings: ReadonlyArray<Binding<Action>> = [
  { keys: ["return"], label: "submit", action: { _tag: "SubmitOverlay" } },
  { keys: ["escape"], label: "cancel", action: { _tag: "CancelOverlay" } }
]

export const metadataBindings: ReadonlyArray<Binding<Action>> = [
  { keys: ["return"], label: "submit", action: { _tag: "SubmitOverlay" } },
  { keys: ["escape"], label: "cancel", action: { _tag: "CancelOverlay" } },
  { keys: ["tab"], label: "switch field", action: { _tag: "SwitchMetadataField" } }
]

export const confirmDeleteBindings: ReadonlyArray<Binding<Action>> = [
  { keys: ["y", "Y", "return"], label: "confirm", action: { _tag: "SubmitOverlay" } },
  { keys: ["n", "N", "escape"], label: "cancel", action: { _tag: "CancelOverlay" } }
]

/** The hint bar shows exactly the active context's table. */
export const activeBindings = (ui: UiState): ReadonlyArray<Binding<unknown>> => {
  if (ui.overlay !== null) {
    switch (ui.overlay.kind) {
      case "confirmDelete": return confirmDeleteBindings
      case "metadata": return metadataBindings
      case "rename":
      case "directory": return textOverlayBindings
      default: return assertNever(ui.overlay)
    }
  }
  return ui.focus === "create" ? createBindings : listBindings
}
