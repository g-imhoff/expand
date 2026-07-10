import { describe, expect, it } from "vitest"

describe("binary smoke isolation", () => {
  it("uses the public data-dir flag and scoped cleanup only", async () => {
    const source = await Bun.file(new URL("./binary-smoke.sh", import.meta.url)).text()
    expect(source).not.toContain("EXPAND_HOME")
    expect(source).toContain('DATA_DIR="$(mktemp -d)"')
    expect(source).toContain('CLI=(./dist/expand --data-dir "$DATA_DIR")')
    expect(source).toContain('ENDPOINT_FILE="$DATA_DIR/server.json"')
    expect(source).toContain('SENTINEL_HOME="$DATA_DIR/default-sentinel"')
    expect(source).toContain('test ! -e "$SENTINEL_HOME/.expand"')
    expect(source).toContain('test "$advertised_pid" = "$SERVER_PID"')
    expect(source).toContain("trap cleanup EXIT")
    expect(source).toContain("trap 'exit 130' INT")
    expect(source).toContain("trap 'exit 143' TERM")
    expect(source).toContain('for pid in "${OWNED_PIDS[@]}"')
    expect(source).toContain('wait "$pid" 2>/dev/null || true')
    expect(source).toContain('rm -rf -- "$DATA_DIR"')
    expect(source).not.toMatch(/pkill|killall|pgrep/)
  })

  it("retires reaped child pids while preserving active ones for cleanup", async () => {
    const source = await Bun.file(new URL("./binary-smoke.sh", import.meta.url)).text()
    const functions = source.match(/^[a-z_]+\(\) \{[\s\S]*?^\}/gm) ?? []
    const script = `
set -euo pipefail

${functions.join("\n\n")}

DATA_DIR="$(mktemp -d)"
ENDPOINT_FILE="$DATA_DIR/server.json"
OWNED_PIDS=(101 202)
REAPED_PID=""

kill() {
  if [[ "$1" = "-0" ]]; then
    if [[ "$2" = "101" && "$REAPED_PID" != "101" ]]; then
      return 1
    fi
    return 0
  fi
  printf 'signaled:%s\n' "$1"
}

wait() {
  REAPED_PID="$1"
}

await_server_exit 101
cleanup
`
    const shell = Bun.spawn(["bash", "-c", script], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(shell.stdout).text(),
      new Response(shell.stderr).text(),
      shell.exited,
    ])

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(stdout).toBe("signaled:202\n")
  })
})
