import { Context, Effect, Layer } from "effect"

export class ServerUseCases extends Context.Service<ServerUseCases, {
  readonly health: Effect.Effect<string>
}>()("expand/ServerUseCases", {
  make: Effect.succeed({
    health: Effect.succeed("ok")
  } as const)
}) {}

export const ServerUseCasesLayer = Layer.effect(ServerUseCases, ServerUseCases.make)
