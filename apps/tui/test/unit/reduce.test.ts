import { describe, expect, it } from "vitest"
import type { Project } from "@expand/contracts/project"
import { textField } from "@expand/ink-input/text-field"
import { initialUiState, type UiState } from "@expand/tui/input/state"
import { uiReduce } from "@expand/tui/input/reduce"

const pid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as string
const project = (n: number): Project => ({
  id: pid(n), name: `p${n}` as string, directory: null, description: null,
  tags: [] as ReadonlyArray<string>, archived: false, createdAt: "t", updatedAt: "t"
} as Project)

describe("uiReduce — text editing", () => {
  it("TextKey edits the create draft when create is focused", () => {
    const ui: UiState = { ...initialUiState, focus: "create" }
    const r1 = uiReduce(ui, { _tag: "TextKey", keyName: "d", input: "d" })
    const r2 = uiReduce(r1.ui, { _tag: "TextKey", keyName: "ata", input: "ata" })
    expect(r2.ui.create.value).toBe("data")
    expect([...r1.effects, ...r2.effects]).toEqual([]) // C1: zero effects from typing
  })
  it("TextKey edits the open overlay's field", () => {
    const ui: UiState = {
      ...initialUiState,
      overlay: { kind: "rename", projectId: pid(1), field: textField("p1") }
    }
    const { ui: next } = uiReduce(ui, { _tag: "TextKey", keyName: "backspace", input: "" })
    expect(next.overlay).toMatchObject({ kind: "rename", field: { value: "p" } })
  })
  it("TextKey edits the ACTIVE metadata field; SwitchMetadataField toggles", () => {
    const ui: UiState = {
      ...initialUiState,
      overlay: { kind: "metadata", projectId: pid(1), active: "description", description: textField(""), tags: textField("") }
    }
    const r1 = uiReduce(ui, { _tag: "TextKey", keyName: "x", input: "x" })
    expect(r1.ui.overlay).toMatchObject({ description: { value: "x" }, tags: { value: "" } })
    const r2 = uiReduce(r1.ui, { _tag: "SwitchMetadataField" })
    const r3 = uiReduce(r2.ui, { _tag: "TextKey", keyName: "y", input: "y" })
    expect(r3.ui.overlay).toMatchObject({ description: { value: "x" }, tags: { value: "y" } })
  })
})

describe("uiReduce — submits and effects", () => {
  it("SubmitCreate emits Create and clears the draft; empty draft is a no-op", () => {
    const ui: UiState = { ...initialUiState, focus: "create", create: textField("  data ") }
    const { ui: next, effects } = uiReduce(ui, { _tag: "SubmitCreate" })
    expect(effects).toEqual([{ _tag: "Create", name: "data" }])
    expect(next.create.value).toBe("")
    expect(uiReduce({ ...ui, create: textField("  ") }, { _tag: "SubmitCreate" }).effects).toEqual([])
  })
  it("SubmitOverlay on rename emits Rename and closes; empty value keeps it open", () => {
    const ui: UiState = { ...initialUiState, overlay: { kind: "rename", projectId: pid(1), field: textField("new-name") } }
    const { ui: next, effects } = uiReduce(ui, { _tag: "SubmitOverlay" })
    expect(effects).toEqual([{ _tag: "Rename", id: pid(1), name: "new-name" }])
    expect(next.overlay).toBeNull()
    const empty: UiState = { ...initialUiState, overlay: { kind: "rename", projectId: pid(1), field: textField(" ") } }
    const r = uiReduce(empty, { _tag: "SubmitOverlay" })
    expect(r.effects).toEqual([])
    expect(r.ui.overlay).not.toBeNull()
  })
  it("SubmitOverlay on metadata: empty description means CLEAR (null); tags parsed", () => {
    const ui: UiState = {
      ...initialUiState,
      overlay: { kind: "metadata", projectId: pid(1), active: "tags", description: textField("  "), tags: textField(" api,  db ,") }
    }
    const { effects } = uiReduce(ui, { _tag: "SubmitOverlay" })
    expect(effects).toEqual([{ _tag: "SetMetadata", id: pid(1), description: null, tags: ["api", "db"] }])
  })
  it("SubmitOverlay on confirmDelete emits Delete", () => {
    const ui: UiState = { ...initialUiState, overlay: { kind: "confirmDelete", projectId: pid(1) } }
    const { ui: next, effects } = uiReduce(ui, { _tag: "SubmitOverlay" })
    expect(effects).toEqual([{ _tag: "Delete", id: pid(1) }])
    expect(next.overlay).toBeNull()
  })
  it("ToggleArchive resolves archive vs restore from the payload", () => {
    expect(uiReduce(initialUiState, { _tag: "ToggleArchive", projectId: pid(1), currentlyArchived: false }).effects)
      .toEqual([{ _tag: "Archive", id: pid(1) }])
    expect(uiReduce(initialUiState, { _tag: "ToggleArchive", projectId: pid(1), currentlyArchived: true }).effects)
      .toEqual([{ _tag: "Restore", id: pid(1) }])
  })
  it("CancelOverlay closes with zero effects (escape is always side-effect-free)", () => {
    const ui: UiState = { ...initialUiState, overlay: { kind: "confirmDelete", projectId: pid(1) } }
    const { ui: next, effects } = uiReduce(ui, { _tag: "CancelOverlay" })
    expect(effects).toEqual([])
    expect(next.overlay).toBeNull()
  })
})

describe("uiReduce — Reconcile (concurrent-client races)", () => {
  it("auto-selects the first project on empty→non-empty", () => {
    const { ui } = uiReduce(initialUiState, { _tag: "Reconcile", projects: [project(1), project(2)] })
    expect(ui.selectedId).toBe(pid(1))
    expect(ui.selectedIndex).toBe(0)
  })
  it("clamps to the nearest neighbor when the selected project vanishes", () => {
    const ui: UiState = { ...initialUiState, selectedId: pid(2), selectedIndex: 1 }
    const { ui: next } = uiReduce(ui, { _tag: "Reconcile", projects: [project(1), project(3)] })
    expect(next.selectedId).toBe(pid(3)) // index 1 in the new list
    const atEnd: UiState = { ...initialUiState, selectedId: pid(3), selectedIndex: 2 }
    const r = uiReduce(atEnd, { _tag: "Reconcile", projects: [project(1)] })
    expect(r.ui.selectedId).toBe(pid(1))
    expect(r.ui.selectedIndex).toBe(0)
  })
  it("clears selection when the list empties", () => {
    const ui: UiState = { ...initialUiState, selectedId: pid(1), selectedIndex: 0 }
    const { ui: next } = uiReduce(ui, { _tag: "Reconcile", projects: [] })
    expect(next.selectedId).toBeNull()
  })
  it("closes an overlay whose project no longer exists", () => {
    const ui: UiState = {
      ...initialUiState, selectedId: pid(1), selectedIndex: 0,
      overlay: { kind: "rename", projectId: pid(2), field: textField("x") }
    }
    const { ui: next } = uiReduce(ui, { _tag: "Reconcile", projects: [project(1)] })
    expect(next.overlay).toBeNull()
  })
  it("keeps a live overlay open and tracks selection index drift", () => {
    const ui: UiState = {
      ...initialUiState, selectedId: pid(2), selectedIndex: 0,
      overlay: { kind: "rename", projectId: pid(2), field: textField("x") }
    }
    const { ui: next } = uiReduce(ui, { _tag: "Reconcile", projects: [project(1), project(2)] })
    expect(next.overlay).not.toBeNull()
    expect(next.selectedIndex).toBe(1)
  })
  it("clamps a negative stale selectedIndex to 0 (never crashes)", () => {
    const ui: UiState = { ...initialUiState, selectedId: pid(9), selectedIndex: -3 }
    const { ui: next } = uiReduce(ui, { _tag: "Reconcile", projects: [project(1), project(2)] })
    expect(next.selectedId).toBe(pid(1))
    expect(next.selectedIndex).toBe(0)
  })
})
