// @vitest-environment happy-dom
import { act, render, renderHook, screen, waitFor } from "@testing-library/react"
import { it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { flushSync } from "react-dom"
import { describe, expect } from "vitest"
import { Project } from "@expand/contracts/project"
import { ProjectAlreadyExists } from "@expand/contracts/rpc"
import { startRendererRoot, type RendererRunner } from "@expand/desktop/renderer/app/runner"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
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

const runner: RendererRunner = {
  start: <A, E,>(
    _effect: Effect.Effect<A, E>,
    onExit: (exit: Exit.Exit<A, E>) => void
  ) => {
    onExit(Exit.succeed(alpha as A))
    return () => {}
  }
}

const ProjectNames = () => (
  <>{useProjectSelector((state) => state.projects).map((project) => project.name).join(", ")}</>
)

const ownRender = <A extends { readonly unmount: () => void }>(acquire: () => A) =>
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

describe("ProjectContextProvider", () => {
  it.effect("updates selector consumers without an AppHandle mirror", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = makeProjectsStore()
      yield* ownRender(() => render(
        <ProjectContextProvider value={{ store, rpc }}>
          <ProjectNames />
        </ProjectContextProvider>
      ))
      yield* makeProjectSyncSink(store).snapshot({ projects: [alpha], seq: 1 })
      yield* Effect.sync(() => flushSync(() => {}))
      expect(screen.getByText("alpha")).toBeDefined()
    })))

  it.live("runs mutations through RPC without updating the store optimistically", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = makeProjectsStore()
      let payload: { readonly name: string; readonly ensure: boolean } | undefined
      const mutationRpc = {
        create: (input: { readonly name: string; readonly ensure: boolean }) => {
          payload = input
          return Effect.succeed({ created: true, project: alpha })
        }
      } as unknown as ProjectRpcApi
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RendererRunnerProvider value={runner}>
          <ProjectContextProvider value={{ store, rpc: mutationRpc }}>{children}</ProjectContextProvider>
        </RendererRunnerProvider>
      )
      const { result } = yield* ownRender(() => renderHook(useCreateProject, { wrapper }))
      yield* Effect.sync(() => result.current.mutate("alpha"))
      expect(payload).toEqual({ name: "alpha", ensure: true })
      expect(store.getState().projects).toEqual([])
    })))

  it.live("publishes duplicate-create failures as typed mutation errors", () =>
    Effect.scoped(Effect.gen(function* () {
      const store = makeProjectsStore()
      const duplicate = new ProjectAlreadyExists({ name: "alpha" })
      const mutationRpc = {
        create: () => Effect.fail(duplicate)
      } as unknown as ProjectRpcApi
      const ownedRunner: RendererRunner = { start: startRendererRoot }
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <RendererRunnerProvider value={ownedRunner}>
          <ProjectContextProvider value={{ store, rpc: mutationRpc }}>{children}</ProjectContextProvider>
        </RendererRunnerProvider>
      )
      const { result } = yield* ownRender(() => renderHook(useCreateProject, { wrapper }))
      let callbackError: unknown

      yield* Effect.sync(() => act(() => {
        result.current.mutate("alpha", { onError: (error) => { callbackError = error } })
      }))
      yield* Effect.tryPromise(() => waitFor(() => {
        expect(result.current.error).toBe(duplicate)
        expect(callbackError).toBe(duplicate)
      }))
    })))
})
