// @vitest-environment happy-dom
import { it } from "@effect/vitest"
import { fireEvent, screen } from "@testing-library/react"
import { Effect, Stream } from "effect"
import { afterEach, describe, expect } from "vitest"
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router"
import type { ActionStep, Binding, Catalog, EditorSchema } from "@expand/contracts/automation"
import type { PreviewOutcome, RoutineRecord } from "@expand/contracts/rpc/automation-schemas"
import { createAppRouter } from "@expand/desktop/renderer/app/router"
import { startRendererRoot } from "@expand/desktop/renderer/app/runner"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { AutomationContextProvider } from "@expand/desktop/renderer/features/automations/data/automation-context"
import { ProjectContextProvider } from "@expand/desktop/renderer/features/projects/data/project-context"
import { RoutineEditor } from "@expand/desktop/renderer/features/automations/components/RoutineEditor"
import { PreviewResult } from "@expand/desktop/renderer/features/automations/components/RoutineTestPanel"
import type { AutomationRpcApi } from "@expand/desktop/renderer/rpc/automation-rpc"
import { fakeProject, makeFakeProjectContext, renderScoped, uid } from "./ui-harness"

const projectId = uid(1)
const scope = { ownerId: "local", projectId }

const renderEditor = (rpc: AutomationRpcApi, routineId: string | undefined) =>
  renderScoped(
    <RendererRunnerProvider value={{ start: startRendererRoot }}>
      <ProjectContextProvider value={makeFakeProjectContext([fakeProject({ id: projectId, name: "alpha" })], {}, rpc)}>
        <AutomationContextProvider value={rpc}>
          <RoutineEditor projectId={projectId} routineId={routineId} />
        </AutomationContextProvider>
      </ProjectContextProvider>
    </RendererRunnerProvider>
  )

const editorSchema = (properties?: { readonly [key: string]: EditorSchema["schema"] }) => ({
  dialect: "draft-2020-12" as const,
  schema: properties === undefined ? { type: "object" } : { type: "object", properties },
  definitions: {}
})

const issueBinding: Binding = { kind: "field", source: "trigger", path: ["issueNumber"] }

const labelStep = (category: string, label: string): ActionStep => ({
  id: `label-${category}`,
  action: { id: "github:label-issue", version: 1 },
  integration: { id: "github", definition: { id: "github:integration", version: 1 } },
  bindings: { issueNumber: issueBinding, label: { kind: "literal", value: label } }
})

const classificationProcess = (categories: ReadonlyArray<string>) => ({
  schemaVersion: 1 as const,
  kind: "process" as const,
  trigger: {
    definition: { id: "github:issue-opened", version: 1 },
    integration: { id: "github", definition: { id: "github:integration", version: 1 } },
    configuration: {}
  },
  decision: {
    kind: "jev" as const,
    provider: "opencode-zen" as const,
    model: "jev" as const,
    version: "1.13" as const,
    outcomes: [...categories]
  },
  actions: Object.fromEntries(categories.map((category) => [category, [labelStep(category, `type: ${category}`)]]))
})

const catalogStub: Catalog = {
  schemaVersion: 1,
  kind: "catalog",
  definitions: [
    {
      schemaVersion: 1,
      kind: "integration",
      definition: { id: "github:integration", version: 1 },
      title: "GitHub",
      capabilities: ["label"],
      configurationSchema: editorSchema()
    },
    {
      schemaVersion: 1,
      kind: "trigger",
      definition: { id: "github:issue-opened", version: 1 },
      title: "GitHub issue opened",
      integration: { id: "github:integration", version: 1 },
      configurationSchema: editorSchema(),
      payloadSchema: editorSchema()
    },
    {
      schemaVersion: 1,
      kind: "action",
      definition: { id: "github:label-issue", version: 1 },
      title: "GitHub label issue",
      integration: { id: "github:integration", version: 1 },
      capabilities: ["label"],
      argumentsSchema: editorSchema({ issueNumber: { type: "integer" }, label: { type: "string" } }),
      resultSchema: editorSchema()
    },
    {
      schemaVersion: 1,
      kind: "routine-template",
      definition: { id: "github:issue-classification", version: 1 },
      title: "GitHub issue classification",
      configurationSchema: editorSchema(),
      process: classificationProcess(["bug", "question"])
    }
  ]
}

const triageRecord: RoutineRecord = {
  routineId: "triage",
  head: { revision: 2, version: 3, status: "enabled" },
  configuration: {
    schemaVersion: 1,
    kind: "routine-configuration",
    reference: { routineId: "triage", revision: 2 },
    template: { id: "github:issue-classification", version: 1 },
    scope: { ...scope },
    configuration: {
      categories: ["bug"],
      labels: { bug: "type: bug" },
      notifications: { onMatch: true, onNoMatch: false }
    },
    integrations: [
      {
        schemaVersion: 1,
        kind: "integration-configuration",
        id: "github",
        definition: { id: "github:integration", version: 1 },
        configuration: { owner: "octo", repo: "hello" },
        credentials: {}
      }
    ],
    process: classificationProcess(["bug"])
  },
  credentials: []
}

const classifiedPreview: PreviewOutcome = {
  kind: "classified",
  request: {
    schemaVersion: 1,
    kind: "jev-request",
    provider: "opencode-zen",
    model: "jev",
    version: "1.13",
    configuration: { routineId: "triage", revision: 2 },
    input: { kind: "input-reference", id: "issue-42" },
    outcomes: ["bug", "question"],
    data: { issueNumber: 42, title: "Login fails on retry" }
  },
  decision: { schemaVersion: 1, kind: "selected", outcomeId: "bug", data: {} },
  latencyMs: 5,
  outcomeId: "bug",
  label: "type: bug",
  actions: [{ stepId: "label-bug", arguments: { issueNumber: 42, label: "type: bug" } }],
  executed: false
}

const unusedEffect = (label: string) => () => Effect.die(new Error(`${label} not stubbed`))

const automationRpc = (over: Partial<AutomationRpcApi>): AutomationRpcApi =>
  ({
    createRoutine: unusedEffect("createRoutine"),
    editRoutine: unusedEffect("editRoutine"),
    enableRoutine: unusedEffect("enableRoutine"),
    pauseRoutine: unusedEffect("pauseRoutine"),
    deleteRoutine: unusedEffect("deleteRoutine"),
    getRoutine: unusedEffect("getRoutine"),
    listRoutines: unusedEffect("listRoutines"),
    putIntegration: unusedEffect("putIntegration"),
    getIntegration: unusedEffect("getIntegration"),
    integrationStatus: unusedEffect("integrationStatus"),
    putCredential: unusedEffect("putCredential"),
    removeCredential: unusedEffect("removeCredential"),
    listCredentials: () =>
      Effect.succeed({ credentials: [{ credentialId: "github-token", version: 1, configured: true as const }] }),
    preview: unusedEffect("preview"),
    listRuns: unusedEffect("listRuns"),
    getRun: unusedEffect("getRun"),
    metrics: unusedEffect("metrics"),
    catalog: unusedEffect("catalog"),
    startRoutine: unusedEffect("startRoutine"),
    events: () => Stream.never,
    notificationList: unusedEffect("notificationList"),
    notificationMarkRead: unusedEffect("notificationMarkRead"),
    ...over
  }) as unknown as AutomationRpcApi

const catalogRpc = () => automationRpc({ catalog: () => Effect.succeed(catalogStub) })

describe("routine editor", () => {
  it.effect("renders the form from the catalog with exactly one trigger and no canvas", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderEditor(catalogRpc(), undefined)
      const trigger = yield* Effect.tryPromise(() => screen.findByLabelText("Trigger", { selector: "select" }))
      expect((trigger as HTMLSelectElement).tagName).toBe("SELECT")
      expect((trigger as HTMLSelectElement).hasAttribute("multiple")).toBe(false)
      yield* Effect.tryPromise(() =>
        screen.findByRole("option", { name: "GitHub issue opened (github:issue-opened v1)" }))
      yield* Effect.tryPromise(() => screen.findByRole("option", { name: "GitHub issue classification" }))
      expect(screen.getByText("No loops or branching", { exact: false })).toBeDefined()
      expect(screen.queryByText("drag-and-drop", { exact: false })).toBeNull()
      expect(screen.queryByText("canvas", { exact: false })).toBeNull()
    })))

  it.effect("names the failed field when the form is incomplete", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderEditor(catalogRpc(), undefined)
      yield* Effect.tryPromise(() => screen.findByLabelText("Routine id"))
      expect(screen.getByText("Enter a routine id.", { exact: false })).toBeDefined()
      expect(screen.getByText("Choose exactly one trigger", { exact: false })).toBeDefined()
    })))

  it.effect("loads categories from the backend template choice", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderEditor(catalogRpc(), undefined)
      yield* Effect.tryPromise(() => screen.findByLabelText("Start from a template"))
      fireEvent.change(screen.getByLabelText("Start from a template"), {
        target: { value: "github:issue-classification@1" }
      })
      fireEvent.change(screen.getByLabelText("Trigger", { selector: "select" }), {
        target: { value: "github:issue-opened@1" }
      })
      yield* Effect.tryPromise(() => screen.findByDisplayValue("question"))
    })))

  it.effect("creates the routine with a credential reference and names the revision", () =>
    Effect.scoped(Effect.gen(function* () {
      const seen: Array<unknown> = []
      const rpc = automationRpc({
        catalog: () => Effect.succeed(catalogStub),
        getRoutine: () => Effect.succeed(triageRecord),
        createRoutine: ((payload: unknown) => {
          seen.push(payload)
          return Effect.succeed({ revision: 1 })
        }) as AutomationRpcApi["createRoutine"]
      })
      yield* renderEditor(rpc, undefined)
      yield* Effect.tryPromise(() => screen.findByLabelText("Routine id"))
      fireEvent.change(screen.getByLabelText("Routine id"), { target: { value: "triage" } })
      fireEvent.change(screen.getByLabelText("Start from a template"), {
        target: { value: "github:issue-classification@1" }
      })
      fireEvent.change(screen.getByLabelText("Trigger", { selector: "select" }), {
        target: { value: "github:issue-opened@1" }
      })
      fireEvent.change(screen.getByLabelText("Repository owner"), { target: { value: "octo" } })
      fireEvent.change(screen.getByLabelText("Repository name"), { target: { value: "hello" } })
      fireEvent.click(screen.getByRole("button", { name: "Create routine" }))
      yield* Effect.tryPromise(() => screen.findByText("Created revision 1."))
      expect(seen.length).toBe(1)
      const payload = seen[0] as { readonly integrations: ReadonlyArray<{ readonly credentials: unknown }> }
      expect(payload.integrations[0]?.credentials).toMatchObject({ token: { credentialId: "github-token" } })
    })))

  it.effect("runs preview inline without creating or editing", () =>
    Effect.scoped(Effect.gen(function* () {
      let created = 0
      let edited = 0
      let previews = 0
      let inlineSeen: unknown = undefined
      const rpc = automationRpc({
        catalog: () => Effect.succeed(catalogStub),
        createRoutine: (() => {
          created += 1
          return Effect.succeed({ revision: 1 })
        }) as AutomationRpcApi["createRoutine"],
        editRoutine: (() => {
          edited += 1
          return Effect.succeed({ revision: 2 })
        }) as AutomationRpcApi["editRoutine"],
        preview: ((payload: { readonly inline: unknown }) => {
          previews += 1
          inlineSeen = payload.inline
          return Effect.succeed(classifiedPreview)
        }) as AutomationRpcApi["preview"]
      })
      yield* renderEditor(rpc, undefined)
      yield* Effect.tryPromise(() => screen.findByLabelText("Routine id"))
      fireEvent.change(screen.getByLabelText("Routine id"), { target: { value: "triage" } })
      fireEvent.change(screen.getByLabelText("Start from a template"), {
        target: { value: "github:issue-classification@1" }
      })
      fireEvent.change(screen.getByLabelText("Trigger", { selector: "select" }), {
        target: { value: "github:issue-opened@1" }
      })
      fireEvent.change(screen.getByLabelText("Repository owner"), { target: { value: "octo" } })
      fireEvent.change(screen.getByLabelText("Repository name"), { target: { value: "hello" } })
      fireEvent.click(screen.getAllByRole("button", { name: "Add action" })[0]!)
      fireEvent.click(screen.getByRole("button", { name: "Run preview" }))
      yield* Effect.tryPromise(() => screen.findByText("Proposed outcome: bug"))
      expect(screen.getByText("Preview only: not applied.")).toBeDefined()
      expect(previews).toBe(1)
      expect(created).toBe(0)
      expect(edited).toBe(0)
      expect(inlineSeen).toMatchObject({ routineId: "triage" })
    })))

  it.effect("loads the edit path from the stored routine", () =>
    Effect.scoped(Effect.gen(function* () {
      const rpc = automationRpc({
        catalog: () => Effect.succeed(catalogStub),
        getRoutine: () => Effect.succeed(triageRecord)
      })
      yield* renderEditor(rpc, "triage")
      yield* Effect.tryPromise(() => screen.findByDisplayValue("triage"))
      yield* Effect.tryPromise(() => screen.findByDisplayValue("octo"))
      expect(screen.getByRole("button", { name: "Save changes" })).toBeDefined()
    })))

  it.effect("redacts secret-like keys in preview arguments", () =>
    Effect.scoped(Effect.gen(function* () {
      const secretPreview: PreviewOutcome = {
        ...classifiedPreview,
        actions: [{ stepId: "label-bug", arguments: { label: "type: bug", token: "super-secret" } }]
      }
      yield* renderScoped(
        <RendererRunnerProvider value={{ start: startRendererRoot }}>
          <PreviewResult outcome={secretPreview} />
        </RendererRunnerProvider>
      )
      yield* Effect.tryPromise(() => screen.findByText("Proposed outcome: bug"))
      expect(document.body.textContent ?? "").toContain("[redacted]")
      expect(document.body.textContent ?? "").not.toContain("super-secret")
    })))

  it.effect("opens the setup, edit, and test routes", () =>
    Effect.scoped(Effect.gen(function* () {
      const context = makeFakeProjectContext([fakeProject({ id: projectId, name: "alpha" })])
      const rpc = automationRpc({
        catalog: () => Effect.succeed(catalogStub),
        getRoutine: () => Effect.succeed(triageRecord),
        listRoutines: () => Effect.succeed({ routines: [] }),
        listRuns: () => Effect.succeed({ runs: [], cursor: null }),
        metrics: () =>
          Effect.succeed({ total: 0, queued: 0, running: 0, succeeded: 0, unresolved: 0, failed: 0, cancelled: 0 })
      })
      const cases = [
        [`/p/${projectId}/automations/routines/new`, "Routine setup"],
        [`/p/${projectId}/automations/routines/triage`, "Edit routine"],
        [`/p/${projectId}/automations/routines/triage/test`, "Edit routine"]
      ] as const
      for (const [path, heading] of cases) {
        const history = createMemoryHistory({ initialEntries: [path] })
        const router = createAppRouter(history)
        yield* renderScoped(
          <RendererRunnerProvider value={{ start: startRendererRoot }}>
            <ProjectContextProvider value={context}>
              <AutomationContextProvider value={rpc}>
                <RouterProvider router={router} />
              </AutomationContextProvider>
            </ProjectContextProvider>
          </RendererRunnerProvider>
        )
        yield* Effect.tryPromise(() => screen.findByRole("heading", { name: heading }))
      }
    })))
})

describe("routine editor credential seam", () => {
  it.effect("disables the repository fields and links to settings when disconnected", () =>
    Effect.scoped(Effect.gen(function* () {
      const rpc = automationRpc({
        catalog: () => Effect.succeed(catalogStub),
        listCredentials: () => Effect.succeed({ credentials: [] })
      })
      yield* renderEditor(rpc, undefined)
      yield* Effect.tryPromise(() => screen.findByLabelText("Start from a template"))
      fireEvent.change(screen.getByLabelText("Start from a template"), {
        target: { value: "github:issue-classification@1" }
      })
      fireEvent.change(screen.getByLabelText("Trigger", { selector: "select" }), {
        target: { value: "github:issue-opened@1" }
      })
      const owner = yield* Effect.tryPromise(() => screen.findByLabelText("Repository owner"))
      expect((owner as HTMLInputElement).disabled).toBe(true)
      fireEvent.click(screen.getByRole("button", { name: "Open settings" }))
      expect(window.location.hash).toBe("#/settings")
    })))
})
