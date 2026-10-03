// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import { describe, expect, vi } from "vitest"
import { fireEvent } from "@testing-library/react"
import { Effect } from "effect"
import { BackendConnectionSettings } from "@expand/desktop/renderer/features/backend/BackendConnectionSettings"
import { renderScoped } from "./ui-harness"

const localProps = {
  mode: "local" as const,
  form: { host: "", portText: "", url: "", secure: false, token: "" },
  hasStoredToken: false,
  probe: undefined,
  probeError: undefined,
  testing: false,
  onFormChange: vi.fn(),
  onTestConnection: vi.fn(),
  onSwitchMode: vi.fn()
}

describe("BackendConnectionSettings", () => {
  it.effect("switches modes without showing remote fields for local", () =>
    Effect.scoped(Effect.gen(function* () {
      const props = { ...localProps, onFormChange: vi.fn(), onTestConnection: vi.fn(), onSwitchMode: vi.fn() }
      const { getByLabelText, queryByLabelText } = yield* renderScoped(<BackendConnectionSettings {...props} />)
      expect(queryByLabelText("Host")).toBeNull()
      fireEvent.click(getByLabelText("Remote backend"))
      expect(props.onSwitchMode).toHaveBeenCalledWith("remote")
    })))

  it.effect("edits the remote form and tests the connection", () =>
    Effect.scoped(Effect.gen(function* () {
      const seen: Array<unknown> = []
      const props = {
        ...localProps,
        mode: "remote" as const,
        onFormChange: vi.fn((form: unknown) => {
          seen.push(form)
        }),
        onTestConnection: vi.fn(),
        onSwitchMode: vi.fn()
      }
      const { getByLabelText, getByRole } = yield* renderScoped(<BackendConnectionSettings {...props} />)
      fireEvent.change(getByLabelText("Host"), { target: { value: "backend.example" } })
      fireEvent.change(getByLabelText("Port"), { target: { value: "43111" } })
      const tokenInput = getByLabelText("Backend token") as HTMLInputElement
      expect(tokenInput.type).toBe("password")
      fireEvent.change(tokenInput, { target: { value: "test-token-value" } })
      expect(seen).toContainEqual({
        host: "backend.example",
        portText: "",
        url: "",
        secure: false,
        token: ""
      })
      expect(seen[seen.length - 1]).toMatchObject({ token: "test-token-value" })
      fireEvent.click(getByRole("button", { name: "Test connection" }))
      expect(props.onTestConnection).toHaveBeenCalledTimes(1)
    })))

  it.effect("shows reachable and auth status, and errors without the token", () =>
    Effect.scoped(Effect.gen(function* () {
      const secret = "ui-token-secret"
      const good = {
        ...localProps,
        mode: "remote" as const,
        probe: { reachable: true, authenticated: true, detail: "connected to ws://h:1/rpc" },
        onFormChange: vi.fn(),
        onTestConnection: vi.fn(),
        onSwitchMode: vi.fn()
      }
      const first = yield* renderScoped(<BackendConnectionSettings {...good} />)
      expect(first.getByRole("status").textContent).toContain("Connected")
      expect(first.getByRole("status").textContent).not.toContain(secret)
      const bad = {
        ...localProps,
        mode: "remote" as const,
        probe: { reachable: true, authenticated: false, detail: "reachable but rejected" },
        probeError: "remote backend unavailable",
        onFormChange: vi.fn(),
        onTestConnection: vi.fn(),
        onSwitchMode: vi.fn()
      }
      const second = yield* renderScoped(<BackendConnectionSettings {...bad} />)
      const alerts = second.queryAllByRole("alert").map((node) => node.textContent ?? "")
      expect(alerts.join("\n")).toContain("token was rejected")
      expect(alerts.join("\n")).toContain("remote backend unavailable")
      expect(alerts.join("\n")).not.toContain(secret)
    })))

  it.effect("disables testing while a probe is running", () =>
    Effect.scoped(Effect.gen(function* () {
      const props = {
        ...localProps,
        mode: "remote" as const,
        testing: true,
        onFormChange: vi.fn(),
        onTestConnection: vi.fn(),
        onSwitchMode: vi.fn()
      }
      const { getByRole } = yield* renderScoped(<BackendConnectionSettings {...props} />)
      expect((getByRole("button", { name: "Testing…" }) as HTMLButtonElement).disabled).toBe(true)
    })))
})
