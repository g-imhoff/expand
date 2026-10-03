import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { mkdir, rm, stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { Effect } from "effect"
import { CodingError } from "./coding-agent.js"

export interface SessionWorktree {
  readonly path: string
  readonly branch: string
  readonly repository: string
  readonly managedRoot: string
  readonly linked: boolean
}

export interface ProcessResult {
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
}

export const runProcessCommand = Effect.fn("CodingWorktree.runCommand")(function*(
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env?: Record<string, string>
) {
  const child = yield* Effect.try({
    try: () => spawn(executable, [...args], {
      cwd,
      env: env ?? globalThis.process.env,
      stdio: ["ignore", "pipe", "pipe"]
    }),
    catch: () => new CodingError({ code: "transport", message: `Could not start ${executable}` })
  })
  return yield* awaitProcessClose(child)
})

export const createSessionWorktree = Effect.fn("CodingWorktree.create")(function*(input: {
  readonly worktreeRoot: string
  readonly repository: string
  readonly branch?: string
  readonly now: number
  readonly salt: number
}) {
  const root = resolve(input.worktreeRoot)
  yield* Effect.tryPromise({
    try: () => mkdir(root, { recursive: true }),
    catch: () => new CodingError({ code: "worktree", message: `Could not create managed directory ${root}` })
  })
  const branch = input.branch ?? `coding/session-${input.now}-${input.salt}`
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) {
    return yield* new CodingError({ code: "invalid", message: "Branch name is not usable" })
  }
  const path = join(root, `session-${input.now}-${input.salt}`)
  if (relative(root, path).startsWith("..") || path === root) {
    return yield* new CodingError({ code: "invalid", message: "Session path escapes the managed directory" })
  }
  if (isRemoteRepository(input.repository)) {
    const cloned = yield* runGit(["clone", input.repository, path], root)
    if (cloned.code !== 0) {
      return yield* new CodingError({ code: "worktree", message: "Could not clone the session repository", details: tail(cloned.stderr) })
    }
    const branched = yield* runGit(["checkout", "-b", branch], path)
    if (branched.code !== 0) {
      return yield* new CodingError({ code: "worktree", message: "Could not create the session branch", details: tail(branched.stderr) })
    }
    return { path, branch, repository: input.repository, managedRoot: root, linked: false }
  }
  const verified = yield* runGit(["rev-parse", "--is-inside-work-tree"], input.repository)
  if (verified.code !== 0) {
    return yield* new CodingError({ code: "worktree", message: "Session repository is not a usable git checkout", details: tail(verified.stderr) })
  }
  const added = yield* runGit(["worktree", "add", path, "-b", branch], input.repository)
  if (added.code !== 0) {
    return yield* new CodingError({ code: "worktree", message: "Could not create the session worktree", details: tail(added.stderr) })
  }
  return { path, branch, repository: input.repository, managedRoot: root, linked: true }
})

export const removeSessionWorktree = Effect.fn("CodingWorktree.remove")(function*(worktree: SessionWorktree) {
  if (relative(worktree.managedRoot, worktree.path).startsWith("..") || worktree.path === worktree.managedRoot) {
    return yield* new CodingError({ code: "invalid", message: "Session path escapes the managed directory" })
  }
  if (worktree.linked) {
    yield* Effect.result(runGit(["worktree", "remove", "--force", worktree.path], worktree.repository))
    yield* Effect.result(runGit(["worktree", "prune"], worktree.repository))
  }
  yield* Effect.tryPromise({
    try: () => rm(worktree.path, { recursive: true, force: true }),
    catch: () => new CodingError({ code: "worktree", message: "Could not remove the session worktree" })
  })
  const present = yield* Effect.tryPromise({
    try: () => stat(worktree.path).then(() => true, () => false),
    catch: () => new CodingError({ code: "worktree", message: "Could not inspect the session worktree" })
  })
  if (present) return yield* new CodingError({ code: "worktree", message: "Session worktree still exists after cleanup" })
})

export const collectSessionDiff = Effect.fn("CodingWorktree.diff")(function*(path: string) {
  const status = yield* runGit(["status", "--porcelain=v1", "-uall"], path)
  if (status.code !== 0) {
    return yield* new CodingError({ code: "worktree", message: "Could not read session changes", details: tail(status.stderr) })
  }
  const filesChanged = status.stdout.split("\n").flatMap((line) => {
    const entry = line.slice(3).trim()
    return entry.length === 0 ? [] : [entry]
  }).slice(0, 200)
  const diff = yield* runGit(["diff", "--no-color", "--stat", "HEAD", "--", "."], path)
  if (diff.code !== 0) {
    return yield* new CodingError({ code: "worktree", message: "Could not summarize session changes", details: tail(diff.stderr) })
  }
  const summary = diff.stdout.trim()
  const diffSummary = summary.length > 0 ? summary.slice(0, 4000) : `untracked: ${filesChanged.join(", ").slice(0, 3800)}`
  return { diffSummary, filesChanged }
})

interface SessionDiff {
  readonly diffSummary: string
  readonly filesChanged: ReadonlyArray<string>
}

const runGit = (args: ReadonlyArray<string>, cwd: string) =>
  runProcessCommand("git", args, cwd, { ...globalThis.process.env as Record<string, string> })

const isRemoteRepository = (repository: string): boolean =>
  /^(https?:\/\/|ssh:\/\/|git@)/.test(repository)

const awaitProcessClose = (child: ChildProcess): Effect.Effect<ProcessResult, CodingError> =>
  Effect.callback<ProcessResult, CodingError>((resume) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (result: ProcessResult) => {
      if (settled) return
      settled = true
      resume(Effect.succeed(result))
    }
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", (cause) => {
      finish({ code: null, signal: null, stdout, stderr: `${stderr}${String(cause)}` })
    })
    child.on("close", (code, signal) => {
      finish({ code, signal, stdout, stderr })
    })
    return Effect.sync(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    })
  })

const tail = (stderr: string): string => stderr.slice(-2000)
