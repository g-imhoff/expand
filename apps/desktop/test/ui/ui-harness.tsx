import { type ReactElement, type ReactNode } from "react"
import { Effect, Schema, Stream } from "effect"
import { render } from "@testing-library/react"
import type { Project } from "@expand/contracts/project"
import { Project as ProjectClass } from "@expand/contracts/project"
import { ProjectContextProvider, type ProjectContextValue } from "@expand/desktop/renderer/features/projects/data/project-context"
import { makeProjectsStore } from "@expand/desktop/renderer/features/projects/data/project-store"
import type { ProjectRpcApi } from "@expand/desktop/renderer/rpc/project-rpc"

export const uid = (n: number): string => "00000000-0000-4000-8000-" + String(n).padStart(12, "0")

export const fakeProject = (over: FakeProjectOver = {}): Project =>
  Schema.decodeUnknownSync(ProjectClass)({
    id: over.id ?? uid(1),
    name: over.name ?? "alpha",
    directory: over.directory ?? null,
    description: over.description ?? null,
    tags: (over.tags ?? []) as Project["tags"],
    archived: over.archived ?? false,
    createdAt: over.createdAt ?? "t",
    updatedAt: over.updatedAt ?? "t"
  })

export const makeFakeProjectContext = (
  projects: ReadonlyArray<Project>,
  over: Partial<ProjectRpcApi> = {}
): ProjectContextValue => {
  const unused = (label: string) => () => Effect.die(new Error(`${label} not stubbed`))
  const store = makeProjectsStore()
  store.setState({ projects, seq: 0 })
  return {
    store,
    rpc: {
      create: unused("create") as ProjectRpcApi["create"],
      rename: unused("rename") as ProjectRpcApi["rename"],
      changeDirectory: unused("changeDirectory") as ProjectRpcApi["changeDirectory"],
      archive: unused("archive") as ProjectRpcApi["archive"],
      restore: unused("restore") as ProjectRpcApi["restore"],
      setMetadata: unused("setMetadata") as ProjectRpcApi["setMetadata"],
      delete: unused("delete") as ProjectRpcApi["delete"],
      list: () => Effect.succeed({ projects, seq: 0 }),
      status: Stream.never,
      events: () => Stream.never,
      ...over
    }
  }
}

export const renderScoped = Effect.fn("DesktopUiTest.renderScoped")((ui: ReactNode) =>
  ownRender(() => render(ui)))

export const renderWithProjectContextScoped = Effect.fn("DesktopUiTest.renderWithProjectContextScoped")((
  ui: ReactElement,
  value: ProjectContextValue
) => ownRender(() => render(
  <ProjectContextProvider value={value}>{ui}</ProjectContextProvider> as ReactNode
)))

interface FakeProjectOver {
  readonly id?: string
  readonly name?: string
  readonly directory?: string | null
  readonly description?: string | null
  readonly tags?: ReadonlyArray<string>
  readonly archived?: boolean
  readonly createdAt?: string
  readonly updatedAt?: string
}

const ownRender = (acquire: () => ReturnType<typeof render>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const rendered = acquire()
      const rawUnmount = rendered.unmount
      let released = false
      const release = () => {
        if (released) return
        released = true
        rawUnmount()
      }
      return { rendered: { ...rendered, unmount: release }, release }
    }),
    (owned) => Effect.sync(owned.release)
  ).pipe(Effect.map((owned) => owned.rendered))
