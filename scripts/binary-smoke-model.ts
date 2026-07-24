import { Data } from "effect"

export type CertificationPhase = "acquired" | "ready" | "departed" | "released" | "reaped" | "cleaned"
export type CleanupSignal = "SIGTERM" | "SIGKILL"

export interface CertificationState {
  readonly dataDirectory: string
  readonly pid: number
  readonly pgid?: number | undefined
  readonly job?: string | undefined
  readonly phase: CertificationPhase
  readonly cleanupSignal?: CleanupSignal | undefined
  readonly exitStatus?: number | undefined
}

export interface RemainingOwnership {
  readonly endpoint: boolean
  readonly endpointLock: boolean
  readonly backendLock: boolean
  readonly processInGroup: boolean
}

export class BinaryModelError extends Data.TaggedError("BinaryModelError")<{
  readonly reason: string
}> {}

const fail = (reason: string): never => {
  throw new BinaryModelError({ reason })
}

export const initialCertificationState = (
  dataDirectory: string,
  pid: number,
  options: { readonly pgid?: number; readonly job?: string } = {}
): CertificationState => ({ dataDirectory, pid, pgid: options.pgid, job: options.job, phase: "acquired" })

export const parseEvidence = (source: string | undefined, guardianPgid: number): { readonly pid: number; readonly pgid: number } => {
  if (source === undefined) return fail("auto-spawn endpoint evidence was not recorded")
  const match = /^([1-9][0-9]*) ([1-9][0-9]*)\n?$/.exec(source)
  if (match === null) return fail("auto-spawn endpoint evidence was malformed")
  const pid = Number(match[1])
  const pgid = Number(match[2])
  if (pgid !== guardianPgid) return fail("endpoint PID process group does not match the guardian process group")
  return { pid, pgid }
}

export const parseStatus = (source: string | undefined): number => {
  if (source === undefined) return fail("auto-spawn CLI status was not recorded")
  if (!/^(?:0|[1-9][0-9]{0,2})\n?$/.test(source)) return fail("auto-spawn CLI status was malformed")
  const status = Number(source.trim())
  if (status > 255) return fail("auto-spawn CLI status was malformed")
  return status
}

export const parseJobIdentity = (source: string, expectedPid: number): { readonly job: string; readonly pid: number } => {
  const match = /^\[([1-9][0-9]*)\][+-]?\s+([1-9][0-9]*)\s+/.exec(source)
  if (match === null) return fail("shell job identity was malformed")
  const pid = Number(match[2])
  if (pid !== expectedPid) return fail("shell job PID does not match the started process PID")
  return { job: `%${match[1]}`, pid }
}

export const assessEndpoint = (current: CertificationState, endpointPid: number): CertificationState => {
  if (endpointPid !== current.pid) return fail("endpoint PID does not match the recorded process")
  return current
}

export const readinessTransition = (
  current: CertificationState,
  observation: { readonly endpointPid: number; readonly activeBefore: boolean; readonly activeAfter: boolean }
): CertificationState => {
  if (!observation.activeBefore || !observation.activeAfter) return fail("recorded process exited during endpoint readiness")
  assessEndpoint(current, observation.endpointPid)
  return { ...current, phase: "ready" }
}

export const assessArtifacts = (
  remaining: Omit<RemainingOwnership, "processInGroup">
): void => {
  if (remaining.endpoint || remaining.endpointLock || remaining.backendLock) {
    return fail("certification ownership files remaining after process exit")
  }
}

export const assessDeparture = (
  current: CertificationState,
  remaining: RemainingOwnership
): CertificationState => {
  if (remaining.endpoint || remaining.endpointLock || remaining.backendLock || remaining.processInGroup) {
    return fail("auto-spawned backend cleanup timed out")
  }
  return { ...current, phase: "departed" }
}

export const releaseTransition = (current: CertificationState): CertificationState => {
  if (current.phase !== "departed") return fail("guardian release requires verified departure")
  return { ...current, phase: "released" }
}

export const reapTransition = (current: CertificationState, exitStatus: number): CertificationState => {
  if (current.phase !== "released") return fail("guardian reap requires successful release")
  return { ...current, phase: "reaped", job: undefined, exitStatus }
}

export const cleanupTransition = (current: CertificationState, active: boolean): CertificationState => {
  if (!active) return { ...current, phase: "cleaned", job: undefined }
  if (current.cleanupSignal === undefined) return { ...current, cleanupSignal: "SIGTERM" }
  if (current.cleanupSignal === "SIGTERM") return { ...current, cleanupSignal: "SIGKILL", job: undefined }
  return fail("bounded cleanup failed after TERM-to-KILL escalation")
}
