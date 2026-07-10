#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
test -x dist/expand || { echo "dist/expand missing — run 'bun run build' first" >&2; exit 1; }
test -x dist/expand-server || { echo "dist/expand-server missing — run 'bun run build' first" >&2; exit 1; }

DATA_DIR="$(mktemp -d)"
ENDPOINT_FILE="$DATA_DIR/server.json"
SENTINEL_HOME="$DATA_DIR/default-sentinel"
PROJECT_DIR="$DATA_DIR/project"
CLI=(./dist/expand --data-dir "$DATA_DIR")
SERVER_PID=""
OWNED_PIDS=()

cleanup() {
  local pid
  for pid in "${OWNED_PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  done
  rm -rf -- "$DATA_DIR"
}

retire_owned_pid() {
  local reaped_pid="$1"
  local index
  for index in "${!OWNED_PIDS[@]}"; do
    if [[ "${OWNED_PIDS[$index]}" = "$reaped_pid" ]]; then
      unset 'OWNED_PIDS[index]'
      return
    fi
  done
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$SENTINEL_HOME" "$PROJECT_DIR"

start_server() {
  HOME="$SENTINEL_HOME" ./dist/expand-server --data-dir "$DATA_DIR" >>"$DATA_DIR/server-smoke.log" 2>&1 &
  SERVER_PID=$!
  OWNED_PIDS+=("$SERVER_PID")
  local deadline=$((SECONDS + 5))
  while [[ ! -f "$ENDPOINT_FILE" ]]; do
    if (( SECONDS >= deadline )); then
      echo "endpoint was not advertised" >&2
      exit 1
    fi
    sleep 0.1
  done
  local advertised_pid
  advertised_pid="$(jq -r '.pid' "$ENDPOINT_FILE")"
  test "$advertised_pid" = "$SERVER_PID"
  kill -0 "$SERVER_PID"
}

await_server_exit() {
  local pid="$1"
  local deadline=$((SECONDS + 5))
  while kill -0 "$pid" 2>/dev/null || [[ -f "$ENDPOINT_FILE" ]]; do
    if (( SECONDS >= deadline )); then
      echo "recorded expand-server did not reap" >&2
      exit 1
    fi
    sleep 0.1
  done
  local status=0
  wait "$pid" || status=$?
  retire_owned_pid "$pid"
  return "$status"
}

run_cli() {
  local output_file="$1"
  shift
  start_server
  HOME="$SENTINEL_HOME" "${CLI[@]}" "$@" >"$output_file"
  await_server_exit "$SERVER_PID"
}

run_cli "$DATA_DIR/health.json" health --format json
jq -e '.kind == "ServerHealth" and .data.status == "ok"' "$DATA_DIR/health.json" >/dev/null

run_cli "$DATA_DIR/created.json" project create binary-smoke --directory "$PROJECT_DIR" --format json
project_id="$(jq -er 'select(.kind == "Project" and .created == true) | .data.id' "$DATA_DIR/created.json")"

run_cli "$DATA_DIR/listed.json" project list --format json
jq -e '.kind == "ProjectList" and any(.data[]; .name == "binary-smoke")' "$DATA_DIR/listed.json" >/dev/null

run_cli "$DATA_DIR/deleted.json" project delete "$project_id" --format json
test -f "$DATA_DIR/events.db"
test ! -e "$SENTINEL_HOME/.expand"
