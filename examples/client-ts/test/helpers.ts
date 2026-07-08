import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const examplesDir = join(fileURLToPath(import.meta.url), "..", "..")

export interface RunResult { readonly code: number; readonly stdout: string; readonly stderr: string }

/** Run `bun run examples/client-ts/<relPath> <...args> --data-dir <isolated>` and capture output. */
export const runExample = async (relPath: string, args: ReadonlyArray<string>): Promise<RunResult> => {
  const dataDir = mkdtempSync(join(tmpdir(), "expand-ex-"))
  try {
    const proc = Bun.spawn(["bun", "run", join(examplesDir, relPath), ...args, "--data-dir", dataDir], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env }
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ])
    return { code, stdout, stderr }
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

/** Create a temp dir containing the named subdirectories; returns its path. Caller removes it. */
export const makeFixtureDir = (subdirs: ReadonlyArray<string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "expand-fixture-"))
  for (const s of subdirs) mkdirSync(join(dir, s))
  return dir
}
