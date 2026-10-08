import { fileURLToPath } from "node:url"
import { Cause, Clock, Console, Effect, Exit, Fiber, FileSystem, Schema } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { AcpTransportError, runAcpPrompt } from "../../automation/acp-transport.js"

const [mode, directory] = process.argv.slice(2)
if (!directory) throw new Error("Missing fixture directory")
const closedFile = `${directory}/stdin.closed`
const stubPath = fileURLToPath(new URL("./automation-acp-closed-stdin-stub.mjs", import.meta.url))
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const program = Effect.gen(function*() {
  const session = runAcpPrompt({
    command: process.execPath,
    args: [stubPath, mode ?? "prompt"],
    cwd: directory,
    env: { ACP_PID_FILE: `${directory}/agent.pid`, ACP_STDIN_CLOSED_FILE: closedFile }
  }, { prompt: "hello", timeoutMs: 5000 })
  if (mode === "cancel") {
    const fs = yield* FileSystem.FileSystem
    const fiber = yield* session.pipe(Effect.forkChild)
    const deadline = (yield* Clock.currentTimeMillis) + 5000
    while (!(yield* fs.exists(closedFile))) {
      if ((yield* Clock.currentTimeMillis) >= deadline) return yield* Effect.fail("ACP child did not close stdin")
      yield* Effect.sleep("10 millis")
    }
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.join(fiber).pipe(Effect.exit)
    yield* Console.log(encode({ interrupted: Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) }))
    return
  }
  const exit = yield* session.pipe(Effect.exit)
  const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null
  if (!(failure instanceof AcpTransportError)) return yield* Effect.fail("ACP child did not return a transport failure")
  yield* Console.log(encode({ _tag: failure._tag, code: failure.code, message: failure.message, transcript: failure.transcript, durationMs: failure.durationMs }))
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
