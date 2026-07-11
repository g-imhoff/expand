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

describe("binary smoke isolation", () => {
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
