// apps/tui/input/state.ts
// Pure module — no ink imports. The TUI's input state machine vocabulary.
import type { Project } from "@yodea/contracts/project"
import { emptyTextField, type TextFieldState } from "@yodea/ink-input/text-field"
import type { KeyName } from "@yodea/ink-input/key-name"

export type Focus = "list" | "create"

export type Overlay =
  | { readonly kind: "rename"; readonly projectId: string; readonly field: TextFieldState }
  | { readonly kind: "directory"; readonly projectId: string; readonly field: TextFieldState }
  | {
      readonly kind: "metadata"; readonly projectId: string
      readonly active: "description" | "tags"
      readonly description: TextFieldState; readonly tags: TextFieldState
    }
  | { readonly kind: "confirmDelete"; readonly projectId: string }

export type UiState = {
  readonly focus: Focus
  readonly overlay: Overlay | null
  readonly selectedId: string | null
  /** Last known index of the selection — lets reconcile clamp to the nearest
   *  neighbor when the selected project vanishes (concurrent client). */
  readonly selectedIndex: number
  readonly create: TextFieldState
}

export const initialUiState: UiState = {
  focus: "list", overlay: null, selectedId: null, selectedIndex: 0, create: emptyTextField
}

/** Intents carried by the list binding table; route() enriches them with the
 *  selected project's data (the only projects-aware step). */
export type ListIntent =
  | "SelectNext" | "SelectPrev"
  | "OpenRename" | "OpenDirectory" | "OpenMetadata"
  | "ToggleArchive" | "OpenConfirmDelete" | "FocusCreate"

/** Fully resolved actions — everything reduce needs is in the payload. */
export type Action =
  | { readonly _tag: "Select"; readonly id: string; readonly index: number }
  | { readonly _tag: "FocusCreate" }
  | { readonly _tag: "FocusList" }
  | { readonly _tag: "OpenRename"; readonly projectId: string; readonly currentName: string }
  /** Directory overlay deliberately opens EMPTY (no currentDirectory prefill): submitting a stale old path by reflex-Enter is worse than retyping; matches pre-redesign behavior. */
  | { readonly _tag: "OpenDirectory"; readonly projectId: string }
  | { readonly _tag: "OpenMetadata"; readonly projectId: string; readonly description: string; readonly tags: string }
  | { readonly _tag: "OpenConfirmDelete"; readonly projectId: string }
  | { readonly _tag: "ToggleArchive"; readonly projectId: string; readonly currentlyArchived: boolean }
  | { readonly _tag: "CancelOverlay" }
  | { readonly _tag: "SubmitOverlay" }
  | { readonly _tag: "SwitchMetadataField" }
  | { readonly _tag: "TextKey"; readonly keyName: KeyName; readonly input: string }
  | { readonly _tag: "SubmitCreate" }
  | { readonly _tag: "ClearCreate" }
  | { readonly _tag: "Reconcile"; readonly projects: ReadonlyArray<Project> }

export const assertNever = (value: never): never => {
  throw new Error(`unreachable: ${JSON.stringify(value)}`)
}
