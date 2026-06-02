import { Cause, Console, Effect, Layer, Runtime } from "effect"
import { CliOutput, Command } from "effect/unstable/cli"
import { BunServices } from "@effect/platform-bun"
import { YodeaClient, type YodeaClientApi } from "@yodea/client-core"
import { jsonCliErrorFormatter } from "@yodea/cli/errors"
import { renderErrors } from "@yodea/cli/run"

export interface CliResult { readonly stdout: ReadonlyArray<string>; readonly stderr: ReadonlyArray<string>; readonly code: number }

const capturingConsole = (stdout: string[], stderr: string[]): Console.Console => ({
  log: (...a: unknown[]) => { stdout.push(a.map(String).join(" ")) },
  error: (...a: unknown[]) => { stderr.push(a.map(String).join(" ")) },
  warn: (...a: unknown[]) => { stderr.push(a.map(String).join(" ")) },
  info: (...a: unknown[]) => { stdout.push(a.map(String).join(" ")) },
  debug: () => {}, clear: () => {}, assert: () => {}, count: () => {}, countReset: () => {},
  dir: () => {}, dirxml: () => {}, group: () => {}, groupCollapsed: () => {}, groupEnd: () => {},
  table: () => {}, time: () => {}, timeEnd: () => {}, timeLog: () => {}, trace: () => {}
} as unknown as Console.Console)

// Bake a stub YodeaClient into a command (mirrors production Command.provide(YodeaClientLive)).
export const stubLayer = (stub: object): Layer.Layer<YodeaClient> => Layer.succeed(YodeaClient, stub as YodeaClientApi)

// Drive a command tree with explicit argv, capturing stdout/stderr + exit code.
// Applies the SAME renderErrors + CliOutput JSON formatter as production main.ts.
export const runCli = async (
  command: Command.Command.Any,
  argv: ReadonlyArray<string>
): Promise<CliResult> => {
  const stdout: string[] = []
  const stderr: string[] = []
  const infra = Layer.mergeAll(
    Layer.succeed(Console.Console, capturingConsole(stdout, stderr)),
    CliOutput.layer(jsonCliErrorFormatter),
    BunServices.layer
  )
  const exit = await Effect.runPromise(
    renderErrors(Command.runWith(command, { version: "test" })(argv) as Effect.Effect<void, unknown, never>).pipe(
      Effect.provide(infra),
      Effect.exit
    )
  )
  return {
    stdout,
    stderr,
    code: exit._tag === "Success" ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause))
  }
}
