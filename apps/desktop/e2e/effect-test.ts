import {
  test,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
  type TestInfo
} from "@playwright/test"
import { NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Path, type Scope } from "effect"

export interface EffectTestRegistration {
  (name: string, body: (fixtures: PlaywrightFixtures, testInfo: TestInfo) => unknown): void
}

export type PlaywrightFixtures = PlaywrightTestArgs & PlaywrightTestOptions & PlaywrightWorkerArgs & PlaywrightWorkerOptions
export type EffectTestFixtures = Record<string, never>

export type EffectTest = <E>(
  name: string,
  body: (
    fixtures: EffectTestFixtures,
    testInfo: TestInfo
  ) => Effect.Effect<void, E, FileSystem.FileSystem | Path.Path | Scope.Scope>
) => void

export const makeTestEffect = (
  register: EffectTestRegistration,
  runPromise: typeof Effect["runPromise"] = Effect["runPromise"]
): EffectTest =>
  (name, body) => {
    register(name, ({}, testInfo) => {
      const fixtures: EffectTestFixtures = {}
      const effect = Effect.scoped(body(fixtures, testInfo)).pipe(Effect.provide(NodeServices.layer))
      const timeout = testInfo.timeout
      const bounded = timeout <= 0
        ? effect
        : effect.pipe(Effect.timeout(Math.max(1, Math.floor(timeout - Math.min(250, timeout * 0.1)))))
      return runPromise(bounded)
    })
  }

export const testEffect = makeTestEffect(test)
