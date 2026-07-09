import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const examplesDir = join(fileURLToPath(import.meta.url), "..", "..")

export interface RunResult { readonly code: number; readonly stdout: string; readonly stderr: string }

/** Create an isolated, caller-owned data dir. Caller removes it (e.g. `rmSync(..., { recursive: true })`). */
export const makeDataDir = (): string => mkdtempSync(join(tmpdir(), "expand-ex-"))

/**
 * Run `bun run examples/client-ts/<relPath> <...args> --data-dir <isolated>` and capture output.
 *
 * When `dataDir` is provided the caller owns its lifecycle (pin multiple runs to one backend);
 * otherwise a fresh temp dir is created and removed around this single run.
 */
export const runExample = async (
  relPath: string,
  args: ReadonlyArray<string>,
  dataDir?: string
): Promise<RunResult> => {
  const owned = dataDir === undefined
  const dir = dataDir ?? makeDataDir()
  try {
    const proc = Bun.spawn(["bun", "run", join(examplesDir, relPath), ...args, "--data-dir", dir], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env }
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ])
    return { code, stdout, stderr }
  } finally {
    if (owned) rmSync(dir, { recursive: true, force: true })
  }
}

export interface ExampleHandle {
  /** Kill the process and await its exit, so cleanup never races the dying backend. */
  readonly kill: () => Promise<void>
  /**
   * Resolve once a stdout line containing `substr` has appeared (matches lines
   * seen before the call too). Rejects on `timeoutMs` or if the process exits
   * first without emitting a matching line.
   */
  readonly waitForLine: (substr: string, timeoutMs: number) => Promise<void>
}

/**
 * Spawn a long-running example against a caller-owned `dataDir` and return a handle
 * immediately (without awaiting exit), so a test can let it run then `kill()` it.
 *
 * stdout is PIPED (not inherited) so callers can deterministically await a
 * readiness line via `waitForLine` instead of sleeping; stderr is inherited for
 * debugging. The caller owns `dataDir`.
 */
export const spawnExample = (
  relPath: string,
  args: ReadonlyArray<string>,
  dataDir: string
): ExampleHandle => {
  const proc = Bun.spawn(["bun", "run", join(examplesDir, relPath), ...args, "--data-dir", dataDir], {
    stdout: "pipe", stderr: "inherit", env: { ...process.env }
  })

  const lines: string[] = []
  const waiters = new Set<(line: string | null) => void>()
  const notify = (line: string | null) => { for (const w of [...waiters]) w(line) }

  // Drain stdout, splitting into lines; feed each to any pending waiters. A final
  // `null` (stream end) lets waiters reject rather than hang.
  void (async () => {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const flush = (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        lines.push(line)
        notify(line)
      }
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        flush(decoder.decode(value, { stream: true }))
      }
    } catch { /* stream torn down on kill */ }
    if (buffer.length > 0) { lines.push(buffer); notify(buffer) }
    notify(null)
  })()

  return {
    kill: async () => {
      proc.kill()
      await proc.exited
    },
    waitForLine: (substr, timeoutMs) =>
      new Promise<void>((resolve, reject) => {
        if (lines.some((l) => l.includes(substr))) { resolve(); return }
        const done = (fn: () => void) => { clearTimeout(timer); waiters.delete(onLine); fn() }
        const timer = setTimeout(
          () => done(() => reject(new Error(
            `timed out after ${timeoutMs}ms waiting for stdout line containing ${JSON.stringify(substr)}; ` +
            `saw ${lines.length} line(s): ${JSON.stringify(lines)}`
          ))),
          timeoutMs
        )
        const onLine = (line: string | null) => {
          if (line === null) done(() => reject(new Error(
            `process exited before emitting a stdout line containing ${JSON.stringify(substr)}; ` +
            `saw ${lines.length} line(s): ${JSON.stringify(lines)}`
          )))
          else if (line.includes(substr)) done(resolve)
        }
        waiters.add(onLine)
      })
  }
}

/** Create a temp dir containing the named subdirectories; returns its path. Caller removes it. */
export const makeFixtureDir = (subdirs: ReadonlyArray<string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "expand-fixture-"))
  for (const s of subdirs) mkdirSync(join(dir, s))
  return dir
}
