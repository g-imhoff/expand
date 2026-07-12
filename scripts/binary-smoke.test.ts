import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

async function readSmokeSource() {
  return Bun.file(new URL("./binary-smoke.sh", import.meta.url)).text()
}

function extractFunctions(source: string) {
  return source.match(/^[a-z_]+\(\) \{[\s\S]*?^\}/gm) ?? []
}

async function runShell(script: string) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 8_000)
  const shell = Bun.spawn(["bash", "-c", script], {
    signal: controller.signal,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(shell.stdout).text(),
    new Response(shell.stderr).text(),
    shell.exited,
  ]).finally(() => clearTimeout(timer))
  if (timedOut) {
    throw new Error("shell harness timed out after 8 seconds")
  }
  return { exitCode, stderr, stdout }
}

type AutospawnControllerScenario = {
  readonly evidence?: "malformed" | "missing" | "valid"
  readonly lingering?: "backend-lock" | "endpoint" | "endpoint-lock" | "endpoint-pid" | "none"
  readonly status?: "malformed" | "missing" | "valid"
}

async function runAutospawnController(source: string, scenario: AutospawnControllerScenario = {}) {
  const functions = extractFunctions(source)
  const root = await mkdtemp(join(tmpdir(), "expand-smoke-controller-"))
  const dataDir = join(root, "data")
  await mkdir(dataDir)
  const evidence = scenario.evidence ?? "valid"
  const lingering = scenario.lingering ?? "none"
  const status = scenario.status ?? "valid"
  const departureTimeout = lingering === "none" ? 1 : 0
  const script = `
set -euo pipefail
set -m

${functions.join("\n\n")}

DATA_DIR=${JSON.stringify(dataDir)}
ENDPOINT_FILE="$DATA_DIR/server.json"
ENDPOINT_LOCK_FILE="$DATA_DIR/server.json.lock"
BACKEND_LOCK_FILE="$DATA_DIR/backend.lock"
JOB_STATE_FILE="$DATA_DIR/server-job.state"
GUARDIAN_STATUS_FILE="$DATA_DIR/autospawn-guardian.status"
GUARDIAN_EVIDENCE_FILE="$DATA_DIR/autospawn-guardian.evidence"
GUARDIAN_RELEASE_FILE="$DATA_DIR/autospawn-guardian.release"
SENTINEL_HOME="$DATA_DIR/default-sentinel"
CLI=(unused)
SERVER_EXIT_TIMEOUT_SECONDS=1
SERVER_STOP_TIMEOUT_SECONDS=1
SERVER_PID=""
SERVER_JOB_SPEC=""
GUARDIAN_PID=""
GUARDIAN_PGID=""
GUARDIAN_EXIT_STATUS=""
ENDPOINT_PID=""
DATA_DIR_SAFE=1
EVIDENCE_MODE=${JSON.stringify(evidence)}
LINGERING_STATE=${JSON.stringify(lingering)}
STATUS_MODE=${JSON.stringify(status)}
DEPARTURE_TIMEOUT=${departureTimeout}
TRACE_FILE="$DATA_DIR/controller.trace"

eval "$(declare -f read_process_group | sed '1s/read_process_group/original_read_process_group/')"
read_process_group() {
  if [[ "$LINGERING_STATE" = "endpoint-pid" ]] && [[ "$1" = "606060" ]]; then
    printf '%s\n' "$GUARDIAN_PGID"
    return 0
  fi
  original_read_process_group "$1"
}

eval "$(declare -f verify_autospawn_evidence | sed '1s/verify_autospawn_evidence/original_verify_autospawn_evidence/')"
verify_autospawn_evidence() {
  local status=0
  printf 'evidence:start\n' >> "$TRACE_FILE"
  original_verify_autospawn_evidence || status=$?
  printf 'evidence:%s\n' "$status" >> "$TRACE_FILE"
  return "$status"
}

eval "$(declare -f await_autospawn_departure | sed '1s/await_autospawn_departure/original_await_autospawn_departure/')"
await_autospawn_departure() {
  local original_timeout="$SERVER_EXIT_TIMEOUT_SECONDS"
  local status=0
  printf 'departure:start\n' >> "$TRACE_FILE"
  SERVER_EXIT_TIMEOUT_SECONDS="$DEPARTURE_TIMEOUT"
  original_await_autospawn_departure || status=$?
  SERVER_EXIT_TIMEOUT_SECONDS="$original_timeout"
  printf 'departure:%s\n' "$status" >> "$TRACE_FILE"
  return "$status"
}

eval "$(declare -f reap_server_job | sed '1s/reap_server_job/original_reap_server_job/')"
reap_server_job() {
  local status=0
  printf 'reap:start\n' >> "$TRACE_FILE"
  original_reap_server_job || status=$?
  printf 'reap:%s\n' "$status" >> "$TRACE_FILE"
  return "$status"
}

eval "$(declare -f release_guardian | sed '1s/release_guardian/original_release_guardian/')"
release_guardian() {
  local status=0
  printf 'release:start\n' >> "$TRACE_FILE"
  original_release_guardian || status=$?
  printf 'release:%s\n' "$status" >> "$TRACE_FILE"
  return "$status"
}

autospawn_guardian() {
  local output_file="$1"
  local guardian_group
  local attempt
  guardian_group="$(original_read_process_group "$BASHPID")"
  printf '{}\n' > "$output_file"
  case "$EVIDENCE_MODE" in
    valid) write_private_file "$GUARDIAN_EVIDENCE_FILE" "606060 $guardian_group" ;;
    malformed) write_private_file "$GUARDIAN_EVIDENCE_FILE" malformed ;;
  esac
  case "$STATUS_MODE" in
    valid) write_private_file "$GUARDIAN_STATUS_FILE" 23 ;;
    malformed) write_private_file "$GUARDIAN_STATUS_FILE" invalid ;;
  esac
  case "$LINGERING_STATE" in
    endpoint) write_private_file "$ENDPOINT_FILE" '{}' ;;
    endpoint-lock) write_private_file "$ENDPOINT_LOCK_FILE" lock ;;
    backend-lock) write_private_file "$BACKEND_LOCK_FILE" lock ;;
  esac
  for ((attempt = 0; attempt < 200; attempt++)); do
    [[ -f "$GUARDIAN_RELEASE_FILE" ]] && return 23
    command sleep 0.002
  done
  return 99
}

controller_status=0
run_cli_autospawn "$DATA_DIR/health.json" health --format json || controller_status=$?
if [[ -e "$GUARDIAN_RELEASE_FILE" ]]; then released=1; else released=0; fi
printf 'controller:%s safe:%s released:%s job:%s guardian:%s\n' "$controller_status" "$DATA_DIR_SAFE" "$released" "$SERVER_JOB_SPEC" "$GUARDIAN_EXIT_STATUS" >> "$TRACE_FILE"
if [[ -n "$SERVER_JOB_SPEC" ]]; then
  job_spec="$SERVER_JOB_SPEC"
  kill -TERM -- "$job_spec" 2>/dev/null || true
  wait "$job_spec" 2>/dev/null || true
fi
cat "$TRACE_FILE"
`

  try {
    return await runShell(script)
  } finally {
    await rm(root, { force: true, recursive: true })
  }
}

describe("binary smoke isolation", () => {
  it("certifies sibling auto-spawn before directly owned CRUD", async () => {
    const source = await readSmokeSource()
    expect(source).toContain("set -m")
    expect(source).toContain("command -v ps")
    expect(source).toContain("unset EXPAND_BACKEND_CMD")
    expect(source).toContain('GUARDIAN_STATUS_FILE="$DATA_DIR/autospawn-guardian.status"')
    expect(source).toContain('GUARDIAN_EVIDENCE_FILE="$DATA_DIR/autospawn-guardian.evidence"')
    expect(source).toContain('GUARDIAN_RELEASE_FILE="$DATA_DIR/autospawn-guardian.release"')
    expect(source).toContain('ENDPOINT_LOCK_FILE="$DATA_DIR/server.json.lock"')
    expect(source).toContain('BACKEND_LOCK_FILE="$DATA_DIR/backend.lock"')
    expect(source).toContain("chmod 600")
    expect(source).toContain("verify_autospawn_evidence")
    expect(source).toContain("await_autospawn_departure")
    expect(source).toContain("release_guardian")
    expect(source).toContain('run_cli_autospawn "$DATA_DIR/health.json" health --format json')
    expect(source).toContain('run_cli "$DATA_DIR/created.json" project create')
    expect(source.indexOf('run_cli_autospawn "$DATA_DIR/health.json"')).toBeLessThan(
      source.indexOf('run_cli "$DATA_DIR/created.json"')
    )
    expect(source).toContain('"${CLI[@]}" "$@"')
    expect(source).toContain("jq -e . \"$output_file\"")
    expect(source).not.toContain("EXPAND_BACKEND_CMD=")
  })

  it("uses shell job ownership while keeping the numeric pid as endpoint evidence", async () => {
    const source = await readSmokeSource()
    expect(source).not.toContain("EXPAND_HOME")
    expect(source).toContain('DATA_DIR="$(mktemp -d)"')
    expect(source).toContain('CLI=(./dist/expand --data-dir "$DATA_DIR")')
    expect(source).toContain('ENDPOINT_FILE="$DATA_DIR/server.json"')
    expect(source).toContain('SENTINEL_HOME="$DATA_DIR/default-sentinel"')
    expect(source).toContain('test ! -e "$SENTINEL_HOME/.expand"')
    expect(source).toContain('[[ "$advertised_pid" != "$SERVER_PID" ]]')
    expect(source).toContain("jobs -l %%")
    expect(source).toMatch(/SERVER_PID=\$!\n\s+capture_server_job/)
    expect(source).not.toContain("kill -0")
    expect(source).not.toMatch(/kill\b[^\n]*\$[A-Z_]*PID/)
    expect(source).not.toMatch(/wait\b[^\n]*\$[A-Z_]*PID/)
    expect(source).toContain("trap cleanup EXIT")
    expect(source).toContain("trap 'exit 130' INT")
    expect(source).toContain("trap 'exit 143' TERM")
    expect(source).toContain('rm -rf -- "$DATA_DIR"')
    expect(source).not.toMatch(/pkill|killall|pgrep/)
  })

  it("captures a non-first job spec and propagates its cached nonzero status", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR="$(mktemp -d)"
ENDPOINT_FILE="$DATA_DIR/server.json"
JOB_STATE_FILE="$DATA_DIR/server-job.state"
SERVER_EXIT_TIMEOUT_SECONDS=1
SERVER_PID=""
SERVER_JOB_SPEC=""
DATA_DIR_SAFE=1

false &
command sleep 0.05
(command sleep 0.05; exit 23) &
SERVER_PID=$!
capture_server_job
printf 'captured:%s\n' "$SERVER_JOB_SPEC"
command sleep 0.1
status=0
await_server_exit "$SERVER_JOB_SPEC" || status=$?
printf 'status:%s job:%s pid:%s\n' "$status" "$SERVER_JOB_SPEC" "$SERVER_PID"
wait %1 || true
rm -rf -- "$DATA_DIR"
`
    const result = await runShell(script)

    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^captured:%2\nstatus:23 job: pid:\d+\n$/)
  })

  it("signals and waits only through the owned job spec", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR="$(mktemp -d)"
ENDPOINT_FILE="$DATA_DIR/server.json"
JOB_STATE_FILE="$DATA_DIR/server-job.state"
SERVER_STOP_TIMEOUT_SECONDS=1
SERVER_PID=424242
SERVER_JOB_SPEC="%7"
DATA_DIR_SAFE=1
OWNED_PIDS=(424242)
JOB_ACTIVE=1

jobs() {
  if [[ "$1" = "-r" && "$JOB_ACTIVE" = "1" ]]; then
    printf '[7]+ Running server\n'
  fi
}

kill() {
  printf 'signal:%s\n' "$*"
  if [[ "$1" = "-TERM" ]]; then
    JOB_ACTIVE=0
  fi
}

wait() {
  printf 'wait:%s\n' "$1"
  return 143
}

cleanup
`
    const result = await runShell(script)

    expect(result.stderr).toBe("")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("signal:-TERM -- %7\nwait:%7\n")
    expect(result.stdout).not.toContain("424242")
  })

  it("retires job eligibility before reaping cached status and polling endpoint removal", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const root = await mkdtemp(join(tmpdir(), "expand-smoke-cached-"))
    const dataDir = join(root, "data")
    await mkdir(dataDir)
    await writeFile(join(dataDir, "server.json"), "{}")
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR=${JSON.stringify(dataDir)}
ENDPOINT_FILE="$DATA_DIR/server.json"
JOB_STATE_FILE="$DATA_DIR/server-job.state"
SERVER_EXIT_TIMEOUT_SECONDS=1
SERVER_PID=515151
SERVER_JOB_SPEC="%4"
DATA_DIR_SAFE=1
OWNED_PIDS=(515151)

jobs() {
  return 0
}

wait() {
  printf 'wait:%s job:%s\n' "$1" "$SERVER_JOB_SPEC"
  rm -f -- "$ENDPOINT_FILE"
  return 29
}

sleep() {
  printf 'unexpected-sleep\n'
  SECONDS=$((SECONDS + 1))
}

status=0
await_server_exit "$SERVER_JOB_SPEC" || status=$?
printf 'status:%s job:%s\n' "$status" "$SERVER_JOB_SPEC"
`

    try {
      const result = await runShell(script)
      expect(result.stderr).toBe("")
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("wait:%4 job:\nstatus:29 job:\n")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("rejects readiness when the owned job exits immediately after endpoint acceptance", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const root = await mkdtemp(join(tmpdir(), "expand-smoke-readiness-"))
    const dataDir = join(root, "data")
    await mkdir(dataDir)
    await writeFile(join(dataDir, "server.json"), JSON.stringify({ pid: 717171 }))
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR=${JSON.stringify(dataDir)}
ENDPOINT_FILE="$DATA_DIR/server.json"
JOB_STATE_FILE="$DATA_DIR/server-job.state"
SERVER_EXIT_TIMEOUT_SECONDS=1
SERVER_PID=717171
SERVER_JOB_SPEC="%3"
DATA_DIR_SAFE=1
ACTIVE_CHECKS=0

server_job_active() {
  ACTIVE_CHECKS=$((ACTIVE_CHECKS + 1))
  [[ "$ACTIVE_CHECKS" = "1" ]]
}

status=0
await_server_readiness || status=$?
printf 'status:%s safe:%s checks:%s\n' "$status" "$DATA_DIR_SAFE" "$ACTIVE_CHECKS"
`

    try {
      const result = await runShell(script)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("status:1 safe:0 checks:2\n")
      expect(result.stderr).toContain("exited during endpoint readiness")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("marks a replacement endpoint unsafe after the owned job is retired", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const root = await mkdtemp(join(tmpdir(), "expand-smoke-replacement-"))
    const dataDir = join(root, "data")
    await mkdir(dataDir)
    await writeFile(join(dataDir, "server.json"), JSON.stringify({ pid: 818181 }))
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR=${JSON.stringify(dataDir)}
ENDPOINT_FILE="$DATA_DIR/server.json"
JOB_STATE_FILE="$DATA_DIR/server-job.state"
SERVER_EXIT_TIMEOUT_SECONDS=0
SERVER_PID=818181
SERVER_JOB_SPEC="%5"
DATA_DIR_SAFE=1

jobs() {
  return 0
}

wait() {
  printf '{"pid":919191}\n' > "$ENDPOINT_FILE"
  return 0
}

status=0
await_server_exit || status=$?
printf 'status:%s safe:%s job:%s\n' "$status" "$DATA_DIR_SAFE" "$SERVER_JOB_SPEC"
`

    try {
      const result = await runShell(script)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("status:1 safe:0 job:\n")
      expect(result.stderr).toContain("endpoint remained after recorded expand-server job exit")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("marks an endpoint PID mismatch unsafe after a CLI command", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const root = await mkdtemp(join(tmpdir(), "expand-smoke-mismatch-"))
    const dataDir = join(root, "data")
    await mkdir(dataDir)
    await writeFile(join(dataDir, "server.json"), JSON.stringify({ pid: 939393 }))
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR=${JSON.stringify(dataDir)}
ENDPOINT_FILE="$DATA_DIR/server.json"
JOB_STATE_FILE="$DATA_DIR/server-job.state"
SERVER_PID=838383
SERVER_JOB_SPEC="%6"
DATA_DIR_SAFE=1

status=0
verify_existing_endpoint_ownership || status=$?
printf 'status:%s safe:%s\n' "$status" "$DATA_DIR_SAFE"
`

    try {
      const result = await runShell(script)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("status:1 safe:0\n")
      expect(result.stderr).toContain("endpoint PID does not match")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("validates controller evidence and status before departure, release, and reap", async () => {
    const source = await readSmokeSource()
    const result = await runAutospawnController(source)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(
      [
        "evidence:start",
        "evidence:0",
        "departure:start",
        "departure:0",
        "release:start",
        "reap:start",
        "reap:23",
        "release:0",
        "controller:23 safe:1 released:1 job: guardian:23",
        "",
      ].join("\n")
    )
  })

  it.each([
    {
      label: "missing evidence",
      message: "endpoint evidence was not recorded",
      scenario: { evidence: "missing" },
    },
    {
      label: "malformed evidence",
      message: "endpoint evidence was missing or malformed",
      scenario: { evidence: "malformed" },
    },
    { label: "missing status", message: "CLI status was not recorded", scenario: { status: "missing" } },
    {
      label: "malformed status",
      message: "CLI status was malformed",
      scenario: { status: "malformed" },
    },
  ] as const)(
    "rejects $label before departure and release",
    async ({ message, scenario }) => {
      const source = await readSmokeSource()
      const result = await runAutospawnController(source, scenario)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(/controller:1 safe:0 released:0 job:%\d+ guardian:\n$/)
      expect(result.stdout).not.toContain("departure:start")
      expect(result.stdout).not.toContain("release:start")
      expect(result.stdout).not.toContain("reap:start")
      expect(result.stderr).toContain(message)
    }
  )

  it.each(["endpoint", "endpoint-lock", "backend-lock", "endpoint-pid"] as const)(
    "blocks controller release while %s ownership remains",
    async (lingering) => {
      const source = await readSmokeSource()
      const result = await runAutospawnController(source, { lingering })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("evidence:start\nevidence:0\ndeparture:start\ndeparture:1\n")
      expect(result.stdout).toMatch(/controller:1 safe:0 released:0 job:%\d+ guardian:\n$/)
      expect(result.stdout).not.toContain("release:start")
      expect(result.stdout).not.toContain("reap:start")
      expect(result.stderr).toContain("auto-spawned backend cleanup timed out")
    }
  )

  it("rejects endpoint evidence from outside the guardian process group", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const root = await mkdtemp(join(tmpdir(), "expand-smoke-wrong-pgid-"))
    const dataDir = join(root, "data")
    const marker = join(dataDir, "marker")
    await mkdir(dataDir)
    await writeFile(marker, "live")
    await writeFile(join(dataDir, "server.json"), JSON.stringify({ pid: 737373 }))
    await writeFile(join(dataDir, "autospawn-guardian.evidence"), "737373 999999\n")
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR=${JSON.stringify(dataDir)}
ENDPOINT_FILE="$DATA_DIR/server.json"
ENDPOINT_LOCK_FILE="$DATA_DIR/server.json.lock"
BACKEND_LOCK_FILE="$DATA_DIR/backend.lock"
JOB_STATE_FILE="$DATA_DIR/server-job.state"
GUARDIAN_EVIDENCE_FILE="$DATA_DIR/autospawn-guardian.evidence"
GUARDIAN_STATUS_FILE="$DATA_DIR/autospawn-guardian.status"
GUARDIAN_RELEASE_FILE="$DATA_DIR/autospawn-guardian.release"
GUARDIAN_PGID=888888
ENDPOINT_PID=""
SERVER_JOB_SPEC=""
SERVER_PID=""
DATA_DIR_SAFE=1

kill() {
  printf 'unexpected-signal:%s\n' "$*"
}

status=0
verify_autospawn_evidence || status=$?
printf 'status:%s safe:%s endpoint:%s\n' "$status" "$DATA_DIR_SAFE" "$ENDPOINT_PID"
cleanup
`

    try {
      const result = await runShell(script)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("status:1 safe:0 endpoint:737373\n")
      expect(result.stdout).not.toContain("unexpected-signal")
      expect(result.stderr).toContain("endpoint PID process group does not match the guardian")
      expect(result.stderr).toContain("preserving data directory")
      await access(marker)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("withholds guardian release while the endpoint PID remains in the owned group", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const root = await mkdtemp(join(tmpdir(), "expand-smoke-owned-group-"))
    const dataDir = join(root, "data")
    await mkdir(dataDir)
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR=${JSON.stringify(dataDir)}
ENDPOINT_FILE="$DATA_DIR/server.json"
ENDPOINT_LOCK_FILE="$DATA_DIR/server.json.lock"
BACKEND_LOCK_FILE="$DATA_DIR/backend.lock"
GUARDIAN_RELEASE_FILE="$DATA_DIR/autospawn-guardian.release"
SERVER_EXIT_TIMEOUT_SECONDS=1
GUARDIAN_PGID=444444
ENDPOINT_PID=747474
DATA_DIR_SAFE=1

ps() {
  printf ' 444444\n'
}

sleep() {
  SECONDS=$((SECONDS + 1))
}

status=0
await_autospawn_departure || status=$?
if [[ -e "$GUARDIAN_RELEASE_FILE" ]]; then released=1; else released=0; fi
printf 'status:%s safe:%s released:%s\n' "$status" "$DATA_DIR_SAFE" "$released"
`

    try {
      const result = await runShell(script)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("status:1 safe:0 released:0\n")
      expect(result.stderr).toContain("auto-spawned backend cleanup timed out")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("releases and reaps the guardian after verified backend departure", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const root = await mkdtemp(join(tmpdir(), "expand-smoke-release-"))
    const dataDir = join(root, "data")
    await mkdir(dataDir)
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR=${JSON.stringify(dataDir)}
ENDPOINT_FILE="$DATA_DIR/server.json"
ENDPOINT_LOCK_FILE="$DATA_DIR/server.json.lock"
BACKEND_LOCK_FILE="$DATA_DIR/backend.lock"
GUARDIAN_RELEASE_FILE="$DATA_DIR/autospawn-guardian.release"
SERVER_EXIT_TIMEOUT_SECONDS=1
GUARDIAN_PGID=555555
ENDPOINT_PID=757575
SERVER_JOB_SPEC="%9"
GUARDIAN_EXIT_STATUS=""
DATA_DIR_SAFE=1

ps() {
  return 1
}

server_job_active() {
  return 1
}

wait() {
  printf 'wait:%s\n' "$1"
  return 17
}

await_autospawn_departure
status=0
release_guardian || status=$?
mode="$(stat -c '%a' "$GUARDIAN_RELEASE_FILE")"
printf 'status:%s guardian:%s job:%s mode:%s\n' "$status" "$GUARDIAN_EXIT_STATUS" "$SERVER_JOB_SPEC" "$mode"
`

    try {
      const result = await runShell(script)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("wait:%9\nstatus:0 guardian:17 job: mode:600\n")
      expect(result.stderr).toBe("")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("retains guardian ownership when the release write fails", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const root = await mkdtemp(join(tmpdir(), "expand-smoke-release-write-"))
    const dataDir = join(root, "data")
    await mkdir(dataDir)
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR=${JSON.stringify(dataDir)}
GUARDIAN_RELEASE_FILE="$DATA_DIR/autospawn-guardian.release"
SERVER_JOB_SPEC="%9"
DATA_DIR_SAFE=1

write_private_file() {
  return 41
}

reap_server_job() {
  printf 'unexpected-reap\n'
  SERVER_JOB_SPEC=""
}

status=0
release_guardian || status=$?
printf 'status:%s safe:%s job:%s\n' "$status" "$DATA_DIR_SAFE" "$SERVER_JOB_SPEC"
`

    try {
      const result = await runShell(script)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("status:41 safe:0 job:%9\n")
      expect(result.stderr).toContain("guardian release could not be recorded")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("retains guardian ownership when exit polling times out", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const root = await mkdtemp(join(tmpdir(), "expand-smoke-release-timeout-"))
    const dataDir = join(root, "data")
    await mkdir(dataDir)
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR=${JSON.stringify(dataDir)}
JOB_STATE_FILE="$DATA_DIR/server-job.state"
GUARDIAN_RELEASE_FILE="$DATA_DIR/autospawn-guardian.release"
SERVER_EXIT_TIMEOUT_SECONDS=1
SERVER_JOB_SPEC="%9"
DATA_DIR_SAFE=1

server_job_active() {
  return 0
}

sleep() {
  SECONDS=$((SECONDS + 1))
}

reap_server_job() {
  printf 'unexpected-reap\n'
  SERVER_JOB_SPEC=""
}

status=0
release_guardian || status=$?
if [[ -e "$GUARDIAN_RELEASE_FILE" ]]; then released=1; else released=0; fi
printf 'status:%s safe:%s job:%s released:%s\n' "$status" "$DATA_DIR_SAFE" "$SERVER_JOB_SPEC" "$released"
`

    try {
      const result = await runShell(script)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("status:1 safe:0 job:%9 released:1\n")
      expect(result.stderr).toContain("guardian did not exit after release")
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("preserves data when an endpoint remains after the job spec is cleared", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const root = await mkdtemp(join(tmpdir(), "expand-smoke-unowned-"))
    const dataDir = join(root, "data")
    const marker = join(dataDir, "marker")
    await mkdir(dataDir)
    await writeFile(marker, "live")
    await writeFile(join(dataDir, "server.json"), JSON.stringify({ pid: 929292 }))
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR=${JSON.stringify(dataDir)}
ENDPOINT_FILE="$DATA_DIR/server.json"
JOB_STATE_FILE="$DATA_DIR/server-job.state"
SERVER_STOP_TIMEOUT_SECONDS=0
SERVER_PID=828282
SERVER_JOB_SPEC=""
DATA_DIR_SAFE=1

cleanup
`

    try {
      const result = await runShell(script)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("preserving data directory")
      await access(marker)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("bounds failed cleanup and preserves live state", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const root = await mkdtemp(join(tmpdir(), "expand-smoke-bounded-"))
    const dataDir = join(root, "data")
    const marker = join(dataDir, "marker")
    await mkdir(dataDir)
    await writeFile(marker, "live")
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR=${JSON.stringify(dataDir)}
ENDPOINT_FILE="$DATA_DIR/server.json"
JOB_STATE_FILE="$DATA_DIR/server-job.state"
SERVER_STOP_TIMEOUT_SECONDS=0
SERVER_PID=626262
SERVER_JOB_SPEC="%8"
DATA_DIR_SAFE=1
OWNED_PIDS=(626262)

jobs() {
  if [[ "$1" = "-r" ]]; then
    printf '[8]+ Running server\n'
  fi
}

kill() {
  printf 'signal:%s\n' "$*"
}

wait() {
  printf 'unexpected-wait:%s\n' "$1"
}

cleanup
`

    try {
      const result = await runShell(script)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("signal:-TERM -- %8\nsignal:-KILL -- %8\n")
      expect(result.stdout).not.toContain("626262")
      expect(result.stderr).toContain("preserving data directory")
      await access(marker)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("stops and reaps an active owned job during cleanup", async () => {
    const source = await readSmokeSource()
    const functions = extractFunctions(source)
    const root = await mkdtemp(join(tmpdir(), "expand-smoke-active-"))
    const dataDir = join(root, "data")
    await mkdir(dataDir)
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR=${JSON.stringify(dataDir)}
ENDPOINT_FILE="$DATA_DIR/server.json"
JOB_STATE_FILE="$DATA_DIR/server-job.state"
SERVER_STOP_TIMEOUT_SECONDS=2
SERVER_PID=""
SERVER_JOB_SPEC=""
DATA_DIR_SAFE=1

false &
command sleep 0.05
sleep 30 &
SERVER_PID=$!
SERVER_JOB_SPEC="%2"
OWNED_PIDS=("$SERVER_PID")
printf 'owned:%s\n' "$SERVER_JOB_SPEC"
cleanup
`

    try {
      const result = await runShell(script)
      expect(result.stderr).toBe("")
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("owned:%2\n")
      await expect(access(dataDir)).rejects.toThrow()
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
