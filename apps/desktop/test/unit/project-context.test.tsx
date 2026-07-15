// @vitest-environment happy-dom
import { render, renderHook, screen } from "@testing-library/react"
import { it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { flushSync } from "react-dom"
import { describe, expect } from "vitest"
import { Project } from "@expand/contracts/project"
import { ProjectContextProvider, useProjectSelector } from "@expand/desktop/renderer/features/projects/data/project-context"
import { makeProjectSyncSink, makeProjectsStore } from "@expand/desktop/renderer/features/projects/data/project-store"
import { useCreateProject } from "@expand/desktop/renderer/features/projects/data/use-projects"
import type { ProjectRpcApi } from "@expand/desktop/renderer/rpc/project-rpc"

const alpha = Schema.decodeUnknownSync(Project)({
  id: "00000000-0000-4000-8000-000000000001",
  name: "alpha",
  directory: null,
  description: null,
  tags: [],
  archived: false,
  createdAt: "t",
  updatedAt: "t"
})

const rpc = {} as ProjectRpcApi

const ProjectNames = () => (
  <>{useProjectSelector((state) => state.projects).map((project) => project.name).join(", ")}</>
)

describe("ProjectContextProvider", () => {
  it.effect("updates selector consumers without an AppHandle mirror", () =>
    Effect.gen(function* () {
      const store = makeProjectsStore()
      render(
        <ProjectContextProvider value={{ store, rpc }}>
          <ProjectNames />
        </ProjectContextProvider>
      )
      yield* makeProjectSyncSink(store).snapshot({ projects: [alpha], seq: 1 })
      yield* Effect.sync(() => flushSync(() => {}))
      expect(screen.getByText("alpha")).toBeDefined()
    }))

  it.live("runs mutations through RPC without updating the store optimistically", () =>
    Effect.gen(function* () {
      const store = makeProjectsStore()
      let payload: { readonly name: string; readonly ensure: boolean } | undefined
      const mutationRpc = {
        create: (input: { readonly name: string; readonly ensure: boolean }) =>
          Effect.sync(() => {
            payload = input
            return { created: true, project: alpha }
          })
      } as unknown as ProjectRpcApi
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <ProjectContextProvider value={{ store, rpc: mutationRpc }}>{children}</ProjectContextProvider>
      )
      const { result } = renderHook(useCreateProject, { wrapper })
      yield* Effect.promise(() => result.current.mutateAsync("alpha"))
      expect(payload).toEqual({ name: "alpha", ensure: true })
      expect(store.getState().projects).toEqual([])
    }))
})
