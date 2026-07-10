#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
test -x dist/expand || { echo "dist/expand missing — run 'bun run build' first" >&2; exit 1; }
test -x dist/expand-server || { echo "dist/expand-server missing — run 'bun run build' first" >&2; exit 1; }

DATA_DIR="$(mktemp -d)"
ENDPOINT_FILE="$DATA_DIR/server.json"
JOB_STATE_FILE="$DATA_DIR/server-job.state"
SENTINEL_HOME="$DATA_DIR/default-sentinel"
PROJECT_DIR="$DATA_DIR/project"
CLI=(./dist/expand --data-dir "$DATA_DIR")
SERVER_EXIT_TIMEOUT_SECONDS=5
SERVER_STOP_TIMEOUT_SECONDS=5
SERVER_PID=""
SERVER_JOB_SPEC=""

capture_server_job() {
  local job_marker
  local job_description
  if ! jobs -l %% > "$JOB_STATE_FILE"; then
    echo "expand-server job was not registered" >&2
    exit 1
  fi
  if ! read -r job_marker job_description < "$JOB_STATE_FILE"; then
    echo "expand-server job identity was not captured" >&2
    exit 1
  fi
  if [[ ! "$job_marker" =~ ^\[([0-9]+)\][+-]?$ ]]; then
    echo "expand-server job identity was invalid" >&2
    exit 1
  fi
  SERVER_JOB_SPEC="%${BASH_REMATCH[1]}"
}

server_job_active() {
  local job_marker
  local job_description
  [[ -n "$SERVER_JOB_SPEC" ]] || return 1
  jobs -r > "$JOB_STATE_FILE"
  jobs -s >> "$JOB_STATE_FILE"
  while read -r job_marker job_description; do
    [[ "$job_marker" =~ ^\[([0-9]+)\][+-]?$ ]] || continue
    if [[ "%${BASH_REMATCH[1]}" = "$SERVER_JOB_SPEC" ]]; then
      return 0
    fi
  done < "$JOB_STATE_FILE"
  return 1
}

wait_for_server_job_exit() {
  local deadline="$1"
  while server_job_active; do
    if (( SECONDS >= deadline )); then
      return 1
    fi
    sleep 0.1
  done
}

reap_server_job() {
  local job_spec="$SERVER_JOB_SPEC"
  local status=0
  wait "$job_spec" || status=$?
  SERVER_JOB_SPEC=""
  return "$status"
}

stop_server_job() {
  local job_spec="$SERVER_JOB_SPEC"
  local deadline
  if server_job_active; then
    kill -TERM -- "$job_spec" 2>/dev/null || true
    deadline=$((SECONDS + SERVER_STOP_TIMEOUT_SECONDS))
    if ! wait_for_server_job_exit "$deadline"; then
      kill -KILL -- "$job_spec" 2>/dev/null || true
      deadline=$((SECONDS + SERVER_STOP_TIMEOUT_SECONDS))
      if ! wait_for_server_job_exit "$deadline"; then
        return 1
      fi
    fi
  fi
  reap_server_job || true
}

cleanup() {
  local script_status=$?
  trap - EXIT
  if [[ -n "$SERVER_JOB_SPEC" ]] && ! stop_server_job; then
    echo "cleanup failed; preserving data directory: $DATA_DIR" >&2
    exit 1
  fi
  rm -rf -- "$DATA_DIR"
  exit "$script_status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$SENTINEL_HOME" "$PROJECT_DIR"

start_server() {
  HOME="$SENTINEL_HOME" ./dist/expand-server --data-dir "$DATA_DIR" >>"$DATA_DIR/server-smoke.log" 2>&1 &
  SERVER_PID=$!
  capture_server_job
  local deadline=$((SECONDS + SERVER_EXIT_TIMEOUT_SECONDS))
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
}

await_server_exit() {
  local deadline=$((SECONDS + SERVER_EXIT_TIMEOUT_SECONDS))
  if ! wait_for_server_job_exit "$deadline"; then
    echo "recorded expand-server job did not exit" >&2
    return 1
  fi
  local status=0
  reap_server_job || status=$?
  deadline=$((SECONDS + SERVER_EXIT_TIMEOUT_SECONDS))
  while [[ -f "$ENDPOINT_FILE" ]]; do
    if (( SECONDS >= deadline )); then
      echo "recorded expand-server endpoint was not removed" >&2
      return 1
    fi
    sleep 0.1
  done
  return "$status"
}

run_cli() {
  local output_file="$1"
  shift
  start_server
  HOME="$SENTINEL_HOME" "${CLI[@]}" "$@" >"$output_file"
  await_server_exit
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
