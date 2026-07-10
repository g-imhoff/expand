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
})
