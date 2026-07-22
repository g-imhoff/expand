// @vitest-environment happy-dom
import { useEffect, useState } from "react"
import { act } from "@testing-library/react"
import { it as effectIt } from "@effect/vitest"
import { Effect, Exit, Scope } from "effect"
import { describe, expect, vi } from "vitest"
import type { Project } from "@expand/contracts/project"
import { startRendererRoot, type RendererRunner } from "@expand/desktop/renderer/app/runner"
import { RendererRunnerProvider } from "@expand/desktop/renderer/app/runner-context"
import { ProjectsView } from "@expand/desktop/renderer/features/projects/pages/ProjectsView"
import {
  fakeProject,
  makeFakeProjectContext,
  renderWithProjectContextScoped,
  uid
} from "./_harness"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>
}))

const runner: RendererRunner = { start: startRendererRoot }

const renderView = (projects: ReadonlyArray<Project>) =>
  renderWithProjectContextScoped(
    <RendererRunnerProvider value={runner}>
      <ProjectsView />
    </RendererRunnerProvider>,
    makeFakeProjectContext(projects)
  )

describe("ProjectsView — default index view hides archived", () => {
  effectIt.effect("excludes an archived project from the list and the header count", () =>
    Effect.scoped(Effect.gen(function* () {
      const { getByTestId, getByText } = yield* renderView([
        fakeProject({ id: uid(1), name: "live-project", archived: false }),
        fakeProject({ id: uid(2), name: "archived-project", archived: true })
      ])

      const list = getByTestId("project-list")
      expect(list.textContent).toContain("live-project")
      expect(list.textContent).not.toContain("archived-project")
      expect(getByText(/Projects \(1\)/)).toBeTruthy()
    })))

  effectIt.effect("does not release the desktop UI root again after explicit unmount", () =>
    Effect.gen(function* () {
      let cleanupCount = 0
      const scope = yield* Scope.make()
      const Probe = () => {
        useEffect(() => () => { cleanupCount += 1 }, [])
        return null
      }
      const rendered = yield* renderWithProjectContextScoped(
        <Probe />,
        makeFakeProjectContext([])
      ).pipe(Scope.provide(scope))
      const unmount = vi.spyOn(rendered, "unmount")

      rendered.unmount()
      yield* Scope.close(scope, Exit.void)

      expect(unmount).toHaveBeenCalledTimes(1)
      expect(cleanupCount).toBe(1)
    }))

  effectIt.effect("releases the desktop UI root after an assertion effect fails", () =>
    Effect.gen(function* () {
      let cleanupCount = 0
      let retainedUpdate: (() => void) | undefined
      let container: HTMLElement | undefined
      const Probe = () => {
        const [value, setValue] = useState(0)
        useEffect(() => {
          retainedUpdate = () => setValue((current) => current + 1)
          return () => { cleanupCount += 1 }
        }, [])
        return <span>{value}</span>
      }
      const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
        const rendered = yield* renderWithProjectContextScoped(<Probe />, makeFakeProjectContext([]))
        container = rendered.container
        expect(container.textContent).toBe("0")
        return yield* Effect.fail("expected assertion failure")
      })))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(cleanupCount).toBe(1)
      act(() => { retainedUpdate?.() })
      expect(container?.textContent).toBe("")
    }))
})
