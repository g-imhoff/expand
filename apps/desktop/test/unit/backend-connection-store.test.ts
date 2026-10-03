import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import {
  backendConnectionStorageKey,
  loadBackendConnection,
  makeBackendConnectionStore,
  noteBackendSnapshot,
  rememberSelectedProject,
  reportBackendStatus,
  saveBackendConnection,
  switchBackendMode
} from "@expand/desktop/renderer/features/backend/backend-connection-store"

const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value)
    }
  }
}

describe("backend connection store", () => {
  it("starts on the local backend with no selection", () => {
    const store = makeBackendConnectionStore()
    expect(store.getState()).toEqual({
      mode: "local",
      remoteHost: "",
      remotePort: undefined,
      remoteUrl: "",
      secure: false,
      selectedProjectId: undefined,
      lastSeq: 0,
      status: "disconnected",
      error: undefined
    })
  })

  it("preserves project selection and sequence across mode switches and drops", () => {
    const store = makeBackendConnectionStore()
    store.setState({ remoteHost: "backend.example", remotePort: 43111 })
    rememberSelectedProject(store, "project-alpha")
    noteBackendSnapshot(store, 7)
    switchBackendMode(store, "remote")
    expect(store.getState()).toMatchObject({
      mode: "remote",
      remoteHost: "backend.example",
      remotePort: 43111,
      selectedProjectId: "project-alpha",
      lastSeq: 7,
      status: "disconnected",
      error: undefined
    })
    reportBackendStatus(store, "reconnecting")
    expect(store.getState()).toMatchObject({ selectedProjectId: "project-alpha", lastSeq: 7 })
    reportBackendStatus(store, "error", "remote backend unavailable")
    expect(store.getState()).toMatchObject({
      status: "error",
      error: "remote backend unavailable",
      selectedProjectId: "project-alpha",
      lastSeq: 7
    })
    switchBackendMode(store, "local")
    expect(store.getState()).toMatchObject({
      mode: "local",
      selectedProjectId: "project-alpha",
      lastSeq: 7,
      status: "disconnected",
      error: undefined
    })
  })

  it("round-trips non-secret state through storage without any token", () => {
    const secret = "store-secret-abc"
    const store = makeBackendConnectionStore({
      mode: "remote",
      remoteHost: "backend.example",
      remotePort: 43111,
      selectedProjectId: "project-alpha",
      lastSeq: 9
    })
    const storage = memoryStorage()
    saveBackendConnection(store, storage)
    const raw = storage.values.get(backendConnectionStorageKey) ?? ""
    expect(raw.length).toBeGreaterThan(0)
    expect(raw).not.toContain(secret)
    expect(raw).not.toContain("token")
    expect(raw).not.toContain("secret")
    const restored = loadBackendConnection(storage)
    expect(restored).toMatchObject({
      mode: "remote",
      remoteHost: "backend.example",
      remotePort: 43111,
      selectedProjectId: "project-alpha",
      lastSeq: 9
    })
    const revived = makeBackendConnectionStore(restored)
    expect(revived.getState()).toMatchObject({
      mode: "remote",
      selectedProjectId: "project-alpha",
      lastSeq: 9
    })
  })

  it("ignores missing storage and corrupt payloads", () => {
    expect(loadBackendConnection(undefined)).toBeUndefined()
    const storage = memoryStorage()
    expect(loadBackendConnection(storage)).toBeUndefined()
    storage.values.set(backendConnectionStorageKey, "{not json")
    expect(loadBackendConnection(storage)).toBeUndefined()
    const store = makeBackendConnectionStore()
    expect(() => saveBackendConnection(store, undefined)).not.toThrow()
  })
})
