// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import { describe, expect, vi } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import { Effect } from "effect"
import { renderScoped } from "./ui-harness"
import { ConnectionSettingsPage } from "@expand/desktop/renderer/features/settings/components/ConnectionSettingsPage"
import { FeatureCredentialSeam } from "@expand/desktop/renderer/features/settings/components/FeatureCredentialSeam"
import { SettingsRailButton } from "@expand/desktop/renderer/features/settings/components/SettingsRailButton"
import type { ConnectionSettingsModel } from "@expand/desktop/renderer/features/settings/model/settings-contract"

const readyModel: ConnectionSettingsModel = {
  status: "ready",
  error: null,
  github: {
    kind: "github",
    health: "degraded",
    accountName: "octo",
    scopes: [
      { scope: "repo", granted: true },
      { scope: "read:org", granted: false }
    ],
    canPushToGh: true,
    isBusy: false
  },
  zen: { kind: "zen", health: "missing", keySaved: false, isBusy: false },
  backendName: "local"
}

const props = {
  onStartGithubOAuth: vi.fn(),
  onPushToGh: vi.fn(),
  onSaveZenKey: vi.fn(),
  onTestConnection: vi.fn(),
  onRetry: vi.fn()
}

describe("SettingsConnection", () => {
  it.effect("names the missing scope and never echoes saved secrets", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderScoped(
        <ConnectionSettingsPage model={readyModel} {...props} />
      )
      expect(screen.getByRole("heading", { name: "Settings" })).toBeDefined()
      expect(screen.getByText("Missing scope:")).toBeDefined()
      expect(screen.getByText("read:org")).toBeDefined()
      expect(screen.queryByDisplayValue("octo")).toBeNull()
      const zenInput = screen.getByLabelText("API key") as HTMLInputElement
      fireEvent.change(zenInput, { target: { value: "secret-key" } })
      fireEvent.click(screen.getByRole("button", { name: "Save Zen API key" }))
      expect(props.onSaveZenKey).toHaveBeenCalledExactlyOnceWith("secret-key")
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("")
    })))

  it.effect("disables the feature picker seam until connected and preserves the return target", () =>
    Effect.scoped(Effect.gen(function* () {
      const onOpenSettings = vi.fn()
      yield* renderScoped(
        <FeatureCredentialSeam
          seam={{ connected: false, featureName: "GitHub", returnTarget: "/routines/new" }}
          onOpenSettings={onOpenSettings}
        >
          {(disabled) => <button type="button" disabled={disabled}>Pick repository</button>}
        </FeatureCredentialSeam>
      )
      const picker = screen.getByRole("button", { name: "Pick repository" })
      expect((picker as HTMLButtonElement).disabled).toBe(true)
      expect(screen.getByText(/Your draft is preserved/)).toBeDefined()
      fireEvent.click(screen.getByRole("button", { name: "Open settings" }))
      expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith("/routines/new")
    })))

  it.effect("pins the rail gear with an accessible name and active state", () =>
    Effect.scoped(Effect.gen(function* () {
      const onOpen = vi.fn()
      yield* renderScoped(<SettingsRailButton active={true} onOpen={onOpen} />)
      const button = screen.getByRole("button", { name: "Settings" })
      expect(button.getAttribute("aria-current")).toBe("page")
      expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
      fireEvent.click(button)
      expect(onOpen).toHaveBeenCalledOnce()
    })))
})
