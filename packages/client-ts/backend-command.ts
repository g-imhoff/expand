import { existsSync } from "node:fs"

/**
 * Options for {@link resolveBackendCommand}.
 *
 * The resolver picks a backend spawn command from three sources, in priority
 * order: an `EXPAND_BACKEND_CMD` env override, a source-mode command derived
 * from {@link sourceEntry}, then {@link binaryArgs} (the compiled fallback).
 */
export interface ResolveBackendCommandOptions {
  /**
   * Environment to read the `EXPAND_BACKEND_CMD` override from. Defaults to
   * `process.env`. When `EXPAND_BACKEND_CMD` is set it must be a JSON array of
   * strings and wins over every other source.
   */
  readonly env?: Record<string, string | undefined>
  /**
   * Path to the server source entry (e.g. `.../apps/server/main.ts`). When this
   * file exists and looks like a runnable script, the command becomes
   * `[execPath, sourceEntry, ...sourceArgs]` ("source mode").
   */
  readonly sourceEntry?: string | undefined
  /**
   * Runtime executable used to run {@link sourceEntry} in source mode. Defaults
   * to `process.execPath`. Electron consumers pass an explicit JS runtime (e.g.
   * `"bun"`) because Electron's `process.execPath` is the Electron binary, not a
   * JS runtime — this lets them keep the source/compiled existence check instead
   * of hard-coding an explicit fallback command.
   */
  readonly execPath?: string | undefined
  /**
   * Extra arguments appended after {@link sourceEntry} in source mode (e.g. a
   * `["server"]` subcommand). Ignored when source mode does not apply.
   */
  readonly sourceArgs?: ReadonlyArray<string>
  /**
   * Command to run when there is no env override and no usable
   * {@link sourceEntry} — typically the compiled-binary invocation. Also the
   * simplest way to supply a fully explicit default (e.g. `["bun", entry]`).
   */
  readonly binaryArgs?: ReadonlyArray<string>
}

/**
 * Resolve the command used to spawn a Expand backend, shared by every frontend
 * (CLI, TUI, desktop) and by the platform adapters' built-in defaults.
 *
 * Resolution order:
 * 1. `env.EXPAND_BACKEND_CMD` — parsed as a JSON array of strings (throws with a
 *    clear message on malformed JSON or a non-string-array).
 * 2. Source mode — if {@link ResolveBackendCommandOptions.sourceEntry} exists on
 *    disk and looks runnable, `[execPath, sourceEntry, ...sourceArgs]` (where
 *    `execPath` defaults to `process.execPath`).
 * 3. {@link ResolveBackendCommandOptions.binaryArgs} — the compiled/explicit
 *    fallback.
 *
 * Throws if none of the three yields a command, so a misconfiguration surfaces
 * as a clear error (adapters wrap it into `BackendUnavailable`) instead of a
 * silent bad spawn.
 */
export const resolveBackendCommand = (opts: ResolveBackendCommandOptions = {}): ReadonlyArray<string> => {
  const env = opts.env ?? process.env
  const override = env["EXPAND_BACKEND_CMD"]
  if (override !== undefined && override !== "") {
    return parseOverride(override)
  }
  const { sourceEntry, sourceArgs = [], binaryArgs, execPath = process.execPath } = opts
  if (sourceEntry !== undefined && SOURCE_ENTRY_RE.test(sourceEntry) && existsSync(sourceEntry)) {
    return [execPath, sourceEntry, ...sourceArgs]
  }
  if (binaryArgs !== undefined) {
    return binaryArgs
  }
  throw new Error("no backend command configured: set EXPAND_BACKEND_CMD or provide sourceEntry/binaryArgs")
}

const SOURCE_ENTRY_RE = /\.(ts|js|mjs|cjs)$/

const OVERRIDE_ERROR = "EXPAND_BACKEND_CMD must be a JSON array of strings"

const parseOverride = (raw: string): ReadonlyArray<string> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(OVERRIDE_ERROR)
  }
  if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
    throw new Error(OVERRIDE_ERROR)
  }
  return parsed as ReadonlyArray<string>
}
