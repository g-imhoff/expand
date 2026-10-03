// @vitest-environment happy-dom
import type { ReactElement } from "react"
import { it } from "@effect/vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { Effect } from "effect"
import { afterEach, describe, expect, vi } from "vitest"
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router"
import type { ActionStep, Binding, Catalog, EditorSchema } from "@expand/contracts/automation"
import type { PreviewOutcome, RoutineRecord } from "@expand/contracts/rpc/automation-schemas"
import { createAppRouter } from "@expand/desktop/renderer/app/router"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { startRendererRoot } from "@expand/desktop/renderer/app/runner"
import { AutomationContextProvider } from "@expand/desktop/renderer/features/automations/data/automation-context"
import { ProjectContextProvider } from "@expand/desktop/renderer/features/projects/data/project-context"
import { RoutineEditor } from "@expand/desktop/renderer/features/automations/components/RoutineEditor"
import type { AutomationRpcApi } from "@expand/desktop/renderer/rpc/automation-rpc"
import { fakeProject, makeFakeProjectContext, renderScoped, uid } from "./ui-harness"

const projectId = uid(1)
const scope = { ownerId: "local", projectId }

afterEach(() => {
  cleanup()
})

const renderWithAutomation = (ui: ReactElement, rpc: AutomationRpcApi) =>
  renderScoped(
    <RendererRunnerProvider value={{ start: startRendererRoot }}>
      <AutomationContextProvider value={rpc}>
        {ui}
      </AutomationContextProvider>
    </RendererRunnerProvider>
  )

const editorSchema = (properties?: { readonly [key: string]: EditorSchema["schema"] }): EditorSchema => ({
  dialect: "draft-2020-12",
  schema: properties === undefined ? { type: "object" } : { type: "object", properties },
  definitions: {}
})

const issueBinding: Binding = { kind: "field", source: "trigger", path: ["issueNumber"] }

const labelBindingFor = (label: string): Binding => ({ kind: "literal", value: label })

const labelStep = (category: string, label: string): ActionStep => ({
  id: `label-${category}`,
  action: { id: "github:label-issue", version: 1 },
  integration: { id: "github", definition: { id: "github:integration", version: 1 } },
  bindings: { issueNumber: issueBinding, label: labelBindingFor(label) }
})

const classificationProcess = (categories: ReadonlyArray<string>) => ({
  schemaVersion: 1 as const,
  kind: "process" as const,
  trigger: {
    definition: { id: "github:issue-opened", version: 1 },
    integration: { id: "github", definition: { id: "github:integration", version: 1 } },
    configuration: {}
  },
  decision: { kind: "jev" as const, provider: "opencode-zen" as const, model: "jev" as const, version: "1.13" as const, outcomes: [...categories] },
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

const unresolvedPreview: PreviewOutcome = {
  kind: "unresolved",
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
  decision: { schemaVersion: 1, kind: "abstained", reason: "No candidate matched the input" },
  latencyMs: 4,
  reason: "No candidate matched the input",
  executed: false
}

const unusedEffect = (label: string) => () => Effect.die(new Error(`${label} not stubbed`))

const automationRpc = (over: Record<string, unknown>): AutomationRpcApi => ({
  routineCreate: unusedEffect("routineCreate"),
  routineEdit: unusedEffect("routineEdit"),
  routineEnable: unusedEffect("routineEnable"),
  routinePause: unusedEffect("routinePause"),
  routineDelete: unusedEffect("routineDelete"),
  routineGet: unusedEffect("routineGet"),
  routineList: unusedEffect("routineList"),
  integrationPut: unusedEffect("integrationPut"),
  integrationGet: unusedEffect("integrationGet"),
  integrationStatus: unusedEffect("integrationStatus"),
  credentialPut: unusedEffect("credentialPut"),
  credentialRemove: unusedEffect("credentialRemove"),
  credentialList: unusedEffect("credentialList"),
  previewClassification: unusedEffect("previewClassification"),
  runList: unusedEffect("runList"),
  runGet: unusedEffect("runGet"),
  runMetrics: unusedEffect("runMetrics"),
  notificationList: unusedEffect("notificationList"),
  notificationMarkRead: unusedEffect("notificationMarkRead"),
  catalog: unusedEffect("catalog"),
  events: unusedEffect("events"),
  ...over
}) as unknown as AutomationRpcApi

const catalogRpc = () => automationRpc({ catalog: () => Effect.succeed(catalogStub) })

const findTriggerSelect = () => Effect.tryPromise(() => screen.findByLabelText("Trigger", { selector: "select" }))

const fillNewRoutine = () => {
  fireEvent.change(screen.getByLabelText("Routine id"), { target: { value: "triage" } })
  fireEvent.change(screen.getByLabelText("Repository owner"), { target: { value: "octo" } })
  fireEvent.change(screen.getByLabelText("Repository name"), { target: { value: "hello" } })
}

const loadTemplate = () => {
  fireEvent.change(screen.getByLabelText("Start from a template"), {
    target: { value: "github:issue-classification@1" }
  })
}

describe("routine editor", () => {
  it.effect("renders the form from the catalog with exactly one trigger and no canvas", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderWithAutomation(<RoutineEditor projectId={projectId} routineId={undefined} />, catalogRpc())
      const trigger = yield* findTriggerSelect()
      expect(trigger.tagName).toBe("SELECT")
      expect(trigger.hasAttribute("multiple")).toBe(false)
      yield* Effect.tryPromise(() => screen.findByRole("option", { name: "GitHub issue opened (github:issue-opened v1)" }))
      yield* Effect.tryPromise(() => screen.findByRole("option", { name: "GitHub issue classification" }))
      expect(screen.getByText("No loops or branching", { exact: false })).toBeDefined()
      expect(screen.queryByText("drag-and-drop", { exact: false })).toBeNull()
      expect(screen.queryByText("canvas", { exact: false })).toBeNull()
    })))

  it.effect("shows a loading state while the catalog is pending", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderWithAutomation(
        <RoutineEditor projectId={projectId} routineId={undefined} />,
        automationRpc({ catalog: () => Effect.never })
      )
      yield* Effect.tryPromise(() => screen.findByText("Loading routine editor…"))
    })))

  it.effect("recovers from catalog errors through retry", () =>
    Effect.scoped(Effect.gen(function* () {
      let calls = 0
      yield* renderWithAutomation(
        <RoutineEditor projectId={projectId} routineId={undefined} />,
        automationRpc({
          catalog: () => {
            calls += 1
            return calls === 1
              ? Effect.fail({ _tag: "RpcClientError", message: "backend is down" })
              : Effect.succeed(catalogStub)
          }
        })
      )
      const alert = yield* Effect.tryPromise(() => screen.findByRole("alert"))
      expect(alert.textContent).toContain("backend is down")
      fireEvent.click(screen.getByRole("button", { name: "Retry" }))
      yield* Effect.tryPromise(() => screen.findByLabelText("Trigger", { selector: "select" }))
      expect(calls).toBe(2)
    })))

  it.effect("loads a template as an editable starting point and creates the routine", () =>
    Effect.scoped(Effect.gen(function* () {
      const seen: Array<{ readonly method: string; readonly payload: unknown }> = []
      yield* renderWithAutomation(
        <RoutineEditor projectId={projectId} routineId={undefined} />,
        automationRpc({
          catalog: () => Effect.succeed(catalogStub),
          routineCreate: (payload: unknown) => {
            seen.push({ method: "routineCreate", payload })
            return Effect.succeed({ revision: 1 })
          },
          routineGet: () => Effect.succeed(triageRecord)
        })
      )
      yield* Effect.tryPromise(() => screen.findByLabelText("Trigger", { selector: "select" }))
      loadTemplate()
      const names = yield* Effect.tryPromise(() => screen.findAllByLabelText("Category name"))
      expect(names.map((entry) => (entry as HTMLInputElement).value)).toEqual(["bug", "question"])
      const labels = yield* Effect.tryPromise(() => screen.findAllByLabelText("Label"))
      expect(labels.map((entry) => (entry as HTMLInputElement).value)).toEqual(["type: bug", "type: question"])
      fireEvent.change(labels[1]!, { target: { value: "type: inquiry" } })
      fillNewRoutine()
      fireEvent.click(screen.getByRole("button", { name: "Create routine" }))
      yield* Effect.tryPromise(() => screen.findByText("Created revision 1."))
      expect(seen).toHaveLength(1)
      const payload = seen[0]?.payload as Record<string, unknown>
      expect(payload).toMatchObject({
        scope,
        routineId: "triage",
        template: { id: "github:issue-classification", version: 1 }
      })
      const configuration = payload["configuration"] as Record<string, unknown>
      expect(configuration["categories"]).toEqual(["bug", "question"])
      expect(configuration["labels"]).toEqual({ bug: "type: bug", question: "type: inquiry" })
      const process = payload["process"] as Record<string, unknown>
      expect(process["trigger"]).toMatchObject({ definition: { id: "github:issue-opened", version: 1 } })
      const decision = process["decision"] as Record<string, unknown>
      expect(decision["outcomes"]).toEqual(["bug", "question"])
      const actions = process["actions"] as Record<string, Array<Record<string, unknown>>>
      expect(Object.keys(actions).sort()).toEqual(["bug", "question"])
      const questionStep = actions["question"]?.[0]
      expect(questionStep?.["action"]).toEqual({ id: "github:label-issue", version: 1 })
      expect(questionStep?.["integration"]).toMatchObject({ id: "github" })
      const bindings = questionStep?.["bindings"] as Record<string, unknown>
      expect(bindings["issueNumber"]).toEqual({ kind: "field", source: "trigger", path: ["issueNumber"] })
      expect(bindings["label"]).toEqual({ kind: "literal", value: "type: inquiry" })
      const integrations = payload["integrations"] as Array<Record<string, unknown>>
      expect(integrations[0]).toMatchObject({
        id: "github",
        definition: { id: "github:integration", version: 1 },
        configuration: { owner: "octo", repo: "hello" },
        credentials: {}
      })
    })))

  it.effect("edits an existing routine and toggles pause and enable", () =>
    Effect.scoped(Effect.gen(function* () {
      const seen: Array<{ readonly method: string; readonly payload: unknown }> = []
      const track = (method: string) => (payload: unknown) => {
        seen.push({ method, payload })
        return method === "routineGet"
          ? Effect.succeed(triageRecord)
          : method === "routineEdit"
            ? Effect.succeed({ revision: 3 })
            : method === "routinePause"
              ? Effect.succeed({ revision: 2, version: 4, status: "paused" })
              : Effect.succeed({ revision: 2, version: 5, status: "enabled" })
      }
      yield* renderWithAutomation(
        <RoutineEditor projectId={projectId} routineId="triage" />,
        automationRpc({
          catalog: () => Effect.succeed(catalogStub),
          routineGet: track("routineGet"),
          routineEdit: track("routineEdit"),
          routinePause: track("routinePause"),
          routineEnable: track("routineEnable")
        })
      )
      yield* Effect.tryPromise(() => screen.findByText("Status: enabled (revision 2)"))
      const routineId = screen.getByLabelText("Routine id") as HTMLInputElement
      expect(routineId.value).toBe("triage")
      expect(routineId.disabled).toBe(true)
      expect((screen.getByLabelText("Repository owner") as HTMLInputElement).value).toBe("octo")
      expect(seen[0]).toMatchObject({ method: "routineGet", payload: { scope, routineId: "triage" } })
      fireEvent.change(screen.getByLabelText("Label"), { target: { value: "type: defect" } })
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
      yield* Effect.tryPromise(() => screen.findByText("Saved revision 3."))
      const edit = seen.find((entry) => entry.method === "routineEdit")
      expect(edit?.payload).toMatchObject({ scope, routineId: "triage" })
      const editConfiguration = (edit?.payload as Record<string, unknown>)["configuration"] as Record<string, unknown>
      expect(editConfiguration["labels"]).toEqual({ bug: "type: defect" })
      fireEvent.click(screen.getByRole("button", { name: "Pause" }))
      yield* Effect.tryPromise(() => screen.findByText("Status: paused (revision 2)"))
      expect(seen.find((entry) => entry.method === "routinePause")).toMatchObject({
        payload: { scope, routineId: "triage", expectedVersion: 3 }
      })
      fireEvent.click(screen.getByRole("button", { name: "Enable" }))
      yield* Effect.tryPromise(() => screen.findByText("Status: enabled (revision 2)"))
      expect(seen.find((entry) => entry.method === "routineEnable")).toMatchObject({
        payload: { scope, routineId: "triage", expectedVersion: 4 }
      })
    })))

  it.effect("previews proposed actions without mutating routines", () =>
    Effect.scoped(Effect.gen(function* () {
      const seen: Array<{ readonly method: string; readonly payload: unknown }> = []
      const mutationSpy = vi.fn(() => Effect.die("mutation must not run during preview"))
      const guards = {
        routineCreate: mutationSpy,
        routineEdit: mutationSpy,
        routineEnable: mutationSpy,
        routinePause: mutationSpy
      }
      yield* renderWithAutomation(
        <RoutineEditor projectId={projectId} routineId={undefined} />,
        automationRpc({
          ...guards,
          catalog: () => Effect.succeed(catalogStub),
          routineGet: () => Effect.succeed(triageRecord),
          previewClassification: (payload: unknown) => {
            seen.push({ method: "previewClassification", payload })
            return Effect.succeed(classifiedPreview)
          }
        })
      )
      yield* Effect.tryPromise(() => screen.findByLabelText("Trigger", { selector: "select" }))
      loadTemplate()
      yield* Effect.tryPromise(() => screen.findAllByLabelText("Category name"))
      fillNewRoutine()
      fireEvent.click(screen.getByRole("button", { name: "Run preview" }))
      yield* Effect.tryPromise(() => screen.findByText("Proposed outcome: bug", { exact: false }))
      expect(seen).toHaveLength(1)
      const payload = seen[0]?.payload as Record<string, unknown>
      expect(payload).toMatchObject({ scope })
      expect(payload["routineId"]).toBeUndefined()
      const inline = payload["inline"] as Record<string, unknown>
      expect(inline["routineId"]).toBe("triage")
      const inlineProcess = inline["process"] as Record<string, unknown>
      expect((inlineProcess["decision"] as Record<string, unknown>)["outcomes"]).toEqual(["bug", "question"])
      expect(payload["issue"]).toEqual({ issueNumber: 42, title: "Login fails on retry" })
      expect(payload["decision"]).toEqual({ schemaVersion: 1, kind: "selected", outcomeId: "bug", data: {} })
      expect(screen.getByText("Proposed label: type: bug", { exact: false })).toBeDefined()
      expect(screen.getByText("Preview only: not applied.")).toBeDefined()
      const proposed = screen.getByRole("list", { name: "Proposed actions" })
      expect(within(proposed).getByText("label-bug")).toBeDefined()
      expect(proposed.textContent ?? "").toContain("type: bug")
      expect(mutationSpy).not.toHaveBeenCalled()
    })))

  it.effect("shows unresolved previews with the nothing-changed state", () =>
    Effect.scoped(Effect.gen(function* () {
      yield* renderWithAutomation(
        <RoutineEditor projectId={projectId} routineId={undefined} />,
        automationRpc({
          catalog: () => Effect.succeed(catalogStub),
          routineGet: () => Effect.succeed(triageRecord),
          previewClassification: () => Effect.succeed(unresolvedPreview)
        })
      )
      yield* Effect.tryPromise(() => screen.findByLabelText("Trigger", { selector: "select" }))
      loadTemplate()
      yield* Effect.tryPromise(() => screen.findAllByLabelText("Category name"))
      fillNewRoutine()
      fireEvent.change(screen.getByLabelText("Simulated Jev decision"), { target: { value: "abstain" } })
      fireEvent.click(screen.getByRole("button", { name: "Run preview" }))
      yield* Effect.tryPromise(() => screen.findByText("No action proposed:", { exact: false }))
      expect(screen.getByText("No candidate matched the input", { exact: false })).toBeDefined()
      expect(screen.getByText("Preview only: nothing changed.")).toBeDefined()
    })))

  it.effect("never touches credentials and shows no secrets", () =>
    Effect.scoped(Effect.gen(function* () {
      const credentialSpy = vi.fn(() => Effect.die("unused"))
      yield* renderWithAutomation(
        <RoutineEditor projectId={projectId} routineId={undefined} />,
        automationRpc({
          catalog: () => Effect.succeed(catalogStub),
          routineGet: () => Effect.succeed(triageRecord),
          credentialList: credentialSpy,
          credentialPut: credentialSpy,
          credentialRemove: credentialSpy,
          routineCreate: () => Effect.succeed({ revision: 1 }),
          previewClassification: () => Effect.succeed(classifiedPreview)
        })
      )
      yield* Effect.tryPromise(() => screen.findByLabelText("Trigger", { selector: "select" }))
      loadTemplate()
      yield* Effect.tryPromise(() => screen.findAllByLabelText("Category name"))
      fillNewRoutine()
      fireEvent.click(screen.getByRole("button", { name: "Create routine" }))
      yield* Effect.tryPromise(() => screen.findByText("Created revision 1."))
      fireEvent.click(screen.getByRole("button", { name: "Run preview" }))
      yield* Effect.tryPromise(() => screen.findByText("Proposed outcome: bug", { exact: false }))
      expect(credentialSpy).not.toHaveBeenCalled()
      const passwords = document.body.querySelectorAll('input[type="password"]')
      expect(passwords.length).toBe(0)
      expect(document.body.textContent ?? "").not.toMatch(/secret|token|password/i)
    })))

  it.effect("blocks saving until the form names a routine and a trigger", () =>
    Effect.scoped(Effect.gen(function* () {
      const created = vi.fn(() => Effect.succeed({ revision: 1 }))
      yield* renderWithAutomation(
        <RoutineEditor projectId={projectId} routineId={undefined} />,
        automationRpc({ catalog: () => Effect.succeed(catalogStub), routineCreate: created })
      )
      yield* Effect.tryPromise(() => screen.findByLabelText("Trigger", { selector: "select" }))
      const save = screen.getByRole("button", { name: "Create routine" }) as HTMLButtonElement
      expect(save.disabled).toBe(true)
      expect(screen.getByText("Enter a routine id.")).toBeDefined()
      expect(screen.getByText("Choose exactly one trigger from the catalog.")).toBeDefined()
      expect(created).not.toHaveBeenCalled()
    })))
})

describe("routine setup routes", () => {
  it.effect("opens the editor at the re-test path with a routine id", () =>
    Effect.scoped(Effect.gen(function* () {
      const seen: Array<unknown> = []
      const rpc = automationRpc({
        catalog: () => Effect.succeed(catalogStub),
        routineGet: (payload: unknown) => {
          seen.push(payload)
          return Effect.succeed(triageRecord)
        },
        routineList: () => Effect.succeed({ routines: [] }),
        runList: () => Effect.succeed({ runs: [], cursor: null }),
        runMetrics: () =>
          Effect.succeed({ total: 0, queued: 0, running: 0, succeeded: 0, unresolved: 0, failed: 0, cancelled: 0 })
      })
      const context = makeFakeProjectContext([fakeProject({ id: projectId, name: "alpha-project" })])
      const history = createMemoryHistory({ initialEntries: [`/p/${projectId}/automations/routines/triage/test`] })
      const router = createAppRouter(history)
      render(
        <RendererRunnerProvider value={{ start: startRendererRoot }}>
          <ProjectContextProvider value={context}>
            <AutomationContextProvider value={rpc}>
              <RouterProvider router={router} />
            </AutomationContextProvider>
          </ProjectContextProvider>
        </RendererRunnerProvider>
      )
      yield* Effect.tryPromise(() => screen.findByRole("heading", { name: "Edit routine" }))
      yield* Effect.tryPromise(() => screen.findByText("Status: enabled (revision 2)"))
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ scope, routineId: "triage" })
      const navigation = screen.getByRole("navigation", { name: "Automation pages" })
      expect(within(navigation).getByRole("button", { name: "Routine setup" }).getAttribute("aria-current")).toBe("page")
    })))
})
