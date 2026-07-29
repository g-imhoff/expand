#!/usr/bin/env bash
set -euo pipefail
set -m
mode="$1"
shift
signal_job() {
  kill "-$1" -- "-$2"
}
start_job() {
  true &
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
