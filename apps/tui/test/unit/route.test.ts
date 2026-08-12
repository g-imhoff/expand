import { describe, expect, it } from "vitest"
import type { Project } from "@expand/contracts/project"
import { textField } from "@expand/tui/input/text-field"
import { initialUiState, type Action, type UiState } from "@expand/tui/input/state"
import { route } from "@expand/tui/input/route"
import type { KeyEvent } from "@expand/ink-input"

const routeKey = (ui: UiState, projects: ReadonlyArray<Project>, key: string, input: string): Action | null => route(ui, projects, { key, input, ctrl: false, meta: false, shift: false } satisfies KeyEvent)
const routeShiftedKey = (ui: UiState, projects: ReadonlyArray<Project>, key: string, input: string): Action | null => route(ui, projects, { key, input, ctrl: false, meta: false, shift: true } satisfies KeyEvent)

const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as string
const project = (n: number, over: Partial<Project> = {}): Project => ({
  id: pid(n), name: `p${n}` as string, directory: null, description: null,
  tags: [] as ReadonlyArray<string>, archived: false, createdAt: "t", updatedAt: "t", ...over
} as Project)

const projects = [project(1), project(2), project(3)]
const listUi: UiState = { ...initialUiState, selectedId: pid(2), selectedIndex: 1 }
const createUi: UiState = { ...listUi, focus: "create" }

describe("route — list focus", () => {
  it("j/down and k/up move a real selection (not projects[0])", () => {
    expect(routeKey(listUi, projects, "j", "j")).toEqual({ _tag: "Select", id: pid(3), index: 2 })
    expect(routeKey(listUi, projects, "down", "")).toEqual({ _tag: "Select", id: pid(3), index: 2 })
    expect(routeKey(listUi, projects, "k", "k")).toEqual({ _tag: "Select", id: pid(1), index: 0 })
  })
  it("selection clamps at the edges", () => {
    const atEnd: UiState = { ...listUi, selectedId: pid(3), selectedIndex: 2 }
    expect(routeKey(atEnd, projects, "j", "j")).toEqual({ _tag: "Select", id: pid(3), index: 2 })
    const atStart: UiState = { ...listUi, selectedId: pid(1), selectedIndex: 0 }
    expect(routeKey(atStart, projects, "k", "k")).toEqual({ _tag: "Select", id: pid(1), index: 0 })
  })
  it("commands act on the SELECTED project", () => {
    expect(routeKey(listUi, projects, "r", "r")).toEqual({ _tag: "OpenRename", projectId: pid(2), currentName: "p2" })
    expect(routeKey(listUi, projects, "d", "d")).toEqual({ _tag: "OpenDirectory", projectId: pid(2) })
    expect(routeKey(listUi, projects, "x", "x")).toEqual({ _tag: "OpenConfirmDelete", projectId: pid(2) })
    expect(routeKey(listUi, projects, "delete", "")).toEqual({ _tag: "OpenConfirmDelete", projectId: pid(2) })
  })
  it("a resolves archive vs restore from the selected project's state", () => {
    expect(routeKey(listUi, projects, "a", "a")).toEqual({ _tag: "ToggleArchive", projectId: pid(2), currentlyArchived: false })
    const archived = [project(1), project(2, { archived: true }), project(3)]
    expect(routeKey(listUi, archived, "a", "a")).toEqual({ _tag: "ToggleArchive", projectId: pid(2), currentlyArchived: true })
  })
  it("m carries metadata prefill (description, comma-joined tags)", () => {
    const tagged = [project(1), project(2, { description: "desc", tags: ["api", "db"] as unknown as Project["tags"] }), project(3)]
    expect(routeKey(listUi, tagged, "m", "m")).toEqual({ _tag: "OpenMetadata", projectId: pid(2), description: "desc", tags: "api, db" })
  })
  it("n and tab focus the create field", () => {
    expect(routeKey(listUi, projects, "n", "n")).toEqual({ _tag: "FocusCreate" })
    expect(routeKey(listUi, projects, "tab", "")).toEqual({ _tag: "FocusCreate" })
  })
  it("commands need a selection; focus-create does not", () => {
    const noSel: UiState = { ...initialUiState }
    expect(routeKey(noSel, [], "r", "r")).toBeNull()
    expect(routeKey(noSel, [], "a", "a")).toBeNull()
    expect(routeKey(noSel, [], "j", "j")).toBeNull()
    expect(routeKey(noSel, [], "n", "n")).toEqual({ _tag: "FocusCreate" })
  })
  it("unbound keys are ignored", () => {
    expect(routeKey(listUi, projects, "q", "q")).toBeNull()
    expect(routeKey(listUi, projects, "backspace", "")).toBeNull() // C1: backspace must NOT open delete-confirm
  })
  it("null selection with non-empty projects: nav and commands are no-ops", () => {
    const noSel: UiState = { ...initialUiState }
    expect(routeKey(noSel, projects, "j", "j")).toBeNull()
    expect(routeKey(noSel, projects, "r", "r")).toBeNull()
  })
})

describe("route — create focus (THE C1 regression)", () => {
  it("typing letters that are command keys prepares field state, never commands", () => {
    for (const ch of ["d", "a", "t", "a", "r", "m", "x", "n", "j", "k"]) {
      expect(routeKey(createUi, projects, ch, ch)).toEqual({ _tag: "EditField", state: { value: ch, cursor: 1 } })
    }
  })
  it("backspace/delete edit text, never open confirm", () => {
    expect(routeKey(createUi, projects, "backspace", "")).toEqual({ _tag: "EditField", state: { value: "", cursor: 0 } })
    expect(routeKey(createUi, projects, "delete", "")).toEqual({ _tag: "EditField", state: { value: "", cursor: 0 } })
    expect(routeKey({ ...createUi, create: textField("a😀b") }, projects, "delete", "")).toEqual({ _tag: "EditField", state: { value: "a😀", cursor: 2 } })
  })
  it("only return/escape/tab fall through", () => {
    expect(routeKey(createUi, projects, "return", "")).toEqual({ _tag: "SubmitCreate" })
    expect(routeKey(createUi, projects, "escape", "")).toEqual({ _tag: "ClearCreate" })
    expect(routeKey(createUi, projects, "tab", "")).toEqual({ _tag: "FocusList" })
  })
  it("pasted literal key-name words are text, never actions (text first refusal)", () => {
    expect(routeKey(createUi, projects, "tab", "tab")).toEqual({ _tag: "EditField", state: { value: "tab", cursor: 3 } })
    expect(routeKey(createUi, projects, "return", "return")).toEqual({ _tag: "EditField", state: { value: "return", cursor: 6 } })
    expect(routeKey(createUi, projects, "escape", "escape")).toEqual({ _tag: "EditField", state: { value: "escape", cursor: 6 } })
  })
})

describe("route — overlays are modal", () => {
  const confirmUi: UiState = { ...listUi, overlay: { kind: "confirmDelete", projectId: pid(2) } }
  const renameUi: UiState = { ...listUi, overlay: { kind: "rename", projectId: pid(2), field: textField("p2") } }
  const metaUi: UiState = {
    ...listUi,
    overlay: { kind: "metadata", projectId: pid(2), active: "description", description: textField(""), tags: textField("") }
  }

  it("confirmDelete: y/return confirm, n/escape cancel, everything else ignored", () => {
    expect(routeKey(confirmUi, projects, "y", "y")).toEqual({ _tag: "SubmitOverlay" })
    expect(routeShiftedKey(confirmUi, projects, "Y", "Y")).toEqual({ _tag: "SubmitOverlay" })
    expect(routeKey(confirmUi, projects, "return", "")).toEqual({ _tag: "SubmitOverlay" })
    expect(routeKey(confirmUi, projects, "n", "n")).toEqual({ _tag: "CancelOverlay" })
    expect(routeShiftedKey(confirmUi, projects, "N", "N")).toEqual({ _tag: "CancelOverlay" })
    expect(routeKey(confirmUi, projects, "escape", "")).toEqual({ _tag: "CancelOverlay" })
    expect(routeKey(confirmUi, projects, "a", "a")).toBeNull() // list keys dead under overlay
    expect(routeKey(confirmUi, projects, "j", "j")).toBeNull()
  })
  it("rename overlay: text first refusal; list keys dead", () => {
    expect(routeKey(renameUi, projects, "a", "a")).toEqual({ _tag: "EditField", state: { value: "p2a", cursor: 3 } })
    expect(routeKey(renameUi, projects, "escape", "")).toEqual({ _tag: "CancelOverlay" })
    expect(routeKey(renameUi, projects, "return", "")).toEqual({ _tag: "SubmitOverlay" })
    expect(routeKey(renameUi, projects, "tab", "")).toBeNull() // tab unbound in rename
  })
  it("metadata overlay: tab switches fields instead of focusing", () => {
    expect(routeKey(metaUi, projects, "tab", "")).toEqual({ _tag: "SwitchMetadataField" })
    expect(routeKey(metaUi, projects, "x", "x")).toEqual({ _tag: "EditField", state: { value: "x", cursor: 1 } })
  })
  it("rename overlay: pasted 'return' is text, real Enter still submits", () => {
    expect(routeKey(renameUi, projects, "return", "return")).toEqual({ _tag: "EditField", state: { value: "p2return", cursor: 8 } })
    expect(routeKey(renameUi, projects, "return", "")).toEqual({ _tag: "SubmitOverlay" })
  })
})
