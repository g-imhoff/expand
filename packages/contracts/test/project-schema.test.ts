import { it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { describe, expect } from "vitest"
import { Project } from "@expand/contracts/project"

const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const valid = {
  id: uid(1),
  name: "my-app",
  directory: null,
  description: null,
  tags: [],
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
}

const decode = (props: Record<string, unknown>) =>
  Schema.decodeUnknownEffect(Project)({ ...valid, ...props })

describe("Project schema", () => {
  it.effect("decodes a well-formed project and brands its fields", () =>
    Schema.decodeUnknownEffect(Project)(valid).pipe(
      Effect.tap((project) => Effect.sync(() => {
        expect(project.id).toBe(uid(1))
        expect(project.name).toBe("my-app")
      }))
    ))

  it.effect("rejects an invalid id on decode", () =>
    decode({ id: "p1" }).pipe(
      Effect.result,
      Effect.tap((result) => Effect.sync(() => expect(Result.isFailure(result)).toBe(true)))
    ))

  it.effect("rejects a project missing a required field", () =>
    Schema.decodeUnknownEffect(Project)({ id: uid(1) }).pipe(
      Effect.result,
      Effect.tap((result) => Effect.sync(() => expect(Result.isFailure(result)).toBe(true)))
    ))

  it.effect("decodes a legacy project (no new fields) filling defaults", () =>
    Schema.decodeUnknownEffect(Project)({
      id: uid(1),
      name: "first",
      createdAt: "2026-01-01T00:00:00.000Z"
    }).pipe(
      Effect.tap((project) => Effect.sync(() => {
        expect(project.directory).toBeNull()
        expect(project.description).toBeNull()
        expect(project.tags).toEqual([])
        expect(project.archived).toBe(false)
      }))
    ))
})

describe("Project field validation (enforced by construction)", () => {
  it.effect("accepts kebab names and rejects spaces/uppercase/empty", () =>
    Effect.gen(function*() {
      expect((yield* decode({ name: "my-app" })).name).toBe("my-app")
      expect(Result.isFailure(yield* decode({ name: "My App" }).pipe(Effect.result))).toBe(true)
      expect(Result.isFailure(yield* decode({ name: "" }).pipe(Effect.result))).toBe(true)
    }))

  it.effect("validates each tag", () =>
    Effect.gen(function*() {
      expect((yield* decode({ tags: ["web", "api"] })).tags).toEqual(["web", "api"])
      expect(Result.isFailure(yield* decode({ tags: ["Bad Tag"] }).pipe(Effect.result))).toBe(true)
    }))

  it.effect("enforces the description length cap and accepts null", () =>
    Effect.gen(function*() {
      expect((yield* decode({ description: null })).description).toBeNull()
      expect((yield* decode({ description: "ok" })).description).toBe("ok")
      expect(Result.isFailure(
        yield* decode({ description: "x".repeat(2049) }).pipe(Effect.result)
      )).toBe(true)
    }))
})
