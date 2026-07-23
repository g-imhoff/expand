import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Data, Effect, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { BuildToolLive, buildBinaries } from "./build"

export class CertificationError extends Data.TaggedError("CertificationError")<{
  readonly exitCode: number
}> {}

export class CertificationProcessError extends Data.TaggedError("CertificationProcessError")<{
  readonly cause: unknown
}> {}

export const certifyCliBuild = Effect.fn("CertCliBuild.certify")(
  function*(root: string) {
    yield* buildBinaries(root)
    yield* Effect.scoped(Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.make("bash", ["scripts/binary-smoke.sh"], {
        cwd: root,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit"
      })).pipe(Effect.mapError((cause) => new CertificationProcessError({ cause })))
      const exitCode = yield* handle.exitCode.pipe(
        Effect.mapError((cause) => new CertificationProcessError({ cause }))
      )
      if (exitCode !== 0) {
        return yield* new CertificationError({ exitCode })
      }
    }))
  }
)

const program = Path.Path.pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../", import.meta.url))),
  Effect.flatMap(certifyCliBuild),
  Effect.provide(BuildToolLive),
  Effect.provide(NodeServices.layer)
)

if (import.meta.main) {
  NodeRuntime["runMain"](program)
}
