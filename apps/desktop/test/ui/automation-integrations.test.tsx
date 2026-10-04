// @vitest-environment happy-dom
import type { ReactElement } from "react"
import { it } from "@effect/vitest"
import { fireEvent, screen } from "@testing-library/react"
import { Data, Effect } from "effect"
import { describe, expect } from "vitest"
import { AutomationNotFound } from "@expand/contracts/rpc/automation-schemas"
import type { Catalog } from "@expand/contracts/automation"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { startRendererRoot } from "@expand/desktop/renderer/app/runner"
import { ProjectContextProvider } from "@expand/desktop/renderer/features/projects/data/project-context"
import { GithubConnection } from "@expand/desktop/renderer/features/automations/components/GithubConnection"
import { RegisteredIntegrations } from "@expand/desktop/renderer/features/automations/components/RegisteredIntegrations"
import { ZenConnection } from "@expand/desktop/renderer/features/automations/components/ZenConnection"
import { automationScopeForProject } from "@expand/desktop/renderer/features/automations/model/integration-messages"
import type { AutomationRpcApi } from "@expand/desktop/renderer/rpc/automation-rpc"
import { makeFakeProjectContext, renderScoped, uid } from "./ui-harness"

const scope = automationScopeForProject(uid(1))

const renderWithAutomation = (ui: ReactElement, automation?: Partial<AutomationRpcApi>) =>
  renderScoped(
    <RendererRunnerProvider value={{ start: startRendererRoot }}>
      <ProjectContextProvider value={makeFakeProjectContext([], {}, automation)}>
        {ui}
      </ProjectContextProvider>
    </RendererRunnerProvider>
  )

const fakeCatalog = (definitions: ReadonlyArray<unknown>) =>
  Effect.succeed({
    schemaVersion: 1 as const,
    kind: "catalog" as const,
    definitions: definitions as unknown as Catalog["definitions"]
  })

const githubIntegrationDescriptor = {
  kind: "integration",
  definition: { id: "github:integration", version: 1 },
  title: "GitHub"
}

const exampleIntegrationDescriptor = {
  kind: "integration",
  definition: { id: "example:integration", version: 2 },
  title: "Example"
}

const triggerDescriptor = {
  kind: "trigger",
  definition: { id: "github:issue-opened", version: 1 },
  title: "GitHub issue opened"
}

const containsSecret = (value: unknown, secret: string): boolean => {
  if (value === secret) return true
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, secret))
  if (value !== null && typeof value === "object") return Object.values(value).some((entry) => containsSecret(entry, secret))
  return false
}

class CatalogFailed extends Data.TaggedError("CatalogFailed")<{
  readonly message: string
}> {}

describe("RegisteredIntegrations", () => {
  it.effect("renders the integrations registered on the backend", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderWithAutomation(<RegisteredIntegrations />, {
        catalog: () => fakeCatalog([githubIntegrationDescriptor, exampleIntegrationDescriptor, triggerDescriptor])
      })
      yield* Effect.tryPromise(() => screen.findByText("GitHub"))
      yield* Effect.tryPromise(() => screen.findByText("Example"))
      yield* Effect.tryPromise(() => screen.findByText("example:integration version 2"))
      expect(screen.queryByText("GitHub issue opened")).toBeNull()
    })))

  it.effect("renders an empty state when the backend registers nothing", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderWithAutomation(<RegisteredIntegrations />, { catalog: () => fakeCatalog([]) })
      yield* Effect.tryPromise(() => screen.findByText("No integrations are registered on the backend yet."))
    })))

  it.effect("renders a loading state while the catalog is pending", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderWithAutomation(<RegisteredIntegrations />, { catalog: () => Effect.never })
      yield* Effect.tryPromise(() => screen.findByText("Loading registered integrations…"))
    })))

  it.effect("renders backend errors with a retry that recovers", () =>
    Effect.scoped(Effect.gen(function* () {
      let calls = 0
      yield* renderWithAutomation(<RegisteredIntegrations />, {
        catalog: (() => {
          calls += 1
          return calls === 1
            ? Effect.fail(new CatalogFailed({ message: "backend is down" }))
            : fakeCatalog([githubIntegrationDescriptor])
        }) as unknown as AutomationRpcApi["catalog"]
      })
      yield* Effect.tryPromise(() => screen.findByRole("alert"))
      expect(screen.getByRole("alert").textContent).toContain("backend is down")
      fireEvent.click(screen.getByRole("button", { name: "Retry" }))
      yield* Effect.tryPromise(() => screen.findByText("GitHub"))
      expect(calls).toBe(2)
    })))

  it.effect("renders an unavailable state without an automation backend", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderWithAutomation(<RegisteredIntegrations />)
      yield* Effect.tryPromise(() => screen.findByText("Automation services are unavailable in this session."))
    })))
})

describe("GithubConnection", () => {
  it.effect("writes the credential by reference and never echoes the secret", () =>
    Effect.scoped(Effect.gen(function* () {
      const secret = "github-secret-for-tests-only"
      const seen: Array<{ readonly method: string; readonly payload: unknown }> = []
      let saved = false
      yield* renderWithAutomation(<GithubConnection scope={scope} />, {
        listCredentials: () =>
          Effect.succeed(saved
            ? { credentials: [{ credentialId: "github-token", version: 1, configured: true as const }] }
            : { credentials: [] }),
        putCredential: ((payload: { readonly credentialId: string; readonly secret: unknown }) => {
          seen.push({ method: "putCredential", payload })
          saved = true
          return Effect.succeed({ credentialId: "github-token", version: 1, configured: true as const })
        }) as unknown as AutomationRpcApi["putCredential"],
        putIntegration: ((payload: { readonly integration: unknown }) => {
          seen.push({ method: "putIntegration", payload })
          return Effect.succeed({ version: 1 })
        }) as unknown as AutomationRpcApi["putIntegration"]
      })
      fireEvent.change(screen.getByLabelText("Repository owner"), { target: { value: "octo" } })
      fireEvent.change(screen.getByLabelText("Repository name"), { target: { value: "hello" } })
      fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: secret } })
      fireEvent.click(screen.getByRole("button", { name: "Save GitHub connection" }))
      yield* Effect.tryPromise(() => screen.findByText("A GitHub token is saved for this project."))
      const credentialCall = seen.find((entry) => entry.method === "putCredential")
      expect(credentialCall?.payload).toMatchObject({ credentialId: "github-token", secret })
      const integrationCall = seen.find((entry) => entry.method === "putIntegration")
      expect(integrationCall?.payload).toMatchObject({
        integration: {
          id: "github",
          configuration: { owner: "octo", repo: "hello" },
          credentials: { token: { credentialId: "github-token" } }
        }
      })
      for (const entry of seen) {
        if (entry.method === "putCredential") continue
        expect(containsSecret(entry.payload, secret)).toBe(false)
      }
      expect((screen.getByLabelText("Personal access token") as HTMLInputElement).value).toBe("")
      expect(document.body.textContent ?? "").not.toContain(secret)
    })))

  it.effect("shows configured repository and labels from the backend status", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderWithAutomation(<GithubConnection scope={scope} />, {
        listCredentials: () => Effect.succeed({ credentials: [] }),
        integrationStatus: () =>
          Effect.succeed({ ok: true, configured: true, owner: "octo", repo: "hello", labels: 12 })
      })
      fireEvent.click(screen.getByRole("button", { name: "Test connection" }))
      yield* Effect.tryPromise(() => screen.findByRole("status"))
      expect(screen.getByRole("status").textContent).toContain("Connected.")
      expect(document.body.textContent ?? "").toContain("octo/hello")
      expect(document.body.textContent ?? "").toContain("Labels: 12")
      expect(document.body.textContent ?? "").toContain("Configured: yes")
    })))

  it.effect("renders actionable guidance when the backend rejects the credential", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderWithAutomation(<GithubConnection scope={scope} />, {
        listCredentials: () => Effect.succeed({ credentials: [] }),
        integrationStatus: () => Effect.succeed({ ok: false, configured: true, owner: "octo", repo: "hello", code: "auth", reason: "Bad credentials" })
      })
      fireEvent.click(screen.getByRole("button", { name: "Test connection" }))
      const alert = yield* Effect.tryPromise(() => screen.findByRole("alert"))
      expect(alert.textContent).toContain("rejected")
    })))

  it.effect("renders setup guidance when the integration is not configured", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderWithAutomation(<GithubConnection scope={scope} />, {
        listCredentials: () => Effect.succeed({ credentials: [] }),
        integrationStatus: (() =>
          Effect.fail(new AutomationNotFound({ code: "missing", message: "Integration is not configured" }))
        ) as unknown as AutomationRpcApi["integrationStatus"]
      })
      fireEvent.click(screen.getByRole("button", { name: "Test connection" }))
      const alert = yield* Effect.tryPromise(() => screen.findByRole("alert"))
      expect(alert.textContent).toContain("not configured yet")
    })))

  it.effect("reads only redacted credential statuses", () =>
    Effect.scoped(Effect.gen(function* () {
      const seen: Array<string> = []
      const statuses = [{ credentialId: "github-token", version: 1, configured: true as const }]
      const tracking = (method: string) => () => {
        seen.push(method)
        return Effect.succeed({ credentials: statuses })
      }
      yield* renderWithAutomation(<GithubConnection scope={scope} />, {
        listCredentials: tracking("listCredentials") as AutomationRpcApi["listCredentials"]
      })
      yield* Effect.tryPromise(() => screen.findByText("A GitHub token is saved for this project."))
      expect(seen).toEqual(["listCredentials"])
      expect(statuses).toEqual([{ credentialId: "github-token", version: 1, configured: true }])
      expect((screen.getByLabelText("Personal access token") as HTMLInputElement).getAttribute("type")).toBe("password")
    })))
})

describe("ZenConnection", () => {
  it.effect("saves the API key by reference without displaying it", () =>
    Effect.scoped(Effect.gen(function* () {
      const secret = "zen-key-for-tests-only"
      const seen: Array<{ readonly method: string; readonly payload: unknown }> = []
      let saved = false
      yield* renderWithAutomation(<ZenConnection scope={scope} />, {
        listCredentials: () =>
          Effect.succeed(saved
            ? { credentials: [{ credentialId: "zen-api-key", version: 1, configured: true as const }] }
            : { credentials: [] }),
        putCredential: ((payload: { readonly credentialId: string; readonly secret: unknown }) => {
          seen.push({ method: "putCredential", payload })
          saved = true
          return Effect.succeed({ credentialId: "zen-api-key", version: 1, configured: true as const })
        }) as unknown as AutomationRpcApi["putCredential"]
      })
      fireEvent.change(screen.getByLabelText("API key"), { target: { value: secret } })
      fireEvent.click(screen.getByRole("button", { name: "Save Zen API key" }))
      yield* Effect.tryPromise(() => screen.findByText("A Zen API key is saved for this project."))
      expect(seen).toHaveLength(1)
      expect(seen[0]?.payload).toMatchObject({ credentialId: "zen-api-key", secret })
      expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("")
      expect(document.body.textContent ?? "").not.toContain(secret)
    })))

  it.effect("tests the saved key through redacted credential reads", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderWithAutomation(<ZenConnection scope={scope} />, {
        listCredentials: () => Effect.succeed({ credentials: [{ credentialId: "zen-api-key", version: 1, configured: true as const }] })
      })
      fireEvent.click(screen.getByRole("button", { name: "Test connection" }))
      yield* Effect.tryPromise(() => screen.findByRole("status"))
      expect(screen.getByRole("status").textContent).toContain("saved for this project")
      expect((screen.getByLabelText("API key") as HTMLInputElement).getAttribute("type")).toBe("password")
    })))
})
