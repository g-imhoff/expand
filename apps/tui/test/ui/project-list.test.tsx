import { it } from "@effect/vitest"
import { describe, expect } from "vitest"
import { Effect } from "effect"
import { ProjectList } from "@expand/tui/components/project-list"
import { type Project } from "@expand/contracts/project"
import { renderInkScoped } from "./_runtime-harness"

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as string

describe("ProjectList", () => {
  it.effect("shows an empty hint when there are no projects", () =>
    Effect.scoped(Effect.gen(function* () {
      const view = yield* renderInkScoped(<ProjectList projects={[]} focused={true} />)
      expect(view.lastFrame()).toContain("Projects (0)")
      expect(view.lastFrame()).toContain("press n to create one")
    })))

  it.effect("renders project names and count", () =>
    Effect.scoped(Effect.gen(function* () {
      const projects: ReadonlyArray<Project> = [
        { id: uid(1), name: "alpha" as string, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" } as unknown as Project,
        { id: uid(2), name: "beta" as string, directory: null, description: null, tags: [], archived: false, createdAt: "t", updatedAt: "t" } as unknown as Project
      ]
      const view = yield* renderInkScoped(<ProjectList projects={projects} focused={true} />)
      expect(view.lastFrame()).toContain("Projects (2)")
      expect(view.lastFrame()).toContain("alpha")
      expect(view.lastFrame()).toContain("beta")
    })))
})
