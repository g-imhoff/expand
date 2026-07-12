#!/usr/bin/env bash
set -euo pipefail
set -m

cd "$(dirname "$0")/.."

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v ps >/dev/null || { echo "ps is required" >&2; exit 1; }
test -x dist/expand || { echo "dist/expand missing — run 'bun run build' first" >&2; exit 1; }
test -x dist/expand-server || { echo "dist/expand-server missing — run 'bun run build' first" >&2; exit 1; }

unset EXPAND_BACKEND_CMD

DATA_DIR="$(mktemp -d)"
ENDPOINT_FILE="$DATA_DIR/server.json"
ENDPOINT_LOCK_FILE="$DATA_DIR/server.json.lock"
BACKEND_LOCK_FILE="$DATA_DIR/backend.lock"
JOB_STATE_FILE="$DATA_DIR/server-job.state"
GUARDIAN_STATUS_FILE="$DATA_DIR/autospawn-guardian.status"
GUARDIAN_EVIDENCE_FILE="$DATA_DIR/autospawn-guardian.evidence"
GUARDIAN_RELEASE_FILE="$DATA_DIR/autospawn-guardian.release"
SENTINEL_HOME="$DATA_DIR/default-sentinel"
PROJECT_DIR="$DATA_DIR/project"
CLI=(./dist/expand --data-dir "$DATA_DIR")
SERVER_EXIT_TIMEOUT_SECONDS=5
SERVER_STOP_TIMEOUT_SECONDS=5
SERVER_PID=""
SERVER_JOB_SPEC=""
GUARDIAN_PID=""
GUARDIAN_PGID=""
GUARDIAN_EXIT_STATUS=""
ENDPOINT_PID=""
DATA_DIR_SAFE=1

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

mark_data_dir_unsafe() {
  DATA_DIR_SAFE=0
  echo "$1" >&2
}

write_private_file() {
  local destination="$1"
  shift
  local temporary="${destination}.tmp.$$.$RANDOM"
  (umask 077; printf '%s\n' "$*" > "$temporary")
  chmod 600 "$temporary"
  mv -f -- "$temporary" "$destination"
}

read_process_group() {
  local process_id="$1"
  local process_group
  process_group="$(ps -o pgid= -p "$process_id" 2>/dev/null)" || return 1
  process_group="${process_group//[[:space:]]/}"
  [[ "$process_group" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$process_group"
}

verify_autospawn_evidence() {
  local endpoint_pid
  local endpoint_group
  local unexpected=""
  if [[ ! -f "$GUARDIAN_EVIDENCE_FILE" ]] || ! read -r endpoint_pid endpoint_group unexpected < "$GUARDIAN_EVIDENCE_FILE"; then
    mark_data_dir_unsafe "auto-spawn endpoint evidence was missing or malformed"
    return 1
  fi
  if [[ ! "$endpoint_pid" =~ ^[1-9][0-9]*$ ]] || [[ ! "$endpoint_group" =~ ^[1-9][0-9]*$ ]] || [[ -n "$unexpected" ]]; then
    mark_data_dir_unsafe "auto-spawn endpoint evidence was missing or malformed"
    return 1
  fi
  ENDPOINT_PID="$endpoint_pid"
  if [[ "$endpoint_group" != "$GUARDIAN_PGID" ]]; then
    mark_data_dir_unsafe "endpoint PID process group does not match the guardian"
    return 1
  fi
}

endpoint_pid_in_owned_group() {
  local current_group
  [[ -n "${ENDPOINT_PID:-}" ]] && [[ -n "${GUARDIAN_PGID:-}" ]] || return 1
  current_group="$(read_process_group "$ENDPOINT_PID")" || return 1
  [[ "$current_group" = "$GUARDIAN_PGID" ]]
}

autospawn_artifacts_absent() {
  [[ ! -e "$ENDPOINT_FILE" ]] && [[ ! -e "$ENDPOINT_LOCK_FILE" ]] && [[ ! -e "$BACKEND_LOCK_FILE" ]]
}

await_autospawn_departure() {
  local deadline=$((SECONDS + SERVER_EXIT_TIMEOUT_SECONDS))
  while true; do
    if autospawn_artifacts_absent && ! endpoint_pid_in_owned_group; then
      return 0
    fi
    if (( SECONDS >= deadline )); then
      mark_data_dir_unsafe "auto-spawned backend cleanup timed out"
      return 1
    fi
    sleep 0.1
  done
}

release_guardian() {
  local deadline
  local guardian_status=0
  local write_status
  if write_private_file "$GUARDIAN_RELEASE_FILE" release; then
    true
  else
    write_status=$?
    mark_data_dir_unsafe "guardian release could not be recorded"
    return "$write_status"
  fi
  deadline=$((SECONDS + SERVER_EXIT_TIMEOUT_SECONDS))
  if ! wait_for_server_job_exit "$deadline"; then
    mark_data_dir_unsafe "guardian did not exit after release"
    return 1
  fi
  reap_server_job || guardian_status=$?
  GUARDIAN_EXIT_STATUS="$guardian_status"
  return 0
}

await_guardian_file() {
  local path="$1"
  local label="$2"
  local deadline=$((SECONDS + SERVER_EXIT_TIMEOUT_SECONDS))
  while [[ ! -f "$path" ]]; do
    if ! server_job_active; then
      mark_data_dir_unsafe "$label was not recorded before the guardian exited"
      return 1
    fi
    if (( SECONDS >= deadline )); then
      mark_data_dir_unsafe "$label was not recorded before timeout"
      return 1
    fi
    sleep 0.1
  done
}

monitor_autospawn_endpoint() {
  local deadline=$((SECONDS + SERVER_EXIT_TIMEOUT_SECONDS))
  local endpoint_pid
  local endpoint_group
  while true; do
    if [[ -f "$ENDPOINT_FILE" ]] && endpoint_pid="$(jq -er '.pid' "$ENDPOINT_FILE" 2>/dev/null)"; then
      if endpoint_group="$(read_process_group "$endpoint_pid")"; then
        write_private_file "$GUARDIAN_EVIDENCE_FILE" "$endpoint_pid $endpoint_group"
        return 0
      fi
    fi
    if (( SECONDS >= deadline )); then
      return 1
    fi
    sleep 0.01
  done
}

autospawn_guardian() {
  local output_file="$1"
  shift
  local cli_status=0
  set +m
  monitor_autospawn_endpoint &
  HOME="$SENTINEL_HOME" "${CLI[@]}" "$@" >"$output_file" || cli_status=$?
  wait || true
  write_private_file "$GUARDIAN_STATUS_FILE" "$cli_status"
  while [[ ! -f "$GUARDIAN_RELEASE_FILE" ]]; do
    sleep 0.05
  done
  return "$cli_status"
}

verify_existing_endpoint_ownership() {
  local advertised_pid
  [[ -f "$ENDPOINT_FILE" ]] || return 0
  if ! advertised_pid="$(jq -er '.pid' "$ENDPOINT_FILE" 2>/dev/null)"; then
    mark_data_dir_unsafe "endpoint PID could not be read"
    return 1
  fi
  if [[ "$advertised_pid" != "$SERVER_PID" ]]; then
    mark_data_dir_unsafe "endpoint PID does not match the recorded expand-server process"
    return 1
  fi
}

await_server_readiness() {
  local advertised_pid
  local deadline=$((SECONDS + SERVER_EXIT_TIMEOUT_SECONDS))
  while true; do
    if ! server_job_active; then
      mark_data_dir_unsafe "recorded expand-server job exited during endpoint readiness"
      return 1
    fi
    if [[ -f "$ENDPOINT_FILE" ]] && advertised_pid="$(jq -er '.pid' "$ENDPOINT_FILE" 2>/dev/null)"; then
      if [[ "$advertised_pid" != "$SERVER_PID" ]]; then
        mark_data_dir_unsafe "endpoint PID does not match the recorded expand-server process"
        return 1
      fi
      if ! server_job_active; then
        mark_data_dir_unsafe "recorded expand-server job exited during endpoint readiness"
        return 1
      fi
      return 0
    fi
    if (( SECONDS >= deadline )); then
      echo "endpoint was not advertised" >&2
      return 1
    fi
    sleep 0.1
  done
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
  SERVER_JOB_SPEC=""
  wait "$job_spec" || status=$?
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
  local state_file
  trap - EXIT
  if [[ -n "$SERVER_JOB_SPEC" ]] && ! stop_server_job; then
    DATA_DIR_SAFE=0
  fi
  for state_file in "$ENDPOINT_FILE" "${ENDPOINT_LOCK_FILE:-}" "${BACKEND_LOCK_FILE:-}"; do
    if [[ -n "$state_file" ]] && [[ -e "$state_file" ]]; then
      DATA_DIR_SAFE=0
    fi
  done
  if endpoint_pid_in_owned_group; then
    DATA_DIR_SAFE=0
  fi
  if [[ "$DATA_DIR_SAFE" != "1" ]]; then
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
  await_server_readiness
}

await_server_exit() {
  local deadline=$((SECONDS + SERVER_EXIT_TIMEOUT_SECONDS))
  while server_job_active; do
    verify_existing_endpoint_ownership || return 1
    if (( SECONDS >= deadline )); then
      echo "recorded expand-server job did not exit" >&2
      return 1
    fi
    sleep 0.1
  done
  local status=0
  reap_server_job || status=$?
  if [[ -f "$ENDPOINT_FILE" ]]; then
    mark_data_dir_unsafe "endpoint remained after recorded expand-server job exit"
    return 1
  fi
  return "$status"
}

run_cli() {
  local output_file="$1"
  shift
  start_server
  HOME="$SENTINEL_HOME" "${CLI[@]}" "$@" >"$output_file"
  verify_existing_endpoint_ownership
  await_server_exit
}

run_cli_autospawn() {
  local output_file="$1"
  shift
  local cli_status
  local guardian_status=0
  rm -f -- "$GUARDIAN_STATUS_FILE" "$GUARDIAN_EVIDENCE_FILE" "$GUARDIAN_RELEASE_FILE"
  GUARDIAN_PID=""
  GUARDIAN_PGID=""
  GUARDIAN_EXIT_STATUS=""
  ENDPOINT_PID=""
  (
    autospawn_guardian "$output_file" "$@"
  ) &
  GUARDIAN_PID=$!
  capture_server_job
  if ! GUARDIAN_PGID="$(read_process_group "$GUARDIAN_PID")"; then
    mark_data_dir_unsafe "guardian process group could not be read"
    return 1
  fi
  await_guardian_file "$GUARDIAN_EVIDENCE_FILE" "auto-spawn endpoint evidence" || return 1
  await_guardian_file "$GUARDIAN_STATUS_FILE" "auto-spawn CLI status" || return 1
  verify_autospawn_evidence || return 1
  if ! cli_status="$(<"$GUARDIAN_STATUS_FILE")" || [[ ! "$cli_status" =~ ^[0-9]+$ ]] || (( cli_status > 255 )); then
    mark_data_dir_unsafe "auto-spawn CLI status was malformed"
    return 1
  fi
  if ! jq -e . "$output_file" >/dev/null; then
    mark_data_dir_unsafe "auto-spawn CLI response was invalid"
    return 1
  fi
  await_autospawn_departure || return 1
  if ! release_guardian; then
    return 1
  fi
  guardian_status="$GUARDIAN_EXIT_STATUS"
  GUARDIAN_PID=""
  if [[ "$guardian_status" != "$cli_status" ]]; then
    mark_data_dir_unsafe "guardian status did not match the auto-spawn CLI status"
    return 1
  fi
  return "$cli_status"
}

run_cli_autospawn "$DATA_DIR/health.json" health --format json
jq -e '.kind == "ServerHealth" and .data.status == "ok"' "$DATA_DIR/health.json" >/dev/null

run_cli "$DATA_DIR/created.json" project create binary-smoke --directory "$PROJECT_DIR" --format json
project_id="$(jq -er 'select(.kind == "Project" and .created == true) | .data.id' "$DATA_DIR/created.json")"

run_cli "$DATA_DIR/listed.json" project list --format json
jq -e '.kind == "ProjectList" and any(.data[]; .name == "binary-smoke")' "$DATA_DIR/listed.json" >/dev/null

run_cli "$DATA_DIR/deleted.json" project delete "$project_id" --format json
test -f "$DATA_DIR/events.db"
test ! -e "$SENTINEL_HOME/.expand"
