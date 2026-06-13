import { describe, expect, it } from "vitest"
import type { Project, ProjectId, ProjectName, Tag } from "@yodea/contracts/project"
import { textField } from "@yodea/ink-input/text-field"
import { initialUiState, type UiState } from "@yodea/tui/input/state"
import { route } from "@yodea/tui/input/route"

const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as ProjectId
const project = (n: number, over: Partial<Project> = {}): Project => ({
  id: pid(n), name: `p${n}` as ProjectName, directory: null, description: null,
  tags: [] as ReadonlyArray<Tag>, archived: false, createdAt: "t", updatedAt: "t", ...over
} as Project)

const projects = [project(1), project(2), project(3)]
const listUi: UiState = { ...initialUiState, selectedId: pid(2), selectedIndex: 1 }
const createUi: UiState = { ...listUi, focus: "create" }

describe("route — list focus", () => {
  it("j/down and k/up move a real selection (not projects[0])", () => {
    expect(route(listUi, projects, "j", "j")).toEqual({ _tag: "Select", id: pid(3), index: 2 })
    expect(route(listUi, projects, "down", "")).toEqual({ _tag: "Select", id: pid(3), index: 2 })
    expect(route(listUi, projects, "k", "k")).toEqual({ _tag: "Select", id: pid(1), index: 0 })
  })
  it("selection clamps at the edges", () => {
    const atEnd: UiState = { ...listUi, selectedId: pid(3), selectedIndex: 2 }
    expect(route(atEnd, projects, "j", "j")).toEqual({ _tag: "Select", id: pid(3), index: 2 })
    const atStart: UiState = { ...listUi, selectedId: pid(1), selectedIndex: 0 }
    expect(route(atStart, projects, "k", "k")).toEqual({ _tag: "Select", id: pid(1), index: 0 })
  })
  it("commands act on the SELECTED project", () => {
    expect(route(listUi, projects, "r", "r")).toEqual({ _tag: "OpenRename", projectId: pid(2), currentName: "p2" })
    expect(route(listUi, projects, "d", "d")).toEqual({ _tag: "OpenDirectory", projectId: pid(2) })
    expect(route(listUi, projects, "x", "x")).toEqual({ _tag: "OpenConfirmDelete", projectId: pid(2) })
    expect(route(listUi, projects, "delete", "")).toEqual({ _tag: "OpenConfirmDelete", projectId: pid(2) })
  })
  it("a resolves archive vs restore from the selected project's state", () => {
    expect(route(listUi, projects, "a", "a")).toEqual({ _tag: "ToggleArchive", projectId: pid(2), currentlyArchived: false })
    const archived = [project(1), project(2, { archived: true }), project(3)]
    expect(route(listUi, archived, "a", "a")).toEqual({ _tag: "ToggleArchive", projectId: pid(2), currentlyArchived: true })
  })
  it("m carries metadata prefill (description, comma-joined tags)", () => {
    const tagged = [project(1), project(2, { description: "desc", tags: ["api", "db"] as unknown as ReadonlyArray<Tag> }), project(3)]
    expect(route(listUi, tagged, "m", "m")).toEqual({ _tag: "OpenMetadata", projectId: pid(2), description: "desc", tags: "api, db" })
  })
  it("n and tab focus the create field", () => {
    expect(route(listUi, projects, "n", "n")).toEqual({ _tag: "FocusCreate" })
    expect(route(listUi, projects, "tab", "")).toEqual({ _tag: "FocusCreate" })
  })
  it("commands need a selection; focus-create does not", () => {
    const noSel: UiState = { ...initialUiState }
    expect(route(noSel, [], "r", "r")).toBeNull()
    expect(route(noSel, [], "a", "a")).toBeNull()
    expect(route(noSel, [], "j", "j")).toBeNull()
    expect(route(noSel, [], "n", "n")).toEqual({ _tag: "FocusCreate" })
  })
  it("unbound keys are ignored", () => {
    expect(route(listUi, projects, "q", "q")).toBeNull()
    expect(route(listUi, projects, "backspace", "")).toBeNull() // C1: backspace must NOT open delete-confirm
  })
  it("null selection with non-empty projects: nav and commands are no-ops", () => {
    const noSel: UiState = { ...initialUiState }
    expect(route(noSel, projects, "j", "j")).toBeNull()
    expect(route(noSel, projects, "r", "r")).toBeNull()
  })
})

describe("route — create focus (THE C1 regression)", () => {
  it("typing letters that are command keys yields TextKey, never commands", () => {
    for (const ch of ["d", "a", "t", "a", "r", "m", "x", "n", "j", "k"]) {
      expect(route(createUi, projects, ch, ch)).toEqual({ _tag: "TextKey", keyName: ch, input: ch })
    }
  })
  it("backspace/delete edit text, never open confirm", () => {
    expect(route(createUi, projects, "backspace", "")).toEqual({ _tag: "TextKey", keyName: "backspace", input: "" })
    expect(route(createUi, projects, "delete", "")).toEqual({ _tag: "TextKey", keyName: "delete", input: "" })
  })
  it("only return/escape/tab fall through", () => {
    expect(route(createUi, projects, "return", "")).toEqual({ _tag: "SubmitCreate" })
    expect(route(createUi, projects, "escape", "")).toEqual({ _tag: "ClearCreate" })
    expect(route(createUi, projects, "tab", "")).toEqual({ _tag: "FocusList" })
  })
  it("pasted literal key-name words are text, never actions (text first refusal)", () => {
    expect(route(createUi, projects, "tab", "tab")).toEqual({ _tag: "TextKey", keyName: "tab", input: "tab" })
    expect(route(createUi, projects, "return", "return")).toEqual({ _tag: "TextKey", keyName: "return", input: "return" })
    expect(route(createUi, projects, "escape", "escape")).toEqual({ _tag: "TextKey", keyName: "escape", input: "escape" })
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
    expect(route(confirmUi, projects, "y", "y")).toEqual({ _tag: "SubmitOverlay" })
    expect(route(confirmUi, projects, "return", "")).toEqual({ _tag: "SubmitOverlay" })
    expect(route(confirmUi, projects, "n", "n")).toEqual({ _tag: "CancelOverlay" })
    expect(route(confirmUi, projects, "escape", "")).toEqual({ _tag: "CancelOverlay" })
    expect(route(confirmUi, projects, "a", "a")).toBeNull() // list keys dead under overlay
    expect(route(confirmUi, projects, "j", "j")).toBeNull()
  })
  it("rename overlay: text first refusal; list keys dead", () => {
    expect(route(renameUi, projects, "a", "a")).toEqual({ _tag: "TextKey", keyName: "a", input: "a" })
    expect(route(renameUi, projects, "escape", "")).toEqual({ _tag: "CancelOverlay" })
    expect(route(renameUi, projects, "return", "")).toEqual({ _tag: "SubmitOverlay" })
    expect(route(renameUi, projects, "tab", "")).toBeNull() // tab unbound in rename
  })
  it("metadata overlay: tab switches fields instead of focusing", () => {
    expect(route(metaUi, projects, "tab", "")).toEqual({ _tag: "SwitchMetadataField" })
    expect(route(metaUi, projects, "x", "x")).toEqual({ _tag: "TextKey", keyName: "x", input: "x" })
  })
  it("rename overlay: pasted 'return' is text, real Enter still submits", () => {
    expect(route(renameUi, projects, "return", "return")).toEqual({ _tag: "TextKey", keyName: "return", input: "return" })
    expect(route(renameUi, projects, "return", "")).toEqual({ _tag: "SubmitOverlay" })
  })
})
