#!/usr/bin/env bash
set -euo pipefail
set -m
mode="$1"
shift
pid=""
pgid=""
signal_job() {
  kill "-$1" -- "-$2"
}
terminate_started_job() {
  trap - TERM INT HUP
  if [[ -z "$pid" ]]; then
    pid="$(jobs -p %% 2>/dev/null || true)"
  fi
  if [[ -n "$pid" && -z "$pgid" ]]; then
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null || true)"
    pgid="${pgid//[[:space:]]/}"
  fi
  if [[ -n "$pid" ]]; then
    if [[ -n "$pgid" ]]; then
      signal_job CONT "$pgid" 2>/dev/null || true
      signal_job TERM "$pgid" 2>/dev/null || true
      signal_job KILL "$pgid" 2>/dev/null || true
    else
      kill -CONT "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
      kill -KILL "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  fi
  exit 143
}
start_job() {
  true &
  trap terminate_started_job TERM INT HUP
  if [[ "$mode" == "guardian" ]]; then
    (kill -STOP "$BASHPID"; exec "$@") &
  else
    "$@" &
  fi
  pid=$!
  job_line="$(jobs -l %%)"
  job_marker="${job_line%% *}"
  job_number="${job_marker#[}"
  job_number="${job_number%%]*}"
  job_pid="$(jobs -p "%$job_number")"
  pgid="$(ps -o pgid= -p "$pid")"
  pgid="${pgid//[[:space:]]/}"
  printf 'job=%%%s pid=%s jobPid=%s pgid=%s\n' "$job_number" "$pid" "$job_pid" "$pgid"
  set +e
  wait -f "%$job_number" 2>/dev/null
  status=$?
  set -e
  trap - TERM INT HUP
  wait %1 2>/dev/null || true
  printf 'status=%s\n' "$status"
}
if [[ "$mode" == "signal" ]]; then
  signal_job "$1" "$2"
  exit 0
fi
start_job "$@"
if [[ "$mode" == "guardian" ]]; then
  kill -STOP "$$"
fi
exit "$status"
