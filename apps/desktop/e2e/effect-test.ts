import { test } from "@playwright/test"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path, type Scope } from "effect"

export interface EffectTestInfo {
  readonly signal?: AbortSignal
}

export interface EffectTestRegistration {
  (name: string, body: (_fixtures: object, testInfo: EffectTestInfo) => unknown): void
}

export type EffectTest = <E>(
  name: string,
  body: Effect.Effect<void, E, FileSystem.FileSystem | Path.Path | Scope.Scope>
) => void

export const makeTestEffect = (
  register: EffectTestRegistration,
  runPromise: typeof Effect["runPromise"] = Effect["runPromise"]
): EffectTest =>
  (name, body) => {
    register(name, ({}, testInfo) =>
      runPromise(Effect.scoped(body).pipe(Effect.provide(NodeServices.layer)), { signal: testInfo.signal })
    )
  }

export const testEffect = makeTestEffect(test as unknown as EffectTestRegistration)
