// apps/tui/input/route.ts
// Pure module — no ink imports. THE routing decision: top-down, first match
// returns and stops. A key can never reach two consumers because there is no
// second lookup. ctrl+c is Ink's built-in exit and never reaches us.
import type { Project } from "@yodea/contracts/project"
import type { KeyName } from "@yodea/ink-input/key-name"
import { resolveBinding } from "@yodea/ink-input/bindings"
import { textFieldConsumes } from "@yodea/ink-input/text-field"
import {
  assertNever, type Action, type UiState
} from "@yodea/tui/input/state"
import {
  confirmDeleteBindings, createBindings, listBindings, metadataBindings,
  textOverlayBindings
} from "@yodea/tui/input/bindings"

export const route = (
  ui: UiState,
  projects: ReadonlyArray<Project>,
  keyName: KeyName,
  input: string
): Action | null => {
  // 1. Overlay open → ONLY its table is consulted (modal semantics).
  if (ui.overlay !== null) {
    switch (ui.overlay.kind) {
      case "confirmDelete":
        return resolveBinding(confirmDeleteBindings, keyName)
      case "rename":
      case "directory": {
        // Text field gets first refusal: a pasted literal "return"/"escape"
        // is text, not a command. Real Enter/Esc arrive with input ""/"\r" —
        // textFieldConsumes rejects them, so they fall through to the table.
        if (textFieldConsumes(keyName, input)) return { _tag: "TextKey", keyName, input }
        return resolveBinding(textOverlayBindings, keyName)
      }
      case "metadata": {
        // Text field gets first refusal (see rename/directory). Real
        // return/escape/tab fall through to switch fields / submit / cancel.
        if (textFieldConsumes(keyName, input)) return { _tag: "TextKey", keyName, input }
        return resolveBinding(metadataBindings, keyName)
      }
      default:
        return assertNever(ui.overlay)
    }
  }

  // 2. Create field focused. Structural property: NO command lookup exists in
  //    this branch — typing d-a-t-a cannot reach a binding because the code
  //    path does not exist. The text field gets first refusal: a pasted
  //    literal "return"/"escape"/"tab" is text, not submit/clear/focus-list.
  //    Real Enter/Esc/Tab arrive with input ""/"\r"/"\t" — textFieldConsumes
  //    rejects them, so they fall through to createBindings.
  if (ui.focus === "create") {
    if (textFieldConsumes(keyName, input)) return { _tag: "TextKey", keyName, input }
    return resolveBinding(createBindings, keyName)
  }

  // 3. List focused → the list table, enriched with the selected project.
  const intent = resolveBinding(listBindings, keyName)
  if (intent === null) return null
  if (intent === "FocusCreate") return { _tag: "FocusCreate" }

  if (projects.length === 0) return null
  const index = ui.selectedId === null ? -1 : projects.findIndex((p) => p.id === ui.selectedId)
  const selected = index === -1 ? null : projects[index]!

  switch (intent) {
    case "SelectNext":
    case "SelectPrev": {
      if (selected === null) return null
      const next = intent === "SelectNext"
        ? Math.min(index + 1, projects.length - 1)
        : Math.max(index - 1, 0)
      const target = projects[next]!
      return { _tag: "Select", id: target.id, index: next }
    }
    case "OpenRename":
      return selected === null ? null : { _tag: "OpenRename", projectId: selected.id, currentName: selected.name }
    case "OpenDirectory":
      return selected === null ? null : { _tag: "OpenDirectory", projectId: selected.id }
    case "OpenMetadata":
      return selected === null ? null : {
        _tag: "OpenMetadata", projectId: selected.id,
        description: selected.description ?? "", tags: selected.tags.join(", ")
      }
    case "OpenConfirmDelete":
      return selected === null ? null : { _tag: "OpenConfirmDelete", projectId: selected.id }
    case "ToggleArchive":
      return selected === null ? null : { _tag: "ToggleArchive", projectId: selected.id, currentlyArchived: selected.archived }
    default:
      return assertNever(intent)
  }
}
